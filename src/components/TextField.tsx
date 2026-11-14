import { useId, useState, type InputHTMLAttributes, type KeyboardEvent, type ReactNode } from 'react';
import { Eye, EyeOff } from 'lucide-react';

interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label?: string;
  error?: string;
  hint?: string;
  prefixEl?: ReactNode;
  suffixEl?: ReactNode;
  testId?: string;
}

export function TextField({
  label,
  error,
  hint,
  prefixEl,
  suffixEl,
  testId,
  className,
  ...rest
}: TextFieldProps) {
  const id = useId();
  return (
    <div className={['field', className ?? ''].filter(Boolean).join(' ')}>
      {label && <label htmlFor={id}>{label}</label>}
      <div className={`control${error ? ' invalid' : ''}`}>
        {prefixEl}
        <input id={id} data-testid={testId} aria-invalid={!!error} {...rest} />
        {suffixEl}
      </div>
      {error && <span className="error" role="alert">{error}</span>}
      {!error && hint && <span className="hint">{hint}</span>}
    </div>
  );
}

interface PasswordFieldProps extends Omit<TextFieldProps, 'type' | 'suffixEl'> {
  showLabel: string;
  hideLabel: string;
  /** Enter in this field presses the button with this data-testid (the first
   *  one of a list that is on screen). For a password that is NOT inside a
   *  <form>: the review step of a send, a claim, a dApp approval.
   *
   *  It CLICKS THE BUTTON rather than calling its handler, on purpose: whatever
   *  keeps that button disabled (the "I understand" tick not set, a send still
   *  being built, one already going out) keeps Enter from doing anything too,
   *  so the keyboard can never confirm what the mouse could not. */
  enterClicks?: string | string[];
}

/** The button Enter stands for, or null when it is absent or disabled. */
export function enterTarget(doc: Document, testIds: string | string[]): HTMLButtonElement | null {
  for (const id of Array.isArray(testIds) ? testIds : [testIds]) {
    const el = doc.querySelector(`[data-testid="${id}"]`);
    if (!el) continue;
    // The first one ON SCREEN decides, enabled or not: a disabled Confirm must
    // not let Enter fall through to some other button further down the list.
    return el instanceof HTMLButtonElement && !el.disabled ? el : null;
  }
  return null;
}

export function PasswordField({ showLabel, hideLabel, enterClicks, onKeyDown, ...rest }: PasswordFieldProps) {
  const [visible, setVisible] = useState(false);
  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(e);
    if (!enterClicks || e.defaultPrevented || e.key !== 'Enter') return;
    // A held key repeats: one press is one confirmation. An IME's Enter picks
    // a candidate, it does not submit.
    if (e.repeat || e.nativeEvent.isComposing || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
    e.preventDefault();
    enterTarget(e.currentTarget.ownerDocument, enterClicks)?.click();
  };
  return (
    <TextField
      type={visible ? 'text' : 'password'}
      autoComplete="off"
      spellCheck={false}
      autoCorrect="off"
      autoCapitalize="off"
      suffixEl={
        <button
          type="button"
          className="icon-btn"
          aria-label={visible ? hideLabel : showLabel}
          data-testid={rest.testId ? `${rest.testId}-toggle` : undefined}
          onClick={() => setVisible((v) => !v)}
        >
          {visible ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      }
      {...rest}
      onKeyDown={handleKeyDown}
    />
  );
}
