import { getStorage } from './storage';
import { normalizeFiatCurrency, type FiatCurrency } from './fiat';
import { normalizeFavouriteChains } from './favouriteChains';

export type Language = 'en' | 'pl';
/** The fiat display currency (Settings, Appearance). Only what the gateway's
 *  /prices document can price: see services/fiat.ts. */
export type Currency = FiatCurrency;
export type ThemeMode = 'dark' | 'light' | 'system';
/** 'satori' is the brand accent (the neuron's #5a5aff) and the default. The rest
 *  stay as opt-in personalisation. */
export type AccentId = 'satori' | 'azure' | 'violet' | 'cyan' | 'emerald' | 'amber' | 'rose';
export type ClipboardClearSeconds = 0 | 15 | 30 | 60;

export interface Settings {
  language: Language;
  currency: Currency;
  theme: ThemeMode;
  accent: AccentId;
  compactMode: boolean;
  reducedMotion: boolean;
  clipboardClearSeconds: ClipboardClearSeconds;
  /** Starred networks in the chain switcher, as chain target ids in the order
   *  the user arranged them (see favouriteChains.ts). Per device, not per
   *  wallet. */
  favouriteChains: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  language: 'en',
  currency: 'USD',
  theme: 'dark',
  accent: 'satori',
  compactMode: false,
  reducedMotion: false,
  clipboardClearSeconds: 0,
  favouriteChains: [],
};

const KEY = 'settings';

export async function loadSettings(): Promise<Settings> {
  const stored = await getStorage().get<Partial<Settings>>(KEY);
  const merged = { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
  // A value this build does not offer (an old 'GBP', anything malformed) reads
  // as the default instead of reaching a formatter as an unknown code.
  return {
    ...merged,
    currency: normalizeFiatCurrency(merged.currency),
    favouriteChains: normalizeFavouriteChains(merged.favouriteChains),
  };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await getStorage().set(KEY, settings);
}
