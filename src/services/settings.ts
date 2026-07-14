import { getStorage } from './storage';

export type Language = 'en' | 'pl';
export type Currency = 'USD' | 'EUR' | 'PLN' | 'GBP';
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
}

export const DEFAULT_SETTINGS: Settings = {
  language: 'en',
  currency: 'USD',
  theme: 'dark',
  accent: 'satori',
  compactMode: false,
  reducedMotion: false,
  clipboardClearSeconds: 0,
};

const KEY = 'settings';

export async function loadSettings(): Promise<Settings> {
  const stored = await getStorage().get<Partial<Settings>>(KEY);
  return { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await getStorage().set(KEY, settings);
}
