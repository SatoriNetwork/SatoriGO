// The Monero side of the Satori GO gateway, as seen from the page: where the
// node set lives, one cheap health read, and the restore-height arithmetic
// (the Monero engine design notes §6.6 and §7).
//
// This module is deliberately tiny. Everything that actually talks to monerod
// in volume (getblocks.bin, get_outs.bin, sendrawtransaction ...) is done by
// wallet2 inside the monero-ts worker, whose XHRs the worker wrapper
// (public/xmr-worker.js) reroutes to `<gateway>/xmr/<set>/<path>` and tags with
// the client token. What is left for plain fetch is the one call the UI makes
// WITHOUT opening a wallet: `get_info`, for the tip height a freshly added
// wallet's restore height is taken from, and for "is the node set up?".
//
// Rules, the same ones evm/rpc.ts states for its own traffic:
//   - One host. Every URL built here is under the gateway; hosts.test-style
//     pins can grep this directory for anything else.
//   - A request body never appears in an error message. get_info has no
//     params, but the rule is kept so a later method cannot break it quietly.
//   - Text from the node is length capped before it reaches an Error.

import type { MoneroNetwork } from './keys';

/** Height of the verified tip on 2026-09-28, the day the derivation scheme was
 *  fixed. Keys derived from a Satori phrase by this release did not exist
 *  before it, so no output can pay them below this height: it is the floor for
 *  a derived wallet's restore height (§6.6), which keeps a second machine that
 *  lost the entry's own height from scanning years of chain for nothing.
 *  NOT a floor for an imported 25-word wallet, which can be arbitrarily old. */
export const MONERO_RELEASE_HEIGHT = 3772358;

/** How far below the tip a derived wallet starts scanning (§6.6). A small
 *  margin so a payment made seconds before the wallet was added, and mined in
 *  the next block or two, is still inside the scanned range. */
export const MONERO_NEW_WALLET_MARGIN = 20;

/** A block every 120 s, Monero's target since v2. */
const BLOCK_SECONDS = 120;

/** The estimator's anchor: the gateway reported height 3772368 at about
 *  2026-09-28T13:50Z (measured during the research, §6.6). */
const ANCHOR_HEIGHT = 3772368;
const ANCHOR_TIME_MS = Date.UTC(2026, 8, 28, 13, 50, 0);

/** Before the v2 hard fork Monero targeted a block every 60 s, twice today's
 *  rate. The fork activated at height 1,009,827 on 2016-03-23. A single
 *  120 s line drawn back from today's anchor therefore lands ABOVE the real
 *  height for every date before the fork (the chain grew faster than the line
 *  assumes), which is the one direction an estimate must never err in: a
 *  wallet from 2015 would start scanning about 200,000 blocks after its first
 *  receipts. Dates before the fork are estimated from the fork itself at 60 s
 *  blocks instead. The fork's time of day is rounded down to midnight UTC,
 *  which only pushes the estimate lower (safer); the week of margin covers it. */
const V2_FORK_HEIGHT = 1009827;
const V2_FORK_TIME_MS = Date.UTC(2016, 2, 23, 0, 0, 0);
const V1_BLOCK_SECONDS = 60;

/** Safety margin subtracted from a date estimate: one week of blocks. The
 *  estimate drifts with real block times (a few percent either way over a
 *  year), and starting a week early costs about 5,000 blocks (a couple of
 *  minutes) while starting a day late loses funds from view. */
const ESTIMATE_MARGIN_BLOCKS = 5040;

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_FOREIGN_TEXT = 200;

/** Node-set names are one gateway path segment: the same pattern the gateway
 *  enforces (`/^[a-z0-9-]{1,32}$/`). Anything else could climb out of
 *  `/xmr/<set>/`, so it is refused here rather than URL-encoded. */
export function isValidMoneroNodeSet(nodeSet: string): boolean {
  return typeof nodeSet === 'string' && /^[a-z0-9-]{1,32}$/.test(nodeSet);
}

/** The gateway base without a trailing slash; throws when there is none.
 *  Monero has no fallback host: without the gateway there is no node. */
function normalizeGateway(gatewayUrl: string): string {
  const raw = typeof gatewayUrl === 'string' ? gatewayUrl.trim().replace(/\/+$/, '') : '';
  if (!raw) throw new Error('Monero needs the Satori GO gateway, and this build has none configured.');
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('The gateway URL is not a valid URL.');
  }
  if (parsed.protocol !== 'https:' && parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    // A local gateway over http is allowed for development only.
    throw new Error('The gateway must be reached over https.');
  }
  return raw;
}

/** `<gateway>/xmr/<set>`: the prefix every monerod path goes under (§7). */
export function moneroGatewayBase(gatewayUrl: string, nodeSet: string): string {
  if (!isValidMoneroNodeSet(nodeSet)) throw new Error(`Not a valid Monero node set name: "${String(nodeSet).slice(0, 40)}".`);
  return `${normalizeGateway(gatewayUrl)}/xmr/${nodeSet}`;
}

/** Headers for a gateway request: the client token when there is one. The
 *  gateway authenticates by it (Firefox's moz-extension origin is random per
 *  install, so Origin cannot be allowlisted). Not a secret: it ships in the
 *  bundle. */
export function moneroGatewayHeaders(clientToken: string): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (clientToken) headers['X-Satori-Client'] = clientToken;
  return headers;
}

function capText(text: unknown): string {
  const s = typeof text === 'string' ? text : String(text ?? '');
  return s.length > MAX_FOREIGN_TEXT ? `${s.slice(0, MAX_FOREIGN_TEXT)}...` : s;
}

