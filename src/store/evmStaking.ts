// The store's native-staking path for an EVM account (Epix, cosmos/evm).
//
// Two halves, and they use different transports on purpose:
//
//   READS  the LISTS (bonded validators, my delegations, my unbonding entries,
//          my pending rewards) come from the chain's Cosmos REST (LCD), because
//          the precompiles answer one validator at a time and a hundred
//          eth_calls per refresh is not a read, it is a denial of service
//          against our own gateway. Per-validator EXACTNESS (what is staked
//          with one validator right now, what it has earned right now) comes
//          from the precompile, read fresh at the moment an action is built.
//
//   WRITES every action is an ordinary EVM transaction to a precompile: the
//          generic planEvmCall prices it, the ordinary broadcast path signs and
//          sends it. There is no second money path here, which is the whole
//          point of doing staking this way.
//
// Everything EVM is reached through loadEvmModules() (the build flag). The
// type-only imports below are erased at compile time.

import { loadEvmModules } from '../services/chain/engine';
import { planEvmCall, type EvmCallPlan } from './evmCall';
import { EvmSendError } from './evmSend';
import { parseAmount } from '../services/chain/amounts';
import type { EvmWalletDataProvider } from '../services/chain/evm/evmProvider';
import type { CosmosRestOptions, CosmosStakingCall } from '../services/chain/evm/cosmosStaking';
import type { EvmChainInfo } from './evmChains';
import type { EvmFeeLevel } from '../services/chain/evm/fees';

/** One validator as the screen shows it: plain data, no bigint arithmetic left
 *  for the UI beyond formatting. */
export interface EvmValidatorRow {
  valoper: string;
  moniker: string;
  jailed: boolean;
  /** A fraction (0.01 = 1%), or null when the chain's answer was unreadable. */
  commissionRate: number | null;
  /** Voting power in base units of the bond denom. */
  tokensBase: bigint;
}

/** What this account has with one validator. */
export interface EvmDelegationRow {
  valoper: string;
  moniker: string;
  amountBase: bigint;
  rewardBase: bigint;
}

/** One in-flight unbonding entry, flattened for the list. */
export interface EvmUnbondingRow {
  valoper: string;
  moniker: string;
  balanceBase: bigint;
  /** Unix ms when the coins become spendable again. */
  completionTime: number;
}

/** Everything the Stake screen renders, in one value. */
export interface EvmStakingSnapshot {
  chainKey: string;
  /** The delegator's bech32 form of the SAME account ('epix1...'), shown so a
   *  user can look the account up on a Cosmos explorer. */
  bech32Address: string;
  /** The chain's own unbonding time, in seconds. Read from params, never
   *  hardcoded: the warning must say what this chain actually does. */
  unbondingSeconds: number;
  /** How many unbonding entries one (delegator, validator) pair may have in
   *  flight before the chain refuses another undelegate. */
  maxEntries: number;
  validators: EvmValidatorRow[];
  delegations: EvmDelegationRow[];
  unbonding: EvmUnbondingRow[];
  stakedTotalBase: bigint;
  rewardsTotalBase: bigint;
  /** Non-null when some or all of the above could not be read. The screen shows
   *  it instead of pretending the account has nothing staked. */
  issue: string | null;
}

/** The staking config of `chainKey`, or null when the chain has none (which is
 *  every chain but Epix) or the build has no EVM engine. */
export async function evmStakingConfigFor(chainKey: string) {
  const evm = await loadEvmModules();
  if (!evm) return null;
  const chain = evm.evmChainByKey(chainKey);
  return chain?.staking ?? null;
}

/** REST options for `chainKey`: the gateway proxy in a gateway build (with the
 *  client token), the chain's own LCD otherwise. Null when the chain has no
 *  staking row. */
async function restOptionsFor(chainKey: string): Promise<CosmosRestOptions | null> {
  const evm = await loadEvmModules();
  if (!evm) return null;
  const chain = evm.evmChainByKey(chainKey);
  if (!chain?.staking) return null;
  const baseUrl = evm.cosmosRestBaseUrl(chain);
  if (!baseUrl) return null;
  return { baseUrl, headers: evm.evmGatewayHeaders() };
}

const EMPTY_SNAPSHOT = (chainKey: string, issue: string): EvmStakingSnapshot => ({
  chainKey,
  bech32Address: '',
  unbondingSeconds: 0,
  maxEntries: 0,
  validators: [],
  delegations: [],
  unbonding: [],
  stakedTotalBase: 0n,
  rewardsTotalBase: 0n,
  issue,
});

/**
 * Read everything the Stake screen needs for one account on one chain.
 *
 * NEVER THROWS. Every failure becomes `issue` text plus whatever did load, so a
 * lagging LCD shows the validator list without the user's delegations rather
 * than a blank screen. Returns null only when the build has no EVM engine.
 */
