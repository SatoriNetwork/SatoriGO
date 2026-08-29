/**
 * @vitest-environment jsdom
 *
 * The recovery-phrase confirmation step on a NEWLY CREATED wallet.
 *
 * The screen this guards is the last moment a phrase that was never written
 * down can still be caught: after it, the words are gone for good. So what these
 * assert is not "the quiz renders" but the three ways it could quietly stop
 * being a check at all:
 *
 *   - the words staying on screen while it is asked (then it is a copying
 *     exercise, not a backup check),
 *   - a wrong answer being waved through (then it is theatre), and
 *   - the answers being predictable, i.e. always the same positions.
 *
 * Plus the one thing it must NOT do: appear on IMPORT, where the user already
 * holds the phrase and being quizzed on it is pure friction.
 *
 * The store's actions are spies, so this is about what the SCREEN does; the
 * quiz's own arithmetic is pinned in services/mnemonicQuiz.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../services/chain/liveWallet', () => {
  class BroadcastGatedError extends Error {}
  class LiveWalletService {
    async exists() {
      return false;
    }
    async listWallets() {
      return [];
    }
    activeWalletId() {
      return null;
    }
    isUnlocked() {
      return false;
    }
    activeWalletFamily() {
      return 'utxo';
    }
    evmChainKey() {
      return null;
    }
    getProvider() {
      return {};
    }
    lock() {}
  }
  return { LiveWalletService, BroadcastGatedError };
});

import { LiveOnboarding } from './LiveOnboarding';
import { useLiveStore } from '../../store/liveStore';
import { MemoryStorageAdapter, setStorageForTests } from '../../services/storage';

/** Twelve distinct words, so "the right word in the wrong blank" is a case that
 *  can actually be constructed. Not a valid BIP39 phrase, and it does not need
 *  to be: nothing here derives a key. */
const PHRASE =
  'ripple canvas hazard puppet velvet orbit tundra marble kettle jigsaw lantern quiver';
/** The classic vector: eleven identical words. Its quiz is nine chips reading
 *  "abandon" eight times, which is exactly where an id-per-word design breaks. */
const VECTOR =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

