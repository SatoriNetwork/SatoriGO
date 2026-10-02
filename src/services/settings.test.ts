import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from './settings';
import { MemoryStorageAdapter, setStorageForTests } from './storage';
import { getStorage } from './storage';
import { moveFavouriteChain, normalizeFavouriteChains, toggleFavouriteChain } from './favouriteChains';

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

describe('the display currency preference', () => {
  it('defaults to USD', async () => {
    expect(DEFAULT_SETTINGS.currency).toBe('USD');
    expect((await loadSettings()).currency).toBe('USD');
  });

  it('round-trips EUR and PLN', async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, currency: 'EUR' });
    expect((await loadSettings()).currency).toBe('EUR');
    await saveSettings({ ...DEFAULT_SETTINGS, currency: 'PLN' });
    expect((await loadSettings()).currency).toBe('PLN');
  });

  it('reads a value this build does not offer (an old GBP, garbage) as USD', async () => {
    await getStorage().set('settings', { currency: 'GBP', theme: 'light' });
    const loaded = await loadSettings();
    expect(loaded.currency).toBe('USD');
    expect(loaded.theme).toBe('light');
    await getStorage().set('settings', { currency: 42 });
    expect((await loadSettings()).currency).toBe('USD');
  });
});

describe('the settings store persists the display currency', () => {
  it('update({ currency }) writes it and a fresh load reads it back', async () => {
    const { useSettingsStore } = await import('../store/settingsStore');
    await useSettingsStore.getState().update({ currency: 'PLN' });
    expect(useSettingsStore.getState().settings.currency).toBe('PLN');
    expect((await loadSettings()).currency).toBe('PLN');
    await useSettingsStore.getState().update({ currency: 'USD' });
  });
});

describe('favourite networks (chain switcher stars)', () => {
  it('default to none and round-trip in order', async () => {
    expect(DEFAULT_SETTINGS.favouriteChains).toEqual([]);
    expect((await loadSettings()).favouriteChains).toEqual([]);
    await saveSettings({ ...DEFAULT_SETTINGS, favouriteChains: ['evm:base', 'mainnet', 'xmr:mainnet'] });
    expect((await loadSettings()).favouriteChains).toEqual(['evm:base', 'mainnet', 'xmr:mainnet']);
  });

  it('settings saved before the field existed read as no favourites', async () => {
    await getStorage().set('settings', { language: 'pl', currency: 'EUR' });
    const loaded = await loadSettings();
    expect(loaded.favouriteChains).toEqual([]);
    expect(loaded.currency).toBe('EUR');
  });

  it('a malformed stored value is cleaned: strings only, no blanks, no duplicates', async () => {
    await getStorage().set('settings', { favouriteChains: ['mainnet', 7, '', 'mainnet', null, 'evm:base'] });
    expect((await loadSettings()).favouriteChains).toEqual(['mainnet', 'evm:base']);
    await getStorage().set('settings', { favouriteChains: 'mainnet' });
    expect((await loadSettings()).favouriteChains).toEqual([]);
  });

  it('the settings store writes stars through update()', async () => {
    const { useSettingsStore } = await import('../store/settingsStore');
    await useSettingsStore.getState().update({ favouriteChains: ['dogecoin-mainnet'] });
    expect((await loadSettings()).favouriteChains).toEqual(['dogecoin-mainnet']);
    await useSettingsStore.getState().update({ favouriteChains: [] });
  });
});

describe('favouriteChains helpers', () => {
  it('toggle appends a new star at the end and removes an existing one in place', () => {
    expect(toggleFavouriteChain([], 'a')).toEqual(['a']);
    expect(toggleFavouriteChain(['a', 'b'], 'c')).toEqual(['a', 'b', 'c']);
    expect(toggleFavouriteChain(['a', 'b', 'c'], 'b')).toEqual(['a', 'c']);
  });

  it('move swaps with the neighbour and is a no-op at the ends', () => {
    expect(moveFavouriteChain(['a', 'b', 'c'], 'c', -1)).toEqual(['a', 'c', 'b']);
    expect(moveFavouriteChain(['a', 'b', 'c'], 'a', 1)).toEqual(['b', 'a', 'c']);
    expect(moveFavouriteChain(['a', 'b', 'c'], 'a', -1)).toEqual(['a', 'b', 'c']);
    expect(moveFavouriteChain(['a', 'b', 'c'], 'c', 1)).toEqual(['a', 'b', 'c']);
    expect(moveFavouriteChain(['a', 'b'], 'zz', 1)).toEqual(['a', 'b']);
  });

  it('move skips ids the user cannot see, which keep their slots', () => {
    // 'gone' is unknown to this build: moving 'c' up swaps it with 'a'.
    expect(moveFavouriteChain(['a', 'gone', 'c'], 'c', -1, ['a', 'c'])).toEqual(['c', 'gone', 'a']);
  });

  it('normalize accepts only a string array', () => {
    expect(normalizeFavouriteChains(undefined)).toEqual([]);
    expect(normalizeFavouriteChains({})).toEqual([]);
    expect(normalizeFavouriteChains(['x', 'x', 'y'])).toEqual(['x', 'y']);
  });
});
