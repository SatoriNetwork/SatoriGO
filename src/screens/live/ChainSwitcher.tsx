// MetaMask-style network switcher for the wallet header. A compact trigger
// shows the ACTIVE chain (coin mark + name); clicking it opens a small popover
// listing all supported chains, UTXO and EVM alike. A chain the ACTIVE
// WALLET'S SEED GROUP already has is a straight switchChain() to that sibling;
// a chain the group has no wallet on yet opens a short confirm step that
// enables it FROM THE SAME SECRET (so nothing needs to be retyped) via
// enableChain(id, password). SEED-SCOPED (the owner's chain-scoping rule):
// "Wallet 1" with no Monero sibling is offered Add on the Monero row even when
// another phrase already has a Monero wallet; it never jumps to that one. A
// wallet outside any seed group (an imported key, a Monero wallet from 25
// words) keeps the older behaviour: any wallet on the chain counts. Both
// rules live in walletOnChain(); this component only asks it per row.
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

import { useEffect, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { Check, ChevronDown, ChevronUp, Info, Star } from 'lucide-react';
import { TokenIcon } from '../../components/BrandLogo';
import { PasswordField, TextField } from '../../components/TextField';
import { Button } from '../../components/Button';
import {
  useLiveStore,
  walletOnChain,
  activeChainTarget,
  describeChain,
} from '../../store/liveStore';
import { useNav } from './LiveNav';
import { useSettingsStore } from '../../store/settingsStore';
import { moveFavouriteChain, toggleFavouriteChain } from '../../services/favouriteChains';
import { networkFor, chainsShareDerivation, type EvrmoreNetwork } from '../../services/chain/chainParams';
import { moneroPhraseUsedBefore } from '../../services/chain/engine';
import { localIsoDate, MONERO_GENESIS_DATE, restoreHeightFromDate } from '../../services/moneroDates';
import { isEvmChainTarget } from '../../store/evmChains';
import { isMoneroChainTarget } from '../../store/moneroChains';
import { isZcashChainTarget } from '../../store/zcashChain';
import { isTaoChainTarget } from '../../store/taoChain';
import { isEngineChainTarget, switcherChainOptionsFor, type SwitcherChainId } from './ChainPicker';

/** The UTXO params for a chain id, or null for an EVM target (`evm:<key>`) or
 *  an engine target (Monero, Zcash, Bittensor). Centralises the family test so
 *  nothing here calls networkFor() on a non-UTXO id — TypeScript narrows `id`
 *  inside this function, which a plain `||` expression at the call site
 *  cannot do. */
function utxoNetOf(id: SwitcherChainId): EvrmoreNetwork | null {
  return isEvmChainTarget(id) || isEngineChainTarget(id) ? null : networkFor(id);
}

/** What TokenIcon should draw for a chain row: the network mark (`evm:<key>`)
 *  for an EVM chain, the native coin's mark for a UTXO chain. */
function chainMarkId(desc: { id: string; family: string; ticker: string } | null | undefined): string {
  if (!desc) return '';
  return desc.family === 'evm' ? desc.id : desc.ticker;
}

/** The homepage as the row shows it: no scheme, no `www.`, no trailing slash.
 *  The search matches against this same string, so what the user reads is
 *  what they can type. */
function homepageHost(homepage: string | undefined): string {
  if (!homepage) return '';
  return homepage.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '');
}

/** Autofocus the search only where a keyboard is already in hand. On a phone
 *  (coarse pointer) focusing it would throw the on-screen keyboard over the
 *  very list the user opened the dropdown to look at. Guarded: jsdom and a
 *  non-DOM context may have no matchMedia at all. */
function prefersSearchAutofocus(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return !window.matchMedia('(pointer: coarse)').matches;
}

/** One row of the chain list: what it is and whether it switches or adds. */
interface ChainRow {
  chainId: SwitcherChainId;
  desc: ReturnType<typeof describeChain>;
  isCurrent: boolean;
  /** True = a straight switch (no Add chip); false = the enable step. */
  hasWallet: boolean;
}

