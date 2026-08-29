// MetaMask-style network switcher for the wallet header. A compact trigger
// shows the ACTIVE chain (coin mark + name); clicking it opens a small popover
// listing all supported chains, UTXO and EVM alike. A chain the wallet already
// has is a straight switchChain(); a chain with no wallet yet opens a short
// confirm step that enables it FROM THE SAME SECRET (so nothing needs to be
// retyped) via enableChain(id, password).
//
// EVM is a DIFFERENT gesture wearing the same control (the EVM engine design notes
// §1 and §11 item 4): a UTXO row switches to a sibling WALLET on that chain, an
// EVM row switches the CHAIN WITHIN the one EVM account (the address never
// changes). switchChain/enableChain already know the difference; this component
// only has to stop assuming every chain id is a UTXO LiveNetworkId.
//
// Deliberately self-contained (own trigger + own popover + own outside-click/
// Escape handling) so mounting it is a single `<ChainSwitcher />` line — see
// LiveHome.tsx, which only adds that one line next to the wallet switcher.

import { useEffect, useState, type FormEvent } from 'react';
import { Check, ChevronDown, Info } from 'lucide-react';
import { TokenIcon } from '../../components/BrandLogo';
import { PasswordField } from '../../components/TextField';
import { Button } from '../../components/Button';
import {
  useLiveStore,
  chainsWithWallets,
  walletOnChain,
  activeChainTarget,
  describeChain,
} from '../../store/liveStore';
import { useNav } from './LiveNav';
import { networkFor, chainsShareDerivation, type EvrmoreNetwork } from '../../services/chain/chainParams';
import { isEvmChainTarget } from '../../store/evmChains';
import { chainOptionsFor, type ChainChoice } from './ChainPicker';

/** The UTXO params for a chain id, or null for an EVM target (`evm:<key>`).
 *  Centralises the family test so nothing here calls networkFor() on an EVM
 *  id — TypeScript narrows `id` inside this function, which a plain `||`
 *  expression at the call site cannot do. */
function utxoNetOf(id: ChainChoice): EvrmoreNetwork | null {
  return isEvmChainTarget(id) ? null : networkFor(id);
}

/** What TokenIcon should draw for a chain row: the network mark (`evm:<key>`)
 *  for an EVM chain, the native coin's mark for a UTXO chain. */
function chainMarkId(desc: { id: string; family: string; ticker: string } | null | undefined): string {
  if (!desc) return '';
  return desc.family === 'evm' ? desc.id : desc.ticker;
}