let clearSpy: ReturnType<typeof vi.fn>;
let importSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  setStorageForTests(new MemoryStorageAdapter());
  clearSpy = vi.fn();
  importSpy = vi.fn(async () => {});
  useLiveStore.setState({
    clearPendingMnemonic: clearSpy,
    importWallet: importSpy,
    pendingMnemonic: null,
    pendingMnemonicHasPassphrase: false,
    addingWallet: false,
    error: null,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function byId(id: string): HTMLElement {
  return screen.getByTestId(id);
}

/** Render the backup screen for a freshly created wallet. */
function showPhrase(mnemonic = PHRASE) {
  useLiveStore.setState({ pendingMnemonic: mnemonic, pendingMnemonicHasPassphrase: false });
  render(<LiveOnboarding />);
}

/** The phrase as the SCREEN shows it, ordered by the position label. */
function renderedWords(): string[] {
  return screen
    .getAllByTestId(/^live-mnemonic-word-/)
    .map((el) => [Number(el.dataset.testid?.replace('live-mnemonic-word-', '')), el.textContent ?? ''] as const)
    .sort((a, b) => a[0] - b[0])
    .map(([, word]) => word);
}

/** "I saved it" + Continue, which is what opens the quiz. */
function continueToQuiz() {
  fireEvent.click(byId('live-mnemonic-saved'));
  fireEvent.click(screen.getByRole('button', { name: /I saved it, continue to wallet/i }));
}

/** The 1-based positions the quiz is asking for, in the order the blanks sit. */
function askedPositions(): number[] {
  return screen
    .getAllByTestId(/^live-mnemonic-slot-/)
    .map((el) => Number(el.dataset.testid?.replace('live-mnemonic-slot-', '')));
}

function slot(position: number): HTMLElement {
  return byId(`live-mnemonic-slot-${position}`);
}

function chips(): HTMLButtonElement[] {
  return screen.getAllByTestId(/^live-mnemonic-choice-/) as HTMLButtonElement[];
}

/** Tap the first chip still in the bank that carries `word`. */
function tapWord(word: string) {
  const chip = chips().find((el) => el.textContent === word && !el.disabled);
  expect(chip, `no chip left in the bank for "${word}"`).toBeTruthy();
  fireEvent.click(chip!);
}

/** Fill the blanks with `words`, left to right. */
function answer(words: string[]) {
  for (const w of words) tapWord(w);
}

describe('recovery-phrase quiz: getting to it', () => {
  it('is what "I saved it, continue to wallet" now opens, instead of the wallet', () => {
    showPhrase();
    expect(screen.queryByTestId('live-mnemonic-verify')).toBeNull();

    continueToQuiz();

    expect(byId('live-mnemonic-verify')).toBeTruthy();
    expect(clearSpy).not.toHaveBeenCalled();
  });

  it('still refuses to move on until the "I saved it" box is ticked', () => {
    // The old acknowledgement is kept: the quiz is an addition to it, not a
    // replacement for the promise the user makes.
    showPhrase();
    const cont = screen.getByRole('button', { name: /I saved it, continue to wallet/i });
    expect(cont).toBeDisabled();
    expect(byId('live-mnemonic-saved')).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(byId('live-mnemonic-saved'));
    expect(cont).not.toBeDisabled();
  });

  it('HIDES the words while it asks for them', () => {
    // The whole point. With the grid still on screen this checks nothing but
    // the user's ability to read.
    showPhrase();
    expect(byId('live-mnemonic')).toBeTruthy();

    continueToQuiz();

    expect(screen.queryByTestId('live-mnemonic')).toBeNull();
    expect(screen.queryAllByTestId(/^live-mnemonic-word-/)).toHaveLength(0);
  });

  it('"Back to the phrase" shows the words again and keeps asking the same words', () => {
    // Re-rolling the positions on every visit would read as the wallet moving
    // the goalposts while the user is trying to comply.
    showPhrase();
    continueToQuiz();
    const first = askedPositions();

    fireEvent.click(byId('live-mnemonic-verify-back'));
    expect(byId('live-mnemonic')).toBeTruthy();
    expect(screen.queryByTestId('live-mnemonic-verify')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /I saved it, continue to wallet/i }));
    expect(askedPositions()).toEqual(first);
  });
});

