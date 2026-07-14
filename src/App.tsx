import { useEffect, useState } from 'react';
import { useSettingsStore } from './store/settingsStore';
import { useBrandingStore } from './store/brandingStore';
import { Toasts } from './components/Toasts';
import { LiveApp } from './screens/live/LiveApp';
import { DappApproval } from './screens/dapp/DappApproval';

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
  if (dappId) return <DappApproval requestId={dappId} />;
  return <MainApp />;
}

function MainApp() {
  const [booted, setBooted] = useState(false);
  useThemeSync();

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
    </>
  );
}
