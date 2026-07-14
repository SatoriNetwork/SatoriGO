// The bottom tab bar, shared by EVERY wallet screen.
//
// It used to live inside LiveHome, so it vanished the moment you opened Settings (or
// Send, or an asset), stranding you with only a Back arrow. It is now a component
// that each screen renders, fed by a context that LiveApp provides, so no screen has
// to thread navigation props through its own props.
//
// It is deliberately NOT rendered on the lock or onboarding screens: there is no
// wallet to navigate yet.
import { createContext, useContext } from 'react';
import { History, Settings, Wallet } from 'lucide-react';

import { BrandLogo } from '../../components/BrandLogo';
import { useLiveStore } from '../../store/liveStore';

/** Which of the home screen's inner tabs is showing. */
export type HomeTab = 'assets' | 'network' | 'activity';

/** Where in the wallet we are, for the purpose of highlighting a tab. */
export type NavSection = 'home' | 'settings' | 'other';

export interface NavContextValue {
  tab: HomeTab;
  section: NavSection;
  /** Go to the home screen and show this tab. */
  openTab(tab: HomeTab): void;
  openSettings(): void;
}

const NavContext = createContext<NavContextValue | null>(null);

export const NavProvider = NavContext.Provider;

export function useNav(): NavContextValue {
  const ctx = useContext(NavContext);
  if (!ctx) throw new Error('useNav used outside a NavProvider');
  return ctx;
}

export function LiveNav() {
  const { tab, section, openTab, openSettings } = useNav();
  const unreadActivity = useLiveStore((s) => s.unreadActivity);

  // A tab is only "current" while we are actually on the home screen; from Settings,
  // no home tab is selected.
  const onHome = section === 'home';

  return (
    <nav className="bottom-nav" role="tablist">
      <button
        type="button"
        role="tab"
        aria-selected={onHome && tab === 'assets'}
        className="nav-item"
        onClick={() => openTab('assets')}
        data-testid="live-tab-assets"
      >
        <Wallet size={19} />
        Wallet
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={onHome && tab === 'activity'}
        className="nav-item"
        onClick={() => openTab('activity')}
        data-testid="live-tab-activity"
        style={{ position: 'relative' }}
      >
        <span style={{ position: 'relative', display: 'inline-flex' }}>
          <History size={19} />
          {unreadActivity > 0 && (
            <span
              data-testid="live-activity-badge"
              aria-label={`${unreadActivity} new`}
              style={{
                position: 'absolute',
                top: -5,
                right: -8,
                minWidth: 15,
                height: 15,
                padding: '0 3px',
                borderRadius: 8,
                background: 'var(--danger)',
                color: '#fff',
                fontSize: 9,
                fontWeight: 700,
                lineHeight: '15px',
                textAlign: 'center',
                boxShadow: '0 0 0 2px var(--bg)',
              }}
            >
              {unreadActivity > 9 ? '9+' : unreadActivity}
            </span>
          )}
        </span>
        Activity
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={section === 'settings'}
        className="nav-item"
        onClick={openSettings}
        data-testid="live-settings-btn"
      >
        <Settings size={19} />
        Settings
      </button>
      {/* Satori Network. Last in the row, unlabelled, and larger than the icon tabs:
          the mark IS the label, and it earns the extra weight for being the Satori
          entry point. */}
      <button
        type="button"
        role="tab"
        aria-selected={onHome && tab === 'network'}
        className="nav-item nav-item-mark"
        onClick={() => openTab('network')}
        data-testid="live-tab-network"
        aria-label="Satori Network"
        title="Satori Network"
      >
        <BrandLogo slot="satori" size={30} alt="" />
      </button>
    </nav>
  );
}