describe('recovery-phrase quiz: what it asks', () => {
  it('asks for three distinct, ascending positions of the phrase', () => {
    showPhrase();
    const words = renderedWords();
    expect(words).toEqual(PHRASE.split(' '));

    continueToQuiz();
    const positions = askedPositions();

    expect(positions).toHaveLength(3);
    expect(new Set(positions).size).toBe(3);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    for (const p of positions) {
      expect(p).toBeGreaterThanOrEqual(1);
      expect(p).toBeLessThanOrEqual(12);
    }
  });

  it('offers nine chips, all from this phrase, including the three answers', () => {
    showPhrase();
    const words = renderedWords();
    continueToQuiz();
    const positions = askedPositions();

    expect(chips()).toHaveLength(9);
    for (const chip of chips()) expect(words).toContain(chip.textContent);
    for (const p of positions) {
      expect(chips().some((c) => c.textContent === words[p - 1])).toBe(true);
    }
  });

  it('does not ask the same thing twice: two wallets get different blanks', () => {
    // Fixed positions would be learnable, and a phrase nobody wrote down would
    // sail through on the second wallet. Over ten draws from C(12,3) = 220 the
    // odds of a genuine all-identical run are far below flake territory.
    const seen = new Set<string>();
    for (let i = 0; i < 10; i++) {
      showPhrase();
      continueToQuiz();
      seen.add(askedPositions().join(','));
      cleanup();
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('recovery-phrase quiz: answering it', () => {
  it('a correct answer continues into the wallet', () => {
    showPhrase();
    const words = renderedWords();
    continueToQuiz();
    const positions = askedPositions();

    expect(byId('live-mnemonic-verify-submit')).toBeDisabled();
    answer(positions.map((p) => words[p - 1]));

    expect(byId('live-mnemonic-verify-submit')).not.toBeDisabled();
    fireEvent.click(byId('live-mnemonic-verify-submit'));
    expect(clearSpy).toHaveBeenCalledTimes(1);
  });

  it('a WRONG answer is refused, says so, and clears the blanks', () => {
    // The assertion this file exists for.
    showPhrase();
    const words = renderedWords();
    continueToQuiz();
    const positions = askedPositions();
    const right = positions.map((p) => words[p - 1]);
    // The right words in the wrong blanks: position is part of the answer.
    answer([right[1], right[2], right[0]]);
    fireEvent.click(byId('live-mnemonic-verify-submit'));

    expect(clearSpy).not.toHaveBeenCalled();
    expect(byId('live-mnemonic-verify-error').textContent).toBe(
      'Those are not the right words. Check your backup and try again.',
    );
    for (const p of positions) expect(slot(p).textContent).toBe('');
    expect(byId('live-mnemonic-verify-submit')).toBeDisabled();
    // Every chip is back in the bank, so a retry is possible.
    expect(chips().filter((c) => c.disabled)).toHaveLength(0);
  });

  it('lets the user recover: answer correctly after a miss and the error goes', () => {
    showPhrase();
    const words = renderedWords();
    continueToQuiz();
    const positions = askedPositions();
    const right = positions.map((p) => words[p - 1]);

    answer([right[1], right[2], right[0]]);
    fireEvent.click(byId('live-mnemonic-verify-submit'));
    expect(byId('live-mnemonic-verify-error')).toBeTruthy();

    answer(right);
    // Placing a chip already clears the complaint, before submitting again.
    expect(screen.queryByTestId('live-mnemonic-verify-error')).toBeNull();
    fireEvent.click(byId('live-mnemonic-verify-submit'));
    expect(clearSpy).toHaveBeenCalledTimes(1);
  });

  it('a chip fills the next empty blank and leaves the bank; a tapped blank gives it back', () => {
    showPhrase();
    const words = renderedWords();
    continueToQuiz();
    const positions = askedPositions();

    tapWord(words[positions[0] - 1]);
    expect(slot(positions[0]).textContent).toBe(words[positions[0] - 1]);
    expect(slot(positions[1]).textContent).toBe('');
    expect(chips().filter((c) => c.disabled)).toHaveLength(1);

    tapWord(words[positions[1] - 1]);
    expect(slot(positions[1]).textContent).toBe(words[positions[1] - 1]);

    fireEvent.click(slot(positions[0]));
    expect(slot(positions[0]).textContent).toBe('');
    // ...and the freed chip is usable again, so the next tap refills that blank.
    expect(chips().filter((c) => c.disabled)).toHaveLength(1);
    tapWord(words[positions[0] - 1]);
    expect(slot(positions[0]).textContent).toBe(words[positions[0] - 1]);
  });

  it('works on a phrase full of REPEATED words, where any copy is the right one', () => {
    // Eleven "abandon"s: the chips are near-indistinguishable, so the screen must
    // accept them by word rather than by which chip was tapped.
    showPhrase(VECTOR);
    const words = renderedWords();
    continueToQuiz();
    const positions = askedPositions();

    expect(chips()).toHaveLength(9);
    answer(positions.map((p) => words[p - 1]));
    fireEvent.click(byId('live-mnemonic-verify-submit'));
    expect(clearSpy).toHaveBeenCalledTimes(1);
  });
});

describe('recovery-phrase quiz: where it must NOT appear', () => {
  it('IMPORT never shows the phrase screen or the quiz', () => {
    // The user typed the phrase in; quizzing them on what they just pasted is
    // friction with nothing behind it.
    render(<LiveOnboarding />);
    fireEvent.click(screen.getByText('Import recovery phrase'));
    fireEvent.change(byId('live-import-input'), { target: { value: PHRASE } });
    fireEvent.change(byId('live-password'), { target: { value: 'password123' } });
    fireEvent.change(byId('live-password-confirm'), { target: { value: 'password123' } });
    fireEvent.click(byId('live-import-submit'));

    expect(importSpy).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('live-mnemonic')).toBeNull();
    expect(screen.queryByTestId('live-mnemonic-verify')).toBeNull();
  });
});
