// EVM branch of the send UI (phase 3). Mirrors LiveSend's layout, testids and
// arming discipline, but this screen never builds a transaction, never
// computes a fee and never converts an amount through a float: it hands text
// to `quoteEvmSend` and only ever displays the plan the store hands back.
//
// One account spans every EVM chain (the EVM engine design notes §1), so "send
// 0.1 ETH" alone is ambiguous: the chain is named on the header and on the
// review step.
//
// This file intentionally imports NOTHING at runtime from
// `src/services/chain/evm/*` (the build-flag-guarded directory, see
// the EVM rollout plan, "trunk with a build flag"). Everything it needs
// (the chain registry mirror, the fee quote, the plan) already crossed into
// plain data via the store, so a fee-level string is typed locally instead of
// importing `EvmFeeLevel`, and the tiny "max fee per gas / gas price" label
// choice is reproduced inline instead of importing `feeSummary`.

import { useEffect, useMemo, useState } from 'react';
import { UntrustedTokenBanner } from '../../components/UntrustedTokenBadge';
import { RecipientRiskBanners } from '../../components/RecipientRiskBanners';
import { ChevronLeft, AlertTriangle, CheckCircle, Wallet } from 'lucide-react';
import { Button } from '../../components/Button';
import { TextField, PasswordField } from '../../components/TextField';
import { useLiveStore, activeEvmChain, walletsOnChain } from '../../store/liveStore';
import { assessRecipient } from '../../services/recipientRisk';
import { formatAmount } from '../../services/chain/amounts';
import { displaySymbol } from '../../services/displaySymbol';
import { shortAccountAddress, filterAccountsForChain } from './walletGroups';
import { LiveNav } from './LiveNav';

interface LiveSendEvmProps {
  onBack(): void;
  onDone(): void;
  /** The row the user tapped on Home: the chain's native ticker, or a token
   *  SYMBOL. Absent means the native coin. */
  asset?: string;
}

/** Mirrors `EvmFeeLevel` (services/chain/evm/fees.ts) as a plain literal type
 *  so this screen names no import from the flag-guarded evm/ directory; the
 *  store's own actions accept these exact strings. */
type FeeLevel = 'slow' | 'normal' | 'fast';
/** Up to this many own wallets are offered as chips; more become a dropdown. */
const MY_WALLETS_CHIPS_MAX = 4;

const FEE_LEVELS: readonly FeeLevel[] = ['slow', 'normal', 'fast'];
const FEE_LEVEL_LABEL: Record<FeeLevel, string> = { slow: 'Slow', normal: 'Normal', fast: 'Fast' };

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** How long after the last keystroke the contract check asks the node. The
 *  first two warnings are answered from state and update on every character;
 *  this one costs an eth_getCode, so it waits until the typing stops. */
const CONTRACT_CHECK_DEBOUNCE_MS = 400;

/** The three recipient warnings as one value, so the form can hand the review
 *  exactly what it showed (see `reviewRisk`). */
interface RecipientRiskSnapshot {
  /** The recipient these warnings were computed for, so a snapshot can never
   *  be shown next to a different plan's address. */
  to: string;
  firstTime: boolean;
  lookalikeOf: string | null;
  isContract: boolean;
}

