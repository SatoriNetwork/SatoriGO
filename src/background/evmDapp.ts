// window.ethereum requests, as the background worker answers them.
//
// index.ts owns the transport, the approval windows and result delivery; this
// module decides what each EIP-1193 method does. Same rules as window.evrmore:
// - no key material here, ever (only the PUBLIC liveWallets record is read);
// - connecting, signing and sending are ALWAYS deferred to an approval page;
// - a site sees only the EVM account the user connected it to.
//
// Errors follow EIP-1193: 4001 user rejected, 4100 unauthorized (not
// connected), 4200 unsupported method, 4902 unrecognized chain, -32602 invalid
// params, -32603 internal.

import { getStorage } from '../services/storage';
// Static, not loadEvmModules(): an MV3 service worker cannot import() (workerEvm.ts).
import { loadWorkerEvm } from '#worker-evm';
import {
  EVM_APPROVED_ORIGINS_KEY,
  evmApprovalFor,
  normalizeEvmApprovals,
  setEvmApproval,
  setEvmApprovalChain,
  type EvmApprovedEntry,
} from './evmApprovals';

export interface EvmDappRequestMessage {
  type: 'evm-dapp';
  id: string;
  method: string;
  params?: unknown;
  origin: string;
}

export interface EvmProviderError {
  code: number;
  message: string;
  data?: unknown;
}

export type EvmDappResponse = { result?: unknown; error?: EvmProviderError; deferred?: boolean };

/** Methods that put an approval in front of the user (index.ts opens the side
 *  panel for these while the site's click still counts as a gesture). */
export const EVM_APPROVAL_METHODS: readonly string[] = [
  'eth_requestAccounts',
  'personal_sign',
  'eth_signTypedData_v4',
  'eth_sendTransaction',
];

/** Read-only JSON-RPC methods forwarded to the chain's own RPC endpoints. An
 *  allowlist: anything that could sign, send or touch node state is not here. */
const READ_METHODS = new Set([
  'eth_blockNumber',
  'eth_call',
  'eth_estimateGas',
  'eth_feeHistory',
  'eth_gasPrice',
  'eth_getBalance',
  'eth_getBlockByHash',
  'eth_getBlockByNumber',
  'eth_getCode',
  'eth_getLogs',
  'eth_getStorageAt',
  'eth_getTransactionByHash',
  'eth_getTransactionCount',
  'eth_getTransactionReceipt',
  'eth_maxPriorityFeePerGas',
]);

/** A connected site's network switch is the user's decision: these open an
 *  approval when the site is connected and asks for a different chain. They are
 *  NOT in EVM_APPROVAL_METHODS (no side panel on a page load's silent switch). */
export const EVM_CHAIN_SWITCH_METHODS: readonly string[] = ['wallet_switchEthereumChain', 'wallet_addEthereumChain'];

/** eth_getLogs: the widest block range a site may ask for in one call. */
export const MAX_LOG_BLOCK_RANGE = 10_000n;

/** Read passthrough budget per origin, per window (in-memory; a restarted
 *  worker starts fresh, which only ever makes it more lenient for a moment). */
const READ_WINDOW_MS = 10_000;
const READ_BUDGET_CONNECTED = 300;
const READ_BUDGET_UNCONNECTED = 60;
const readUse = new Map<string, { start: number; count: number }>();

/** True when `origin` may make one more read now (and counts it). */
export function takeReadBudget(origin: string, connected: boolean, now = Date.now()): boolean {
  let u = readUse.get(origin);
  if (!u || now - u.start >= READ_WINDOW_MS) {
    u = { start: now, count: 0 };
    readUse.set(origin, u);
    if (readUse.size > 500) {
      for (const [k, v] of readUse) if (now - v.start >= READ_WINDOW_MS) readUse.delete(k);
    }
  }
  if (u.count >= (connected ? READ_BUDGET_CONNECTED : READ_BUDGET_UNCONNECTED)) return false;
  u.count++;
  return true;
}

/** Test hook: forget every origin's read budget. */
export function resetReadBudgets(): void {
  readUse.clear();
}

const WALLETS_KEY = 'liveWallets';
/** storage.session: the chain a NOT-yet-connected origin switched to. */
const ORIGIN_CHAIN_PREFIX = 'evmOriginChain:';

const err = (code: number, message: string): { error: EvmProviderError } => ({ error: { code, message } });
const USER_REJECTED: EvmProviderError = { code: 4001, message: 'User rejected the request.' };

