import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, AlertTriangle, CheckCircle, BookUser, Check, Wallet } from 'lucide-react';
import { Button } from '../../components/Button';
import { TextField, PasswordField } from '../../components/TextField';
import { TokenIcon } from '../../components/BrandLogo';
import { useLiveStore, computeDisplayedAssets, walletsOnChain } from '../../store/liveStore';
import { isValidAddress, isSpendableAddress } from '../../services/chain/keys';
import { supportsSegwit } from '../../services/chain/chainParams';
import { networkFor } from '../../services/chain/chainParams';
import { distinctFeeOptions } from '../../services/chain/feePolicy';
import { isLegacyAsset } from '../../services/assetNotes';
import type { FeeEstimate, LiveSendPlan, LiveNetworkId } from '../../services/chain/liveWallet';
import { estimateTxBytes } from '../../services/chain/txBuilder';
import { ELECTRUM_CLOSED, ELECTRUM_NOT_CONNECTED } from '../../services/chain/electrumClient';
import { LiveNav } from './LiveNav';
import type { NativeTicker } from '../../services/chain/chainParams';

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

/**
 * Typical transaction sizes (bytes) used only to PREVIEW a fee amount before
 * the real transaction is built. These are UTXO chains: the fee is rate × the
 * transaction's actual size, and the size is unknown until the inputs are
 * selected at build time — so the form shows "~amount at a typical size" and
 * the review shows the exact fee of the actually-built transaction.
 *   - native send: 1 input, 2 outputs (payment + change);
 *   - asset transfer: 1 asset + 1 native input, asset out + asset change +
 *     native change, padded ~60 bytes per asset-script output (mirrors the
 *     builder's own padding in buildAssetSend).
 */
const TYPICAL_SEND_TX_BYTES = estimateTxBytes(1, 2);
const TYPICAL_ASSET_TX_BYTES = estimateTxBytes(2, 3) + 120;

/** Presentation for the engine's fee targets (2/6/25 blocks — fastest first).
 *  An unexpected target still renders (generic label), it just isn't named. */
const SPEED_META: Record<number, { key: string; label: string }> = {
  2: { key: 'fast', label: 'Fast' },
  6: { key: 'normal', label: 'Normal' },
  25: { key: 'slow', label: 'Slow' },
};

function speedMetaFor(targetBlocks: number): { key: string; label: string } {
  return SPEED_META[targetBlocks] ?? { key: `t${targetBlocks}`, label: `${targetBlocks} blocks` };
}

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

/** Turn a raw build/broadcast error code into a clear, human message.
 *  `native` is the active chain's ticker and `chainName` its display name, both
 *  looked up from the chain params, so a message never names the wrong chain. */
