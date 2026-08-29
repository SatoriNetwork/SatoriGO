// Root of the wallet UI — renders the correct screen based on the store phase.
// Mounted directly by App.tsx once display settings + branding have loaded.

import { useEffect, useState } from 'react';
import { useLiveStore, computeDisplayedAssets, stakingSupported, evmStakingSupported, nativeTickerFor } from '../../store/liveStore';
import { LiveOnboarding } from './LiveOnboarding';
import { LiveLock } from './LiveLock';
import { LiveAppLock } from './LiveAppLock';
import { LiveForceAppPassword } from './LiveForceAppPassword';
import { LiveHome } from './LiveHome';
import { LiveReceive } from './LiveReceive';
import { LiveSend } from './LiveSend';
import { LiveSendEvm } from './LiveSendEvm';
import { LiveAssetDetail } from './LiveAssetDetail';
import { LiveSettings } from './LiveSettings';
import { LiveTxDetail } from './LiveTxDetail';
import { LiveAddressBook } from './LiveAddressBook';
import { LiveStaking } from './LiveStaking';
import { LiveStakeEvm } from './LiveStakeEvm';
import { NavProvider, type HomeTab, type NavSection } from './LiveNav';

// Discriminated subview. `receive`/`send` carry the asset they were opened from
// (when launched from an asset-detail screen) so Back returns to that detail
// instead of dead-ending; absent means they were opened from home.
type LiveSubView =
  | { name: 'home' }
  | { name: 'asset'; asset: string }
  | { name: 'receive'; asset?: string }
  | { name: 'send'; asset?: string }
  | { name: 'settings' }
  | { name: 'addressbook' }
  // `from` only decides where Back lands: the staking screen itself is one
  // screen on one route, reached from the asset detail and (on a chain with
  // native staking) from the Home action row.
  | { name: 'staking'; from?: 'home' }
  | { name: 'tx'; txid: string };