/** A deferred outcome as the approval page reported it (a string code, or
 *  already an EIP-1193 error) -> the error the site receives. */
export function toEvmProviderError(error: unknown): EvmProviderError | undefined {
  if (error === undefined || error === null) return undefined;
  if (typeof error === 'object' && typeof (error as EvmProviderError).code === 'number') return error as EvmProviderError;
  if (error === 'user-rejected') return USER_REJECTED;
  // MetaMask's code for "a request from this site is already waiting"; dApps key off it.
  if (error === 'approval-already-open') {
    return { code: -32002, message: 'A Satori GO approval for this site is already open.' };
  }
  if (error === 'wallet-setup-required') {
    return { code: 4100, message: 'Satori GO needs an app password before it can answer this site.' };
  }
  return { code: -32603, message: String(error) };
}

interface PublicWalletEntry {
  id: string;
  name?: string;
  address?: string;
  family?: string;
}

/** Every EVM account in the PUBLIC wallet record (no vault is read). */
export async function evmWallets(): Promise<PublicWalletEntry[]> {
  const store = await getStorage().get<{ wallets?: PublicWalletEntry[] }>(WALLETS_KEY);
  const wallets = Array.isArray(store?.wallets) ? store.wallets : [];
  return wallets.filter((w) => w.family === 'evm' && typeof w.address === 'string' && w.address !== '');
}

type EvmMods = NonNullable<Awaited<ReturnType<typeof loadWorkerEvm>>>;

async function requireEvm(): Promise<EvmMods | null> {
  return loadWorkerEvm();
}

/** One read-only RPC provider per chain for the passthrough (the same public
 *  endpoints and gateway the wallet reads through). */
const providers = new Map<string, ReturnType<EvmMods['createEvmProvider']>>();
function readProvider(evm: EvmMods, chain: NonNullable<ReturnType<EvmMods['evmChainByKey']>>) {
  let p = providers.get(chain.key);
  if (!p) {
    p = evm.createEvmProvider(chain, { rpc: { endpoints: evm.evmRpcEndpoints(chain) }, tokenBalances: 'eth_call' });
    providers.set(chain.key, p);
  }
  return p;
}

async function readEntries(evm: EvmMods, validIds: ReadonlySet<string>): Promise<EvmApprovedEntry[]> {
  const raw = await getStorage().get<unknown>(EVM_APPROVED_ORIGINS_KEY);
  const { entries, changed } = normalizeEvmApprovals(raw, {
    validWalletIds: validIds,
    isChainKey: (k) => evm.isEvmChainKey(k),
    defaultChainKey: evm.DEFAULT_EVM_CHAIN_KEY,
  });
  if (changed) {
    try {
      await getStorage().set(EVM_APPROVED_ORIGINS_KEY, entries);
    } catch {
      // storage unavailable: the in-memory list still gates this request
    }
  }
  return entries;
}

/** The EVM account `origin` is connected to (and its binding), or null. */
async function connectionFor(
  evm: EvmMods,
  origin: string,
): Promise<{ entry: EvmApprovedEntry; wallet: PublicWalletEntry; entries: EvmApprovedEntry[] } | null> {
  const wallets = await evmWallets();
  const entries = await readEntries(evm, new Set(wallets.map((w) => w.id)));
  const entry = evmApprovalFor(entries, origin);
  if (!entry) return null;
  const wallet = wallets.find((w) => w.id === entry.walletId);
  return wallet ? { entry, wallet, entries } : null;
}

async function unconnectedChainKey(evm: EvmMods, origin: string): Promise<string> {
  try {
    const key = ORIGIN_CHAIN_PREFIX + origin;
    const found = (await chrome.storage.session.get(key))[key];
    if (typeof found === 'string' && evm.isEvmChainKey(found)) return found;
  } catch {
    // session storage unavailable: the default chain
  }
  return evm.DEFAULT_EVM_CHAIN_KEY;
}

/**
 * Persist an approved connection: `origin` -> the EVM account the user picked,
 * on `chainKey`. The id is checked against the EVM accounts that exist, so a
 * stale or forged id binds nothing (fails closed).
 */
export async function bindEvmOrigin(origin: string, walletId: string | undefined, chainKey: string | undefined): Promise<void> {
  const evm = await requireEvm();
  if (!evm || !walletId) return;
  const wallets = await evmWallets();
  if (!wallets.some((w) => w.id === walletId)) return;
  const entries = await readEntries(evm, new Set(wallets.map((w) => w.id)));
  const key = chainKey && evm.isEvmChainKey(chainKey) ? chainKey : await unconnectedChainKey(evm, origin);
  await getStorage().set(EVM_APPROVED_ORIGINS_KEY, setEvmApproval(entries, origin, walletId, key));
}

