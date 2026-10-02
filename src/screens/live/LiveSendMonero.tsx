// Send screen for a Monero wallet (Monero engine design §10, §15 Set C).
//
// Same three-step shape (form -> review -> success) and the same arming
// discipline (a real-money warning banner, an explicit "I understand" check,
// the wallet password when the user asked to be asked) as LiveSend.tsx and
// LiveSendEvm.tsx, so a Monero send FEELS like every other send in this
// wallet. What is genuinely different, because the chain is different:
//
//   - the fee is not previewed from a typical size, it is the REAL fee of the
//     transaction wallet2 already built (createTx({relay:false}), §6/§10);
//   - "Max" is a sweep, not a computed amount: the exact spendable total is
//     not knowable client-side before the ring signatures are chosen, so the
//     wallet does not pretend to compute it and asks the host to sweep;
//   - priority is three discrete levels (Unimportant/Normal/Elevated), not
//     gwei or sat/vByte;
//   - there is no nonce and no input picker in this UI — wallet2 owns that.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, AlertTriangle, CheckCircle } from 'lucide-react';
import { Button } from '../../components/Button';
import { TextField, PasswordField } from '../../components/TextField';
import { TokenIcon } from '../../components/BrandLogo';
import { useLiveStore, walletsOnChain } from '../../store/liveStore';
import { buildMoneroSendPlan, broadcastMoneroPlan, MoneroSendError, type MoneroSendPlan } from '../../store/moneroSend';
import { MONERO_TARGET, moneroExplorerTxUrl } from '../../store/moneroChains';
import type { MoneroPriority } from '../../services/chain/monero/fees';
import { isValidMoneroAddress } from '../../services/chain/monero/address';
import { LiveNav } from './LiveNav';
import { ContactsPicker, MyWalletsPicker, SaveContactPanel } from './RecipientPickers';

interface LiveSendMoneroProps {
  onBack(): void;
  onDone?(): void;
}

type SendStep = 'form' | 'review' | 'success';

/** How long the success screen lingers before auto-returning home — same
 *  pause LiveSend.tsx uses, so a Monero send does not feel snappier or
 *  slower than any other chain's. */
const SUCCESS_AUTO_RETURN_MS = 4_000;

const PRIORITIES: readonly MoneroPriority[] = ['unimportant', 'normal', 'elevated'];
const PRIORITY_LABEL: Record<MoneroPriority, string> = {
  unimportant: 'Unimportant',
  normal: 'Normal',
  elevated: 'Elevated',
};

/** Percentage fills read straight off the UNLOCKED balance (§10: "Unlocked
 *  balance is what can be spent"). Unlike Max, these do not subtract a fee —
 *  the exact fee is unknown until the host builds the transaction, same
 *  limitation the UTXO percentage chips already accept (see LiveSend.tsx). */
function pctOfUnlocked(unlockedPico: bigint, pct: number): bigint {
  return (unlockedPico * BigInt(pct)) / 100n;
}

/** bigint piconero -> plain decimal text at Monero's 12-decimal scale, for the
 *  amount field's percentage fills. Local and tiny on purpose: Set A's
 *  formatXmr does the SAME job for every number this screen actually SENDS
 *  (the plan review), this one only ever fills a text input the user can edit
 *  further, so it stays independent of Set A's exact trimming rules. */
