// Satori rewards day by day, and the claims made from this address
// (src/store/satoriDaily.ts). The contract's figures stay the authority: a
// difference from the daily files is shown, never smoothed over.

import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ChevronLeft, Info } from 'lucide-react';
import { Button } from '../../components/Button';
import { formatListAmount } from '../../services/chain/amounts';
import { useLiveStore } from '../../store/liveStore';
import {
  loadSatoriDays,
  satoriDayStatuses,
  satoriDropDays,
  SATORI_DAYS_PAGE,
  SATORI_DAY_TOLERANCE_BASE,
  SATORI_DROP_FIRST_DAY,
  type SatoriDayRead,
  type SatoriDayStatus,
} from '../../store/satoriDaily';
import { satoriClaimRowTitle } from '../../store/satoriRewards';
import { LiveNav } from './LiveNav';

interface LiveRewardsHistoryProps {
  onBack(): void;
}

const STATUS_LABEL: Record<SatoriDayStatus, string> = {
  claimed: 'Claimed',
  part: 'Partly claimed',
  waiting: 'To claim',
  later: 'Not in the drop yet',
};
const satori = (base: bigint) => `${formatListAmount(base, 18)} SATORI`;
const dayLabel = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { dateStyle: 'medium', timeZone: 'UTC' });

