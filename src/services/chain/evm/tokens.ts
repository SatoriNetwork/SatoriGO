// Alchemy Token API: "which ERC-20s does this address hold, and what are
// they", for the wallet's Import tokens button (phase of the EVM rollout
// after rpc.ts / erc20.ts, the EVM rollout plan).
//
// This module talks ONLY through EvmRpcClient (rpc.ts): alchemy_getTokenBalances
// to enumerate contracts with a confirmed non-zero balance, alchemy_getTokenMetadata
// to read symbol/decimals/name/logo for each one found. No fetch of its own, no
// network beyond what call()/batch() already do.
//
// alchemy_getTokenBalances and alchemy_getTokenMetadata are ALCHEMY-SPECIFIC
// JSON-RPC extensions, not part of the standard Ethereum JSON-RPC surface. When
// the active endpoint is not Alchemy (or an Alchemy-compatible proxy) the node
// answers "method not found", and this module reports that as
// EvmTokenApiError('unsupported') rather than crashing or claiming the wallet
// holds no tokens: those are two very different messages for the UI to show.
//
// A single held token whose metadata cannot be read is not this module's
// failure: it is dropped and counted in `skipped`, because a token with no
// symbol or no decimals cannot be shown or scaled, and the user has a second
// path (adding it by contract address) if the chain itself can answer for it.

import {
  type EvmRpcClient,
  type EvmRpcBatchResult,
  EvmRpcError,
  EvmRpcUnavailableError,
} from './rpc';
import { isEvmAddress, normalizeEvmAddress } from './keys';
import { type EvmTokenRef } from './chains';

/** One ERC-20 the address holds with a confirmed non-zero balance. Identity is
 *  still the contract address (see EvmTokenRef): symbol/decimals here are
 *  ALWAYS read fresh from alchemy_getTokenMetadata, never guessed. */
export interface HeldToken extends EvmTokenRef {
  /** EIP-55 checksummed contract address. */
  address: string;
  symbol: string;
  decimals: number;
  name: string;
  /** Base units, i.e. NOT divided by 10**decimals. Always > 0n: a zero or
   *  unparseable balance is dropped before a HeldToken is ever built. */
  amountBase: bigint;
  logo: string | null;
}

/** Reasons listHeldTokens() can fail the whole call. A per-token metadata
 *  problem never reaches this: it is counted in `skipped` instead. */
export type EvmTokenApiErrorReason = 'unavailable' | 'unsupported' | 'rate-limited' | 'malformed';

/**
 * Thrown by listHeldTokens() for every failure that stops the whole call.
 *
 *  - 'unavailable': no endpoint answered at the transport level
 *    (EvmRpcUnavailableError), or the node refused for a reason that is
 *    neither of the two below. `detail` carries the underlying message.
 *  - 'rate-limited': the node's refusal reads as a rate limit.
 *  - 'unsupported': the active endpoint does not implement the Alchemy Token
 *    API at all (wrong provider for this build). The UI should say so, not
 *    say the wallet holds nothing.
 *  - 'malformed': the endpoint answered but the shape is not what the Alchemy
 *    Token API promises (no `tokenBalances` array).
 */
export class EvmTokenApiError extends Error {
  readonly reason: EvmTokenApiErrorReason;
  readonly detail?: string;

  constructor(reason: EvmTokenApiErrorReason, detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'EvmTokenApiError';
    this.reason = reason;
    this.detail = detail;
  }
}

/** Alchemy pages tokenBalances up to 100 per call; 5 pages is 500 contracts,
 *  far past what any real wallet holds, so this is a safety cap, not a
 *  realistic ceiling. */
const DEFAULT_MAX_PAGES = 5;

/** alchemy_getTokenMetadata is one contract per JSON-RPC call, so a batch of
 *  20 keeps one HTTP round trip well inside common node/proxy request-size
 *  limits while still cutting round trips by 20x versus one call each. */
const METADATA_CHUNK_SIZE = 20;

