// Satori pool staking (delegation) on Base: HTTP client for the Satori central server.
//
// This is NOT chain code: staking on Satori is NOT an on-chain transaction. The
// user's SATORI stays put on their own Base address; that address is simply
// registered as a "lender" of a chosen pool on Satori's central server
// (network.satorinet.io). Nothing here builds, signs, or broadcasts a tx.
//
// Same exchange as the neuron (satori-lite web/routes.py, satorilib server.py),
// verified live with a throwaway key on 2026-11-04. A key the server has not seen
// logs in as a peer of its own:
//   POST   /api/v1/auth/login     headers alias-pubkey, message, signature (EIP-191)
//                                 -> { access_token, expires_in, ... }
//   GET    /api/v1/pool/open      -> { "pools": [{address, alias|null, commission}] }
//   GET    /api/v1/lender/status?wallet_address=0x.. -> { pool_address, is_pool, ... }
//   POST   /api/v1/lender/lend    Authorization: Bearer, { pool_address, source }
//   DELETE /api/v1/lender/lend    Authorization: Bearer
//
// The access token lives for one join or leave and is never stored.
//
// SECURITY: never log private keys, public keys, signatures, or tokens.

import { paginate } from './activityFeed';

/** Base URL of the Satori central server (network.satorinet.io — a DIFFERENT
 *  host from satorinet.io; see public/manifest.json host_permissions). */
export const SATORI_NETWORK_BASE = 'https://network.satorinet.io';

/** How long any single request may take before we abort it (offline guard). */
const REQUEST_TIMEOUT_MS = 15_000;
const AUDIT_BODY_TIMEOUT_MS = 45_000;

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

/** Signs the login message with the active account's key, which stays in the
 *  wallet service: only the compressed public key (hex) and the signature leave. */
export type PoolSigner = (message: string) => { aliasPubkey: string; signature: string };

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

/** The server's own reason for a refusal when it gave one (`detail`, e.g. a pool
 *  closed to new lenders), so the user sees why rather than a status code. */
async function refusalReason(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    const detail = (JSON.parse(text) as Record<string, unknown>)?.detail;
    if (typeof detail === 'string' && detail.trim()) return ` ${detail.trim().slice(0, 160)}`;
  } catch {
    // Not JSON: the status code alone says enough.
  }
  return '';
}

/** Log in with `sign` and return the access token. The message is a timestamp of
 *  the wallet's own making, as the neuron signs, never text a server supplied. */
async function login(sign: PoolSigner): Promise<string> {
  const message = String(Date.now() / 1000);
  const { aliasPubkey, signature } = sign(message);
  const res = await requestWithTimeout(`${SATORI_NETWORK_BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'alias-pubkey': aliasPubkey, message, signature },
  });
  if (res.status >= 400) {
    throw new SatoriServerError(`Signing in to the Satori network failed (HTTP ${res.status}).${await refusalReason(res)}`, res.status);
  }
  const token = ((await parseJsonOk(res, 'Signing in')) as Record<string, unknown>)?.access_token;
  if (typeof token !== 'string' || !token) {
    throw new SatoriServerError('Signing in: no access token in response.', res.status);
  }
  return token;
}

/**
 * Register the signer's address as a lender of `poolAddress` (join/stake). The
 * server handles leave-then-join when the address already lends elsewhere.
 * Resolves on success; throws SatoriOfflineError / SatoriServerError otherwise.
 */
export async function joinPool(poolAddress: string, sign: PoolSigner): Promise<void> {
  const token = await login(sign);
  const res = await requestWithTimeout(`${SATORI_NETWORK_BASE}/api/v1/lender/lend`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ pool_address: poolAddress, source: LEND_SOURCE }),
  });
  if (res.status >= 400) {
    throw new SatoriServerError(`Joining the pool failed (HTTP ${res.status}).${await refusalReason(res)}`, res.status);
  }
}

/** Deregister the signer's address as a lender (leave/unstake). Resolves on
 *  success; throws otherwise. */
export async function leavePool(sign: PoolSigner): Promise<void> {
  const token = await login(sign);
  const res = await requestWithTimeout(`${SATORI_NETWORK_BASE}/api/v1/lender/lend`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status >= 400) {
    throw new SatoriServerError(`Leaving the pool failed (HTTP ${res.status}).${await refusalReason(res)}`, res.status);
  }
}


/** One address's place in the current reward drop. */
export interface MerkleProofEntry {
  /** Lifetime entitlement in wei; the contract mints the part not yet minted. */
  amountBase: bigint;
  proof: string[];
}

/** The address's Merkle proof, or null when it is not in the current drop (404). */
/** One UTC day's public audit file, or null when the server has none for that date. */
export async function fetchSatoriAuditCsv(file: 'predictors' | 'stakers', date: string): Promise<string | null> {
  const url = `${SATORI_NETWORK_BASE}/api/v1/audit/${file}?date=${encodeURIComponent(date)}`;
  const res = await requestWithTimeout(url, { method: 'GET' });
  if (res.status === 404) return null;
  if (!res.ok) throw new SatoriServerError(`Reading rewards history: HTTP ${res.status}.`, res.status);
  // The timeout above ends with the headers; these files are large enough for a
  // stalled body to matter, and the days behind it wait for this one.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SatoriOfflineError('Could not reach the Satori network (timed out).')), AUDIT_BODY_TIMEOUT_MS);
  });
  try {
    return await Promise.race([res.text(), stalled]);
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchMerkleProof(address: string): Promise<MerkleProofEntry | null> {
  const url = `${SATORI_NETWORK_BASE}/api/v1/merkle/proof/${encodeURIComponent(address)}`;
  const res = await requestWithTimeout(url, { method: 'GET' });
  if (res.status === 404) return null;
  const json = await parseJsonOk(res, 'Reading rewards');
  const { amountWei, proof } = (json ?? {}) as Record<string, unknown>;
  if (
    typeof amountWei !== 'string' ||
    !/^\d+$/.test(amountWei) ||
    !Array.isArray(proof) ||
    proof.some((node) => typeof node !== 'string')
  ) {
    throw new SatoriServerError('Reading rewards: unexpected response shape.', res.status);
  }
  return { amountBase: BigInt(amountWei), proof: proof as string[] };
}

/** The Base config the server currently publishes, reward contracts included. */
export async function fetchBaseConfig(): Promise<Record<string, unknown>> {
  const res = await requestWithTimeout(`${SATORI_NETWORK_BASE}/api/v1/base/config`, { method: 'GET' });
  const json = await parseJsonOk(res, 'Reading the reward contracts');
  return (json ?? {}) as Record<string, unknown>;
}
