// What the wallet knows about a recipient the user just typed, and nothing
// more. Two questions, both answerable offline from state the wallet already
// holds (owner's pick, 2026-08-19, MetaMask-style security UX):
//
//   1. Have I ever paid this address before? A "no" is not an accusation, it
//      is the moment where a mistyped or pasted-from-the-wrong-place address
//      still costs nothing. A sent transaction cannot be recalled on any of
//      these chains, so this is the last cheap check there is.
//
//   2. Does it merely LOOK like an address I have used? Address poisoning
//      works by dusting a wallet with a transaction from a vanity address
//      whose first and last few characters match one of the victim's real
//      counterparties, betting that the victim copies it out of their own
//      history and only ever compares the ends. The ends matching while the
//      middle does not is exactly the signature of that attack, and it is the
//      one thing the human eye is known to skip.
//
// Deliberately NOT here: anything needing the network. The contract-address
// check (EVM) is an eth_getCode call and lives in the store; this module stays
// pure so both send screens can call it on every keystroke.

/** Everything the assessment compares the recipient against. Each list is a
 *  plain address list assembled by the caller from the store, so this module
 *  never has to know the shape of a wallet, a contact or a transaction. */
export interface RecipientKnowledge {
  /** Addresses this user owns: their wallets/accounts and receive addresses. */
  mine: readonly string[];
  /** Address-book entries (saved recipients). */
  contacts: readonly string[];
  /** Counterparties seen in this wallet's transaction history. */
  history: readonly string[];
  /** True when the chain writes addresses case-insensitively (EVM hex, where
   *  the mixed case is only an EIP-55 checksum). Base58 chains are
   *  case-SENSITIVE: there, two addresses differing only in case are two
   *  different addresses, and comparing them loosely would silently suppress a
   *  real warning. */
  caseInsensitive: boolean;
}

export interface RecipientRisk {
  /** True when the recipient is not one of `mine`, not a contact and never a
   *  counterparty. False for an empty/unknown recipient too: there is nothing
   *  to warn about until an address is actually there. */
  firstTime: boolean;
  /** The known address this recipient impersonates (as it is written in the
   *  caller's own list), or null. Never set for an exact match. */
  lookalikeOf: string | null;
}

/** How many characters at each end an address-poisoning vanity address is
 *  built to reproduce. Four is the tightest end that still catches the real
 *  attacks: the common wallet short forms show 4 to 6, and a vanity grind for
 *  8 matching characters at BOTH ends is far more expensive than the scam
 *  pays. Two ends of 4 also cannot overlap on any address this wallet sends
 *  to, so "first four" and "last four" are always distinct characters. */
const EDGE = 4;

/** The comparable body of an address: an EVM address without its `0x`, so
 *  "same first four" means the first four characters a user actually reads
 *  rather than "0x" plus two. Left alone for base58, which has no prefix. */
function addressBody(address: string): string {
  return /^0x/i.test(address) ? address.slice(2) : address;
}

/** Normalized comparison key: trimmed, and lowercased only where the chain
 *  says case carries no information. */
function comparisonKey(address: string, caseInsensitive: boolean): string {
  const trimmed = address.trim();
  return caseInsensitive ? trimmed.toLowerCase() : trimmed;
}

/**
 * Assess one recipient against what the wallet knows.
 *
 * An exact match (anywhere in `mine`, `contacts` or `history`) means the
 * address is known: neither warning fires, and in particular a known address
 * is NEVER reported as a look-alike of itself.
 *
 * The look-alike search runs over history first, then contacts, then the
 * user's own addresses, because that is the order in which the copied address
 * most likely came from: the poisoning transaction lands in history, right
 * next to the real one it imitates.
 */
export function assessRecipient(recipient: string, known: RecipientKnowledge): RecipientRisk {
  const quiet: RecipientRisk = { firstTime: false, lookalikeOf: null };
  if (typeof recipient !== 'string') return quiet;
  const target = comparisonKey(recipient, known.caseInsensitive);
  if (!target) return quiet;

  // One deduped candidate list, keeping each address as the caller wrote it
  // (that is the form the UI shows back to the user).
  const seen = new Set<string>();
  const candidates: { raw: string; key: string }[] = [];
  for (const group of [known.history, known.contacts, known.mine]) {
    for (const entry of group ?? []) {
      if (typeof entry !== 'string') continue;
      const key = comparisonKey(entry, known.caseInsensitive);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      candidates.push({ raw: entry.trim(), key });
    }
  }

  if (seen.has(target)) return quiet;

  const targetBody = addressBody(target);
  let lookalikeOf: string | null = null;
  if (targetBody.length >= EDGE * 2) {
    for (const candidate of candidates) {
      const body = addressBody(candidate.key);
      if (body.length < EDGE * 2) continue;
      // Same body with a different prefix is the SAME address written two
      // ways, not an impersonation of it.
      if (body === targetBody) continue;
      if (
        body.slice(0, EDGE) === targetBody.slice(0, EDGE) &&
        body.slice(-EDGE) === targetBody.slice(-EDGE)
      ) {
        lookalikeOf = candidate.raw;
        break;
      }
    }
  }

  return { firstTime: true, lookalikeOf };
}
