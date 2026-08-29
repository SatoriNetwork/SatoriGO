// THE ONE FAILURE OF THE WALLET STORE THAT IS NOBODY'S MISTAKE.
//
// Every write of the `liveWallets` object is a compare-and-swap: it is refused
// if another extension page wrote between this page's read and its write, and
// then re-read and re-applied (see LiveWalletService.updateStore). That retries
// a bounded number of times, and when the budget runs out NOTHING IS WRITTEN.
// The store is untouched and correct; the action simply did not happen.
//
// It lives in its own module rather than in liveWallet.ts so the UI store can
// recognise it without importing the wallet service, and so a test that mocks
// the service wholesale still sees the real type.
//
// WHY IT IS TYPED AT ALL. It used to arrive as a bare `false` or a raw
// 'store-conflict' string, and every caller guessed: the password screen said
// "Current password is incorrect." about a password that was right, create and
// import printed the word `store-conflict` at the user, and rename, switch and
// remove reported success for something that had not happened. A distinguishable
// failure is what lets all of them say the same true thing instead.

/** The single user-facing line for it. One sentence of what happened, one of
 *  what it cost (nothing), one of what to do. */
export const STORE_WRITE_FAILED_MESSAGE =
  'Another window changed your wallets. Nothing was changed, please try again.';

/** Thrown when a store write was given up on. NOTHING WAS WRITTEN: whatever the
 *  caller was going to change is exactly as it was, so a caller's only job is to
 *  say so and let the user try again. */
export class StoreWriteFailedError extends Error {
  constructor() {
    super(STORE_WRITE_FAILED_MESSAGE);
    this.name = 'StoreWriteFailedError';
  }
}

/** True for the failure above and nothing else. A caller that swallows its own
 *  expected errors (an unknown wallet id, an empty name) uses this to let this
 *  one through, because this one is the user's business. */
export function isStoreWriteFailed(err: unknown): err is StoreWriteFailedError {
  return err instanceof StoreWriteFailedError;
}
