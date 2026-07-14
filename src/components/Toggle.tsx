interface ToggleProps {
  checked: boolean;
  onChange(checked: boolean): void;
  label: string;
  disabled?: boolean;
  testId?: string;
}

export function Toggle({ checked, onChange, label, disabled, testId }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="toggle"
      disabled={disabled}
      data-testid={testId}
      onClick={() => onChange(!checked)}
    />
  );
}