export function LiveRewardsHistory({ onBack }: LiveRewardsHistoryProps) {
  const address = useLiveStore((s) => s.address);
  const rewards = useLiveStore((s) => s.satoriRewards);
  const txs = useLiveStore((s) => s.txs);

  const evrKey = rewards.evrKey && rewards.evrKey.mainAddress === address ? rewards.evrKey : null;
  const evrHasRewards = (evrKey?.snapshot?.rewards?.lifetimeBase ?? 0n) > 0n;
  const addresses = useMemo(
    () => [address, evrHasRewards ? evrKey?.address : null].filter((a): a is string => !!a),
    [address, evrHasRewards, evrKey?.address],
  );
  const [picked, setPicked] = useState<string>(address ?? '');
  // The old key's tab can go away under a failed read, and the account can change.
  const shown = addresses.includes(picked) ? picked : address ?? '';
  const [pages, setPages] = useState(1);
  const [reads, setReads] = useState<Record<string, SatoriDayRead>>({});
  const held = useRef<{ key: string; reads: Record<string, SatoriDayRead> }>({ key: '', reads: {} });

  const allDays = useMemo(() => satoriDropDays(Date.now()), []);
  const wanted = useMemo(() => allDays.slice(0, pages * SATORI_DAYS_PAGE), [allDays, pages]);

  useEffect(() => {
    let cancelled = false;
    // Paging further asks only for the days not read yet.
    const key = addresses.join();
    if (held.current.key !== key) {
      held.current = { key, reads: {} };
      setReads({});
    }
    void loadSatoriDays({
      addresses,
      dates: wanted.filter((date) => !held.current.reads[date]),
      nowMs: Date.now(),
      isCancelled: () => cancelled,
      onDay: (read) => {
        if (cancelled) return;
        held.current.reads[read.date] = read;
        setReads({ ...held.current.reads });
      },
    });
    return () => {
      cancelled = true;
    };
  }, [addresses, wanted]);

  const lower = shown.toLowerCase();
  const snapshot = shown === address ? rewards.snapshot : evrKey?.snapshot ?? null;
  const contract = snapshot?.address === shown ? snapshot.rewards : null;
  const loading = wanted.some((date) => !reads[date]);
  const failed = wanted.some((date) => reads[date]?.state === 'failed');

  // Null for a day not read. Today's file may simply not be out yet: that is no gap.
  const listed = wanted
    .filter((date, i) => !(i === 0 && reads[date]?.state === 'missing'))
    .map((date) => {
      const read = reads[date];
      const figures = read?.state === 'ok' ? read.figures.get(lower) : undefined;
      return figures ? { date, ...figures } : null;
    });
  const reachesFirstDay = wanted.length === allDays.length;
  const statuses =
    contract && !loading
      ? satoriDayStatuses(listed, contract.lifetimeBase, contract.claimedBase, reachesFirstDay)
      : null;
  const days = listed.flatMap((day, i) => (day ? [{ ...day, status: statuses?.[i] ?? null }] : []));

  // Only a complete read can say the days do not add up to the contract's total.
  const complete = !loading && reachesFirstDay && listed.every((day) => day !== null);
  const itemised = days.reduce((sum, day) => (day.status === 'later' ? sum : sum + day.totalBase), 0n);
  const notItemised = contract && complete ? contract.lifetimeBase - itemised : 0n;
  const showDifference = notItemised > SATORI_DAY_TOLERANCE_BASE * 100n || notItemised < -SATORI_DAY_TOLERANCE_BASE * 100n;

  const claims = shown === address ? txs.filter((tx) => satoriClaimRowTitle(tx)) : [];

  return (
    <div className="app-frame screen-enter">
      <div className="sub-header">
        <button type="button" className="icon-btn" onClick={onBack} aria-label="Back">
          <ChevronLeft size={20} />
        </button>
        <h2>Rewards history</h2>
        <span />
      </div>
      <div className="app-content" data-testid="live-rewards-history">
        {addresses.length > 1 && (
          <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
            {addresses.map((a) => (
              <Button
                key={a}
                size="sm"
                block
                variant={a === shown ? 'primary' : 'secondary'}
                onClick={() => setPicked(a)}
                data-testid={a === address ? 'live-history-main' : 'live-history-evr'}
              >
                {a === address ? 'Main address' : 'Old Evrmore key'}
              </Button>
            ))}
          </div>
        )}

        {contract && (
          <div className="card" style={{ marginBottom: 12 }} data-testid="live-history-totals">
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12.5, padding: '2px 0' }}>
              <span className="text-dim">Earned so far</span>
              <span>{satori(contract.lifetimeBase)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12.5, padding: '2px 0' }}>
              <span className="text-dim">Claimed</span>
              <span>{satori(contract.claimedBase)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12.5, padding: '2px 0' }}>
              <span className="text-dim">To claim</span>
              <span>{satori(contract.claimableBase)}</span>
            </div>
          </div>
        )}

        <div className="section-label">By day (UTC)</div>
        {days.filter((day) => day.totalBase !== 0n).length === 0 && !loading && !failed && (
          <div className="text-dim" style={{ fontSize: 12, marginBottom: 8 }} data-testid="live-history-empty">
            No rewards for this address since {dayLabel(SATORI_DROP_FIRST_DAY)}.
          </div>
        )}
        <div className="stack" style={{ gap: 6 }}>
          {days.map((day) =>
            day.totalBase === 0n ? null : (
              <div key={day.date} className="card" data-testid={`live-history-day-${day.date}`} style={{ padding: '8px 12px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12.5, fontWeight: 600 }}>
                  <span>{dayLabel(day.date)}</span>
                  <span>{satori(day.totalBase)}</span>
                </div>
                <div className="text-dim" style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11, marginTop: 2 }}>
                  <span>
                    {[
                      day.neuronsBase !== 0n ? `Neurons ${formatListAmount(day.neuronsBase, 18)}` : null,
                      day.lendingBase !== 0n ? `Lending ${formatListAmount(day.lendingBase, 18)}` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                  {day.status && <span data-testid={`live-history-status-${day.date}`}>{STATUS_LABEL[day.status]}</span>}
                </div>
              </div>
            ),
          )}
          {loading && <div className="skeleton" style={{ height: 48, borderRadius: 12 }} data-testid="live-history-loading" />}
        </div>

        {showDifference && (
          <div className="banner info" style={{ marginTop: 10 }} data-testid="live-history-difference">
            <Info size={14} />
            <span style={{ fontSize: 11.5 }}>
              {satori(notItemised < 0n ? -notItemised : notItemised)} of the contract&apos;s total differs from the daily
              files. The contract&apos;s figure is the one you can claim.
            </span>
          </div>
        )}
        {failed && !loading && (
          <div className="banner danger" style={{ marginTop: 10 }} data-testid="live-history-failed">
            <AlertTriangle size={14} />
            <span style={{ fontSize: 11.5 }}>Some days could not be read. Open this screen again to retry.</span>
          </div>
        )}
        {wanted.length < allDays.length && !loading && (
          <Button block size="sm" variant="secondary" onClick={() => setPages(pages + 1)} style={{ marginTop: 10 }}>
            Show older days
          </Button>
        )}

        {shown === address && (
          <>
            <div className="section-label" style={{ marginTop: 16 }}>Claims</div>
            {claims.length === 0 ? (
              <div className="text-dim" style={{ fontSize: 12 }} data-testid="live-history-no-claims">
                No claims in this address&apos;s Activity yet.
              </div>
            ) : (
              <div className="stack" style={{ gap: 6 }}>
                {claims.map((tx) => (
                  <div key={tx.txid} className="card" data-testid="live-history-claim" style={{ padding: '8px 12px', fontSize: 12.5 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontWeight: 600 }}>
                      <span>{satoriClaimRowTitle(tx)}</span>
                      <span>{tx.amount.toLocaleString('en-US', { maximumFractionDigits: 8 })} SATORI</span>
                    </div>
                    <div className="text-dim" style={{ fontSize: 11, marginTop: 2 }}>
                      {tx.status === 'pending' ? 'Pending' : new Date(tx.timestamp).toLocaleDateString()}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        <div className="text-dim" style={{ fontSize: 11, lineHeight: 1.5, marginTop: 14 }}>
          Daily figures come from Satori&apos;s public audit files, downloaded whole and worked out on this device.
        </div>
      </div>
      <LiveNav />
    </div>
  );
}