export function ChainSwitcher() {
  const wallets = useLiveStore((s) => s.wallets);
  const switchChain = useLiveStore((s) => s.switchChain);
  const { tab, openTab } = useNav();
  const enableChain = useLiveStore((s) => s.enableChain);
  // Empty in a build without the EVM engine, which collapses every branch below
  // back to the UTXO-only switcher this always was.
  const evmChains = useLiveStore((s) => s.evm.chains);

  const [open, setOpen] = useState(false);
  // Which chain the "enable" confirm step is showing for; null = plain list.
  const [enableTarget, setEnableTarget] = useState<ChainChoice | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // The chain id the UI treats as active: a UTXO LiveNetworkId, or the
  // `evm:<key>` target the active EVM account is currently showing.
  const currentChainId = activeChainTarget() as ChainChoice;
  const currentDesc = describeChain(currentChainId, evmChains);
  const currentDisplayName = currentDesc?.displayName ?? currentChainId;
  // Chains the wallet already has a key for -> clicking switches; anything
  // else -> clicking offers to enable it. One EVM account enables every EVM
  // chain this build knows, so this Set already carries that (see
  // chainsWithWallets's own doc comment).
  const withWallets = chainsWithWallets(wallets, evmChains.map((c) => c.key));
  // The wallet actually IN USE on the active chain right now — its passwordless
  // flag decides whether the enable step needs a password field, and its KIND
  // decides how the linkability warning fires (see linkableAddresses below).
  // Chains the user switched off in expert Settings are not offered here. The
  // one in use is always kept, so a chain hidden by a stale render can never
  // strand the user on a network absent from their own list.
  const hiddenChains = useLiveStore((s) => s.hiddenChains);
  const allChainIds = chainOptionsFor(evmChains).map((o) => o.value);
  // Hidden chains: a UTXO chain by its canonical id, an EVM chain by its
  // `evm:<key>` target (Settings > Visible networks lists both). The one in
  // use is always kept.
  const visibleChains = allChainIds.filter((id) => {
    if (id === currentChainId) return true;
    const net = utxoNetOf(id);
    return net ? !hiddenChains.includes(net.chainId) : !hiddenChains.includes(id);
  });
  const activeWallet = walletOnChain(wallets, currentChainId);
  const activePasswordless = activeWallet?.passwordless ?? false;
  // Its vault is wrapped by the app master key, so the password that opens it is
  // the APP password. Only the field's LABEL depends on this: the store's reveal
  // path verifies whichever password the wallet actually has.
  const activeIsAppProtected = activeWallet?.appProtected ?? false;
  // 'pk' = a single imported private key (no seed, no derivation). enableChain
  // re-imports that SAME key on the target chain, so the hash160 — and thus the
  // address, bar the version byte — is identical on EVERY UTXO chain pair.
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
      // A chain switch lands on the Wallet tab, like a wallet switch: the
      // balances are the first thing to check on the chain just entered.
      if (tab !== 'assets') openTab('assets');
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

  const targetDesc = enableTarget ? describeChain(enableTarget, evmChains) : null;
  const targetDisplayName = targetDesc?.displayName ?? enableTarget ?? '';
  const enableTargetIsEvm = enableTarget !== null && isEvmChainTarget(enableTarget);
  // Show the "publicly linkable" note whenever enabling `enableTarget` yields a
  // UTXO address anyone can tie to the current one:
  //  - SEED wallets: only when the chains share derivation (same coin type +
  //    BIP32 bytes, e.g. Evrmore/Ravencoin) does one seed repeat a key;
  //  - 'pk' wallets: ALWAYS — the same imported key is reused on every chain,
  //    which chainsShareDerivation (a derivation-path predicate) cannot see.
  // Without the kind check the warning under-fired exactly where linkability
  // always holds; like the predicate itself, this must fail toward
  // over-warning, never under-warning.
  //
  // UTXO-only: an EVM address is derived with a different hash function
  // entirely (keccak256, not hash160), so reusing the same key across a
  // UTXO/EVM pair produces addresses with no visible byte relationship — there
  // is nothing to warn about from public data alone, and chainsShareDerivation
  // must never be called with an `evm:<key>` id (it calls networkFor()).
  const bothUtxo = !isEvmChainTarget(currentChainId) && !enableTargetIsEvm;
  const linkableAddresses =
    enableTarget !== null && bothUtxo && (activeIsPk || chainsShareDerivation(currentChainId, enableTarget));

  return (
    // A FRAGMENT, not a wrapper div: the trigger is the header's own left flex
    // item (see .app-header .chain-trigger in global.css, which owns its floor
    // and its cap), and both the popover and its overlay are taken out of flow,
    // so a wrapper would only have hidden the trigger from the header's flex
    // sizing. The popover anchors to .app-header (position:relative, z-index 3)
    // via .menu-pop's own top/left, so it can be wider than the trigger chip
    // without clipping past the frame's left edge.
    <>
      <button
        type="button"
        className="chip neutral chain-trigger"
        data-testid="live-chain-switcher"
        aria-label={`Switch network, current: ${currentDisplayName}`}
        title={currentDisplayName}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <TokenIcon assetId={chainMarkId(currentDesc)} size={14} />
        {/* Classed, not just styled: the side-panel smoke measures how much of
            the chain name survives at 320px through this exact element. */}
        <span
          className="chain-trigger-text"
          style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}
        >
          {currentDisplayName}
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
          {/* Anchored LEFT, under the trigger it belongs to (.menu-pop's own
              right:14px is overridden here). 300px (was a cramped 224) is wide
              enough that the enable-chain confirm title fits on one line, and
              the calc keeps it inside a 320px side panel. */}
          <div
            className="menu-pop"
            data-testid="live-chain-dropdown"
            /* Eleven chains (seven UTXO + four EVM) no longer fit the 600px
               popup: the list is capped to the viewport and scrolls (owner,
               2026-08-20: "not all networks fit and it cannot be scrolled").
               Viewport units, not %, because the containing block is the
               header, not the frame. */
            style={{
              left: 14,
              right: 'auto',
              width: 'min(300px, calc(100% - 28px))',
              maxHeight: 'calc(100vh - 110px)',
              overflowY: 'auto',
            }}
          >
            {!enableTarget ? (
              <div role="listbox" aria-label="Chains" data-testid="live-chain-list">
                <div className="section-label" style={{ padding: '2px 9px 2px' }}>
                  Switch network
                </div>
                <div className="text-faint" style={{ fontSize: 9.5, padding: '0 9px 8px', lineHeight: 1.35 }}>
                  Switching changes your receiving address: each chain derives its own.
                  {evmChains.length > 0 ? ' EVM chains share one account and one address.' : ''}
                </div>
                {visibleChains.map((chainId) => {
                  const desc = describeChain(chainId, evmChains);
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
                      <TokenIcon assetId={chainMarkId(desc)} size={20} />
                      {/* Name plus the project's own domain. This list is where a
                          user decides WHICH chain they mean, and several names
                          collide with better-known coins, so the domain is the
                          part that actually disambiguates. EVM rows carry one
                          too since 2026-08-26: the earlier reasoning (an EVM row
                          is one account, not a project) was about the ACCOUNT
                          being shared, but the row still names a specific chain
                          and Ethereum, Base, BNB Chain and Epix each have a site
                          of their own. */}
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span
                          style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}
                        >
                          <span
                            style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                          >
                            {desc?.displayName ?? chainId}
                          </span>
                          {/* Marked HERE, at the moment the user picks a chain,
                              not only after they are on it. `isNew`, not
                              `young`: a chain can be new in this wallet and a
                              mature network out there, and the chip must not
                              imply the warning that `young` carries. */}
                          {desc?.isNew && (
                            <span
                              className="chip warning"
                              data-testid={`live-chain-young-${chainId}`}
                              title={
                                desc.young
                                  ? 'Young network. Open it to read why this matters.'
                                  : 'Recently added to Satori GO.'
                              }
                              style={{ fontSize: 8.5, padding: '1px 5px', flexShrink: 0 }}
                            >
                              New
                            </span>
                          )}
                        </span>
                        {desc?.homepage && (
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
                            {desc.homepage.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '')}
                          </span>
                        )}
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
                  <TokenIcon assetId={chainMarkId(targetDesc)} size={18} />
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    Enable {targetDisplayName} for this wallet?
                  </span>
                </div>
                {/* A 'pk' wallet has no recovery phrase — its single imported key
                    is what gets reused — so the seed wording would be false for
                    it. The copy must match what enableChain actually does. */}
                <p className="text-dim" style={{ fontSize: 11, lineHeight: 1.4, margin: '0 0 10px' }}>
                  {activeIsPk ? (
                    <>
                      This reuses your imported private key on {targetDisplayName}, so nothing
                      needs to be retyped. Your {currentDisplayName} address stays the same.
                    </>
                  ) : (
                    <>
                      This derives a new address on {targetDisplayName} from the same recovery
                      phrase, so nothing needs to be retyped. Your {currentDisplayName} address
                      stays the same.
                    </>
                  )}
                </p>
                {enableTargetIsEvm ? (
                  <div
                    className="banner info"
                    data-testid="live-chain-evm-derivation-note"
                    style={{ marginBottom: 10, alignItems: 'flex-start' }}
                  >
                    <Info size={14} />
                    <span>
                      Derived from this wallet&apos;s phrase at the standard EVM path (m/44&apos;/60&apos;/0&apos;/0/0), the
                      same address MetaMask shows for it.
                    </span>
                  </div>
                ) : (
                  linkableAddresses && (
                    <div
                      className="banner info"
                      data-testid="live-chain-privacy-note"
                      style={{ marginBottom: 10, alignItems: 'flex-start' }}
                    >
                      <Info size={14} />
                      <span>
                        {targetDisplayName} and {currentDisplayName} share the same key, so the two
                        addresses are publicly linkable.
                      </span>
                    </div>
                  )
                )}
                {!activePasswordless && (
                  <PasswordField
                    /* An app-key wallet has no password of its own: the one that
                       opens its vault is the app password, so asking for a
                       "wallet password" would be asking for something that no
                       longer exists (the app-password design notes). */
                    label={activeIsAppProtected ? 'App password' : 'Wallet password'}
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
    </>
  );
}
