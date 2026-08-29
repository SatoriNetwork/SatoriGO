// Logos for tokens known only at runtime (EVM tokens the user added or
// imported), keyed by the asset name the rows carry (the symbol). A tiny
// external store so TokenIcon can read it from anywhere without depending on
// the live store, and the live store replaces the whole set whenever the active
// account or chain changes (symbols are not unique across chains).
//
// Values are data: URLs produced by evm/tokenLogos.ts (validated PNG bytes),
// never remote URLs: the extension's CSP forbids remote images.

import { useSyncExternalStore } from 'react';

interface TokenInfo {
  logo: string | null;
  /** true = listed in the trusted registry, false = checked and NOT listed
   *  (the UI warns), undefined = not checked (no claim either way). */
  trusted: boolean | undefined;
}

let infos: ReadonlyMap<string, TokenInfo> = new Map();
const listeners = new Set<() => void>();
// Bumped on every replacement. Lets a consumer that reads MANY symbols at once
// (the Home list's ordering, which asks after every row's trust) depend on one
// scalar instead of subscribing per symbol.
let version = 0;

function key(symbol: string): string {
  return symbol.trim().toUpperCase();
}

/** Replace the whole set (the active account + chain's tokens). */
export function setTokenLogos(entries: Iterable<{ symbol: string; logo?: string | null; trusted?: boolean }>): void {
  const next = new Map<string, TokenInfo>();
  for (const e of entries) {
    const k = key(e.symbol);
    const prev = next.get(k);
    next.set(k, {
      logo: e.logo ?? prev?.logo ?? null,
      // A listed verdict wins over an unlisted one for a shared symbol.
      trusted: prev?.trusted === true ? true : (e.trusted ?? prev?.trusted),
    });
  }
  infos = next;
  version++;
  for (const l of listeners) l();
}

export function tokenLogoFor(symbol: string): string | null {
  return infos.get(key(symbol))?.logo ?? null;
}

/** true/false once checked against the trusted registry, null otherwise. */
export function tokenTrustFor(symbol: string): boolean | null {
  const t = infos.get(key(symbol))?.trusted;
  return t === undefined ? null : t;
}

function subscribeTrust(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** React hook: the trust verdict for `symbol` (true, false) or null. */
export function useTokenTrust(symbol: string): boolean | null {
  return useSyncExternalStore(subscribeTrust, () => tokenTrustFor(symbol), () => null);
}

/** React hook: a counter that changes whenever the registry is replaced. Read it
 *  to make a memo that calls tokenTrustFor() for many symbols recompute when the
 *  verdicts land (there is no single symbol to subscribe to in that case). */
export function useTokenRegistryVersion(): number {
  return useSyncExternalStore(subscribeTrust, () => version, () => 0);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** React hook: the data: URL for `symbol`, or null. Re-renders on changes. */
export function useTokenLogo(symbol: string): string | null {
  return useSyncExternalStore(subscribe, () => tokenLogoFor(symbol), () => null);
}
