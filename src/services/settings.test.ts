import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from './settings';
import { MemoryStorageAdapter, setStorageForTests } from './storage';
import { getStorage } from './storage';

beforeEach(() => {
  setStorageForTests(new MemoryStorageAdapter());
});

describe('settings persistence', () => {
  it('returns defaults when nothing is stored', async () => {
    expect(await loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('round-trips saved settings', async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, language: 'pl', currency: 'PLN', theme: 'light', compactMode: true });
    const loaded = await loadSettings();
    expect(loaded.language).toBe('pl');
    expect(loaded.currency).toBe('PLN');
    expect(loaded.theme).toBe('light');
    expect(loaded.compactMode).toBe(true);
  });

  it('merges stored partial settings over defaults (forward compatibility)', async () => {
    await getStorage().set('settings', { language: 'pl' });
    const loaded = await loadSettings();
    expect(loaded.language).toBe('pl');
    expect(loaded.accent).toBe(DEFAULT_SETTINGS.accent);
    expect(loaded.clipboardClearSeconds).toBe(DEFAULT_SETTINGS.clipboardClearSeconds);
  });
});
