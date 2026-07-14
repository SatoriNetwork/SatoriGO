// Satori pool staking (delegation) — HTTP client for the Satori central server.
//
// This is NOT chain code: staking on Satori is NOT an on-chain transaction. The
// user's SATORIEVR tokens stay put on their own address; that address is simply
// registered as a "lender" of a chosen pool on Satori's central server
// (network.satorinet.io). Nothing here builds, signs, or broadcasts a tx.
//
// Authenticating a join/leave uses a fresh server-issued challenge signed with
// the Evrmore `signmessage` format — the SAME format src/services/chain/message.ts
// (`signMessageWithKey`) already produces, which the Satori backend verifies with
// python-evrmorelib. We REUSE that; no crypto is added here.
//
// Response shapes verified against the Magic Flutter reference AND re-verified
// live via scripts/pool-api-probe.ts (2026-07-13):
//   GET  /api/v1/pool/open            -> { "pools": [{address, alias|null, commission}] }
//   GET  /api/v1/auth/challenge?t=..  -> { "challenge": "<uuid>" }
//   GET  /api/v1/lender/status?..     -> { pool_address: string|null, is_pool?: bool, ... }
//   POST /api/v1/lender/lend          -> HTTP <400 = joined  (auth headers + body)
//   DELETE /api/v1/lender/lend        -> HTTP <400 = left    (auth headers, no body)
//
// SECURITY: never log private keys, public keys, signatures, or challenges.

import { signMessageWithKey } from './chain/message';
import { paginate } from './activityFeed';

/** Base URL of the Satori central server (network.satorinet.io — a DIFFERENT
 *  host from satorinet.io; see public/manifest.json host_permissions). */
export const SATORI_NETWORK_BASE = 'https://network.satorinet.io';

/** How long any single request may take before we abort it (offline guard). */
const REQUEST_TIMEOUT_MS = 15_000;

/** The `source` tag the server records for a lend request (mirrors Magic's tag,
 *  branded for this client). */
const LEND_SOURCE = 'satori go';

/** One open pool a user can delegate (lend) to. `commission` is the pool fee %
 *  (what the pool keeps); lower is better, so the UI sorts ascending. */
export interface PoolInfo {
  address: string;
  /** Human alias, or null when the pool set none. */
  alias: string | null;
  /** Pool fee percentage (0..100). */
  commission: number;
}

/** Whether an address is currently registered as a lender, and where. */
export interface LenderStatus {
  /** The pool the address lends to, or null when it lends to none. */
  poolAddress: string | null;
  /** True when the address is itself a registered pool operator (not a plain
   *  lender). Undefined = the server didn't say (treat as unknown). */
  isPool?: boolean;
}

/** The minimal key material a join/leave needs: the private key to sign the
 *  challenge and the compressed public key sent as the `wallet-pubkey` header.
 *  (Structurally compatible with keys.DerivedKey.) */
export interface PoolSigningKey {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  /** Compression flag; defaults to true (all our wallets use compressed keys). */
  compressed?: boolean;
  /** The address this key controls — used only to label per-address results. */
  address?: string;
}

/** Thrown when the network could not be reached (offline, timeout, DNS, CORS).
 *  Distinct from SatoriServerError so the UI can say "check your connection"
 *  rather than "the server rejected this". */
export class SatoriOfflineError extends Error {
  constructor(message = 'Could not reach the Satori network. Check your connection and try again.') {
    super(message);
    this.name = 'SatoriOfflineError';
  }
}

/** Thrown when the server was reached but rejected the request (HTTP >= 400) or
 *  returned a body we could not parse. `status` is the HTTP code (0 for a
 *  malformed-response error). */
export class SatoriServerError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'SatoriServerError';
    this.status = status;
  }
}

/** hex-encode a byte array (lowercase, no prefix). Local so this module pulls in
 *  no extra dependency. */
function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/** GET/POST/DELETE with a hard timeout. Maps abort/network faults to
 *  SatoriOfflineError; leaves HTTP-status handling to the caller. */
async function requestWithTimeout(url: string, init: RequestInit): Promise<Response> {
  if (typeof fetch === 'undefined') {
    throw new SatoriOfflineError('Network requests are unavailable in this environment.');
  }
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer =
    controller && typeof setTimeout !== 'undefined'
      ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      : null;
  try {
    return await fetch(url, controller ? { ...init, signal: controller.signal } : init);
  } catch (err) {
    // AbortError (timeout) and any network-layer failure land here.
    const msg = err instanceof Error && err.name === 'AbortError' ? 'timed out' : 'request failed';
    throw new SatoriOfflineError(`Could not reach the Satori network (${msg}).`);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/** Parse a JSON response body defensively. Throws SatoriServerError on a
 *  non-2xx status or a malformed body so the UI always gets a clear reason. */
async function parseJsonOk(res: Response, context: string): Promise<unknown> {
  const text = await res.text().catch(() => '');
  if (res.status >= 400) {
    throw new SatoriServerError(`${context}: server returned HTTP ${res.status}.`, res.status);
  }
  if (!text.trim()) {
    throw new SatoriServerError(`${context}: server returned an empty response.`, res.status);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SatoriServerError(`${context}: server returned a malformed response.`, res.status);
  }
}

/** One raw pool record from the server, coerced defensively into a PoolInfo (or
 *  null when it lacks a usable address). `commission` is normalized to a finite
 *  number (0 when absent/garbage). */
function coercePool(raw: unknown): PoolInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.address !== 'string' || !o.address) return null;
  const alias = typeof o.alias === 'string' && o.alias.trim() ? o.alias : null;
  const commission =
    typeof o.commission === 'number' && Number.isFinite(o.commission) ? o.commission : 0;
  return { address: o.address, alias, commission };
}

