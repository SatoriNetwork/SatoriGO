// Root of the wallet UI — renders the correct screen based on the store phase.
// Mounted directly by App.tsx once display settings + branding have loaded.

import { useEffect, useState } from 'react';
import { useLiveStore, computeDisplayedAssets } from '../../store/liveStore';
import { LiveOnboarding } from './LiveOnboarding';
import { LiveLock } from './LiveLock';
import { LiveHome } from './LiveHome';
import { LiveReceive } from './LiveReceive';
import { LiveSend } from './LiveSend';
import { LiveAssetDetail } from './LiveAssetDetail';
import { LiveSettings } from './LiveSettings';
import { LiveTxDetail } from './LiveTxDetail';
import { LiveAddressBook } from './LiveAddressBook';
import { LiveStaking } from './LiveStaking';
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
  | { name: 'staking' }
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
  const activePasswordless =
    wallets.find((w) => w.id === activeWalletId)?.passwordless ?? false;

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

  // Auto-lock after inactivity: while the wallet is ready, track user activity
  // and lock() once `autoLockMinutes` of idle time elapse. Skipped for a
  // passwordless wallet (nothing to re-enter) and when the timeout is 0 (never).
  // Activity resets on pointer/keyboard input and on regaining tab visibility.
  useEffect(() => {
    if (phase !== 'ready') return;
    if (activePasswordless) return;
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
      if (Date.now() - lastActivity >= idleMs) lock();
    }, 10_000);

    return () => {
      document.removeEventListener('pointerdown', touch);
      document.removeEventListener('keydown', touch);
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(interval);
    };
  }, [phase, activePasswordless, autoLockMinutes, lock]);

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
    return wrap(
      <LiveSend
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
    return wrap(<LiveStaking onBack={() => setSubView({ name: 'asset', asset: 'SATORIEVR' })} />);
  }

  if (subView.name === 'tx') {
    return wrap(<LiveTxDetail txid={subView.txid} onBack={() => setSubView({ name: 'home' })} />);
  }

  if (subView.name === 'asset') {
    const displayAssets = computeDisplayedAssets(assets, pinnedAssets, hiddenAssets);
    const selected = displayAssets.find((a) => a.name === subView.asset);
    // If the asset is gone (e.g. removed while viewing), fall back to home.
    if (!selected) return wrap(home);
    // Staking is offered ONLY for SATORIEVR on mainnet (all wallets here are
    // mainnet, but gate explicitly so a future testnet wallet never shows it).
    const activeNetwork = wallets.find((w) => w.id === activeWalletId)?.network ?? 'mainnet';
    const canStake = selected.name === 'SATORIEVR' && activeNetwork === 'mainnet';
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
