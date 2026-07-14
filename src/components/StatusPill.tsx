import type { NetworkState } from '../types/domain';
import { useT } from '../i18n/useT';

interface StatusPillProps {
  state: NetworkState;
  label?: string;
  onClick?(): void;
  testId?: string;
}

export function StatusPill({ state, label, onClick, testId }: StatusPillProps) {
  const t = useT();
  const text = label ?? t(`network.${state}`);
  const content = (
    <>
      <span className="dot" aria-hidden />
      {text}
    </>
  );
  if (onClick) {
    return (
      <button type="button" className={`pill state-${state}`} onClick={onClick} data-testid={testId}>
        {content}
      </button>
    );
  }
  return (
    <span className={`pill state-${state}`} data-testid={testId}>
      {content}
    </span>
  );
}
