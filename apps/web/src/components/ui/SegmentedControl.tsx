import * as React from 'react';
import { cn } from '@/lib/cn';
import { filterPillClass } from './filterPill';
import { FilterCount } from './FilterBar';

export interface SegmentedControlOption<T extends string | number> {
  value: T;
  label: React.ReactNode;
  /** How many records the choice would show ("Open 3"). */
  count?: number;
}

export interface SegmentedControlProps<T extends string | number> {
  options: SegmentedControlOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Labels the radiogroup for screen readers. */
  ariaLabel?: string;
  className?: string;
}

/** Past this many characters a label may wrap onto two lines instead of forcing the row wider. */
const LONG_LABEL = 24;

/**
 * Pill-button row used for window presets, view toggles, status filters
 * — anywhere a small fixed set of mutually-exclusive choices needs to
 * sit inline next to a chart or table. Generic `T` keeps the value typed
 * end-to-end.
 *
 * Drawn with the same pill as FilterChip (one filter look across the
 * app). The row wraps and never grows past its container: on Branding ›
 * Finance two sentence-long options pushed a 390px screen 153px sideways.
 * A long label wraps inside its pill rather than widening the row.
 */
export function SegmentedControl<T extends string | number>({
  options,
  value,
  onChange,
  ariaLabel,
  className,
}: SegmentedControlProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn('inline-flex max-w-full flex-wrap items-center gap-1.5', className)}
    >
      {options.map((opt) => {
        const selected = opt.value === value;
        const long = typeof opt.label === 'string' && opt.label.length > LONG_LABEL;
        return (
          <button
            key={String(opt.value)}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(opt.value)}
            className={filterPillClass(
              selected,
              long ? 'h-auto min-h-8 max-w-full whitespace-normal py-1 text-left leading-snug' : 'whitespace-nowrap',
            )}
          >
            {opt.label}
            {opt.count != null && ' '}
            {opt.count != null && <FilterCount value={opt.count} />}
          </button>
        );
      })}
    </div>
  );
}