/** The node's tip, as the gateway's current node for `nodeSet` reports it.
 *  POST json_rpc get_info. Throws on transport failure, a non-2xx answer, a
 *  JSON-RPC error, or an answer without a sane height. `version` is the
 *  daemon release from get_info's `version` string ("0.18.4.3"), encoded as
 *  major << 16 | minor so it compares as one number; 0 when the node does not
 *  say (restricted nodes may blank it). */
export async function moneroDaemonInfo(
  gatewayUrl: string,
  token: string,
  nodeSet: string,
  signal?: AbortSignal,
  network: MoneroNetwork = 'mainnet',
): Promise<{ height: number; version: number; status: string }> {
  const url = `${moneroGatewayBase(gatewayUrl, nodeSet)}/json_rpc`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
  const onOuterAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', onOuterAbort, { once: true });
  }
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: moneroGatewayHeaders(token),
      body: JSON.stringify({ jsonrpc: '2.0', id: '0', method: 'get_info' }),
      signal: ctrl.signal,
      cache: 'no-store',
      credentials: 'omit',
    });
  } catch (e) {
    const aborted = ctrl.signal.aborted;
    throw new Error(
      aborted && !signal?.aborted
        ? 'Monero node did not answer in time (get_info).'
        : aborted
          ? 'Monero node request was cancelled (get_info).'
          : `Monero node unreachable (get_info): ${capText((e as Error)?.message)}`,
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onOuterAbort);
  }
  if (!res.ok) throw new Error(`Monero gateway answered HTTP ${res.status} (get_info).`);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error('Monero node sent something that is not JSON (get_info).');
  }
  return parseDaemonInfo(body, network);
}

/** Split out for tests: the shape checks on a get_info reply. */
export function parseDaemonInfo(
  body: unknown,
  network: MoneroNetwork = 'mainnet',
): { height: number; version: number; status: string } {
  const obj = (body ?? {}) as { error?: { message?: unknown }; result?: Record<string, unknown> };
  if (obj.error) throw new Error(`Monero node refused get_info: ${capText(obj.error.message)}`);
  const r = obj.result;
  if (!r || typeof r !== 'object') throw new Error('Monero node reply to get_info had no result.');
  const height = r.height;
  if (typeof height !== 'number' || !Number.isSafeInteger(height) || height <= 0) {
    throw new Error('Monero node reply to get_info had no valid height.');
  }
  // The node's network is checked before its height is believed, for the reason
  // evm/rpc.ts checks eth_chainId: a node set misconfigured to point at
  // stagenet would otherwise hand a mainnet wallet a restore height (and, in
  // the worker, blocks) from another chain. Restricted nodes report `nettype`;
  // older ones only the three booleans.
  const nettype =
    typeof r.nettype === 'string'
      ? r.nettype
      : r.mainnet === true
        ? 'mainnet'
        : r.stagenet === true
          ? 'stagenet'
          : r.testnet === true
            ? 'testnet'
            : '';
  if (nettype && nettype !== network) {
    throw new Error(`Monero node is on ${capText(nettype)}, not ${network}.`);
  }
  const status = typeof r.status === 'string' ? capText(r.status) : '';
  if (status && status !== 'OK') throw new Error(`Monero node is not ready (${status}).`);
  // get_info has no numeric daemon version; `version` is a release string on
  // current nodes ("0.18.4.3"). Encode major.minor the way get_version does
  // (major << 16 | minor) so callers get one comparable number either way.
  let version = 0;
  if (typeof r.version === 'string') {
    const m = /^(\d+)\.(\d+)/.exec(r.version);
    if (m) version = (Number(m[1]) << 16) | Number(m[2]);
  } else if (typeof r.version === 'number' && Number.isSafeInteger(r.version)) {
    version = r.version;
  }
  return { height, version, status: status || 'OK' };
}

/** Restore height for a wallet derived from the Satori phrase and added now:
 *  the tip minus a small margin, never below the release floor (§6.6). */
export function restoreHeightForNewWallet(tipHeight: number): number {
  if (!Number.isSafeInteger(tipHeight) || tipHeight < 0) throw new Error('Tip height must be a non-negative integer.');
  return Math.max(tipHeight - MONERO_NEW_WALLET_MARGIN, MONERO_RELEASE_HEIGHT);
}

/**
 * A restore height for an imported wallet created on `date` (§6.6).
 *
 *   height = anchorHeight + (date - anchorTime) / 120 s - one week of blocks
 *
 * clamped to [0, estimated tip at `now`]. A date in the future is read as
 * `now` (a wallet cannot have been created tomorrow). A local estimate rather
 * than monero-ts's getHeightByDate: that costs 12 round trips and 5 to 14 s,
 * and the week of margin already absorbs block-time drift.
 *
 * Two segments, because the block time halved at the v2 fork (see
 * V2_FORK_HEIGHT): the 120 s line from today's anchor, and a 60 s line from
 * the fork for the years before it. The answer is the LOWER of the two, which
 * is the accurate one on each side of the fork and keeps the function
 * monotonic through it (both lines rise with the date, so their minimum does).
 */
export function estimateHeightForDate(date: Date, now: Date = new Date()): number {
  const t = date instanceof Date ? date.getTime() : Number.NaN;
  const n = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(t)) throw new Error('Not a valid date.');
  const at = Number.isFinite(n) ? Math.min(t, n) : t;
  const sinceAnchor = ANCHOR_HEIGHT + Math.floor((at - ANCHOR_TIME_MS) / 1000 / BLOCK_SECONDS);
  const sinceFork = V2_FORK_HEIGHT + Math.floor((at - V2_FORK_TIME_MS) / 1000 / V1_BLOCK_SECONDS);
  const est = Math.min(sinceAnchor, sinceFork) - ESTIMATE_MARGIN_BLOCKS;
  return Math.max(0, est);
}
