// Pending-nonce tracker per (chainId, account), phase 3 of the EVM rollout.
//
// Why it exists. JSON-RPC gives eth_getTransactionCount(address, 'pending'):
// the node's view of the next nonce, INCLUDING transactions in its mempool.
// Between "we asked" and "the node saw our broadcast" there is a window; two
// sends built in that window get the same nonce and one is stuck forever
// behind the other (or replaces it, if it pays more). This tracker closes the
// window locally: reservations are serialized per key, the next nonce is
// max(node pending, highest local reservation + 1), and a reservation that
// never gets sent is released so it does not leave a gap.
//
// Nonce state is per account AND per chain (the EVM rollout plan §4):
// the same address has an independent counter on Base and on BNB Chain.
//
// On the release rule: releasing the HIGHEST outstanding nonce lets the next
// reserve reuse it. Releasing a LOWER one while a higher one is outstanding
// leaves a gap the higher one cannot fill (nonces must be used in order); the
// gap closes on the next node read once the higher one is sent or released.
// This is why the caller broadcasts in reservation order, and why the store
// keeps at most one send in flight per account.

import type { EvmRpcClient } from './rpc';
import { fromQuantity } from './rpc';
import { normalizeEvmAddress } from './keys';

export interface EvmNonceReservation {
  readonly nonce: bigint;
  /** The transaction with this nonce was BROADCAST (accepted by a node). The
   *  tracker keeps counting from here even if the node's pending count lags. */
  sent(): void;
  /** The transaction was NOT broadcast (user cancelled, signing failed,
   *  broadcast refused). Frees the nonce. Idempotent; a no-op after sent(). */
  release(): void;
}

export interface EvmNonceTrackerOptions {
  now?: () => number;
  /** A reservation neither sent() nor released() within this long is treated
   *  as abandoned and freed (a crashed UI must not wedge the account). */
  staleAfterMs?: number;
  /** A sent() nonce is trusted over the node's pending count for this long,
   *  after which the node's view wins again (the tx may have been dropped). */
  sentTrustMs?: number;
}

const DEFAULT_STALE_MS = 10 * 60_000;
const DEFAULT_SENT_TRUST_MS = 30 * 60_000;

interface KeyState {
  /** Reserved, not yet sent or released: nonce -> reserved-at (ms). */
  outstanding: Map<bigint, number>;
  /** Broadcast: nonce -> sent-at (ms). */
  sent: Map<bigint, number>;
  /** Serialization: the tail of the per-key promise chain. */
  chain: Promise<void>;
}

export class EvmNonceTracker {
  private readonly now: () => number;
  private readonly staleAfterMs: number;
  private readonly sentTrustMs: number;
  private readonly keys = new Map<string, KeyState>();

  constructor(opts: EvmNonceTrackerOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_MS;
    this.sentTrustMs = opts.sentTrustMs ?? DEFAULT_SENT_TRUST_MS;
  }

  private keyOf(chainId: number, address: string): string {
    return `${chainId}:${normalizeEvmAddress(address)}`;
  }

  private stateFor(key: string): KeyState {
    let st = this.keys.get(key);
    if (!st) {
      st = { outstanding: new Map(), sent: new Map(), chain: Promise.resolve() };
      this.keys.set(key, st);
    }
    return st;
  }

  /** Drop abandoned reservations and no-longer-trusted sent nonces. */
  private prune(st: KeyState): void {
    const t = this.now();
    for (const [n, at] of st.outstanding) if (t - at > this.staleAfterMs) st.outstanding.delete(n);
    for (const [n, at] of st.sent) if (t - at > this.sentTrustMs) st.sent.delete(n);
  }

  /**
   * Reserve the next nonce for `address` on `rpc.chain.chainId`. Serialized per
   * (chainId, address): concurrent calls resolve in order with distinct
   * consecutive nonces. Node errors propagate unchanged.
   */
  async reserve(rpc: EvmRpcClient, address: string): Promise<EvmNonceReservation> {
    const key = this.keyOf(rpc.chain.chainId, address); // rejects on a bad address, before any call
    const st = this.stateFor(key);
    const run = async (): Promise<EvmNonceReservation> => {
      const nodePending = fromQuantity(await rpc.call('eth_getTransactionCount', [address, 'pending']));
      this.prune(st);
      let local: bigint | null = null;
      for (const n of st.outstanding.keys()) if (local === null || n > local) local = n;
      for (const n of st.sent.keys()) if (local === null || n > local) local = n;
      const next = local === null ? nodePending : nodePending > local + 1n ? nodePending : local + 1n;
      st.outstanding.set(next, this.now());
      let settled = false;
      return {
        nonce: next,
        sent: () => {
          if (settled) return;
          settled = true;
          st.outstanding.delete(next);
          st.sent.set(next, this.now());
        },
        release: () => {
          if (settled) return;
          settled = true;
          st.outstanding.delete(next);
        },
      };
    };
    // Chain onto the tail so overlapping reserves for one key run one at a time,
    // in call order; a failed reserve does not break the chain for the next.
    const result = st.chain.then(run);
    st.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Forget everything known about (chainId, address). */
  reset(chainId: number, address: string): void {
    this.keys.delete(this.keyOf(chainId, address));
  }

  /** The outstanding (reserved, not yet resolved) nonces for a key, ascending. */
  outstanding(chainId: number, address: string): bigint[] {
    const st = this.keys.get(this.keyOf(chainId, address));
    if (!st) return [];
    this.prune(st);
    return [...st.outstanding.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }
}