/**
 * Fetch the open pools a user can delegate to. The live server returns
 * `{ pools: [...] }`; we also tolerate a bare array in case the shape changes.
 *
 * NOTE ON SORT ORDER: this function intentionally returns pools sorted by
 * commission ascending ONLY (the raw server-truth order, kept for back-compat
 * with existing callers/tests). The UI-facing "named pools first, then
 * commission ascending within each group" order lives in `sortPoolsForDisplay`
 * below — a separate pure step so we never sort twice inconsistently. Callers
 * that render a list to the user should pipe this through `sortPoolsForDisplay`
 * (or `paginatePools`, which calls it internally).
 */
export async function fetchOpenPools(): Promise<PoolInfo[]> {
  const res = await requestWithTimeout(`${SATORI_NETWORK_BASE}/api/v1/pool/open`, {
    method: 'GET',
  });
  const json = await parseJsonOk(res, 'Loading pools');
  let list: unknown[];
  if (Array.isArray(json)) {
    list = json;
  } else if (json && typeof json === 'object' && Array.isArray((json as Record<string, unknown>).pools)) {
    list = (json as Record<string, unknown[]>).pools;
  } else {
    throw new SatoriServerError('Loading pools: unexpected response shape.', res.status);
  }
  return list
    .map(coercePool)
    .filter((p): p is PoolInfo => p !== null)
    .sort((a, b) => a.commission - b.commission);
}

// ---- pure UI helpers: sort / filter / paginate (unit-tested, no I/O) --------

/**
 * Display sort: pools WITH a non-empty alias first, then unnamed pools —
 * commission ascending within each group. Pure + exported so both the UI and
 * unit tests share the exact same order (never sorted twice differently).
 */
export function sortPoolsForDisplay(pools: PoolInfo[]): PoolInfo[] {
  return [...pools].sort((a, b) => {
    const aNamed = a.alias ? 0 : 1;
    const bNamed = b.alias ? 0 : 1;
    if (aNamed !== bNamed) return aNamed - bNamed;
    return a.commission - b.commission;
  });
}

/**
 * Case-insensitive substring filter over alias OR address. An empty/whitespace
 * query returns the full list unchanged. Pure + exported for tests.
 */
export function filterPools(pools: PoolInfo[], query: string): PoolInfo[] {
  const q = query.trim().toLowerCase();
  if (!q) return pools;
  return pools.filter((p) => {
    const alias = (p.alias ?? '').toLowerCase();
    const address = p.address.toLowerCase();
    return alias.includes(q) || address.includes(q);
  });
}

/** One page of pools plus the pagination metadata the UI needs to render
 *  Prev/Next controls and "page X of Y". */
export interface PoolsPage {
  /** The pools on THIS page (may be shorter than pageSize on the last page). */
  items: PoolInfo[];
  /** 1-based current page number, clamped to [1, totalPages]. */
  page: number;
  /** Total number of pages (at least 1, even for an empty list). */
  totalPages: number;
  /** Total number of pools AFTER filtering (before pagination). */
  total: number;
}

/** Default number of pools shown per page. */
export const POOLS_PER_PAGE = 10;

/**
 * Sort (named-first, commission asc) + paginate a pool list. `page` is
 * 1-based and clamped into range, so an out-of-range page (e.g. stale after a
 * search narrows the list) never returns an empty page when a valid one
 * exists. Pure + exported for tests; the UI additionally calls `filterPools`
 * before this when a search query is active.
 */
export function paginatePools(pools: PoolInfo[], page: number, pageSize: number = POOLS_PER_PAGE): PoolsPage {
  // Sort (named-first, commission asc) THEN reuse the generic paginate helper so
  // the page-clamp/slice logic lives in exactly one place (activityFeed.paginate).
  return paginate(sortPoolsForDisplay(pools), page, pageSize);
}

/**
 * Fetch a fresh authentication challenge (a nonce to sign). Cache-busted with a
 * timestamp query param + no-store headers so each join/leave signs a unique
 * challenge (the server will not accept a replayed one).
 */
