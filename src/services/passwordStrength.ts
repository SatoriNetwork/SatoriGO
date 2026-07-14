// Advisory password-strength estimator.
//
// Pure, deterministic, dependency-free and CSP-safe: no network, no imports,
// no randomness. This is a *heuristic* UX aid to nudge users toward stronger
// wallet passwords. It is NOT an authority — it does not gate submission and it
// does not replace the min-length rule enforced by the forms. A stolen vault's
// real defence is the scrypt KDF (see src/services/chain/vault.ts); this bar
// just discourages obviously weak choices.
//
// The score is intentionally simple and explainable:
//   - reward length (tiers) and character-class variety
//   - penalise single-class passwords, common patterns (repeats, straight
//     sequences, keyboard rows, year-like suffixes) and known common passwords
// Output is clamped to 0..4 with a matching label.

export type PasswordScore = 0 | 1 | 2 | 3 | 4;
export type PasswordStrengthLabel = 'very-weak' | 'weak' | 'fair' | 'good' | 'strong';

export interface PasswordStrength {
  score: PasswordScore;
  label: PasswordStrengthLabel;
}

/** Score -> label, in order, so index === score. */
const LABELS: readonly PasswordStrengthLabel[] = ['very-weak', 'weak', 'fair', 'good', 'strong'];

/**
 * A small built-in list of very common passwords (and trivial variants). Kept
 * lowercase; the check is case-insensitive. Intentionally short (~50) — this is
 * a nudge, not a breach dictionary. If the whole password matches one of these,
 * it is capped at the weakest score regardless of length.
 */
const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  'password', 'password1', 'password123', 'passw0rd', 'p@ssword', 'p@ssw0rd',
  '12345678', '123456789', '1234567890', '123123123', '111111', '000000',
  'qwerty', 'qwerty123', 'qwertyuiop', 'qwerty12345', 'asdfghjkl', 'zxcvbnm',
  '1q2w3e4r', '1qaz2wsx', 'qazwsx', 'qazwsxedc', 'q1w2e3r4', 'abc123', 'abcd1234',
  'letmein', 'welcome', 'welcome1', 'welcome123', 'iloveyou', 'admin', 'admin123',
  'root', 'toor', 'login', 'master', 'monkey', 'dragon', 'sunshine', 'princess',
  'football', 'baseball', 'superman', 'batman', 'trustno1', 'starwars',
  'whatever', 'freedom', 'ninja', 'shadow', 'michael', 'changeme', 'secret',
]);

/** Sequences we scan for runs against (forwards and reversed). */
const SEQUENCES: readonly string[] = [
  'abcdefghijklmnopqrstuvwxyz',
  '0123456789',
  'qwertyuiop', // keyboard rows
  'asdfghjkl',
  'zxcvbnm',
];

/** True if `s` contains a straight run of length >= `runLen` from any sequence. */
function hasStraightRun(s: string, runLen: number): boolean {
  const lower = s.toLowerCase();
  for (const seq of SEQUENCES) {
    const rev = seq.split('').reverse().join('');
    for (const line of [seq, rev]) {
      for (let i = 0; i + runLen <= line.length; i++) {
        if (lower.includes(line.slice(i, i + runLen))) return true;
      }
    }
  }
  return false;
}

/** True if `s` has any character repeated `n` or more times in a row (aaaa). */
function hasLongRepeat(s: string, n: number): boolean {
  let run = 1;
  for (let i = 1; i < s.length; i++) {
    run = s[i] === s[i - 1] ? run + 1 : 1;
    if (run >= n) return true;
  }
  return false;
}

/** True if the password ends in a plausible 19xx/20xx year (weak suffix). */
function hasYearSuffix(s: string): boolean {
  return /(19|20)\d{2}$/.test(s);
}

/** Count how many distinct character classes appear (lower/upper/digit/symbol). */
function classVariety(pw: string): number {
  let n = 0;
  if (/[a-z]/.test(pw)) n++;
  if (/[A-Z]/.test(pw)) n++;
  if (/[0-9]/.test(pw)) n++;
  if (/[^a-zA-Z0-9]/.test(pw)) n++;
  return n;
}

/**
 * Estimate password strength on a 0..4 scale with a matching label.
 *
 * Deterministic and side-effect-free. Empty / very short passwords are always
 * `very-weak`; a password that IS a common password is capped at `very-weak`
 * regardless of length.
 */
export function estimatePasswordStrength(pw: string): PasswordStrength {
  // Empty or trivially short -> weakest, no further analysis.
  if (!pw || pw.length < 4) return result(0);

  // Exact common-password hit (case-insensitive) -> capped at weakest.
  if (COMMON_PASSWORDS.has(pw.toLowerCase())) return result(0);

  const len = pw.length;
  const variety = classVariety(pw);

  // --- base points from length tiers ---
  // Tiers, not raw length, keep the score coarse and predictable.
  let points = 0;
  if (len >= 8) points += 1;
  if (len >= 12) points += 1;
  if (len >= 16) points += 1;
  if (len >= 20) points += 1;

  // --- points from character-class variety ---
  if (variety >= 2) points += 1;
  if (variety >= 3) points += 1;
  if (variety >= 4) points += 1;

  // --- penalties for weak structure ---
  // A single character class (e.g. all-lowercase or all-digits) is weak even
  // when long, so cap it down.
  if (variety <= 1) points -= 2;
  // Long identical runs ("aaaa") add no entropy.
  if (hasLongRepeat(pw, 3)) points -= 1;
  // Straight sequences ("1234", "abcd", "qwer") are guessable.
  if (hasStraightRun(pw, 4)) points -= 1;
  // Trailing year is a very common, low-entropy pattern.
  if (hasYearSuffix(pw)) points -= 1;

  // Map the accumulated points onto the 0..4 scale. The thresholds are chosen so
  // that a long multi-class password ("kV9#mQ2$xL7@": len 12 => 2 length,
  // variety 4 => 3 variety = 5 points) lands on `strong`, while "password123"
  // (common hit) and short single-class strings stay low.
  let score: number;
  if (points <= 1) score = 0;
  else if (points <= 2) score = 1;
  else if (points <= 3) score = 2;
  else if (points <= 4) score = 3;
  else score = 4;

  return result(score);
}

/** Clamp a raw number to 0..4 and pair it with its label. */
function result(raw: number): PasswordStrength {
  const score = Math.max(0, Math.min(4, raw)) as PasswordScore;
  return { score, label: LABELS[score] };
}