export function LiveApp() {
  const phase = useLiveStore((s) => s.phase);
  const syncing = useLiveStore((s) => s.syncing);
  const init = useLiveStore((s) => s.init);
  const refresh = useLiveStore((s) => s.refresh);
  const startAutoRefresh = useLiveStore((s) => s.startAutoRefresh);
  const stopAutoRefresh = useLiveStore((s) => s.stopAutoRefresh);
  const lock = useLiveStore((s) => s.lock);
  const autoLockMinutes = useLiveStore((s) => s.autoLockMinutes);
  const wallets = useLiveStore((s) => s.wallets);
  const activeWalletId = useLiveStore((s) => s.activeWalletId);
  // Subscribed so the asset-detail balance stays fresh across background refreshes.
  const assets = useLiveStore((s) => s.assets);
  const pinnedAssets = useLiveStore((s) => s.pinnedAssets);
  const hiddenAssets = useLiveStore((s) => s.hiddenAssets);
  const [subView, setSubView] = useState<LiveSubView>({ name: 'home' });
  // The home screen's inner tab lives HERE, not in LiveHome: the bottom nav is shown
  // on every screen now, so pressing "Activity" from Settings has to be able to send
  // you home AND select the tab.
  const [tab, setTab] = useState<HomeTab>('assets');

  // A passwordless wallet has no password to re-enter, so auto-locking it would
  // just auto-unlock again on the next boot — pointless. Skip the idle timer for
  // it. Derived to a boolean so the effect below only re-runs when it flips.
  //
  // ONCE AN APP PASSWORD EXISTS this stops being true even for a passwordless
  // wallet: locking then returns to the APP lock screen, which is a real gate
  // and does have something to re-enter. So the skip is conditioned on there
  // being no app password at all.
  const appPasswordSet = useLiveStore((s) => s.appPasswordSet);
  const activePasswordless =
    !appPasswordSet && (wallets.find((w) => w.id === activeWalletId)?.passwordless ?? false);

  // Initialize on mount.
  useEffect(() => {
    void init();
  }, [init]);

  // Auto-refresh while the wallet is ready: a quiet 20s interval, plus a kick on
  // tab focus / visibility-change→visible. Everything is torn down when we leave
  // the ready phase or unmount. A light debounce avoids focus/visibility storms.
  useEffect(() => {
    if (phase !== 'ready') return;
    startAutoRefresh();

    let lastKick = 0;
    const kick = () => {
      const now = Date.now();
      if (now - lastKick < 2000) return; // debounce bursty focus/visibility events
      lastKick = now;
      void refresh({ silent: true });
    };
    const onVisible = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') kick();
    };
    const onFocus = () => kick();

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisible);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', onFocus);
    }

    return () => {
      stopAutoRefresh();
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisible);
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', onFocus);
      }
    };
  }, [phase, refresh, startAutoRefresh, stopAutoRefresh]);

  // Auto-lock after inactivity: track user activity and lock() once
  // `autoLockMinutes` of idle time elapse. Skipped for a passwordless wallet
  // (nothing to re-enter) and when the timeout is 0 (never). Activity resets on
  // pointer/keyboard input and on regaining tab visibility.
  //
  // THE GATE IS "IS THERE A KEY IN MEMORY", NOT "IS A WALLET ON SCREEN". It used
  // to be `phase !== 'ready'`, which missed the state the app password creates:
  // after the app lock screen is passed, a wallet still on its own password
  // leaves the app UNLOCKED at phase 'locked'. The master key sat in page memory
  // behind a screen headed "Wallet Locked" with no timer running at all, so it
  // stayed there until the page was closed. `appUnlocked` is exactly "the master
  // key is in memory", so it arms the timer wherever that is true.
  const appUnlocked = useLiveStore((s) => s.appUnlocked);
  useEffect(() => {
    if (phase !== 'ready' && !appUnlocked) return;
    // A passwordless wallet has nothing to re-enter, but an unlocked APP does:
    // locking returns to the app lock screen, which is a real gate.
    if (activePasswordless && !appUnlocked) return;
    if (autoLockMinutes <= 0) return;
    if (typeof document === 'undefined') return; // non-DOM env guard (jsdom-safe)

    const idleMs = autoLockMinutes * 60_000;
    let lastActivity = Date.now();
    const touch = () => {
      lastActivity = Date.now();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') touch();
    };

    document.addEventListener('pointerdown', touch);
    document.addEventListener('keydown', touch);
    document.addEventListener('visibilitychange', onVisible);
    const interval = setInterval(() => {
      // Hold the auto-lock while the wallet runs its FIRST full sync: that sync is
      // watch-only, and locking mid-sync clears address/txs and discards in-flight
      // progress — confusing for a user who is just passively waiting for the
      // balance to appear. Read the CURRENT store state (not a captured value, to
      // avoid a new effect dependency) and refresh activity so the idle timer
      // resumes cleanly once the sync completes.
      if (useLiveStore.getState().syncing === 'initial') {
        lastActivity = Date.now();
        return;
      }
      if (Date.now() - lastActivity >= idleMs) lock();
    }, 10_000);

    return () => {
      document.removeEventListener('pointerdown', touch);
      document.removeEventListener('keydown', touch);
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(interval);
    };
  }, [phase, appUnlocked, activePasswordless, autoLockMinutes, lock]);

  // Every screen is wrapped in `.live-scope` so global.css can trim the
  // wallet-surface font sizes without touching the base type scale.
  const section: NavSection =
    subView.name === 'home'
      ? 'home'
      : subView.name === 'settings' || subView.name === 'addressbook'
        ? 'settings'
        : 'other';

  const nav = {
    tab,
    section,
    openTab: (next: HomeTab) => {
      setTab(next);
      setSubView({ name: 'home' });
    },
    openSettings: () => setSubView({ name: 'settings' }),
  };

  const wrap = (node: React.ReactNode) => (
    <div className="live-scope">
      <NavProvider value={nav}>{node}</NavProvider>
    </div>
  );

  // Boot splash.
  if (phase === 'boot') {
    return wrap(
      <div className="app-frame">
        <div className="result-screen">
          <span className="spinner lg" style={{ color: 'var(--accent)' }} />
        </div>
      </div>,
    );
  }

  // THE FORCED APP-PASSWORD SETUP, and it comes before every other screen on
  // purpose (the app-password design notes §12).
  //
  // This user has a wallet whose seed is at rest under an EMPTY passphrase and
  // no app password to protect it with. The owner's decision is that this must
  // stop being a state the wallet can be opened in, so the screen REPLACES the
  // whole app: there is no wallet behind it, no nav, no switcher, no settings,
  // and no branch below can render while the phase holds. It is entered only by
  // init(), so closing the window and opening it again lands right back here,
  // and it is left only by setting the password.
  //
  // It sits above `syncing === 'switching'` as well: that loading screen belongs
  // to a wallet switch, which is unreachable from here, and a phase this
  // absolute must not be something a stale `syncing` value can cover up.
  if (phase === 'force-app-password') {
    return wrap(<LiveForceAppPassword />);
  }

  // Wallet switch in progress: a full-frame loading screen instead of the
  // intermediate lock/empty-home flash while the target wallet spins up.
  if (syncing === 'switching') {
    return wrap(
      <div className="app-frame" data-testid="live-syncing">
        <div className="result-screen">
          <span className="spinner lg" style={{ color: 'var(--accent)' }} />
          <h3 style={{ marginTop: 14 }}>Switching wallet…</h3>
          <p className="text-dim" style={{ fontSize: 12 }}>Loading the selected wallet.</p>
        </div>
      </div>,
    );
  }

  if (phase === 'onboarding') {
    return wrap(<LiveOnboarding />);
  }

  // The APP lock screen: only reachable once an app password has been set.
  if (phase === 'app-locked') {
    return wrap(<LiveAppLock />);
  }

  if (phase === 'locked') {
    return wrap(<LiveLock />);
  }

  // phase === 'ready'
  const home = (
    <LiveHome
      onReceive={() => setSubView({ name: 'receive' })}
      onSend={() => setSubView({ name: 'send' })}
      onSelectAsset={(name) => setSubView({ name: 'asset', asset: name })}
      onSelectTx={(txid) => setSubView({ name: 'tx', txid })}
      // The route is the same one the asset detail uses; LiveHome offers the
      // action only on a chain that has native staking (its own capability
      // check), and this route degrades to home on a chain that has neither
      // kind of staking, so a stale navigation cannot dead-end.
      onStake={() => setSubView({ name: 'staking', from: 'home' })}
    />
  );

  if (subView.name === 'receive') {
    const asset = subView.asset;
    return wrap(
      <LiveReceive
        initialAsset={asset}
        onBack={() => setSubView(asset ? { name: 'asset', asset } : { name: 'home' })}
      />,
    );
  }

  if (subView.name === 'send') {
    const asset = subView.asset;
    const isEvmActive = wallets.find((w) => w.id === activeWalletId)?.family === 'evm';
    const SendScreen = isEvmActive ? LiveSendEvm : LiveSend;
    return wrap(
      <SendScreen
        asset={asset}
        onBack={() => setSubView(asset ? { name: 'asset', asset } : { name: 'home' })}
        onDone={() => setSubView({ name: 'home' })}
      />,
    );
  }

  if (subView.name === 'settings') {
    return wrap(
      <LiveSettings
        onBack={() => setSubView({ name: 'home' })}
        onOpenAddressBook={() => setSubView({ name: 'addressbook' })}
      />,
    );
  }

  if (subView.name === 'addressbook') {
    return wrap(<LiveAddressBook onBack={() => setSubView({ name: 'settings' })} />);
  }

  if (subView.name === 'staking') {
    // TWO staking screens, one route, chosen by what the ACTIVE CHAIN actually
    // has. Neither is a chain-name check:
    //   - stakingSupported()    Satori POOL staking (SATORIEVR on Evrmore), the
    //                           HTTP registration flow in LiveStaking.
    //   - evmStakingSupported() NATIVE staking on an EVM chain whose registry
    //                           row carries `staking` (Epix, cosmos/evm
    //                           precompiles), the transaction flow here.
    // A chain with neither degrades to home rather than rendering an inert
    // screen, exactly as before: the Stake action is never offered there, so
    // reaching this route means a stale navigation.
    // Back returns where the user came FROM: home when the Home action row
    // opened it, otherwise the asset detail that did.
    const fromHome = subView.from === 'home';
    if (evmStakingSupported()) {
      return wrap(
        <LiveStakeEvm
          onBack={() => setSubView(fromHome ? { name: 'home' } : { name: 'asset', asset: nativeTickerFor() })}
        />,
      );
    }
    if (!stakingSupported()) return wrap(home);
    return wrap(
      <LiveStaking
        onBack={() => setSubView(fromHome ? { name: 'home' } : { name: 'asset', asset: 'SATORIEVR' })}
      />,
    );
  }

  if (subView.name === 'tx') {
    return wrap(<LiveTxDetail txid={subView.txid} onBack={() => setSubView({ name: 'home' })} />);
  }

  if (subView.name === 'asset') {
    const displayAssets = computeDisplayedAssets(assets, pinnedAssets, hiddenAssets);
    const selected = displayAssets.find((a) => a.name === subView.asset);
    // If the asset is gone (e.g. removed while viewing), fall back to home.
    if (!selected) return wrap(home);
    // Which asset carries a Stake action depends on WHICH staking the chain
    // has, and the two answers differ:
    //   - Satori pool staking is a SATORIEVR affordance (Evrmore only);
    //   - native staking stakes the chain's own coin, so it belongs on the
    //     native asset (EPIX on Epix), never on a token row.
    // Both go through the store's own chain checks, so this can never drift
    // from the store's refusal, and a chain with neither shows no Stake button.
    const canStake = evmStakingSupported()
      ? selected.isNative && selected.name === nativeTickerFor()
      : selected.name === 'SATORIEVR' && stakingSupported();
    return wrap(
      <LiveAssetDetail
        asset={selected}
        onBack={() => setSubView({ name: 'home' })}
        onReceive={() => setSubView({ name: 'receive', asset: selected.name })}
        onSend={() => setSubView({ name: 'send', asset: selected.name })}
        onSelectTx={(txid) => setSubView({ name: 'tx', txid })}
        onStake={canStake ? () => setSubView({ name: 'staking' }) : undefined}
      />,
    );
  }

  return wrap(home);
}
