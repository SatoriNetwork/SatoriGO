// The approval screen for window.ethereum requests: connect an EVM account,
// personal_sign, eth_signTypedData_v4 and eth_sendTransaction.
//
// Rendered by DappApproval for a pending request with family 'evm'. DappApproval
// keeps the lifecycle it already owns (loading the request, the liveness ping,
// the port, "closed without deciding = rejected", settle-once); this component
// owns only what is EVM: the account picker, what is shown, and the signing.
//
// Keys stay in THIS extension page, exactly as on the Evrmore side: the wallet
// is unlocked here (or the hosting window lends its unlocked service), signs,
// and is locked again. Only an address, a signature or a txid goes back.
//
// A transaction is priced and SIMULATED (planEvmCall runs eth_estimateGas, so a
// call the chain would revert never reaches a Confirm button), then sent
// through broadcastEvmPlan, the wallet's one guarded broadcast path (fee caps,
// nonce, decode-back check). The site's own gas and fee fields are ignored: the
// wallet prices the transaction itself.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { FileSignature, SendHorizonal, ShieldCheck, TriangleAlert } from 'lucide-react';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
import { Button } from '../../components/Button';
import { PasswordField } from '../../components/TextField';
import { getStorage } from '../../services/storage';
import { LiveWalletService } from '../../services/chain/liveWallet';
import { createElectrumClient } from '../../services/chain/electrumClient';
import { loadEvmModules } from '../../services/chain/engine';
import { formatAmount } from '../../services/chain/amounts';
import { loadEvmChainInfos, type EvmChainInfo } from '../../store/evmChains';
import { evmProviderFor } from '../../store/evmBalances';
import { planEvmCall, type EvmCallPlan } from '../../store/evmCall';
import { broadcastEvmPlan } from '../../store/evmSend';
import type { TypedData } from '../../services/chain/evm/typedData';
import type { DappHostSession } from './DappApproval';

export interface PendingEvmRequest {
  id: string;
  origin: string;
  method: string;
  params?: unknown;
  walletId?: string;
  chainKey?: string;
}

interface EvmWalletInfo {
  id: string;
  name: string;
  address: string;
  passwordless: boolean;
  appProtected: boolean;
}

interface WalletsRecord {
  wallets?: {
    id: string;
    name?: string;
    address?: string;
    passwordless?: boolean;
    family?: string;
    vault?: { version?: number };
  }[];
  activeId?: string;
}

export interface DappApprovalEvmProps {
  pending: PendingEvmRequest;
  hosted: boolean;
  session?: DappHostSession;
  settle(payload: { result?: unknown; error?: unknown; approveOrigin?: string; walletId?: string }): Promise<void>;
  frame(children: ReactNode): ReactNode;
}

function shortAddress(addr: string): string {
  return addr.length > 20 ? `${addr.slice(0, 10)}…${addr.slice(-8)}` : addr;
}

/** What personal_sign signs and shows: 0x hex is bytes (shown as text when it
 *  is readable UTF-8), anything else is the text itself. */
export function decodeSignMessage(raw: string): { bytes: Uint8Array; text: string | null } {
  if (/^0x([0-9a-fA-F]{2})*$/.test(raw)) {
    const bytes = hexToBytes(raw.slice(2));
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      // eslint-disable-next-line no-control-regex
      return { bytes, text: /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text) ? null : text };
    } catch {
      return { bytes, text: null };
    }
  }
  return { bytes: new TextEncoder().encode(raw), text: raw };
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** The message of a personal_sign request. Normally [message, address]; some
 *  older sites send [address, message]. Swapped ONLY when the first looks like
 *  an address and the second does not, the worker's rule exactly: a 20-byte
 *  message is also 40 hex characters. */
export function personalSignMessage(params: readonly unknown[]): unknown {
  return typeof params[0] === 'string' && ADDRESS_RE.test(params[0]) && !(typeof params[1] === 'string' && ADDRESS_RE.test(params[1]))
    ? params[1]
    : params[0];
}