export async function loadEvmStakingSnapshot(
  chain: EvmChainInfo,
  evmAddress: string,
): Promise<EvmStakingSnapshot | null> {
  const evm = await loadEvmModules();
  if (!evm) return null;
  const def = evm.evmChainByKey(chain.key);
  const cfg = def?.staking;
  if (!cfg) return EMPTY_SNAPSHOT(chain.key, `${chain.displayName} has no native staking in this build.`);
  const opts = await restOptionsFor(chain.key);
  if (!opts) return EMPTY_SNAPSHOT(chain.key, `${chain.displayName} staking has no data source in this build.`);

  let bech32Address = '';
  try {
    bech32Address = evm.bech32AddressFor(cfg.accountPrefix, evmAddress);
  } catch {
    return EMPTY_SNAPSHOT(chain.key, "This account address could not be converted to the chain's own format.");
  }

  const issues: string[] = [];
  const say = (what: string, err: unknown) => {
    const reason =
      err instanceof evm.CosmosRestError && err.reason === 'unavailable'
        ? `${chain.displayName} could not be reached`
        : `${chain.displayName} refused the request`;
    issues.push(`${what} could not be read: ${reason}.`);
  };

  // Params first and on its own: the unbonding warning is not optional copy, so
  // a screen that cannot state the real lock-up must say so rather than guess.
  let unbondingSeconds = 0;
  let maxEntries = 0;
  try {
    const params = await evm.fetchStakingParams(opts);
    unbondingSeconds = params.unbondingTimeSeconds;
    maxEntries = params.maxEntries;
  } catch (err) {
    say("The chain's staking parameters", err);
  }

  // The four lists in parallel: they are independent reads and one failing must
  // not hide the other three.
  const [validatorsR, delegationsR, unbondingR, rewardsR] = await Promise.allSettled([
    evm.fetchBondedValidators(opts),
    evm.fetchDelegations(opts, bech32Address),
    evm.fetchUnbondingDelegations(opts, bech32Address),
    evm.fetchPendingRewards(opts, bech32Address, cfg.bondDenom),
  ]);

  const validators: EvmValidatorRow[] =
    validatorsR.status === 'fulfilled'
      ? validatorsR.value.map((v) => ({
          valoper: v.operatorAddress,
          moniker: v.moniker,
          jailed: v.jailed,
          commissionRate: v.commissionRate,
          tokensBase: v.tokensBase,
        }))
      : [];
  if (validatorsR.status === 'rejected') say('The validator list', validatorsR.reason);
  if (delegationsR.status === 'rejected') say('Your delegations', delegationsR.reason);
  if (unbondingR.status === 'rejected') say('Your unbonding coins', unbondingR.reason);
  if (rewardsR.status === 'rejected') say('Your pending rewards', rewardsR.reason);

  const monikerOf = new Map(validators.map((v) => [v.valoper, v.moniker]));
  const rewards = rewardsR.status === 'fulfilled' ? rewardsR.value : { perValidator: new Map<string, bigint>(), totalBase: 0n };

  const delegations: EvmDelegationRow[] =
    delegationsR.status === 'fulfilled'
      ? delegationsR.value.map((d) => ({
          valoper: d.valoper,
          moniker: monikerOf.get(d.valoper) ?? '',
          amountBase: d.amountBase,
          rewardBase: rewards.perValidator.get(d.valoper) ?? 0n,
        }))
      : [];

  const unbonding: EvmUnbondingRow[] = [];
  if (unbondingR.status === 'fulfilled') {
    for (const u of unbondingR.value) {
      for (const entry of u.entries) {
        unbonding.push({
          valoper: u.valoper,
          moniker: monikerOf.get(u.valoper) ?? '',
          balanceBase: entry.balanceBase,
          completionTime: entry.completionTime,
        });
      }
    }
    unbonding.sort((a, b) => a.completionTime - b.completionTime);
  }

  let stakedTotalBase = 0n;
  for (const d of delegations) stakedTotalBase += d.amountBase;

  return {
    chainKey: chain.key,
    bech32Address,
    unbondingSeconds,
    maxEntries,
    validators,
    delegations,
    unbonding,
    stakedTotalBase,
    rewardsTotalBase: rewards.totalBase,
    issue: issues.length > 0 ? issues.join(' ') : null,
  };
}

/**
 * What is staked with ONE validator right now, straight from the precompile.
 *
 * Used for the Undelegate and Redelegate Max: the REST list is a snapshot that
 * can be a block or two old, and offering "Max" that is one base unit above the
 * real delegation produces a transaction the chain refuses after the user
 * armed it. Returns null when the read fails or there is no delegation, which
 * the caller reads as "fall back to the list figure".
 */
export async function readExactDelegation(
  provider: EvmWalletDataProvider,
  chainKey: string,
  delegator: string,
  valoper: string,
): Promise<bigint | null> {
  const evm = await loadEvmModules();
  if (!evm) return null;
  const cfg = evm.evmChainByKey(chainKey)?.staking;
  if (!cfg) return null;
  try {
    const data = evm.encodeDelegationQuery(cfg, delegator, valoper);
    const result = await provider.rpc.call<string>('eth_call', [{ to: cfg.stakingPrecompile, data }, 'latest']);
    if (typeof result !== 'string') return null;
    const decoded = evm.decodeDelegationResult(result);
    // A reward or delegation in some other denom is not this chain's coin and
    // must never be added to an EPIX figure.
    if (decoded.balance.denom !== cfg.bondDenom) return null;
    return decoded.balance.amountBase;
  } catch {
    // The precompile reverts with "no delegation for (address, validator)
    // tuple" when there is none: that is not an error worth surfacing, it is
    // the answer zero, and the caller's list figure already says so.
    return null;
  }
}

