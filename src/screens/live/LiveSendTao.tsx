// Send screen for a Bittensor wallet (Bittensor engine design §10, §15 Set
// C). Same three-step shape (form -> review -> success) and the same arming
// discipline (a real-money warning banner, an explicit "I understand" check,
// the wallet password when the user asked to be asked) as LiveSend.tsx and
// LiveSendMonero.tsx.
//
// A NOTE ON WHERE THE SIGNING HAPPENS (see taoSend.ts's file header for the
// full reasoning): buildTaoSendPlan/broadcastTaoPlan (this Set's taoSend.ts)
// need the account's mini secret, which only LiveWalletService can produce
// and only liveStore.ts ever touches (mirroring how LiveSendEvm.tsx never
// calls evmSend.ts directly either — it goes through store actions that
// inject `svc.signEvmTransaction`). So, like LiveSendEvm.tsx, this screen
// calls STORE ACTIONS (`buildTaoSend` / `confirmTaoSend` / `clearTaoSend`,
// mirroring `quoteEvmSend` / `confirmEvmSend` / `clearEvmSend` exactly) rather
// than taoSend.ts's functions directly. THOSE ACTIONS DO NOT EXIST YET on the
// real liveStore.ts (Set D wires them in) — see the Set C report for the
// exact shape this screen expects.
//
// What is genuinely different because the chain is different:
//   - MAX is transfer_all, not a computed "balance minus a fee estimate"
//     (design §4.5: "a 'send everything, close the account' is not offered");
//   - a minimum amount is enforced (the existential deposit) with an explicit
//     reason, not just "greater than zero";
//   - a runtime-guard banner can block Send entirely while Receive/balance
//     keep working (design §10, §4.4);
//   - after broadcast there is a genuine "waiting for inclusion" state
//     (Substrate finality, not a UTXO's confirmation count).

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, AlertTriangle, CheckCircle, Clock } from 'lucide-react';
import { Button } from '../../components/Button';
import { TextField, PasswordField } from '../../components/TextField';
import { TokenIcon } from '../../components/BrandLogo';
import { useLiveStore, walletsOnChain } from '../../store/liveStore';
import type { TaoSendPlan } from '../../store/taoSend';
import { TAO_TARGET, TAO_CHAIN, taoExplorerTxUrl } from '../../store/taoChain';
import { parseTao, formatTao, taoFeeWithMargin } from '../../services/chain/substrate/fees';
import { LiveNav } from './LiveNav';
import { ContactsPicker, MyWalletsPicker, SaveContactPanel } from './RecipientPickers';

interface LiveSendTaoProps {
  onBack(): void;
  onDone?(): void;
}

type SendStep = 'form' | 'review' | 'success';

/** Shown under the amount when Max is used, or when a typed amount would
 *  dip into the 500 rao existential deposit. Max itself is `transfer_all`
 *  with keep_alive, so the chain pays the fee first and always leaves the
 *  existential deposit on the account; this line only says so. */
export const TAO_ED_HINT = 'Max keeps 0.0000005 TAO on the account, the minimum Bittensor requires.';

/** Under an amount that leaves no room for the fee (it is at or above Available). */
export const TAO_NO_FEE_ROOM_HINT = 'This amount leaves no room for the network fee. Tap Max for the largest amount that fits.';

/** Fee allowance Max subtracts before filling the field. A transfer_keep_alive
 *  costs about 83,000 rao on mainnet (spec 470, measured 2026-10-02); 100,000
 *  plus the affordability margin leaves room for small fee moves while the
 *  exact fee is still the one the review shows. */
export const TAO_MAX_FEE_ALLOWANCE_RAO = 100_000n;

/** The amount Max fills in: what can be spent minus the fee allowance (with
 *  its margin), never below zero. A concrete, editable number rather than an
 *  empty "send the rest" sweep (owner, 2026-10-02). */
export function taoMaxFill(spendableRao: bigint): bigint {
  const room = spendableRao - taoFeeWithMargin(TAO_MAX_FEE_ALLOWANCE_RAO);
  return room > 0n ? room : 0n;
}

/** True when a typed amount (in TAO text) leaves less than the existential
 *  deposit once any fee is paid. `spendable` already excludes the deposit
 *  (free - max(frozen, ED)), so an amount at or above it cannot also cover a
 *  fee without touching the deposit. Malformed or empty text answers false:
 *  the form's own validation handles that. */
export function amountTouchesExistentialDeposit(amountText: string, spendableRao: bigint): boolean {
  if (!amountText.trim()) return false;
  let rao: bigint;
  try {
    rao = parseTao(amountText.trim());
  } catch {
    return false;
  }
  return rao > 0n && rao >= spendableRao;
}

/** Same pause as every other Send screen's success step (LiveSend.tsx,
 *  LiveSendMonero.tsx). */
