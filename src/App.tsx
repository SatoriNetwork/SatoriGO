import { useEffect, useRef, useState } from 'react';
import { useSettingsStore } from './store/settingsStore';
import { useBrandingStore } from './store/brandingStore';
import { Toasts } from './components/Toasts';
import { LiveApp } from './screens/live/LiveApp';
import { DappApproval, type DappHostSession } from './screens/dapp/DappApproval';
import { liveService, useLiveStore } from './store/liveStore';

/** dApp approval mode: the background worker opens index.html?dapp=<id> for a
 *  pending site request. Guarded so non-browser (jsdom/node) runs return null. */
function getDappRequestId(): string | null {
  try {
    if (typeof window === 'undefined' || !window.location) return null;
    return new URLSearchParams(window.location.search).get('dapp');
  } catch {
    return null;
  }
}

/** Applies theme/accent/compact/motion settings to the <html> element. */
function useThemeSync() {
  const settings = useSettingsStore((s) => s.settings);
  useEffect(() => {
    const root = document.documentElement;
    const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
    const systemReduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => {
      const theme = settings.theme === 'system' ? (systemDark.matches ? 'dark' : 'light') : settings.theme;
      root.dataset.theme = theme;
      root.dataset.accent = settings.accent;
      root.dataset.compact = String(settings.compactMode);
      root.dataset.reducedMotion = String(settings.reducedMotion || systemReduced.matches);
      root.lang = settings.language;
    };
    apply();
    systemDark.addEventListener('change', apply);
    systemReduced.addEventListener('change', apply);
    return () => {
      systemDark.removeEventListener('change', apply);
      systemReduced.removeEventListener('change', apply);
    };
  }, [settings]);
}

export function App() {
  // Approval mode replaces the whole app (no wallet boot) — the window only
  // exists to decide ONE pending dApp request.
  const dappId = getDappRequestId();
  if (dappId) return <ThemedDappApproval requestId={dappId} />;
  return <MainApp />;
}

/** The approval route bypasses MainApp entirely, so without this wrapper
 *  useThemeSync never ran for it and the window ignored the user's theme
 *  (always dark). Load the display settings and apply the same sync here. */
function ThemedDappApproval({ requestId }: { requestId: string }) {
  useThemeSync();
  useEffect(() => {
    void useSettingsStore.getState().load();
  }, []);
  return <DappApproval requestId={requestId} />;
}

function MainApp() {
  const [booted, setBooted] = useState(false);
  /** A dApp request the background worker asked THIS open wallet window to
   *  decide (see hostInOpenWalletUi in the worker). Rendered as an overlay so
   *  the wallet underneath keeps its state and its connections. */
  const [hostedDapp, setHostedDapp] = useState<string | null>(null);
  const hostedRef = useRef<string | null>(null);
  hostedRef.current = hostedDapp;
  useThemeSync();

  // What the hosted approval may reuse from THIS page: the wallet service the
  // user has already unlocked here, so a site's sign or send request does not
  // ask for the password a second time (see DappApproval, `session`).
  const phase = useLiveStore((s) => s.phase);
  const activeWalletId = useLiveStore((s) => s.activeWalletId);
  const wallets = useLiveStore((s) => s.wallets);
  const requirePasswordToSend = useLiveStore((s) => s.requirePasswordToSend);
  const verifyPassword = useLiveStore((s) => s.verifyPassword);
  const activeWallet = wallets.find((w) => w.id === activeWalletId);
  const hostSession: DappHostSession = {
    service: liveService(),
    unlocked: phase === 'ready',
    activeWalletId,
    // The wallet's own send screen rule (LiveSend): the gate applies unless
    // the wallet is passwordless or opted out of the send password.
    sendNeedsPassword: requirePasswordToSend && !((activeWallet?.passwordless ?? false) || (activeWallet?.noSendPassword ?? false)),
    verifyPassword,
  };

  // The worker OFFERS a pending request to the open wallet windows, naming the
  // URL of the one it prefers (the side panel over a tab). Every window that
  // could host it sends a CLAIM; the worker accepts exactly one, so two tabs at
  // the same URL never both show the approval. The preferred window claims at
  // once, the others after a short delay so it wins when it is still alive. A
  // window already hosting one request claims nothing: the worker then opens
  // the popup rather than replacing an approval the user is looking at.
  // Guarded for jsdom/tests, where there is no chrome.runtime.
  useEffect(() => {
    const rt = typeof chrome !== 'undefined' ? chrome.runtime : undefined;
    if (!rt?.onMessage?.addListener) return;
    const HOST_FALLBACK_DELAY_MS = 150;
    const onMessage = (message: unknown): undefined => {
      const msg = message as { type?: string; id?: string; hostUrl?: string } | null;
      if (msg?.type !== 'evr-dapp-host-offer' || typeof msg.id !== 'string') return undefined;
      const id = msg.id;
      const preferred = msg.hostUrl === window.location.href;
      /** Busy = hosting a request that is STILL parked. One that was just
       *  decided is gone from session storage before this page has even
       *  received the worker's reply, so the overlay may linger a few ms;
       *  that must not turn the next request into a popup. */
      const busy = async () => {
        const hosting = hostedRef.current;
        if (!hosting) return false;
        try {
          const key = `dappPending:${hosting}`;
          const parked = await chrome.storage.session.get(key);
          return !!parked[key];
        } catch {
          return true;
        }
      };
      void (async () => {
        if (await busy()) return;
        if (!preferred) await new Promise((r) => setTimeout(r, HOST_FALLBACK_DELAY_MS));
        if (await busy()) return;
        try {
          const r = (await rt.sendMessage({ type: 'evr-dapp-host-claim', id })) as { accepted?: boolean } | undefined;
          if (r?.accepted) setHostedDapp(id);
        } catch {
          // worker gone: the request will time out on its own
        }
      })();
      return undefined;
    };
    rt.onMessage.addListener(onMessage);
    return () => rt.onMessage.removeListener(onMessage);
  }, []);

  // The real EVRmore wallet is the whole app. We only need to load display
  // settings (theme/accent) and branding (logos) before mounting it; LiveApp's
  // own init() drives the wallet phase (onboarding / locked / ready).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await Promise.all([
        useSettingsStore.getState().load(),
        useBrandingStore.getState().load(),
      ]);
      if (!cancelled) setBooted(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!booted) {
    return (
      <div className="app-frame">
        <div className="result-screen">
          <span className="spinner lg" style={{ color: 'var(--accent)' }} />
        </div>
      </div>
    );
  }

  return (
    <>
      <LiveApp />
      <Toasts />
      {hostedDapp && (
        <DappApproval
          key={hostedDapp}
          requestId={hostedDapp}
          hosted
          session={hostSession}
          onDone={() => setHostedDapp(null)}
        />
      )}
    </>
  );
}
