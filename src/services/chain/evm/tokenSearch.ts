// "Search a token by name or symbol" for the Add token modal on an EVM chain
// (owner's request, 2026-08-19). Typing a contract address still works and is
// still the only identity a token has here; this module only helps the user
// FIND that address, it never decides what a token is.
//
// Source: the CoinGecko token lists, keyless, CORS-open, one file per chain:
//   https://tokens.coingecko.com/<slug>/all.json
// shaped `{ tokens: [{ chainId, address, name, symbol, decimals, logoURI }] }`
// (Base = 'base', 2571 tokens; BNB Chain = 'binance-smart-chain', 3465 tokens;
// verified live 2026-08-19, Cache-Control: max-age=1800). One host, one GET per
// chain per day.
//
// THREE RULES THIS MODULE KEEPS:
//
// (a) THE LIST IS A DIRECTORY, NOT AN AUTHORITY. Nothing here is trusted as
//     token metadata: after the user picks a row, the store still adds the
//     token by its CONTRACT ADDRESS and reads symbol and decimals from the
//     chain (see liveStore addEvmToken), exactly as if the address had been
//     pasted. A wrong `symbol` in this list can therefore mislabel a search
//     ROW, never a balance. The lists also normalise symbols to upper case
//     ("CBBTC" where the contract answers "cbBTC"), which is exactly why the
//     row's label is not what ends up on the token list on Home.
//
// (b) `logoURI` IS IGNORED ON PURPOSE. The extension's CSP allows images from
//     `'self' data: blob:` and the Satori GO gateway origin only, so a
//     third-party image URL cannot be rendered
//     at all; token marks come from the Trust Wallet probe in tokenLogos.ts,
//     which fetches and validates the bytes. Keeping the field out of the
//     parsed entry means no caller can ever try.
//
// (c) NEVER THROWS. Every failure (host down, HTTP error, non-JSON body,
//     wrong shape) comes back as `{ ok: false, error }`, because the Add token
//     modal has to keep working as an address field when search is unavailable.

import { isEvmAddress, normalizeEvmAddress } from './keys';
import { evmGatewayHeaders, evmGatewayUrl } from './endpoints';

/** The manifest match pattern the token lists need (dev builds without a gateway). */
export const TOKEN_LIST_HOST_PATTERN = 'https://tokens.coingecko.com/*';

const TOKEN_LIST_BASE = 'https://tokens.coingecko.com';

/** How long a downloaded list stays usable. The lists move slowly (a new
 *  listing a day is a lot) and the file is a few hundred KB, so a day is the
 *  honest trade between freshness and re-downloading it in every popup. */
export const TOKEN_LIST_TTL_MS = 24 * 60 * 60 * 1000;

/** Refuse a body larger than this: the biggest real list is ~1.5 MB unzipped,
 *  and a runaway response would be parsed into extension memory. */
export const MAX_TOKEN_LIST_BYTES = 8 * 1024 * 1024;

/** Highest ERC-20 `decimals` this accepts. 18 is the norm, a few tokens use
 *  more; past 36 the entry is malformed, not exotic. */
const MAX_TOKEN_DECIMALS = 36;

/** One searchable token. `address` is the EIP-55 checksummed contract (the
 *  lists publish lowercase); `symbol`/`name` are display hints for the search
 *  row only, see rule (a) above. */
export interface TokenListEntry {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
}

export type TokenListResult =
  | { ok: true; entries: TokenListEntry[] }
  | { ok: false; error: string };

/** The list URL for a chain slug, or null when the slug is not a plain
 *  registry name (no path traversal into another host's file). With a gateway
 *  configured the list comes from `<gateway>/evm/tokenlist/<slug>` (the same
 *  CoinGecko file, cached server-side); otherwise from CoinGecko directly. */
export function tokenListUrl(slug: string, gateway: string = evmGatewayUrl()): string | null {
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) return null;
  if (gateway) return `${gateway}/evm/tokenlist/${slug}`;
  return `${TOKEN_LIST_BASE}/${slug}/all.json`;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Turn a decoded `all.json` body into compact entries. Unknown fields are
 * dropped; an entry is dropped when its address is not a 20-byte hex address
 * or its symbol is empty (nothing to match on and nothing to show), and when
 * its `decimals` is not a plain integer in range. Duplicate addresses keep the
 * first occurrence, so the list's own order survives.
 */
export function parseTokenList(body: unknown): TokenListEntry[] {
  const raw = (body as { tokens?: unknown } | null)?.tokens;
  if (!Array.isArray(raw)) return [];
  const out: TokenListEntry[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const address = readString(row.address);
    if (!isEvmAddress(address)) continue;
    const symbol = readString(row.symbol);
    if (!symbol) continue;
    const decimals = row.decimals;
    if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > MAX_TOKEN_DECIMALS) continue;
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ address: normalizeEvmAddress(address), name: readString(row.name) || symbol, symbol, decimals });
  }
  return out;
}

