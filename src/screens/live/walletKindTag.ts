// The "what kind of wallet is this" chip every wallet list draws (the Home
// switcher, the lock screen, Settings > Wallets). One place, so a new kind of
// wallet is tagged the same way everywhere.
//
// Three kinds today: a recovery phrase ("Seed"), a single imported private key
// ("Satori": that is how Satori-network wallets are generated), and a Monero
// wallet imported from its 25 words. The last one is stored as kind:'seed'
// (its vault holds words) but it is NOT a phrase: it derives nothing, joins
// no seed group and has no derivation path, and calling it "Seed" told the
// 1.4.3 audit the wrong story (N-diag-vector-xmr-imported). Its own tag says
// what it is.

export interface TaggableWallet {
  kind: 'seed' | 'pk';
  /** Monero only: 'phrase' (derived from a seed wallet) or 'words' (imported). */
  moneroKeySource?: 'phrase' | 'words';
}

/** The chip text. 'short' is the compact row chip (Home switcher, lock screen);
 *  'long' is the Settings > Wallets label, which has room to say more. */
export function walletKindTag(w: TaggableWallet, variant: 'short' | 'long' = 'short'): string {
  if (w.kind === 'pk') return variant === 'long' ? 'Satori (key)' : 'Satori';
  if (w.moneroKeySource === 'words') return variant === 'long' ? 'Monero (25 words)' : '25 words';
  return 'Seed';
}
