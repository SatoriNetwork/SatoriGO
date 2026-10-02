// Send screen for a Zcash wallet (docs/design/zcash-engine.md §3, §4, §10,
// §15 Set C).
//
// Same three-step shape (form -> review -> success) and the same arming
// discipline (a real-money warning banner, an explicit "I understand" check,
// the wallet password when the user asked to be asked) as LiveSend.tsx and
// LiveSendMonero.tsx. What is genuinely different, because the chain is
// different:
//
//   - there is no priority picker and no fee-level choice: ZIP-317 fixes the
//     fee exactly, so the review screen shows it as a rule, not an estimate;
//   - "Max" sweeps every spendable (confirmed, non-coinbase) UTXO — unlike a
//     UTXO chain's percentage-based amount fill, this is knowable client-side
//     because there is no ring signature / decoy step in the way;
//   - the review shows the transaction's EXPIRY ("valid for about N blocks"),
//     which no other chain in this wallet has (§4.5, §6.5);
//   - ZcashSignedTx (Set A) carries no recipient field, so the review's "To"
//     row is the screen's own typed value, not something read back off the
//     signed transaction.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, AlertTriangle, CheckCircle } from 'lucide-react';
import { Button } from '../../components/Button';
import { TextField, PasswordField } from '../../components/TextField';
import { TokenIcon } from '../../components/BrandLogo';
import { useLiveStore, walletsOnChain } from '../../store/liveStore';
import { buildZcashSendPlan, ZcashSendError, type ZcashSendPlan } from '../../store/zcashSend';
import { ZCASH_TARGET, ZCASH_CHAIN, zcashExplorerTxUrl } from '../../store/zcashChain';
import { isValidZcashRecipient } from '../../services/chain/zcash/address';
import { zcashSweepInfo } from '../../services/chain/zcash/builder';
import { formatZec, ZCASH_MAX_FEE_ZAT } from '../../services/chain/zcash/fees';
import { LiveNav } from './LiveNav';
import { ContactsPicker, MyWalletsPicker, SaveContactPanel } from './RecipientPickers';

interface LiveSendZcashProps {
  onBack(): void;
  onDone?(): void;
}

type SendStep = 'form' | 'review' | 'success';

/** Same pause LiveSend.tsx / LiveSendMonero.tsx use before auto-returning
 *  home, so a Zcash send does not feel snappier or slower than any other
 *  chain's. */
const SUCCESS_AUTO_RETURN_MS = 4_000;

const ZEC_DECIMALS = 8;

/** bigint zatoshi -> plain decimal text at Zcash's 8-decimal scale, for the
 *  amount field's percentage fills. Local and tiny on purpose, independent of
 *  Set A's `formatZec` (which is authoritative for what the review screen
 *  SENDS): this one only ever fills a text input the user can edit further,
 *  same reasoning as LiveSendMonero.tsx's local piconeroToText. */