const RATE_LIMIT_RE = /rate limit|429|too many/i;
const UNSUPPORTED_RE = /does not exist|not supported|method not found|-32601/i;

/** A hex value that may be a 32-byte data word with leading zeros (what
 *  alchemy_getTokenBalances returns) or a plain quantity. Strict on shape
 *  (0x, hex only, non-empty), lenient on padding. */
function parseDataWord(value: unknown): bigint {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error('not a hex value');
  }
  return BigInt(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Map a failure from rpc.call()/rpc.batch() to the one EvmTokenApiError this
 * module promises (rule 6). Anything that is not an EvmRpcError or an
 * EvmRpcUnavailableError is not this module's failure to interpret: it is
 * allowed out unchanged, the same convention rpc.ts's own withEndpoint uses
 * for a genuine bug versus a network answer.
 */
function mapRpcError(err: unknown): never {
  if (err instanceof EvmRpcUnavailableError) {
    throw new EvmTokenApiError('unavailable', err.message);
  }
  if (err instanceof EvmRpcError) {
    if (RATE_LIMIT_RE.test(err.message)) {
      throw new EvmTokenApiError('rate-limited', err.message);
    }
    if (UNSUPPORTED_RE.test(err.message)) {
      throw new EvmTokenApiError('unsupported', err.message);
    }
    throw new EvmTokenApiError('unavailable', err.message);
  }
  throw err;
}

interface AlchemyBalancesPage {
  tokenBalances: unknown[];
  pageKey?: string;
}

/** Validate the outer shape of one alchemy_getTokenBalances answer. Only the
 *  page envelope is checked here (rule 6's 'malformed'); each entry in
 *  `tokenBalances` is validated on its own in collectBalances() below,
 *  because one bad entry must not lose every other token on the page. */
function parseBalancesPage(result: unknown): AlchemyBalancesPage {
  if (!isRecord(result) || !Array.isArray(result.tokenBalances)) {
    throw new EvmTokenApiError(
      'malformed',
      'alchemy_getTokenBalances answered without a tokenBalances array',
    );
  }
  const pageKey =
    typeof result.pageKey === 'string' && result.pageKey.length > 0 ? result.pageKey : undefined;
  return { tokenBalances: result.tokenBalances, pageKey };
}

/**
 * Page through alchemy_getTokenBalances (rule 2), keep only entries with a
 * confirmed non-zero balance and no error (rule 3), and dedupe contracts
 * case-insensitively across pages, keeping the first occurrence in the order
 * Alchemy returned them (rule 7). The wallet address is sent EXACTLY as
 * given: Alchemy accepts any case, and this is not the value being
 * checksummed for output (rule 1).
 */
async function collectBalances(
  rpc: EvmRpcClient,
  address: string,
  maxPages: number,
): Promise<Map<string, bigint>> {
  const balances = new Map<string, bigint>();
  let pageKey: string | undefined;
  let pagesFetched = 0;

  while (pagesFetched < maxPages) {
    const params: unknown[] =
      pageKey === undefined ? [address, 'erc20'] : [address, 'erc20', { pageKey }];
    let raw: unknown;
    try {
      raw = await rpc.call('alchemy_getTokenBalances', params);
    } catch (err) {
      mapRpcError(err);
    }
    pagesFetched++;
    const page = parseBalancesPage(raw);

    for (const entry of page.tokenBalances) {
      if (!isRecord(entry)) continue;
      if (typeof entry.error === 'string') continue;
      if (typeof entry.contractAddress !== 'string' || !isEvmAddress(entry.contractAddress)) continue;
      if (entry.tokenBalance === null || entry.tokenBalance === undefined) continue;
      let amount: bigint;
      try {
        // Alchemy returns tokenBalance as a full 32-byte data word ("0x000…01"),
        // NOT a canonical JSON-RPC quantity, so the strict fromQuantity (which
        // refuses leading zeros) would drop every real balance. Verified live:
        // the vector account's 24 held tokens all arrive zero-padded.
        amount = parseDataWord(entry.tokenBalance);
      } catch {
        continue;
      }
      if (amount <= 0n) continue;
      const key = normalizeEvmAddress(entry.contractAddress);
      if (!balances.has(key)) balances.set(key, amount);
    }

    if (!page.pageKey) break;
    pageKey = page.pageKey;
  }

  return balances;
}

interface ParsedMetadata {
  decimals: number;
  symbol: string;
  name: string | null;
  logo: string | null;
}

/** Validate and extract one alchemy_getTokenMetadata answer (rule 4). Returns
 *  null for anything that cannot be trusted: not a record, `decimals` not an
 *  integer in 0..255, or `symbol` missing/empty once trimmed. Those tokens
 *  are dropped and counted in `skipped` by the caller. */
function parseMetadata(value: unknown): ParsedMetadata | null {
  if (!isRecord(value)) return null;
  const decimals = value.decimals;
  if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    return null;
  }
  const rawSymbol = value.symbol;
  if (typeof rawSymbol !== 'string') return null;
  const symbol = rawSymbol.trim();
  if (symbol.length === 0) return null;
  const name = typeof value.name === 'string' ? value.name : null;
  const logo = typeof value.logo === 'string' ? value.logo : null;
  return { decimals, symbol, name, logo };
}

