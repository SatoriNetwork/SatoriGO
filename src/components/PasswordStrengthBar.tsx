import { estimatePasswordStrength, type PasswordStrengthLabel } from '../services/passwordStrength';

// A slim, advisory password-strength indicator: a 4-segment bar plus a text
// label under a password field. It is purely informational — it never blocks
// submission and does not change any validation rule.
//
// The live wallet surface is English-only (its screens use hardcoded strings,
// not the i18n translator), so the human-readable labels are inlined here to
// match that style. Parallel keys live in src/i18n/{en,pl}.ts for consistency.

/** Display text for each strength label (English; live surface is English-only). */
const LABEL_TEXT: Record<PasswordStrengthLabel, string> = {
  'very-weak': 'Very weak',
  weak: 'Weak',
  fair: 'Fair',
  good: 'Good',
  strong: 'Strong',
};

/** Bar/label colour per score, drawn from the existing theme CSS variables. */
const SCORE_COLOR: readonly string[] = [
  'var(--danger)', // 0 very-weak
  'var(--danger)', // 1 weak
  'var(--warning)', // 2 fair
  'var(--accent)', // 3 good
  'var(--success)', // 4 strong
];

const SEGMENTS = 4;

export function PasswordStrengthBar({ password }: { password: string }) {
  // Nothing to show for an empty field — keep the form uncluttered.
  if (!password) return null;

  const { score, label } = estimatePasswordStrength(password);
  const color = SCORE_COLOR[score];
  // score 0..4 maps to 1..4 filled segments (an entered-but-very-weak password
  // still shows one red segment so the meter is visibly "on").
  const filled = Math.max(1, score);

  return (
    <div
      data-testid="password-strength"
      data-score={score}
      aria-hidden="true"
      style={{ margin: '6px 0 2px' }}
    >
      <div style={{ display: 'flex', gap: 4 }}>
        {Array.from({ length: SEGMENTS }, (_, i) => (
          <span
            key={i}
            style={{
              flex: 1,
              height: 4,
              borderRadius: 2,
              background: i < filled ? color : 'var(--border-strong)',
              transition: 'background 0.18s',
            }}
          />
        ))}
      </div>
      <span
        style={{
          display: 'block',
          fontSize: 11,
          fontWeight: 600,
          color,
          marginTop: 4,
        }}
      >
        Password strength: {LABEL_TEXT[label]}
      </span>
    </div>
  );
}
