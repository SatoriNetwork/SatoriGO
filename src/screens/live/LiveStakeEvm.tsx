// Native staking on an EVM chain that has it (Epix, through the cosmos/evm
// staking and distribution precompiles).
//
// The counterpart of LiveStaking.tsx, which is Satori POOL staking on Evrmore
// and is not a transaction at all (it registers an address with a pool over
// HTTP). This one moves real coins with real transactions, so it follows the
// SEND discipline instead: the screen holds text, the store holds the plan, and
// every action passes through a review step and the same arming control a send
// does. Nothing here builds a transaction, prices a fee, or converts an amount
// through a float.
//
// This file imports NOTHING at runtime from src/services/chain/evm/* (the
// build-flag-guarded directory): everything it needs already crossed into plain
// data through the store, exactly as LiveSendEvm.tsx does.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, AlertTriangle, CheckCircle, Landmark, RefreshCw, Info } from 'lucide-react';
import { Button } from '../../components/Button';
import { TextField, PasswordField } from '../../components/TextField';
import { EmptyState } from '../../components/EmptyState';
import { Skeleton } from '../../components/Skeleton';
import { useLiveStore, activeEvmChain } from '../../store/liveStore';
import { formatAmount, formatListAmount } from '../../services/chain/amounts';
import { LiveNav } from './LiveNav';

interface LiveStakeEvmProps {
  onBack(): void;
}

/** Mirrors `EvmFeeLevel` as a plain literal type, so this screen names no
 *  import from the flag-guarded evm/ directory (same reason as LiveSendEvm). */
type FeeLevel = 'slow' | 'normal' | 'fast';
const FEE_LEVELS: readonly FeeLevel[] = ['slow', 'normal', 'fast'];
const FEE_LEVEL_LABEL: Record<FeeLevel, string> = { slow: 'Slow', normal: 'Normal', fast: 'Fast' };

type StakeAction = 'delegate' | 'undelegate' | 'redelegate' | 'claim';

/** The form the user is filling in, or null when the overview is showing. */
interface FormState {
  action: Exclude<StakeAction, 'claim'>;
  valoper: string;
  moniker: string;
  /** Redelegate only. */
  dstValoper: string;
}

const ACTION_TITLE: Record<StakeAction, string> = {
  delegate: 'Stake',
  undelegate: 'Unstake',
  redelegate: 'Move stake',
  claim: 'Claim rewards',
};

/** "21 days", "36 hours", "45 minutes": the chain's own unbonding time in the
 *  largest unit that reads as a whole number. Never a hardcoded 21: the figure
 *  comes from /cosmos/staking/v1beta1/params and a chain can change it. */
