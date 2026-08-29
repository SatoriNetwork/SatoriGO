// Which accounts of one EVM seed are ALREADY IN USE (the EVM accounts design notes).
//
// The wallet derives the candidate addresses (liveWallet.discoverEvmAccounts);
// THIS module decides what the chains' answers mean. It is deliberately split
// out of the store so the rule can be tested against fixed JSON-RPC answers
// rather than against a live node:
//
//   used = balance > 0 OR nonce > 0, on ANY configured chain
//
// Nonce as well as balance because an account that spent everything it ever
// received still exists and still belongs to the user; showing only funded
// accounts would silently drop it (and, worse, renumber the accounts above it).
//
// A CHAIN THAT FAILS IS NOT AN ANSWER. One dead RPC endpoint must never read as
// "these accounts are unused": that is how a restored recovery phrase loses
// accounts. So a failed chain contributes nothing, and when EVERY chain failed
// the outcome carries `answered: false` and the caller reports a failure instead
// of a result.

import { fromQuantity, type EvmRpcBatchResult, type EvmRpcCall } from './rpc';

/** JSON-RPC calls that decide one address, in this exact order. */
const PROBE_METHODS = ['eth_getBalance', 'eth_getTransactionCount'] as const;

/** How many calls each address costs in the batch. */
export const EVM_ACCOUNT_PROBE_CALLS_PER_ADDRESS = PROBE_METHODS.length;

/**
 * The batch that probes `addresses` on one chain: balance and nonce for each,
 * grouped per address in the given order. One HTTP round trip for the whole
 * scan, which is why the service asks for every candidate at once.
 *
 * 'latest' (not 'pending'): a pending nonce would count a transaction the chain
 * has not accepted, and 'latest' is what every other read in this wallet uses.
 */
export function evmAccountProbeBatch(addresses: readonly string[]): EvmRpcCall[] {
  const calls: EvmRpcCall[] = [];
  for (const address of addresses) {
    for (const method of PROBE_METHODS) calls.push({ method, params: [address, 'latest'] });
  }
  return calls;
}

/** What one chain said about the whole candidate list. `ok:false` = the chain
 *  could not be read at all (transport gone, every endpoint down): no verdicts. */
export type EvmAccountChainProbe =
  | { ok: true; results: readonly EvmRpcBatchResult[] }
  | { ok: false };

export interface EvmAccountProbeOutcome {
  /** True when at least one chain answered. False = nothing was learned. */
  answered: boolean;
  /** used[i] for addresses[i]; false where nothing proved the address used. */
  used: boolean[];
}

/**
 * Merge the chains' batch answers into one verdict per address.
 *
 * Tolerant per item, strict overall: a single malformed or errored entry (a node
 * that answers a decimal balance, one rate-limited item in the batch) proves
 * nothing about that address and is skipped, while `answered` still records that
 * the chain replied. Extra entries beyond the expected length are ignored, and
 * missing ones are simply not evidence.
 */
export function mergeEvmAccountProbes(
  addressCount: number,
  chains: readonly EvmAccountChainProbe[],
): EvmAccountProbeOutcome {
  const used = new Array<boolean>(addressCount).fill(false);
  let answered = false;
  for (const chain of chains) {
    if (!chain.ok) continue;
    answered = true;
    for (let i = 0; i < addressCount; i++) {
      if (used[i]) continue;
      const base = i * EVM_ACCOUNT_PROBE_CALLS_PER_ADDRESS;
      for (let call = 0; call < EVM_ACCOUNT_PROBE_CALLS_PER_ADDRESS; call++) {
        const entry = chain.results[base + call];
        if (!entry || !entry.ok) continue;
        try {
          if (fromQuantity(entry.result) > 0n) {
            used[i] = true;
            break;
          }
        } catch {
          // Not a JSON-RPC quantity: no evidence either way, so leave it alone.
        }
      }
    }
  }
  return { answered, used };
}

/**
 * Run the probe across every chain and merge the answers. `batchers` is one
 * "send this batch" function per chain (the store passes each EVM provider's
 * `rpc.batch`); a batcher that throws is a chain that failed, never a chain
 * that said "unused".
 *
 * The chains run in parallel: they are independent hosts, and a scan the user
 * is waiting on should cost one round trip, not one per chain.
 */
export async function probeEvmAccountsUsed(
  addresses: readonly string[],
  batchers: ReadonlyArray<(calls: EvmRpcCall[]) => Promise<EvmRpcBatchResult[]>>,
): Promise<EvmAccountProbeOutcome> {
  if (addresses.length === 0) return { answered: batchers.length > 0, used: [] };
  const calls = evmAccountProbeBatch(addresses);
  const chains = await Promise.all(
    batchers.map(async (batch): Promise<EvmAccountChainProbe> => {
      try {
        return { ok: true, results: await batch(calls) };
      } catch {
        return { ok: false };
      }
    }),
  );
  return mergeEvmAccountProbes(addresses.length, chains);
}