function piconeroToText(pico: bigint): string {
  const s = pico.toString().padStart(13, '0');
  const whole = s.slice(0, -12) || '0';
  const frac = s.slice(-12).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

/** A raw wallet2/monero-ts error string -> a sentence a user can act on. Most
 *  of what reaches here is already plain English from the C++ wallet; this
 *  only rewords the ones a user would otherwise have to guess at, mirroring
 *  LiveSend.tsx's friendlyError in spirit (map the few known shapes, pass
 *  everything else through unchanged rather than swallowing information). */
export function friendlyMoneroSendError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const low = raw.toLowerCase();
  if (err instanceof MoneroSendError && err.code === 'no-wallet') return raw;
  // wallet2's insufficient-funds family: "not enough money", "not enough
  // unlocked money", and for a sweep of an empty wallet "No unlocked balance
  // in the specified account".
  if (
    low.includes('not enough money') ||
    low.includes('not enough unlocked money') ||
    low.includes('no unlocked balance') ||
    low.includes('not enough unlocked balance')
  ) {
    return 'Insufficient unlocked XMR balance for this transaction (amount plus the network fee). Wait for locked funds to unlock, or reduce the amount.';
  }
  // A sweep or a send that would not fit in one transaction (MoneroWalletError
  // 'sweep-multiple', or wallet2's own "transaction would be too large").
  if (low.includes('more than one transaction') || low.includes('too large') || low.includes('too big')) {
    return 'This send would need more than one Monero transaction. Send a smaller amount, or send in two steps.';
  }
  // wallet2 could not find enough decoy outputs for the ring (a fresh or
  // very small output set on the node's side).
  if (low.includes('not enough outputs') || low.includes('output not found')) {
    return 'The Monero node could not gather enough decoys for this transaction right now. Try again in a moment.';
  }
  // wallet2 refuses a destination it cannot pay to at all.
  if (low.includes('zero destination') || low.includes('no destinations')) {
    return 'Enter an amount greater than 0.';
  }
  if (low.includes('daemon is busy') || low.includes('unreachable') || low.includes('timeout') || low.includes('network')) {
    return 'The Monero network could not be reached through the gateway. Try again in a moment.';
  }
  return raw;
}

