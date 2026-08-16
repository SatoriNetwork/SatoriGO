import type { ReactNode } from 'react';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
}

interface SegmentedProps<T extends string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange(value: T): void;
  testIdPrefix?: string;
  /**
   * Lay the options out as a wrapping grid instead of one equal-width row.
   *
   * The default row divides the width by the option count, which stops working
   * once there are more than about three: at six options each cell is roughly
   * 57px in a 400px popup and the longer labels spill past the edge. Opt into
   * this for a control whose option count grows over time.
   */
  wrap?: boolean;
}

export function Segmented<T extends string>({ options, value, onChange, testIdPrefix, wrap = false }: SegmentedProps<T>) {
  return (
    <div className={wrap ? 'seg seg-wrap' : 'seg'} role="group">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          data-testid={testIdPrefix ? `${testIdPrefix}-${option.value}` : undefined}
          onClick={() => onChange(option.value)}
        >
          {option.icon}
          {option.label}
        </button>
      ))}
    </div>
  );
}
