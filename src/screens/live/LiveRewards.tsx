// Claim Satori rewards on Base: the reward drop, the airdrop and prediction
// rewards, as the neuron claims them (src/store/satoriRewards.ts).
//
// Each claim is a real transaction paid in ETH from this address, so it takes
// the same review, arming gate and password as a send. Figures are what the
// contracts report, re-read on open and again when a claim is built.

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle, ChevronLeft, Info, RefreshCw } from 'lucide-react';
import { Button } from '../../components/Button';
import { CopyButton } from '../../components/CopyButton';
import { PasswordField } from '../../components/TextField';
import { formatAmount, formatListAmount } from '../../services/chain/amounts';
import { activeEvmChain, useLiveStore } from '../../store/liveStore';
import { satoriLockText } from '../../store/evmSend';
import { SATORI_CLAIM_TITLE as KIND_TITLE, type SatoriRewardsSnapshot } from '../../store/satoriRewards';
import type { EvmFeeLevel } from '../../services/chain/evm/fees';
import { LiveNav } from './LiveNav';
import { LiveRewardsHistory } from './LiveRewardsHistory';

interface LiveRewardsProps {
  onBack(): void;
}

const SATORI_DECIMALS = 18;
const FEE_LEVELS: readonly EvmFeeLevel[] = ['slow', 'normal', 'fast'];
const FEE_LEVEL_LABEL: Record<EvmFeeLevel, string> = { slow: 'Slow', normal: 'Normal', fast: 'Fast' };

const satori = (base: bigint) => `${formatListAmount(base, SATORI_DECIMALS)} SATORI`;

