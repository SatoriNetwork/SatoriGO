/**
 * The recovery-phrase confirmation quiz, shown once right after a wallet is
 * CREATED (never on import, where the user already holds the phrase).
 *
 * Showing the twelve words and taking "I saved it" on trust proves nothing: the
 * single most common way a self-custody wallet loses funds is a phrase that was
 * never actually written down. So the create flow asks for three of the words
 * back, at positions the user cannot predict, before the wallet opens.
 *
 * Two deliberate choices about how hard this is:
 *
 *   - the distractor chips come from the SAME phrase, at other positions. Words
 *     pulled from the wider BIP39 list would make the quiz answerable by
 *     recognition alone ("I remember seeing that one"); words the user has just
 *     seen force them to read what they wrote down and pay attention to the
 *     POSITION, which is the part a hurried backup gets wrong.
 *
 *   - it is a chip picker, not three text inputs. Typing invites typos, and a
 *     typo here would read as "your backup is wrong" about a backup that is
 *     fine, which teaches the user to distrust the check rather than the copy.
 *
 * All of the logic lives here, pure and rng-injectable, so the positions being
 * distinct/ascending/in-range and the bank being complete are pinned by tests
 * rather than by squinting at a rendered screen.
 */

/** A source of randomness in [0, 1), same shape as Math.random. Injected so the
 *  tests are deterministic; production passes crypto-grade bits. */
export type Rng = () => number;

/** One chip in the word bank. */
export interface QuizChoice {
  /**
   * Unique WITHIN the bank, so a phrase containing the same word twice still
   * gets one addressable chip per copy (BIP39 permits repeats, and the classic
   * test vector is eleven "abandon"s). Equal to `word` when that word appears
   * once, otherwise `word-<n>`. Answers are always compared by `word`, never by
   * this id: any chip carrying the right word is the right answer.
   */
  id: string;
  word: string;
}

export interface Quiz {
  /** 1-based word positions to ask for, distinct and ascending. */
  positions: number[];
  /** Shuffled chips: the answers plus distractors from the same phrase. */
  bank: QuizChoice[];
}

/** How many words the user has to place. Three is MetaMask parity, and enough
 *  that guessing from a nine-chip bank is a 1-in-504 shot. */
export const QUIZ_BLANKS = 3;

/** Chips offered: the 3 answers plus 6 distractors. */
export const QUIZ_BANK_SIZE = 9;

/** Crypto-grade replacement for Math.random, in [0, 1). The positions decide
 *  what the user is asked, so they must not come from a predictable PRNG. */
export function cryptoRng(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] / 2 ** 32;
}

/** Fisher-Yates, on a copy. Clamped because an injected rng in a test is allowed
 *  to be sloppy (return exactly 1, say) without producing a hole in the array. */
function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.max(0, Math.floor(rng() * (i + 1))));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

/**
 * Three distinct 1-based positions inside a phrase of `wordCount` words,
 * returned in ascending order so the blanks read left to right the way the
 * phrase does. Shorter phrases than QUIZ_BLANKS (never a real BIP39 phrase, but
 * reachable from a test or a corrupt store) simply ask for every word they have
 * rather than looping forever looking for a fourth.
 */
export function pickQuizPositions(wordCount: number, rng: Rng = cryptoRng): number[] {
  const total = Math.max(0, Math.floor(wordCount));
  const all = Array.from({ length: total }, (_, i) => i + 1);
  return shuffle(all, rng)
    .slice(0, Math.min(QUIZ_BLANKS, total))
    .sort((a, b) => a - b);
}

/** Give every chip an id that is unique inside the bank (see QuizChoice.id). */
function withIds(words: readonly string[]): QuizChoice[] {
  const totals = new Map<string, number>();
  for (const w of words) totals.set(w, (totals.get(w) ?? 0) + 1);
  const seen = new Map<string, number>();
  return words.map((word) => {
    const n = (seen.get(word) ?? 0) + 1;
    seen.set(word, n);
    return { id: (totals.get(word) ?? 0) > 1 ? `${word}-${n}` : word, word };
  });
}

/**
 * The quiz for `positions` of `words`: the correct words plus distractors drawn
 * from the phrase's OTHER positions, all shuffled together so the answers do not
 * sit in a recognisable block.
 */
export function buildQuiz(
  words: readonly string[],
  positions: readonly number[],
  rng: Rng = cryptoRng,
): Quiz {
  const asked = new Set(positions);
  const answers = positions
    .map((p) => words[p - 1])
    .filter((w): w is string => typeof w === 'string');
  const otherPositions = words.map((_, i) => i + 1).filter((p) => !asked.has(p));
  const distractors = shuffle(otherPositions, rng)
    .slice(0, Math.max(0, QUIZ_BANK_SIZE - answers.length))
    .map((p) => words[p - 1]);
  return {
    positions: [...positions],
    bank: withIds(shuffle([...answers, ...distractors], rng)),
  };
}

/**
 * Whether `answers` (one word per asked position, in the same order) is the
 * phrase's own. Compared case-insensitively and trimmed: BIP39 words are
 * lowercase already, so this only ever forgives whitespace the UI introduced,
 * never a genuinely different word. A missing answer is always wrong.
 */
export function checkQuiz(
  words: readonly string[],
  positions: readonly number[],
  answers: readonly (string | null | undefined)[],
): boolean {
  if (answers.length !== positions.length || positions.length === 0) return false;
  return positions.every((p, i) => {
    const expected = words[p - 1];
    const given = answers[i];
    if (typeof expected !== 'string' || typeof given !== 'string') return false;
    return given.trim().toLowerCase() === expected.trim().toLowerCase();
  });
}