const isAddress = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
const isHex = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-fA-F]*$/.test(v);
/** Calldata: whole bytes only (an odd nibble count is not a byte string). */
const isHexData = (v: unknown): v is string => typeof v === 'string' && /^0x([0-9a-fA-F]{2})*$/.test(v);
const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The chain a site named in wallet_switchEthereumChain / addEthereumChain. */
function requestedChainId(params: unknown): number | null {
  const first = Array.isArray(params) ? params[0] : undefined;
  const hex = first && typeof first === 'object' ? (first as { chainId?: unknown }).chainId : undefined;
  if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]+$/.test(hex)) return null;
  const n = Number.parseInt(hex, 16);
  return Number.isSafeInteger(n) ? n : null;
}

export interface EvmDappDeps {
  /** Park the request and show the approval (index.ts deferToApproval). */
  defer(walletId: string | undefined, extra: { chainKey: string }): Promise<{ result?: unknown; error?: unknown; deferred?: boolean }>;
  /** Push an EIP-1193 event to every tab showing the requesting origin. */
  pushEvent(event: 'chainChanged' | 'accountsChanged', data: unknown): void;
}

export async function handleEvmDappRequest(msg: EvmDappRequestMessage, deps: EvmDappDeps): Promise<EvmDappResponse> {
  if (typeof msg.id !== 'string' || typeof msg.origin !== 'string' || !msg.origin) {
    return err(-32602, 'Bad request.');
  }
  const evm = await requireEvm();
  if (!evm) return err(4200, 'This build of Satori GO has no EVM engine.');

  const conn = await connectionFor(evm, msg.origin);
  const chainKey = conn ? conn.entry.chainKey : await unconnectedChainKey(evm, msg.origin);
  const chain = evm.evmChainByKey(chainKey) ?? evm.evmChainByKey(evm.DEFAULT_EVM_CHAIN_KEY)!;
  const params = msg.params;
  const accounts = conn ? [conn.wallet.address as string] : [];

  const deferred = async (walletId: string | undefined, chainKeyFor = chain.key): Promise<EvmDappResponse> => {
    const r = await deps.defer(walletId, { chainKey: chainKeyFor });
    return { result: r.result, deferred: r.deferred, error: toEvmProviderError(r.error) };
  };

  switch (msg.method) {
    case 'eth_chainId':
      return { result: evm.evmChainIdHex(chain) };
    case 'net_version':
      return { result: String(chain.chainId) };
    case 'eth_accounts':
      return { result: accounts };

    case 'eth_requestAccounts': {
      // A site that is already connected gets its account at once, however
      // many EVM accounts the wallet holds: asking again on every page load
      // taught users to click through the approval. To give a site a different
      // account, disconnect it in the wallet (Settings, Connected sites) and
      // connect again; the picker opens then.
      if (conn) return { result: accounts };
      return deferred(undefined);
    }

    case 'wallet_switchEthereumChain':
    case 'wallet_addEthereumChain': {
      const id = requestedChainId(params);
      if (id === null) return err(-32602, 'Expected [{ chainId: "0x..." }].');
      const target = evm.evmChainById(id);
      if (!target) {
        const names = evm.EVM_CHAINS.map((c) => c.displayName).join(', ');
        return msg.method === 'wallet_switchEthereumChain'
          ? err(4902, `Satori GO does not support chain ${id}. Supported: ${names}.`)
          : err(4200, `Satori GO cannot add new networks. Supported: ${names}.`);
      }
      if (target.key === chain.key) return { result: null };
      if (conn) {
        // A connected site's later signs and sends happen on the chain it is
        // on, so moving it is the user's call. The approval page settles it;
        // the worker applies the PARKED chain key (applyEvmChainSwitch), and
        // the storage change tells every tab of the origin.
        return deferred(conn.wallet.id, target.key);
      }
      // Not connected: the site sees no account and can do nothing but read,
      // so following it is harmless. Kept for this browser session only.
      try {
        await chrome.storage.session.set({ [ORIGIN_CHAIN_PREFIX + msg.origin]: target.key });
      } catch {
        return err(-32603, 'Could not switch chain.');
      }
      deps.pushEvent('chainChanged', evm.evmChainIdHex(target));
      return { result: null };
    }

    case 'wallet_watchAsset': {
      // Satori GO shows a token when it is a default on the chain or the user
      // added it. A site cannot add one: the wallet reads symbol and decimals
      // from the chain itself (Add token), never from a website.
      const opts = params && typeof params === 'object' && !Array.isArray(params)
        ? (params as { type?: unknown; options?: { address?: unknown } })
        : null;
      if (!opts || opts.type !== 'ERC20' || !isAddress(opts.options?.address)) {
        return err(-32602, 'Expected { type: "ERC20", options: { address } }.');
      }
      const address = opts.options.address;
      if ((chain.defaultTokens ?? []).some((t) => sameAddress(t.address, address))) return { result: true };
      if (conn) {
        const tracked = await getStorage().get<{ address?: string }[]>(`evmTokens:${conn.wallet.id}:${chain.key}`);
        if (Array.isArray(tracked) && tracked.some((t) => typeof t?.address === 'string' && sameAddress(t.address, address))) {
          return { result: true };
        }
      }
      return err(4200, `This token is not in Satori GO yet. Add it in the wallet under Add token on ${chain.displayName}.`);
    }

    case 'personal_sign': {
      if (!conn) return err(4100, 'Connect this site to Satori GO first (eth_requestAccounts).');
      const p = Array.isArray(params) ? params : [];
      // Some older sites send [address, message]; accept either order.
      const [message, address] = isAddress(p[0]) && !isAddress(p[1]) ? [p[1], p[0]] : [p[0], p[1]];
      if (typeof message !== 'string') return err(-32602, 'Expected [message, address].');
      if (address !== undefined && (!isAddress(address) || !sameAddress(address, conn.wallet.address as string))) {
        return err(4100, 'That address is not the account connected to this site.');
      }
      return deferred(conn.wallet.id);
    }

    case 'eth_signTypedData_v4': {
      if (!conn) return err(4100, 'Connect this site to Satori GO first (eth_requestAccounts).');
      const p = Array.isArray(params) ? params : [];
      if (!isAddress(p[0]) || !sameAddress(p[0], conn.wallet.address as string)) {
        return err(4100, 'That address is not the account connected to this site.');
      }
      // Refuse here, before any window opens, what cannot be signed exactly.
      try {
        const typed = evm.parseTypedData(p[1]);
        evm.typedDataDigest(typed);
        const domainChain = evm.typedDataChainId(typed);
        if (domainChain !== null && domainChain !== chain.chainId) {
          return err(-32602, `The typed data is for chain ${domainChain}, but this site is on ${chain.displayName} (${chain.chainId}).`);
        }
      } catch (e) {
        return err(-32602, e instanceof Error ? e.message : String(e));
      }
      return deferred(conn.wallet.id);
    }

    case 'eth_sendTransaction': {
      if (!conn) return err(4100, 'Connect this site to Satori GO first (eth_requestAccounts).');
      const tx = Array.isArray(params) && params[0] && typeof params[0] === 'object' ? (params[0] as Record<string, unknown>) : null;
      if (!tx) return err(-32602, 'Expected [{ to, value?, data? }].');
      if (tx.from !== undefined && (!isAddress(tx.from) || !sameAddress(tx.from, conn.wallet.address as string))) {
        return err(4100, 'That address is not the account connected to this site.');
      }
      if (!isAddress(tx.to)) return err(-32602, 'A transaction needs a "to" address. Contract deployment is not supported.');
      if (tx.value !== undefined && !isHex(tx.value)) return err(-32602, '"value" must be 0x hex wei.');
      const data = tx.data ?? tx.input;
      if (data !== undefined && !isHexData(data)) return err(-32602, '"data" must be 0x hex bytes.');
      if (tx.chainId !== undefined) {
        const id = typeof tx.chainId === 'string' ? Number.parseInt(tx.chainId, 16) : Number(tx.chainId);
        if (id !== chain.chainId) return err(-32602, `The transaction is for chain ${id}, but this site is on ${chain.displayName}.`);
      }
      return deferred(conn.wallet.id);
    }

    case 'eth_sign':
      // Signs a raw 32-byte hash, which can be a transaction: never offered.
      return err(4200, 'eth_sign is not supported. Use personal_sign or eth_signTypedData_v4.');

    default: {
      if (!READ_METHODS.has(msg.method)) return err(4200, `Satori GO does not support ${msg.method}.`);
      if (!takeReadBudget(msg.origin, !!conn)) {
        return err(-32005, 'Too many requests from this site. Try again in a few seconds.');
      }
      const provider = readProvider(evm, chain);
      try {
        if (msg.method === 'eth_getLogs') {
          const refusal = await checkLogRange(params, () => provider.rpc.call<string>('eth_blockNumber', []));
          if (refusal) return err(-32602, refusal);
        }
        const result = await provider.rpc.call<unknown>(msg.method, Array.isArray(params) ? params : []);
        return { result: result ?? null };
      } catch (e) {
        if (e instanceof evm.EvmRpcError) return { error: { code: e.code, message: e.message, data: e.data } };
        return err(-32603, `${chain.displayName} is unreachable right now.`);
      }
    }
  }
}

