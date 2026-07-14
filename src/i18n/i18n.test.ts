import { describe, expect, it } from 'vitest';
import { en } from './en';
import { pl } from './pl';
import { translate } from './index';

describe('i18n', () => {
  it('en and pl dictionaries expose the same keys', () => {
    expect(Object.keys(pl).sort()).toEqual(Object.keys(en).sort());
  });

  it('has no empty translations', () => {
    for (const value of [...Object.values(en), ...Object.values(pl)]) {
      expect(value.trim().length).toBeGreaterThan(0);
    }
  });

  it('leaves a string with no placeholders untouched when params are passed', () => {
    expect(translate('en', 'accent.azure', { unused: 1 })).toBe('Azure');
  });

  it('actually differs between languages', () => {
    expect(translate('pl', 'network.connected')).toBe('Połączono');
    expect(translate('en', 'network.connected')).toBe('Connected');
  });
});
