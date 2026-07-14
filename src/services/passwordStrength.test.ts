import { describe, it, expect } from 'vitest';
import { estimatePasswordStrength, type PasswordScore } from './passwordStrength';

const score = (pw: string): PasswordScore => estimatePasswordStrength(pw).score;

describe('estimatePasswordStrength', () => {
  it('empty and very short passwords are very weak (score 0)', () => {
    expect(estimatePasswordStrength('')).toEqual({ score: 0, label: 'very-weak' });
    expect(estimatePasswordStrength('a')).toEqual({ score: 0, label: 'very-weak' });
    expect(estimatePasswordStrength('abc')).toEqual({ score: 0, label: 'very-weak' });
  });

  it('score and label always agree and stay within 0..4', () => {
    const labels = ['very-weak', 'weak', 'fair', 'good', 'strong'];
    for (const pw of ['', 'a', 'password', 'abc123def', 'kV9#mQ2$xL7@', 'Tr0ub4dour&3xtra']) {
      const { score: s, label } = estimatePasswordStrength(pw);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(4);
      expect(label).toBe(labels[s]);
    }
  });

  it('common dictionary passwords are capped at weak-at-best', () => {
    // Exact common-list hits are forced to the weakest score even when long.
    expect(score('password')).toBe(0);
    expect(score('password123')).toBe(0);
    expect(score('qwerty123')).toBe(0);
    expect(score('12345678')).toBe(0);
    expect(score('letmein')).toBe(0);
    // "password123" must never rate above weak (score <= 1) per the spec.
    expect(score('password123')).toBeLessThanOrEqual(1);
  });

  it('a long multi-class random-ish password is strong (score 4)', () => {
    expect(score('kV9#mQ2$xL7@')).toBe(4);
  });

  it('monotone sequences and repeats are penalised', () => {
    // Straight runs and long repeats drag the score down versus a similar-length
    // password without them.
    expect(score('12345678')).toBeLessThanOrEqual(1); // pure digit sequence
    expect(score('abcdefgh')).toBeLessThanOrEqual(1); // pure alpha sequence
    expect(score('aaaaaaaa')).toBeLessThanOrEqual(1); // long repeat
    expect(score('qwertyuiop')).toBeLessThanOrEqual(1); // keyboard row
    // A sequence-containing password scores no higher than a scrambled one of
    // the same length and class mix.
    expect(score('abcd1234')).toBeLessThanOrEqual(score('h7fk2q9x'));
  });

  it('year-like suffixes are penalised', () => {
    // Same base and class mix (lower + 4 digits); only the digit tail differs.
    // The year-like tail ("2021") must score no higher than a non-year tail.
    expect(score('bluehouse2021')).toBeLessThanOrEqual(score('bluehouse4837'));
  });

  it('score is monotone non-decreasing when appending a new character class', () => {
    // Spot-check pairs: each step adds a fresh character class to a fixed base,
    // so strength must not go *down*.
    const pairs: Array<[string, string]> = [
      ['loweronly', 'loweronlyU'], // + uppercase
      ['loweronlyU', 'loweronlyU7'], // + digit
      ['loweronlyU7', 'loweronlyU7!'], // + symbol
      ['xkq', 'xkqZ'], // short base + uppercase
      ['mydogspot', 'mydogspot9'], // + digit
    ];
    for (const [base, extended] of pairs) {
      expect(score(extended)).toBeGreaterThanOrEqual(score(base));
    }
  });

  it('rates a genuinely strong passphrase highly', () => {
    expect(score('Tr0ub4dour&3xtra')).toBeGreaterThanOrEqual(3);
    expect(score('9xK#pL2@vN8$wQ4!')).toBe(4);
  });
});
