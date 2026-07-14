// Satori pool staking (delegation) for the SATORIEVR asset.
//
// Staking on Satori is NOT an on-chain transaction: the user's SATORIEVR stays
// on their own address(es). This screen registers/deregisters those addresses as
// a "lender" of a chosen pool on Satori's central server (network.satorinet.io),
// authenticated with a locally-signed challenge. No funds move; no password is
// required (signing a challenge cannot move funds) — the wallet is already
// unlocked in the ready phase where this screen lives.
//
// Data is SERVER TRUTH, re-fetched on open (refreshStaking). All errors surface
// via the store's staking.error (never thrown to the UI).

import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, Landmark, Info, AlertTriangle, RefreshCw, Search } from 'lucide-react';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { CopyButton } from '../../components/CopyButton';
import { EmptyState } from '../../components/EmptyState';
import { TextField } from '../../components/TextField';
import { useLiveStore } from '../../store/liveStore';
import { filterPools, paginatePools, type PoolInfo } from '../../services/satoriPool';
import { LiveNav } from './LiveNav';

interface LiveStakingProps {
  onBack(): void;
}

/** Shorten an E-address for display: first 8 … last 6. */
function shortAddr(address: string): string {
  return address.length > 16 ? `${address.slice(0, 8)}…${address.slice(-6)}` : address;
}

/** A pending confirm action: join a specific pool, or leave the current pool. */
type PendingAction = { kind: 'join'; pool: PoolInfo } | { kind: 'leave' };

