// What "the wallet vouches for this token" means on an EVM chain, in one place.
//
// THE PROBLEM THIS REPLACES (2026-08-25 security review)
// Until now "trusted" meant exactly one thing: an image came back for the
// contract. In a gateway build the mark is served by `<gateway>/evm/marks/...`
// (tokenLogos.ts), so the sentence read, literally, "this token is trusted
// because the gateway returned a picture for it". A hostile or compromised
// gateway could therefore hand its own contract a mark, and that contract
// appeared with no warning at all, was auto-added by "Import trusted", and
// showed the logo of whatever it was imitating. Re-reading `symbol()` from the
// chain (tokenSearch.ts rule (a)) does not help: a counterfeit contract answers
// `symbol() = "USDC"` itself, which proves nothing about identity.
//
// THE RULE NOW
// Two signals, not one, before the unlisted warning is suppressed:
//
//   1. the contract is IN THE CHAIN'S PUBLIC TOKEN LIST (the CoinGecko list
//      behind Add token search, tokenSearch.ts), and
//   2. a MARK exists for the contract (tokenLogos.ts).
//
// Neither alone is enough. A token missing either one is drawn as unlisted, and
// keeps its letter badge rather than the picture the registry served, because
// the picture is the other half of the impersonation.
//
// WHEN THERE IS NO GATEWAY, THE OLD RULE STANDS. Without a gateway the mark
// comes straight from raw.githubusercontent.com and the list from
// tokens.coingecko.com: two unrelated third parties, neither of which this
// wallet operates, and a mark from one of them is the signal it always was.
// The change is aimed at the case where one host we run answers both.
//
// AN HONEST LIMIT, WRITTEN DOWN RATHER THAN GLOSSED: in a gateway build BOTH
// signals arrive from the same origin, so a fully compromised gateway could
// forge both. What the second signal buys is that a mark alone is no longer a
// verdict: the gateway must also publish the contract in a named, public,
// independently checkable list that mirrors an upstream anyone can diff. It
// raises the floor and removes the accidental case (a permissive cache, a
// placeholder image, an upstream that answers 200 for everything); it is not a
// proof of identity, and nothing in this wallet should be written as if it were.
//
// NOT IDENTITY. A verdict here decides what the user is TOLD about a token. It
// never decides which token is which: that is the contract address, always.

import { type TokenLogoProbe, fetchTokenLogo, trustWalletLogoUrl } from './tokenLogos';
import { fetchTokenList, type TokenListEntry } from './tokenSearch';
import { evmGatewayUrl } from './endpoints';

/** What the rule needs off a chain registry row. A structural subset so a test
 *  can pass a literal instead of building a whole `EvmChain`, and `null` is
 *  accepted alongside `undefined` because the store's plain-data mirror of the
 *  registry (store/evmChains.ts EvmChainInfo) spells "absent" as null. */
export interface TokenTrustChain {
  /** Trust Wallet assets folder for this chain; absent = no mark source. */
  trustWalletChain?: string | null;
  /** CoinGecko token-list slug for this chain; absent = no token list. */
  tokenListSlug?: string | null;
}

/** Whether the chain's token list carries a contract.
 *  'listed' / 'unlisted' are answers; 'no-list' means the chain publishes no
 *  list at all (a permanent state, so a permanent "cannot vouch"); 'unknown'
 *  means the list could not be read right now (transient: never recorded). */
export type TokenListMembership = 'listed' | 'unlisted' | 'no-list' | 'unknown';

/** The token list resolved once for a batch of contracts, so ten tokens cost
 *  one list read rather than ten. */
export type TokenListLookup =
  | { kind: 'no-list' }
  | { kind: 'unavailable' }
  | { kind: 'ready'; addresses: ReadonlySet<string> };

/** Contract addresses of a parsed list, lowercased, memoised per entries array.
 *  `fetchTokenList` hands back the SAME array for a cached list, so keying the
 *  index on the array identity keeps it exactly as fresh as the list itself. */
const addressIndex = new WeakMap<readonly TokenListEntry[], ReadonlySet<string>>();

export function tokenListAddressSet(entries: readonly TokenListEntry[]): ReadonlySet<string> {
  const hit = addressIndex.get(entries);
  if (hit) return hit;
  const set = new Set(entries.map((e) => e.address.toLowerCase()));
  addressIndex.set(entries, set);
  return set;
}

/**
 * Resolve the token-list signal once, for a whole batch of trust checks. Never
 * throws: a failure is 'unavailable', which produces no verdict rather than a
 * wrong one.
 *
 * It answers 'no-list' WITHOUT a request in the two cases where the list is not
 * part of the rule: the chain publishes none, and this build has no gateway (a
 * mark then comes straight from the public registry and decides on its own, see
 * the module header). A build that does not consult the list must not pay for
 * it, and must not be blocked when it is down.
 */