export function ChainSwitcher() {
  const wallets = useLiveStore((s) => s.wallets);
  const switchChain = useLiveStore((s) => s.switchChain);
  const { tab, openTab } = useNav();
  const enableChain = useLiveStore((s) => s.enableChain);
  // Empty in a build without the EVM engine, which collapses every branch below
  // back to the UTXO-only switcher this always was.
  const evmChains = useLiveStore((s) => s.evm.chains);
  // The one Monero row, null in a build without --monero (no row, no Add).
  // Optional chaining: the switcher's own tests mock the store without this
  // slice, and a missing slice must read as "no Monero", not crash.
  const moneroChain = useLiveStore((s) => s.monero?.chain ?? null);

  const [open, setOpen] = useState(false);
  // Which chain the "enable" confirm step is showing for; null = plain list.
  const [enableTarget, setEnableTarget] = useState<SwitcherChainId | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // "Add Monero" only: has this phrase been used with Monero before (Satori GO
  // on another device, or Cake Wallet with the same words)? Decides where the
  // scan starts (the Monero engine design notes §6.6): the release floor when
  // yes, today's tip when no. Preset from the phrase's origin when the panel
  // opens (see handleRowClick); the user can override it either way.
  const [moneroUsedBefore, setMoneroUsedBefore] = useState(false);
  // Optional "First used around" date, shown only while the box is ticked. It
  // turns into a restore height (restoreHeightFromDate: the shared estimator,
  // one week of margin) that replaces the release floor. Empty = the floor, as
  // before the field existed.
  const [moneroFirstUsed, setMoneroFirstUsed] = useState('');
  const [moneroDateError, setMoneroDateError] = useState<string | null>(null);
  // The list's search box. Seventeen chains need a scroll; typing two letters
  // should not. Cleared whenever the dropdown closes.
  const [query, setQuery] = useState('');
  // Starred networks, oldest star first: a per-device UI preference (Settings),
  // not tied to the open wallet. Ids with no row in this build are skipped
  // below and left untouched in storage (see favouriteChains.ts).
  const favouriteChains = useSettingsStore((s) => s.settings.favouriteChains);
  const updateSettings = useSettingsStore((s) => s.update);

  // The chain id the UI treats as active: a UTXO LiveNetworkId, or the
  // `evm:<key>` target the active EVM account is currently showing.
  const currentChainId = activeChainTarget() as SwitcherChainId;
  const currentDesc = describeChain(currentChainId, evmChains, moneroChain);
  const currentDisplayName = currentDesc?.displayName ?? currentChainId;
  // Chains the ACTIVE wallet's seed group already has a wallet on -> clicking
  // switches to that sibling; anything else -> clicking offers to enable it
  // for THIS group. walletOnChain answers null exactly when the group has no
  // wallet there (another phrase's wallet on that chain does not count), and
  // keeps the any-wallet rule for a wallet outside every group. An active EVM
  // account covers every EVM chain this build knows (one address on all).
  const hasWalletFor = (chainId: SwitcherChainId): boolean => walletOnChain(wallets, chainId) !== null;
  // The wallet actually IN USE right now — its passwordless flag decides
  // whether the enable step needs a password field, and its KIND decides how
  // the linkability warning fires (see linkableAddresses below).
  // Chains the user switched off in expert Settings are not offered here. The
  // one in use is always kept, so a chain hidden by a stale render can never
  // strand the user on a network absent from their own list.
  const hiddenChains = useLiveStore((s) => s.hiddenChains);
  const allChainIds = switcherChainOptionsFor(evmChains, moneroChain).map((o) => o.value);
  // Hidden chains: a UTXO chain by its canonical id, an EVM chain by its
  // `evm:<key>` target (Settings > Visible networks lists both). The one in
  // use is always kept.
  const visibleChains = allChainIds.filter((id) => {
    if (id === currentChainId) return true;
    const net = utxoNetOf(id);
    return net ? !hiddenChains.includes(net.chainId) : !hiddenChains.includes(id);
  });
  const activeWallet = wallets.find((w) => w.active) ?? walletOnChain(wallets, currentChainId);
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
    setQuery('');
    setMoneroFirstUsed('');
    setMoneroDateError(null);
  }

  // Escape closes the whole switcher, list or confirm step alike. On the list
  // with something typed in the search, the first Escape only clears it (the
  // usual search-box gesture) and the second one closes.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (!enableTarget && query !== '') {
        setQuery('');
        return;
      }
      closeAll();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, enableTarget, query]);

  function backToList() {
    setEnableTarget(null);
    setPassword('');
    setError(null);
    setMoneroFirstUsed('');
    setMoneroDateError(null);
  }

  function handleRowClick(chainId: SwitcherChainId) {
    if (chainId === currentChainId) {
      setOpen(false);
      setQuery('');
      return;
    }
    if (hasWalletFor(chainId)) {
      setOpen(false);
      setQuery('');
      // A chain switch lands on the Wallet tab, like a wallet switch: the
      // balances are the first thing to check on the chain just entered.
      if (tab !== 'assets') openTab('assets');
      void switchChain(chainId);
      return;
    }
    setEnableTarget(chainId);
    setPassword('');
    setError(null);
    // A phrase generated on this install cannot hold Monero yet; anything
    // else (typed in, or from before the origin was recorded) may.
    setMoneroUsedBefore(isMoneroChainTarget(chainId) && moneroPhraseUsedBefore(activeWallet));
    setMoneroFirstUsed('');
    setMoneroDateError(null);
  }

  async function handleEnableSubmit(e: FormEvent) {
    e.preventDefault();
    if (!enableTarget || submitting) return;
    // The date is read only while "used before" is ticked; unticking hides the
    // field and brings back the plain release-floor / tip choice.
    let moneroRestoreHeight: number | undefined;
    if (isMoneroChainTarget(enableTarget) && moneroUsedBefore) {
      const parsed = restoreHeightFromDate(moneroFirstUsed);
      if (parsed.kind === 'error') {
        setMoneroDateError(parsed.error);
        return;
      }
      if (parsed.kind === 'ok') moneroRestoreHeight = parsed.height;
    }
    setSubmitting(true);
    setError(null);
    try {
      // A passwordless active wallet has nothing to re-enter — the spec is an
      // empty passphrase, not a UI asking for one that doesn't exist.
      const pw = activePasswordless ? '' : password;
      // The third argument exists only for the Monero target: every other
      // chain keeps the two-argument call it always made.
      // `moneroRestoreHeight` rides along only when a date was given, so an
      // empty date is byte-for-byte the call this made before the field.
      const moneroOpts: { moneroUsedBefore: boolean; moneroRestoreHeight?: number } =
        moneroRestoreHeight !== undefined ? { moneroUsedBefore, moneroRestoreHeight } : { moneroUsedBefore };
      const result = isMoneroChainTarget(enableTarget)
        ? await enableChain(enableTarget, pw, moneroOpts)
        : await enableChain(enableTarget, pw);
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

  const targetDesc = enableTarget ? describeChain(enableTarget, evmChains, moneroChain) : null;
  const targetDisplayName = targetDesc?.displayName ?? enableTarget ?? '';
  const enableTargetIsEvm = enableTarget !== null && isEvmChainTarget(enableTarget);
  const enableTargetIsMonero = enableTarget !== null && isMoneroChainTarget(enableTarget);
  const enableTargetIsZcash = enableTarget !== null && isZcashChainTarget(enableTarget);
  const enableTargetIsTao = enableTarget !== null && isTaoChainTarget(enableTarget);
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
  // Monero keys are derived by a different scheme entirely (coin type 128,
  // then Monero's own key math, the Monero engine design notes §2): nothing in
  // a Monero address relates to a UTXO one, so it is not "linkable" either.
  // Zcash (coin type 133, its own two-byte prefix) and Bittensor (sr25519 from
  // the phrase's entropy) share no key with any UTXO chain here either.
  const bothUtxo =
    !isEvmChainTarget(currentChainId) &&
    !isEngineChainTarget(currentChainId) &&
    !enableTargetIsEvm &&
    !enableTargetIsMonero &&
    !enableTargetIsZcash &&
    !enableTargetIsTao;
  const linkableAddresses =
    enableTarget !== null && bothUtxo && (activeIsPk || chainsShareDerivation(currentChainId, enableTarget));

  // The list in two groups, each in the switcher's own order: "Your networks"
  // (the row in use plus every chain this seed group can switch to, i.e. the
  // rows without Add) on top, "Add a network" (the Add rows) below. The split
  // is the SAME hasWallet test that decides Add vs switch, so a row can never
  // sit under one heading while behaving like the other.
  const rows: ChainRow[] = visibleChains.map((chainId) => {
    const desc = describeChain(chainId, evmChains, moneroChain);
    const isCurrent = chainId === currentChainId;
    return { chainId, desc, isCurrent, hasWallet: isCurrent || hasWalletFor(chainId) };
  });
  // Case-insensitive match on the name, the ticker and the site as the row
  // shows it (no scheme, no www.).
  const needle = query.trim().toLowerCase();
  const matchesQuery = ({ chainId, desc }: ChainRow): boolean => {
    if (!needle) return true;
    const hay = [desc?.displayName ?? chainId, desc?.ticker ?? '', homepageHost(desc?.homepage)];
    return hay.some((s) => s.toLowerCase().includes(needle));
  };
  const shownRows = rows.filter(matchesQuery);
  // Favourites sit on top in the user's own order and ONLY there: a starred
  // row keeps its switch or Add behaviour but is not repeated under Your
  // networks or Add a network. An id with no visible row (removed from this
  // build, hidden in Settings, filtered out by the search) is skipped.
  const favRows = favouriteChains
    .map((id) => shownRows.find((r) => r.chainId === id))
    .filter((r): r is ChainRow => r !== undefined);
  const favIds: string[] = favRows.map((r) => r.chainId);
  const isFavourite = (chainId: SwitcherChainId): boolean => favouriteChains.includes(chainId);
  const mineRows = shownRows.filter((r) => r.hasWallet && !isFavourite(r.chainId));
  const addRows = shownRows.filter((r) => !r.hasWallet && !isFavourite(r.chainId));
  const searchAutofocus = prefersSearchAutofocus();

  function toggleFavourite(chainId: SwitcherChainId) {
    void updateSettings({ favouriteChains: toggleFavouriteChain(favouriteChains, chainId) });
  }

  function moveFavourite(chainId: SwitcherChainId, dir: -1 | 1) {
    void updateSettings({ favouriteChains: moveFavouriteChain(favouriteChains, chainId, dir, favIds) });
  }

  // The row is a focusable div, not a <button>: it holds its own star (and,
  // for a favourite, up/down) buttons, and a button inside a button is invalid
  // HTML. Enter and Space on the row itself act like the click; keys aimed at
  // an inner button are left to that button.
  function handleRowKeyDown(e: ReactKeyboardEvent<HTMLDivElement>, chainId: SwitcherChainId) {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleRowClick(chainId);
    }
  }

  /** A small icon button inside a row. stopPropagation keeps the click from
   *  also selecting, switching or enabling the row underneath. */
  function rowIconButton(props: {
    testId: string;
    label: string;
    pressed?: boolean;
    disabled?: boolean;
    onPress: () => void;
    children: ReactNode;
  }) {
    return (
      <button
        type="button"
        data-testid={props.testId}
        aria-label={props.label}
        title={props.label}
        aria-pressed={props.pressed}
        disabled={props.disabled}
        onClick={(e) => {
          e.stopPropagation();
          if (!props.disabled) props.onPress();
        }}
        onKeyDown={(e) => e.stopPropagation()}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 22,
          height: 22,
          // `.menu-pop button` gives every menu ROW 9px 11px of padding,
          // which would leave a 22px icon button no room for its icon.
          padding: 0,
          borderRadius: 6,
          flexShrink: 0,
          color: 'var(--text-faint)',
          opacity: props.disabled ? 0.3 : 1,
          cursor: props.disabled ? 'default' : 'pointer',
        }}
      >
        {props.children}
      </button>
    );
  }

  function renderRow({ chainId, desc, isCurrent, hasWallet }: ChainRow, fav?: { index: number; count: number }) {
    const name = desc?.displayName ?? chainId;
    const starred = isFavourite(chainId);
    return (
      <div
        key={chainId}
        className="opt-row"
        role="option"
        tabIndex={0}
        aria-selected={isCurrent}
        aria-current={isCurrent ? 'true' : undefined}
        data-testid={`live-chain-option-${chainId}`}
        onClick={() => handleRowClick(chainId)}
        onKeyDown={(e) => handleRowKeyDown(e, chainId)}
        style={{ cursor: 'pointer' }}
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
              {homepageHost(desc.homepage)}
            </span>
          )}
        </span>
        {/* Reordering, favourites only: one place up or down among the
            favourites on screen. Disabled (not hidden) at the ends so every
            favourite row keeps the same shape. */}
        {fav && (
          <span style={{ display: 'inline-flex', flexShrink: 0, marginRight: -6 }}>
            {rowIconButton({
              testId: `live-chain-fav-up-${chainId}`,
              label: `Move ${name} up`,
              disabled: fav.index === 0,
              onPress: () => moveFavourite(chainId, -1),
              children: <ChevronUp size={13} />,
            })}
            {rowIconButton({
              testId: `live-chain-fav-down-${chainId}`,
              label: `Move ${name} down`,
              disabled: fav.index === fav.count - 1,
              onPress: () => moveFavourite(chainId, 1),
              children: <ChevronDown size={13} />,
            })}
          </span>
        )}
        {/* The star: outline when off, filled gold (--warning, which has a
            darker value in the light theme) when on. */}
        {rowIconButton({
          testId: `live-chain-fav-${chainId}`,
          label: starred ? `Remove ${name} from favourites` : `Add ${name} to favourites`,
          pressed: starred,
          onPress: () => toggleFavourite(chainId),
          children: (
            <Star
              size={14}
              style={starred ? { color: 'var(--warning)' } : undefined}
              fill={starred ? 'currentColor' : 'none'}
            />
          ),
        })}
        {!hasWallet && (
          <span className="chip neutral" style={{ fontSize: 8.5, padding: '1px 6px', flexShrink: 0 }}>
            Add
          </span>
        )}
        {isCurrent && <Check size={15} className="opt-check" />}
      </div>
    );
  }

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
        onClick={() => {
          setOpen((v) => !v);
          setQuery('');
        }}
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
                {/* Sticky, so the box stays in reach while the rows scroll
                    under it. top:-6 cancels .menu-pop's own 6px padding. */}
                <div
                  style={{
                    position: 'sticky',
                    top: -6,
                    zIndex: 1,
                    background: 'var(--bg-elev)',
                    padding: '2px 4px 6px',
                  }}
                >
                  <input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search name, ticker or site"
                    aria-label="Search networks"
                    data-testid="live-chain-search"
                    autoComplete="off"
                    spellCheck={false}
                    autoFocus={searchAutofocus}
                    style={{
                      width: '100%',
                      fontSize: 12,
                      padding: '7px 9px',
                      borderRadius: 8,
                      border: '1px solid var(--border-strong)',
                      background: 'var(--card)',
                      outline: 'none',
                    }}
                  />
                </div>
                {favRows.length > 0 && (
                  <div
                    className="section-label"
                    role="presentation"
                    data-testid="live-chain-group-fav"
                    style={{ padding: '2px 9px 2px', margin: '4px 4px 3px' }}
                  >
                    Favourites
                  </div>
                )}
                {favRows.map((row, index) => renderRow(row, { index, count: favRows.length }))}
                {mineRows.length > 0 && (
                  <div
                    className="section-label"
                    role="presentation"
                    data-testid="live-chain-group-mine"
                    style={{ padding: '2px 9px 2px', margin: favRows.length > 0 ? '10px 4px 3px' : '4px 4px 3px' }}
                  >
                    Your networks
                  </div>
                )}
                {mineRows.map((row) => renderRow(row))}
                {addRows.length > 0 && (
                  <div
                    className="section-label"
                    role="presentation"
                    data-testid="live-chain-group-add"
                    style={{ padding: '2px 9px 2px', margin: mineRows.length > 0 || favRows.length > 0 ? '10px 4px 3px' : '4px 4px 3px' }}
                  >
                    Add a network
                  </div>
                )}
                {addRows.map((row) => renderRow(row))}
                {favRows.length === 0 && mineRows.length === 0 && addRows.length === 0 && (
                  <div
                    className="text-faint"
                    data-testid="live-chain-search-empty"
                    style={{ fontSize: 11.5, padding: '10px 9px 12px', textAlign: 'center' }}
                  >
                    No network matches
                  </div>
                )}
              </div>
            ) : (
              /* noValidate: the date field's min/max only steer the picker.
                 The browser's own range check would block the submit with a
                 native bubble, where the rules here clamp a pre-genesis date
                 and explain a future one (restoreHeightFromDate). */
              <form
                onSubmit={handleEnableSubmit}
                noValidate
                data-testid="live-chain-enable-panel"
                style={{ padding: '8px 9px 9px' }}
              >
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
                ) : enableTargetIsMonero ? (
                  /* The disclosure the design asks for (the Monero engine design
                     notes §10): which wallet these keys are, and that the scan
                     only runs while a wallet window is open (§6.3). */
                  <div
                    className="banner info"
                    data-testid="live-chain-monero-derivation-note"
                    style={{ marginBottom: 10, alignItems: 'flex-start' }}
                  >
                    <Info size={14} />
                    <span>
                      Derived from this wallet&apos;s phrase the same way Cake Wallet&apos;s BIP39 option does, so Cake
                      shows the same Monero wallet for it. A Ledger or Trezor restored from the phrase shows a
                      different one. Monero scans the chain itself, and only while this wallet is open.
                    </span>
                  </div>
                ) : enableTargetIsZcash ? (
                  /* The disclosure the Zcash design asks for (§1, §10): which
                     address this is, and that transparent Zcash is public. */
                  <div
                    className="banner info"
                    data-testid="live-chain-zcash-derivation-note"
                    style={{ marginBottom: 10, alignItems: 'flex-start' }}
                  >
                    <Info size={14} />
                    <span>
                      Derived from this wallet&apos;s phrase at the standard Zcash path, the same transparent address
                      Zashi, YWallet, Trust Wallet and Ledger show for it. Payments to it are public, like Bitcoin.
                      Shielded Zcash is not supported.
                    </span>
                  </div>
                ) : enableTargetIsTao ? (
                  /* The disclosure the Bittensor design asks for (§10): the
                     account is the phrase's root, as btcli derives it. */
                  <div
                    className="banner info"
                    data-testid="live-chain-tao-derivation-note"
                    style={{ marginBottom: 10, alignItems: 'flex-start' }}
                  >
                    <Info size={14} />
                    <span>
                      Derived from this wallet&apos;s phrase the way btcli and polkadot.js derive a coldkey, so they show
                      the same Bittensor account for it.
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
                {enableTargetIsMonero && (
                  /* Where the scan starts. A sibling started at today's tip is
                     right only for a phrase that never touched Monero; a phrase
                     restored from another device, or already used in Cake,
                     would otherwise sync to "0 XMR" with its funds below the
                     scanned range (the Monero engine design notes 6.6). The
                     scan from the release floor grows with time, so it is a
                     choice, not the default for a fresh phrase. */
                  <label
                    style={{
                      display: 'flex',
                      gap: 10,
                      alignItems: 'flex-start',
                      cursor: 'pointer',
                      background: 'var(--bg-elev)',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--r-md)',
                      padding: '10px 12px',
                      margin: '0 0 10px',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={moneroUsedBefore}
                      onChange={(e) => setMoneroUsedBefore(e.target.checked)}
                      data-testid="live-chain-monero-used-before"
                      style={{ marginTop: 2, flexShrink: 0 }}
                    />
                    <span style={{ fontSize: 12, lineHeight: 1.5 }}>
                      <strong>This phrase has been used with Monero before</strong>
                      <span className="text-dim" style={{ display: 'block', fontWeight: 400, marginTop: 1 }}>
                        In Satori GO on another device, or in Cake Wallet. The scan then starts from Monero&apos;s first
                        Satori GO release so older payments are found, which takes longer. Leave it off for a phrase
                        that never held Monero: the scan starts from today.
                      </span>
                    </span>
                  </label>
                )}
                {enableTargetIsMonero && moneroUsedBefore && (
                  <TextField
                    label="First used around (optional)"
                    type="date"
                    min={MONERO_GENESIS_DATE}
                    max={localIsoDate()}
                    value={moneroFirstUsed}
                    onChange={(e) => {
                      setMoneroFirstUsed(e.target.value);
                      setMoneroDateError(null);
                    }}
                    testId="live-chain-monero-first-used"
                    hint="Scanning starts near this date, so an older date takes longer."
                    error={moneroDateError ?? undefined}
                  />
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
