// Swap one token for another on Uniswap v3, inside the wallet.
//
// The wallet finds the route and builds the transaction itself against pinned
// contracts (src/store/evmSwap.ts), so this screen only ever shows and confirms
// what the store planned. A token swap can take two transactions: an approval
// for the exact amount, then the swap. Each one gets the same review, arming
// gate and password as a send.

import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowDown, CheckCircle, ChevronLeft, Info } from 'lucide-react';
import { Button } from '../../components/Button';
import { PasswordField, TextField } from '../../components/TextField';
import { formatAmount, formatListAmount, parseAmount } from '../../services/chain/amounts';
import { displaySymbol } from '../../services/displaySymbol';
import { activeEvmChain, useLiveStore } from '../../store/liveStore';
import {
  SWAP_IMPACT_WARN_BPS,
  SWAP_SLIPPAGE_DEFAULT_BPS,
  swapNeedsImpactAck,
  type SwapToken,
} from '../../store/evmSwap';
import type { EvmFeeLevel } from '../../services/chain/evm/fees';
import { LiveNav } from './LiveNav';

interface LiveSwapProps {
  onBack(): void;
}

const FEE_LEVELS: readonly EvmFeeLevel[] = ['slow', 'normal', 'fast'];
const FEE_LEVEL_LABEL: Record<EvmFeeLevel, string> = { slow: 'Slow', normal: 'Normal', fast: 'Fast' };
const SLIPPAGE_CHOICES: readonly number[] = [10, 50, 100, 300];
/** How long typing rests before a quote is asked for. */
const QUOTE_DEBOUNCE_MS = 500;
/** How often the allowance is looked at again while an approval confirms. */
const APPROVAL_POLL_MS = 4000;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

const tokenKey = (t: SwapToken) => t.address?.toLowerCase() ?? 'native';
const percent = (bps: number) => `${(bps / 100).toFixed(2).replace(/\.?0+$/, '')}%`;
const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function impactText(bps: number | null): string {
  if (bps === null) return 'Could not be measured';
  return bps < 1 ? 'Less than 0.01%' : percent(bps);
}

