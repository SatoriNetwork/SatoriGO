// MetaMask-style network switcher for the wallet header. A compact trigger
// shows the ACTIVE chain (coin mark + name); clicking it opens a small popover
// listing all supported chains. A chain the wallet already has is a straight
// switchChain(); a chain with no wallet yet opens a short confirm step that
// enables it FROM THE SAME SECRET (so nothing needs to be retyped) via
// enableChain(id, password).
//
// Deliberately self-contained (own trigger + own popover + own outside-click/
// Escape handling) so mounting it is a single `<ChainSwitcher />` line — see
// LiveHome.tsx, which only adds that one line next to the wallet switcher.

import { useEffect, useState, type FormEvent } from 'react';
import { Check, ChevronDown, Info } from 'lucide-react';
import { TokenIcon } from '../../components/BrandLogo';
import { PasswordField } from '../../components/TextField';
import { Button } from '../../components/Button';
import { useLiveStore, chainsWithWallets, walletOnChain, activeChainId } from '../../store/liveStore';
import { networkFor, chainsShareDerivation, isYoungChain } from '../../services/chain/chainParams';
import { CHAIN_OPTIONS, type ChainChoice } from './ChainPicker';

/** Every chain the switcher can list, in the same canonical order ChainPicker
 *  already uses (Evrmore first) — one source of truth for "the four chains". */
const ALL_CHAINS: ChainChoice[] = CHAIN_OPTIONS.map((o) => o.value);