function friendlyError(msg: string, assetId: string, native: NativeTicker, chainName: string): string {
  switch (msg) {
    case 'insufficient-asset':
      return `Insufficient ${assetId} balance for this transfer.`;
    case 'insufficient-evr-for-fee':
      return `Not enough ${native} to cover the network fee for this asset transfer.`;
    case 'invalid-amount-precision':
      return `That amount is finer than ${assetId} allows. Reduce the number of decimals.`;
    case 'unknown-asset':
      return `Asset "${assetId}" was not found on the ${chainName} network.`;
    case 'invalid-amount':
      return 'Enter a valid amount greater than 0.';
    case 'insufficient-funds':
      return `Insufficient ${native} balance for this transaction (amount + network fee).`;
    case 'unsupported-address-type':
      return `That is not a standard ${chainName} address. Script and wrong-network addresses are rejected.`;
    case 'input-verify-failed':
    case 'input-value-mismatch':
      return 'Could not verify your coins against the network (the server may be faulty or malicious). Nothing was sent. Try another Electrum server in Settings.';
    case 'broadcast-unconfirmed':
      return 'The server had a problem and the transaction could not be confirmed as sent. Nothing appears on the network. It is safe to try again.';
    case ELECTRUM_NOT_CONNECTED:
    case ELECTRUM_CLOSED:
      // Reachable by tapping Review in the seconds after a chain switch, before
      // that chain's socket is up. Nothing was built and nothing was sent.
      return `Still connecting to the ${chainName} network. Wait a moment and try again.`;
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
  const estimateFeeOptions = useLiveStore((s) => s.estimateFeeOptions);

  // A passwordless wallet has no password to confirm — skip the whole password
  // step (no `live-send-password` field). Otherwise honour the user setting.
  const activeWallet = wallets.find((w) => w.id === activeWalletId);
  const isPasswordless = activeWallet?.passwordless ?? false;
  const requirePassword = requirePasswordToSend && !isPasswordless;

  // The active wallet's chain (defaults to Evrmore mainnet, same as the store's
  // own default) drives address validation + every chain-aware label below.
  const activeNet = networkFor((activeWallet?.network as LiveNetworkId | undefined) ?? 'mainnet');
  const nativeTicker = activeNet.ticker;

  // Resolve which asset we're sending. Absent / the chain's native ticker => the
  // native coin (EVR on Evrmore, RVN on Ravencoin).
  const assetId = asset && asset.toUpperCase() !== nativeTicker ? asset.toUpperCase() : nativeTicker;
  const isAsset = assetId !== nativeTicker;

  // Displayed (spendable) balance for the selected asset — the same list the
  // home screen shows. The native coin is always present; an asset falls back to
  // a raw balance lookup (or 0) if it isn't in the displayed set.
  const displayedAssets = computeDisplayedAssets(assets, pinnedAssets, hiddenAssets);
  const balanceRow =
    displayedAssets.find((a) => a.name === assetId) ?? assets.find((a) => a.name === assetId);
  const availableBalance = balanceRow?.amount ?? 0;
  const assetDecimals = balanceRow?.decimals ?? 8;

  // Every asset transfer pays its network fee exclusively from the chain's native
  // UTXOs (LiveWalletService.buildAssetSend -> 'insufficient-evr-for-fee'). With
  // 0 native balance, no asset can ever be sent, no matter the asset amount.
  // Detect that up front (same `assets` list the rest of the screen reads the
  // native balance from) and block the send before the user hits the build-time
  // error. Nonzero-but-insufficient native balance still flows to the existing
  // build-time error, since the exact fee isn't known until build.
  const evrBalance = assets.find((a) => a.isNative || a.name === nativeTicker)?.amount ?? 0;
  const noEvrForGas = isAsset && evrBalance === 0;

  // Other wallets you own (skip the active one + any with no known address) so
  // funds can be moved between your wallets in one tap. Scoped to the ACTIVE
  // chain: cross-chain sends are impossible (an R... wallet cannot receive EVR and
  // vice versa), so wallets on other chains must never be offered as recipients.
  // Same rule for every future chain.
  const myWallets = walletsOnChain(wallets, activeWallet?.network).filter(
    (w) => w.id !== activeWalletId && w.address,
  );

  // Address-book entries are plain addresses with no chain tag, so scope them by
  // what the address itself decodes to: only P2PKH addresses of the ACTIVE chain
  // are offered (an EVR contact on a Ravencoin wallet is a guaranteed error).
  // Address-book entries are scoped to the active chain, and to the address
  // types this chain can actually pay to (segwit included where available).
  const chainContacts = addressBook.filter((c) => isSpendableAddress(c.address, activeNet));

  const [step, setStep] = useState<SendStep>('form');
  const [to, setTo] = useState('');
  // Name of the own wallet the recipient was quick-picked from ('' = none).
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
  // fee it deducts is shown in the fee note.
  const [maxLoading, setMaxLoading] = useState(false);
  const [maxUsed, setMaxUsed] = useState(false);
  const [maxFeeEvr, setMaxFeeEvr] = useState<number | null>(null);

  // --- network fee choice ---------------------------------------------------
  // The chain's fee options (fetched once on mount). null only while loading:
  // the store action never rejects — an offline/useless server resolves to the
  // chain's policy defaults, so the send is never blocked on this.
  const [feeEstimate, setFeeEstimate] = useState<FeeEstimate | null>(null);
  // targetBlocks of the picked speed option (differentiated chains only);
  // null = the wallet's long-standing 6-block "normal" target.
  const [pickedTarget, setPickedTarget] = useState<number | null>(null);
  // Custom sat/byte rate: open/closed + raw input text ('' = none entered, so
  // the picked/auto rate still applies).
  const [customOpen, setCustomOpen] = useState(false);
  const [customText, setCustomText] = useState('');
  // Rate the last Max estimate was computed at (null = server-probed rate).
  const lastMaxRateRef = useRef<bigint | null>(null);

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

  // Non-blocking: fetch the chain's fee options once so the fee panel can show
  // the real rate(s) and amounts. The store action never rejects (an offline
  // server resolves to the chain's policy defaults); the chainId guard drops a
  // stale estimate if the active chain somehow changed mid-flight.
  useEffect(() => {
    let cancelled = false;
    void estimateFeeOptions()
      .then((est) => {
        if (!cancelled && est.chainId === activeNet.chainId) setFeeEstimate(est);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [estimateFeeOptions, activeNet.chainId]);

  // --- fee choice derivation ------------------------------------------------
  // Effective option when nothing is picked: the 6-block "normal" target, the
  // wallet's long-standing single-probe target (middle of the offered set).
  const feeOptions = feeEstimate?.options ?? [];
  const autoOption = feeOptions.find((o) => o.targetBlocks === 6) ?? feeOptions[1] ?? feeOptions[0];
  const pickedOption =
    feeEstimate?.differentiated && pickedTarget !== null
      ? feeOptions.find((o) => o.targetBlocks === pickedTarget) ?? autoOption
      : autoOption;

  // Custom rate, validated against the chain's real floor/ceiling for immediate
  // feedback. DISPLAY validation only: the wallet service independently
  // re-clamps whatever rate reaches it, so nothing here is a safety boundary.
  const trimmedCustom = customText.trim();
  let customRate: bigint | null = null;
  let customError = '';
  if (customOpen && trimmedCustom !== '' && feeEstimate) {
    if (!/^\d+$/.test(trimmedCustom)) {
      customError = 'Enter a whole number of sat/byte.';
    } else {
      const v = BigInt(trimmedCustom);
      if (v < feeEstimate.floorSatPerByte) {
        customError = `Too low. This network does not relay transactions under ${feeEstimate.floorSatPerByte.toString()} sat/byte.`;
      } else if (v > feeEstimate.ceilingSatPerByte) {
        customError = `Too high. This wallet caps the rate at ${feeEstimate.ceilingSatPerByte.toString()} sat/byte on this network.`;
      } else {
        customRate = v;
      }
    }
  }

  // The rate the send is actually built at (undefined only while the estimate
  // is still loading; the wallet then probes the server itself, as before).
  const effectiveRate: bigint | undefined =
    customOpen && customRate !== null ? customRate : pickedOption?.satPerByte;
  // Rate shown in the headline (falls back to the chain default for safety;
  // in practice effectiveRate is always set once the estimate has loaded).
  const headlineRate: bigint | null = effectiveRate ?? feeEstimate?.defaultSatPerByte ?? null;

  // ~fee amount (in the chain's own coin) at `rate` for a typical transaction
  // size. These are UTXO chains: the exact fee follows the built transaction's
  // size, so the form previews and the review states the exact number.
  const typicalTxBytes = isAsset ? TYPICAL_ASSET_TX_BYTES : TYPICAL_SEND_TX_BYTES;
  const feePreviewDecimal = (rate: bigint): number => Number(rate * BigInt(typicalTxBytes)) / 1e8;

  // Honest label for where the headline rate comes from: a degraded probe is
  // named as the default, never passed off as a live estimate.
  const rateSourceLabel =
    customOpen && customRate !== null
      ? 'custom rate'
      : pickedOption && !pickedOption.estimated
      ? 'network default rate'
      : feeEstimate?.differentiated && pickedOption
      ? `about ${pickedOption.targetBlocks} blocks`
      : 'current network rate';

  // Keep a Max-filled amount honest when the chosen rate changes afterwards:
  // Max = balance − fee(rate), so a rate change silently invalidates it (too
  // high -> insufficient-funds at build; too low -> coins left behind). Small
  // debounce so typing a custom rate doesn't fire a UTXO query per keystroke.
  useEffect(() => {
    if (isAsset || !maxUsed) return;
    if (lastMaxRateRef.current === (effectiveRate ?? null)) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void estimateMaxEvr(effectiveRate)
        .then(({ maxDecimal, feeDecimal }) => {
          if (cancelled) return;
          lastMaxRateRef.current = effectiveRate ?? null;
          setAmount(maxDecimal > 0 ? fmtBalance(maxDecimal, 8) : '0');
          setMaxFeeEvr(feeDecimal);
        })
        .catch(() => {});
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [isAsset, maxUsed, effectiveRate, estimateMaxEvr]);

  const toggleCustomRate = () => {
    if (customOpen) {
      setCustomOpen(false);
      setCustomText('');
    } else {
      setCustomOpen(true);
    }
  };

  const trimmedTo = to.trim();
  const alreadySaved = addressBook.some((c) => c.address === trimmedTo);
  // Don't offer "Save to address book" for one of your OWN wallets: it is already
  // in the My-wallets list, so saving it as a contact is redundant.
  const isOwnWallet = myWallets.some((w) => w.address === trimmedTo);
  const canSaveContact = isValidAddress(trimmedTo) && !alreadySaved && !isOwnWallet;

  const fillRecipient = (addr: string) => {
    setTo(addr);
    setContactSaved(false);
    setSavingContact(false);
  };

  // Quick-pick one of your own wallets: fills the recipient. The picked wallet is
  // shown by HIGHLIGHTING its own chip (below), not by a separate confirmation line
  // that would shift the layout, so it stays obvious even with many wallets.
  const pickMyWallet = (addr: string) => {
    fillRecipient(addr);
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
    // Computed at the CHOSEN fee rate so Max stays consistent with the fee the
    // send is actually built at (the re-estimate effect keeps it so later).
    setMaxLoading(true);
    try {
      const { maxDecimal, feeDecimal } = await estimateMaxEvr(effectiveRate);
      lastMaxRateRef.current = effectiveRate ?? null;
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

  // Contextual fee note inside the fee panel. Interpolating `nativeTicker`
  // reproduces the exact historical 'EVR' wording on an Evrmore wallet
  // (nativeTicker === 'EVR'), and reads correctly on every other chain. The
  // amount itself now lives in the panel headline; this line carries what the
  // headline cannot: where the fee is paid from, and (after Max) the exact fee
  // the Max amount already deducts.
  const feeNote = isAsset
    ? `Network fee: paid in ${nativeTicker} (from your ${nativeTicker} balance).`
    : maxUsed && maxFeeEvr != null
    ? `Network fee: ~${fmtBalance(maxFeeEvr, 8)} ${nativeTicker} (deducted from Max)`
    : `Network fee: deducted from your ${nativeTicker} balance at review. The exact fee follows the transaction's size.`;

  // The store keeps raw error codes; map them for display on this screen.
  const mappedStoreError = storeError ? friendlyError(storeError, assetId, nativeTicker, activeNet.displayName) : null;

  const handleBuild = async (e: React.FormEvent) => {
    e.preventDefault();
    setFieldError('');

    if (!to.trim()) {
      setFieldError('Recipient address is required.');
      return;
    }
    if (!isValidAddress(to.trim())) {
      setFieldError(`Invalid ${activeNet.displayName} address.`);
      return;
    }
    // Only recipients the builder can actually pay to are accepted: standard
    // P2PKH on every chain, plus native segwit (P2WPKH) on chains that have it.
    // isValidAddress deliberately passes more than that (P2SH, and on a segwit
    // chain also P2WSH/taproot), and paying to a script this wallet cannot
    // construct would burn the funds. Checked against the ACTIVE WALLET's chain,
    // so a wrong-network address is rejected here too.
    if (!isSpendableAddress(to.trim(), activeNet)) {
      setFieldError(
        supportsSegwit(activeNet)
          ? `Enter a standard ${activeNet.displayName} address (${activeNet.bech32Hrp}1...). Script and wrong-network addresses are rejected.`
          : `Enter a standard ${activeNet.displayName} address. Script and wrong-network addresses are rejected.`,
      );
      return;
    }
    const amountNum = parseFloat(amount);
    if (!amount || isNaN(amountNum) || amountNum <= 0) {
      setFieldError('Enter a valid amount greater than 0.');
      return;
    }
    // A custom rate outside the chain's bounds is never submitted; the inline
    // message under the rate input already explains the refusal. (The service
    // would re-clamp it anyway; refusing here keeps the UI honest instead of
    // silently building at a different rate than the one typed.)
    if (customOpen && trimmedCustom !== '' && customRate === null) {
      return;
    }

    const result = await buildSend(to.trim(), amountNum, assetId, effectiveRate);
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

  const handleArmToggle = (val: boolean) => {
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

  // The unit shown on the review's amount row (asset name for asset sends; the
  // chain's native ticker for a native send).
  const amountUnit = plan?.assetName ?? nativeTicker;
  // "EVRmore"/"Ravencoin network" mention on the review + success screens. Kept
  // as an explicit branch (not net.displayName) so the Evrmore wording stays the
  // exact historical "EVRmore network" the live smoke asserts on.
  const chainNetworkName = `${activeNet.displayName} network`;

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
            <p>Your transaction has been submitted to the {chainNetworkName}.</p>
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
            This broadcasts a real {amountUnit} transaction to the {chainNetworkName}. Sends cannot be undone.
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
                <span className="sum-val">{fmtSats(plan.feeSats)} {nativeTicker}</span>
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
            {/* Custom check tile (same design as the onboarding ack tiles) in
                the arm's danger accent. role="checkbox" + aria-checked kept so
                Playwright .check()/.uncheck() still drive it. */}
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
      {/* send-pinned: the fields scroll in .send-scroll below while the CTA row
          (.send-cta, with the no-gas + store-error banners) stays pinned above
          the bottom nav — the primary action can never be clipped by it. See
          global.css. */}
      <div className="app-content send-pinned">
        <form onSubmit={handleBuild}>
          <div className="send-scroll">
          <TextField
            label="Recipient address"
            placeholder={`${activeNet.displayName} address`}
            value={to}
            onChange={(e) => { setTo(e.target.value); setContactSaved(false); }}
            testId="live-send-to"
          />

          {/* Quick-pick your OWN wallets: one tap fills the recipient. The chosen
              wallet's chip highlights green (matched by address, so it survives
              duplicate names and clears itself when you edit the recipient). No
              separate confirmation line, so picking never shifts the layout. */}
          {myWallets.length > 0 && (
            <div data-testid="live-send-my-wallets" style={{ margin: '10px 0 12px' }}>
              <div className="section-label" style={{ marginTop: 0, marginBottom: 6 }}>My wallets</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {myWallets.map((w, i) => {
                  const isPicked = !!w.address && trimmedTo === w.address;
                  return (
                    <button
                      key={w.id}
                      type="button"
                      className="chip"
                      onClick={() => pickMyWallet(w.address)}
                      aria-label={`Send to my wallet ${w.name}`}
                      aria-pressed={isPicked}
                      title={`${w.name}: ${w.address}`}
                      data-testid={`live-send-wallet-${i}`}
                      style={{
                        cursor: 'pointer',
                        maxWidth: '100%',
                        color: isPicked ? 'var(--success)' : 'var(--text-dim)',
                        background: isPicked ? 'var(--success-bg)' : 'var(--card)',
                        border: isPicked
                          ? '1px solid color-mix(in srgb, var(--success) 45%, transparent)'
                          : '1px solid var(--border)',
                        fontWeight: isPicked ? 700 : 600,
                        transition: 'all 0.15s',
                      }}
                    >
                      {isPicked ? <Check size={11} style={{ flexShrink: 0 }} /> : <Wallet size={11} style={{ flexShrink: 0 }} />}
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {w.name}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Saved contacts from the address book. */}
          {chainContacts.length > 0 && (
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
                {chainContacts.map((c) => (
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
            error={fieldError || undefined}
          />

          {/* Available balance for the selected asset. A small positive top margin
              keeps a clear gap under the amount field (its focus ring extends a few
              px); a negative margin here made "Available" touch the input. */}
          <div
            className="text-dim"
            data-testid="live-send-available"
            style={{ fontSize: 11.5, margin: '6px 2px 8px' }}
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

          {/* Network fee: the amount in the chain's own coin is the headline
              (that is what a user pays), the sat/byte rate is secondary detail.
              A speed choice renders ONLY when the chain genuinely returns
              different rates per confirmation target; most chains answer one
              flat rate for every target, so the single-fee view is the normal,
              finished presentation, not a fallback. A custom rate is always
              available, validated against the chain's real floor and ceiling. */}
          <div className="section-label">Network fee</div>
          <div className="card" data-testid="live-fee-section" style={{ marginBottom: 10, padding: 12 }}>
            {feeEstimate === null || headlineRate === null ? (
              <div className="text-dim" style={{ fontSize: 11.5 }}>
                Fetching the current network fee…
              </div>
            ) : (
              <>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <div style={{ minWidth: 0 }}>
                    <div data-testid="live-fee-amount" style={{ fontWeight: 700, fontSize: 13.5 }}>
                      ~{fmtBalance(feePreviewDecimal(headlineRate), 8)} {nativeTicker}
                    </div>
                    <div className="text-dim" data-testid="live-fee-rate" style={{ fontSize: 11, marginTop: 1 }}>
                      {headlineRate.toString()} sat/byte · {rateSourceLabel}
                    </div>
                  </div>
                  <button
                    type="button"
                    className={customOpen ? 'chip' : 'chip neutral'}
                    data-testid="live-fee-custom-toggle"
                    aria-pressed={customOpen}
                    onClick={toggleCustomRate}
                    style={{ cursor: 'pointer', flexShrink: 0 }}
                  >
                    Custom
                  </button>
                </div>

                {feeEstimate.differentiated && !customOpen && (
                  <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                    {/* Duplicates by effective rate are collapsed (fastest
                        target of each rate survives): a chain can answer e.g.
                        fast 1860 / normal 1006 / slow 1006 (seen live on
                        Ravencoin), and rendering two chips with the SAME
                        amount offers no choice — see distinctFeeOptions for
                        why collapsing beats demanding all three to differ.
                        The picked highlight compares RATES, not targets, so
                        the default 6-block pick still lights the surviving
                        chip that carries its rate when target 6 itself was
                        collapsed away. */}
                    {distinctFeeOptions(feeEstimate.options).map((o) => {
                      const meta = speedMetaFor(o.targetBlocks);
                      const isPicked = pickedOption?.satPerByte === o.satPerByte;
                      return (
                        <button
                          key={o.targetBlocks}
                          type="button"
                          className={isPicked ? 'chip' : 'chip neutral'}
                          data-testid={`live-fee-option-${meta.key}`}
                          aria-pressed={isPicked}
                          onClick={() => setPickedTarget(o.targetBlocks)}
                          title={`${meta.label}: about ${o.targetBlocks} blocks at ${o.satPerByte.toString()} sat/byte`}
                          style={{
                            flex: 1,
                            flexDirection: 'column',
                            alignItems: 'center',
                            gap: 1,
                            padding: '6px 4px',
                            borderRadius: 10,
                            cursor: 'pointer',
                          }}
                        >
                          <span style={{ fontWeight: 700 }}>{meta.label}</span>
                          <span style={{ fontSize: 10, opacity: 0.9 }}>
                            ~{fmtBalance(feePreviewDecimal(o.satPerByte), 8)}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}

                {customOpen && (
                  <div style={{ marginTop: 10 }}>
                    <TextField
                      label="Custom rate (sat/byte)"
                      type="number"
                      min="1"
                      step="1"
                      inputMode="numeric"
                      placeholder={(pickedOption?.satPerByte ?? feeEstimate.defaultSatPerByte).toString()}
                      value={customText}
                      onChange={(e) => setCustomText(e.target.value)}
                      testId="live-fee-custom"
                      hint={
                        customError
                          ? undefined
                          : `Between ${feeEstimate.floorSatPerByte.toString()} and ${feeEstimate.ceilingSatPerByte.toString()} sat/byte on this network.`
                      }
                    />
                    {customError && (
                      <span
                        role="alert"
                        data-testid="live-fee-custom-error"
                        style={{ fontSize: 11.5, color: 'var(--danger)', display: 'block', marginTop: 4 }}
                      >
                        {customError}
                      </span>
                    )}
                  </div>
                )}
              </>
            )}
            <p
              className="text-dim"
              data-testid="live-send-fee-note"
              style={{ fontSize: 11, margin: '8px 0 0', lineHeight: 1.5 }}
            >
              {feeNote}
            </p>
          </div>

          <div className="section-label">Asset</div>
          {/* Name over description in a shrinkable column so a long asset name
              (e.g. JACKDAWTOKEN.COM/WHITEPAPER) truncates cleanly instead of
              crushing the description into a 4-line sliver. */}
          {/* The card's own description already says what is being sent and in
              which coin fees are paid — the old standalone sentence repeating
              it below was deleted to keep the primary CTA above the fold. */}
          <div className="token-row" style={{ marginBottom: 10 }}>
            <TokenIcon assetId={assetId} size={30} />
            <div style={{ minWidth: 0, marginLeft: 8, flex: 1 }}>
              <div
                style={{
                  fontWeight: 700,
                  fontSize: 13,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                title={assetId}
              >
                {assetId}
              </div>
              <div
                className="text-dim"
                style={{
                  fontSize: 11.5,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {isAsset
                  ? `${activeNet.displayName} asset · fee paid in ${nativeTicker}`
                  : activeNet.displayName}
              </div>
            </div>
          </div>
          {isLegacyAsset(assetId, nativeTicker) && (
            <p
              className="text-dim"
              data-testid="legacy-asset-send-note"
              style={{ fontSize: 11.5, margin: '0 2px 8px', lineHeight: 1.5 }}
            >
              Legacy SATORI. The Satori Network now uses SATORIEVR.
            </p>
          )}
          </div>{/* /send-scroll */}

          {/* Pinned with the CTA (not inside the scroll region): the no-gas
              banner is the reason the button below it is disabled, and a build
              error is the outcome of pressing it — both must stay in view next
              to the always-visible button, never scrolled below the fold. */}
          <div className="send-cta">
            {noEvrForGas && (
              <div className="banner danger" data-testid="no-evr-gas-banner" style={{ marginBottom: 10 }}>
                <AlertTriangle size={14} />
                You need {nativeTicker} to pay the network fee. You can&apos;t send assets while your {nativeTicker} balance is 0.
              </div>
            )}
            {/* Store/build errors (e.g. insufficient funds) show HERE only; field
                validation errors render once, under the field they belong to. */}
            {mappedStoreError && (
              <div className="banner danger" data-testid="live-send-error" style={{ marginBottom: 10 }}>
                {mappedStoreError}
              </div>
            )}

            <Button type="submit" block loading={loadingSend} disabled={noEvrForGas}>
              Review transaction
            </Button>
          </div>
        </form>
      </div>
      <LiveNav />
    </div>
  );
}
