import { useId, useState, type InputHTMLAttributes, type ReactNode } from 'react';
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
}

export function PasswordField({ showLabel, hideLabel, ...rest }: PasswordFieldProps) {
  const [visible, setVisible] = useState(false);
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
    />
  );
}
