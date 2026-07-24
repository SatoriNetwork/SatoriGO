// dApp approval window — the EXPLICIT user gate for every site connection and
// every send requested through `window.evrmore`.
//
// Opened by the background worker as index.html?dapp=<id> (App.tsx routes here
// before any other boot). Reads the pending request from chrome.storage.session
// and the PUBLIC wallet info (name/address/passwordless — never the vault) from
// the `liveWallets` record. For sends it unlocks/builds/signs/broadcasts with
// its OWN LiveWalletService instance, entirely inside this extension page —
// keys never reach the background worker, the content script or the page.
// The outcome goes back as {type:'evr-dapp-approve-result'} and the window closes.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Globe, SendHorizonal, ShieldCheck } from 'lucide-react';
import { Button } from '../../components/Button';
import { PasswordField } from '../../components/TextField';
import { getStorage } from '../../services/storage';
import { LiveWalletService, type LiveSendPlan, type LiveNetworkId } from '../../services/chain/liveWallet';
import { createElectrumClient } from '../../services/chain/electrumClient';
import { isP2pkhAddress } from '../../services/chain/keys';
import { networkFor } from '../../services/chain/chainParams';

/** Format sats (bigint) as a decimal EVR/asset amount. */
function fmtSats(sats: bigint): string {
  return (Number(sats) / 1e8).toLocaleString('en-US', { maximumFractionDigits: 8 });
}

const PENDING_PREFIX = 'dappPending:';

interface PendingDappRequest {
  id: string;
  tabId: number;
  origin: string;
  method: string;
  params?: { to?: unknown; amount?: unknown; asset?: unknown; message?: unknown };
}

interface PublicWalletInfo {
  name: string;
  address: string;
  passwordless: boolean;
  /** Chain id ('mainnet'|'testnet'|'ravencoin-mainnet'); drives every chain-aware
   *  label below (fee unit, chain name in copy). Defaults to 'mainnet' (Evrmore)
   *  for a legacy entry with no stored network. */
  network: string;
}

/** Public subset of the persisted `liveWallets` record (no vault is read). */
interface PublicWalletsRecord {
  wallets: { id: string; name?: string; address?: string; passwordless?: boolean; network?: string }[];
  activeId: string;
}

function shortAddress(addr: string): string {
  return addr.length > 20 ? `${addr.slice(0, 10)}…${addr.slice(-8)}` : addr;
}

/** Map raw build/broadcast error codes to human messages (mirrors LiveSend).
 *  `native` is the connected wallet's chain ticker: every message keeps its
 *  exact historical EVR wording (the dApp smoke asserts on it) and only
 *  branches for a Ravencoin wallet. */
function friendlyError(msg: string, assetName: string, native: 'EVR' | 'RVN'): string {
  const isRvn = native === 'RVN';
  switch (msg) {
    case 'insufficient-funds':
      return isRvn
        ? 'Insufficient RVN balance for this transaction (amount + network fee).'
        : 'Insufficient EVR balance for this transaction (amount + network fee).';
    case 'insufficient-asset':
      return `Insufficient ${assetName} balance for this transfer.`;
    case 'insufficient-evr-for-fee':
      return isRvn
        ? 'Not enough RVN to cover the network fee for this asset transfer.'
        : 'Not enough EVR to cover the network fee for this asset transfer.';
    case 'invalid-amount-precision':
      return `That amount is finer than ${assetName} allows. Reduce the number of decimals.`;
    case 'unknown-asset':
      return isRvn
        ? `Asset "${assetName}" was not found on the Ravencoin network.`
        : `Asset "${assetName}" was not found on the EVRmore network.`;
    case 'invalid-amount':
      return 'Enter a valid amount greater than 0.';
    case 'unsupported-address-type':
      return isRvn
        ? 'That recipient is not a standard Ravencoin address (only addresses starting with R are supported; P2SH / wrong-network addresses are rejected).'
        : 'That recipient is not a standard EVRmore address (only addresses starting with E are supported; P2SH / wrong-network addresses are rejected).';
    case 'input-verify-failed':
    case 'input-value-mismatch':
      return 'Could not verify your coins against the network (the server may be faulty or malicious). Nothing was sent. Try another Electrum server in Settings.';
    case 'broadcast-unconfirmed':
      return 'The server had a problem and the transaction could not be confirmed as sent. Nothing appears on the network. It is safe to try again.';
    default:
      return msg;
  }
}