const SUCCESS_AUTO_RETURN_MS = 4_000;

/** Design §9: an SS58 address with no visible EVM-style "0x" prefix check —
 *  this is only the FIRST-glance filter the picker/contact lists use before
 *  the real check (isValidTaoAddress, inside buildTaoSend). */
function looksLikeTaoAddress(address: string): boolean {
  return address.startsWith('5') && address.length >= 46 && address.length <= 48;
}

/** A raw Bittensor/gateway error -> a sentence a user can act on. UNLIKE
 *  friendlyMoneroSendError, this does NOT pattern-match the message text to
 *  reword it: Set A/B (services/chain/substrate) already write every error
 *  in plain English for its exact cause — TaoSendError and
 *  TaoRuntimeChangedError's messages (design §4.5, §4.4) and TaoRpcError's
 *  ("The Bittensor network is unreachable...", "...rate limiting...", "...did
 *  not answer in time...") are already what the screen should show. A
 *  keyword-based reword was tried and dropped: the runtime-changed message
 *  itself contains the word "network" ("Bittensor updated its network..."),
 *  so a naive "contains 'network' -> show a network-unreachable sentence"
 *  rule misfires on it. */
export function friendlyTaoSendError(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return 'Something went wrong sending TAO. Try again in a moment.';
}

