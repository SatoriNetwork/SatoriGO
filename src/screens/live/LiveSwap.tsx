// Swap one token for another on Uniswap v3, inside the wallet.
//
// The wallet finds the route and builds the transaction itself against pinned
// contracts (src/store/evmSwap.ts), so this screen only ever shows and confirms
// what the store planned. A token swap needs the router allowed the exact
// amount first: as a signed permit inside the swap when the token supports one
// (one transaction), else as an approval before it (two). Each transaction
// gets the same review, arming gate and password as a send.
//
// The form is the two amounts: what you pay over what you receive, in one
// panel, with the token of each side on a pill that opens the token list.
// Everything else (the rate, the route, slippage) stays folded until asked for,
// and the one button names what is still missing.

import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowDown, ArrowDownUp, ChevronDown, ChevronLeft, Info, SlidersHorizontal } from 'lucide-react';
import { TokenIcon } from '../../components/BrandLogo';
import { Button } from '../../components/Button';
import { PasswordField, TextField } from '../../components/TextField';
import { formatAmount, formatListAmount, parseAmount } from '../../services/chain/amounts';
import { displaySymbol } from '../../services/displaySymbol';
import { formatFiatValue } from '../../services/fiat';
import { activeEvmChain, useLiveStore } from '../../store/liveStore';
import {
  SWAP_IMPACT_WARN_BPS,
  SWAP_PLAN_MAX_AGE_MS,
  SWAP_PUBLIC_MEMPOOL_CHAINS,
  SWAP_SLIPPAGE_DEFAULT_BPS,
  swapNeedsImpactAck,
  type SwapToken,
} from '../../store/evmSwap';
import type { EvmFeeLevel } from '../../services/chain/evm/fees';
import { LiveNav } from './LiveNav';
import { typedAmountFiat, useAssetFiat } from './useFiat';

interface LiveSwapProps {
  onBack(): void;
  /** A swap was sent: leave for Home, where a bar follows it. Back when absent. */
  onDone?(): void;
}

const FEE_LEVELS: readonly EvmFeeLevel[] = ['slow', 'normal', 'fast'];
const FEE_LEVEL_LABEL: Record<EvmFeeLevel, string> = { slow: 'Slow', normal: 'Normal', fast: 'Fast' };
const SLIPPAGE_CHOICES: readonly number[] = [10, 50, 100, 300];
/** How long typing rests before a quote is asked for. */
const QUOTE_DEBOUNCE_MS = 500;
/** How often the allowance is looked at again while an approval confirms. */
const APPROVAL_POLL_MS = 4000;
/** After this long the screen stops asking and says the approval has not landed. */
const APPROVAL_WAIT_MS = 180_000;
/** The widest slippage offered where pending transactions are public. */
const PUBLIC_MEMPOOL_MAX_SLIPPAGE_BPS = 100;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

const tokenKey = (t: SwapToken) => t.address?.toLowerCase() ?? 'native';
const percent = (bps: number) => `${(bps / 100).toFixed(2).replace(/\.?0+$/, '')}%`;
const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function impactText(bps: number | null): string {
  if (bps === null) return 'Could not be measured';
  return bps < 1 ? 'Less than 0.01%' : percent(bps);
}