function zatToText(zat: bigint): string {
  const s = zat.toString().padStart(ZEC_DECIMALS + 1, '0');
  const whole = s.slice(0, -ZEC_DECIMALS) || '0';
  const frac = s.slice(-ZEC_DECIMALS).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

function pctOf(zat: bigint, pct: number): bigint {
  return (zat * BigInt(pct)) / 100n;
}

/** Why Max cannot sweep, in the words the form shows. */
function sweepRefusal(reason: 'ok' | 'none' | 'dust' | 'fee-cap', coins: number): string {
  if (reason === 'fee-cap') {
    return `Max would spend all ${coins} coins at once, and the network fee for that is above this wallet's cap of ${formatZec(ZCASH_MAX_FEE_ZAT)} ZEC. Send a smaller amount, or send in parts.`;
  }
  if (reason === 'dust') return 'Nothing to send yet: the spendable ZEC does not cover the network fee.';
  return 'Nothing to send yet: no spendable ZEC.';
}

/** A ZcashSendError's own message is already user-facing (zcashSend.ts writes
 *  every one of them for a screen to show directly, including the exact §3.3
 *  refusal wording); anything else gets a generic fallback, mirroring
 *  LiveSendMonero.tsx's friendlyMoneroSendError in shape. */
export function friendlyZcashSendError(err: unknown): string {
  if (err instanceof ZcashSendError) return err.message;
  return err instanceof Error && err.message ? err.message : 'Something went wrong building this transaction.';
}

export function LiveSendZcash({ onBack, onDone }: LiveSendZcashProps) {
  const chain = useLiveStore((s) => s.zcash.chain) ?? ZCASH_CHAIN;
  const snapshot = useLiveStore((s) => s.zcash.snapshot);
  const wallets = useLiveStore((s) => s.wallets);
  const activeWalletId = useLiveStore((s) => s.activeWalletId);
  const addressBook = useLiveStore((s) => s.addressBook);
  const addContact = useLiveStore((s) => s.addContact);
  const requirePasswordToSend = useLiveStore((s) => s.requirePasswordToSend);
  const verifyPassword = useLiveStore((s) => s.verifyPassword);
  const arm = useLiveStore((s) => s.arm);
  const confirmZcashSend = useLiveStore((s) => s.confirmZcashSend);
  const refresh = useLiveStore((s) => s.refresh);

  const activeWallet = wallets.find((w) => w.id === activeWalletId);
  const isOpen = !!activeWallet && activeWallet.family === 'zcash';
  const isPasswordless = (activeWallet?.passwordless ?? false) || (activeWallet?.noSendPassword ?? false);
  const requirePassword = requirePasswordToSend && !isPasswordless;

  // What this wallet can actually spend right now: the coins a send is built
  // from (confirmed, not coinbase, not held back for one of our pending sends
  // or spent in the mempool: snapshot.spendable), not the confirmed balance.
  // Available, the % chips and Max all read this one set, and Max sends
  // exactly what a sweep of it sends (zcashSweepInfo, the builder's own rule).
  const sweepInfo = zcashSweepInfo(snapshot?.spendable ?? []);
  const availableZat = sweepInfo.total;

  // The user's OTHER Zcash wallets, and the address-book entries that decode
  // as a valid Zcash recipient — the same chain-scoping rule every other Send
  // screen follows (RecipientPickers.tsx header, the owner's chain-scoping
  // rule): a UTXO/EVM/Monero wallet is never offered here.
  const myWallets = walletsOnChain(wallets, ZCASH_TARGET).filter((w) => w.id !== activeWalletId && w.address);
  const chainContacts = addressBook.filter((c) => isValidZcashRecipient(c.address));

  const [step, setStep] = useState<SendStep>('form');
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [sweep, setSweep] = useState(false);
  const [fieldError, setFieldError] = useState('');
  const [building, setBuilding] = useState(false);
  const [plan, setPlan] = useState<ZcashSendPlan | null>(null);

  const [armed, setArmed] = useState(false);
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [broadcasting, setBroadcasting] = useState(false);
  const [broadcastError, setBroadcastError] = useState('');
  const [successTxid, setSuccessTxid] = useState('');
  /** The gateway could not say whether the send was received (its 504, or
   *  "already queued"): the record is kept and looked up, NEVER re-sent. The
   *  success screen then shows the pending variant and does not auto-return. */
  const [successUnknown, setSuccessUnknown] = useState(false);

  const handleDone = useCallback(() => {
    void refresh({ silent: true });
    (onDone ?? onBack)();
  }, [refresh, onDone, onBack]);

  const doneRef = useRef(handleDone);
  useEffect(() => {
    doneRef.current = handleDone;
  }, [handleDone]);
  useEffect(() => {
    if (step !== 'success' || successUnknown) return;
    const timer = setTimeout(() => doneRef.current(), SUCCESS_AUTO_RETURN_MS);
    return () => clearTimeout(timer);
  }, [step, successUnknown]);

  const setAmountManual = (val: string) => {
    setAmount(val);
    setSweep(false);
  };

  const fillPct = (pct: number) => {
    const value = pctOf(availableZat, pct);
    setAmount(value > 0n ? zatToText(value) : '0');
    setSweep(false);
  };

  const toggleMax = () => {
    // Still a sweep (exact: every spendable coin, no change), but the field
    // shows the amount that sweep sends, so Max is never an empty box
    // (owner, 2026-10-02).
    const max = sweepInfo.amount;
    if (max === null) {
      setSweep(false);
      setAmount('');
      setFieldError(sweepRefusal(sweepInfo.reason, sweepInfo.coins));
      return;
    }
    setSweep(true);
    setAmount(zatToText(max));
    setFieldError('');
  };

  const trimmedTo = to.trim();
  const alreadySaved = chainContacts.some((c) => c.address === trimmedTo);
  const isOwnWallet = myWallets.some((w) => w.address === trimmedTo);
  const canSaveContact = isValidZcashRecipient(trimmedTo) && !alreadySaved && !isOwnWallet;

  const fillRecipient = (addr: string) => {
    setTo(addr);
    setFieldError('');
  };

  const handleBuild = async (e: React.FormEvent) => {
    e.preventDefault();
    setFieldError('');

    if (!to.trim()) {
      setFieldError('Recipient address is required.');
      return;
    }
    if (!sweep && !amount.trim()) {
      setFieldError('Enter an amount, or use Max to sweep your whole spendable balance.');
      return;
    }

    setBuilding(true);
    try {
      const result = await buildZcashSendPlan({ to: to.trim(), amount, sweep });
      setPlan(result);
      setStep('review');
    } catch (err) {
      if (err instanceof ZcashSendError && (err.code === 'invalid-address' || err.code === 'invalid-amount')) {
        setFieldError(err.message);
      } else {
        setFieldError(friendlyZcashSendError(err));
      }
    } finally {
      setBuilding(false);
    }
  };

  const handleBack = () => {
    if (step === 'review') {
      setPlan(null);
      setArmed(false);
      setPassword('');
      setPasswordError('');
      setBroadcastError('');
      arm(false);
      setStep('form');
    } else {
      onBack();
    }
  };

  const handleArmToggle = (val: boolean) => {
    setArmed(val);
    arm(val);
  };

  const handleBroadcast = async () => {
    if (!plan) return;
    setBroadcastError('');
    setPasswordError('');

    if (requirePassword) {
      const ok = await verifyPassword(password);
      if (!ok) {
        setPasswordError('Incorrect password');
        return;
      }
    }

    setBroadcasting(true);
    try {
      // Through the store's arming gate (confirmZcashSend), never the relay
      // directly: the plan is signed already, so the gate is what stands
      // between this screen and the network.
      const { txid } = await confirmZcashSend(plan, { to: trimmedTo });
      setSuccessTxid(txid);
      setSuccessUnknown(false);
      setPlan(null);
      setStep('success');
      void refresh({ silent: true });
    } catch (err) {
      if (err instanceof ZcashSendError && err.code === 'broadcast-unknown') {
        // The gateway contract for this answer is "never re-send": leave the
        // review step so the same bytes cannot be posted again, show the txid
        // the wallet computed itself, and point at Activity.
        setSuccessTxid(plan.signed.txid);
        setSuccessUnknown(true);
        setPlan(null);
        setStep('success');
        void refresh({ silent: true });
      } else {
        setBroadcastError(friendlyZcashSendError(err));
      }
    } finally {
      setBroadcasting(false);
      arm(false);
      setArmed(false);
    }
  };

  if (!isOpen) {
    return (
      <div className="app-frame screen-enter">
        <div className="sub-header">
          <button type="button" className="icon-btn" onClick={onBack} aria-label="Back">
            <ChevronLeft size={20} />
          </button>
          <h2>Send Zcash</h2>
          <span />
        </div>
        <div className="app-content">
          <div className="banner danger" data-testid="live-zec-send-closed">
            Your Zcash wallet is not open. Unlock it to send.
          </div>
        </div>
        <LiveNav />
      </div>
    );
  }

  const explorerUrl = successTxid ? zcashExplorerTxUrl(successTxid, chain) : null;

  if (step === 'success') {
    return (
      <div className="app-frame screen-enter">
        <div className="sub-header">
          <button type="button" className="icon-btn" onClick={handleDone} aria-label="Back">
            <ChevronLeft size={20} />
          </button>
          <h2>{successUnknown ? 'Sent, not yet confirmed' : 'Sent'}</h2>
          <span />
        </div>
        <div className="app-content">
          <div className="result-screen" data-testid={successUnknown ? 'live-zec-send-unknown' : 'live-zec-send-success'}>
            <div
              className={successUnknown ? 'result-icon' : 'result-icon success'}
              style={successUnknown ? { background: 'var(--warning-bg)', color: 'var(--warning)' } : undefined}
            >
              {successUnknown ? <AlertTriangle size={32} /> : <CheckCircle size={32} />}
            </div>
            <h3>{successUnknown ? 'Not yet confirmed' : 'Broadcast successful'}</h3>
            <p>
              {successUnknown
                ? 'The network did not confirm it received this send. It may still go through. Check Activity before sending again: it shows as pending until it confirms, or as not sent if it expires.'
                : 'Your transaction has been submitted to the Zcash network.'}
            </p>
            <div className="card" style={{ marginTop: 16, width: '100%', textAlign: 'left' }} data-testid="live-zec-send-txid">
              <div className="section-label" style={{ marginTop: 0 }}>Transaction ID</div>
              <span className="mono" style={{ fontSize: 11, wordBreak: 'break-all', color: 'var(--text-dim)' }}>
                {successTxid}
              </span>
            </div>
            {explorerUrl && (
              <a
                href={explorerUrl}
                target="_blank"
                rel="noreferrer"
                className="btn btn-secondary btn-sm"
                data-testid="live-zec-send-explorer-link"
                style={{ marginTop: 12 }}
              >
                Open in explorer
              </a>
            )}
            <Button block onClick={handleDone} style={{ marginTop: 12 }}>
              Done
            </Button>
            {!successUnknown && (
              <p className="text-faint" style={{ fontSize: 10.5, marginTop: 10 }}>
                Returning to your wallet in a few seconds…
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (step === 'review' && plan) {
    const sendDisabled = !armed;
    return (
      <div className="app-frame screen-enter">
        <div className="sub-header">
          <button type="button" className="icon-btn" onClick={handleBack} aria-label="Back">
            <ChevronLeft size={20} />
          </button>
          <h2>Review send</h2>
          <span />
        </div>
        {/* Review split (same send-pinned pair as the form): the summary
            scrolls in .send-scroll while the whole Confirm & Send section
            (arm tick, password, error, Back + Confirm) stays pinned below it,
            so the primary button is visible without scrolling on 400x600. */}
        <div className="app-content send-pinned" data-testid="live-zec-send-review">
          <div className="send-scroll">
            <div className="banner warning" style={{ marginBottom: 14 }}>
              <AlertTriangle size={14} />
              This broadcasts a real ZEC transaction to the Zcash network. Sends cannot be undone.
            </div>

            <div className="card solid" style={{ marginBottom: 14 }}>
              <div className="summary-table">
                <div className="sum-row">
                  <span className="sum-key">To</span>
                  <span className="sum-val mono" style={{ fontSize: 11, wordBreak: 'break-all' }}>{trimmedTo}</span>
                </div>
                <div className="sum-row">
                  <span className="sum-key">Amount</span>
                  <span className="sum-val" data-testid="live-zec-send-amount-row">
                    {plan.amountZec} ZEC{sweep ? ' (sweep)' : ''}
                  </span>
                </div>
                <div className="sum-row" data-testid="live-zec-send-fee">
                  <span className="sum-key">Network fee</span>
                  <span className="sum-val">{plan.feeZec} ZEC</span>
                </div>
                <div className="sum-row" data-testid="live-zec-send-total">
                  <span className="sum-key">Total</span>
                  <span className="sum-val">{plan.totalZec} ZEC</span>
                </div>
                <div className="sum-row" data-testid="live-zec-send-expiry">
                  <span className="sum-key">Valid for</span>
                  <span className="sum-val">
                    about {plan.expiresInBlocks} blocks (roughly {Math.round((plan.expiresInBlocks * 75) / 60)} minutes)
                  </span>
                </div>
              </div>
            </div>

            <div className="banner info" style={{ marginBottom: 14 }}>
              If this expires before it confirms, it fails cleanly and you can send again. The fee follows a fixed
              network rule; there is no priority to choose.
            </div>
          </div>{/* /send-scroll */}
          <div className="send-cta">
            <div className="section-label">Confirm &amp; Send</div>
            <div className="card" style={{ marginBottom: 14 }}>
              <div
                role="checkbox"
                aria-checked={armed}
                tabIndex={0}
                data-testid="live-zec-arm-checkbox"
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
                  I understand this sends real ZEC and cannot be undone.
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
                  testId="live-zec-send-password"
                />
                {passwordError && (
                  <span
                    role="alert"
                    data-testid="live-zec-send-password-error"
                    style={{ fontSize: 11.5, color: 'var(--danger)', display: 'block', marginTop: 4 }}
                  >
                    {passwordError}
                  </span>
                )}
              </div>
            )}

            {broadcastError && (
              <div className="banner danger" style={{ marginBottom: 14 }} data-testid="live-zec-send-error">
                {broadcastError}
              </div>
            )}

            <div style={{ display: 'flex', gap: 9 }}>
              <Button variant="secondary" onClick={handleBack}>Back</Button>
              <Button
                block
                variant="danger"
                disabled={sendDisabled}
                loading={broadcasting}
                onClick={() => void handleBroadcast()}
                data-testid="live-zec-broadcast"
              >
                Confirm & Send
              </Button>
            </div>
          </div>{/* /send-cta */}
        </div>
      </div>
    );
  }

  // step === 'form'
  return (
    <div className="app-frame screen-enter">
      <div className="sub-header">
        <button type="button" className="icon-btn" onClick={onBack} aria-label="Back">
          <ChevronLeft size={20} />
        </button>
        <h2>Send ZEC</h2>
        <span />
      </div>
      <div className="app-content send-pinned">
        <form onSubmit={(e) => { void handleBuild(e); }}>
          <div className="send-scroll">
            <TextField
              label="Recipient address"
              placeholder="Zcash address (t1, t3 or tex1)"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              testId="live-zec-send-to"
            />

            <MyWalletsPicker wallets={myWallets} current={trimmedTo} onPick={fillRecipient} testIdPrefix="live-zec-send" />
            <ContactsPicker contacts={chainContacts} onPick={fillRecipient} testIdPrefix="live-zec-send" />
            <SaveContactPanel
              canSave={canSaveContact}
              recipient={trimmedTo}
              onSave={(label) => addContact(label, trimmedTo)}
              testIdPrefix="live-zec-send"
            />

            <TextField
              label="Amount (ZEC)"
              placeholder="0.00"
              type="text"
              inputMode="decimal"
              value={amount}
              disabled={sweep}
              onChange={(e) => setAmountManual(e.target.value)}
              testId="live-zec-send-amount"
              error={fieldError || undefined}
              hint={sweep ? 'Sending your entire spendable (confirmed) balance.' : undefined}
            />

            <div className="text-dim" data-testid="live-zec-send-available" style={{ fontSize: 11.5, margin: '6px 2px 8px' }}>
              Available: {snapshot ? zatToText(availableZat) : 'Loading…'} ZEC
            </div>

            <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
              {[25, 50, 75].map((pct) => (
                <button
                  key={pct}
                  type="button"
                  className="chip neutral"
                  data-testid={`live-zec-send-amt-${pct}`}
                  onClick={() => fillPct(pct)}
                  style={{ flex: 1, justifyContent: 'center', cursor: 'pointer' }}
                >
                  {pct}%
                </button>
              ))}
              <button
                type="button"
                className={sweep ? 'chip' : 'chip neutral'}
                data-testid="live-zec-send-sweep"
                aria-pressed={sweep}
                disabled={availableZat === 0n}
                title={
                  availableZat === 0n
                    ? 'Nothing to sweep: no spendable ZEC yet.'
                    : sweepInfo.amount === null
                      ? sweepRefusal(sweepInfo.reason, sweepInfo.coins)
                      : undefined
                }
                onClick={toggleMax}
                style={{
                  flex: 1,
                  justifyContent: 'center',
                  cursor: availableZat === 0n ? 'not-allowed' : 'pointer',
                  opacity: availableZat === 0n ? 0.5 : 1,
                }}
              >
                Max
              </button>
            </div>

            <div className="token-row" style={{ marginBottom: 10 }}>
              <TokenIcon assetId="ZEC" size={30} />
              <div style={{ minWidth: 0, marginLeft: 8, flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 13 }}>ZEC</div>
                <div className="text-dim" style={{ fontSize: 11.5 }}>Zcash (transparent)</div>
              </div>
            </div>
          </div>

          <div className="send-cta">
            <Button type="submit" block loading={building} data-testid="live-zec-send-submit">
              Review transaction
            </Button>
          </div>
        </form>
      </div>
      <LiveNav />
    </div>
  );
}