export function formatUnbondingPeriod(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const days = seconds / 86_400;
  if (days >= 1) {
    const whole = Math.round(days);
    return `${whole} day${whole === 1 ? '' : 's'}`;
  }
  const hours = seconds / 3600;
  if (hours >= 1) {
    const whole = Math.round(hours);
    return `${whole} hour${whole === 1 ? '' : 's'}`;
  }
  const minutes = Math.max(1, Math.round(seconds / 60));
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/** The unbonding sentence, with the chain's real figure when it is known and an
 *  honest "we could not read it" when it is not. NEVER a guess: the whole point
 *  of this warning is that the number is right. */
export function unbondingNoteText(seconds: number, ticker: string): string {
  const period = formatUnbondingPeriod(seconds);
  return period
    ? `Unstaking locks the coins for ${period}. They earn no rewards during that time and cannot be sent or moved until it ends.`
    : `Unstaking locks the coins for this chain's unbonding period, which could not be read right now. They earn no rewards during that time and cannot be sent until it ends. Check the ${ticker} network parameters before you continue.`;
}

/** '12 Sep 2026, 14:05', or 'n/a' when the stamp is unusable. */
function formatWhen(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return 'n/a';
  try {
    return new Date(at).toLocaleString(undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return 'n/a';
  }
}

/** 'epixvaloper1abcd...wxyz' */
function shortValoper(valoper: string): string {
  return valoper.length > 22 ? `${valoper.slice(0, 14)}...${valoper.slice(-6)}` : valoper;
}

function commissionText(rate: number | null): string {
  if (rate === null) return 'n/a';
  return `${(rate * 100).toFixed(2).replace(/\.?0+$/, '')}%`;
}

/** How the validator list is ordered. SESSION ONLY (component state, never
 *  storage): it is a way of looking at one list, not a setting about the
 *  wallet, and a persisted one would silently outlive the reason it was
 *  chosen. */
export type ValidatorSort = 'power' | 'commission' | 'name';

const SORTS: readonly ValidatorSort[] = ['power', 'commission', 'name'];
const SORT_LABEL: Record<ValidatorSort, string> = {
  power: 'Power',
  commission: 'Commission',
  name: 'Name',
};

/** The shape the sort needs. Structural on purpose: it is EvmValidatorRow, but
 *  naming that type here would import from the store for no gain. */
interface SortableValidator {
  moniker: string;
  valoper: string;
  commissionRate: number | null;
  tokensBase: bigint;
}

/** Sort key for a moniker: case- AND diacritic-insensitive, so "Ångström" sits
 *  with the A's and "onenov" with "OneNov". A validator with no moniker sorts
 *  under its address, which is what the row shows for it. */
function monikerKey(v: SortableValidator): string {
  return (v.moniker || v.valoper)
    .trim()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

/**
 * Order the validator rows. Pure and total: it never mutates its input, and
 * every comparison falls back to voting power so the result is stable rather
 * than "whatever the LCD happened to answer".
 *
 * `commission` is CHEAPEST FIRST, and a commission that could not be read
 * (null) sorts LAST rather than first: an unknown rate is not a free one, and
 * putting it at the top of a cheapest-first list would recommend it.
 */
export function sortValidators<T extends SortableValidator>(rows: readonly T[], sort: ValidatorSort): T[] {
  const byPower = (a: T, b: T) => (a.tokensBase === b.tokensBase ? 0 : a.tokensBase > b.tokensBase ? -1 : 1);
  const out = [...rows];
  if (sort === 'commission') {
    out.sort((a, b) => {
      if (a.commissionRate === null && b.commissionRate === null) return byPower(a, b);
      if (a.commissionRate === null) return 1;
      if (b.commissionRate === null) return -1;
      if (a.commissionRate !== b.commissionRate) return a.commissionRate - b.commissionRate;
      return byPower(a, b);
    });
    return out;
  }
  if (sort === 'name') {
    out.sort((a, b) => {
      const cmp = monikerKey(a).localeCompare(monikerKey(b));
      return cmp !== 0 ? cmp : byPower(a, b);
    });
    return out;
  }
  out.sort(byPower);
  return out;
}

export function LiveStakeEvm({ onBack }: LiveStakeEvmProps) {
  const evm = useLiveStore((s) => s.evm);
  const evmStaking = useLiveStore((s) => s.evmStaking);
  const assets = useLiveStore((s) => s.assets);
  const wallets = useLiveStore((s) => s.wallets);
  const activeWalletId = useLiveStore((s) => s.activeWalletId);
  const storeError = useLiveStore((s) => s.error);
  const requirePasswordToSend = useLiveStore((s) => s.requirePasswordToSend);
  const verifyPassword = useLiveStore((s) => s.verifyPassword);
  const arm = useLiveStore((s) => s.arm);
  const refreshEvmStaking = useLiveStore((s) => s.refreshEvmStaking);
  const planEvmStake = useLiveStore((s) => s.planEvmStake);
  const selectEvmStakeFeeLevel = useLiveStore((s) => s.selectEvmStakeFeeLevel);
  const estimateEvmStakeMax = useLiveStore((s) => s.estimateEvmStakeMax);
  const countEvmUnbondingEntries = useLiveStore((s) => s.countEvmUnbondingEntries);
  const confirmEvmStake = useLiveStore((s) => s.confirmEvmStake);
  const clearEvmStake = useLiveStore((s) => s.clearEvmStake);

  const chain = activeEvmChain({ evm });

  // --- form state ----------------------------------------------------------
  const [form, setForm] = useState<FormState | null>(null);
  const [amountText, setAmountText] = useState('');
  const [level, setLevel] = useState<FeeLevel>('normal');
  const [fieldError, setFieldError] = useState('');
  const [maxLoading, setMaxLoading] = useState(false);
  const [showJailed, setShowJailed] = useState(false);
  const [sort, setSort] = useState<ValidatorSort>('power');
  /** Unbonding entries already in flight with the validator being unstaked
   *  from, or null when unknown. The chain refuses an undelegate past
   *  max_entries, and it does so after the user armed and signed. */
  const [entryCount, setEntryCount] = useState<number | null>(null);

  // --- confirm state -------------------------------------------------------
  const [armed, setArmed] = useState(false);
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState('');
  const [successResult, setSuccessResult] = useState<{ txid: string; explorerUrl: string; action: StakeAction } | null>(null);

  const snapshot = evmStaking.snapshot;
  const plan = evmStaking.plan;

  // First read on open, and a clean slate on leaving: an armed plan must never
  // survive a navigation.
  useEffect(() => {
    void refreshEvmStaking();
    return () => {
      clearEvmStake();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeWallet = wallets.find((w) => w.id === activeWalletId);
  const isPasswordless = activeWallet?.passwordless ?? false;
  const requirePassword = requirePasswordToSend && !isPasswordless;

  const nativeRow = assets.find((a) => a.isNative);
  const availableBase = nativeRow?.amountBase ?? 0n;

  const resetForm = useCallback(() => {
    setForm(null);
    setAmountText('');
    setFieldError('');
    setEntryCount(null);
  }, []);

  const backFromReview = useCallback(() => {
    clearEvmStake();
    arm(false);
    setArmed(false);
    setPassword('');
    setPasswordError('');
    setConfirmError('');
  }, [arm, clearEvmStake]);

  // Filter first, then order: the jailed filter decides WHICH validators exist
  // on screen and the sort only decides the order they appear in, so the two
  // controls stay independent whichever way they are used.
  const validators = useMemo(() => {
    const rows = snapshot?.validators ?? [];
    return sortValidators(showJailed ? rows : rows.filter((v) => !v.jailed), sort);
  }, [snapshot, showJailed, sort]);

  const jailedCount = (snapshot?.validators ?? []).filter((v) => v.jailed).length;

  // A chain without staking (or a build without the engine) must not render a
  // half-working screen: this route is guarded in LiveApp too, so reaching here
  // means something went stale.
  if (!chain || !chain.staking) {
    return (
      <div className="app-frame screen-enter">
        <div className="sub-header">
          <button type="button" className="icon-btn" onClick={onBack} aria-label="Back">
            <ChevronLeft size={20} />
          </button>
          <h2>Stake</h2>
          <span />
        </div>
        <div className="app-content" data-testid="live-stake-evm">
          <div className="banner danger">Staking is not available on this chain.</div>
        </div>
        <LiveNav />
      </div>
    );
  }

  const ticker = chain.nativeTicker;
  const decimals = chain.nativeDecimals;

  // --- success step --------------------------------------------------------
  if (successResult) {
    return (
      <div className="app-frame screen-enter">
        <div className="sub-header">
          <button type="button" className="icon-btn" onClick={() => { setSuccessResult(null); resetForm(); }} aria-label="Back">
            <ChevronLeft size={20} />
          </button>
          <h2>{ACTION_TITLE[successResult.action]}</h2>
          <span />
        </div>
        <div className="app-content" data-testid="live-stake-evm">
          <div className="result-screen">
            <div className="result-icon success">
              <CheckCircle size={32} />
            </div>
            <h3>Broadcast successful</h3>
            <p>Your transaction has been submitted to {chain.displayName}.</p>
            <div className="card" style={{ marginTop: 16, width: '100%', textAlign: 'left' }} data-testid="live-stake-txid">
              <div className="section-label" style={{ marginTop: 0 }}>Transaction hash</div>
              <span className="mono" style={{ fontSize: 11, wordBreak: 'break-all', color: 'var(--text-dim)' }}>
                {successResult.txid}
              </span>
            </div>
            <a
              href={successResult.explorerUrl}
              target="_blank"
              rel="noreferrer"
              className="btn btn-secondary btn-sm"
              data-testid="live-stake-explorer-link"
              style={{ marginTop: 12 }}
            >
              Open in explorer
            </a>
            <p className="text-faint" style={{ fontSize: 11, marginTop: 12 }}>
              Staking figures come from the chain and can take a block or two to catch up.
            </p>
            <Button block onClick={() => { setSuccessResult(null); resetForm(); }} style={{ marginTop: 12 }}>
              Done
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // --- review step ---------------------------------------------------------
  if (plan) {
    const quote = plan.quote;
    const perGas = quote.fee.type === 'eip1559' ? quote.fee.maxFeePerGas : quote.fee.gasPrice;
    const perGasLabel = quote.fee.type === 'eip1559' ? 'max fee per gas' : 'gas price';
    const blocked = !!plan.shortfall || !!plan.capRefusal;

    const handleConfirm = async () => {
      setConfirmError('');
      setPasswordError('');
      arm(true);
      if (requirePassword) {
        const ok = await verifyPassword(password);
        if (!ok) {
          setPasswordError('Incorrect password');
          arm(false);
          return;
        }
      }
      setConfirming(true);
      try {
        const result = await confirmEvmStake();
        setSuccessResult({ txid: result.txid, explorerUrl: result.explorerUrl, action: plan.action });
        setArmed(false);
        setPassword('');
        resetForm();
        arm(false);
      } catch (err) {
        setConfirmError(err instanceof Error ? err.message : String(err));
        arm(false);
      } finally {
        setConfirming(false);
      }
    };

    return (
      <div className="app-frame screen-enter">
        <div className="sub-header">
          <button type="button" className="icon-btn" onClick={backFromReview} aria-label="Back">
            <ChevronLeft size={20} />
          </button>
          <h2>Review {ACTION_TITLE[plan.action].toLowerCase()}</h2>
          <span />
        </div>
        <div className="app-content" data-testid="live-stake-review">
          {/* What will happen, in words, before any figure: this is the
              sentence the plan builder wrote for these exact bytes. */}
          <div className="banner warning" style={{ marginBottom: 14 }}>
            <AlertTriangle size={14} />
            {plan.description} This broadcasts a real transaction on {chain.displayName} and cannot be undone.
          </div>

          {plan.action === 'undelegate' && (
            <div className="banner danger" style={{ marginBottom: 14 }} data-testid="live-stake-unbonding-note">
              <AlertTriangle size={14} />
              {unbondingNoteText(snapshot?.unbondingSeconds ?? 0, ticker)}
            </div>
          )}

          <div className="card solid" style={{ marginBottom: 14 }}>
            <div className="summary-table">
              <div className="sum-row">
                <span className="sum-key">Action</span>
                <span className="sum-val">{ACTION_TITLE[plan.action]}</span>
              </div>
              <div className="sum-row">
                <span className="sum-key">Validator</span>
                <span className="sum-val">{form?.moniker || snapshot?.delegations.find((d) => d.valoper === plan.valoper)?.moniker || 'n/a'}</span>
              </div>
              <div className="sum-row">
                <span className="sum-key">Validator address</span>
                <span className="sum-val mono" style={{ fontSize: 10.5, wordBreak: 'break-all' }} data-testid="live-stake-review-valoper">
                  {plan.valoper}
                </span>
              </div>
              {plan.action !== 'claim' && amountText.trim() !== '' && (
                <div className="sum-row">
                  <span className="sum-key">Amount</span>
                  <span className="sum-val">{amountText.trim()} {ticker}</span>
                </div>
              )}
              <div className="sum-row">
                <span className="sum-key">Network</span>
                <span className="sum-val">{chain.displayName}</span>
              </div>
              <div className="sum-row" data-testid="live-stake-review-fee">
                <span className="sum-key">Estimated fee</span>
                <span className="sum-val">{formatAmount(quote.estimatedTotal, decimals)} {ticker}</span>
              </div>
              <div className="sum-row">
                <span className="sum-key">Maximum fee</span>
                <span className="sum-val">{formatAmount(quote.maxTotal, decimals)} {ticker}</span>
              </div>
              <div className="sum-row">
                <span className="sum-key text-dim" style={{ fontSize: 11 }}>{perGasLabel}</span>
                <span className="sum-val text-dim" style={{ fontSize: 11 }}>{formatAmount(perGas, 9)} gwei</span>
              </div>
              <div className="sum-row">
                <span className="sum-key text-dim" style={{ fontSize: 11 }}>Gas limit</span>
                <span className="sum-val text-dim" style={{ fontSize: 11 }}>{quote.gasLimit.toString()}</span>
              </div>
            </div>
          </div>

          <div className="section-label">Speed</div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
            {FEE_LEVELS.map((lvl) => (
              <button
                key={lvl}
                type="button"
                className={plan.level === lvl ? 'chip' : 'chip neutral'}
                data-testid={`live-stake-fee-option-${lvl}`}
                aria-pressed={plan.level === lvl}
                onClick={() => { void selectEvmStakeFeeLevel(lvl); }}
                style={{ flex: 1, justifyContent: 'center', cursor: 'pointer' }}
              >
                {FEE_LEVEL_LABEL[lvl]}
              </button>
            ))}
          </div>

          {plan.shortfall && (
            <div className="banner danger" style={{ marginBottom: 14 }} data-testid="live-stake-shortfall">
              <AlertTriangle size={14} />
              {plan.shortfall}
            </div>
          )}
          {plan.capRefusal && (
            <div className="banner danger" style={{ marginBottom: 14 }} data-testid="live-stake-cap-refusal">
              <AlertTriangle size={14} />
              {plan.capRefusal}
            </div>
          )}

          <div className="section-label">Confirm</div>
          <div className="card" style={{ marginBottom: 14 }}>
            <div
              role="checkbox"
              aria-checked={armed}
              tabIndex={0}
              data-testid="live-stake-arm-checkbox"
              onClick={() => { setArmed(!armed); arm(!armed); }}
              onKeyDown={(e) => {
                if (e.key === ' ' || e.key === 'Enter') {
                  e.preventDefault();
                  setArmed(!armed);
                  arm(!armed);
                }
              }}
              style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer' }}
            >
              <div
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: 5,
                  border: `2px solid ${armed ? 'var(--danger)' : 'var(--border-strong)'}`,
                  background: armed ? 'var(--danger-bg)' : 'transparent',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                  marginTop: 1,
                  transition: 'all 0.15s',
                }}
              >
                {armed && <span style={{ color: 'var(--danger)', fontSize: 11, fontWeight: 700 }}>✓</span>}
              </div>
              <span style={{ fontSize: 12, lineHeight: 1.5 }}>
                I understand this sends a real transaction on {chain.displayName} and cannot be undone.
              </span>
            </div>
          </div>

          {requirePassword && (
            <div style={{ marginBottom: 14 }}>
              <PasswordField
                label="Wallet password"
                showLabel="Show password"
                hideLabel="Hide password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setPasswordError('');
                }}
                placeholder="Enter your password to confirm"
                testId="live-stake-password"
              />
              {passwordError && (
                <span
                  role="alert"
                  data-testid="live-stake-password-error"
                  style={{ fontSize: 11.5, color: 'var(--danger)', display: 'block', marginTop: 4 }}
                >
                  {passwordError}
                </span>
              )}
            </div>
          )}

          {confirmError && (
            <div className="banner danger" style={{ marginBottom: 14 }} data-testid="live-stake-error">
              {confirmError}
            </div>
          )}

          <div style={{ display: 'flex', gap: 9 }}>
            <Button variant="secondary" onClick={backFromReview} data-testid="live-stake-review-back">Back</Button>
            <Button
              block
              variant="danger"
              disabled={!armed || blocked}
              loading={confirming}
              onClick={() => { void handleConfirm(); }}
              data-testid="live-stake-broadcast"
            >
              Confirm
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // --- form step -----------------------------------------------------------
  if (form) {
    const staked = snapshot?.delegations.find((d) => d.valoper === form.valoper)?.amountBase ?? 0n;
    const capBase = form.action === 'delegate' ? availableBase : staked;
    const maxEntries = snapshot?.maxEntries ?? 0;
    const atEntryLimit = form.action === 'undelegate' && entryCount !== null && maxEntries > 0 && entryCount >= maxEntries;
    // Every bonded validator except the source: moving a stake to itself is not
    // a thing the chain accepts, and offering it would only produce a revert.
    const destinations = (snapshot?.validators ?? []).filter((v) => !v.jailed && v.valoper !== form.valoper);

    const fillMax = async () => {
      setMaxLoading(true);
      try {
        setAmountText(await estimateEvmStakeMax(form.action, form.valoper, level));
      } finally {
        setMaxLoading(false);
      }
    };

    const submit = async (e: React.FormEvent) => {
      e.preventDefault();
      setFieldError('');
      if (!amountText.trim()) {
        setFieldError('Enter an amount.');
        return;
      }
      if (form.action === 'redelegate' && !form.dstValoper) {
        setFieldError('Choose the validator to move the stake to.');
        return;
      }
      await planEvmStake({
        action: form.action,
        valoper: form.valoper,
        dstValoper: form.action === 'redelegate' ? form.dstValoper : undefined,
        amountText: amountText.trim(),
        moniker: form.moniker,
        dstMoniker: destinations.find((v) => v.valoper === form.dstValoper)?.moniker,
        level,
      });
    };

    return (
      <div className="app-frame screen-enter">
        <div className="sub-header">
          <button type="button" className="icon-btn" onClick={resetForm} aria-label="Back" data-testid="live-stake-form-back">
            <ChevronLeft size={20} />
          </button>
          <h2>{ACTION_TITLE[form.action]} {ticker}</h2>
          <span />
        </div>
        <div className="app-content" data-testid="live-stake-evm">
          <form onSubmit={(e) => { void submit(e); }}>
            <div className="card solid" style={{ marginBottom: 12 }}>
              <div className="summary-table">
                <div className="sum-row">
                  <span className="sum-key">Validator</span>
                  <span className="sum-val">{form.moniker || 'n/a'}</span>
                </div>
                <div className="sum-row">
                  <span className="sum-key text-dim" style={{ fontSize: 11 }}>Address</span>
                  <span className="sum-val mono text-dim" style={{ fontSize: 10.5 }}>{shortValoper(form.valoper)}</span>
                </div>
              </div>
            </div>

            {form.action === 'undelegate' && (
              <div className="banner warning" style={{ marginBottom: 12 }} data-testid="live-stake-unbonding-note">
                <AlertTriangle size={14} />
                {unbondingNoteText(snapshot?.unbondingSeconds ?? 0, ticker)}
              </div>
            )}

            {atEntryLimit && (
              <div className="banner danger" style={{ marginBottom: 12 }} data-testid="live-stake-entry-limit">
                <AlertTriangle size={14} />
                This validator already has {entryCount} unstaking entries in flight, which is the most {chain.displayName} allows at once. Wait for one to finish before starting another.
              </div>
            )}

            {form.action === 'redelegate' && (
              <div style={{ marginBottom: 12 }}>
                <div className="section-label" style={{ marginTop: 0 }}>Move to</div>
                <select
                  className="live-picker"
                  data-testid="live-stake-redelegate-dst"
                  value={form.dstValoper}
                  onChange={(e) => setForm({ ...form, dstValoper: e.target.value })}
                  aria-label="Validator to move the stake to"
                  style={{ width: '100%' }}
                >
                  <option value="">Choose a validator...</option>
                  {destinations.map((v) => (
                    <option key={v.valoper} value={v.valoper}>
                      {v.moniker || shortValoper(v.valoper)} · {commissionText(v.commissionRate)} commission
                    </option>
                  ))}
                </select>
              </div>
            )}

            <TextField
              label={`Amount (${ticker})`}
              placeholder="0.00"
              value={amountText}
              onChange={(e) => setAmountText(e.target.value)}
              testId="live-stake-amount"
              error={fieldError || undefined}
            />
            <div className="text-dim" style={{ fontSize: 11.5, margin: '6px 2px 8px' }} data-testid="live-stake-available">
              {form.action === 'delegate'
                ? `Available: ${formatAmount(availableBase, decimals, { grouping: true })} ${ticker}`
                : `Staked with this validator: ${formatAmount(capBase, decimals, { grouping: true })} ${ticker}`}
            </div>

            <div style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
              {[25, 50, 75].map((pct) => (
                <button
                  key={pct}
                  type="button"
                  className="chip neutral"
                  data-testid={`live-stake-amt-${pct}`}
                  onClick={() => {
                    const value = (capBase * BigInt(pct)) / 100n;
                    setAmountText(value > 0n ? formatAmount(value, decimals) : '0');
                  }}
                  style={{ flex: 1, justifyContent: 'center', cursor: 'pointer' }}
                >
                  {pct}%
                </button>
              ))}
              <button
                type="button"
                className="chip neutral"
                data-testid="live-stake-amt-max"
                onClick={() => { void fillMax(); }}
                disabled={maxLoading}
                aria-busy={maxLoading}
                style={{ flex: 1, justifyContent: 'center', cursor: 'pointer' }}
              >
                {maxLoading ? '...' : 'Max'}
              </button>
            </div>
            <p className="text-faint" style={{ fontSize: 10, margin: '0 2px 10px' }}>
              {form.action === 'delegate'
                ? `Max leaves the network fee aside, plus a small margin for the fee market moving before you confirm.`
                : `Max is what this validator holds for you right now, read from the chain.`}
            </p>

            <div className="section-label">Network fee</div>
            <div className="card" style={{ marginBottom: 10, padding: 12 }}>
              <div style={{ display: 'flex', gap: 6 }}>
                {FEE_LEVELS.map((lvl) => (
                  <button
                    key={lvl}
                    type="button"
                    className={level === lvl ? 'chip' : 'chip neutral'}
                    data-testid={`live-stake-fee-option-${lvl}`}
                    aria-pressed={level === lvl}
                    onClick={() => setLevel(lvl)}
                    style={{ flex: 1, justifyContent: 'center', cursor: 'pointer' }}
                  >
                    {FEE_LEVEL_LABEL[lvl]}
                  </button>
                ))}
              </div>
              <p className="text-dim" style={{ fontSize: 11, margin: '8px 0 0', lineHeight: 1.5 }}>
                Network fee: paid in {ticker}, shown exactly on the next screen.
              </p>
            </div>

            {storeError && (
              <div className="banner danger" data-testid="live-stake-error" style={{ marginBottom: 10 }}>
                {storeError}
              </div>
            )}

            <Button type="submit" block loading={evmStaking.planning} data-testid="live-stake-review-submit">
              Review
            </Button>
          </form>
        </div>
      </div>
    );
  }

  // --- overview ------------------------------------------------------------
  const loading = evmStaking.loading && !snapshot;

  return (
    <div className="app-frame screen-enter">
      <div className="sub-header">
        <button type="button" className="icon-btn" onClick={onBack} aria-label="Back">
          <ChevronLeft size={20} />
        </button>
        <h2>Stake {ticker}</h2>
        <button
          type="button"
          className="icon-btn"
          onClick={() => { void refreshEvmStaking(); }}
          aria-label="Refresh staking"
          data-testid="live-stake-refresh"
        >
          <RefreshCw size={16} className={evmStaking.loading ? 'spin' : undefined} />
        </button>
      </div>
      <div className="app-content" data-testid="live-stake-evm">
        {/* Header: what is staked and what it has earned. */}
        <div className="card solid" style={{ marginBottom: 12 }}>
          <div className="summary-table">
            <div className="sum-row">
              <span className="sum-key">Staked</span>
              <span className="sum-val" data-testid="live-stake-total">
                {loading ? <Skeleton width={80} height={14} /> : `${formatListAmount(snapshot?.stakedTotalBase ?? 0n, decimals)} ${ticker}`}
              </span>
            </div>
            <div className="sum-row">
              <span className="sum-key">Pending rewards</span>
              <span className="sum-val" data-testid="live-stake-rewards-total">
                {loading ? <Skeleton width={80} height={14} /> : `${formatListAmount(snapshot?.rewardsTotalBase ?? 0n, decimals)} ${ticker}`}
              </span>
            </div>
            <div className="sum-row">
              <span className="sum-key text-dim" style={{ fontSize: 11 }}>Available to stake</span>
              <span className="sum-val text-dim" style={{ fontSize: 11 }}>
                {formatListAmount(availableBase, decimals)} {ticker}
              </span>
            </div>
          </div>
        </div>

        {snapshot?.issue && (
          <div className="banner warning" style={{ marginBottom: 12 }} data-testid="live-stake-issue">
            <AlertTriangle size={14} />
            {snapshot.issue}
          </div>
        )}

        {/* My delegations. */}
        {(snapshot?.delegations.length ?? 0) > 0 && (
          <>
            <div className="section-label">My stake</div>
            {snapshot?.delegations.map((d) => (
              <div className="card" style={{ marginBottom: 8 }} key={`del-${d.valoper}`} data-testid={`live-stake-delegation-${d.valoper}`}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
                  <span style={{ fontWeight: 600, fontSize: 12.5 }}>{d.moniker || shortValoper(d.valoper)}</span>
                  <span style={{ fontSize: 12.5 }} title={`${formatAmount(d.amountBase, decimals)} ${ticker}`}>
                    {formatListAmount(d.amountBase, decimals)} {ticker}
                  </span>
                </div>
                <div className="text-dim" style={{ fontSize: 11, marginTop: 3 }}>
                  Rewards: {formatListAmount(d.rewardBase, decimals)} {ticker}
                </div>
                <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                  <Button
                    size="sm"
                    variant="secondary"
                    data-testid="live-stake-undelegate"
                    onClick={() => {
                      setForm({ action: 'undelegate', valoper: d.valoper, moniker: d.moniker, dstValoper: '' });
                      setAmountText('');
                      setEntryCount(null);
                      void countEvmUnbondingEntries(d.valoper).then(setEntryCount);
                    }}
                  >
                    Unstake
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    data-testid="live-stake-redelegate"
                    onClick={() => {
                      setForm({ action: 'redelegate', valoper: d.valoper, moniker: d.moniker, dstValoper: '' });
                      setAmountText('');
                    }}
                  >
                    Move
                  </Button>
                  <Button
                    size="sm"
                    data-testid="live-stake-claim"
                    disabled={d.rewardBase <= 0n || evmStaking.planning}
                    onClick={() => {
                      setForm(null);
                      setAmountText('');
                      void planEvmStake({
                        action: 'claim',
                        valoper: d.valoper,
                        moniker: d.moniker,
                        amountText: formatAmount(d.rewardBase, decimals),
                      });
                    }}
                  >
                    Claim
                  </Button>
                </div>
              </div>
            ))}
          </>
        )}

        {/* Unbonding, with the moment each entry frees up. */}
        {(snapshot?.unbonding.length ?? 0) > 0 && (
          <>
            <div className="section-label">Unstaking</div>
            {snapshot?.unbonding.map((u, i) => (
              <div className="card" style={{ marginBottom: 8 }} key={`unb-${u.valoper}-${i}`} data-testid="live-stake-unbonding-row">
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
                  <span style={{ fontWeight: 600, fontSize: 12.5 }}>{u.moniker || shortValoper(u.valoper)}</span>
                  <span style={{ fontSize: 12.5 }} title={`${formatAmount(u.balanceBase, decimals)} ${ticker}`}>
                    {formatListAmount(u.balanceBase, decimals)} {ticker}
                  </span>
                </div>
                <div className="text-dim" style={{ fontSize: 11, marginTop: 3 }}>
                  Available {formatWhen(u.completionTime)}
                </div>
              </div>
            ))}
          </>
        )}

        {/* Bonded validators, most voting power first unless the sort below
            says otherwise. */}
        <div className="section-label" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span>Validators</span>
          {jailedCount > 0 && (
            <button
              type="button"
              className="chip neutral"
              data-testid="live-stake-jailed-filter"
              aria-pressed={showJailed}
              onClick={() => setShowJailed(!showJailed)}
              style={{ cursor: 'pointer' }}
            >
              {showJailed ? `Hide jailed (${jailedCount})` : `Show jailed (${jailedCount})`}
            </button>
          )}
        </div>

        {/* Sort: the same segmented-chip control the fee levels use, so it
            reads as one control system. Voting power is the default because
            that is the order the chain answers in and the one a delegator
            compares against; commission is cheapest first, which is the
            question the owner actually asked this list. */}
        <div
          style={{ display: 'flex', gap: 6, marginBottom: 8 }}
          data-testid="live-stake-sort"
          role="group"
          aria-label="Sort validators"
        >
          {SORTS.map((key) => (
            <button
              key={key}
              type="button"
              className={sort === key ? 'chip' : 'chip neutral'}
              data-testid={`live-stake-sort-${key}`}
              aria-pressed={sort === key}
              onClick={() => setSort(key)}
              style={{ flex: 1, justifyContent: 'center', cursor: 'pointer' }}
            >
              {SORT_LABEL[key]}
            </button>
          ))}
        </div>

        {loading ? (
          <div data-testid="live-stake-loading">
            <Skeleton height={54} style={{ marginBottom: 6 }} />
            <Skeleton height={54} style={{ marginBottom: 6 }} />
            <Skeleton height={54} />
          </div>
        ) : validators.length === 0 ? (
          <EmptyState
            icon={<Landmark size={20} />}
            title={snapshot?.issue ? 'Validators unavailable' : 'No validators'}
            description={
              snapshot?.issue
                ? `The validator list could not be read from ${chain.displayName} right now. Try again in a moment.`
                : `${chain.displayName} reported no bonded validators.`
            }
          />
        ) : (
          validators.map((v) => (
            <div className="card" style={{ marginBottom: 8 }} key={v.valoper} data-testid={`live-stake-validator-${v.valoper}`}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
                <span style={{ fontWeight: 600, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {v.moniker || shortValoper(v.valoper)}
                </span>
                {v.jailed && (
                  <span className="chip danger" style={{ flexShrink: 0 }}>Jailed</span>
                )}
              </div>
              <div className="text-dim" style={{ fontSize: 11, marginTop: 3 }}>
                Commission {commissionText(v.commissionRate)} · Voting power {formatListAmount(v.tokensBase, decimals)} {ticker}
              </div>
              <div className="text-faint mono" style={{ fontSize: 10, marginTop: 2, wordBreak: 'break-all' }}>
                {shortValoper(v.valoper)}
              </div>
              <div style={{ marginTop: 8 }}>
                <Button
                  size="sm"
                  data-testid="live-stake-delegate"
                  disabled={v.jailed}
                  onClick={() => {
                    setForm({ action: 'delegate', valoper: v.valoper, moniker: v.moniker, dstValoper: '' });
                    setAmountText('');
                    setFieldError('');
                  }}
                >
                  Stake
                </Button>
              </div>
            </div>
          ))
        )}

        <p className="text-faint" style={{ fontSize: 10.5, marginTop: 12, display: 'flex', gap: 6, alignItems: 'flex-start' }}>
          <Info size={12} style={{ flexShrink: 0, marginTop: 1 }} />
          Staking sends real transactions on {chain.displayName}. Rewards and balances are read from the chain and can lag a block or two.
        </p>
      </div>
      <LiveNav />
    </div>
  );
}
