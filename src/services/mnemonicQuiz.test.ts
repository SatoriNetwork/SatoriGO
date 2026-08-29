import { describe, expect, it } from 'vitest';
import {
  QUIZ_BANK_SIZE,
  QUIZ_BLANKS,
  buildQuiz,
  checkQuiz,
  cryptoRng,
  pickQuizPositions,
  type Rng,
} from './mnemonicQuiz';

/** A deterministic rng: replays `values` then repeats the last one. Feeding the
 *  shuffle a fixed script is what makes every assertion below exact rather than
 *  "probably". */
function scriptedRng(values: number[]): Rng {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

/** rng that always returns 0: Fisher-Yates then swaps every slot with index 0,
 *  which is a real permutation, not the identity. */
const zeroRng: Rng = () => 0;
/** rng at the very top of the range, the value a sloppy source might actually
 *  produce; the shuffle must not read past the end of the array. */
const oneRng: Rng = () => 0.999999;

const PHRASE =
  'legal winner thank year wave sausage worth useful legal winner thank yellow'.split(' ');
const DISTINCT = Array.from({ length: 12 }, (_, i) => `w${i + 1}`);
/** The classic BIP39 vector: eleven identical words plus one. The duplicate case
 *  is not exotic, it is the phrase every test in this repo already uses. */
const VECTOR = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'.split(' ');

describe('pickQuizPositions', () => {
  it('asks for three distinct, ascending, in-range positions', () => {
    for (const rng of [zeroRng, oneRng, scriptedRng([0.1, 0.9, 0.42, 0.7, 0.33, 0.05])]) {
      const positions = pickQuizPositions(12, rng);
      expect(positions).toHaveLength(QUIZ_BLANKS);
      expect(new Set(positions).size).toBe(QUIZ_BLANKS);
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
      for (const p of positions) {
        expect(p).toBeGreaterThanOrEqual(1);
        expect(p).toBeLessThanOrEqual(12);
      }
    }
  });

  it('covers every BIP39 phrase length, never running off the end', () => {
    for (const count of [12, 15, 18, 21, 24]) {
      const positions = pickQuizPositions(count, scriptedRng([0.97, 0.03, 0.55, 0.8, 0.21]));
      expect(positions).toHaveLength(QUIZ_BLANKS);
      expect(Math.max(...positions)).toBeLessThanOrEqual(count);
      expect(Math.min(...positions)).toBeGreaterThanOrEqual(1);
    }
  });

  it('actually varies: two different rng scripts ask for different words', () => {
    const a = pickQuizPositions(24, scriptedRng([0.02, 0.11, 0.23, 0.31, 0.44]));
    const b = pickQuizPositions(24, scriptedRng([0.91, 0.77, 0.63, 0.52, 0.48]));
    expect(a).not.toEqual(b);
  });

  it('never asks for more blanks than the phrase has words', () => {
    expect(pickQuizPositions(2, zeroRng)).toHaveLength(2);
    expect(pickQuizPositions(0, zeroRng)).toEqual([]);
    // A nonsense count cannot produce a position pointing at nothing.
    expect(pickQuizPositions(-3, zeroRng)).toEqual([]);
  });

  it('the production rng is in range and not constant', () => {
    const draws = Array.from({ length: 50 }, () => cryptoRng());
    for (const d of draws) {
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThan(1);
    }
    expect(new Set(draws).size).toBeGreaterThan(1);
  });
});

describe('buildQuiz', () => {
  it('offers nine uniquely addressable chips containing the three answers', () => {
    const positions = [2, 5, 11];
    const { bank, positions: out } = buildQuiz(DISTINCT, positions, scriptedRng([0.3, 0.8, 0.1, 0.6]));

    expect(out).toEqual(positions);
    expect(bank).toHaveLength(QUIZ_BANK_SIZE);
    expect(new Set(bank.map((c) => c.id)).size).toBe(QUIZ_BANK_SIZE);
    for (const p of positions) {
      expect(bank.some((c) => c.word === DISTINCT[p - 1])).toBe(true);
    }
  });

  it('draws every distractor from the SAME phrase, at positions it did not ask for', () => {
    const positions = [1, 4, 9];
    const { bank } = buildQuiz(DISTINCT, positions, scriptedRng([0.45, 0.15, 0.72]));
    const answers = positions.map((p) => DISTINCT[p - 1]);
    const distractors = bank.map((c) => c.word).filter((w) => !answers.includes(w));

    expect(distractors).toHaveLength(QUIZ_BANK_SIZE - QUIZ_BLANKS);
    for (const w of distractors) {
      // From the phrase...
      expect(DISTINCT).toContain(w);
      // ...and not one of the words being asked for.
      expect(answers).not.toContain(w);
    }
  });

  it('does not leave the answers sitting in a recognisable block', () => {
    const positions = [3, 7, 11];
    const answers = positions.map((p) => DISTINCT[p - 1]);
    const { bank } = buildQuiz(DISTINCT, positions, scriptedRng([0.62, 0.18, 0.94, 0.37, 0.5]));
    const answerSlots = bank.map((c, i) => (answers.includes(c.word) ? i : -1)).filter((i) => i >= 0);
    expect(answerSlots).toHaveLength(QUIZ_BLANKS);
    expect(answerSlots).not.toEqual([0, 1, 2]);
  });

  it('handles a phrase with REPEATED words: one chip per copy, unique ids', () => {
    // 'legal', 'winner' and 'thank' each appear twice in PHRASE, so the bank is
    // full of duplicates and the naive `id = word` would collide.
    const positions = [1, 2, 3];
    const { bank } = buildQuiz(PHRASE, positions, scriptedRng([0.25, 0.65, 0.4]));

    expect(bank).toHaveLength(QUIZ_BANK_SIZE);
    expect(new Set(bank.map((c) => c.id)).size).toBe(QUIZ_BANK_SIZE);
    // The duplicated words are suffixed; a word appearing once keeps its plain id.
    for (const c of bank) {
      const copies = bank.filter((o) => o.word === c.word).length;
      if (copies > 1) expect(c.id).toMatch(new RegExp(`^${c.word}-\\d+$`));
      else expect(c.id).toBe(c.word);
    }
  });

  it('survives the all-but-one-identical vector phrase', () => {
    const positions = pickQuizPositions(VECTOR.length, scriptedRng([0.9, 0.1, 0.5]));
    const { bank } = buildQuiz(VECTOR, positions, scriptedRng([0.2, 0.7, 0.35]));

    expect(bank).toHaveLength(QUIZ_BANK_SIZE);
    expect(new Set(bank.map((c) => c.id)).size).toBe(QUIZ_BANK_SIZE);
    // Every answer is still reachable by WORD, which is how the UI accepts them.
    for (const p of positions) {
      expect(bank.some((c) => c.word === VECTOR[p - 1])).toBe(true);
    }
  });

  it('a shorter phrase gives a smaller bank rather than undefined chips', () => {
    const short = ['alpha', 'beta', 'gamma', 'delta'];
    const { bank } = buildQuiz(short, [1, 3], zeroRng);
    expect(bank).toHaveLength(short.length);
    for (const c of bank) expect(typeof c.word).toBe('string');
  });
});

describe('checkQuiz', () => {
  const positions = [2, 5, 11];
  const answers = positions.map((p) => DISTINCT[p - 1]);

  it('accepts the phrase\'s own words, in the order they were asked', () => {
    expect(checkQuiz(DISTINCT, positions, answers)).toBe(true);
  });

  it('rejects the right words in the wrong blanks', () => {
    expect(checkQuiz(DISTINCT, positions, [answers[1], answers[0], answers[2]])).toBe(false);
  });

  it('rejects a single wrong word, a short answer set and empty slots', () => {
    expect(checkQuiz(DISTINCT, positions, [answers[0], 'w1', answers[2]])).toBe(false);
    expect(checkQuiz(DISTINCT, positions, [answers[0], answers[1]])).toBe(false);
    expect(checkQuiz(DISTINCT, positions, [answers[0], null, answers[2]])).toBe(false);
    expect(checkQuiz(DISTINCT, positions, [answers[0], undefined, answers[2]])).toBe(false);
  });

  it('forgives whitespace and case, since BIP39 words carry neither', () => {
    expect(checkQuiz(DISTINCT, positions, answers.map((w) => ` ${w.toUpperCase()} `))).toBe(true);
  });

  it('accepts any copy of a repeated word, because the chips are interchangeable', () => {
    // PHRASE[1] === PHRASE[10] === 'winner': the user tapping either chip has
    // demonstrated exactly the same knowledge.
    expect(checkQuiz(PHRASE, [2, 10], ['winner', 'winner'])).toBe(true);
    expect(checkQuiz(VECTOR, [1, 5, 9], ['abandon', 'abandon', 'abandon'])).toBe(true);
    expect(checkQuiz(VECTOR, [1, 5, 12], ['abandon', 'abandon', 'abandon'])).toBe(false);
  });

  it('never passes on an empty question set', () => {
    expect(checkQuiz(DISTINCT, [], [])).toBe(false);
  });
});