export function ChainSwitcher() {
  const wallets = useLiveStore((s) => s.wallets);
  const switchChain = useLiveStore((s) => s.switchChain);
  const enableChain = useLiveStore((s) => s.enableChain);

  const [open, setOpen] = useState(false);
  // Which chain the "enable" confirm step is showing for; null = plain list.
  const [enableTarget, setEnableTarget] = useState<ChainChoice | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const currentChainId = activeChainId() as ChainChoice;
  const currentNet = networkFor(currentChainId);
  // Chains the wallet already has a key for -> clicking switches; anything
  // else -> clicking offers to enable it.
  const withWallets = chainsWithWallets(wallets);
  // The wallet actually IN USE on the active chain right now — its passwordless
  // flag decides whether the enable step needs a password field, and its KIND
  // decides how the linkability warning fires (see linkableAddresses below).
  // Chains the user switched off in expert Settings are not offered here. The
  // one in use is always kept, so a chain hidden by a stale render can never
  // strand the user on a network absent from their own list.
  const hiddenChains = useLiveStore((s) => s.hiddenChains);
  const visibleChains = ALL_CHAINS.filter(
    (id) => !hiddenChains.includes(networkFor(id).chainId) || id === currentChainId,
  );
  const activeWallet = walletOnChain(wallets, currentChainId);
  const activePasswordless = activeWallet?.passwordless ?? false;
  // 'pk' = a single imported private key (no seed, no derivation). enableChain
  // re-imports that SAME key on the target chain, so the hash160 — and thus the
  // address, bar the version byte — is identical on EVERY chain pair.
  const activeIsPk = activeWallet?.kind === 'pk';

  function closeAll() {
    setOpen(false);
    setEnableTarget(null);
    setPassword('');
    setError(null);
    setSubmitting(false);
  }

  // Escape closes the whole switcher, list or confirm step alike.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeAll();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function backToList() {
    setEnableTarget(null);
    setPassword('');
    setError(null);
  }

  function handleRowClick(chainId: ChainChoice) {
    if (chainId === currentChainId) {
      setOpen(false);
      return;
    }
    if (withWallets.has(chainId)) {
      setOpen(false);
      void switchChain(chainId);
      return;
    }
    setEnableTarget(chainId);
    setPassword('');
    setError(null);
  }

  async function handleEnableSubmit(e: FormEvent) {
    e.preventDefault();
    if (!enableTarget || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      // A passwordless active wallet has nothing to re-enter — the spec is an
      // empty passphrase, not a UI asking for one that doesn't exist.
      const result = await enableChain(enableTarget, activePasswordless ? '' : password);
      if (result.ok) {
        closeAll();
      } else {
        setError(result.error || 'Could not enable this chain.');
        setSubmitting(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  const targetNet = enableTarget ? networkFor(enableTarget) : null;
  // Show the "publicly linkable" note whenever enabling `enableTarget` yields an
  // address anyone can tie to the current one:
  //  - SEED wallets: only when the chains share derivation (same coin type +
  //    BIP32 bytes, e.g. Evrmore/Ravencoin) does one seed repeat a key;
  //  - 'pk' wallets: ALWAYS — the same imported key is reused on every chain,
  //    which chainsShareDerivation (a derivation-path predicate) cannot see.
  // Without the kind check the warning under-fired exactly where linkability
  // always holds; like the predicate itself, this must fail toward
  // over-warning, never under-warning.
  const linkableAddresses =
    enableTarget !== null && (activeIsPk || chainsShareDerivation(currentChainId, enableTarget));

  return (
    // NOT position:relative — the popover anchors to the app-header (the
    // nearest positioned ancestor) via .menu-pop's own top/right, so it can be
    // wider than the trigger chip without clipping past the popup's left edge.
    <div style={{ display: 'inline-flex' }}>
      <button
        type="button"
        className="chip neutral"
        data-testid="live-chain-switcher"
        aria-label="Switch network"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{ cursor: 'pointer', padding: '4px 8px 4px 6px', maxWidth: 132 }}
      >
        <TokenIcon assetId={currentNet.ticker} size={14} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
          {currentNet.displayName}
        </span>
        <ChevronDown size={11} style={{ flexShrink: 0 }} />
      </button>

      {open && (
        <>
          {/* Outside-click closer — same pattern as the wallet switcher's own
              overlay in LiveHome. Fixed (not absolute) so it covers the whole
              popup regardless of which ancestor happens to be positioned. */}
          <div
            data-testid="live-chain-switcher-overlay"
            style={{ position: 'fixed', inset: 0, zIndex: 49 }}
            onClick={closeAll}
          />
          {/* 300px (was a cramped 224): wide enough that the enable-chain
              confirm title fits on one line. Position comes from .menu-pop
              itself (top 52 / right 14, anchored to the header). */}
          <div className="menu-pop" data-testid="live-chain-dropdown" style={{ width: 300 }}>
            {!enableTarget ? (
              <div role="listbox" aria-label="Chains" data-testid="live-chain-list">
                <div className="section-label" style={{ padding: '2px 9px 2px' }}>
                  Switch network
                </div>
                <div className="text-faint" style={{ fontSize: 9.5, padding: '0 9px 8px', lineHeight: 1.35 }}>
                  Switching changes your receiving address: each chain derives its own.
                </div>
                {visibleChains.map((chainId) => {
                  const net = networkFor(chainId);
                  const isCurrent = chainId === currentChainId;
                  const hasWallet = withWallets.has(chainId);
                  return (
                    <button
                      key={chainId}
                      type="button"
                      className="opt-row"
                      role="option"
                      aria-selected={isCurrent}
                      aria-current={isCurrent ? 'true' : undefined}
                      data-testid={`live-chain-option-${chainId}`}
                      onClick={() => handleRowClick(chainId)}
                    >
                      <TokenIcon assetId={net.ticker} size={20} />
                      {/* Name plus the project's own domain. This list is where a
                          user decides WHICH chain they mean, and several names
                          collide with better-known coins, so the domain is the
                          part that actually disambiguates. */}
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span
                          style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}
                        >
                          <span
                            style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                          >
                            {net.displayName}
                          </span>
                          {/* A young network is marked HERE, at the moment the
                              user picks a chain, not only after they are on it. */}
                          {isYoungChain(net) && (
                            <span
                              className="chip warning"
                              data-testid={`live-chain-young-${chainId}`}
                              title="Young network. Open it to read why this matters."
                              style={{ fontSize: 8.5, padding: '1px 5px', flexShrink: 0 }}
                            >
                              New
                            </span>
                          )}
                        </span>
                        <span
                          className="text-faint"
                          style={{
                            display: 'block',
                            fontSize: 9,
                            fontWeight: 500,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {net.homepage.replace(/^https?:\/\//i, '').replace(/\/$/, '')}
                        </span>
                      </span>
                      {!hasWallet && (
                        <span className="chip neutral" style={{ fontSize: 8.5, padding: '1px 6px', flexShrink: 0 }}>
                          Add
                        </span>
                      )}
                      {isCurrent && <Check size={15} className="opt-check" />}
                    </button>
                  );
                })}
              </div>
            ) : (
              <form onSubmit={handleEnableSubmit} data-testid="live-chain-enable-panel" style={{ padding: '8px 9px 9px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, fontWeight: 700, marginBottom: 7 }}>
                  <TokenIcon assetId={targetNet!.ticker} size={18} />
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    Enable {targetNet!.displayName} for this wallet?
                  </span>
                </div>
                {/* A 'pk' wallet has no recovery phrase — its single imported key
                    is what gets reused — so the seed wording would be false for
                    it. The copy must match what enableChain actually does. */}
                <p className="text-dim" style={{ fontSize: 11, lineHeight: 1.4, margin: '0 0 10px' }}>
                  {activeIsPk ? (
                    <>
                      This reuses your imported private key on {targetNet!.displayName}, so nothing
                      needs to be retyped. Your {currentNet.displayName} address stays the same.
                    </>
                  ) : (
                    <>
                      This derives a new address on {targetNet!.displayName} from the same recovery
                      phrase, so nothing needs to be retyped. Your {currentNet.displayName} address
                      stays the same.
                    </>
                  )}
                </p>
                {linkableAddresses && (
                  <div
                    className="banner info"
                    data-testid="live-chain-privacy-note"
                    style={{ marginBottom: 10, alignItems: 'flex-start' }}
                  >
                    <Info size={14} />
                    <span>
                      {targetNet!.displayName} and {currentNet.displayName} share the same key, so the two
                      addresses are publicly linkable.
                    </span>
                  </div>
                )}
                {!activePasswordless && (
                  <PasswordField
                    label="Wallet password"
                    placeholder="Enter password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    testId="live-chain-enable-password"
                    showLabel="Show password"
                    hideLabel="Hide password"
                  />
                )}
                {error && (
                  <div className="banner danger" role="alert" data-testid="live-chain-enable-error" style={{ marginTop: 10, marginBottom: 0 }}>
                    {error}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={backToList}
                    data-testid="live-chain-enable-cancel"
                    style={{ flex: 1 }}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    size="sm"
                    loading={submitting}
                    data-testid="live-chain-enable-submit"
                    style={{ flex: 1 }}
                  >
                    Enable
                  </Button>
                </div>
              </form>
            )}
          </div>
        </>
      )}
    </div>
  );
}