/**
 * How many unbonding entries this account already has with one validator.
 *
 * The chain refuses an undelegate once the pair is at `max_entries` (7 on
 * Epix), and it refuses it AFTER the user armed and signed. Read here so the
 * form can say so first. Null when unknown.
 */
export async function readUnbondingEntryCount(
  provider: EvmWalletDataProvider,
  chainKey: string,
  delegator: string,
  valoper: string,
): Promise<number | null> {
  const evm = await loadEvmModules();
  if (!evm) return null;
  const cfg = evm.evmChainByKey(chainKey)?.staking;
  if (!cfg) return null;
  try {
    const data = evm.encodeUnbondingDelegationQuery(cfg, delegator, valoper);
    const result = await provider.rpc.call<string>('eth_call', [{ to: cfg.stakingPrecompile, data }, 'latest']);
    if (typeof result !== 'string') return null;
    return evm.decodeUnbondingDelegationResult(result).length;
  } catch {
    return null;
  }
}

/** Which action the screen is building. */
export type EvmStakeAction = 'delegate' | 'undelegate' | 'redelegate' | 'claim';

/** A priced staking action awaiting the arming gate. A generic contract-call
 *  plan plus the two facts the review screen needs that the bytes alone would
 *  not tell it: which action this is, and which validator it names. */
export type EvmStakePlan = EvmCallPlan & { action: EvmStakeAction; valoper: string };

export interface EvmStakeInput {
  action: EvmStakeAction;
  valoper: string;
  /** Redelegate only: where the coins go. */
  dstValoper?: string;
  /** As typed. Parsed exactly at the chain's native decimals, never a float.
   *  Ignored for 'claim'. */
  amountText?: string;
  /** Shown in the review sentence. */
  moniker?: string;
  dstMoniker?: string;
  level?: EvmFeeLevel;
}

/**
 * Build the priced plan for one staking action.
 *
 * The bytes come from the codec, the price from the generic call planner, and
 * the sentence from the plan builder that knows what the bytes mean. Throws
 * EvmSendError, whose message the screen shows verbatim.
 */
export async function buildEvmStakePlan(args: {
  provider: EvmWalletDataProvider;
  chain: EvmChainInfo;
  from: string;
  input: EvmStakeInput;
  nativeBalanceBase?: bigint;
}): Promise<EvmStakePlan> {
  const evm = await loadEvmModules();
  if (!evm) throw new EvmSendError('no-engine', 'This build of Satori GO has no EVM engine.');
  const { provider, chain, from, input, nativeBalanceBase } = args;
  const cfg = evm.evmChainByKey(chain.key)?.staking;
  if (!cfg) throw new EvmSendError('unknown-asset', `${chain.displayName} has no native staking.`);

  const ticker = chain.nativeTicker;
  let call: CosmosStakingCall;
  try {
    if (input.action === 'claim') {
      call = evm.planClaimRewards({
        staking: cfg,
        delegator: from,
        valoper: input.valoper,
        moniker: input.moniker,
        amountText: input.amountText,
        ticker,
      });
    } else {
      const amountText = (input.amountText ?? '').trim();
      let amountBase: bigint;
      try {
        amountBase = parseAmount(amountText, chain.nativeDecimals);
      } catch (err) {
        throw new EvmSendError('invalid-amount', err instanceof Error ? err.message : String(err));
      }
      if (amountBase <= 0n) throw new EvmSendError('invalid-amount', 'Enter an amount greater than zero.');
      if (input.action === 'delegate') {
        call = evm.planDelegate({ staking: cfg, delegator: from, valoper: input.valoper, amountBase, amountText, ticker, moniker: input.moniker });
      } else if (input.action === 'undelegate') {
        call = evm.planUndelegate({ staking: cfg, delegator: from, valoper: input.valoper, amountBase, amountText, ticker, moniker: input.moniker });
      } else {
        if (!input.dstValoper) throw new EvmSendError('invalid-address', 'Choose the validator to move the stake to.');
        call = evm.planRedelegate({
          staking: cfg,
          delegator: from,
          srcValoper: input.valoper,
          dstValoper: input.dstValoper,
          amountBase,
          amountText,
          ticker,
          srcMoniker: input.moniker,
          dstMoniker: input.dstMoniker,
        });
      }
    }
  } catch (err) {
    if (err instanceof EvmSendError) throw err;
    // A bad validator address or a zero amount: the codec's own words, which
    // already name which argument is wrong.
    throw new EvmSendError('invalid-address', err instanceof Error ? err.message : String(err));
  }

  const plan = await planEvmCall({
    provider,
    chain,
    from,
    nativeBalanceBase,
    input: { to: call.to, data: call.data, value: call.value, description: call.description, level: input.level },
  });
  return { ...plan, action: input.action, valoper: input.valoper };
}
