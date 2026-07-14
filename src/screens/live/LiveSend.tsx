import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, AlertTriangle, CheckCircle, BookUser, Wallet } from 'lucide-react';
import { Button } from '../../components/Button';
import { TextField, PasswordField } from '../../components/TextField';
import { TokenIcon } from '../../components/BrandLogo';
import { useLiveStore, computeDisplayedAssets } from '../../store/liveStore';
import { isValidAddress, isP2pkhAddress } from '../../services/chain/keys';
import { EVRMORE_MAINNET } from '../../services/chain/chainParams';
import { isLegacyAsset } from '../../services/assetNotes';
import type { LiveSendPlan } from '../../services/chain/liveWallet';
import { LiveNav } from './LiveNav';

interface LiveSendProps {
  onBack(): void;
  /** Return to the live HOME after a successful send (falls back to onBack). */
  onDone?(): void;
  /** Asset being sent — the native coin when absent or 'EVR'. */
  asset?: string;
}

/** How long the success screen lingers before auto-returning home. */
const SUCCESS_AUTO_RETURN_MS = 4_000;

type SendStep = 'form' | 'review' | 'success';

function fmtSats(sats: bigint): string {
  const val = Number(sats) / 1e8;
  return val.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 8 });
}

function fmtShort(txid: string): string {
  return `${txid.slice(0, 8)}...${txid.slice(-8)}`;
}

/** Floor a whole-unit value to `decimals` (max 8) places so a % / balance chip
 *  can never fill an amount that exceeds the actual balance. */
function floorToDecimals(value: number, decimals: number): number {
  const f = 10 ** Math.min(Math.max(decimals, 0), 8);
  return Math.floor(value * f) / f;
}

/** Format a whole-unit amount with up to `decimals` (max 8) dp, trailing zeros
 *  (and a bare trailing dot) trimmed. Used for the "Available" line + chip fills. */
function fmtBalance(amount: number, decimals: number): string {
  const dp = Math.min(Math.max(decimals, 0), 8);
  const s = amount.toFixed(dp);
  return dp === 0 ? s : s.replace(/\.?0+$/, '');
}

/** Turn a raw build/broadcast error code into a clear, human message. */
function friendlyError(msg: string, assetId: string): string {
  switch (msg) {
    case 'insufficient-asset':
      return `Insufficient ${assetId} balance for this transfer.`;
    case 'insufficient-evr-for-fee':
      return 'Not enough EVR to cover the network fee for this asset transfer.';
    case 'invalid-amount-precision':
      return `That amount is finer than ${assetId} allows. Reduce the number of decimals.`;
    case 'unknown-asset':
      return `Asset "${assetId}" was not found on the EVRmore network.`;
    case 'invalid-amount':
      return 'Enter a valid amount greater than 0.';
    case 'insufficient-funds':
      return 'Insufficient EVR balance for this transaction (amount + network fee).';
    case 'unsupported-address-type':
      return 'That is not a standard EVRmore address (only addresses starting with E are supported; P2SH / wrong-network addresses are rejected).';
    case 'input-verify-failed':
    case 'input-value-mismatch':
      return 'Could not verify your coins against the network (the server may be faulty or malicious). Nothing was sent. Try another Electrum server in Settings.';
    default:
      return msg;
  }
}

