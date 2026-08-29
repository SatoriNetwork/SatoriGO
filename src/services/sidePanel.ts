// The wallet's window mode: docked in the browser's SIDE PANEL (it stays open
// while you browse, the way MetaMask offers) or the toolbar POPUP that closes
// the moment you click elsewhere. Since 2026-08-28 (owner's request) the side
// panel is the DEFAULT wherever the browser has a real one; the popup is a
// choice the user makes in Settings > Appearance.
//
// THE STORED PREFERENCE IS TRI-STATE IN EFFECT:
//   * absent  -> nobody has chosen: defaultSidePanelPreference() decides.
//   * true    -> the user wants the panel.
//   * false   -> the user wants the popup. This is why the raw value has to
//     survive the read: if a stored `false` decayed into "unset" it would be
//     re-defaulted back to the panel on the next worker boot and the user's own
//     choice would silently undo itself.
//
// HOW IT WORKS (Chrome / Edge, MV3 `sidePanel` API):
//   * The manifest carries the `sidePanel` permission and a `default_popup`.
//     The panel itself is registered at runtime with
//     `chrome.sidePanel.setOptions({ path, enabled })`; the manifest popup is
//     the pre-worker fallback, so the first toolbar click after an install
//     always opens a wallet even if the worker has not booted yet.
//   * Panel ON: the panel is enabled + pointed at `index.html?panel=1`,
//     `setPanelBehavior({ openPanelOnActionClick: true })` makes the toolbar
//     icon open the panel, and the action POPUP is cleared (a popup always wins
//     over the panel behaviour, so it must go). Panel OFF restores both.
//   * The preference lives in chrome.storage.local (SIDE_PANEL_PREF_KEY). The
//     settings screen applies it immediately AND the background worker re-applies
//     the effective mode on every boot, so it survives browser restarts whatever
//     the browser itself persists. "Takes effect the next time you open the
//     wallet": the popup you are in stays a popup until it is closed.
//   * Firefox has no `chrome.sidePanel`; it has `sidebar_action` (the manifest
//     registers `index.html?panel=1` as the sidebar, not opened at install) and
//     `chrome.sidebarAction`. There the preference only clears / restores the
//     action popup: with no popup, the toolbar click reaches the background's
//     `action.onClicked`, which toggles the sidebar (that call is allowed only
//     inside a user-input handler, which onClicked is). The sidebar is also
//     always reachable from Firefox's own View > Sidebar menu.
//   * The new default is deliberately NOT applied on Firefox: docking there
//     means clearing the popup and leaving the toolbar icon dependent on a
//     background listener, so a fresh install whose listener is asleep or whose
//     toggle call is refused would have an icon that does nothing at all. A
//     Firefox user opts in from Settings and undoes it from the same row.
//     Chrome and Edge open the panel themselves, with no listener in the path,
//     which is what makes the default safe there.
//
// Inside the panel, main.tsx stamps `data-panel` on <html> (from the ?panel=1
// query) and global.css lets the fixed 400x600 popup canvas follow the panel's
// own width and height (see the `:root[data-panel]` rules).

import { useCallback, useEffect, useState } from 'react';

/** chrome.storage.local key holding the preference (boolean, or absent). */
export const SIDE_PANEL_PREF_KEY = 'ui:sidePanel';
/** The page the side panel loads; the query is what main.tsx reads. */
export const SIDE_PANEL_PATH = 'index.html?panel=1';
/** The toolbar popup page, restored when the preference is turned off. */
export const POPUP_PATH = 'index.html';
export const PANEL_FLAG = 'panel';

/** True when this document runs inside the side panel (index.html?panel=1). */
export function isSidePanelWindow(search: string = typeof window !== 'undefined' ? window.location.search : ''): boolean {
  return new URLSearchParams(search).get(PANEL_FLAG) === '1';
}

interface SidePanelApi {
  setOptions?(options: { path?: string; enabled?: boolean }): Promise<void>;
  setPanelBehavior?(behavior: { openPanelOnActionClick: boolean }): Promise<void>;
  getPanelBehavior?(): Promise<{ openPanelOnActionClick: boolean }>;
}
interface ActionApi {
  setPopup(details: { popup: string }): Promise<void>;
  getPopup(details: Record<string, never>): Promise<string>;
}
interface SidebarActionApi {
  open(): Promise<void>;
  toggle?(): Promise<void>;
  setPanel(details: { panel: string | null }): Promise<void>;
}
interface ChromeLike {
  sidePanel?: SidePanelApi;
  /** Firefox's sidebar (sidebar_action). */
  sidebarAction?: SidebarActionApi;
  action?: ActionApi;
  storage?: { local?: { get(keys: string[]): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> } };
}

/** Chrome/Edge dock the wallet in a side panel, Firefox in a sidebar, the rest
 *  not at all. */
export type SidePanelFlavor = 'sidePanel' | 'sidebar' | 'none';

function chromeApi(): ChromeLike | null {
  const api = (globalThis as { chrome?: ChromeLike }).chrome;
  return api ?? null;
}

/** Which docking API this browser has. */
export function sidePanelFlavor(): SidePanelFlavor {
  const api = chromeApi();
  if (!api?.action?.setPopup) return 'none';
  if (api.sidePanel?.setOptions && api.sidePanel?.setPanelBehavior) return 'sidePanel';
  if (api.sidebarAction?.open) return 'sidebar';
  return 'none';
}

/** True when this browser can dock the wallet (Chrome, Edge: side panel;
 *  Firefox: sidebar). */