export function LiveSwap({ onBack, onDone }: LiveSwapProps) {
  const swap = useLiveStore((s) => s.swap);
  const quoteSwap = useLiveStore((s) => s.quoteSwap);
  const swapAllowanceReady = useLiveStore((s) => s.swapAllowanceReady);
  const planSwap = useLiveStore((s) => s.planSwap);
  const selectSwapFeeLevel = useLiveStore((s) => s.selectSwapFeeLevel);
  const confirmSwap = useLiveStore((s) => s.confirmSwap);
  const clearSwapPlan = useLiveStore((s) => s.clearSwapPlan);
  const clearSwap = useLiveStore((s) => s.clearSwap);
  const resolveSwapToken = useLiveStore((s) => s.resolveSwapToken);
  const searchEvmTokens = useLiveStore((s) => s.searchEvmTokens);
  const arm = useLiveStore((s) => s.arm);
  const verifyPassword = useLiveStore((s) => s.verifyPassword);
  const requirePasswordToSend = useLiveStore((s) => s.requirePasswordToSend);
  const wallets = useLiveStore((s) => s.wallets);
  const activeWalletId = useLiveStore((s) => s.activeWalletId);
  const assets = useLiveStore((s) => s.assets);
  const evmTokens = useLiveStore((s) => s.evmTokens);
  const chain = useLiveStore(activeEvmChain);

  const ticker = chain?.nativeTicker ?? 'ETH';
  const nativeDecimals = chain?.nativeDecimals ?? 18;

  // Tokens found by search or pasted address, for this visit only.
  const [found, setFound] = useState<SwapToken[]>([]);
  const { options, vouched, held } = useMemo(() => {
    const native: SwapToken = { address: null, symbol: ticker, decimals: nativeDecimals };
    const list: SwapToken[] = [native];
    const trusted = new Set<string>(['native']);
    // Tokens that have a balance row of their own on Home: everything but the
    // ones only found on this screen.
    const rows = new Set<string>(['native']);
    const add = (t: { address: string; symbol?: string; decimals?: number }, vouch: boolean, hasRow: boolean) => {
      if (!t.symbol || t.decimals === undefined) return;
      const key = t.address.toLowerCase();
      if (vouch) trusted.add(key);
      if (hasRow) rows.add(key);
      if (!list.some((x) => tokenKey(x) === key)) list.push({ address: t.address, symbol: t.symbol, decimals: t.decimals });
    };
    (chain?.defaultTokens ?? []).forEach((t) => add(t, true, true));
    evmTokens.tracked.forEach((t) => add(t, t.trusted === true, true));
    evmTokens.discovered.filter((t) => t.trusted === true).forEach((t) => add(t, true, true));
    found.forEach((t) => add(t as { address: string; symbol: string; decimals: number }, false, false));
    return { options: list, vouched: trusted, held: rows };
  }, [chain, evmTokens, found, ticker, nativeDecimals]);

  const [inKey, setInKey] = useState('native');
  const [outKey, setOutKey] = useState('');
  const [amountText, setAmountText] = useState('');
  const [slippageBps, setSlippageBps] = useState(SWAP_SLIPPAGE_DEFAULT_BPS);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [hits, setHits] = useState<Array<{ address: string; name: string; symbol: string }>>([]);

  const [armed, setArmed] = useState(false);
  const [ackImpact, setAckImpact] = useState(false);
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState('');
  // Which side's token list is open, the folded details, the slippage panel.
  const [sheet, setSheet] = useState<'in' | 'out' | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [waitingApproval, setWaitingApproval] = useState(false);
  const [waitingSince, setWaitingSince] = useState(0);
  const [waitTimedOut, setWaitTimedOut] = useState(false);
  // Ticks while a plan is under review, so an old one is noticed without a click.
  const [now, setNow] = useState(() => Date.now());
  const [showMore, setShowMore] = useState(false);
  // State only reaches the button on the next render; a double click is faster.
  const confirmStarted = useRef(false);

  const tokenIn = options.find((t) => tokenKey(t) === inKey) ?? null;
  const tokenOut = options.find((t) => tokenKey(t) === outKey) ?? null;

  let amountIn: bigint | null = null;
  let amountError = '';
  if (tokenIn && amountText.trim() !== '') {
    try {
      amountIn = parseAmount(amountText, tokenIn.decimals);
    } catch (err) {
      amountError = err instanceof Error ? err.message : 'Enter a valid amount.';
    }
  }
  // Balance rows are keyed by SYMBOL, and a symbol is whatever a contract says
  // it is. So a balance is shown only for a token that has a row of its own,
  // and only when the wallet vouches for it or no other token here shares the
  // symbol: a pasted look-alike never borrows the real token's balance.
  const balanceOf = (t: SwapToken | null): bigint | null => {
    if (!t) return null;
    const key = tokenKey(t);
    const sharesSymbol = options.some((o) => tokenKey(o) !== key && o.symbol.toUpperCase() === t.symbol.toUpperCase());
    if (!held.has(key) || (!vouched.has(key) && sharesSymbol)) return null;
    const row = t.address === null
      ? assets.find((a) => a.isNative && a.name === ticker)
      : assets.find((a) => !a.isNative && a.name.toUpperCase() === t.symbol.toUpperCase());
    return row ? row.amountBase : null;
  };
  const balanceIn = balanceOf(tokenIn);
  // A price is looked up by symbol, so only a token the wallet vouches for gets one.
  const priced = (t: SwapToken | null) => (t && vouched.has(tokenKey(t)) ? t.symbol : '');
  const fiatIn = useAssetFiat(priced(tokenIn), tokenIn?.address === null).unit;
  const fiatOut = useAssetFiat(priced(tokenOut), tokenOut?.address === null).unit;
  const overBalance = amountIn !== null && balanceIn !== null && amountIn > balanceIn;

  // A clean slate on leaving: an armed plan must never survive a navigation.
  useEffect(() => () => clearSwap(), [clearSwap]);

  // Ask for a quote once the form rests on two tokens and an amount.
  const quoteKey = tokenIn && tokenOut && amountIn !== null && amountIn > 0n ? `${inKey}>${outKey}:${amountIn}` : '';
  useEffect(() => {
    setWaitingApproval(false);
    if (!quoteKey || !tokenIn || !tokenOut || amountIn === null) {
      clearSwap();
      return;
    }
    const timer = setTimeout(() => void quoteSwap(tokenIn, tokenOut, amountIn as bigint), QUOTE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // quoteKey stands for the two tokens and the amount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quoteKey, quoteSwap, clearSwap]);

  // After an approval is sent: read only the allowance until the chain shows
  // it, then ask for the full quote once. Waiting must stay cheap.
  const { quote, plan, quoting, planning, error } = swap;
  const waitingOn = quote ? quote.needsApproval : null;
  useEffect(() => {
    if (!waitingApproval || waitTimedOut || !tokenIn || !tokenOut || amountIn === null) return;
    if (waitingOn === false) {
      setWaitingApproval(false);
      return;
    }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const look = async () => {
      if (Date.now() - waitingSince > APPROVAL_WAIT_MS) {
        setWaitTimedOut(true);
        return;
      }
      // No quote to wait on (the last one failed): ask for it again.
      const ready = waitingOn === null || (await swapAllowanceReady());
      if (stopped) return;
      // A quote that still needs the approval (or none) leaves the wait as it
      // was, so keep looking; one that does not ends the wait above.
      if (ready) await quoteSwap(tokenIn, tokenOut, amountIn as bigint);
      if (!stopped) timer = setTimeout(() => void look(), APPROVAL_POLL_MS);
    };
    timer = setTimeout(() => void look(), APPROVAL_POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitingApproval, waitTimedOut, waitingSince, waitingOn, quoteSwap, swapAllowanceReady]);

  const startWaiting = () => {
    setWaitingSince(Date.now());
    setWaitTimedOut(false);
    setWaitingApproval(true);
  };

  const planId = swap.plan ? swap.plan.kind : null;
  useEffect(() => {
    if (!planId) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, [planId]);

  const isPasswordless = wallets.find((w) => w.id === activeWalletId)?.passwordless ?? false;
  const requirePassword = requirePasswordToSend && !isPasswordless;

  const resetReview = () => {
    setArmed(false);
    setAckImpact(false);
    setShowMore(false);
    setPassword('');
    setPasswordError('');
    setConfirmError('');
  };
  const backFromReview = () => {
    clearSwapPlan();
    resetReview();
  };

  /** A token the wallet does not vouch for is never named by symbol alone. */
  const optionLabel = (t: SwapToken): string =>
    vouched.has(tokenKey(t)) || t.address === null ? displaySymbol(t.symbol) : `${displaySymbol(t.symbol)} (${shortAddress(t.address)})`;

  /** A vouched token gets its mark. Anything else gets a plain letter: a mark
   *  is looked up by symbol, and a symbol proves nothing. */
  const mark = (t: SwapToken, size: number) =>
    vouched.has(tokenKey(t)) ? (
      <TokenIcon assetId={t.symbol} size={size} />
    ) : (
      <span className="swap-badge" style={{ width: size, height: size, fontSize: size * 0.45 }} aria-hidden="true">
        {displaySymbol(t.symbol).slice(0, 1).toUpperCase() || '?'}
      </span>
    );

  const symbolOf = (address: string): string => {
    const known = options.find((t) => t.address?.toLowerCase() === address.toLowerCase());
    return known ? displaySymbol(known.symbol) : shortAddress(address);
  };

  /** Put a token on one side. Picking the other side's token swaps the two. */
  const choose = (side: 'in' | 'out', key: string) => {
    const other = side === 'in' ? outKey : inKey;
    const mine = side === 'in' ? inKey : outKey;
    if (key === other) {
      const fallback = mine || options.map(tokenKey).find((k) => k !== key) || '';
      if (side === 'in') setOutKey(fallback);
      else setInKey(fallback);
    }
    if (side === 'in') setInKey(key);
    else setOutKey(key);
    setSheet(null);
    setQuery('');
    setHits([]);
    setSearchError('');
  };

  const pickFound = async (address: string, side: 'in' | 'out') => {
    setSearchError('');
    setSearching(true);
    try {
      const resolved = await resolveSwapToken(address);
      if (!resolved.ok) {
        setSearchError(resolved.error);
        return;
      }
      setFound((list) => (list.some((t) => tokenKey(t) === tokenKey(resolved.token)) ? list : [...list, resolved.token]));
      choose(side, tokenKey(resolved.token));
    } finally {
      setSearching(false);
    }
  };

  const runSearch = async (side: 'in' | 'out') => {
    const text = query.trim();
    if (!text) return;
    if (ADDRESS_RE.test(text)) {
      await pickFound(text, side);
      return;
    }
    setSearchError('');
    setSearching(true);
    try {
      const result = await searchEvmTokens(text);
      if (!result.ok) setSearchError(result.error);
      else if (result.results.length === 0) setSearchError('No token by that name. Paste its contract address instead.');
      setHits(result.ok ? result.results : []);
    } finally {
      setSearching(false);
    }
  };

  const header = (title: string, back: () => void, right?: JSX.Element) => (
    <div className="sub-header">
      <button type="button" className="icon-btn" onClick={back} aria-label="Back">
        <ChevronLeft size={20} />
      </button>
      <h2>{title}</h2>
      {right ?? <span />}
    </div>
  );

  if (!chain || !chain.swap) {
    return (
      <div className="app-frame screen-enter">
        {header('Swap', onBack)}
        <div className="app-content" data-testid="live-swap">
          <div className="banner info">
            <Info size={14} />
            Swapping is not available on this network.
          </div>
        </div>
        <LiveNav />
      </div>
    );
  }

  if (plan) {
    const isApprove = plan.kind === 'approve';
    const needsAck = plan.kind === 'swap' && swapNeedsImpactAck(plan.impactBps);
    // The store refuses an old swap plan as well; this is the same rule, shown.
    const stale = plan.kind === 'swap' && now - plan.plannedAt > SWAP_PLAN_MAX_AGE_MS;
    const blocked = !!plan.shortfall || !!plan.capRefusal || stale;

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
        const result = await confirmSwap(ackImpact);
        resetReview();
        if (result.kind === 'approve') startWaiting();
        else (onDone ?? onBack)();
      } catch (err) {
        setConfirmError(err instanceof Error ? err.message : String(err));
      } finally {
        arm(false);
        setConfirming(false);
        confirmStarted.current = false;
      }
    };

    const paySymbol = displaySymbol(plan.tokenIn.symbol);
    const impactClass = plan.kind !== 'swap' || (plan.impactBps !== null && plan.impactBps < SWAP_IMPACT_WARN_BPS) ? '' : needsAck ? ' danger' : ' warn';

    return (
      <div className="app-frame screen-enter">
        {header(isApprove ? 'Review approval' : 'Review swap', backFromReview)}
        <div className="app-content" data-testid="live-swap-review">
          {isApprove && (
            <div className="swap-steps" data-testid="live-swap-step-note">
              <span className="swap-step current">Step 1 of 2</span>
              <span>Approve, then swap</span>
            </div>
          )}

          <div className="swap-panel">
            <div className="swap-leg">
              <span className="swap-leg-label">{isApprove ? 'Allow Uniswap to take exactly' : 'You pay'}</span>
              <div className="swap-leg-main" data-testid="live-swap-review-pay">
                <span className="swap-amount review">{formatAmount(plan.amountIn, plan.tokenIn.decimals)} {paySymbol}</span>
                {mark(plan.tokenIn, 26)}
              </div>
              {isApprove && <div className="swap-leg-sub"><span>For this one swap, and nothing more.</span></div>}
            </div>
            {plan.kind === 'swap' && (
              <>
                <div className="swap-seam">
                  <span className="swap-flip still" aria-hidden="true">
                    <ArrowDown size={15} />
                  </span>
                </div>
                <div className="swap-leg">
                  <span className="swap-leg-label">You receive about</span>
                  <div className="swap-leg-main" data-testid="live-swap-review-receive">
                    <span className="swap-amount review">
                      {formatListAmount(plan.amountOut, plan.tokenOut.decimals)} {displaySymbol(plan.tokenOut.symbol)}
                    </span>
                    {mark(plan.tokenOut, 26)}
                  </div>
                  <div className="swap-leg-sub">
                    <span data-testid="live-swap-review-minimum">
                      At least {formatAmount(plan.minimumOut, plan.tokenOut.decimals)} {displaySymbol(plan.tokenOut.symbol)}
                    </span>
                  </div>
                </div>
              </>
            )}
          </div>

          <div className="summary-table swap-details">
            {plan.kind === 'swap' && (
              <div className="sum-row" data-testid="live-swap-review-impact">
                <span className="sum-key">Price impact</span>
                <span className={`sum-val swap-impact${impactClass}`}>{impactText(plan.impactBps)}</span>
              </div>
            )}
            {plan.kind === 'swap' && plan.feeBps > 0 && (
              <div className="sum-row" data-testid="live-swap-review-wallet-fee">
                <span className="sum-key">Fee ({percent(plan.feeBps)}), already taken off</span>
                <span className="sum-val">{formatAmount(plan.feeAmount, plan.tokenOut.decimals)} {displaySymbol(plan.tokenOut.symbol)}</span>
              </div>
            )}
            {plan.kind === 'swap' && plan.viaPermit && (
              <div className="sum-row" data-testid="live-swap-review-permit">
                <span className="sum-key">Approval</span>
                <span className="sum-val">Signed for exactly this amount, inside this swap</span>
              </div>
            )}
            <div className="sum-row" data-testid="live-swap-review-fee">
              <span className="sum-key">Network fee</span>
              <span className="sum-val" title={`${formatAmount(plan.quote.estimatedTotal, nativeDecimals)} ${ticker}`}>{formatListAmount(plan.quote.estimatedTotal, nativeDecimals)} {ticker}</span>
            </div>
          </div>

          <button
            type="button"
            className="swap-rate"
            aria-expanded={showMore}
            onClick={() => setShowMore((v) => !v)}
            data-testid="live-swap-review-more"
          >
            <span>More details</span>
            <ChevronDown size={14} style={showMore ? { transform: 'rotate(180deg)' } : undefined} />
          </button>
          {showMore && (
            <div data-testid="live-swap-review-details">
              <div className="summary-table swap-details">
                {plan.kind === 'swap' && (
                  <>
                    <div className="sum-row">
                      <span className="sum-key">Slippage</span>
                      <span className="sum-val">{percent(plan.slippageBps)}</span>
                    </div>
                    <div className="sum-row">
                      <span className="sum-key">Route</span>
                      <span className="sum-val">
                        {[paySymbol, ...plan.hops.slice(0, -1).map((h) => symbolOf(h.tokenOut)), displaySymbol(plan.tokenOut.symbol)].join(' › ')}
                      </span>
                    </div>
                  </>
                )}
                <div className="sum-row">
                  <span className="sum-key">{isApprove ? 'Token contract' : 'Uniswap router'}</span>
                  <span className="sum-val mono" style={{ fontSize: 10.5, wordBreak: 'break-all' }}>{plan.to}</span>
                </div>
                <div className="sum-row">
                  <span className="sum-key">Network</span>
                  <span className="sum-val">{chain.displayName}</span>
                </div>
                <div className="sum-row">
                  <span className="sum-key">Maximum network fee</span>
                  <span className="sum-val" title={`${formatAmount(plan.quote.maxTotal, nativeDecimals)} ${ticker}`}>{formatListAmount(plan.quote.maxTotal, nativeDecimals)} {ticker}</span>
                </div>
              </div>
              <div className="section-label">Speed</div>
              <div style={{ display: 'flex', gap: 6 }}>
                {FEE_LEVELS.map((lvl) => (
                  <button
                    key={lvl}
                    type="button"
                    className={plan.level === lvl ? 'chip' : 'chip neutral'}
                    aria-pressed={plan.level === lvl}
                    onClick={() => void selectSwapFeeLevel(lvl)}
                    style={{ flex: 1, justifyContent: 'center', cursor: 'pointer' }}
                  >
                    {FEE_LEVEL_LABEL[lvl]}
                  </button>
                ))}
              </div>
            </div>
          )}

          {plan.shortfall && (
            <div className="banner danger" style={{ marginTop: 12 }} data-testid="live-swap-shortfall">
              <AlertTriangle size={14} />
              {plan.shortfall}
            </div>
          )}
          {plan.capRefusal && (
            <div className="banner danger" style={{ marginTop: 12 }}>
              <AlertTriangle size={14} />
              {plan.capRefusal}
            </div>
          )}
          {stale && (
            <div className="banner warning" style={{ marginTop: 12 }} data-testid="live-swap-stale">
              <AlertTriangle size={14} />
              <span>
                The price is out of date.{' '}
                <button
                  type="button"
                  className="chip neutral"
                  style={{ cursor: 'pointer' }}
                  onClick={() => {
                    resetReview();
                    void planSwap(plan.slippageBps);
                  }}
                  data-testid="live-swap-replan"
                >
                  Update price
                </button>
              </span>
            </div>
          )}

          <div className="swap-confirm">
            {needsAck && (
              <label className="swap-tick danger">
                <input type="checkbox" checked={ackImpact} onChange={(e) => setAckImpact(e.target.checked)} data-testid="live-swap-ack-impact" />
                <span>
                  {plan.kind === 'swap' && plan.impactBps === null
                    ? 'The price impact of this swap could not be measured. I accept that I may receive much less than the market price.'
                    : `This swap moves the price by ${impactText(plan.kind === 'swap' ? plan.impactBps : null)}. I accept that I receive that much less than the market price.`}
                </span>
              </label>
            )}
            <label className="swap-tick">
              <input type="checkbox" checked={armed} onChange={(e) => setArmed(e.target.checked)} data-testid="live-swap-arm" />
              <span>I understand this sends a real transaction on {chain.displayName} and cannot be undone.</span>
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
                testId="live-swap-password"
                enterClicks="live-swap-confirm"
              />
              {passwordError && (
                <span role="alert" style={{ fontSize: 11.5, color: 'var(--danger)', display: 'block', marginTop: 4 }}>
                  {passwordError}
                </span>
              )}
            </div>
          )}

          {confirmError && (
            <div className="banner danger" style={{ marginBottom: 14 }} data-testid="live-swap-confirm-error">
              {confirmError}
            </div>
          )}

          <div style={{ display: 'flex', gap: 9 }}>
            <Button variant="secondary" onClick={backFromReview}>Back</Button>
            <Button
              block
              disabled={!armed || blocked || (needsAck && !ackImpact)}
              loading={confirming}
              onClick={() => void handleConfirm()}
              data-testid="live-swap-confirm"
            >
              {isApprove ? `Approve ${paySymbol}` : 'Swap'}
            </Button>
          </div>
        </div>
        <LiveNav />
      </div>
    );
  }

  const outUnverified = tokenOut !== null && !vouched.has(tokenKey(tokenOut));
  const publicMempool = SWAP_PUBLIC_MEMPOOL_CHAINS.includes(chain.key);
  const slippageChoices = SLIPPAGE_CHOICES.filter((bps) => !publicMempool || bps <= PUBLIC_MEMPOOL_MAX_SLIPPAGE_BPS);

  // The one button says what is still missing, in the order it is needed.
  const inSymbol = tokenIn ? displaySymbol(tokenIn.symbol) : '';
  const step: { label: string; ready: boolean } = !tokenOut
    ? { label: 'Choose a token', ready: false }
    : amountError
      ? { label: 'Enter a valid amount', ready: false }
      : amountIn === null || amountIn <= 0n
        ? { label: 'Enter an amount', ready: false }
        : overBalance
          ? { label: `Not enough ${inSymbol}`, ready: false }
          : waitingApproval
            ? { label: 'Waiting for approval', ready: false }
            : !quote
              ? { label: error ? 'No swap available' : 'Getting a price...', ready: false }
              : { label: 'Review swap', ready: !quoting && !planning };

  const amountNumber = (base: bigint, decimals: number) => Number(formatAmount(base, decimals));
  const rate =
    quote && quote.amountIn > 0n
      ? amountNumber(quote.amountOut, quote.tokenOut.decimals) / amountNumber(quote.amountIn, quote.tokenIn.decimals)
      : null;
  const rateText = rate !== null && Number.isFinite(rate) && rate > 0 ? Number(rate.toPrecision(6)).toString() : null;
  const impactTone =
    !quote || (quote.impactBps !== null && quote.impactBps < SWAP_IMPACT_WARN_BPS)
      ? ''
      : swapNeedsImpactAck(quote.impactBps)
        ? ' danger'
        : ' warn';
  const payFiat = typedAmountFiat(amountText, fiatIn);
  const receiveFiat = quote ? typedAmountFiat(formatAmount(quote.amountOut, quote.tokenOut.decimals), fiatOut) : null;

  const pill = (side: 'in' | 'out', t: SwapToken | null) => (
    <button
      type="button"
      className={t ? 'swap-token' : 'swap-token unset'}
      onClick={() => setSheet(side)}
      aria-label={side === 'in' ? 'Token to pay with' : 'Token to receive'}
      aria-haspopup="dialog"
      data-testid={`live-swap-token-${side}`}
    >
      {t && mark(t, 22)}
      <span>{t ? optionLabel(t) : 'Choose token'}</span>
      <ChevronDown size={14} />
    </button>
  );

  return (
    <div className="app-frame screen-enter">
      {header(
        'Swap',
        onBack,
        <button
          type="button"
          className="icon-btn"
          aria-label="Slippage settings"
          aria-expanded={showSettings}
          onClick={() => setShowSettings((v) => !v)}
          data-testid="live-swap-settings"
        >
          <SlidersHorizontal size={18} />
        </button>,
      )}
      <div className="app-content" data-testid="live-swap">
        {showSettings && (
          <div className="card" style={{ marginBottom: 12 }} data-testid="live-swap-settings-panel">
            <div className="section-label" style={{ marginTop: 0 }}>Slippage</div>
            <div style={{ display: 'flex', gap: 6 }}>
              {slippageChoices.map((bps) => (
                <button
                  key={bps}
                  type="button"
                  className={slippageBps === bps ? 'chip' : 'chip neutral'}
                  aria-pressed={slippageBps === bps}
                  onClick={() => setSlippageBps(bps)}
                  style={{ flex: 1, justifyContent: 'center', cursor: 'pointer' }}
                  data-testid={`live-swap-slippage-${bps}`}
                >
                  {percent(bps)}
                </button>
              ))}
            </div>
            <div className="text-faint" style={{ fontSize: 11, marginTop: 8, lineHeight: 1.5 }}>
              How far the price may move against you before the swap is cancelled instead.
            </div>
          </div>
        )}

        <div className="swap-panel">
          <div className="swap-leg">
            <label className="swap-leg-label" htmlFor="live-swap-amount-input">You pay</label>
            <div className="swap-leg-main">
              <input
                id="live-swap-amount-input"
                className="swap-amount"
                placeholder="0"
                inputMode="decimal"
                autoComplete="off"
                spellCheck={false}
                value={amountText}
                onChange={(e) => setAmountText(e.target.value)}
                aria-invalid={!!amountError || overBalance}
                data-testid="live-swap-amount"
              />
              {pill('in', tokenIn)}
            </div>
            <div className="swap-leg-sub">
              <span data-testid="live-swap-pay-fiat">{payFiat ? formatFiatValue(payFiat) : ''}</span>
              {tokenIn && balanceIn !== null && (
                <span data-testid="live-swap-balance">
                  Balance {formatListAmount(balanceIn, tokenIn.decimals)}
                  {tokenIn.address !== null && balanceIn > 0n && (
                    <>
                      {' · '}
                      <button
                        type="button"
                        className="swap-link"
                        onClick={() => setAmountText(formatAmount(balanceIn, tokenIn.decimals))}
                        data-testid="live-swap-max"
                      >
                        Max
                      </button>
                    </>
                  )}
                </span>
              )}
            </div>
          </div>

          <div className="swap-seam">
            <button
              type="button"
              className="swap-flip"
              aria-label="Swap the two tokens around"
              data-testid="live-swap-flip"
              disabled={!tokenOut}
              onClick={() => {
                setInKey(outKey);
                setOutKey(inKey);
                setAmountText('');
              }}
            >
              <ArrowDownUp size={15} />
            </button>
          </div>

          <div className="swap-leg">
            <span className="swap-leg-label">You receive</span>
            <div className="swap-leg-main">
              <span className={quote ? 'swap-amount' : 'swap-amount empty'} data-testid="live-swap-quote-out" aria-live="polite">
                {quote ? formatListAmount(quote.amountOut, quote.tokenOut.decimals) : '0'}
              </span>
              {pill('out', tokenOut)}
            </div>
            <div className="swap-leg-sub">
              <span>{receiveFiat ? formatFiatValue(receiveFiat) : ''}</span>
              {quote && quote.feeBps > 0 && (
                <span data-testid="live-swap-quote-wallet-fee">after the {percent(quote.feeBps)} fee</span>
              )}
            </div>
          </div>
        </div>

        {quote && (
          <div data-testid="live-swap-quote">
            <button
              type="button"
              className="swap-rate"
              aria-expanded={showDetails}
              onClick={() => setShowDetails((v) => !v)}
              data-testid="live-swap-details-toggle"
            >
              <span>
                {rateText ? `1 ${displaySymbol(quote.tokenIn.symbol)} ≈ ${rateText} ${displaySymbol(quote.tokenOut.symbol)}` : 'Details'}
              </span>
              <span className="swap-rate-end">
                <span className={`swap-impact${impactTone}`} data-testid="live-swap-quote-impact">
                  Price impact {impactText(quote.impactBps).toLowerCase()}
                </span>
                <ChevronDown size={14} style={showDetails ? { transform: 'rotate(180deg)' } : undefined} />
              </span>
            </button>
            {showDetails && (
              <div className="summary-table swap-details" data-testid="live-swap-details">
                <div className="sum-row">
                  <span className="sum-key">At least</span>
                  <span className="sum-val">
                    {formatListAmount((quote.amountOut * BigInt(10_000 - slippageBps)) / 10_000n, quote.tokenOut.decimals)}{' '}
                    {displaySymbol(quote.tokenOut.symbol)}
                  </span>
                </div>
                <div className="sum-row">
                  <span className="sum-key">Slippage</span>
                  <span className="sum-val">{percent(slippageBps)}</span>
                </div>
                <div className="sum-row">
                  <span className="sum-key">Route</span>
                  <span className="sum-val">
                    {[displaySymbol(quote.tokenIn.symbol), ...quote.hops.slice(0, -1).map((h) => symbolOf(h.tokenOut)), displaySymbol(quote.tokenOut.symbol)].join(' › ')}
                  </span>
                </div>
                <div className="sum-row">
                  <span className="sum-key">Fee</span>
                  <span className="sum-val">{quote.feeBps > 0 ? percent(quote.feeBps) : 'None'}</span>
                </div>
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="banner danger" style={{ marginTop: 12 }} data-testid="live-swap-error">
            <AlertTriangle size={14} />
            {error}
          </div>
        )}
        {quote && quote.impactBps !== null && quote.impactBps >= SWAP_IMPACT_WARN_BPS && (
          <div className="banner warning" style={{ marginTop: 12 }} data-testid="live-swap-impact-warning">
            <AlertTriangle size={14} />
            This pool is small next to your swap, so you receive {impactText(quote.impactBps)} less than the market price. A smaller amount loses less.
          </div>
        )}
        {outUnverified && tokenOut?.address && (
          <div className="banner warning" style={{ marginTop: 12 }} data-testid="live-swap-unverified">
            <AlertTriangle size={14} />
            <span>
              Satori GO cannot vouch for {displaySymbol(tokenOut.symbol)}. Anyone can create a token with this name, and some tokens can be
              bought but never sold again, which the wallet cannot tell in advance. Check its contract address before you swap:{' '}
              <span className="mono" style={{ wordBreak: 'break-all' }}>{tokenOut.address}</span>
            </span>
          </div>
        )}
        {waitingApproval && !waitTimedOut && (
          <div className="banner info" style={{ marginTop: 12 }} data-testid="live-swap-waiting-approval">
            <Info size={14} />
            Approval sent. Waiting for {chain.displayName} to confirm it, then you can review the swap.
          </div>
        )}
        {waitingApproval && waitTimedOut && (
          <div className="banner warning" style={{ marginTop: 12 }} data-testid="live-swap-approval-late">
            <AlertTriangle size={14} />
            <span>
              {chain.displayName} has not confirmed the approval yet. It may still be pending; Activity shows it.{' '}
              <button type="button" className="chip neutral" style={{ cursor: 'pointer' }} onClick={startWaiting} data-testid="live-swap-check-again">
                Check again
              </button>
            </span>
          </div>
        )}

        <Button
          block
          disabled={!step.ready}
          loading={planning}
          onClick={() => void planSwap(slippageBps)}
          style={{ marginTop: 14 }}
          data-testid="live-swap-review-btn"
        >
          {step.label}
        </Button>

        {publicMempool && (
          <div className="text-faint" style={{ fontSize: 11, marginTop: 10, lineHeight: 1.5 }} data-testid="live-swap-mempool-note">
            On {chain.displayName}, pending swaps are public and trading bots can move the price against you, up to your slippage. Keep it low.
          </div>
        )}
        <div className="text-faint" style={{ fontSize: 11, marginTop: 10, lineHeight: 1.5 }}>
          Swaps go through Uniswap v3 pools. Satori GO finds the route and builds the transaction itself
          {quote && quote.feeBps > 0 ? '.' : ', and takes no fee.'}
        </div>
      </div>
      <LiveNav />

      {sheet && (
        <div
          className="overlay sheet-host"
          onClick={(e) => {
            if (e.target === e.currentTarget) setSheet(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setSheet(null);
          }}
        >
          <div className="sheet" role="dialog" aria-modal="true" aria-label={sheet === 'in' ? 'Pay with' : 'Receive'} data-testid="live-swap-sheet">
            <div className="sheet-grip" />
            <h3>{sheet === 'in' ? 'Pay with' : 'Receive'}</h3>
            <TextField
              placeholder="Name, symbol or contract address"
              aria-label="Find a token"
              autoComplete="off"
              spellCheck={false}
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setSearchError('');
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void runSearch(sheet);
              }}
              error={searchError || undefined}
              testId="live-swap-search"
              suffixEl={
                <button
                  type="button"
                  className="chip neutral"
                  style={{ cursor: 'pointer' }}
                  disabled={searching || query.trim() === ''}
                  onClick={() => void runSearch(sheet)}
                  data-testid="live-swap-search-go"
                >
                  {searching ? '…' : 'Find'}
                </button>
              }
            />
            {hits.length > 0 && (
              <div style={{ marginTop: 8 }} data-testid="live-swap-hits">
                {hits.map((hit) => (
                  <button key={hit.address} type="button" className="swap-option" onClick={() => void pickFound(hit.address, sheet)}>
                    <span className="swap-badge" style={{ width: 30, height: 30, fontSize: 13 }} aria-hidden="true">
                      {displaySymbol(hit.symbol).slice(0, 1).toUpperCase() || '?'}
                    </span>
                    <span className="swap-option-name">
                      {displaySymbol(hit.symbol)}
                      <small>{hit.name}</small>
                    </span>
                    <span className="mono swap-option-end">{shortAddress(hit.address)}</span>
                  </button>
                ))}
              </div>
            )}
            <div style={{ marginTop: 8 }}>
              {options.map((t) => {
                const key = tokenKey(t);
                const balance = balanceOf(t);
                const selected = key === (sheet === 'in' ? inKey : outKey);
                return (
                  <button
                    key={key}
                    type="button"
                    className="swap-option"
                    aria-current={selected ? 'true' : undefined}
                    onClick={() => choose(sheet, key)}
                    data-testid={`live-swap-option-${key}`}
                  >
                    {mark(t, 30)}
                    <span className="swap-option-name">
                      {optionLabel(t)}
                      {!vouched.has(key) && <small>Not verified</small>}
                    </span>
                    <span className="swap-option-end">{balance !== null ? formatListAmount(balance, t.decimals) : ''}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