export function LiveSwap({ onBack }: LiveSwapProps) {
  const swap = useLiveStore((s) => s.swap);
  const quoteSwap = useLiveStore((s) => s.quoteSwap);
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
  const { options, vouched } = useMemo(() => {
    const native: SwapToken = { address: null, symbol: ticker, decimals: nativeDecimals };
    const list: SwapToken[] = [native];
    const trusted = new Set<string>(['native']);
    const add = (t: { address: string; symbol?: string; decimals?: number }, vouch: boolean) => {
      if (!t.symbol || t.decimals === undefined) return;
      const key = t.address.toLowerCase();
      if (vouch) trusted.add(key);
      if (!list.some((x) => tokenKey(x) === key)) list.push({ address: t.address, symbol: t.symbol, decimals: t.decimals });
    };
    (chain?.defaultTokens ?? []).forEach((t) => add(t, true));
    evmTokens.tracked.forEach((t) => add(t, t.trusted === true));
    evmTokens.discovered.filter((t) => t.trusted === true).forEach((t) => add(t, true));
    found.forEach((t) => add(t as { address: string; symbol: string; decimals: number }, false));
    return { options: list, vouched: trusted };
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
  const [waitingApproval, setWaitingApproval] = useState(false);
  const [done, setDone] = useState<{ txid: string; explorerUrl: string } | null>(null);
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
  const balanceOf = (t: SwapToken | null): bigint | null => {
    if (!t) return null;
    const row = t.address === null
      ? assets.find((a) => a.isNative && a.name === ticker)
      : assets.find((a) => !a.isNative && a.name.toUpperCase() === t.symbol.toUpperCase());
    return row ? row.amountBase : null;
  };
  const balanceIn = balanceOf(tokenIn);
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

  // After an approval is sent: look again until the chain shows the allowance.
  const { quote, plan, quoting, planning, error } = swap;
  useEffect(() => {
    if (!waitingApproval || !tokenIn || !tokenOut || amountIn === null) return;
    if (quote && !quote.needsApproval) {
      setWaitingApproval(false);
      return;
    }
    const timer = setTimeout(() => void quoteSwap(tokenIn, tokenOut, amountIn as bigint), APPROVAL_POLL_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitingApproval, quote, quoteSwap]);

  const isPasswordless = wallets.find((w) => w.id === activeWalletId)?.passwordless ?? false;
  const requirePassword = requirePasswordToSend && !isPasswordless;

  const resetReview = () => {
    setArmed(false);
    setAckImpact(false);
    setPassword('');
    setPasswordError('');
    setConfirmError('');
  };
  const backFromReview = () => {
    clearSwapPlan();
    resetReview();
  };

  const symbolOf = (address: string): string => {
    const known = options.find((t) => t.address?.toLowerCase() === address.toLowerCase());
    return known ? displaySymbol(known.symbol) : shortAddress(address);
  };

  const pickFound = async (address: string, side: 'in' | 'out' = 'out') => {
    setSearchError('');
    setSearching(true);
    try {
      const resolved = await resolveSwapToken(address);
      if (!resolved.ok) {
        setSearchError(resolved.error);
        return;
      }
      setFound((list) => (list.some((t) => tokenKey(t) === tokenKey(resolved.token)) ? list : [...list, resolved.token]));
      if (side === 'in') setInKey(tokenKey(resolved.token));
      else setOutKey(tokenKey(resolved.token));
      setQuery('');
      setHits([]);
    } finally {
      setSearching(false);
    }
  };

  const runSearch = async () => {
    const text = query.trim();
    if (!text) return;
    if (ADDRESS_RE.test(text)) {
      await pickFound(text);
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

  const header = (title: string, back: () => void) => (
    <div className="sub-header">
      <button type="button" className="icon-btn" onClick={back} aria-label="Back">
        <ChevronLeft size={20} />
      </button>
      <h2>{title}</h2>
      <span />
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

  if (done) {
    return (
      <div className="app-frame screen-enter">
        {header('Swap', onBack)}
        <div className="app-content" data-testid="live-swap-done">
          <div className="result-screen">
            <div className="result-icon success">
              <CheckCircle size={32} />
            </div>
            <h3>Swap sent</h3>
            <p>Your tokens arrive once {chain.displayName} confirms it.</p>
            <div className="card" style={{ marginTop: 16, width: '100%', textAlign: 'left' }} data-testid="live-swap-txid">
              <div className="section-label" style={{ marginTop: 0 }}>Transaction hash</div>
              <span className="mono" style={{ fontSize: 11, wordBreak: 'break-all', color: 'var(--text-dim)' }}>{done.txid}</span>
            </div>
            <a href={done.explorerUrl} target="_blank" rel="noreferrer" className="btn btn-secondary btn-sm" style={{ marginTop: 12 }}>
              Open in explorer
            </a>
            <Button block onClick={onBack} style={{ marginTop: 12 }}>
              Done
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (plan) {
    const isApprove = plan.kind === 'approve';
    const needsAck = plan.kind === 'swap' && swapNeedsImpactAck(plan.impactBps);
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
        const result = await confirmSwap(ackImpact);
        resetReview();
        if (result.kind === 'approve') setWaitingApproval(true);
        else setDone({ txid: result.txid, explorerUrl: result.explorerUrl });
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
        {header(isApprove ? 'Review approval' : 'Review swap', backFromReview)}
        <div className="app-content" data-testid="live-swap-review">
          <div className="banner warning" style={{ marginBottom: 14 }}>
            <AlertTriangle size={14} />
            {plan.description} This broadcasts a real transaction on {chain.displayName} and cannot be undone.
          </div>
          {isApprove && (
            <div className="banner info" style={{ marginBottom: 14 }} data-testid="live-swap-step-note">
              <Info size={14} />
              Step 1 of 2. This lets Uniswap take the tokens for this one swap and nothing more. The swap itself is the next step.
            </div>
          )}

          <div className="card solid" style={{ marginBottom: 14 }}>
            <div className="summary-table">
              <div className="sum-row">
                <span className="sum-key">Action</span>
                <span className="sum-val">{isApprove ? `Approve ${displaySymbol(plan.tokenIn.symbol)}` : 'Swap on Uniswap'}</span>
              </div>
              <div className="sum-row" data-testid="live-swap-review-pay">
                <span className="sum-key">{isApprove ? 'Amount allowed' : 'You pay'}</span>
                <span className="sum-val">{formatAmount(plan.amountIn, plan.tokenIn.decimals)} {displaySymbol(plan.tokenIn.symbol)}</span>
              </div>
              {plan.kind === 'swap' && (
                <>
                  <div className="sum-row" data-testid="live-swap-review-receive">
                    <span className="sum-key">You receive about</span>
                    <span className="sum-val">{formatAmount(plan.amountOut, plan.tokenOut.decimals)} {displaySymbol(plan.tokenOut.symbol)}</span>
                  </div>
                  <div className="sum-row" data-testid="live-swap-review-minimum">
                    <span className="sum-key">At least ({percent(plan.slippageBps)} slippage)</span>
                    <span className="sum-val">{formatAmount(plan.minimumOut, plan.tokenOut.decimals)} {displaySymbol(plan.tokenOut.symbol)}</span>
                  </div>
                  <div className="sum-row" data-testid="live-swap-review-impact">
                    <span className="sum-key">Price impact</span>
                    <span className="sum-val" style={needsAck ? { color: 'var(--danger)' } : undefined}>{impactText(plan.impactBps)}</span>
                  </div>
                  <div className="sum-row">
                    <span className="sum-key">Route</span>
                    <span className="sum-val">
                      {[displaySymbol(plan.tokenIn.symbol), ...plan.hops.slice(0, -1).map((h) => symbolOf(h.tokenOut)), displaySymbol(plan.tokenOut.symbol)].join(' › ')}
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
              <div className="sum-row" data-testid="live-swap-review-fee">
                <span className="sum-key">Estimated fee</span>
                <span className="sum-val">{formatAmount(plan.quote.estimatedTotal, nativeDecimals)} {ticker}</span>
              </div>
              <div className="sum-row">
                <span className="sum-key">Maximum fee</span>
                <span className="sum-val">{formatAmount(plan.quote.maxTotal, nativeDecimals)} {ticker}</span>
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
                onClick={() => void selectSwapFeeLevel(lvl)}
                style={{ flex: 1, justifyContent: 'center', cursor: 'pointer' }}
              >
                {FEE_LEVEL_LABEL[lvl]}
              </button>
            ))}
          </div>

          {plan.shortfall && (
            <div className="banner danger" style={{ marginBottom: 14 }} data-testid="live-swap-shortfall">
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
            {needsAck && (
              <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer', marginBottom: 10 }}>
                <input
                  type="checkbox"
                  checked={ackImpact}
                  onChange={(e) => setAckImpact(e.target.checked)}
                  data-testid="live-swap-ack-impact"
                  style={{ marginTop: 2 }}
                />
                <span style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--danger)' }}>
                  {plan.kind === 'swap' && plan.impactBps === null
                    ? 'The price impact of this swap could not be measured. I accept that I may receive much less than the market price.'
                    : `This swap moves the price by ${impactText(plan.kind === 'swap' ? plan.impactBps : null)}. I accept that I receive that much less than the market price.`}
                </span>
              </label>
            )}
            <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={armed}
                onChange={(e) => setArmed(e.target.checked)}
                data-testid="live-swap-arm"
                style={{ marginTop: 2 }}
              />
              <span style={{ fontSize: 12, lineHeight: 1.5 }}>
                I understand this sends a real transaction on {chain.displayName} and cannot be undone.
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
              variant="danger"
              disabled={!armed || blocked || (needsAck && !ackImpact)}
              loading={confirming}
              onClick={() => void handleConfirm()}
              data-testid="live-swap-confirm"
            >
              {isApprove ? 'Approve' : 'Swap'}
            </Button>
          </div>
        </div>
        <LiveNav />
      </div>
    );
  }

  const outUnverified = tokenOut !== null && !vouched.has(tokenKey(tokenOut));
  const canReview = !!quote && !quoting && !planning && !overBalance && !waitingApproval;

  return (
    <div className="app-frame screen-enter">
      {header('Swap', onBack)}
      <div className="app-content" data-testid="live-swap">
        <div className="section-label" style={{ marginTop: 0 }}>You pay</div>
        <select
          className="live-picker"
          data-testid="live-swap-token-in"
          aria-label="Token to pay with"
          value={inKey}
          onChange={(e) => {
            if (e.target.value === outKey) setOutKey(inKey);
            setInKey(e.target.value);
          }}
          style={{ width: '100%', marginBottom: 8 }}
        >
          {options.map((t) => (
            <option key={tokenKey(t)} value={tokenKey(t)}>{displaySymbol(t.symbol)}</option>
          ))}
        </select>
        <TextField
          label={`Amount${tokenIn ? ` (${displaySymbol(tokenIn.symbol)})` : ''}`}
          placeholder="0.00"
          inputMode="decimal"
          autoComplete="off"
          value={amountText}
          onChange={(e) => setAmountText(e.target.value)}
          error={amountError || (overBalance ? 'More than this address holds.' : undefined)}
          hint={tokenIn && balanceIn !== null ? `Balance: ${formatListAmount(balanceIn, tokenIn.decimals)} ${displaySymbol(tokenIn.symbol)}` : undefined}
          testId="live-swap-amount"
          suffixEl={
            tokenIn && tokenIn.address !== null && balanceIn !== null && balanceIn > 0n ? (
              <button
                type="button"
                className="chip neutral"
                style={{ cursor: 'pointer' }}
                onClick={() => setAmountText(formatAmount(balanceIn, tokenIn.decimals))}
                data-testid="live-swap-max"
              >
                Max
              </button>
            ) : undefined
          }
        />

        <div style={{ display: 'flex', justifyContent: 'center', margin: '10px 0' }}>
          <button
            type="button"
            className="icon-btn"
            aria-label="Swap the two tokens around"
            data-testid="live-swap-flip"
            disabled={!tokenOut}
            onClick={() => {
              setInKey(outKey);
              setOutKey(inKey);
              setAmountText('');
            }}
          >
            <ArrowDown size={18} />
          </button>
        </div>

        <div className="section-label" style={{ marginTop: 0 }}>You receive</div>
        <select
          className="live-picker"
          data-testid="live-swap-token-out"
          aria-label="Token to receive"
          value={outKey}
          onChange={(e) => {
            if (e.target.value === inKey) setInKey(outKey || 'native');
            setOutKey(e.target.value);
          }}
          style={{ width: '100%', marginBottom: 8 }}
        >
          <option value="">Choose a token...</option>
          {options.map((t) => (
            <option key={tokenKey(t)} value={tokenKey(t)}>{displaySymbol(t.symbol)}</option>
          ))}
        </select>
        <TextField
          label="Find another token"
          placeholder="Name, symbol or contract address"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSearchError('');
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void runSearch();
          }}
          error={searchError || undefined}
          testId="live-swap-search"
          suffixEl={
            <button
              type="button"
              className="chip neutral"
              style={{ cursor: 'pointer' }}
              disabled={searching || query.trim() === ''}
              onClick={() => void runSearch()}
              data-testid="live-swap-search-go"
            >
              {searching ? '…' : 'Find'}
            </button>
          }
        />
        {hits.length > 0 && (
          <div className="card" style={{ marginTop: 8, padding: 6 }} data-testid="live-swap-hits">
            {hits.map((hit) => (
              <button
                key={hit.address}
                type="button"
                className="chip neutral"
                style={{ display: 'flex', width: '100%', justifyContent: 'space-between', cursor: 'pointer', marginBottom: 4 }}
                onClick={() => void pickFound(hit.address)}
              >
                <span>{displaySymbol(hit.symbol)} · {hit.name}</span>
                <span className="mono" style={{ fontSize: 10.5 }}>{shortAddress(hit.address)}</span>
              </button>
            ))}
          </div>
        )}

        {outUnverified && tokenOut?.address && (
          <div className="banner warning" style={{ marginTop: 12 }} data-testid="live-swap-unverified">
            <AlertTriangle size={14} />
            <span>
              Satori GO cannot vouch for {displaySymbol(tokenOut.symbol)}. Anyone can create a token with this name, so check its contract
              address before you swap: <span className="mono" style={{ wordBreak: 'break-all' }}>{tokenOut.address}</span>
            </span>
          </div>
        )}

        <div className="section-label">Slippage</div>
        <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
          {SLIPPAGE_CHOICES.map((bps) => (
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

        {quoting && !quote && (
          <div className="text-faint" style={{ fontSize: 12, marginBottom: 14 }} data-testid="live-swap-quoting">
            Asking Uniswap for a price...
          </div>
        )}
        {error && (
          <div className="banner danger" style={{ marginBottom: 14 }} data-testid="live-swap-error">
            <AlertTriangle size={14} />
            {error}
          </div>
        )}

        {quote && (
          <div className="card solid" style={{ marginBottom: 14 }} data-testid="live-swap-quote">
            <div className="summary-table">
              <div className="sum-row" data-testid="live-swap-quote-out">
                <span className="sum-key">You receive about</span>
                <span className="sum-val">{formatListAmount(quote.amountOut, quote.tokenOut.decimals)} {displaySymbol(quote.tokenOut.symbol)}</span>
              </div>
              <div className="sum-row" data-testid="live-swap-quote-impact">
                <span className="sum-key">Price impact</span>
                <span
                  className="sum-val"
                  style={quote.impactBps === null || quote.impactBps >= SWAP_IMPACT_WARN_BPS ? { color: 'var(--danger)' } : undefined}
                >
                  {impactText(quote.impactBps)}
                </span>
              </div>
              <div className="sum-row">
                <span className="sum-key">Route</span>
                <span className="sum-val">
                  {[displaySymbol(quote.tokenIn.symbol), ...quote.hops.slice(0, -1).map((h) => symbolOf(h.tokenOut)), displaySymbol(quote.tokenOut.symbol)].join(' › ')}
                </span>
              </div>
            </div>
          </div>
        )}
        {quote && quote.impactBps !== null && quote.impactBps >= SWAP_IMPACT_WARN_BPS && (
          <div className="banner warning" style={{ marginBottom: 14 }} data-testid="live-swap-impact-warning">
            <AlertTriangle size={14} />
            This pool is small next to your swap, so you receive {impactText(quote.impactBps)} less than the market price. A smaller amount loses less.
          </div>
        )}

        {waitingApproval && (
          <div className="banner info" style={{ marginBottom: 14 }} data-testid="live-swap-waiting-approval">
            <Info size={14} />
            Approval sent. Waiting for {chain.displayName} to confirm it, then you can review the swap.
          </div>
        )}

        <Button
          block
          disabled={!canReview}
          loading={planning}
          onClick={() => void planSwap(slippageBps)}
          data-testid="live-swap-review-btn"
        >
          {waitingApproval ? 'Waiting for approval' : quote?.needsApproval ? `Approve ${displaySymbol(quote.tokenIn.symbol)}` : 'Review swap'}
        </Button>
        <div className="text-faint" style={{ fontSize: 11, marginTop: 10, lineHeight: 1.5 }}>
          Swaps go through Uniswap v3 pools. Satori GO finds the route and builds the transaction itself, and takes no fee.
        </div>
      </div>
      <LiveNav />
    </div>
  );
}