export function sidePanelSupported(): boolean {
  return sidePanelFlavor() !== 'none';
}

/** The window mode for a user who has never chosen: the side panel where the
 *  browser opens it by itself, the popup everywhere else (the Firefox and
 *  no-API reasoning is at the top of this file). */
export function defaultSidePanelPreference(flavor: SidePanelFlavor = sidePanelFlavor()): boolean {
  return flavor === 'sidePanel';
}

/**
 * The raw stored choice, or null when the user has never made one. Storage that
 * cannot be read counts as "never chosen": falling back to the default is safer
 * than pretending the user asked for the popup. Callers that want to know what
 * should happen want readSidePanelPreference(); this one exists so that absent
 * can be told apart from an explicit false.
 */
export async function readStoredSidePanelPreference(): Promise<boolean | null> {
  const local = chromeApi()?.storage?.local;
  if (!local) return null;
  try {
    const got = await local.get([SIDE_PANEL_PREF_KEY]);
    const stored = got[SIDE_PANEL_PREF_KEY];
    return typeof stored === 'boolean' ? stored : null;
  } catch {
    return null;
  }
}

/** The effective preference: the user's own choice, else this browser's default. */
export async function readSidePanelPreference(): Promise<boolean> {
  return (await readStoredSidePanelPreference()) ?? defaultSidePanelPreference();
}

/**
 * Apply `enabled` to the browser: panel registered + icon opens it + popup
 * cleared, or the reverse. Never throws (an unsupported browser is a no-op);
 * returns whether it could be applied.
 */
export async function applySidePanelPreference(enabled: boolean): Promise<boolean> {
  const api = chromeApi();
  const flavor = sidePanelFlavor();
  if (flavor === 'none' || !api?.action) return false;
  if (flavor === 'sidebar') {
    // Firefox: the sidebar page is fixed by the manifest; only the popup moves
    // out of the way (and back). The background toggles the sidebar on click.
    try {
      await api.action.setPopup({ popup: enabled ? '' : POPUP_PATH });
      return true;
    } catch {
      return false;
    }
  }
  const panel = api.sidePanel;
  if (!panel?.setOptions || !panel.setPanelBehavior) return false;
  try {
    if (enabled) {
      await panel.setOptions({ path: SIDE_PANEL_PATH, enabled: true });
      await panel.setPanelBehavior({ openPanelOnActionClick: true });
      // Order matters: the popup is cleared LAST, so a failure above leaves the
      // user with a working popup rather than an icon that does nothing.
      await api.action.setPopup({ popup: '' });
    } else {
      await api.action.setPopup({ popup: POPUP_PATH });
      await panel.setPanelBehavior({ openPanelOnActionClick: false });
      await panel.setOptions({ enabled: false });
    }
    return true;
  } catch {
    return false;
  }
}

/** Persist AND apply. Returns false when the browser could not apply it (the
 *  preference is still stored, so a later supporting browser honours it). */
export async function writeSidePanelPreference(enabled: boolean): Promise<boolean> {
  const local = chromeApi()?.storage?.local;
  if (local) {
    try {
      await local.set({ [SIDE_PANEL_PREF_KEY]: enabled });
    } catch {
      /* storage unavailable: still try to apply for this session */
    }
  }
  return applySidePanelPreference(enabled);
}

/**
 * Firefox only: the toolbar click with NO popup set (preference on) lands in
 * `action.onClicked`; toggle the sidebar from there. No-op elsewhere (Chrome's
 * panel behaviour opens the panel itself and never fires onClicked for it).
 * Returns whether a sidebar call was made.
 */
export async function handleActionClickForSidebar(): Promise<boolean> {
  const api = chromeApi();
  if (sidePanelFlavor() !== 'sidebar' || !api?.sidebarAction) return false;
  try {
    if (api.sidebarAction.toggle) await api.sidebarAction.toggle();
    else await api.sidebarAction.open();
    return true;
  } catch {
    return false;
  }
}

/**
 * Background worker boot: put the effective window mode back. Safe to call often.
 *
 * This used to skip the work whenever the preference was off, on the grounds
 * that a fresh install already had the popup it needed. The default flip turns
 * that around: a fresh install on Chrome/Edge has to be moved TO the panel from
 * here, and an explicit popup choice has to be re-asserted, because an update
 * reloads the extension while the browser still holds the panel registration.
 * A browser with neither API is still left untouched, so it keeps the popup the
 * manifest gives it and never sees an error.
 */
export async function restoreSidePanelPreference(): Promise<void> {
  if (sidePanelFlavor() === 'none') return;
  await applySidePanelPreference(await readSidePanelPreference());
}

/** React hook for the settings toggle: the effective value, a setter, and
 *  whether this browser supports the panel at all. */
export function useSidePanelPreference(): {
  supported: boolean;
  enabled: boolean;
  loaded: boolean;
  setEnabled(next: boolean): Promise<boolean>;
} {
  // Seeded with this browser's default so the row does not flash the wrong
  // state in the moment before storage answers.
  const [enabled, setEnabledState] = useState(() => defaultSidePanelPreference());
  const [loaded, setLoaded] = useState(false);
  const supported = sidePanelSupported();
  useEffect(() => {
    let alive = true;
    void readSidePanelPreference().then((v) => {
      if (!alive) return;
      setEnabledState(v);
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, []);
  const setEnabled = useCallback(async (next: boolean) => {
    setEnabledState(next);
    return writeSidePanelPreference(next);
  }, []);
  return { supported, enabled, loaded, setEnabled };
}