export function LiveSendTao({ onBack, onDone }: LiveSendTaoProps) {
  const tao = useLiveStore((s) => s.tao);
  const plan = useLiveStore((s) => s.taoSend) as TaoSendPlan | null;
  const loadingPlan = useLiveStore((s) => s.loadingTaoSend);
  const buildTaoSend = useLiveStore((s) => s.buildTaoSend);
  const confirmTaoSend = useLiveStore((s) => s.confirmTaoSend);
  const clearTaoSend = useLiveStore((s) => s.clearTaoSend);
  const wallets = useLiveStore((s) => s.wallets);
  const activeWalletId = useLiveStore((s) => s.activeWalletId);
  const addressBook = useLiveStore((s) => s.addressBook);
  const addContact = useLiveStore((s) => s.addContact);
  const requirePasswordToSend = useLiveStore((s) => s.requirePasswordToSend);
  const verifyPassword = useLiveStore((s) => s.verifyPassword);
  const arm = useLiveStore((s) => s.arm);
  const refresh = useLiveStore((s) => s.refresh);

  const activeWallet = wallets.find((w) => w.id === activeWalletId);
  const isPasswordless = (activeWallet?.passwordless ?? false) || (activeWallet?.noSendPassword ?? false);
  const requirePassword = requirePasswordToSend && !isPasswordless;

  const account = tao?.account ?? null;
  const spendableRao = account?.spendable ?? 0n;
  const runtimeBlocked = tao?.runtime === 'layout-changed';

  const myWallets = walletsOnChain(wallets, TAO_TARGET).filter((w) => w.id !== activeWalletId && w.address);
  const chainContacts = addressBook.filter((c) => looksLikeTaoAddress(c.address));

  const [step, setStep] = useState<SendStep>('form');
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [sweep, setSweep] = useState(false);
  const [fieldError, setFieldError] = useState('');

  const [armed, setArmed] = useState(false);
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [broadcasting, setBroadcasting] = useState(false);
  const [broadcastError, setBroadcastError] = useState('');
  const [successHash, setSuccessHash] = useState('');
  const [inclusion, setInclusion] = useState<'pending' | 'included' | 'expired' | null>(null);

  const handleDone = useCallback(() => {
    clearTaoSend();
    void refresh({ silent: true });
    (onDone ?? onBack)();
  }, [clearTaoSend, refresh, onDone, onBack]);

  const doneRef = useRef(handleDone);
  useEffect(() => {
    doneRef.current = handleDone;
  }, [handleDone]);
  useEffect(() => {
    if (step !== 'success') return;
    const timer = setTimeout(() => doneRef.current(), SUCCESS_AUTO_RETURN_MS);
    return () => clearTimeout(timer);
  }, [step]);

  const trimmedTo = to.trim();
  const alreadySaved = chainContacts.some((c) => c.address === trimmedTo);
  const isOwnWallet = myWallets.some((w) => w.address === trimmedTo);
  const canSaveContact = looksLikeTaoAddress(trimmedTo) && !alreadySaved && !isOwnWallet;

  const fillRecipient = (addr: string) => {
    setTo(addr);
    setFieldError('');
  };

  const toggleMax = () => {
    // Fills a concrete amount (spendable minus the fee allowance) and sends it
    // as an ordinary keep-alive transfer, so the user sees exactly what goes.
    const fill = taoMaxFill(spendableRao);
    setSweep(false);
    setAmount(fill > 0n ? formatTao(fill) : '');
    setFieldError(fill > 0n ? '' : 'Not enough TAO to cover the network fee.');
  };

  const setAmountManual = (val: string) => {
    setAmount(val);
    setSweep(false);
  };

  const handleBuild = async (e: React.FormEvent) => {
    e.preventDefault();
    setFieldError('');

    if (runtimeBlocked) {
      setFieldError('Bittensor updated its network; update Satori GO to send.');
      return;
    }
    if (!trimmedTo) {
      setFieldError('Recipient address is required.');
      return;
    }
    if (!sweep && !amount.trim()) {
      setFieldError('Enter an amount, or use Max to send the rest of your balance.');
      return;
    }

    try {
      await buildTaoSend({ to: trimmedTo, amount, sweep });
      setStep('review');
    } catch (err) {
      // Every failure here (a bad recipient/amount, below the existential
      // deposit, a fee over the cap, a runtime change) happens before the
      // send reaches review, so all of it is shown as one inline field
      // error rather than split by code — see friendlyTaoSendError's header.
      setFieldError(friendlyTaoSendError(err));
    }
  };

  const handleBack = () => {
    if (step === 'review') {
      clearTaoSend();
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
      const { hash } = await confirmTaoSend();
      setSuccessHash(hash);
      setInclusion('pending');
      setStep('success');
    } catch (err) {
      setBroadcastError(friendlyTaoSendError(err));
    } finally {
      setBroadcasting(false);
      arm(false);
      setArmed(false);
    }
  };

  // Once broadcast, `tao.pending` (Set D surface, design §15: TaoInclusion)
  // is the store's own view of the poll broadcastTaoPlan started; this screen
  // only reflects it, matching the "waiting for inclusion" state design §10
  // describes.
  useEffect(() => {
    if (step !== 'success') return;
    if (tao?.pending && tao.pending.state !== 'pending') {
      setInclusion(tao.pending.state);
    }
  }, [step, tao?.pending]);

  // Balance and Receive keep working while Send is blocked (design §10): the
  // runtime banner is rendered INSIDE the form below rather than replacing
  // the whole screen, so the recipient/amount fields stay visible for
  // context even while disabled.
  const explorerUrl = successHash ? taoExplorerTxUrl(successHash) : null;

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
            <p>Your transaction has been submitted to the Bittensor network.</p>
            <div className="card" style={{ marginTop: 16, width: '100%', textAlign: 'left' }} data-testid="live-tao-send-hash">
              <div className="section-label" style={{ marginTop: 0 }}>Transaction hash</div>
              <span className="mono" style={{ fontSize: 11, wordBreak: 'break-all', color: 'var(--text-dim)' }}>
                {successHash}
              </span>
            </div>
            <div
              className={`banner ${inclusion === 'expired' ? 'warning' : 'info'}`}
              style={{ marginTop: 12, width: '100%' }}
              data-testid="live-tao-send-inclusion"
            >
              <Clock size={14} />
              {inclusion === 'included' && 'Included in a block.'}
              {inclusion === 'expired' && 'Not included within the window. You can send again.'}
              {(inclusion === 'pending' || inclusion === null) && 'Waiting for inclusion...'}
            </div>
            {explorerUrl && (
              <a
                href={explorerUrl}
                target="_blank"
                rel="noreferrer"
                className="btn btn-secondary btn-sm"
                data-testid="live-tao-send-explorer-link"
                style={{ marginTop: 12 }}
              >
                Open in explorer
              </a>
            )}
            <Button block onClick={handleDone} style={{ marginTop: 12 }}>
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
        <div className="app-content send-pinned" data-testid="live-tao-send-review">
          <div className="send-scroll">
            <div className="banner warning" style={{ marginBottom: 14 }}>
              <AlertTriangle size={14} />
              This broadcasts a real TAO transaction to the Bittensor network. Sends cannot be undone.
            </div>

            {plan.warnings.map((w, i) => (
              <div className="banner info" style={{ marginBottom: 10 }} key={i} data-testid={`live-tao-send-warning-${i}`}>
                {w}
              </div>
            ))}

            <div className="card solid" style={{ marginBottom: 14 }}>
              <div className="summary-table">
                <div className="sum-row">
                  <span className="sum-key">To</span>
                  <span className="sum-val mono" style={{ fontSize: 11, wordBreak: 'break-all' }}>{plan.to}</span>
                </div>
                <div className="sum-row">
                  <span className="sum-key">Amount</span>
                  <span className="sum-val" data-testid="live-tao-send-amount-row">{plan.amountTao} TAO</span>
                </div>
                <div className="sum-row" data-testid="live-tao-send-fee" data-fee-rao={plan.plan.fee.toString()}>
                  <span className="sum-key">Network fee</span>
                  <span className="sum-val">{plan.feeTao} TAO</span>
                </div>
                <div className="sum-row" data-testid="live-tao-send-total">
                  <span className="sum-key">Total</span>
                  <span className="sum-val">{plan.totalTao} TAO</span>
                </div>
              </div>
            </div>
          </div>{/* /send-scroll */}
          <div className="send-cta">
            <div className="section-label">Confirm &amp; Send</div>
            <div className="card" style={{ marginBottom: 14 }}>
              <div
                role="checkbox"
                aria-checked={armed}
                tabIndex={0}
                data-testid="live-tao-arm-checkbox"
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
                  I understand this sends real TAO and cannot be undone.
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
                  testId="live-tao-send-password"
                />
                {passwordError && (
                  <span
                    role="alert"
                    data-testid="live-tao-send-password-error"
                    style={{ fontSize: 11.5, color: 'var(--danger)', display: 'block', marginTop: 4 }}
                  >
                    {passwordError}
                  </span>
                )}
              </div>
            )}

            {broadcastError && (
              <div className="banner danger" style={{ marginBottom: 14 }} data-testid="live-tao-send-error">
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
                data-testid="live-tao-broadcast"
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
        <h2>Send TAO</h2>
        <span />
      </div>
      <div className="app-content send-pinned">
        <form onSubmit={(e) => { void handleBuild(e); }}>
          <div className="send-scroll">
            {runtimeBlocked && (
              <div className="banner warning" style={{ marginBottom: 12 }} data-testid="live-tao-runtime-banner">
                <AlertTriangle size={14} />
                Bittensor updated its network; update Satori GO to send.
              </div>
            )}

            <TextField
              label="Recipient address"
              placeholder="Bittensor address (starts with 5)"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              testId="live-tao-send-to"
              disabled={runtimeBlocked}
            />

            <MyWalletsPicker wallets={myWallets} current={trimmedTo} onPick={fillRecipient} testIdPrefix="live-tao-send" />
            <ContactsPicker contacts={chainContacts} onPick={fillRecipient} testIdPrefix="live-tao-send" />
            <SaveContactPanel
              canSave={canSaveContact}
              recipient={trimmedTo}
              onSave={(label) => addContact(label, trimmedTo)}
              testIdPrefix="live-tao-send"
            />

            <TextField
              label="Amount (TAO)"
              placeholder="0.00"
              type="text"
              inputMode="decimal"
              value={sweep ? '' : amount}
              disabled={sweep || runtimeBlocked}
              onChange={(e) => setAmountManual(e.target.value)}
              testId="live-tao-send-amount"
              error={fieldError || undefined}
            />

            {(sweep || amountTouchesExistentialDeposit(amount, spendableRao)) && (
              <div className="text-dim" data-testid="live-tao-send-ed-hint" style={{ fontSize: 11.5, margin: '6px 2px 0' }}>
                {sweep ? TAO_ED_HINT : TAO_NO_FEE_ROOM_HINT}
              </div>
            )}

            <div className="text-dim" data-testid="live-tao-send-available" style={{ fontSize: 11.5, margin: '6px 2px 8px' }}>
              Available: {formatRaoForDisplay(spendableRao)} TAO
            </div>

            <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
              <button
                type="button"
                className={sweep ? 'chip' : 'chip neutral'}
                data-testid="live-tao-send-max"
                aria-pressed={sweep}
                disabled={runtimeBlocked || spendableRao === 0n}
                onClick={toggleMax}
                style={{ flex: 1, justifyContent: 'center', cursor: runtimeBlocked || spendableRao === 0n ? 'not-allowed' : 'pointer' }}
              >
                Max
              </button>
            </div>

            <div className="token-row" style={{ marginBottom: 10 }}>
              <TokenIcon assetId="TAO" size={30} />
              <div style={{ minWidth: 0, marginLeft: 8, flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 13 }}>TAO</div>
                <div className="text-dim" style={{ fontSize: 11.5 }}>{TAO_CHAIN.displayName}</div>
              </div>
            </div>
          </div>

          <div className="send-cta">
            <Button
              type="submit"
              block
              loading={loadingPlan}
              disabled={runtimeBlocked}
              data-testid="live-tao-send-submit"
            >
              Review transaction
            </Button>
          </div>
        </form>
      </div>
      <LiveNav />
    </div>
  );
}

/** rao (9 decimals) -> a plain decimal string, for the "Available" line.
 *  Local and tiny on the same principle as LiveSendMonero's piconeroToText:
 *  Set A's formatTao does the SAME job for every number this screen actually
 *  SENDS (the plan review), this one only ever fills a read-only line. */
function formatRaoForDisplay(rao: bigint): string {
  const s = rao.toString().padStart(10, '0');
  const whole = s.slice(0, -9) || '0';
  const frac = s.slice(-9).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}