export function DappApproval({ requestId }: { requestId: string }) {
  const [pending, setPending] = useState<PendingDappRequest | null>(null);
  const [wallet, setWallet] = useState<PublicWalletInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [password, setPassword] = useState('');
  const [actionError, setActionError] = useState('');
  const [working, setWorking] = useState(false);
  // A built+reviewed send: the plan (with its REAL fee) plus the still-unlocked
  // service that will broadcast it. Holding this lets us show the fee/total
  // BEFORE the user commits to broadcasting.
  const [review, setReview] = useState<{ plan: LiveSendPlan; service: LiveWalletService; client: { close(): void } } | null>(null);
  const settled = useRef(false);
  // Mirror `review` into a ref so the pagehide handler can zero the unlocked
  // service if the window is closed via the OS mid-review (defense-in-depth).
  const reviewRef = useRef(review);
  useEffect(() => {
    reviewRef.current = review;
  }, [review]);

  // Load the pending request (session storage) + public wallet info.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const key = PENDING_PREFIX + requestId;
        const found = await chrome.storage.session.get(key);
        const req = found[key] as PendingDappRequest | undefined;
        const record = await getStorage().get<PublicWalletsRecord>('liveWallets');
        const entry = record?.wallets?.find((w) => w.id === record.activeId);
        if (cancelled) return;
        if (!req) {
          setLoadError('This request has expired or was already handled.');
        } else {
          setPending(req);
        }
        if (entry) {
          setWallet({
            name: entry.name || 'Wallet',
            address: entry.address || '',
            passwordless: entry.passwordless ?? false,
            network: entry.network || 'mainnet',
          });
        }
      } catch {
        if (!cancelled) setLoadError('Could not load the request.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [requestId]);

  /** Send the terminal outcome to the worker exactly once, then close. */
  const settle = useCallback(
    async (payload: { result?: unknown; error?: string; approveOrigin?: string }) => {
      if (settled.current) return;
      settled.current = true;
      try {
        await chrome.runtime.sendMessage({
          type: 'evr-dapp-approve-result',
          id: requestId,
          ...payload,
        });
      } catch {
        // worker unreachable — still close; the page's request will simply hang
      }
      window.close();
    },
    [requestId],
  );

  // Closing the window without deciding counts as a rejection.
  useEffect(() => {
    const onPageHide = () => {
      // Zero any unlocked in-memory secret before the window is torn down.
      if (reviewRef.current) {
        reviewRef.current.service.lock();
        reviewRef.current.client.close();
      }
      if (settled.current) return;
      settled.current = true;
      try {
        void chrome.runtime.sendMessage({
          type: 'evr-dapp-approve-result',
          id: requestId,
          error: 'user-rejected',
        });
      } catch {
        // best-effort
      }
    };
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, [requestId]);

  const reject = () => {
    if (review) {
      review.service.lock();
      review.client.close();
    }
    void settle({ error: 'user-rejected' });
  };

  const approveConnect = () => {
    if (!wallet?.address || !pending) return;
    void settle({ result: { address: wallet.address }, approveOrigin: pending.origin });
  };

  // Step 1: unlock -> build+sign (NO broadcast). Surfaces the REAL fee so the
  // user sees exactly what will be spent before committing. The unlocked service
  // is held (in `review`) for the confirm step. All inside THIS extension page.
  const reviewSend = async () => {
    if (!pending || working) return;
    setActionError('');
    const to = typeof pending.params?.to === 'string' ? pending.params.to.trim() : '';
    const amount = Number(pending.params?.amount);
    const assetName =
      pending.method === 'sendAsset' && typeof pending.params?.asset === 'string'
        ? pending.params.asset.trim().toUpperCase()
        : '';
    if (!to || !Number.isFinite(amount) || amount <= 0) {
      setActionError('The site sent an invalid recipient or amount.');
      return;
    }
    if (pending.method === 'sendAsset' && !assetName) {
      setActionError('The site sent an invalid asset name.');
      return;
    }
    setWorking(true);
    const client = createElectrumClient();
    const service = new LiveWalletService(client);
    let unlocked = false;
    try {
      const ok = await service.unlock(wallet?.passwordless ? '' : password);
      if (!ok) {
        setActionError('Incorrect password.');
        return;
      }
      unlocked = true;
      // Reject a malformed / wrong-network / wrong-type (e.g. P2SH) recipient
      // before building a P2PKH output that the recipient couldn't spend.
      const net = networkFor(service.network());
      if (!isP2pkhAddress(to, net)) {
        setActionError(
          net.ticker === 'RVN'
            ? 'The site sent an unsupported Ravencoin address (only standard P2PKH addresses starting with R are accepted).'
            : 'The site sent an unsupported EVRmore address (only standard P2PKH addresses starting with E are accepted).',
        );
        return;
      }
      await client.connect();
      const amountSats = BigInt(Math.round(amount * 1e8));
      const plan =
        pending.method === 'sendAsset'
          ? await service.buildAssetSend(to, assetName, amountSats)
          : await service.buildEvrSend(to, amountSats);
      // Keep the unlocked service + client alive for the confirm step.
      setReview({ plan, service, client });
      unlocked = false; // ownership transferred to `review`
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      setActionError(friendlyError(raw, assetName || walletNativeTicker, networkFor(service.network()).ticker));
    } finally {
      if (unlocked) {
        service.lock();
        client.close();
      }
      setWorking(false);
    }
  };

  // Step 2: broadcast the reviewed plan (fee already shown + agreed).
  const confirmSend = async () => {
    if (!review || working) return;
    setActionError('');
    setWorking(true);
    try {
      review.service.allowBroadcast = true;
      const txid = await review.service.broadcast(review.plan.built.rawHex);
      await settle({ result: { txid } });
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      setActionError(friendlyError(raw, review.plan.assetName || walletNativeTicker, walletNativeTicker));
    } finally {
      review.service.lock();
      review.client.close();
      setReview(null);
      setWorking(false);
    }
  };

  // Sign an arbitrary message with the active wallet's primary key. Pure local
  // crypto — no network, no broadcast. Keys stay inside this extension page; only
  // { address, signature } goes back to the site. Password-gated unless the
  // wallet is passwordless.
  const approveSign = async () => {
    if (!pending || working) return;
    setActionError('');
    const message = typeof pending.params?.message === 'string' ? pending.params.message : null;
    if (message === null) {
      setActionError('The site sent an invalid message to sign.');
      return;
    }
    setWorking(true);
    const client = createElectrumClient();
    const service = new LiveWalletService(client);
    try {
      const ok = await service.unlock(wallet?.passwordless ? '' : password);
      if (!ok) {
        setActionError('Incorrect password.');
        return;
      }
      const signed = service.signMessage(message);
      await settle({ result: signed });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      service.lock();
      client.close();
      setWorking(false);
    }
  };

  if (loading) {
    return (
      <div className="app-frame">
        <div className="result-screen">
          <span className="spinner lg" style={{ color: 'var(--accent)' }} />
        </div>
      </div>
    );
  }

  if (!pending || loadError) {
    return (
      <div className="app-frame" data-testid="dapp-approval">
        <div className="app-content">
          <div className="banner danger" style={{ marginTop: 16 }} data-testid="dapp-error">
            {loadError || 'This request has expired or was already handled.'}
          </div>
          <Button block variant="secondary" style={{ marginTop: 14 }} onClick={() => window.close()}>
            Close
          </Button>
        </div>
      </div>
    );
  }

  // The connected wallet's chain ticker: drives every chain-aware label below
  // (fee unit, "sending X" wording, default asset name for a native send).
  const walletNativeTicker = networkFor((wallet?.network as LiveNetworkId | undefined) ?? 'mainnet').ticker;

  const isSend = pending.method === 'sendEvr' || pending.method === 'sendAsset';
  const isSign = pending.method === 'signMessage';
  const signMessageText = typeof pending.params?.message === 'string' ? pending.params.message : '';
  const sendAssetName =
    pending.method === 'sendAsset' && typeof pending.params?.asset === 'string'
      ? pending.params.asset.trim().toUpperCase()
      : walletNativeTicker;
  const sendAmount = Number(pending.params?.amount);
  const sendTo = typeof pending.params?.to === 'string' ? pending.params.to : '';
  const needPassword = !(wallet?.passwordless ?? false);

  return (
    <div className="app-frame screen-enter" data-testid="dapp-approval">
      <div className="sub-header">
        <span style={{ width: 32 }} />
        <h2 style={{ flex: 1 }}>{isSend ? 'Confirm transaction' : isSign ? 'Sign message' : 'Connect to site'}</h2>
        <span style={{ width: 32 }} />
      </div>
      <div className="app-content">
        <div className="banner info" style={{ marginBottom: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Globe size={16} style={{ flexShrink: 0 }} />
          <span className="mono" style={{ wordBreak: 'break-all' }} data-testid="dapp-origin">
            {pending.origin}
          </span>
        </div>

        {isSign && (
          <>
            <p className="text-dim" style={{ fontSize: 12.5, lineHeight: 1.55, margin: '0 2px 14px' }}>
              This site wants you to <strong>sign a message</strong> with your wallet to
              prove you control its address (e.g. to log in). Signing costs nothing,
              moves no funds, and reveals no private key.
            </p>
            <div className="section-label" style={{ marginTop: 0 }}>Signing wallet</div>
            <div className="card solid" style={{ marginBottom: 14 }}>
              <div className="summary-table">
                <div className="sum-row">
                  <span className="sum-key">Wallet</span>
                  <span className="sum-val">{wallet?.name ?? 'n/a'}</span>
                </div>
                <div className="sum-row">
                  <span className="sum-key">Address</span>
                  <span className="sum-val mono" style={{ fontSize: 11 }} data-testid="dapp-sign-address">
                    {wallet?.address ? shortAddress(wallet.address) : 'No wallet set up'}
                  </span>
                </div>
              </div>
            </div>
            <div className="section-label">Message</div>
            <div
              className="card solid mono"
              style={{ marginBottom: 14, maxHeight: 150, overflowY: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, lineHeight: 1.5 }}
              data-testid="dapp-sign-message"
            >
              {signMessageText || <span className="text-dim">(empty message)</span>}
            </div>

            {needPassword && (
              <PasswordField
                label="Wallet password"
                showLabel="Show password"
                hideLabel="Hide password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter your wallet password"
                autoFocus
                testId="dapp-password"
              />
            )}

            {actionError && (
              <div className="banner danger" style={{ margin: '12px 0 0' }} data-testid="dapp-error" role="alert">
                {actionError}
              </div>
            )}

            <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
              <Button block variant="secondary" data-testid="dapp-reject" disabled={working} onClick={reject}>
                Reject
              </Button>
              <Button
                block
                loading={working}
                icon={working ? undefined : <ShieldCheck size={16} />}
                data-testid="dapp-approve"
                disabled={!wallet?.address}
                onClick={() => void approveSign()}
              >
                Sign
              </Button>
            </div>
          </>
        )}

        {!isSend && !isSign && (
          <>
            <p className="text-dim" style={{ fontSize: 12.5, lineHeight: 1.55, margin: '0 2px 14px' }}>
              This site wants to connect to your wallet. It will be able to see your
              address and balances, and to <strong>request</strong> transactions.
              every send still needs your explicit approval.
            </p>
            <div className="section-label">Wallet to connect</div>
            <div className="card solid" style={{ marginBottom: 14 }}>
              <div className="summary-table">
                <div className="sum-row">
                  <span className="sum-key">Wallet</span>
                  <span className="sum-val" data-testid="dapp-wallet-name">{wallet?.name ?? 'n/a'}</span>
                </div>
                <div className="sum-row">
                  <span className="sum-key">Address</span>
                  <span className="sum-val mono" style={{ fontSize: 11 }} data-testid="dapp-wallet-address">
                    {wallet?.address ? shortAddress(wallet.address) : 'No wallet set up'}
                  </span>
                </div>
              </div>
            </div>
            {!wallet?.address && (
              <div className="banner warning" style={{ marginBottom: 14 }}>
                Set up the live wallet in the extension first, then retry from the site.
              </div>
            )}
            <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
              <Button block variant="secondary" data-testid="dapp-reject" onClick={reject}>
                Reject
              </Button>
              <Button
                block
                icon={<ShieldCheck size={16} />}
                data-testid="dapp-approve"
                disabled={!wallet?.address}
                onClick={approveConnect}
              >
                Connect
              </Button>
            </div>
          </>
        )}

        {isSend && (
          <>
            <div className="banner warning" style={{ marginBottom: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
              <SendHorizonal size={15} style={{ flexShrink: 0 }} />
              <span>
                Sending <strong>{Number.isFinite(sendAmount) ? sendAmount : '?'} {sendAssetName}</strong> on the REAL
                {walletNativeTicker === 'RVN' ? ' Ravencoin' : ' EVRmore'} network. This cannot be undone.
              </span>
            </div>
            <div className="card solid" style={{ marginBottom: 14 }}>
              <div className="summary-table">
                <div className="sum-row">
                  <span className="sum-key">From wallet</span>
                  <span className="sum-val">{wallet?.name ?? 'n/a'}</span>
                </div>
                <div className="sum-row">
                  <span className="sum-key">To</span>
                  <span className="sum-val mono" style={{ fontSize: 11, wordBreak: 'break-all' }} data-testid="dapp-send-to">
                    {sendTo || 'n/a'}
                  </span>
                </div>
                <div className="sum-row">
                  <span className="sum-key">Amount</span>
                  <span className="sum-val" data-testid="dapp-send-amount">
                    {Number.isFinite(sendAmount) ? sendAmount : '?'} {sendAssetName}
                  </span>
                </div>
                <div className="sum-row" data-testid="dapp-send-fee">
                  <span className="sum-key">Network fee</span>
                  <span className="sum-val">
                    {review ? `${fmtSats(review.plan.feeSats)} ${walletNativeTicker}` : 'shown after review'}
                  </span>
                </div>
                {review && review.plan.assetName === undefined && (
                  <div className="sum-row">
                    <span className="sum-key">Total debited</span>
                    <span className="sum-val">
                      {fmtSats(review.plan.amountSats + review.plan.feeSats)} {walletNativeTicker}
                    </span>
                  </div>
                )}
              </div>
            </div>

            {needPassword && !review && (
              <PasswordField
                label="Wallet password"
                showLabel="Show password"
                hideLabel="Hide password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter your wallet password"
                autoFocus
                testId="dapp-password"
              />
            )}

            {review && (
              <div className="banner info" style={{ marginTop: 4 }}>
                Reviewed &amp; signed. Confirm to broadcast. The fee above is final.
              </div>
            )}

            {actionError && (
              <div className="banner danger" style={{ margin: '12px 0 0' }} data-testid="dapp-error" role="alert">
                {actionError}
              </div>
            )}

            <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
              <Button block variant="secondary" data-testid="dapp-reject" disabled={working} onClick={reject}>
                Reject
              </Button>
              {review ? (
                <Button
                  block
                  loading={working}
                  icon={working ? undefined : <ShieldCheck size={16} />}
                  data-testid="dapp-confirm"
                  onClick={() => void confirmSend()}
                >
                  Confirm &amp; Send
                </Button>
              ) : (
                <Button
                  block
                  loading={working}
                  data-testid="dapp-approve"
                  onClick={() => void reviewSend()}
                >
                  Review
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