export function LiveStaking({ onBack }: LiveStakingProps) {
  const staking = useLiveStore((s) => s.staking);
  const refreshStaking = useLiveStore((s) => s.refreshStaking);
  const joinPool = useLiveStore((s) => s.joinPool);
  const leavePool = useLiveStore((s) => s.leavePool);
  const assets = useLiveStore((s) => s.assets);

  const [pending, setPending] = useState<PendingAction | null>(null);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);

  // Fetch server truth on open. (Deliberately not in deps beyond the action so it
  // runs once per mount; the user can Retry / it re-fetches after join/leave.)
  useEffect(() => {
    void refreshStaking();
  }, [refreshStaking]);

  const { pools, addressStatuses, loading, submitting, error, loaded } = staking;

  // Total SATORIEVR balance across the wallet — joining is impossible at 0 (the
  // user has nothing to delegate); leaving stays possible regardless (they may
  // have spent it after joining and still want to unregister).
  const satoriBalance = assets.find((a) => a.name === 'SATORIEVR')?.amount ?? 0;
  const canJoin = satoriBalance > 0;

  // Distinct pool addresses our held addresses are currently registered with.
  const stakedPools = useMemo(
    () => Array.from(new Set(addressStatuses.map((a) => a.poolAddress).filter((p): p is string => !!p))),
    [addressStatuses],
  );
  const anyStaked = stakedPools.length > 0;
  const mixed = stakedPools.length > 1 || (anyStaked && addressStatuses.some((a) => !a.poolAddress));
  const holdsSatori = addressStatuses.length > 0;

  // Resolve a pool address to its alias (for the status card) when we know it.
  const aliasFor = (poolAddress: string): string | null =>
    pools.find((p) => p.address === poolAddress)?.alias ?? null;

  // Resolve a pool address to its full PoolInfo when it's still in the open-pool
  // list (closed pools the user already joined won't be — see below).
  const poolInfoFor = (poolAddress: string): PoolInfo | undefined =>
    pools.find((p) => p.address === poolAddress);

  // Search -> filter -> paginate. Typing resets to page 1 (handled in the input's
  // onChange). Pure helpers live in services/satoriPool.ts (unit-tested there).
  const filtered = useMemo(() => filterPools(pools, query), [pools, query]);
  const { items: pageItems, page: currentPage, totalPages } = useMemo(
    () => paginatePools(filtered, page),
    [filtered, page],
  );

  const confirmPending = async () => {
    if (!pending) return;
    const action = pending;
    setPending(null);
    if (action.kind === 'join') await joinPool(action.pool.address);
    else await leavePool();
  };

  // ---- confirm modal copy -----------------------------------------------------
  const confirmModal = pending && (
    <Modal
      title={pending.kind === 'join' ? 'Join this pool?' : 'Leave your pool?'}
      onClose={() => setPending(null)}
      testId="staking-confirm"
      actions={
        <>
          <Button variant="secondary" onClick={() => setPending(null)}>
            Cancel
          </Button>
          <Button
            variant={pending.kind === 'leave' ? 'danger' : 'primary'}
            onClick={confirmPending}
            data-testid="staking-confirm-submit"
          >
            {pending.kind === 'join' ? 'Join pool' : 'Leave pool'}
          </Button>
        </>
      }
    >
      {pending.kind === 'join' ? (
        <div style={{ fontSize: 12.5, lineHeight: 1.55 }}>
          <p style={{ marginTop: 0 }}>
            Register your SATORIEVR address{addressStatuses.length > 1 ? 'es' : ''} as a lender of:
          </p>
          <div className="card" style={{ padding: 10, margin: '10px 0' }}>
            <div style={{ fontWeight: 600 }}>{pending.pool.alias || 'Unnamed pool'}</div>
            <div className="mono text-dim" style={{ fontSize: 11, wordBreak: 'break-all' }}>
              {pending.pool.address}
            </div>
            <div className="text-dim" style={{ fontSize: 11, marginTop: 4 }}>
              Commission {pending.pool.commission}%
            </div>
          </div>
          {anyStaked && (
            <p className="text-dim">
              You are already staked. Joining this pool will first leave your current pool, then
              register with the new one.
            </p>
          )}
          <p className="text-dim" style={{ marginBottom: 0 }}>
            No funds move. Your SATORIEVR stays in your wallet. This only registers your address on
            the Satori network, using a signature made locally. No EVR fee: nothing is broadcast
            on-chain.
          </p>
        </div>
      ) : (
        <div style={{ fontSize: 12.5, lineHeight: 1.55 }}>
          <p style={{ marginTop: 0 }}>
            Deregister your SATORIEVR address{addressStatuses.length > 1 ? 'es' : ''} from
            {stakedPools.length === 1 ? ` ${aliasFor(stakedPools[0]) || shortAddr(stakedPools[0])}` : ' your pool'}.
          </p>
          <p className="text-dim" style={{ marginBottom: 0 }}>
            No funds move. Your SATORIEVR stays in your wallet. This only removes your address as a
            pool lender on the Satori network. No EVR fee: nothing is broadcast on-chain.
          </p>
        </div>
      )}
    </Modal>
  );

  return (
    <div className="app-frame screen-enter">
      <div className="sub-header">
        <button type="button" className="icon-btn" onClick={onBack} aria-label="Back">
          <ChevronLeft size={20} />
        </button>
        <h2>Stake SATORIEVR</h2>
        <button
          type="button"
          className="icon-btn"
          onClick={() => void refreshStaking()}
          aria-label="Refresh"
          disabled={loading || submitting}
        >
          <RefreshCw size={16} />
        </button>
      </div>

      <div className="app-content" data-testid="live-staking">
        {/* Error banner with Retry. */}
        {error && (
          <div className="banner danger" data-testid="staking-error" style={{ alignItems: 'flex-start' }}>
            <AlertTriangle size={14} />
            <span style={{ flex: 1 }}>{error}</span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => void refreshStaking()}
              data-testid="staking-retry"
            >
              Retry
            </button>
          </div>
        )}

        {/* Loading skeletons (first load). */}
        {loading && !loaded ? (
          <div className="stack" style={{ marginTop: 4 }}>
            <div className="skeleton" style={{ height: 74, borderRadius: 12 }} />
            <div className="skeleton" style={{ height: 52, borderRadius: 12 }} />
            <div className="skeleton" style={{ height: 52, borderRadius: 12 }} />
          </div>
        ) : loaded && !holdsSatori ? (
          // Empty state: no SATORIEVR held anywhere.
          <EmptyState
            icon={<Landmark size={20} />}
            title="No SATORIEVR to stake"
            description="You need SATORIEVR in this wallet to stake. Receive some SATORIEVR, then come back here to delegate it to a pool."
          />
        ) : (
          <>
            {/* Status card. */}
            <div className="card" data-testid="staking-status" style={{ marginBottom: 16 }}>
              {anyStaked ? (
                <>
                  <div className="section-label" style={{ marginTop: 0 }}>Your staking</div>
                  {mixed ? (
                    <>
                      <p className="text-dim" style={{ fontSize: 12, lineHeight: 1.5, marginTop: 0 }}>
                        Your addresses are in different states:
                      </p>
                      <div className="stack">
                        {addressStatuses.map((a) => (
                          <div
                            key={a.address}
                            className="token-row"
                            style={{ alignItems: 'center' }}
                          >
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div className="mono" style={{ fontSize: 11.5 }}>{shortAddr(a.address)}</div>
                              <div className="text-dim" style={{ fontSize: 11 }}>
                                {a.poolAddress
                                  ? `Staked → ${aliasFor(a.poolAddress) || shortAddr(a.poolAddress)}`
                                  : 'Not staked'}
                              </div>
                            </div>
                            {a.poolAddress && <span className="chip success" style={{ fontSize: 10 }}>Staked</span>}
                          </div>
                        ))}
                      </div>
                    </>
                  ) : (
                    (() => {
                      // Resolve the joined pool's alias + fee by matching its address
                      // against the fetched open-pool list. A CLOSED pool (one the
                      // user already joined that has since left the open list) has no
                      // match — show the shortened address and "fee —" instead of
                      // guessing.
                      const info = poolInfoFor(stakedPools[0]);
                      return (
                        <>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                            <span className="chip success">Staked</span>
                            <span style={{ fontWeight: 600, fontSize: 13 }} data-testid="staking-status-name">
                              {info?.alias || (info ? 'Unnamed pool' : shortAddr(stakedPools[0]))}
                            </span>
                            <span
                              className="chip neutral"
                              style={{ fontSize: 10 }}
                              data-testid="staking-status-fee"
                            >
                              fee {info ? `${info.commission}%` : 'n/a'}
                            </span>
                          </div>
                          <div
                            style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}
                          >
                            <span className="mono text-dim" style={{ fontSize: 11, wordBreak: 'break-all' }}>
                              {shortAddr(stakedPools[0])}
                            </span>
                            <CopyButton value={stakedPools[0]} label="Copy pool address" size={12} />
                          </div>
                        </>
                      );
                    })()
                  )}
                  <Button
                    variant="danger"
                    block
                    size="sm"
                    loading={submitting}
                    onClick={() => setPending({ kind: 'leave' })}
                    data-testid="staking-leave"
                    style={{ marginTop: 12 }}
                  >
                    Leave pool
                  </Button>
                </>
              ) : (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Landmark size={16} />
                    <span style={{ fontWeight: 600, fontSize: 13 }}>Not staked</span>
                  </div>
                  <p className="text-dim" style={{ fontSize: 12, lineHeight: 1.55, marginBottom: 0 }}>
                    Staking keeps your SATORIEVR in your wallet. Your address is registered with a
                    pool on the Satori network. Pick a pool below to start. No EVR fee: nothing is
                    broadcast on-chain.
                  </p>
                </>
              )}
            </div>

            {/* Pool list. */}
            <div className="section-label">Open pools</div>
            <div className="banner info" style={{ alignItems: 'flex-start', marginBottom: 10 }}>
              <Info size={14} />
              <span style={{ fontSize: 11.5 }}>
                Named pools are listed first; commission (the fee the pool keeps) is ascending
                within each group. Lower is better.
              </span>
            </div>

            {!canJoin && pools.length > 0 && (
              <div
                className="banner warning"
                data-testid="staking-zero-balance-note"
                style={{ alignItems: 'flex-start', marginBottom: 10 }}
              >
                <AlertTriangle size={14} />
                <span style={{ fontSize: 11.5 }}>You need SATORIEVR to stake.</span>
              </div>
            )}

            {pools.length === 0 ? (
              <EmptyState
                icon={<Landmark size={20} />}
                title="No open pools"
                description="No pools are currently open for delegation. Try again later."
              />
            ) : (
              <>
                <div style={{ marginBottom: 10 }}>
                  <TextField
                    placeholder="Search pools by name or address…"
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setPage(1); // typing resets to page 1
                    }}
                    prefixEl={<Search size={14} className="text-dim" />}
                    testId="staking-search"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>

                {filtered.length === 0 ? (
                  <EmptyState
                    icon={<Search size={20} />}
                    title="No pools match"
                    description="Try a different name or address."
                  />
                ) : (
                  <>
                    <div className="stack" data-testid="staking-pool-list">
                      {pageItems.map((pool) => {
                        const joinedHere = stakedPools.includes(pool.address);
                        return (
                          <div
                            key={pool.address}
                            className="token-row"
                            data-testid={`staking-pool-row-${pool.address.slice(0, 8)}`}
                            style={{ alignItems: 'center' }}
                          >
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontWeight: 600, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
                                {pool.alias || 'Unnamed pool'}
                                {joinedHere && <span className="chip success" style={{ fontSize: 9 }}>Joined</span>}
                              </div>
                              <div className="mono text-dim" style={{ fontSize: 11 }}>{shortAddr(pool.address)}</div>
                            </div>
                            <span className="chip neutral" style={{ flexShrink: 0 }}>{pool.commission}% fee</span>
                            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3, flexShrink: 0 }}>
                              <Button
                                size="sm"
                                variant={joinedHere ? 'secondary' : 'primary'}
                                disabled={joinedHere || submitting || !canJoin}
                                loading={submitting}
                                onClick={() => setPending({ kind: 'join', pool })}
                                data-testid={`staking-join-${pool.address.slice(0, 8)}`}
                              >
                                {joinedHere ? 'Joined' : 'Join'}
                              </Button>
                              {!joinedHere && !canJoin && (
                                <span
                                  className="text-dim"
                                  style={{ fontSize: 9.5, whiteSpace: 'nowrap' }}
                                  data-testid={`staking-join-note-${pool.address.slice(0, 8)}`}
                                >
                                  Need SATORIEVR
                                </span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {/* Pagination — 10 per page (POOLS_PER_PAGE). */}
                    {totalPages > 1 && (
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          gap: 10,
                          marginTop: 12,
                        }}
                        data-testid="staking-pagination"
                      >
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => setPage((p) => Math.max(1, p - 1))}
                          disabled={currentPage <= 1}
                          data-testid="staking-page-prev"
                        >
                          Prev
                        </button>
                        <span className="text-dim" style={{ fontSize: 11.5 }} data-testid="staking-page-info">
                          page {currentPage} of {totalPages}
                        </span>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                          disabled={currentPage >= totalPages}
                          data-testid="staking-page-next"
                        >
                          Next
                        </button>
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </>
        )}
      </div>

      {confirmModal}
      <LiveNav />
    </div>
  );
}