export async function openTokenListLookup(
  chain: TokenTrustChain,
  fetchImpl?: typeof fetch,
  gateway: string = evmGatewayUrl(),
): Promise<TokenListLookup> {
  if (!chain.tokenListSlug || !marksAreGatewayServed(gateway)) return { kind: 'no-list' };
  const list = await fetchTokenList(chain.tokenListSlug, fetchImpl);
  if (!list.ok) return { kind: 'unavailable' };
  return { kind: 'ready', addresses: tokenListAddressSet(list.entries) };
}

/** Membership of one contract in a resolved lookup. */
export function membershipOf(lookup: TokenListLookup, address: string): TokenListMembership {
  if (lookup.kind === 'no-list') return 'no-list';
  if (lookup.kind === 'unavailable') return 'unknown';
  return lookup.addresses.has(address.toLowerCase()) ? 'listed' : 'unlisted';
}

/** True when the wallet's own gateway is what serves the marks, i.e. the mark
 *  and the token list are not independent parties. */
export function marksAreGatewayServed(gateway: string = evmGatewayUrl()): boolean {
  return gateway !== '';
}

/**
 * THE RULE. Pure, so it is the one thing every call site is tested against.
 *
 * Returns `true` (the wallet vouches: no warning, mark shown), `false` (drawn
 * as unlisted, letter badge) or `undefined` (NO VERDICT: the question could not
 * be answered, so nothing is recorded and it is asked again later).
 *
 * `undefined` is never a quiet "trusted": the UI treats it as "no claim either
 * way", which suppresses the warning but also suppresses the vouching.
 */
export function decideTokenTrust(input: {
  /** Outcome of the mark probe. 'error' is a transport failure, not an answer. */
  mark: TokenLogoProbe['kind'];
  membership: TokenListMembership;
  /** True when one host we operate serves the marks (see the module header). */
  requireBothSignals: boolean;
}): boolean | undefined {
  // A transport failure answers nothing, whichever rule is in force.
  if (input.mark === 'error') return undefined;
  const hasMark = input.mark === 'found';
  if (!input.requireBothSignals) return hasMark;
  // No mark is a definitive "not listed anywhere we can see", so it settles the
  // question before the list is consulted at all.
  if (!hasMark) return false;
  switch (input.membership) {
    case 'listed':
      return true;
    case 'unlisted':
    case 'no-list':
      return false;
    case 'unknown':
      // A mark, but the list could not be read. Refusing to answer is the only
      // honest option: recording `false` here would put a warning on real USDC
      // the first time the list host hiccups, and record it permanently.
      return undefined;
  }
}

/** A verdict plus the mark that earned it. */
export interface TokenTrustVerdict {
  /** true / false / undefined, exactly as decideTokenTrust returns. */
  trusted: boolean | undefined;
  /** The validated PNG data: URL, present ONLY when `trusted` is true. A token
   *  the wallet will not vouch for keeps its letter badge: the picture is the
   *  other half of an impersonation, and drawing a real token's logo beside an
   *  "unlisted" pill is the contradiction the review found. */
  logo?: string;
}

/**
 * The verdict for one contract, mark probe included. `lookup` comes from
 * openTokenListLookup() and is shared by the whole batch. Never throws.
 */
export async function probeTokenTrust(
  chain: TokenTrustChain,
  address: string,
  lookup: TokenListLookup,
  opts: { fetchImpl?: typeof fetch; gateway?: string } = {},
): Promise<TokenTrustVerdict> {
  const gateway = opts.gateway ?? evmGatewayUrl();
  const url = trustWalletLogoUrl(chain.trustWalletChain, address, gateway);
  // No mark source for this chain at all: the same standing as a 404. The
  // wallet cannot vouch, and says so, rather than staying silent.
  const probe: TokenLogoProbe = url
    ? await fetchTokenLogo(url, opts.fetchImpl)
    : { kind: 'missing' };
  const trusted = decideTokenTrust({
    mark: probe.kind,
    membership: membershipOf(lookup, address),
    requireBothSignals: marksAreGatewayServed(gateway),
  });
  return trusted === true && probe.kind === 'found' ? { trusted, logo: probe.dataUrl } : { trusted };
}

/**
 * Can this chain produce a positive verdict at all in this build? False when a
 * signal the rule needs does not exist here, which is what "Import trusted"
 * must check before it promises to import anything: with no way to vouch, the
 * honest answer is to say so, not to import nothing and call it success.
 */
export function canVouchOnChain(chain: TokenTrustChain, gateway: string = evmGatewayUrl()): boolean {
  if (!chain.trustWalletChain) return false;
  return marksAreGatewayServed(gateway) ? Boolean(chain.tokenListSlug) : true;
}