export function LiveSendEvm({ onBack, onDone, asset }: LiveSendEvmProps) {
  const evm = useLiveStore((s) => s.evm);
  const evmSend = useLiveStore((s) => s.evmSend);
  const loadingEvmSend = useLiveStore((s) => s.loadingEvmSend);
  const storeError = useLiveStore((s) => s.error);
  const assets = useLiveStore((s) => s.assets);
  const evmTokens = useLiveStore((s) => s.evmTokens);
  const wallets = useLiveStore((s) => s.wallets);
  const activeWalletId = useLiveStore((s) => s.activeWalletId);
  const addressBook = useLiveStore((s) => s.addressBook);
  const evmAccountsOnChain = useLiveStore((s) => s.evmAccountsOnChain);
  const txs = useLiveStore((s) => s.txs);
  const myAddress = useLiveStore((s) => s.address);
  const myAddresses = useLiveStore((s) => s.addresses);
  const isEvmContractAddress = useLiveStore((s) => s.isEvmContractAddress);
  const requirePasswordToSend = useLiveStore((s) => s.requirePasswordToSend);
  const verifyPassword = useLiveStore((s) => s.verifyPassword);
  const arm = useLiveStore((s) => s.arm);
  const quoteEvmSend = useLiveStore((s) => s.quoteEvmSend);
  const selectEvmFeeLevel = useLiveStore((s) => s.selectEvmFeeLevel);
  const estimateEvmMax = useLiveStore((s) => s.estimateEvmMax);
  const confirmEvmSend = useLiveStore((s) => s.confirmEvmSend);
  const clearEvmSend = useLiveStore((s) => s.clearEvmSend);

  // --- form state --------------------------------------------------------
  const [to, setTo] = useState('');
  const [amountText, setAmountText] = useState('');
  const [level, setLevel] = useState<FeeLevel>('normal');
  const [fieldError, setFieldError] = useState('');
  const [maxLoading, setMaxLoading] = useState(false);
  /** Last answer of the debounced eth_getCode look-up for the typed recipient.
   *  Only ever true on a definitive "there is code here"; unknown reads as
   *  false, because an unanswerable question is not a warning. */
  const [recipientIsContract, setRecipientIsContract] = useState(false);
  /** The warnings as they stood when the plan was built. Snapshotted rather
   *  than recomputed on the review step: the review must show the user exactly
   *  what they were shown before they pressed Review. */
  const [reviewRisk, setReviewRisk] = useState<RecipientRiskSnapshot | null>(null);

  // --- confirm state -------------------------------------------------------
  const [armed, setArmed] = useState(false);
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState('');
  const [successResult, setSuccessResult] = useState<{ txid: string; explorerUrl: string } | null>(null);

  // The plan under review is store state, never local: leaving without an
  // explicit clear (e.g. navigating away) must not leave a stale plan armed.
  useEffect(() => {
    return () => {
      clearEvmSend();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const chain = activeEvmChain({ evm });

  // A passwordless wallet has no password to confirm.
  const activeWallet = wallets.find((w) => w.id === activeWalletId);
  // See LiveSend: `noSendPassword` carries the "do not ask when sending" half of
  // the old `passwordless` flag once a wallet moves to the app password (§6).
  const isPasswordless = (activeWallet?.passwordless ?? false) || (activeWallet?.noSendPassword ?? false);
  const requirePassword = requirePasswordToSend && !isPasswordless;

  // --- recipient risk ------------------------------------------------------
  // Answered live from state the wallet already holds, on every keystroke, as
  // soon as the field holds a well-formed address. None of it blocks the send.
  const trimmedTo = to.trim();
  const recipientValid = EVM_ADDRESS_RE.test(trimmedTo);
  const chainKey = chain?.key ?? null;

  const risk = useMemo(() => {
    if (!recipientValid) return { firstTime: false, lookalikeOf: null };
    // "Mine" is chain-scoped exactly like the My-wallets picker below: one EVM
    // account is on every EVM chain, so walletsOnChain returns every EVM
    // account here, and never a UTXO wallet whose address could not be a
    // recipient in the first place.
    const mine = [
      myAddress,
      ...myAddresses.map((a) => a.address),
      ...(chainKey ? walletsOnChain(wallets, `evm:${chainKey}`).map((w) => w.address) : []),
    ];
    return assessRecipient(trimmedTo, {
      mine,
      // Address-book entries carry no chain tag; only 0x ones can be compared
      // against an EVM recipient at all.
      contacts: addressBook.map((c) => c.address).filter((a) => EVM_ADDRESS_RE.test(a)),
      history: txs.map((t) => t.counterparty),
      caseInsensitive: true,
    });
  }, [recipientValid, trimmedTo, myAddress, myAddresses, wallets, chainKey, addressBook, txs]);

  // The contract check is the only one that costs a round trip, so it waits
  // for the typing to stop and the store caches the answer per chain+address.
  useEffect(() => {
    if (!recipientValid) {
      setRecipientIsContract(false);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void isEvmContractAddress(trimmedTo)
        .then((answer) => {
          if (!cancelled) setRecipientIsContract(answer === true);
        })
        .catch(() => {
          if (!cancelled) setRecipientIsContract(false);
        });
    }, CONTRACT_CHECK_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [recipientValid, trimmedTo, chainKey, isEvmContractAddress]);

  const handleDone = () => {
    onDone();
  };

  // --- success step ----------------------------------------------------------
  if (successResult) {
    return (
      <div className="app-frame screen-enter">
        <div className="sub-header">
          <button type="button" className="icon-btn" onClick={handleDone} aria-label="Back">
            <ChevronLeft size={20} />
          </button>
          <h2>Sent</h2>
          <span />
        </div>
        <div className="app-content">
          <div className="result-screen">
            <div className="result-icon success">
              <CheckCircle size={32} />
            </div>
            <h3>Broadcast successful</h3>
            <p>Your transaction has been submitted{chain ? ` to ${chain.displayName}` : ''}.</p>
            <div
              className="card"
              style={{ marginTop: 16, width: '100%', textAlign: 'left' }}
              data-testid="live-review-txid"
            >
              <div className="section-label" style={{ marginTop: 0 }}>Transaction hash</div>
              <span className="mono" style={{ fontSize: 11, wordBreak: 'break-all', color: 'var(--text-dim)' }}>
                {successResult.txid}
              </span>
            </div>
            <a
              href={successResult.explorerUrl}
              target="_blank"
              rel="noreferrer"
              className="btn btn-secondary btn-sm"
              data-testid="live-explorer-link"
              style={{ marginTop: 12 }}
            >
              Open in explorer
            </a>
            <Button block onClick={handleDone} style={{ marginTop: 12 }}>
              Done
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // --- review step (evmSend is the plan under review) -------------------------
  if (evmSend && chain) {
    const plan = evmSend;
    const quote = plan.quote;
    // DISPLAY only, and every use of it below is drawn text: a token symbol is
    // a string the token's author chose, and this is the last screen before
    // real money moves, so it must not be able to write in the wallet's voice.
    const amountUnit = displaySymbol(plan.asset.kind === 'native' ? plan.asset.ticker : plan.asset.symbol);
    // Inline equivalent of feeSummary(quote): see the file header for why this
    // is not imported from evm/fees.ts.
    const perGas = quote.fee.type === 'eip1559' ? quote.fee.maxFeePerGas : quote.fee.gasPrice;
    const perGasLabel = quote.fee.type === 'eip1559' ? 'max fee per gas' : 'gas price';
    const sendDisabled = !armed || !!plan.shortfall || !!plan.capRefusal;

    const handleArmToggle = (val: boolean) => {
      setArmed(val);
      arm(val);
    };

    const handleBackFromReview = () => {
      clearEvmSend();
      arm(false);
      setArmed(false);
      setPassword('');
      setPasswordError('');
      setConfirmError('');
    };

    const handleConfirm = async () => {
      setConfirmError('');
      setPasswordError('');
      arm(true);
      if (requirePassword) {
        const ok = await verifyPassword(password);
        if (!ok) {
          setPasswordError('Incorrect password');
          arm(false);
          return;
        }
      }
      setConfirming(true);
      try {
        const result = await confirmEvmSend();
        setSuccessResult({ txid: result.txid, explorerUrl: result.explorerUrl });
        arm(false);
      } catch (err) {
        setConfirmError(err instanceof Error ? err.message : String(err));
        arm(false);
      } finally {
        setConfirming(false);
      }
    };

    return (
      <div className="app-frame screen-enter">
        <div className="sub-header">
          <button type="button" className="icon-btn" onClick={handleBackFromReview} aria-label="Back">
            <ChevronLeft size={20} />
          </button>
          <h2>Review send</h2>
          <span />
        </div>
        <div className="app-content" data-testid="live-send-review">
          {plan.asset.kind === 'token' && <UntrustedTokenBanner symbol={plan.asset.symbol} />}
          {/* The same recipient warnings the form showed, repeated here: this
              is the last screen before the transaction is real. */}
          {reviewRisk && reviewRisk.to.toLowerCase() === plan.to.toLowerCase() && (
            <RecipientRiskBanners
              firstTime={reviewRisk.firstTime}
              lookalikeOf={reviewRisk.lookalikeOf ? shortAccountAddress(reviewRisk.lookalikeOf) : null}
              isContract={reviewRisk.isContract}
            />
          )}
          <div className="banner warning" style={{ marginBottom: 14 }}>
            <AlertTriangle size={14} />
            This broadcasts a real {amountUnit} transaction on {chain.displayName}. Sends cannot be undone.
          </div>

          <div className="card solid" style={{ marginBottom: 14 }}>
            <div className="summary-table">
              <div className="sum-row">
                <span className="sum-key">To</span>
                <span className="sum-val mono" style={{ fontSize: 11, wordBreak: 'break-all' }}>{plan.to}</span>
              </div>
              <div className="sum-row">
                <span className="sum-key">Amount</span>
                <span className="sum-val">
                  {formatAmount(plan.amountBase, plan.asset.decimals)} {amountUnit}
                </span>
              </div>
              <div className="sum-row">
                <span className="sum-key">Network</span>
                <span className="sum-val">{chain.displayName}</span>
              </div>
              <div className="sum-row" data-testid="live-review-fee">
                <span className="sum-key">Estimated fee</span>
                <span className="sum-val">
                  {formatAmount(quote.estimatedTotal, chain.nativeDecimals)} {chain.nativeTicker}
                </span>
              </div>
              <div className="sum-row">
                <span className="sum-key">Maximum fee</span>
                <span className="sum-val">
                  {formatAmount(quote.maxTotal, chain.nativeDecimals)} {chain.nativeTicker}
                </span>
              </div>
              {chain.l1DataFee && (
                <div className="sum-row" data-testid="live-review-l1-fee">
                  <span className="sum-key">Includes L1 data fee</span>
                  <span className="sum-val">
                    {formatAmount(quote.l1DataFee, chain.nativeDecimals)} {chain.nativeTicker}
                  </span>
                </div>
              )}
              <div className="sum-row">
                <span className="sum-key text-dim" style={{ fontSize: 11 }}>{perGasLabel}</span>
                <span className="sum-val text-dim" style={{ fontSize: 11 }}>{formatAmount(perGas, 9)} gwei</span>
              </div>
              <div className="sum-row">
                <span className="sum-key text-dim" style={{ fontSize: 11 }}>Gas limit</span>
                <span className="sum-val text-dim" style={{ fontSize: 11 }}>{quote.gasLimit.toString()}</span>
              </div>
            </div>
          </div>

          <div className="section-label">Speed</div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
            {FEE_LEVELS.map((lvl) => {
              const isPicked = plan.level === lvl;
              return (
                <button
                  key={lvl}
                  type="button"
                  className={isPicked ? 'chip' : 'chip neutral'}
                  data-testid={`live-fee-option-${lvl}`}
                  aria-pressed={isPicked}
                  onClick={() => { void selectEvmFeeLevel(lvl); }}
                  style={{ flex: 1, justifyContent: 'center', cursor: 'pointer' }}
                >
                  {FEE_LEVEL_LABEL[lvl]}
                </button>
              );
            })}
          </div>

          {plan.shortfall && (
            <div className="banner danger" style={{ marginBottom: 14 }} data-testid="live-send-shortfall">
              <AlertTriangle size={14} />
              {plan.shortfall}
            </div>
          )}
          {plan.capRefusal && (
            <div className="banner danger" style={{ marginBottom: 14 }} data-testid="live-send-cap-refusal">
              <AlertTriangle size={14} />
              {plan.capRefusal}
            </div>
          )}

          <div className="section-label">Confirm &amp; Send</div>
          <div className="card" style={{ marginBottom: 14 }}>
            <div
              role="checkbox"
              aria-checked={armed}
              tabIndex={0}
              data-testid="live-arm-checkbox"
              onClick={() => handleArmToggle(!armed)}
              onKeyDown={(e) => {
                if (e.key === ' ' || e.key === 'Enter') {
                  e.preventDefault();
                  handleArmToggle(!armed);
                }
              }}
              style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer' }}
            >
              <div
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: 5,
                  border: `2px solid ${armed ? 'var(--danger)' : 'var(--border-strong)'}`,
                  background: armed ? 'var(--danger-bg)' : 'transparent',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                  marginTop: 1,
                  transition: 'all 0.15s',
                }}
              >
                {armed && <span style={{ color: 'var(--danger)', fontSize: 11, fontWeight: 700 }}>✓</span>}
              </div>
              <span style={{ fontSize: 12, lineHeight: 1.5 }}>
                I understand this sends real {amountUnit} and cannot be undone.
              </span>
            </div>
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
                testId="live-send-password"
              />
              {passwordError && (
                <span
                  role="alert"
                  data-testid="live-send-password-error"
                  style={{ fontSize: 11.5, color: 'var(--danger)', display: 'block', marginTop: 4 }}
                >
                  {passwordError}
                </span>
              )}
            </div>
          )}

          {confirmError && (
            <div className="banner danger" style={{ marginBottom: 14 }} data-testid="live-send-error">
              {confirmError}
            </div>
          )}

          <div style={{ display: 'flex', gap: 9 }}>
            <Button variant="secondary" onClick={handleBackFromReview} data-testid="live-send-review-back">Back</Button>
            <Button
              block
              variant="danger"
              disabled={sendDisabled}
              loading={confirming}
              onClick={() => { void handleConfirm(); }}
              data-testid="live-broadcast"
            >
              Confirm &amp; Send
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // --- no EVM chain available (build without the engine, or nothing active) --
  if (!chain) {
    return (
      <div className="app-frame screen-enter">
        <div className="sub-header">
          <button type="button" className="icon-btn" onClick={onBack} aria-label="Back">
            <ChevronLeft size={20} />
          </button>
          <h2>Send</h2>
          <span />
        </div>
        <div className="app-content">
          <div className="banner danger" data-testid="live-send-error">
            This build has no EVM chain available.
          </div>
        </div>
        <LiveNav />
      </div>
    );
  }

  // --- form step ---------------------------------------------------------
  // Asset resolution: absent / the chain's native ticker => native; otherwise a
  // token SYMBOL, resolved against the chain's default tokens by its CONTRACT
  // address (the store identifies tokens by contract, never by symbol).
  const assetUpper = asset?.toUpperCase();
  const isNativeAsset = !assetUpper || assetUpper === chain.nativeTicker.toUpperCase();
  // The universe of tokens this account can send: the chain's defaults plus
  // everything the user added, imported or the wallet discovered (all keyed by
  // contract; the symbol only picks the row the user tapped).
  const knownTokens = [...chain.defaultTokens, ...evmTokens.tracked, ...evmTokens.discovered];
  const token = !isNativeAsset && assetUpper
    ? knownTokens.find((t) => t.symbol?.toUpperCase() === assetUpper) ?? null
    : null;
  const unknownAsset = !isNativeAsset && !token;
  const assetId: string | null = isNativeAsset ? chain.nativeTicker : token ? token.address : null;
  const assetSymbol = isNativeAsset ? chain.nativeTicker : (token?.symbol ?? assetUpper ?? '');
  // `assetSymbol` is the IDENTITY (it matches a balance row and keys the trust
  // registry); `shownSymbol` is the same thing made safe to draw.
  const shownSymbol = displaySymbol(assetSymbol);

  const balanceRow = isNativeAsset
    ? assets.find((a) => a.isNative)
    : assets.find((a) => !a.isNative && a.name === assetSymbol);
  const availableBase = balanceRow?.amountBase ?? 0n;
  const availableDecimals = isNativeAsset ? chain.nativeDecimals : (balanceRow?.decimals ?? token?.decimals ?? 18);

  // Only EVM accounts, scoped to THIS chain (one EVM account is "on" every EVM
  // chain (see walletsOnChain), never a UTXO wallet.
  const myWallets = filterAccountsForChain(walletsOnChain(wallets, `evm:${chain.key}`), evmAccountsOnChain, activeWalletId).filter(
    (w) => w.id !== activeWalletId && w.address,
  );
  const contacts = addressBook.filter((c) => EVM_ADDRESS_RE.test(c.address));

  const fillPct = (pct: number) => {
    const value = (availableBase * BigInt(pct)) / 100n;
    setAmountText(value > 0n ? formatAmount(value, availableDecimals) : '0');
  };

  const fillMax = async () => {
    if (!isNativeAsset) {
      setAmountText(availableBase > 0n ? formatAmount(availableBase, availableDecimals) : '0');
      return;
    }
    setMaxLoading(true);
    try {
      const { maxText } = await estimateEvmMax(level, to.trim());
      setAmountText(maxText);
    } finally {
      setMaxLoading(false);
    }
  };

  const handleReview = async (e: React.FormEvent) => {
    e.preventDefault();
    setFieldError('');
    if (unknownAsset || !assetId) return;
    if (!trimmedTo) {
      setFieldError('Recipient address is required.');
      return;
    }
    if (!EVM_ADDRESS_RE.test(trimmedTo)) {
      setFieldError('Enter a valid EVM address: 0x followed by 40 hex characters.');
      return;
    }
    if (!amountText.trim()) {
      setFieldError('Enter an amount.');
      return;
    }
    // Snapshot the warnings before leaving the form: the review repeats these,
    // it never re-derives them.
    setReviewRisk({ to: trimmedTo, firstTime: risk.firstTime, lookalikeOf: risk.lookalikeOf, isContract: recipientIsContract });
    await quoteEvmSend({ to: trimmedTo, amountText: amountText.trim(), assetId, level });
  };

  return (
    <div className="app-frame screen-enter">
      <div className="sub-header">
        <button type="button" className="icon-btn" onClick={onBack} aria-label="Back">
          <ChevronLeft size={20} />
        </button>
        <h2>Send {shownSymbol} on {chain.displayName}</h2>
        <span />
      </div>
      <div className="app-content send-pinned">
        <form onSubmit={(e) => { void handleReview(e); }}>
          <div className="send-scroll">
            {!isNativeAsset && <UntrustedTokenBanner symbol={assetSymbol} />}
            <RecipientRiskBanners
              firstTime={risk.firstTime}
              lookalikeOf={risk.lookalikeOf ? shortAccountAddress(risk.lookalikeOf) : null}
              isContract={recipientIsContract}
            />
            <TextField
              label="Recipient address"
              placeholder="0x..."
              value={to}
              onChange={(e) => setTo(e.target.value)}
              testId="live-send-to"
            />

            {/* Past a handful of accounts the chip grid would eat the screen (a
                seed can carry 20 accounts): a dropdown then, chips for 1 to 4. */}
            {myWallets.length > MY_WALLETS_CHIPS_MAX && (
              <div data-testid="live-send-my-wallets" style={{ margin: '10px 0 12px' }}>
                <select
                  data-testid="live-send-my-wallets-select"
                  className="live-picker"
                  value={myWallets.find((w) => w.address.toLowerCase() === to.trim().toLowerCase())?.address ?? ''}
                  onChange={(e) => { if (e.target.value) setTo(e.target.value); }}
                  aria-label="Send to one of my accounts"
                  style={{ width: '100%' }}
                >
                  <option value="">Send to one of my accounts ({myWallets.length})…</option>
                  {myWallets.map((w) => (
                    <option key={w.id} value={w.address}>
                      {w.name} · {w.address.slice(0, 6)}…{w.address.slice(-4)}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {myWallets.length > 0 && myWallets.length <= MY_WALLETS_CHIPS_MAX && (
              <div data-testid="live-send-my-wallets" style={{ margin: '10px 0 12px' }}>
                <div className="section-label" style={{ marginTop: 0, marginBottom: 6 }}>My wallets</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {myWallets.map((w, i) => (
                    <button
                      key={w.id}
                      type="button"
                      className="chip"
                      onClick={() => setTo(w.address)}
                      aria-label={`Send to my wallet ${w.name}`}
                      title={`${w.name}: ${w.address}`}
                      data-testid={`live-send-wallet-${i}`}
                      style={{ cursor: 'pointer' }}
                    >
                      <Wallet size={11} style={{ flexShrink: 0 }} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {contacts.length > 0 && (
              <div style={{ display: 'flex', gap: 8, margin: '2px 0 12px', flexWrap: 'wrap' }}>
                <select
                  data-testid="live-send-contacts"
                  className="live-picker"
                  value=""
                  onChange={(e) => { if (e.target.value) setTo(e.target.value); }}
                  aria-label="From address book"
                  style={{ flex: 1, minWidth: 128 }}
                >
                  <option value="">From address book…</option>
                  {contacts.map((c) => (
                    <option key={c.address} value={c.address}>
                      {c.label} · {c.address.slice(0, 10)}…
                    </option>
                  ))}
                </select>
              </div>
            )}

            <TextField
              label={`Amount (${shownSymbol})`}
              placeholder="0.00"
              value={amountText}
              onChange={(e) => setAmountText(e.target.value)}
              testId="live-send-amount"
              error={
                fieldError ||
                (unknownAsset ? `Unknown asset on ${chain.displayName}: ${displaySymbol(asset ?? '')}` : undefined)
              }
            />

            <div
              className="text-dim"
              data-testid="live-send-available"
              style={{ fontSize: 11.5, margin: '6px 2px 8px' }}
            >
              Available: {formatAmount(availableBase, availableDecimals, { grouping: true })} {shownSymbol}
            </div>

            <div style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
              {[25, 50, 75].map((pct) => (
                <button
                  key={pct}
                  type="button"
                  className="chip neutral"
                  data-testid={`live-amt-${pct}`}
                  onClick={() => fillPct(pct)}
                  style={{ flex: 1, justifyContent: 'center', cursor: 'pointer' }}
                >
                  {pct}%
                </button>
              ))}
              <button
                type="button"
                className="chip neutral"
                data-testid="live-amt-max"
                onClick={() => { void fillMax(); }}
                disabled={maxLoading}
                aria-busy={maxLoading}
                style={{ flex: 1, justifyContent: 'center', cursor: 'pointer' }}
              >
                {maxLoading ? '…' : 'Max'}
              </button>
            </div>
            {isNativeAsset && (
              <p className="text-faint" style={{ fontSize: 10, margin: '0 2px 10px' }}>
                Max leaves the maximum fee aside, plus a small margin for the fee market moving before you confirm.
              </p>
            )}

            <div className="section-label">Network fee</div>
            <div className="card" data-testid="live-fee-section" style={{ marginBottom: 10, padding: 12 }}>
              <div style={{ display: 'flex', gap: 6 }}>
                {FEE_LEVELS.map((lvl) => {
                  const isPicked = level === lvl;
                  return (
                    <button
                      key={lvl}
                      type="button"
                      className={isPicked ? 'chip' : 'chip neutral'}
                      data-testid={`live-fee-option-${lvl}`}
                      aria-pressed={isPicked}
                      onClick={() => setLevel(lvl)}
                      style={{ flex: 1, justifyContent: 'center', cursor: 'pointer' }}
                    >
                      {FEE_LEVEL_LABEL[lvl]}
                    </button>
                  );
                })}
              </div>
              <p className="text-dim" style={{ fontSize: 11, margin: '8px 0 0', lineHeight: 1.5 }}>
                Network fee: paid in {chain.nativeTicker}, shown exactly on the next screen.
              </p>
            </div>
          </div>

          <div className="send-cta">
            {storeError && (
              <div className="banner danger" data-testid="live-send-error" style={{ marginBottom: 10 }}>
                {storeError}
              </div>
            )}
            <Button type="submit" block loading={loadingEvmSend} disabled={unknownAsset}>
              Review transaction
            </Button>
          </div>
        </form>
      </div>
      <LiveNav />
    </div>
  );
}