const toWei = (v: unknown): bigint => (typeof v === 'string' && /^0x[0-9a-fA-F]+$/.test(v) ? BigInt(v) : 0n);

export function DappApprovalEvm({ pending, hosted, session, settle, frame }: DappApprovalEvmProps) {
  const [wallet, setWallet] = useState<EvmWalletInfo | null>(null);
  const [choices, setChoices] = useState<EvmWalletInfo[]>([]);
  const [chain, setChain] = useState<EvmChainInfo | null>(null);
  const [typed, setTyped] = useState<TypedData | null>(null);
  const [loading, setLoading] = useState(true);
  const [password, setPassword] = useState('');
  const [actionError, setActionError] = useState('');
  const [working, setWorking] = useState(false);
  const [review, setReview] = useState<{ plan: EvmCallPlan; service: LiveWalletService; owned: boolean } | null>(null);
  const reviewRef = useRef(review);
  useEffect(() => {
    reviewRef.current = review;
  }, [review]);

  const params = Array.isArray(pending.params) ? pending.params : [];
  const isConnect = pending.method === 'eth_requestAccounts';
  const isPersonal = pending.method === 'personal_sign';
  const isTyped = pending.method === 'eth_signTypedData_v4';
  const isSend = pending.method === 'eth_sendTransaction';

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const record = await getStorage().get<WalletsRecord>('liveWallets');
        const evmWallets = (record?.wallets ?? [])
          .filter((w) => w.family === 'evm' && w.address)
          .map((w) => ({
            id: w.id,
            name: w.name || 'Account',
            address: w.address as string,
            passwordless: w.passwordless ?? false,
            appProtected: w.vault?.version === 2,
          }));
        const chains = await loadEvmChainInfos();
        let parsed: TypedData | null = null;
        if (pending.method === 'eth_signTypedData_v4') {
          const evm = await loadEvmModules();
          if (evm) parsed = evm.parseTypedData(params[1]);
        }
        if (cancelled) return;
        setChoices(evmWallets);
        setChain(chains.find((c) => c.key === pending.chainKey) ?? chains.find((c) => c.key === 'base') ?? null);
        setTyped(parsed);
        setWallet(
          isConnect
            ? (evmWallets.find((w) => w.id === pending.walletId) ??
                evmWallets.find((w) => w.id === record?.activeId) ??
                evmWallets[0] ??
                null)
            : (evmWallets.find((w) => w.id === pending.walletId) ?? null),
        );
      } catch (err) {
        if (!cancelled) setActionError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // The request is fixed for this page's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending.id]);

  // Zero an unlocked service if the page goes away mid-review.
  useEffect(() => {
    const lockOwned = () => {
      if (reviewRef.current?.owned) reviewRef.current.service.lockApp();
    };
    window.addEventListener('pagehide', lockOwned);
    return () => {
      window.removeEventListener('pagehide', lockOwned);
      lockOwned();
    };
  }, []);

  /** The hosting page's unlocked service, when it shows this very account. */
  const shared = hosted && session && session.unlocked && wallet && session.activeWalletId === wallet.id ? session : null;
  const needPassword = !shared && ((wallet?.appProtected ?? false) || !(wallet?.passwordless ?? false));

  /** Run `fn` with an unlocked service for the connected account: the lent
   *  one, or a fresh one unlocked with the typed password and locked after
   *  (unless `keep`, which hands ownership to the caller). */
  const withService = async <T,>(fn: (svc: LiveWalletService) => Promise<T> | T, keep = false): Promise<T | null> => {
    if (shared) return fn(shared.service);
    const service = new LiveWalletService(createElectrumClient());
    if (wallet) service.adoptWallet(wallet.id);
    const secret = wallet?.passwordless && !wallet.appProtected ? '' : password;
    let handedOver = false;
    try {
      if (!(await service.unlock(secret))) {
        setActionError('Incorrect password.');
        return null;
      }
      const out = await fn(service);
      handedOver = keep;
      return out;
    } finally {
      if (!handedOver) service.lockApp();
    }
  };

  const reject = () => {
    if (review?.owned) review.service.lockApp();
    void settle({ error: 'user-rejected' });
  };

  const approveConnect = () => {
    if (!wallet) return;
    void settle({ result: [wallet.address], approveOrigin: pending.origin, walletId: wallet.id });
  };

  const approveSign = async () => {
    if (working || !wallet) return;
    setActionError('');
    setWorking(true);
    try {
      let signed: { address: string; signature: string } | null;
      if (isPersonal) {
        const raw = personalSignMessage(params);
        if (typeof raw !== 'string') throw new Error('The site sent an invalid message to sign.');
        const { bytes } = decodeSignMessage(raw);
        signed = await withService((svc) => svc.personalSignEvm(bytes));
      } else {
        if (!typed) throw new Error('The site sent typed data Satori GO cannot read.');
        signed = await withService((svc) => svc.signTypedDataEvm(typed));
      }
      if (!signed) return;
      if (signed.address.toLowerCase() !== wallet.address.toLowerCase()) {
        throw new Error('The unlocked account is not the one connected to this site. Nothing was signed.');
      }
      await settle({ result: signed.signature });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  };

  const tx = (isSend && params[0] && typeof params[0] === 'object' ? params[0] : {}) as Record<string, unknown>;
  const txTo = typeof tx.to === 'string' ? tx.to : '';
  const txValue = toWei(tx.value);
  const txDataHex = typeof tx.data === 'string' ? tx.data : typeof tx.input === 'string' ? tx.input : '0x';
  const txData = /^0x([0-9a-fA-F]{2})*$/.test(txDataHex) ? hexToBytes(txDataHex.slice(2)) : new Uint8Array();

  // Step 1: price + simulate (and, without a lent service, unlock and hold).
  const reviewSend = async () => {
    if (working || !wallet || !chain) return;
    setActionError('');
    setWorking(true);
    try {
      const provider = await evmProviderFor(chain.key);
      if (!provider) throw new Error('This build of Satori GO has no EVM engine.');
      let balance: bigint | undefined;
      try {
        balance = BigInt(await provider.rpc.call<string>('eth_getBalance', [wallet.address, 'latest']));
      } catch {
        balance = undefined; // unknown: the node refuses an unaffordable send anyway
      }
      const plan = await planEvmCall({
        provider,
        chain,
        from: wallet.address,
        nativeBalanceBase: balance,
        input: {
          to: txTo,
          data: txData,
          value: txValue,
          description: `Transaction requested by ${pending.origin}`,
          allowEmptyData: true,
        },
      });
      if (shared) {
        setReview({ plan, service: shared.service, owned: false });
      } else {
        // Unlock now so a wrong password is caught at review; keep the service
        // for the confirm step (it is locked on confirm, reject or page close).
        const service = await withService((svc) => svc, true);
        if (service) setReview({ plan, service, owned: true });
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  };

  // Step 2: sign and broadcast the reviewed plan.
  const confirmSend = async () => {
    if (!review || working || !chain) return;
    setActionError('');
    setWorking(true);
    try {
      if (!review.owned && shared?.sendNeedsPassword && !(await shared.verifyPassword(password))) {
        setActionError('Incorrect password.');
        return;
      }
      if (review.plan.capRefusal) throw new Error(review.plan.capRefusal);
      const provider = await evmProviderFor(chain.key);
      const evm = await loadEvmModules();
      if (!provider || !evm) throw new Error('This build of Satori GO has no EVM engine.');
      const result = await broadcastEvmPlan({
        provider,
        plan: review.plan,
        nonces: new evm.EvmNonceTracker(),
        sign: (request) => review.service.signEvmTransaction(request),
        // The user pressed Confirm on a reviewed, priced transaction: that is
        // the arming act, as on the wallet's own send screen.
        allowBroadcast: true,
      });
      if (review.owned) review.service.lockApp();
      setReview(null);
      await settle({ result: result.txid });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  };

  if (loading) {
    return frame(
      <div className="app-frame">
        <div className="result-screen">
          <span className="spinner lg" style={{ color: 'var(--accent)' }} />
        </div>
      </div>,
    );
  }

  // Hosted, wallet locked, keys needed: the lock screen stays and a strip says
  // who is waiting (same rule as the Evrmore approvals).
  if (hosted && session && !session.unlocked && !isConnect) {
    return (
      <div
        data-testid="dapp-unlock-wait"
        role="status"
        style={{
          position: 'fixed', top: 0, left: 0, right: 0, zIndex: 1000, display: 'flex', alignItems: 'center', gap: 10,
          padding: '10px 12px', background: 'var(--bg)', borderBottom: '1px solid var(--border-strong)',
          boxShadow: '0 4px 14px rgba(0,0,0,0.18)',
        }}
      >
        <ShieldCheck size={16} style={{ flexShrink: 0, color: 'var(--accent)' }} />
        <span style={{ flex: 1, fontSize: 12.5, lineHeight: 1.4 }}>
          <strong className="mono" style={{ wordBreak: 'break-all' }}>{pending.origin}</strong>{' '}
          asks you to {isSend ? 'confirm a transaction' : 'sign a message'}. Unlock the wallet to continue.
        </span>
        <Button variant="secondary" data-testid="dapp-reject" style={{ flexShrink: 0, padding: '6px 12px' }} onClick={reject}>
          Reject
        </Button>
      </div>
    );
  }

  const chainName = chain?.displayName ?? 'EVM';
  const ticker = chain?.nativeTicker ?? 'ETH';
  const decimals = chain?.nativeDecimals ?? 18;
  const title = isConnect ? 'Connect to site' : isSend ? 'Confirm transaction' : 'Sign message';

  const accountCard = (label: string) => (
    <div className="card solid" style={{ marginBottom: 10, flexShrink: 0 }}>
      <div className="summary-table">
        <div className="sum-row">
          <span className="sum-key">{label}</span>
          <span className="sum-val" data-testid="dapp-wallet-name">{wallet?.name ?? 'n/a'}</span>
        </div>
        <div className="sum-row">
          <span className="sum-key">Address</span>
          <span className="sum-val mono" style={{ fontSize: 11 }} data-testid="dapp-wallet-address">
            {wallet ? shortAddress(wallet.address) : 'No EVM account set up'}
          </span>
        </div>
        <div className="sum-row">
          <span className="sum-key">Network</span>
          <span className="sum-val" data-testid="dapp-evm-chain">{chainName}</span>
        </div>
      </div>
    </div>
  );

  const passwordBox = (
    <div style={{ flexShrink: 0 }}>
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
    </div>
  );

  const errorBox = actionError && (
    <div className="banner danger" style={{ margin: '10px 0 0', flexShrink: 0 }} data-testid="dapp-error" role="alert">
      {actionError}
    </div>
  );

  const signText = (() => {
    if (!isPersonal) return null;
    const raw = personalSignMessage(params);
    if (typeof raw !== 'string') return null;
    const { bytes, text } = decodeSignMessage(raw);
    return text ?? `0x${bytesToHex(bytes)}`;
  })();
  const looksLikePermit =
    !!typed && (/permit/i.test(typed.primaryType) || 'spender' in typed.message || 'operator' in typed.message);

  return frame(
    <div className="app-frame screen-enter" data-testid="dapp-approval">
      <div className="sub-header">
        <span style={{ width: 32 }} />
        <h2 style={{ flex: 1 }}>{title}</h2>
        <span style={{ width: 32 }} />
      </div>
      <div className="app-content" style={{ display: 'flex', flexDirection: 'column' }}>
        <div className="banner info" style={{ marginBottom: 10, flexShrink: 0 }}>
          <span className="mono" style={{ wordBreak: 'break-all' }} data-testid="dapp-origin">{pending.origin}</span>
        </div>

        {isConnect && (
          <>
            <p className="text-dim" style={{ fontSize: 12.5, lineHeight: 1.5, margin: '0 2px 10px', flexShrink: 0 }}>
              This site wants to connect to your <strong>{chainName}</strong> account. It will see the
              address and may <strong>request</strong> signatures and transactions, each of which still
              needs your approval.
            </p>
            {choices.length > 1 && (
              <div style={{ marginBottom: 10, flexShrink: 0 }} data-testid="dapp-wallet-picker">
                <select
                  className="live-picker"
                  data-testid="dapp-wallet-select"
                  aria-label="Account to connect"
                  value={wallet?.id ?? ''}
                  onChange={(e) => setWallet(choices.find((c) => c.id === e.target.value) ?? wallet)}
                  style={{ width: '100%' }}
                >
                  {choices.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} · {shortAddress(c.address)}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {accountCard('Account')}
            {!wallet && (
              <div className="banner warning" style={{ marginBottom: 10, flexShrink: 0 }} data-testid="dapp-no-evm-wallet">
                This site needs an EVM account. Open Satori GO, add Base (or another EVM network) to a wallet, then retry from the site.
              </div>
            )}
            <div style={{ display: 'flex', gap: 10, marginTop: 4, flexShrink: 0 }}>
              <Button block variant="secondary" data-testid="dapp-reject" onClick={reject}>Reject</Button>
              <Button block icon={<ShieldCheck size={16} />} data-testid="dapp-approve" disabled={!wallet} onClick={approveConnect}>
                Connect
              </Button>
            </div>
          </>
        )}

        {(isPersonal || isTyped) && (
          <>
            <p className="text-dim" style={{ fontSize: 12.5, lineHeight: 1.5, margin: '0 2px 10px', flexShrink: 0 }}>
              This site asks you to <strong>sign</strong> {isTyped ? 'structured data' : 'a message'}. No transaction is sent
              by signing{isTyped ? ', but a signature like this can authorise a contract to act for you' : ''}.
            </p>
            {looksLikePermit && (
              <div className="banner warning" style={{ marginBottom: 10, display: 'flex', gap: 8, flexShrink: 0 }} data-testid="dapp-permit-warning">
                <TriangleAlert size={15} style={{ flexShrink: 0 }} />
                <span>This looks like a <strong>token permit</strong>: it can let another address spend your tokens. Only sign on sites you trust.</span>
              </div>
            )}
            {accountCard('Signing account')}
            {isTyped && typed && (
              <div className="card solid" style={{ marginBottom: 10, flexShrink: 0 }}>
                <div className="summary-table">
                  {(['name', 'version', 'chainId', 'verifyingContract'] as const)
                    .filter((k) => typed.domain[k] !== undefined)
                    .map((k) => (
                      <div className="sum-row" key={k}>
                        <span className="sum-key">{k === 'verifyingContract' ? 'Contract' : k === 'chainId' ? 'Chain id' : k[0].toUpperCase() + k.slice(1)}</span>
                        <span className="sum-val mono" style={{ fontSize: 11, wordBreak: 'break-all' }}>{String(typed.domain[k])}</span>
                      </div>
                    ))}
                  <div className="sum-row">
                    <span className="sum-key">Type</span>
                    <span className="sum-val mono" style={{ fontSize: 11 }}>{typed.primaryType}</span>
                  </div>
                </div>
              </div>
            )}
            <div className="section-label" style={{ marginTop: 0, flexShrink: 0 }}>
              <FileSignature size={12} style={{ verticalAlign: '-1px', marginRight: 4 }} />
              Message
            </div>
            <div
              className="card solid mono"
              style={{ marginBottom: 10, flex: '0 1 auto', minHeight: 44, maxHeight: 180, overflowY: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, lineHeight: 1.5 }}
              data-testid="dapp-sign-message"
            >
              {isTyped ? (typed ? JSON.stringify(typed.message, null, 2) : '') : signText || <span className="text-dim">(empty message)</span>}
            </div>
            {needPassword && passwordBox}
            {errorBox}
            <div style={{ display: 'flex', gap: 10, marginTop: 12, flexShrink: 0 }}>
              <Button block variant="secondary" data-testid="dapp-reject" disabled={working} onClick={reject}>Reject</Button>
              <Button
                block
                loading={working}
                icon={working ? undefined : <ShieldCheck size={16} />}
                data-testid="dapp-approve"
                disabled={!wallet || (isTyped && !typed)}
                onClick={() => void approveSign()}
              >
                Sign
              </Button>
            </div>
          </>
        )}

        {isSend && (
          <>
            <div className="banner warning" style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
              <SendHorizonal size={15} style={{ flexShrink: 0 }} />
              <span>
                A transaction on the <strong>real</strong> {chainName} network. This cannot be undone.
                {txData.length > 0 && ' It calls a contract; Satori GO cannot tell what the contract does, so only approve on sites you trust.'}
              </span>
            </div>
            <div className="card solid" style={{ marginBottom: 12, flexShrink: 0 }}>
              <div className="summary-table">
                <div className="sum-row">
                  <span className="sum-key">From</span>
                  <span className="sum-val">{wallet?.name ?? 'n/a'}</span>
                </div>
                <div className="sum-row">
                  <span className="sum-key">To</span>
                  <span className="sum-val mono" style={{ fontSize: 11, wordBreak: 'break-all' }} data-testid="dapp-send-to">{txTo || 'n/a'}</span>
                </div>
                <div className="sum-row">
                  <span className="sum-key">Amount</span>
                  <span className="sum-val" data-testid="dapp-send-amount">{formatAmount(txValue, decimals)} {ticker}</span>
                </div>
                {txData.length > 0 && (
                  <div className="sum-row">
                    <span className="sum-key">Data</span>
                    <span className="sum-val mono" style={{ fontSize: 11 }} data-testid="dapp-send-data">
                      {txData.length} bytes · 0x{bytesToHex(txData.slice(0, 4))}
                    </span>
                  </div>
                )}
                <div className="sum-row" data-testid="dapp-send-fee">
                  <span className="sum-key">Network fee</span>
                  <span className="sum-val">
                    {review
                      ? `${formatAmount(review.plan.quote.estimatedTotal, decimals)} ${ticker} (max ${formatAmount(review.plan.quote.maxTotal, decimals)})`
                      : 'shown after review'}
                  </span>
                </div>
              </div>
            </div>
            {review?.plan.shortfall && (
              <div className="banner danger" style={{ marginBottom: 10, flexShrink: 0 }}>{review.plan.shortfall}</div>
            )}
            {review?.plan.capRefusal && (
              <div className="banner danger" style={{ marginBottom: 10, flexShrink: 0 }}>{review.plan.capRefusal}</div>
            )}
            {((needPassword && !review) || (!!shared && shared.sendNeedsPassword && !!review)) && passwordBox}
            {review && !review.plan.shortfall && !review.plan.capRefusal && (
              <div className="banner info" style={{ marginTop: 4, flexShrink: 0 }}>
                Simulated and priced. Confirm to sign and send.
              </div>
            )}
            {errorBox}
            <div style={{ display: 'flex', gap: 10, marginTop: 12, flexShrink: 0 }}>
              <Button block variant="secondary" data-testid="dapp-reject" disabled={working} onClick={reject}>Reject</Button>
              {review ? (
                <Button
                  block
                  loading={working}
                  icon={working ? undefined : <ShieldCheck size={16} />}
                  data-testid="dapp-confirm"
                  disabled={!!review.plan.shortfall || !!review.plan.capRefusal}
                  onClick={() => void confirmSend()}
                >
                  Confirm &amp; Send
                </Button>
              ) : (
                <Button block loading={working} data-testid="dapp-approve" disabled={!wallet || !txTo} onClick={() => void reviewSend()}>
                  Review
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    </div>,
  );
}