/** Apply a switch the user approved: move the connected `origin` to `chainKey`
 *  (taken from the PARKED request, never from the approval page). */
export async function applyEvmChainSwitch(origin: string, chainKey: string | undefined): Promise<boolean> {
  const evm = await requireEvm();
  if (!evm || !chainKey || !evm.isEvmChainKey(chainKey)) return false;
  const conn = await connectionFor(evm, origin);
  if (!conn) return false;
  await getStorage().set(EVM_APPROVED_ORIGINS_KEY, setEvmApprovalChain(conn.entries, origin, chainKey));
  return true;
}

const BLOCK_TAGS_AT_HEAD = new Set(['latest', 'pending', 'safe', 'finalized']);

/** eth_getLogs over a bounded range only: null when fine, else why not. A
 *  blockHash filter is one block. 'earliest' or a range wider than
 *  MAX_LOG_BLOCK_RANGE would make the wallet's endpoints scan the chain for a
 *  site. */
export async function checkLogRange(params: unknown, head: () => Promise<string>): Promise<string | null> {
  const filter = Array.isArray(params) && params[0] && typeof params[0] === 'object' ? (params[0] as Record<string, unknown>) : null;
  if (!filter) return 'Expected [filter].';
  if (filter.blockHash !== undefined) return null;
  const tooWide = `eth_getLogs is limited to ${MAX_LOG_BLOCK_RANGE} blocks per call.`;
  let headNum: bigint | null = null;
  const resolve = async (tag: unknown): Promise<bigint | null> => {
    if (tag === undefined || (typeof tag === 'string' && BLOCK_TAGS_AT_HEAD.has(tag))) {
      if (headNum === null) headNum = BigInt(await head());
      return headNum;
    }
    if (typeof tag === 'string' && /^0x[0-9a-fA-F]+$/.test(tag)) return BigInt(tag);
    return null; // 'earliest' or malformed
  };
  const from = await resolve(filter.fromBlock);
  const to = await resolve(filter.toBlock);
  if (from === null || to === null) return tooWide;
  if (to >= from && to - from + 1n > MAX_LOG_BLOCK_RANGE) return tooWide;
  return null;
}