export function LiveSendMonero({ onBack, onDone }: LiveSendMoneroProps) {
  const host = useLiveStore((s) => s.monero.host);
  const chain = useLiveStore((s) => s.monero.chain);
  const balance = useLiveStore((s) => s.monero.balance);
  const wallets = useLiveStore((s) => s.wallets);
  const activeWalletId = useLiveStore((s) => s.activeWalletId);
  const addressBook = useLiveStore((s) => s.addressBook);
  const addContact = useLiveStore((s) => s.addContact);
  const requirePasswordToSend = useLiveStore((s) => s.requirePasswordToSend);
  const verifyPassword = useLiveStore((s) => s.verifyPassword);
  const arm = useLiveStore((s) => s.arm);
  const refresh = useLiveStore((s) => s.refresh);

  const activeWallet = wallets.find((w) => w.id === activeWalletId);
  // Same password-gating rule as every other Send screen (LiveSend.tsx,
  // LiveSendEvm.tsx): a passwordless wallet, or one with the "do not ask when
  // sending" convenience on, skips the password step entirely.
  const isPasswordless = (activeWallet?.passwordless ?? false) || (activeWallet?.noSendPassword ?? false);
  const requirePassword = requirePasswordToSend && !isPasswordless;

  // The wallet's OWN answer, read when the form opens: the store's copy is
  // only refreshed by the Home poll and can be stale (or still empty during a
  // first sync) while wallet2 already has spendable outputs. A stale 0 here
  // greyed out Max although a 75% send went through (owner, 2026-10-02).
  const [liveUnlocked, setLiveUnlocked] = useState<bigint | null>(null);
  useEffect(() => {
    if (!host || typeof host.balance !== 'function') return;
    let cancelled = false;
    Promise.resolve()
      .then(() => host.balance())
      .then((b) => {
        if (!cancelled) setLiveUnlocked(b.unlocked);
      })
      .catch(() => {
        /* keep the store's figure */
      });
    return () => {
      cancelled = true;
    };
  }, [host]);
  const unlockedPico = liveUnlocked ?? balance?.unlocked ?? 0n;

  // The user's OTHER Monero wallets (an import beside the seed sibling), so
  // funds can move between them in one tap. Scoped to the Monero target by
  // walletsOnChain, the same rule every other Send screen follows: a UTXO or
  // EVM wallet can never receive XMR and is never offered.
  const myWallets = walletsOnChain(wallets, MONERO_TARGET).filter((w) => w.id !== activeWalletId && w.address);
  // The address book is one flat list across chains; only the entries that
  // decode as a mainnet Monero address belong on this screen.
  const chainContacts = addressBook.filter((c) => isValidMoneroAddress(c.address));

  const [step, setStep] = useState<SendStep>('form');
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [priority, setPriority] = useState<MoneroPriority>('normal');
  const [sweep, setSweep] = useState(false);
  const [fieldError, setFieldError] = useState('');
  const [building, setBuilding] = useState(false);
  const [plan, setPlan] = useState<MoneroSendPlan | null>(null);

  const [armed, setArmed] = useState(false);
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [broadcasting, setBroadcasting] = useState(false);
  const [broadcastError, setBroadcastError] = useState('');
  // After a relay that FAILED: the wallet is refreshed before the user may
  // build another transaction. A failed relay is not proof the node did not
  // take the transaction (a gateway 502 or timeout can arrive after monerod
  // put it in its pool), and until wallet2 has seen the pool it still counts
  // those inputs as unspent, so a rebuilt send could pay the recipient twice.
  const [settling, setSettling] = useState(false);
  const [successTxid, setSuccessTxid] = useState('');

  const handleDone = useCallback(() => {
    void refresh({ silent: true });
    (onDone ?? onBack)();
  }, [refresh, onDone, onBack]);

  const doneRef = useRef(handleDone);
  useEffect(() => {
    doneRef.current = handleDone;
  }, [handleDone]);
  useEffect(() => {
    if (step !== 'success') return;
    const timer = setTimeout(() => doneRef.current(), SUCCESS_AUTO_RETURN_MS);
    return () => clearTimeout(timer);
  }, [step]);

  const setAmountManual = (val: string) => {
    setAmount(val);
    setSweep(false);
  };

  const fillPct = (pct: number) => {
    const value = pctOfUnlocked(unlockedPico, pct);
    setAmount(value > 0n ? piconeroToText(value) : '0');
    setSweep(false);
  };

  // Max is still a sweep (wallet2 picks the inputs and the exact fee), but the
  // field shows what that sweep sends: the open wallet builds it once, signed
  // and NEVER relayed, to this wallet's own address, and its outgoing amount is
  // filled in (owner, 2026-10-02: Max must show a number in every wallet).
  const [maxLoading, setMaxLoading] = useState(false);
  const fillMaxAmount = async (forPriority: MoneroPriority) => {
    const own = activeWallet?.address;
    if (!host || !own) return;
    setMaxLoading(true);
    try {
      const draft = await host.buildTx({ to: own, amountPico: 0n, priority: forPriority, sweep: true });
      setAmount(piconeroToText(draft.amount));
    } catch (err) {
      setSweep(false);
      setAmount('');
      setFieldError(friendlyMoneroSendError(err));
    } finally {
      setMaxLoading(false);
    }
  };

  const toggleMax = () => {
    setSweep(true);
    setAmount('');
    setFieldError('');
    void fillMaxAmount(priority);
  };

  const trimmedTo = to.trim();
  const alreadySaved = chainContacts.some((c) => c.address === trimmedTo);
  const isOwnWallet = myWallets.some((w) => w.address === trimmedTo);
  const canSaveContact = isValidMoneroAddress(trimmedTo) && !alreadySaved && !isOwnWallet;

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
    if (!sweep) {
      if (!amount.trim()) {
        setFieldError('Enter an amount, or use Max to sweep your whole spendable balance.');
        return;
      }
    }

    setBuilding(true);
    try {
      const result = await buildMoneroSendPlan({ to: to.trim(), amount, priority, sweep });
      setPlan(result);
      setStep('review');
    } catch (err) {
      if (err instanceof MoneroSendError && (err.code === 'invalid-address' || err.code === 'invalid-amount')) {
        setFieldError(err.message);
      } else {
        setFieldError(friendlyMoneroSendError(err));
      }
    } finally {
      setBuilding(false);
    }
  };

  const handleBack = () => {
    if (step === 'review') {
      if (settling) return; // the refresh after a failed relay has not run yet
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
      const { txid } = await broadcastMoneroPlan(plan);
      setSuccessTxid(txid);
      setStep('success');
    } catch (err) {
      setBroadcastError(friendlyMoneroSendError(err));
      // Refresh before Back is allowed (see `settling`). Retrying THIS draft
      // (Confirm & Send again) stays open: a repeat relay of the same
      // transaction is a repeat of the same inputs, never a second payment.
      setSettling(true);
      Promise.resolve(refresh({ silent: true }))
        .catch(() => {})
        .finally(() => setSettling(false));
    } finally {
      setBroadcasting(false);
      arm(false);
      setArmed(false);
    }
  };

  if (!host) {
    return (
      <div className="app-frame screen-enter">
        <div className="sub-header">
          <button type="button" className="icon-btn" onClick={onBack} aria-label="Back">
            <ChevronLeft size={20} />
          </button>
          <h2>Send Monero</h2>
          <span />
        </div>
        <div className="app-content">
          <div className="banner danger" data-testid="live-xmr-send-closed">
            Your Monero wallet is not open. Unlock it to send.
          </div>
        </div>
        <LiveNav />
      </div>
    );
  }

  const explorerUrl = chain && successTxid ? moneroExplorerTxUrl(chain, successTxid) : null;

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
            <p>Your transaction has been submitted to the Monero network.</p>
            <div className="card" style={{ marginTop: 16, width: '100%', textAlign: 'left' }} data-testid="live-xmr-send-txid">
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
                data-testid="live-xmr-send-explorer-link"
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
        <div className="app-content send-pinned" data-testid="live-xmr-send-review">
          <div className="send-scroll">
            <div className="banner warning" style={{ marginBottom: 14 }}>
              <AlertTriangle size={14} />
              This broadcasts a real XMR transaction to the Monero network. Sends cannot be undone.
            </div>

            {plan.warnings.map((w, i) => (
              <div className="banner info" style={{ marginBottom: 10 }} key={i} data-testid={`live-xmr-send-warning-${i}`}>
                {w}
              </div>
            ))}

            <div className="card solid" style={{ marginBottom: 14 }}>
              <div className="summary-table">
                <div className="sum-row">
                  <span className="sum-key">To</span>
                  <span className="sum-val mono" style={{ fontSize: 11, wordBreak: 'break-all' }}>{plan.draft.destination}</span>
                </div>
                <div className="sum-row">
                  <span className="sum-key">Amount</span>
                  <span className="sum-val" data-testid="live-xmr-send-amount-row">
                    {plan.amountXmr} XMR{plan.draft.sweep ? ' (sweep)' : ''}
                  </span>
                </div>
                <div className="sum-row" data-testid="live-xmr-send-fee">
                  <span className="sum-key">Network fee</span>
                  <span className="sum-val">{plan.feeXmr} XMR</span>
                </div>
                <div className="sum-row" data-testid="live-xmr-send-total">
                  <span className="sum-key">Total</span>
                  <span className="sum-val">{plan.totalXmr} XMR</span>
                </div>
                <div className="sum-row">
                  <span className="sum-key">Priority</span>
                  <span className="sum-val">{PRIORITY_LABEL[priority]}</span>
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
                data-testid="live-xmr-arm-checkbox"
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
                  I understand this sends real XMR and cannot be undone.
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
                  testId="live-xmr-send-password"
                />
                {passwordError && (
                  <span
                    role="alert"
                    data-testid="live-xmr-send-password-error"
                    style={{ fontSize: 11.5, color: 'var(--danger)', display: 'block', marginTop: 4 }}
                  >
                    {passwordError}
                  </span>
                )}
              </div>
            )}

            {broadcastError && (
              <div className="banner danger" style={{ marginBottom: 14 }} data-testid="live-xmr-send-error">
                {broadcastError}
                <span style={{ display: 'block', marginTop: 4, fontWeight: 400 }}>
                  The network may still have accepted it. Transaction ID {plan.draft.hash.slice(0, 12)}... Check Activity after
                  the next refresh before sending again; sending this same transaction again is safe, building a new one is not.
                </span>
              </div>
            )}

            <div style={{ display: 'flex', gap: 9 }}>
              <Button variant="secondary" onClick={handleBack} disabled={settling} loading={settling}>Back</Button>
              <Button
                block
                variant="danger"
                disabled={sendDisabled}
                loading={broadcasting}
                onClick={() => void handleBroadcast()}
                data-testid="live-xmr-broadcast"
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
        <h2>Send XMR</h2>
        <span />
      </div>
      <div className="app-content send-pinned">
        <form onSubmit={(e) => { void handleBuild(e); }}>
          <div className="send-scroll">
            <TextField
              label="Recipient address"
              placeholder="Monero address"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              testId="live-xmr-send-to"
            />

            {/* The same three recipient helpers as every other Send screen
                (RecipientPickers.tsx): own Monero wallets, Monero contacts,
                and saving a typed recipient. */}
            <MyWalletsPicker wallets={myWallets} current={trimmedTo} onPick={fillRecipient} testIdPrefix="live-xmr-send" />
            <ContactsPicker contacts={chainContacts} onPick={fillRecipient} testIdPrefix="live-xmr-send" />
            <SaveContactPanel
              canSave={canSaveContact}
              recipient={trimmedTo}
              onSave={(label) => addContact(label, trimmedTo)}
              testIdPrefix="live-xmr-send"
            />

            <TextField
              label="Amount (XMR)"
              placeholder="0.00"
              type="text"
              inputMode="decimal"
              value={amount}
              disabled={sweep}
              onChange={(e) => setAmountManual(e.target.value)}
              testId="live-xmr-send-amount"
              error={fieldError || undefined}
              hint={sweep ? (maxLoading ? 'Working out the exact amount…' : 'Your entire spendable (unlocked) balance, after the network fee.') : undefined}
            />

            <div className="text-dim" data-testid="live-xmr-send-available" style={{ fontSize: 11.5, margin: '6px 2px 8px' }}>
              Available (unlocked): {piconeroToText(unlockedPico)} XMR
              {balance && balance.total > unlockedPico ? (
                <span data-testid="live-xmr-send-locked">
                  {' '}
                  · {piconeroToText(balance.total - unlockedPico)} XMR still locked (new funds unlock after 10
                  confirmations, about 20 min)
                </span>
              ) : null}
            </div>

            <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
              {[25, 50, 75].map((pct) => (
                <button
                  key={pct}
                  type="button"
                  className="chip neutral"
                  data-testid={`live-xmr-send-amt-${pct}`}
                  onClick={() => fillPct(pct)}
                  disabled={unlockedPico === 0n}
                  style={{
                    flex: 1,
                    justifyContent: 'center',
                    cursor: unlockedPico === 0n ? 'not-allowed' : 'pointer',
                    opacity: unlockedPico === 0n ? 0.5 : 1,
                  }}
                >
                  {pct}%
                </button>
              ))}
              {/* Max is a sweep of the UNLOCKED balance: with nothing unlocked
                  there is nothing to sweep, and wallet2 would only answer with
                  its raw "No unlocked balance in the specified account". */}
              <button
                type="button"
                className={sweep ? 'chip' : 'chip neutral'}
                data-testid="live-xmr-send-sweep"
                aria-pressed={sweep}
                disabled={unlockedPico === 0n}
                title={unlockedPico === 0n ? 'Nothing to sweep: no unlocked XMR balance yet.' : undefined}
                onClick={toggleMax}
                style={{
                  flex: 1,
                  justifyContent: 'center',
                  cursor: unlockedPico === 0n ? 'not-allowed' : 'pointer',
                  opacity: unlockedPico === 0n ? 0.5 : 1,
                }}
              >
                Max
              </button>
            </div>

            <div className="section-label">Priority</div>
            <div className="card" data-testid="live-xmr-send-priority" style={{ marginBottom: 10, padding: 12 }}>
              <div style={{ display: 'flex', gap: 6 }}>
                {PRIORITIES.map((p) => {
                  const isPicked = priority === p;
                  return (
                    <button
                      key={p}
                      type="button"
                      className={isPicked ? 'chip' : 'chip neutral'}
                      data-testid={`live-xmr-send-priority-${p}`}
                      aria-pressed={isPicked}
                      onClick={() => {
                        setPriority(p);
                        if (sweep) void fillMaxAmount(p);
                      }}
                      style={{ flex: 1, justifyContent: 'center', cursor: 'pointer' }}
                    >
                      {PRIORITY_LABEL[p]}
                    </button>
                  );
                })}
              </div>
              <p className="text-dim" style={{ fontSize: 11, margin: '8px 0 0', lineHeight: 1.5 }}>
                Higher priority pays a larger network fee for faster confirmation. The exact fee is shown on the
                next screen.
              </p>
            </div>

            <div className="token-row" style={{ marginBottom: 10 }}>
              <TokenIcon assetId="XMR" size={30} />
              <div style={{ minWidth: 0, marginLeft: 8, flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 13 }}>XMR</div>
                <div className="text-dim" style={{ fontSize: 11.5 }}>Monero</div>
              </div>
            </div>
          </div>

          <div className="send-cta">
            <Button type="submit" block loading={building} data-testid="live-xmr-send-submit">
              Review transaction
            </Button>
          </div>
        </form>
      </div>
      <LiveNav />
    </div>
  );
}