/**
 * Read symbol/decimals/name/logo for every contract in `addresses` (already
 * checksummed, already deduped), one rpc.batch() call per chunk of 20 (rule
 * 4). Order of `tokens` follows `addresses`, i.e. the order Alchemy's
 * balances answer returned them (rule 5); nothing here re-sorts by value.
 */
async function collectMetadata(
  rpc: EvmRpcClient,
  addresses: readonly string[],
  balances: ReadonlyMap<string, bigint>,
): Promise<{ tokens: HeldToken[]; skipped: number }> {
  const tokens: HeldToken[] = [];
  let skipped = 0;

  for (const group of chunk(addresses, METADATA_CHUNK_SIZE)) {
    let results: EvmRpcBatchResult[];
    try {
      results = await rpc.batch(
        group.map((address) => ({ method: 'alchemy_getTokenMetadata', params: [address] })),
      );
    } catch (err) {
      mapRpcError(err);
    }

    for (let i = 0; i < group.length; i++) {
      const address = group[i];
      const outcome = results[i];
      const parsed = outcome.ok ? parseMetadata(outcome.result) : null;
      if (!parsed) {
        skipped++;
        continue;
      }
      tokens.push({
        address,
        symbol: parsed.symbol,
        decimals: parsed.decimals,
        name: parsed.name ?? parsed.symbol,
        logo: parsed.logo,
        // Always present: `addresses` came from balances.keys().
        amountBase: balances.get(address)!,
      });
    }
  }

  return { tokens, skipped };
}

/**
 * Every ERC-20 `address` holds with a non-zero balance, newest metadata read
 * from the chain provider.
 *
 * Throws EvmTokenApiError (see its doc for `reason`) for anything that stops
 * the whole call; never returns partial silently except for tokens whose
 * metadata could not be read, which are dropped and counted in `skipped`.
 *
 * `opts.maxPages` bounds how many alchemy_getTokenBalances pages are fetched
 * (default 5, i.e. up to ~500 contracts at 100 per page); pagination stops
 * earlier as soon as a page has no `pageKey`.
 */
export async function listHeldTokens(
  rpc: EvmRpcClient,
  address: string,
  opts?: { maxPages?: number },
): Promise<{ tokens: HeldToken[]; skipped: number }> {
  if (!isEvmAddress(address)) {
    throw new Error(
      `invalid EVM address: ${address} (expected 0x followed by 40 hex characters, ` +
        'with a valid EIP-55 checksum when mixed case)',
    );
  }
  const maxPages = opts?.maxPages ?? DEFAULT_MAX_PAGES;
  const balances = await collectBalances(rpc, address, maxPages);
  return collectMetadata(rpc, [...balances.keys()], balances);
}