export function LiveSend({ onBack, onDone, asset }: LiveSendProps) {
  const buildSend = useLiveStore((s) => s.buildSend);
  const clearSendPlan = useLiveStore((s) => s.clearSendPlan);
  const arm = useLiveStore((s) => s.arm);
  const broadcast = useLiveStore((s) => s.broadcast);
  const refresh = useLiveStore((s) => s.refresh);
  const verifyPassword = useLiveStore((s) => s.verifyPassword);
  const requirePasswordToSend = useLiveStore((s) => s.requirePasswordToSend);
  const storeError = useLiveStore((s) => s.error);
  const loadingSend = useLiveStore((s) => s.loadingSend);
  const wallets = useLiveStore((s) => s.wallets);
  const activeWalletId = useLiveStore((s) => s.activeWalletId);
  const addressBook = useLiveStore((s) => s.addressBook);
  const addContact = useLiveStore((s) => s.addContact);
  const assets = useLiveStore((s) => s.assets);
  const pinnedAssets = useLiveStore((s) => s.pinnedAssets);
  const hiddenAssets = useLiveStore((s) => s.hiddenAssets);
  const estimateMaxEvr = useLiveStore((s) => s.estimateMaxEvr);

  // Resolve which asset we're sending. Absent / 'EVR' => native coin.
  const assetId = asset && asset.toUpperCase() !== 'EVR' ? asset.toUpperCase() : 'EVR';
  const isAsset = assetId !== 'EVR';

  // Displayed (spendable) balance for the selected asset — the same list the
  // home screen shows. EVR is always present; an asset falls back to a raw
  // balance lookup (or 0) if it isn't in the displayed set.
  const displayedAssets = computeDisplayedAssets(assets, pinnedAssets, hiddenAssets);
  const balanceRow =
    displayedAssets.find((a) => a.name === assetId) ?? assets.find((a) => a.name === assetId);
  const availableBalance = balanceRow?.amount ?? 0;
  const assetDecimals = balanceRow?.decimals ?? 8;

  // Every asset transfer pays its network fee exclusively from EVR UTXOs
  // (LiveWalletService.buildAssetSend -> 'insufficient-evr-for-fee'). With 0 EVR,
  // no asset can ever be sent, no matter the asset amount. Detect that up front
  // (same `assets` list the rest of the screen reads EVR from) and block the
  // send before the user hits the build-time error. Nonzero-but-insufficient EVR
  // still flows to the existing build-time error, since the exact fee isn't
  // known until build.
  const evrBalance = assets.find((a) => a.isNative || a.name === 'EVR')?.amount ?? 0;
  const noEvrForGas = isAsset && evrBalance === 0;

  // A passwordless wallet has no password to confirm — skip the whole password
  // step (no `live-send-password` field). Otherwise honour the user setting.
  const activeWallet = wallets.find((w) => w.id === activeWalletId);
  const isPasswordless = activeWallet?.passwordless ?? false;
  const requirePassword = requirePasswordToSend && !isPasswordless;

  // Other wallets you own (skip the active one + any with no known address) so
  // funds can be moved between your wallets in one tap.
  const myWallets = wallets.filter((w) => w.id !== activeWalletId && w.address);

  const [step, setStep] = useState<SendStep>('form');
  const [to, setTo] = useState('');
  // Name of the own wallet the recipient was quick-picked from ('' = none).
  const [myWalletPicked, setMyWalletPicked] = useState('');
  const [amount, setAmount] = useState('');
  const [fieldError, setFieldError] = useState('');
  const [plan, setPlan] = useState<LiveSendPlan | null>(null);
  const [armed, setArmed] = useState(false);
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [broadcasting, setBroadcasting] = useState(false);
  const [broadcastError, setBroadcastError] = useState('');
  const [successTxid, setSuccessTxid] = useState('');

  // Quick-amount ("Max") state. For EVR, Max is async (queries UTXOs) and the
  // fee it deducts is shown in the fee note. `typicalFeeEvr` is an optional
  // on-mount estimate of the current fee, shown before Max is used.
  const [maxLoading, setMaxLoading] = useState(false);
  const [maxUsed, setMaxUsed] = useState(false);
  const [maxFeeEvr, setMaxFeeEvr] = useState<number | null>(null);
  const [typicalFeeEvr, setTypicalFeeEvr] = useState<number | null>(null);

  // Save-to-address-book affordance for a freshly-entered recipient.
  const [savingContact, setSavingContact] = useState(false);
  const [contactLabel, setContactLabel] = useState('');
  const [contactError, setContactError] = useState('');
  const [contactSaved, setContactSaved] = useState(false);

  // Leaving the success screen always returns to the live HOME (never a dead
  // end) and kicks a refresh so the new pending tx shows in Activity right away.
  const handleDone = useCallback(() => {
    void refresh({ silent: true });
    (onDone ?? onBack)();
  }, [refresh, onDone, onBack]);

  // Auto-return home ~4s after a successful broadcast if the user does nothing.
  // The timer is cleared on unmount (or if the user leaves the success step).
  // handleDone is read through a ref so parent re-renders (which recreate the
  // onDone/onBack lambdas) can't keep resetting the countdown.
  const doneRef = useRef(handleDone);
  useEffect(() => {
    doneRef.current = handleDone;
  }, [handleDone]);
  useEffect(() => {
    if (step !== 'success') return;
    const timer = setTimeout(() => doneRef.current(), SUCCESS_AUTO_RETURN_MS);
    return () => clearTimeout(timer);
  }, [step]);

  // Non-blocking: fetch the current typical EVR fee once so the fee note can show
  // "~<fee> EVR" before the user taps Max. Errors are swallowed (store already
  // returns 0 on failure); asset sends don't need this (fixed fee note).
  useEffect(() => {
    if (isAsset) return;
    let cancelled = false;
    void estimateMaxEvr()
      .then(({ feeDecimal }) => {
        if (!cancelled) setTypicalFeeEvr(feeDecimal);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isAsset, estimateMaxEvr]);

  const trimmedTo = to.trim();
  const alreadySaved = addressBook.some((c) => c.address === trimmedTo);
  const canSaveContact = isValidAddress(trimmedTo) && !alreadySaved;

  const fillRecipient = (addr: string) => {
    setTo(addr);
    setMyWalletPicked('');
    setContactSaved(false);
    setSavingContact(false);
  };

  // Quick-pick one of your own wallets by NAME: fills the recipient and shows a
  // "→ <name>" confirmation next to the field.
  const pickMyWallet = (addr: string, name: string) => {
    fillRecipient(addr);
    setMyWalletPicked(name);
    setFieldError('');
  };

  const handleSaveContact = () => {
    setContactError('');
    const res = addContact(contactLabel, trimmedTo);
    if (!res.ok) {
      setContactError(res.error);
      return;
    }
    setSavingContact(false);
    setContactLabel('');
    setContactSaved(true);
  };

  // Quick-amount chips (MetaMask-style). Setting `amount` runs the normal
  // build/review path unchanged; typing resets the "Max" fee note.
  const setAmountManual = (val: string) => {
    setAmount(val);
    setMaxUsed(false);
  };

  const fillPct = (pct: number) => {
    const floored = floorToDecimals((pct / 100) * availableBalance, assetDecimals);
    setAmount(floored > 0 ? fmtBalance(floored, assetDecimals) : '0');
    setMaxUsed(false);
  };

  const fillMax = async () => {
    // Assets: send the full balance — the EVR fee is paid separately from EVR.
    if (isAsset) {
      setAmount(availableBalance > 0 ? fmtBalance(availableBalance, assetDecimals) : '0');
      setMaxUsed(false);
      return;
    }
    // EVR: Max = all UTXOs − the fee to spend them, so the tx fits. Async.
    setMaxLoading(true);
    try {
      const { maxDecimal, feeDecimal } = await estimateMaxEvr();
      setAmount(maxDecimal > 0 ? fmtBalance(maxDecimal, 8) : '0');
      if (maxDecimal > 0) {
        setMaxUsed(true);
        setMaxFeeEvr(feeDecimal);
      } else {
        setMaxUsed(false);
      }
    } catch {
      // Tolerant: leave the amount untouched on failure.
    } finally {
      setMaxLoading(false);
    }
  };

  // Network-fee note under the chips.
  const feeNote = isAsset
    ? 'Network fee: paid in EVR (from your EVR balance).'
    : maxUsed && maxFeeEvr != null
    ? `Network fee: ~${fmtBalance(maxFeeEvr, 8)} EVR (deducted from Max)`
    : typicalFeeEvr != null && typicalFeeEvr > 0
    ? `Network fee: ~${fmtBalance(typicalFeeEvr, 8)} EVR (deducted from your EVR balance at review).`
    : 'Network fee: deducted from your EVR balance at review.';

  // The store keeps raw error codes; map them for display on this screen.
  const mappedStoreError = storeError ? friendlyError(storeError, assetId) : null;

  const handleBuild = async (e: React.FormEvent) => {
    e.preventDefault();
    setFieldError('');

    if (!to.trim()) {
      setFieldError('Recipient address is required.');
      return;
    }
    if (!isValidAddress(to.trim())) {
      setFieldError('Invalid EVRmore address.');
      return;
    }
    // Only standard P2PKH recipients are spendable — the builder emits P2PKH
    // outputs, so a P2SH ('e…') / wrong-network address would burn the funds.
    if (!isP2pkhAddress(to.trim(), EVRMORE_MAINNET)) {
      setFieldError('Only standard EVRmore addresses (starting with E) are supported. P2SH / wrong-network addresses are rejected.');
      return;
    }
    const amountNum = parseFloat(amount);
    if (!amount || isNaN(amountNum) || amountNum <= 0) {
      setFieldError('Enter a valid amount greater than 0.');
      return;
    }

    const result = await buildSend(to.trim(), amountNum, assetId);
    if (result) {
      setPlan(result);
      setStep('review');
    }
  };

  const handleBack = () => {
    if (step === 'review') {
      clearSendPlan();
      setPlan(null);
      setArmed(false);
      setPassword('');
      setPasswordError('');
      setBroadcastError('');
      setStep('form');
    } else {
      clearSendPlan();
      onBack();
    }
  };

  const handleArmChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.checked;
    setArmed(val);
    arm(val);
  };

  const handleBroadcast = async () => {
    if (!plan) return;
    setBroadcastError('');
    setPasswordError('');

    // Password gate: when enabled (and the wallet has a password), verify it
    // BEFORE broadcasting. A passwordless wallet skips this entirely.
    if (requirePassword) {
      const ok = await verifyPassword(password);
      if (!ok) {
        setPasswordError('Incorrect password');
        return;
      }
    }

    setBroadcasting(true);
    try {
      const txid = await broadcast(plan.built.rawHex);
      setSuccessTxid(txid);
      setStep('success');
      clearSendPlan();
    } catch (err) {
      setBroadcastError(err instanceof Error ? err.message : String(err));
    } finally {
      setBroadcasting(false);
      arm(false);
      setArmed(false);
    }
  };

  const displayFormError = fieldError || (step === 'form' ? mappedStoreError : null);
  // The unit shown on the review's amount row (asset name for asset sends).
  const amountUnit = plan?.assetName ?? 'EVR';

  if (step === 'success') {
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
            <p>Your transaction has been submitted to the EVRmore network.</p>
            <div
              className="card"
              style={{ marginTop: 16, width: '100%', textAlign: 'left' }}
              data-testid="live-review-txid"
            >
              <div className="section-label" style={{ marginTop: 0 }}>Transaction ID</div>
              <span className="mono" style={{ fontSize: 11, wordBreak: 'break-all', color: 'var(--text-dim)' }}>
                {successTxid}
              </span>
            </div>
            <Button block onClick={handleDone} style={{ marginTop: 20 }}>
              Done
            </Button>
            <p className="text-faint" style={{ fontSize: 10.5, marginTop: 10 }}>
              Returning to your wallet in a few seconds…
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (step === 'review' && plan) {
    return (
      <div className="app-frame screen-enter">
        <div className="sub-header">
          <button type="button" className="icon-btn" onClick={handleBack} aria-label="Back">
            <ChevronLeft size={20} />
          </button>
          <h2>Review send</h2>
          <span />
        </div>
        <div className="app-content" data-testid="live-send-review">
          <div className="banner warning" style={{ marginBottom: 14 }}>
            <AlertTriangle size={14} />
            This broadcasts a real {amountUnit} transaction to the EVRmore network. Sends cannot be undone.
          </div>

          <div className="card solid" style={{ marginBottom: 14 }}>
            <div className="summary-table">
              <div className="sum-row">
                <span className="sum-key">To</span>
                <span className="sum-val mono" style={{ fontSize: 11 }}>{plan.toAddress}</span>
              </div>
              <div className="sum-row">
                <span className="sum-key">Amount</span>
                <span className="sum-val">{fmtSats(plan.amountSats)} {amountUnit}</span>
              </div>
              <div className="sum-row" data-testid="live-review-fee">
                <span className="sum-key">Network fee</span>
                <span className="sum-val">{fmtSats(plan.feeSats)} EVR</span>
              </div>
              <div className="sum-row">
                <span className="sum-key">Virtual size</span>
                <span className="sum-val">{plan.built.virtualSize} vbytes</span>
              </div>
              <div className="sum-row" data-testid="live-review-txid">
                <span className="sum-key">Tx ID (preview)</span>
                <span className="sum-val mono" style={{ fontSize: 11 }}>{fmtShort(plan.built.txid)}</span>
              </div>
            </div>
          </div>

          <div className="section-label">Confirm &amp; Send</div>
          <div
            className="card"
            style={{ marginBottom: 14 }}
          >
            <label
              style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer' }}
              data-testid="live-arm-checkbox"
            >
              <input
                type="checkbox"
                checked={armed}
                onChange={handleArmChange}
                style={{ marginTop: 2, flexShrink: 0, accentColor: 'var(--danger)' }}
              />
              <span style={{ fontSize: 12, lineHeight: 1.5 }}>
                I understand this sends real {amountUnit} and cannot be undone.
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
                testId="live-send-password"
              />
              {passwordError && (
                <span
                  role="alert"
                  data-testid="live-send-password-error"
                  style={{ fontSize: 11.5, color: 'var(--danger)', display: 'block', marginTop: -6 }}
                >
                  {passwordError}
                </span>
              )}
            </div>
          )}

          {(broadcastError || mappedStoreError) && (
            <div className="banner danger" style={{ marginBottom: 14 }} data-testid="live-send-error">
              {broadcastError || mappedStoreError}
            </div>
          )}

          <div style={{ display: 'flex', gap: 9 }}>
            <Button variant="secondary" onClick={handleBack}>Back</Button>
            <Button
              block
              variant="danger"
              disabled={!armed}
              loading={broadcasting}
              onClick={handleBroadcast}
              data-testid="live-broadcast"
            >
              Confirm & Send
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // step === 'form'
  return (
    <div className="app-frame screen-enter">
      <div className="sub-header">
        <button type="button" className="icon-btn" onClick={handleBack} aria-label="Back">
          <ChevronLeft size={20} />
        </button>
        <h2>Send {assetId}</h2>
        <span />
      </div>
      <div className="app-content">
        <form onSubmit={handleBuild}>
          <TextField
            label="Recipient address"
            placeholder="EVR address (starts with E)"
            value={to}
            onChange={(e) => { setTo(e.target.value); setMyWalletPicked(''); setContactSaved(false); }}
            testId="live-send-to"
          />
          {myWalletPicked && (
            <div
              data-testid="live-send-wallet-selected"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                fontSize: 11.5,
                fontWeight: 600,
                color: 'var(--success)',
                margin: '-6px 2px 10px',
              }}
            >
              <Wallet size={12} /> → {myWalletPicked}
            </div>
          )}

          {/* Quick-pick your OWN wallets by name: one tap moves funds between them. */}
          {myWallets.length > 0 && (
            <div data-testid="live-send-my-wallets" style={{ margin: '2px 0 12px' }}>
              <div className="section-label" style={{ marginTop: 0, marginBottom: 6 }}>My wallets</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {myWallets.map((w, i) => (
                  <button
                    key={w.id}
                    type="button"
                    className="chip neutral"
                    onClick={() => pickMyWallet(w.address, w.name)}
                    aria-label={`Send to my wallet ${w.name}`}
                    title={`${w.name}: ${w.address}`}
                    data-testid={`live-send-wallet-${i}`}
                    style={{ cursor: 'pointer', maxWidth: '100%' }}
                  >
                    <Wallet size={11} style={{ flexShrink: 0 }} />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {w.name}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Saved contacts from the address book. */}
          {addressBook.length > 0 && (
            <div style={{ display: 'flex', gap: 8, margin: '2px 0 12px', flexWrap: 'wrap' }}>
              <select
                data-testid="live-send-contacts"
                className="live-picker"
                value=""
                onChange={(e) => { if (e.target.value) fillRecipient(e.target.value); }}
                aria-label="From address book"
                style={{ flex: 1, minWidth: 128 }}
              >
                <option value="">From address book…</option>
                {addressBook.map((c) => (
                  <option key={c.address} value={c.address}>
                    {c.label} · {c.address.slice(0, 8)}…
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Save a freshly-entered recipient to the address book. */}
          {canSaveContact && !savingContact && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => { setSavingContact(true); setContactError(''); }}
              data-testid="live-send-save-contact"
              style={{ marginBottom: 12 }}
            >
              <BookUser size={13} /> Save to address book
            </button>
          )}
          {contactSaved && (
            <div className="text-dim" style={{ fontSize: 11.5, margin: '0 2px 12px', display: 'flex', alignItems: 'center', gap: 5 }}>
              <Wallet size={12} /> Saved to address book.
            </div>
          )}
          {savingContact && (
            <div className="card" style={{ marginBottom: 12 }}>
              <TextField
                label="Contact name"
                value={contactLabel}
                onChange={(e) => { setContactLabel(e.target.value); setContactError(''); }}
                placeholder="e.g. Exchange"
                testId="live-send-contact-label"
                autoComplete="off"
                autoFocus
                error={contactError || undefined}
              />
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <Button type="button" variant="secondary" size="sm" onClick={() => setSavingContact(false)}>
                  Cancel
                </Button>
                <Button type="button" size="sm" block onClick={handleSaveContact} data-testid="live-send-contact-save">
                  Save contact
                </Button>
              </div>
            </div>
          )}

          <TextField
            label={`Amount (${assetId})`}
            placeholder="0.00"
            type="number"
            min="0"
            step="any"
            value={amount}
            onChange={(e) => setAmountManual(e.target.value)}
            testId="live-send-amount"
            error={displayFormError ?? undefined}
          />

          {/* Available balance for the selected asset. */}
          <div
            className="text-dim"
            data-testid="live-send-available"
            style={{ fontSize: 11.5, margin: '-4px 2px 8px' }}
          >
            Available: {fmtBalance(availableBalance, assetDecimals)} {assetId}
          </div>

          {/* Quick-amount chips (25 / 50 / 75 / Max), MetaMask-style. */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
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

          {/* Network fee note. */}
          <p
            className="text-dim"
            data-testid="live-send-fee-note"
            style={{ fontSize: 11, margin: '0 2px 14px', lineHeight: 1.5 }}
          >
            {feeNote}
          </p>

          <div className="section-label">Asset</div>
          <div className="token-row" style={{ marginBottom: 6 }}>
            <TokenIcon assetId={assetId} size={30} />
            <span style={{ fontWeight: 700, fontSize: 13, marginLeft: 8 }}>{assetId}</span>
            <span className="text-dim" style={{ fontSize: 11.5, flex: 1, marginLeft: 8 }}>
              {isAsset ? 'EVRmore asset · fee paid in EVR' : 'EVRmore'}
            </span>
          </div>
          {isLegacyAsset(assetId) && (
            <p
              className="text-dim"
              data-testid="legacy-asset-send-note"
              style={{ fontSize: 11.5, margin: '0 2px 8px', lineHeight: 1.5 }}
            >
              Legacy SATORI. The Satori Network now uses SATORIEVR.
            </p>
          )}
          <p className="text-dim" style={{ fontSize: 11.5, margin: '0 2px 14px', lineHeight: 1.5 }}>
            {isAsset
              ? `Sending ${assetId}. Network fees are always paid in EVR.`
              : 'Sending the native EVR coin.'}
          </p>

          {noEvrForGas && (
            <div className="banner danger" data-testid="no-evr-gas-banner" style={{ marginBottom: 10 }}>
              <AlertTriangle size={14} />
              You need EVR to pay the network fee. You can&apos;t send assets while your EVR balance is 0.
            </div>
          )}

          {displayFormError && (
            <div className="banner danger" data-testid="live-send-error" style={{ marginBottom: 10 }}>
              {displayFormError}
            </div>
          )}

          <Button type="submit" block loading={loadingSend} disabled={noEvrForGas}>
            Review transaction
          </Button>
        </form>
      </div>
      <LiveNav />
    </div>
  );
}
