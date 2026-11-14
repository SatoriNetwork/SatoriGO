// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PasswordField } from './TextField';

afterEach(cleanup);

function Screen({ onConfirm, disabled = false, onOther }: { onConfirm: () => void; disabled?: boolean; onOther?: () => void }) {
  return (
    <div>
      <PasswordField
        label="Password"
        showLabel="Show"
        hideLabel="Hide"
        testId="pw"
        enterClicks={onOther ? ['confirm', 'other'] : 'confirm'}
        defaultValue="x"
      />
      <button type="button" data-testid="confirm" disabled={disabled} onClick={onConfirm}>
        Confirm
      </button>
      {onOther && (
        <button type="button" data-testid="other" onClick={onOther}>
          Other
        </button>
      )}
    </div>
  );
}

describe('PasswordField enterClicks', () => {
  it('Enter presses the named button once', () => {
    const onConfirm = vi.fn();
    render(<Screen onConfirm={onConfirm} />);
    fireEvent.keyDown(screen.getByTestId('pw'), { key: 'Enter' });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('does nothing while the button is disabled: the keyboard cannot confirm what the mouse cannot', () => {
    const onConfirm = vi.fn();
    render(<Screen onConfirm={onConfirm} disabled />);
    fireEvent.keyDown(screen.getByTestId('pw'), { key: 'Enter' });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('a disabled first button does not let Enter fall through to the next one in the list', () => {
    const onConfirm = vi.fn();
    const onOther = vi.fn();
    render(<Screen onConfirm={onConfirm} onOther={onOther} disabled />);
    fireEvent.keyDown(screen.getByTestId('pw'), { key: 'Enter' });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOther).not.toHaveBeenCalled();
  });

  it('a held Enter, an IME Enter and Enter with a modifier are ignored; other keys too', () => {
    const onConfirm = vi.fn();
    render(<Screen onConfirm={onConfirm} />);
    const pw = screen.getByTestId('pw');
    fireEvent.keyDown(pw, { key: 'Enter', repeat: true });
    fireEvent.keyDown(pw, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(pw, { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(pw, { key: 'Enter', ctrlKey: true });
    fireEvent.keyDown(pw, { key: 'a' });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('without enterClicks Enter is left alone (a field inside a form submits the form itself)', () => {
    const onSubmit = vi.fn((e: { preventDefault(): void }) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <PasswordField label="Password" showLabel="Show" hideLabel="Hide" testId="pw2" />
      </form>,
    );
    const notPrevented = fireEvent.keyDown(screen.getByTestId('pw2'), { key: 'Enter' });
    expect(notPrevented).toBe(true);
  });
});