/**
 * The events a change of the stored connection list means for each origin:
 * accountsChanged [] when it was disconnected, accountsChanged [address] when
 * it was bound to an account (new or different), chainChanged when its chain
 * moved. Raw values straight from storage.onChanged; malformed ones count as
 * an empty list.
 */
export async function evmApprovalEvents(
  oldRaw: unknown,
  newRaw: unknown,
): Promise<{ origin: string; event: 'chainChanged' | 'accountsChanged'; data: unknown }[]> {
  const evm = await requireEvm();
  if (!evm) return [];
  const opts = { isChainKey: (k: string) => evm.isEvmChainKey(k), defaultChainKey: evm.DEFAULT_EVM_CHAIN_KEY };
  const before = new Map(normalizeEvmApprovals(oldRaw, opts).entries.map((e) => [e.origin, e]));
  const after = new Map(normalizeEvmApprovals(newRaw, opts).entries.map((e) => [e.origin, e]));
  const wallets = await evmWallets();
  const out: { origin: string; event: 'chainChanged' | 'accountsChanged'; data: unknown }[] = [];
  for (const [origin, was] of before) {
    const now = after.get(origin);
    if (!now) {
      out.push({ origin, event: 'accountsChanged', data: [] });
      continue;
    }
    if (now.chainKey !== was.chainKey) {
      const chain = evm.evmChainByKey(now.chainKey);
      if (chain) out.push({ origin, event: 'chainChanged', data: evm.evmChainIdHex(chain) });
    }
  }
  for (const [origin, now] of after) {
    const was = before.get(origin);
    if (was && was.walletId === now.walletId) continue;
    const address = wallets.find((w) => w.id === now.walletId)?.address;
    out.push({ origin, event: 'accountsChanged', data: address ? [address] : [] });
  }
  return out;
}
