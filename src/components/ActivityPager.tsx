// The Activity list's paging controls, in ONE place so the two surfaces that
// show transactions cannot drift apart (owner, live testing 2026-08-25: "there
// is no pagination in activities, I checked for USDT on EVM BNB" — the main
// Activity tab had prev/next, the per-asset list on the token's own screen had
// nothing at all and simply rendered every matching row).
//
// It carries two separate ideas that look like one control, and keeping them
// distinct is the point:
//
//   PAGES are over the rows the wallet ALREADY HAS. Prev/Next never touch the
//   network; they walk a list that is already in memory.
//
//   "LOAD OLDER" asks the chain's history source for a page it has not served
//   yet. It is one request, it is offered only while the source can actually go
//   deeper, and when the source runs out the row says so plainly instead of
//   leaving a button that answers with nothing. A UTXO chain never shows it at
//   all: Electrum serves an address's whole history in one call, so there is
//   nothing older to ask for.

import { useLiveStore } from '../store/liveStore';

interface ActivityPagerProps {
  /** 1-based, already clamped by paginate(). */
  page: number;
  totalPages: number;
  onPage(next: number): void;
  /** Testid prefix, so the two surfaces are addressable apart: the main
   *  Activity tab keeps its historical `activity-` ids. */
  idPrefix: string;
  /** Show the "Load older" half. False on a surface where it makes no sense. */
  showLoadOlder?: boolean;
}

export function ActivityPager({ page, totalPages, onPage, idPrefix, showLoadOlder = true }: ActivityPagerProps) {
  const olderHistory = useLiveStore((s) => s.olderHistory);
  const loadOlderActivity = useLiveStore((s) => s.loadOlderActivity);

  // Only on the LAST page: asking for older rows while looking at the newest
  // ones is a control with no relationship to what is on screen.
  const onLastPage = page >= totalPages;
  // `canLoadOlder: null` means the question is not settled yet (no history read
  // has finished), and an unsettled question is not an offer.
  const offerOlder = showLoadOlder && onLastPage && olderHistory.canLoadOlder === true;
  const exhausted = showLoadOlder && onLastPage && olderHistory.canLoadOlder === false;

  if (totalPages <= 1 && !offerOlder && !exhausted && !olderHistory.error) return null;

  return (
    <div style={{ marginTop: 12 }} data-testid={`${idPrefix}-pager`}>
      {totalPages > 1 && (
        <div
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}
          data-testid={`${idPrefix}-pagination`}
        >
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => onPage(Math.max(1, page - 1))}
            disabled={page <= 1}
            data-testid={`${idPrefix}-page-prev`}
          >
            Prev
          </button>
          <span className="text-dim" style={{ fontSize: 11.5 }} data-testid={`${idPrefix}-page-info`}>
            page {page} of {totalPages}
          </span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => onPage(Math.min(totalPages, page + 1))}
            disabled={page >= totalPages}
            data-testid={`${idPrefix}-page-next`}
          >
            Next
          </button>
        </div>
      )}

      {offerOlder && (
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: totalPages > 1 ? 8 : 0 }}>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => void loadOlderActivity()}
            disabled={olderHistory.loading}
            data-testid={`${idPrefix}-load-older`}
          >
            {olderHistory.loading ? 'Loading older...' : 'Load older'}
          </button>
        </div>
      )}

      {/* The honest full stop. Shown only once the source has actually said it
          has nothing older, never as a guess. */}
      {exhausted && (
        <div
          className="text-faint"
          style={{ textAlign: 'center', fontSize: 10.5, marginTop: totalPages > 1 ? 8 : 0 }}
          data-testid={`${idPrefix}-no-older`}
        >
          That is the whole history this wallet can list.
        </div>
      )}

      {olderHistory.error && (
        <div
          className="text-dim"
          style={{ textAlign: 'center', fontSize: 10.5, marginTop: 8 }}
          data-testid={`${idPrefix}-older-error`}
        >
          {olderHistory.error}
        </div>
      )}
    </div>
  );
}