interface CacheRow {
  entries: TokenListEntry[];
  /** When the list was downloaded, by the clock passed to fetchTokenList. */
  at: number;
}

/** Downloaded lists, per slug. Module scope: the popup asks for the same chain
 *  on every keystroke, and this is what keeps that to one GET a day. */
const cache = new Map<string, CacheRow>();
/** Downloads in flight, per slug, so ten keystrokes share one request. */
const inFlight = new Map<string, Promise<TokenListResult>>();

/** Drop every cached list and in-flight entry (unit tests only). */
export function clearTokenListCacheForTests(): void {
  cache.clear();
  inFlight.clear();
}

async function downloadTokenList(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<TokenListResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal, headers: evmGatewayHeaders() });
    if (!res.ok) return { ok: false, error: `token list HTTP ${res.status}` };
    const length = Number(res.headers.get('content-length') ?? '0');
    if (length > MAX_TOKEN_LIST_BYTES) return { ok: false, error: 'token list too large' };
    const body: unknown = await res.json();
    const entries = parseTokenList(body);
    if (entries.length === 0) return { ok: false, error: 'token list is empty or malformed' };
    return { ok: true, entries };
  } catch {
    return { ok: false, error: 'token list unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The token list for a chain slug: from the day-old cache when there is one,
 * otherwise downloaded once (concurrent callers share the same request).
 * Only successes are cached, so a failure is retried by the next keystroke.
 * Never throws.
 */
export async function fetchTokenList(
  slug: string,
  fetchImpl: typeof fetch = globalThis.fetch?.bind(globalThis),
  opts: { now?: () => number; timeoutMs?: number } = {},
): Promise<TokenListResult> {
  const now = opts.now ?? Date.now;
  const url = tokenListUrl(slug);
  if (!url) return { ok: false, error: 'no token list for this chain' };
  const hit = cache.get(slug);
  if (hit && now() - hit.at < TOKEN_LIST_TTL_MS) return { ok: true, entries: hit.entries };
  const running = inFlight.get(slug);
  if (running) return running;
  if (!fetchImpl) return { ok: false, error: 'token list unreachable' };
  const pending = downloadTokenList(url, fetchImpl, opts.timeoutMs ?? 12_000)
    .then((res) => {
      if (res.ok) cache.set(slug, { entries: res.entries, at: now() });
      return res;
    })
    .finally(() => {
      inFlight.delete(slug);
    });
  inFlight.set(slug, pending);
  return pending;
}

/** A query shorter than this cannot select an address prefix usefully: '0x'
 *  alone matches every token on the chain. '0x' plus four hex digits can. */
const MIN_ADDRESS_QUERY = 6;

/** Match strength, best first. Ties keep the list's own order. */
function rankOf(entry: TokenListEntry, query: string): number {
  const symbol = entry.symbol.toLowerCase();
  const name = entry.name.toLowerCase();
  if (symbol === query) return 0;
  if (symbol.startsWith(query)) return 1;
  if (name.startsWith(query)) return 2;
  if (symbol.includes(query) || name.includes(query)) return 3;
  if (query.length >= MIN_ADDRESS_QUERY && entry.address.toLowerCase().startsWith(query)) return 4;
  return -1;
}

/**
 * Up to `limit` tokens matching `query`, case-insensitive, best match first:
 * an exact symbol, then a symbol prefix, then a name prefix, then a symbol or
 * name substring, then a contract-address prefix. Stable: entries of equal
 * rank stay in the list's order, so the same query always answers the same
 * rows in the same order.
 */
export function searchTokenList(entries: readonly TokenListEntry[], query: string, limit = 8): TokenListEntry[] {
  const q = query.trim().toLowerCase();
  if (!q || limit <= 0) return [];
  const scored: Array<{ entry: TokenListEntry; rank: number; index: number }> = [];
  entries.forEach((entry, index) => {
    const rank = rankOf(entry, q);
    if (rank >= 0) scored.push({ entry, rank, index });
  });
  // Same tier: the SHORTER symbol first (for "usd" that puts USDC and USDT
  // above USDC+ and USDbC), then alphabetical, then list order. The list's
  // own order is arbitrary and must not decide what the top row is.
  scored.sort(
    (a, b) =>
      a.rank - b.rank ||
      a.entry.symbol.length - b.entry.symbol.length ||
      a.entry.symbol.localeCompare(b.entry.symbol) ||
      a.entry.name.localeCompare(b.entry.name) ||
      a.index - b.index,
  );
  return scored.slice(0, limit).map((s) => s.entry);
}