export function LiveRewards({ onBack }: LiveRewardsProps) {
  const rewards = useLiveStore((s) => s.satoriRewards);
  const refreshSatoriRewards = useLiveStore((s) => s.refreshSatoriRewards);
  const planSatoriClaim = useLiveStore((s) => s.planSatoriClaim);
  const selectSatoriClaimFeeLevel = useLiveStore((s) => s.selectSatoriClaimFeeLevel);
  const confirmSatoriClaim = useLiveStore((s) => s.confirmSatoriClaim);
  const clearSatoriClaim = useLiveStore((s) => s.clearSatoriClaim);
  const arm = useLiveStore((s) => s.arm);
  const verifyPassword = useLiveStore((s) => s.verifyPassword);
  const requirePasswordToSend = useLiveStore((s) => s.requirePasswordToSend);
  const wallets = useLiveStore((s) => s.wallets);
  const activeWalletId = useLiveStore((s) => s.activeWalletId);
  const assets = useLiveStore((s) => s.assets);
  const address = useLiveStore((s) => s.address);
  const chain = useLiveStore(activeEvmChain);

  const [armed, setArmed] = useState(false);
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState('');
  const [claimed, setClaimed] = useState<{ txid: string; explorerUrl: string } | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  // State only reaches the button on the next render; a double click is faster.
  const confirmStarted = useRef(false);

  // First read on open, and a clean slate on leaving: an armed plan must never
  // survive a navigation.
  useEffect(() => {
    void refreshSatoriRewards();
    return () => clearSatoriClaim();
  }, [refreshSatoriRewards, clearSatoriClaim]);

  const isPasswordless = wallets.find((w) => w.id === activeWalletId)?.passwordless ?? false;
  const requirePassword = requirePasswordToSend && !isPasswordless;
  const { snapshot, evrKey, plan, planning, loading, error } = rewards;
  const planSatoriMove = useLiveStore((s) => s.planSatoriMove);
  const ticker = chain?.nativeTicker ?? 'ETH';
  const decimals = chain?.nativeDecimals ?? 18;
  const native = assets.find((a) => a.isNative && a.name === ticker);
  const noEth = native?.amountBase === 0n;

  const backFromReview = () => {
    clearSatoriClaim();
    setArmed(false);
    setPassword('');
    setPasswordError('');
    setConfirmError('');
  };

  if (showHistory) return <LiveRewardsHistory onBack={() => setShowHistory(false)} />;

  if (claimed) {
    return (
      <div className="app-frame screen-enter">
        <div className="sub-header">
          <button type="button" className="icon-btn" onClick={() => setClaimed(null)} aria-label="Back">
            <ChevronLeft size={20} />
          </button>
          <h2>Rewards</h2>
          <span />
        </div>
        <div className="app-content" data-testid="live-rewards">
          <div className="result-screen">
            <div className="result-icon success">
              <CheckCircle size={32} />
            </div>
            <h3>Claim sent</h3>
            <p>Your SATORI arrives once {chain?.displayName ?? 'the network'} confirms it.</p>
            <div className="card" style={{ marginTop: 16, width: '100%', textAlign: 'left' }} data-testid="live-rewards-txid">
              <div className="section-label" style={{ marginTop: 0 }}>Transaction hash</div>
              <span className="mono" style={{ fontSize: 11, wordBreak: 'break-all', color: 'var(--text-dim)' }}>
                {claimed.txid}
              </span>
            </div>
            <a
              href={claimed.explorerUrl}
              target="_blank"
              rel="noreferrer"
              className="btn btn-secondary btn-sm"
              style={{ marginTop: 12 }}
            >
              Open in explorer
            </a>
            <Button block onClick={() => setClaimed(null)} style={{ marginTop: 12 }}>
              Done
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (plan) {
    const { quote } = plan;
    const blocked = !!plan.shortfall || !!plan.capRefusal;

    const handleConfirm = async () => {
      if (confirmStarted.current) return;
      confirmStarted.current = true;
      setConfirmError('');
      setPasswordError('');
      setConfirming(true);
      try {
        if (requirePassword && !(await verifyPassword(password))) {
          setPasswordError('Incorrect password');
          return;
        }
        arm(true);
        const result = await confirmSatoriClaim();
        setClaimed({ txid: result.txid, explorerUrl: result.explorerUrl });
        setArmed(false);
        setPassword('');
      } catch (err) {
        setConfirmError(err instanceof Error ? err.message : String(err));
      } finally {
        arm(false);
        setConfirming(false);
        confirmStarted.current = false;
      }
    };

    return (
      <div className="app-frame screen-enter">
        <div className="sub-header">
          <button type="button" className="icon-btn" onClick={backFromReview} aria-label="Back">
            <ChevronLeft size={20} />
          </button>
          <h2>Review claim</h2>
          <span />
        </div>
        <div className="app-content" data-testid="live-rewards-review">
          <div className="banner warning" style={{ marginBottom: 14 }}>
            <AlertTriangle size={14} />
            {plan.description} This broadcasts a real transaction on {chain?.displayName} and cannot be undone.
          </div>

          <div className="card solid" style={{ marginBottom: 14 }}>
            <div className="summary-table">
              <div className="sum-row">
                <span className="sum-key">Action</span>
                <span className="sum-val">{plan.kind === 'move' ? 'Move SATORI' : `Claim ${KIND_TITLE[plan.kind].toLowerCase()}`}</span>
              </div>
              {plan.from !== address && (
                <div className="sum-row" data-testid="live-rewards-review-from">
                  <span className="sum-key">From old Evrmore key</span>
                  <span className="sum-val mono" style={{ fontSize: 10.5, wordBreak: 'break-all' }}>{plan.from}</span>
                </div>
              )}
              {plan.kind === 'move' && (
                <div className="sum-row">
                  <span className="sum-key">To</span>
                  <span className="sum-val mono" style={{ fontSize: 10.5, wordBreak: 'break-all' }}>{address}</span>
                </div>
              )}
              <div className="sum-row" data-testid="live-rewards-review-amount">
                <span className="sum-key">{plan.kind === 'move' ? 'Amount' : 'You receive'}</span>
                <span className="sum-val">
                  {plan.amountIsLowerBound ? 'At least ' : ''}
                  {formatAmount(plan.amountBase, SATORI_DECIMALS)} SATORI
                </span>
              </div>
              <div className="sum-row">
                <span className="sum-key">Contract</span>
                <span className="sum-val mono" style={{ fontSize: 10.5, wordBreak: 'break-all' }}>{plan.to}</span>
              </div>
              <div className="sum-row">
                <span className="sum-key">Network</span>
                <span className="sum-val">{chain?.displayName}</span>
              </div>
              <div className="sum-row" data-testid="live-rewards-review-fee">
                <span className="sum-key">Estimated fee</span>
                <span className="sum-val">{formatAmount(quote.estimatedTotal, decimals)} {ticker}</span>
              </div>
              <div className="sum-row">
                <span className="sum-key">Maximum fee</span>
                <span className="sum-val">{formatAmount(quote.maxTotal, decimals)} {ticker}</span>
              </div>
            </div>
          </div>

          <div className="section-label">Speed</div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
            {FEE_LEVELS.map((lvl) => (
              <button
                key={lvl}
                type="button"
                className={plan.level === lvl ? 'chip' : 'chip neutral'}
                aria-pressed={plan.level === lvl}
                onClick={() => void selectSatoriClaimFeeLevel(lvl)}
                style={{ flex: 1, justifyContent: 'center', cursor: 'pointer' }}
              >
                {FEE_LEVEL_LABEL[lvl]}
              </button>
            ))}
          </div>

          {plan.shortfall && (
            <div className="banner danger" style={{ marginBottom: 14 }} data-testid="live-rewards-shortfall">
              <AlertTriangle size={14} />
              {plan.shortfall}
            </div>
          )}
          {plan.capRefusal && (
            <div className="banner danger" style={{ marginBottom: 14 }}>
              <AlertTriangle size={14} />
              {plan.capRefusal}
            </div>
          )}

          <div className="section-label">Confirm</div>
          <div className="card" style={{ marginBottom: 14 }}>
            <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={armed}
                onChange={(e) => setArmed(e.target.checked)}
                data-testid="live-rewards-arm"
                style={{ marginTop: 2 }}
              />
              <span style={{ fontSize: 12, lineHeight: 1.5 }}>
                I understand this sends a real transaction on {chain?.displayName} and cannot be undone.
              </span>
            </label>
          </div>

          {requirePassword && (
            <div style={{ marginBottom: 14 }}>
              <PasswordField
                label="Wallet password"
                showLabel="Show password"
                hideLabel="Hide password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setPasswordError('');
                }}
                placeholder="Enter your password to confirm"
                testId="live-rewards-password"
                enterClicks="live-rewards-confirm"
              />
              {passwordError && (
                <span role="alert" style={{ fontSize: 11.5, color: 'var(--danger)', display: 'block', marginTop: 4 }}>
                  {passwordError}
                </span>
              )}
            </div>
          )}

          {confirmError && (
            <div className="banner danger" style={{ marginBottom: 14 }} data-testid="live-rewards-confirm-error">
              {confirmError}
            </div>
          )}

          <div style={{ display: 'flex', gap: 9 }}>
            <Button variant="secondary" onClick={backFromReview}>Back</Button>
            <Button
              block
              variant="danger"
              disabled={!armed || blocked}
              loading={confirming}
              onClick={() => void handleConfirm()}
              data-testid="live-rewards-confirm"
            >
              {plan.kind === 'move' ? 'Move' : 'Claim'}
            </Button>
          </div>
        </div>
        <LiveNav />
      </div>
    );
  }

  const rowsFor = (read: SatoriRewardsSnapshot | null) => [
    {
      kind: 'rewards' as const,
      claimableBase: read?.rewards?.claimableBase ?? null,
      prefix: '',
      detail: read?.rewards
        ? `Earned ${satori(read.rewards.lifetimeBase)}, claimed ${satori(read.rewards.claimedBase)}`
        : '',
    },
    {
      kind: 'airdrop' as const,
      claimableBase: read?.airdrop?.claimableBase ?? null,
      prefix: '',
      detail: read?.airdrop
        ? `Allocation ${satori(read.airdrop.allocationBase)}, claimed ${satori(read.airdrop.claimedBase)}`
        : '',
    },
    {
      kind: 'prediction' as const,
      claimableBase: read?.prediction?.claimableBase ?? null,
      prefix: read?.prediction && !read.prediction.complete ? 'At least ' : '',
      detail: 'From scored predictions',
    },
  ];

  const renderRows = (read: SatoriRewardsSnapshot | null, fromEvrKey: boolean, claimDisabled: boolean) => (
    <div className="stack">
      {rowsFor(read).map(({ kind, claimableBase, prefix, detail }) => {
        const hasClaim = claimableBase !== null && claimableBase > 0n;
        const suffix = fromEvrKey ? `evr-${kind}` : kind;
        return (
          <div key={kind} className="token-row" data-testid={`live-rewards-row-${suffix}`} style={{ alignItems: 'center' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>{KIND_TITLE[kind]}</div>
              <div style={{ fontSize: 12, marginTop: 2 }} data-testid={`live-rewards-amount-${suffix}`}>
                {claimableBase === null
                  ? 'Could not be read'
                  : hasClaim
                    ? `${prefix}${satori(claimableBase)}`
                    : 'Nothing to claim'}
              </div>
              {detail && <div className="text-dim" style={{ fontSize: 10.5, marginTop: 2 }}>{detail}</div>}
            </div>
            <Button
              size="sm"
              disabled={!hasClaim || claimDisabled || planning}
              onClick={() => void planSatoriClaim(kind, fromEvrKey)}
              data-testid={`live-rewards-claim-${suffix}`}
            >
              Claim
            </Button>
          </div>
        );
      })}
    </div>
  );

  // The Evrmore key's section is noise on a wallet that never earned on Evrmore,
  // so it shows only when that address has something, or could not be read.
  const evrRead = evrKey && evrKey.mainAddress === address ? evrKey : null;
  const evrParts = evrRead?.snapshot;
  const showEvrKey =
    !!evrRead &&
    (!evrParts ||
      evrRead.ethBase === null ||
      evrRead.satoriBase === null ||
      !evrParts.rewards ||
      !evrParts.airdrop ||
      !evrParts.prediction ||
      evrRead.ethBase > 0n ||
      evrRead.satoriBase > 0n ||
      evrParts.rewards.lifetimeBase > 0n ||
      evrParts.airdrop.allocationBase > 0n ||
      evrParts.prediction.claimableBase > 0n);

  return (
    <div className="app-frame screen-enter">
      <div className="sub-header">
        <button type="button" className="icon-btn" onClick={onBack} aria-label="Back">
          <ChevronLeft size={20} />
        </button>
        <h2>Rewards</h2>
        <button
          type="button"
          className="icon-btn"
          onClick={() => void refreshSatoriRewards()}
          aria-label="Refresh"
          disabled={loading}
        >
          <RefreshCw size={16} className={loading ? 'spin' : undefined} />
        </button>
      </div>

      <div className="app-content" data-testid="live-rewards">
        {snapshot?.issue && (
          <div className="banner danger" style={{ marginBottom: 12 }} data-testid="live-rewards-issue">
            <AlertTriangle size={14} />
            {snapshot.issue}
          </div>
        )}
        {error && (
          <div className="banner danger" style={{ marginBottom: 12 }} data-testid="live-rewards-error">
            <AlertTriangle size={14} />
            {error}
          </div>
        )}

        {noEth ? (
          <div className="banner warning" style={{ marginBottom: 12 }} data-testid="live-rewards-no-eth">
            <AlertTriangle size={14} />
            <span style={{ fontSize: 11.5 }}>
              This address has no {ticker} on {chain?.displayName}. Claiming pays a network fee in {ticker}, so send it a
              little first.
            </span>
          </div>
        ) : (
          <div className="banner info" style={{ marginBottom: 12 }}>
            <Info size={14} />
            <span style={{ fontSize: 11.5 }}>
              Claiming pays a network fee in {ticker}. Rewards add up, so you can claim daily or every few days.
            </span>
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12 }}>
          <span className="text-dim" style={{ fontSize: 11 }}>Claiming to</span>
          <span className="mono text-dim" style={{ fontSize: 11 }}>
            {address ? `${address.slice(0, 8)}…${address.slice(-6)}` : ''}
          </span>
          {address && <CopyButton value={address} label="Copy address" size={12} />}
        </div>

        {!snapshot && loading ? (
          <div className="stack">
            <div className="skeleton" style={{ height: 64, borderRadius: 12 }} />
            <div className="skeleton" style={{ height: 64, borderRadius: 12 }} />
            <div className="skeleton" style={{ height: 64, borderRadius: 12 }} />
          </div>
        ) : (
          renderRows(snapshot, false, noEth)
        )}

        <Button
          block
          size="sm"
          variant="secondary"
          onClick={() => setShowHistory(true)}
          data-testid="live-rewards-history-button"
          style={{ marginTop: 10 }}
        >
          Rewards history
        </Button>

        {showEvrKey && evrRead && (
          <div data-testid="live-rewards-evr-key" style={{ marginTop: 18 }}>
            <div className="section-label">Old Evrmore key</div>
            <div className="text-dim" style={{ fontSize: 11.5, lineHeight: 1.5, marginBottom: 8 }}>
              Rewards earned on Evrmore were kept for this key&apos;s address on {chain?.displayName}, not your main one.
              Claiming from it needs a little {ticker} on that address.
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <span className="mono text-dim" style={{ fontSize: 11 }} data-testid="live-rewards-evr-address">
                {`${evrRead.address.slice(0, 8)}…${evrRead.address.slice(-6)}`}
              </span>
              <CopyButton value={evrRead.address} label="Copy address" size={12} />
            </div>
            <div className="text-dim" style={{ fontSize: 11, marginBottom: 8 }} data-testid="live-rewards-evr-balances">
              {evrRead.ethBase === null ? `${ticker} could not be read` : `${formatListAmount(evrRead.ethBase, decimals)} ${ticker}`}
              {' · '}
              {evrRead.satoriBase === null ? 'SATORI could not be read' : satori(evrRead.satoriBase)}
            </div>
            {satoriLockText(evrRead.snapshot?.lock) && (
              <div className="banner warning" style={{ marginBottom: 8 }} data-testid="live-rewards-evr-lock">
                <AlertTriangle size={14} />
                <span style={{ fontSize: 11.5 }}>{satoriLockText(evrRead.snapshot?.lock)}</span>
              </div>
            )}
            {evrRead.snapshot?.issue && (
              <div className="banner danger" style={{ marginBottom: 8 }}>
                <AlertTriangle size={14} />
                {evrRead.snapshot.issue}
              </div>
            )}
            {renderRows(evrRead.snapshot, true, evrRead.ethBase === 0n)}
            {evrRead.satoriBase !== null && evrRead.satoriBase > 0n && (
              <Button
                block
                size="sm"
                variant="secondary"
                disabled={evrRead.ethBase === 0n || planning}
                onClick={() => void planSatoriMove()}
                data-testid="live-rewards-move"
                style={{ marginTop: 10 }}
              >
                Move SATORI to main address
              </Button>
            )}
          </div>
        )}
      </div>
      <LiveNav />
    </div>
  );
}