export async function getChallenge(): Promise<string> {
  const url = `${SATORI_NETWORK_BASE}/api/v1/auth/challenge?t=${Date.now()}`;
  const res = await requestWithTimeout(url, {
    method: 'GET',
    headers: {
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Pragma: 'no-cache',
    },
  });
  const json = await parseJsonOk(res, 'Getting challenge');
  const challenge = (json as Record<string, unknown>)?.challenge;
  if (typeof challenge !== 'string' || !challenge) {
    throw new SatoriServerError('Getting challenge: no challenge in response.', res.status);
  }
  return challenge;
}

/**
 * Read whether `address` is currently registered as a lender (and to which pool).
 * A null `poolAddress` means the address lends to no pool.
 */
export async function getLenderStatus(address: string): Promise<LenderStatus> {
  const url = `${SATORI_NETWORK_BASE}/api/v1/lender/status?wallet_address=${encodeURIComponent(address)}`;
  const res = await requestWithTimeout(url, { method: 'GET' });
  const json = await parseJsonOk(res, 'Checking staking status');
  const o = (json ?? {}) as Record<string, unknown>;
  const poolAddress = typeof o.pool_address === 'string' && o.pool_address ? o.pool_address : null;
  const isPool = typeof o.is_pool === 'boolean' ? o.is_pool : undefined;
  return { poolAddress, isPool };
}

/** Build the exact auth headers the server expects for a lend/unlend request:
 *  the compressed pubkey (hex), the challenge as the signed `message`, and its
 *  base64 recoverable signature. Signs with the shared Evrmore signmessage impl. */
function buildAuthHeaders(challenge: string, key: PoolSigningKey): Record<string, string> {
  const compressed = key.compressed ?? true;
  const signature = signMessageWithKey(key.privateKey, challenge, compressed);
  return {
    'wallet-pubkey': toHex(key.publicKey),
    message: challenge,
    signature,
  };
}

/**
 * Register `key`'s address as a lender of `poolAddress` (join/stake). Fetches a
 * FRESH challenge, signs it, and POSTs the lend request. The server handles
 * leave-then-join automatically when the address already lends elsewhere.
 * Resolves on success; throws SatoriOfflineError / SatoriServerError otherwise.
 */
export async function joinPool(poolAddress: string, key: PoolSigningKey): Promise<void> {
  const challenge = await getChallenge();
  const res = await requestWithTimeout(`${SATORI_NETWORK_BASE}/api/v1/lender/lend`, {
    method: 'POST',
    headers: {
      ...buildAuthHeaders(challenge, key),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ pool_address: poolAddress, source: LEND_SOURCE }),
  });
  if (res.status >= 400) {
    throw new SatoriServerError(`Joining the pool failed (HTTP ${res.status}).`, res.status);
  }
}

/**
 * Deregister `key`'s address as a lender (leave/unstake). Fresh challenge, signed,
 * then a DELETE with no body. Resolves on success; throws otherwise.
 */
export async function leavePool(key: PoolSigningKey): Promise<void> {
  const challenge = await getChallenge();
  const res = await requestWithTimeout(`${SATORI_NETWORK_BASE}/api/v1/lender/lend`, {
    method: 'DELETE',
    headers: buildAuthHeaders(challenge, key),
  });
  if (res.status >= 400) {
    throw new SatoriServerError(`Leaving the pool failed (HTTP ${res.status}).`, res.status);
  }
}

/** Per-address outcome of a multi-address join/leave. `ok` true = success; on
 *  failure `error` carries a short human message (never any key/signature). */
export interface PoolAddressResult {
  address: string;
  ok: boolean;
  error?: string;
}

/** Short, log-safe message for a pool op failure. */
function resultError(err: unknown): string {
  if (err instanceof SatoriOfflineError || err instanceof SatoriServerError) return err.message;
  return 'Unexpected error.';
}

/**
 * Join `poolAddress` for EVERY key SEQUENTIALLY (funds can sit on several derived
 * addresses; mirrors Magic's per-address registration). Each address gets its OWN
 * fresh challenge. One address failing does not abort the others — every result
 * is returned so the UI can report partial success honestly.
 */
export async function joinPoolForKeys(
  poolAddress: string,
  keys: PoolSigningKey[],
): Promise<PoolAddressResult[]> {
  const results: PoolAddressResult[] = [];
  for (const key of keys) {
    const address = key.address ?? '';
    try {
      await joinPool(poolAddress, key);
      results.push({ address, ok: true });
    } catch (err) {
      results.push({ address, ok: false, error: resultError(err) });
    }
  }
  return results;
}

/** Leave the current pool for EVERY key SEQUENTIALLY (per-address challenge).
 *  One failure does not abort the rest; all results are returned. */
export async function leavePoolForKeys(keys: PoolSigningKey[]): Promise<PoolAddressResult[]> {
  const results: PoolAddressResult[] = [];
  for (const key of keys) {
    const address = key.address ?? '';
    try {
      await leavePool(key);
      results.push({ address, ok: true });
    } catch (err) {
      results.push({ address, ok: false, error: resultError(err) });
    }
  }
  return results;
}
