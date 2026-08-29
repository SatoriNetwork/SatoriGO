import { useState, useCallback, useEffect, useRef } from 'react';
import { Check, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '../../components/Button';
import { PasswordField } from '../../components/TextField';
import { BrandLogo, TokenIcon } from '../../components/BrandLogo';
import { ConstellationField } from '../../components/ConstellationField';
import { AccountAvatar } from '../../components/AccountAvatar';
import { useLiveStore, chainDisplayName, nativeTickerFor } from '../../store/liveStore';
import { groupWallets, flattenGroups, shortAccountAddress, memberLabel } from './walletGroups';

type LiveLockProps = Record<string, never>;

/** Which of the two lock-screen views is showing. The screen used to stack a
 *  truncated wallet strip ON TOP of the password field: with EVM accounts a
 *  seed can contribute 20+ entries, and a 3-row scroll window above the
 *  password looked broken (user report). Now the password view names ONE
 *  wallet and the list is a view of its own, with the whole panel height to
 *  fill. */
type LockView = 'password' | 'wallets';

export function LiveLock(_props: LiveLockProps) {
  const unlock = useLiveStore((s) => s.unlock);
  const storeError = useLiveStore((s) => s.error);
  const wallets = useLiveStore((s) => s.wallets);
  const activeWalletId = useLiveStore((s) => s.activeWalletId);
  const switchWallet = useLiveStore((s) => s.switchWallet);
  const loadWallets = useLiveStore((s) => s.loadWallets);
  const addWalletStart = useLiveStore((s) => s.addWalletStart);
  // Set once the user has opted into one password for the whole wallet. Drives
  // the TRANSITIONAL prompt below and nothing else; false on every install that
  // never opted in, and this screen is then exactly what it always was.
  const appPasswordSet = useLiveStore((s) => s.appPasswordSet);
  // THIS SCREEN CAN BE SHOWING WHILE THE APP IS UNLOCKED. After the app password
  // is accepted, a wallet still on its own password lands here with the master
  // key in memory: the heading says the wallet is locked, and the app is not. So
  // the screen has to offer the act it is named after. When the app is LOCKED
  // and this screen was reached from the app lock screen instead, the same slot
  // is the way back to it.
  const appUnlocked = useLiveStore((s) => s.appUnlocked);
  const lockApp = useLiveStore((s) => s.lock);
  const showAppLock = useLiveStore((s) => s.showAppLock);
  // The arrival class is dropped the moment its animation finishes: keeping it
  // would keep the mark composited as a GPU texture rasterised at CSS size,
  // which Windows display scaling then stretches into standing pixelation
  // (owner, lock screen, 2026-08-25). Plain DOM after arrival = native-DPI crisp.
  const [markArrived, setMarkArrived] = useState(false);
  const markProps = {
    className: markArrived ? 'welcome-mark' : 'welcome-mark welcome-mark-arrive',
    // Any animationend from this element will do: the arrival (780ms) ends
    // before the glow swell (1100ms, and that one lives on ::before, which the
    // class removal does not touch), and jsdom's event carries no animationName.
    onAnimationEnd: () => setMarkArrived(true),
  };
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [shake, setShake] = useState(false);
  const [localError, setLocalError] = useState('');
  const [view, setView] = useState<LockView>('password');
  // The user's answer to the transitional prompt. Declining is a first-class
  // outcome (the app-password design notes §4 rule 5, §6): the wallet stays on its
  // own password, stays listed, and is asked again next time.
  const [keepOwnPassword, setKeepOwnPassword] = useState(false);

  // The wallet list is normally loaded by init(), but make sure it's there when
  // the lock screen is reached through a path that skipped it.
  useEffect(() => {
    if (wallets.length === 0) void loadWallets();
  }, [wallets.length, loadWallets]);

  // The list can be long enough to scroll, and the selected wallet can start out
  // below the fold: opening the picker would then show a list with nothing
  // ticked. Bring it into view. 'nearest' so a list that already shows it does
  // not jump.
  const selectedRowRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (view !== 'wallets') return;
    // Optional call: jsdom (unit tests) has no scrollIntoView.
    selectedRowRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [view, activeWalletId, wallets.length]);

  const backToPassword = useCallback(() => setView('password'), []);

  // Escape leaves the picker, like every other overlay in the app.
  useEffect(() => {
    if (view !== 'wallets') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') backToPassword();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view, backToPassword]);

  const activeWallet = wallets.find((w) => w.id === activeWalletId) ?? null;
  // Same grouped shape as the Home switcher (the EVM accounts design notes):
  // accounts of one seed sit under one heading. DISPLAY ONLY here — adding or
  // scanning accounts needs the seed unlocked, which is exactly what this screen
  // does not have yet. `rowIndexById` is the flattened index the
  // `live-lock-wallet-${i}` testids carry (headings take none).
  const walletNodes = groupWallets(wallets);
  const flatRows = flattenGroups(walletNodes);
  const rowIndexById = new Map<string, number>(flatRows.map((w, i) => [w.id, i] as const));
  // Bug fix: switchWallet() only auto-unlocks a passwordless target when it
  // ACTUALLY switches (it no-ops if the id is already active — see liveStore's
  // `if (id === get().activeWalletId) return;`). That left no path to unlock a
  // passwordless wallet that is already the active one when the lock screen is
  // reached directly (e.g. re-opening the popup after auto-lock) — clicking it
  // looked selected already, so nothing happened. Previously the only way in
  // was to switch to a different wallet and back, which DOES cross the
  // passwordless auto-unlock branch. Fixed below by unlocking explicitly with
  // unlock('') whenever the selected wallet is passwordless, regardless of
  // whether picking it also triggered a switch.
  const isActivePasswordless = !!activeWallet?.passwordless;
  // Seed groups are COLLAPSED by default on this screen: unlocking any account
  // of a seed unlocks all of them (one secret, one password; switching between
  // them afterwards asks for nothing), so the list shows one row per seed,
  // naming the account that row unlocks, and a chevron for the rare case where
  // the user wants a specific other account before unlocking.
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  const toggleGroup = (key: string) =>
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // Picking a wallet re-targets the lock screen: the store switches the active
  // wallet (it stays locked; a passwordless target auto-unlocks inside
  // switchWallet) and the password field applies to it. Either way the picker
  // closes — the user asked a question ("which wallet?") and got the answer.
  const pickWallet = (id: string) => {
    setLocalError('');
    setView('password');
    if (id === activeWalletId) {
      // Already the selected/active wallet — switchWallet() would no-op, so if
      // it's passwordless, unlock it directly instead of relying on a switch.
      const w = wallets.find((x) => x.id === id);
      // With an app password set, a passwordless wallet must NOT be opened
      // silently: opening it is what moves it to the app key, and §6 says the
      // user has to be told and allowed to decline. The prompt below does that.
      if (w?.passwordless && !appPasswordSet) void unlock('');
      return;
    }
    setPassword('');
    void switchWallet(id);
  };

  const handleOpenPasswordless = async (migrate: boolean) => {
    setLocalError('');
    setLoading(true);
    const ok = await unlock('', { migrate });
    setLoading(false);
    if (!ok) {
      setLocalError('Could not open this wallet. Try again.');
      triggerShake();
    }
  };

  const triggerShake = useCallback(() => {
    setShake(true);
    setTimeout(() => setShake(false), 500);
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError('');
    if (!password) {
      setLocalError('Enter your password.');
      triggerShake();
      return;
    }
    setLoading(true);
    const ok = await unlock(password, { migrate: !keepOwnPassword });
    setLoading(false);
    if (!ok) {
      setLocalError('Incorrect password. Try again.');
      setPassword('');
      triggerShake();
    }
  };

  const displayError = localError || storeError;

  /** Chain mark + ticker for one entry. Each row's OWN chain drives it, so a
   *  BTGS/LTC/any future wallet is identified here too — never a hardcoded
   *  chain-id test, which silently skipped every chain added after Ravencoin.
   *  An EVM entry's stored `network` is the 'evm' sentinel, never a real chain
   *  id, so it never reaches nativeTickerFor() (that would answer for the
   *  ACTIVE EVM chain). */
  const tickerOf = (w: { family?: string; network: string }) =>
    w.family === 'evm' ? 'EVM' : nativeTickerFor(w.network);

  /** WHICH PASSWORD OPENS THIS WALLET, once there is more than one answer.
   *  Absent until an app password exists, so an install that never opted in
   *  shows exactly the chips it always showed. It reuses this list's own
   *  vocabulary (a short `chip neutral lock-chip`) rather than inventing a
   *  badge: after a migration some wallets open with the app password and some
   *  still ask for their own, and a user must be able to READ that off the list
   *  instead of finding out one lock screen at a time. */
  const pwChip = (w: { appProtected?: boolean }, testId?: string) =>
    appPasswordSet ? (
      <span className="chip neutral lock-chip" data-testid={testId}>
        {w.appProtected ? 'App pw' : 'Own pw'}
      </span>
    ) : null;

  // ---- password view: the ONE wallet this password unlocks -------------------
  const selectedNode = walletNodes.find((n) =>
    n.kind === 'single' ? n.wallet.id === activeWalletId : n.members.some((m) => m.id === activeWalletId),
  );
  // An account of a seed that has several accounts is named by BOTH halves: the
  // seed ("My EVM") and which account of it ("Account 2"), because neither
  // identifies it alone. They are two spans so that at 320px the SEED half
  // ellipsises and the account number always survives — one span would cut the
  // half that distinguishes this wallet from its siblings.
  const selectedGroup =
    selectedNode?.kind === 'group' && selectedNode.members.length > 1 ? selectedNode : null;
  const selectedGroupTitle = selectedGroup ? selectedGroup.title : activeWallet?.name ?? '';
  const selectedAccountLabel =
    selectedGroup && activeWallet
      ? memberLabel(activeWallet, selectedGroup.title, selectedGroup.members.length)
      : '';
  const selectedTicker = activeWallet ? tickerOf(activeWallet) : '';
  // One wallet = nothing to change to. The card still shows: it names what the
  // password below opens.
  const canChangeWallet = flatRows.length > 1;

  const selectedCard = activeWallet && (
    <div className="lock-selected" data-testid="live-lock-selected">
      {/* The card names the ONE wallet this password opens, so it leads with
          that account's own identicon (28px here — this is the screen's
          subject, not a list row) and keeps the chain/brand mark beside it,
          which says which chain or which kind of wallet it is. */}
      <span className="lock-selected-mark">
        <AccountAvatar address={activeWallet.address} seed={activeWallet.id} size={28} />
        {activeWallet.kind === 'pk' ? (
          <BrandLogo slot="satori" size={20} alt="Satori" />
        ) : (
          <TokenIcon assetId={selectedTicker} size={20} />
        )}
      </span>
      <span className="lock-selected-main">
        <span className="lock-selected-name">
          <span className="lock-selected-name-seed">{selectedGroupTitle}</span>
          {selectedAccountLabel && (
            <span className="lock-selected-name-account">{` · ${selectedAccountLabel}`}</span>
          )}
        </span>
        {activeWallet.address && (
          <span className="mono lock-selected-addr">{shortAccountAddress(activeWallet.address)}</span>
        )}
        <span className="lock-selected-chips">
          <span className="chip neutral">{activeWallet.kind === 'pk' ? 'Satori' : 'Seed'}</span>
          <span className="chip neutral" data-testid="live-lock-selected-chain">
            {selectedTicker}
          </span>
          {activeWallet.passwordless && <span className="chip warning">No pw</span>}
          {pwChip(activeWallet, 'live-lock-selected-pw')}
          {/* §6's convenience half, made visible. A wallet that migrated from
              passwordless keeps "do not ask when sending" but loses the
              `passwordless` flag, so it used to show NO badge at all while
              still spending with nothing typed. */}
          {!activeWallet.passwordless && activeWallet.noSendPassword && (
            <span className="chip warning" data-testid="live-lock-selected-no-send-pw">
              Sends without pw
            </span>
          )}
        </span>
      </span>
      {canChangeWallet && (
        <button
          type="button"
          className="lock-change"
          data-testid="live-lock-change"
          onClick={() => setView('wallets')}
        >
          Change
          <ChevronRight size={14} />
        </button>
      )}
    </div>
  );

  // ---- the TRANSITIONAL prompt (the app-password design notes §5, §6) ----------
  // Shown only while an app password exists, THIS SESSION HAS ITS KEY, and this
  // wallet is still on its own password. It says what unlocking will do, and
  // offers the way out: keep the wallet's own password and be asked again next
  // time.
  //
  // `appUnlocked` is part of the condition because the promise is only true when
  // it holds: migration wraps the seed under the master key this session holds,
  // so with the app LOCKED (the escape hatch from the app lock screen, which
  // reaches a still-v1 wallet without its password) nothing will move, and a
  // prompt saying it will is the same lie §4's member check used to tell.
  const isTransitional =
    appPasswordSet && appUnlocked && !!activeWallet && !activeWallet.appProtected;

  const migrationNote = isTransitional && (
    <div className="lock-migrate" data-testid="live-lock-migrate-note">
      <p className="lock-migrate-text">
        {isActivePasswordless
          ? 'This wallet has no password of its own. Open it once and your app password will protect it from then on.'
          : "This wallet still has its own password. Enter it once and this wallet moves to your app password. After that, your app password opens it."}
      </p>
      {/* §6 says the behaviour change must be EXPLICIT. Protecting the vault is
          only half of what happens to a passwordless wallet: the other half is
          that it goes on sending with nothing typed, which is the half that
          spends money. Said here, before the click, not discovered later. */}
      {isActivePasswordless && (
        <p className="lock-migrate-text" data-testid="live-lock-migrate-send-note">
          Sending from it will still not ask for a password. You can change that
          in Settings, under Security.
        </p>
      )}
      {!isActivePasswordless && (
        <label className="lock-migrate-keep">
          <input
            type="checkbox"
            checked={keepOwnPassword}
            onChange={(e) => setKeepOwnPassword(e.target.checked)}
            data-testid="live-lock-keep-own-password"
          />
          <span>Keep this wallet&apos;s own password for now</span>
        </label>
      )}
    </div>
  );

  // ---- list view: every wallet on this device, grouped by seed ---------------
  const walletList = (
    <div className="stack lock-wallets" data-testid="live-lock-wallets">
      {walletNodes.map((node, ni) => {
        if (node.kind === 'single') {
          const w = node.wallet;
          const i = rowIndexById.get(w.id) ?? 0;
          const selected = w.id === activeWalletId;
          const walletTicker = tickerOf(w);
          const isOtherChain = w.family === 'evm' || walletTicker !== 'EVR';
          return (
            <button
              key={w.id}
              type="button"
              ref={selected ? selectedRowRef : undefined}
              className="lock-wallet"
              aria-pressed={selected}
              onClick={() => pickWallet(w.id)}
              data-testid={`live-lock-wallet-${i}`}
            >
              {/* Identicon on every row (the account's own mark), then the
                  brand/chain mark that says what KIND of wallet it is. */}
              <AccountAvatar address={w.address} seed={w.id} size={16} />
              {w.kind === 'pk' && <BrandLogo slot="satori" size={16} alt="Satori" />}
              {isOtherChain && <TokenIcon assetId={walletTicker} size={16} />}
              <span className="lock-wallet-name">{w.name}</span>
              <span className="chip neutral lock-chip">{w.kind === 'pk' ? 'Satori' : 'Seed'}</span>
              {isOtherChain && (
                <span className="chip neutral lock-chip" data-testid={`live-lock-wallet-chain-${i}`}>
                  {walletTicker}
                </span>
              )}
              {w.passwordless && <span className="chip warning lock-chip">No pw</span>}
              {!w.passwordless && w.noSendPassword && (
                <span className="chip warning lock-chip">Sends without pw</span>
              )}
              {pwChip(w, `live-lock-wallet-pw-${i}`)}
              {selected && <Check size={14} className="lock-wallet-tick" />}
            </button>
          );
        }
        // One seed = ONE row. Picking it unlocks the account the row names
        // (the active one when it belongs to this seed, else the first), and
        // every other account of the seed is reachable from the Home switcher
        // right after. The chevron expands the accounts for a specific pick.
        const groupSelected = node.members.some((m) => m.id === activeWalletId);
        const target =
          node.members.find((m) => m.id === activeWalletId) ?? node.members[0];
        const expanded = expandedGroups.has(node.key);
        const many = node.members.length > 1;
        return (
          <div key={`group-${node.key}`} className="lock-group">
            <div className="lock-group-row">
              <button
                type="button"
                ref={groupSelected && !expanded ? selectedRowRef : undefined}
                className="lock-wallet"
                aria-pressed={groupSelected}
                onClick={() => pickWallet(target.id)}
                data-testid={`live-lock-group-${ni}`}
              >
                {/* One row per seed: the EVM mark for the family, plus the
                    identicon of the account this row actually unlocks. */}
                <TokenIcon assetId="EVM" size={16} />
                <AccountAvatar address={target.address} seed={target.id} size={16} />
                <span className="lock-wallet-main">
                  <span className="lock-wallet-name">{node.title}</span>
                  <span className="mono lock-wallet-addr" data-testid={`live-lock-group-sub-${ni}`}>
                    {many
                      ? `${node.members.length} accounts · unlocks ${memberLabel(target, node.title, node.members.length)}`
                      : target.address
                        ? shortAccountAddress(target.address)
                        : '1 account'}
                  </span>
                </span>
                <span className="chip neutral lock-chip">Seed</span>
                <span className="chip neutral lock-chip">EVM</span>
                {target.passwordless && <span className="chip warning lock-chip">No pw</span>}
                {!target.passwordless && target.noSendPassword && (
                  <span className="chip warning lock-chip">Sends without pw</span>
                )}
                {pwChip(target, `live-lock-group-pw-${ni}`)}
                {groupSelected && <Check size={14} className="lock-wallet-tick" />}
              </button>
              {many && (
                <button
                  type="button"
                  className="icon-btn lock-group-toggle"
                  aria-label={expanded ? `Hide the accounts of ${node.title}` : `Show the accounts of ${node.title}`}
                  aria-expanded={expanded}
                  onClick={() => toggleGroup(node.key)}
                  data-testid={`live-lock-group-toggle-${ni}`}
                >
                  <ChevronDown size={16} style={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }} />
                </button>
              )}
            </div>
            {expanded && node.members.map((w) => {
              const i = rowIndexById.get(w.id) ?? 0;
              const selected = w.id === activeWalletId;
              return (
                <button
                  key={w.id}
                  type="button"
                  ref={selected ? selectedRowRef : undefined}
                  className="lock-wallet lock-wallet-member"
                  aria-pressed={selected}
                  onClick={() => pickWallet(w.id)}
                  data-testid={`live-lock-wallet-${i}`}
                >
                  <AccountAvatar address={w.address} seed={w.id} size={16} />
                  <span className="lock-wallet-main">
                    <span className="lock-wallet-name">
                      {memberLabel(w, node.title, node.members.length)}
                    </span>
                    {w.address && (
                      <span className="mono lock-wallet-addr">{shortAccountAddress(w.address)}</span>
                    )}
                  </span>
                  <span className="chip neutral lock-chip" data-testid={`live-lock-wallet-chain-${i}`}>
                    EVM
                  </span>
                  {w.passwordless && <span className="chip warning lock-chip">No pw</span>}
                  {!w.passwordless && w.noSendPassword && (
                    <span className="chip warning lock-chip">Sends without pw</span>
                  )}
                  {pwChip(w, `live-lock-wallet-pw-${i}`)}
                  {selected && <Check size={14} className="lock-wallet-tick" />}
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );

  if (view === 'wallets') {
    return (
      <div className="app-frame screen-enter" data-testid="live-lock">
        <ConstellationField variant="calm" />
        <div className="lock-screen lock-screen-list">
          {/* The brand block shrinks to a title row here: the list is what this
              view is for, and it gets the height. */}
          <div className="lock-list-head">
            <button
              type="button"
              className="icon-btn"
              aria-label="Back"
              data-testid="live-lock-wallets-back"
              onClick={backToPassword}
            >
              <ChevronLeft size={20} />
            </button>
            <h2>Choose wallet</h2>
            <span className="lock-list-head-spacer" />
          </div>
          <p className="lock-list-hint">Pick the wallet to unlock on this device.</p>
          {walletList}
        </div>
      </div>
    );
  }

  return (
    <div className="app-frame screen-enter" data-testid="live-lock">
      {/* The same network as the first-run screen, turned down (fewer dots,
          slower, dimmer), so unlocking feels like re-entering the same world.
          No entrance choreography here: this screen stays calm. */}
      <ConstellationField variant="calm" />
      <div className="lock-screen">
        {/* Satori GO branding — the lock screen previously had no wordmark at
            all, just a bare red lock circle (user report: "na ekranie
            logowania nic nie ma" — nothing on the login screen). Matches the
            header brand block on LiveHome (BrandLogo "satori" slot + "Satori
            GO" wordmark) plus the same tagline used on LiveHome's footer. */}
        <div className="lock-brand">
          {/* The same breathing glow the welcome mark carries: the owner asked
              for the welcome treatment here too (2026-08-25). */}
          <span {...markProps}>
            <BrandLogo slot="satori" size={88} alt="Satori Network" />
          </span>
          <span className="brand-title">Satori GO</span>
          <span className="text-faint">Built for the Satori Network</span>
        </div>

        {/* No lock badge above this heading: it restated what the heading says
            in words, and the ~62px it cost came straight out of the wallet
            list, which is the one thing on this screen that needs the height. */}
        <h2>Live Wallet Locked</h2>
        {/* The card below names the wallet being unlocked, so the subtitle only
            earns its place when there is no wallet to name yet. */}
        {wallets.length === 0 && (
          <p className="lock-account">
            {activeWallet?.name ?? `Real ${chainDisplayName()} Network`}
          </p>
        )}

        {selectedCard}

        {/* Passwordless wallet: there is no password to ask for. Skip the form
            entirely and offer a single button that unlocks with the empty
            passphrase — covers both "just picked from the list" and "already
            the active wallet when this screen was reached". */}
        {isActivePasswordless ? (
          <div className={`lock-form${shake ? ' shake' : ''}`}>
            {migrationNote}
            {displayError && (
              <p
                data-testid="live-unlock-error"
                style={{ fontSize: 11.5, color: 'var(--danger)', marginBottom: 10 }}
              >
                {displayError}
              </p>
            )}
            <Button
              type="button"
              block
              loading={loading}
              data-testid="live-lock-open-passwordless"
              onClick={() => void handleOpenPasswordless(isTransitional)}
            >
              {isTransitional ? 'Open and protect it' : 'Open wallet'}
            </Button>
            {/* Declining must stay one click away: §6 requires it, and a wallet
                that declines is simply still a v1 wallet. */}
            {isTransitional && (
              <Button
                type="button"
                block
                variant="ghost"
                loading={loading}
                data-testid="live-lock-open-keep-v1"
                onClick={() => void handleOpenPasswordless(false)}
                style={{ marginTop: 8 }}
              >
                Open without changing it
              </Button>
            )}
          </div>
        ) : (
          <form onSubmit={handleSubmit} className={`lock-form${shake ? ' shake' : ''}`}>
            {migrationNote}
            <PasswordField
              label="Password"
              showLabel="Show password"
              hideLabel="Hide password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter your password"
              autoFocus
              testId="live-unlock"
              error={displayError ?? undefined}
            />
            <Button
              type="submit"
              block
              loading={loading}
              style={{ marginTop: 16 }}
            >
              Unlock
            </Button>
          </form>
        )}

        {/* A REAL LOCK, on the screen that says "Locked".
            When the app password has already been accepted, the master key is in
            memory and only the WALLET is locked. There was no way to say so and
            no way to undo it: the header lock button lives on the wallet, which
            is not on screen. When the app is locked and this screen was reached
            from the app lock screen, the same slot goes back to it. */}
        {appPasswordSet && (
          <div className="lock-alt" data-testid="live-lock-app-state">
            {appUnlocked ? (
              <>
                <p className="text-faint" style={{ fontSize: 11, margin: '0 0 9px', lineHeight: 1.5 }}>
                  Your app password is still open in this window.
                </p>
                <Button
                  type="button"
                  variant="ghost"
                  block
                  data-testid="live-lock-lock-app"
                  onClick={() => lockApp()}
                >
                  Lock
                </Button>
              </>
            ) : (
              <Button
                type="button"
                variant="ghost"
                block
                data-testid="live-lock-back-to-app-lock"
                onClick={() => showAppLock()}
              >
                Use your app password
              </Button>
            )}
          </div>
        )}

        {/* Don't want to log in? Create or import a NEW wallet from here. */}
        <div className="lock-alt">
          <span className="lock-alt-sep">or</span>
          <div style={{ display: 'flex', gap: 9 }}>
            <Button
              type="button"
              variant="secondary"
              onClick={() => addWalletStart()}
              data-testid="live-lock-create"
              style={{ flex: 1 }}
            >
              Create new wallet
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => addWalletStart()}
              data-testid="live-lock-import"
              style={{ flex: 1 }}
            >
              Import wallet
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
