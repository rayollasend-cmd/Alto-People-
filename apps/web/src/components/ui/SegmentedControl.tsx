import * as React from 'react';
import { cn } from '@/lib/cn';

export interface SegmentedControlOption<T extends string | number> {
  value: T;
  label: React.ReactNode;
}

export interface SegmentedControlProps<T extends string | number> {
  options: SegmentedControlOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Labels the radiogroup for screen readers. */
  ariaLabel?: string;
  className?: string;
}

/**
 * Pill-button row used for window presets, view toggles, status filters
 * — anywhere a small fixed set of mutually-exclusive choices needs to
 * sit inline next to a chart or table. Generic `T` keeps the value typed
 * end-to-end.
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
      className={cn('inline-flex items-center gap-1.5', className)}
    >
      {options.map((opt) => {
        const selected = opt.value === value;
        return (
          <button
            key={String(opt.value)}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(opt.value)}
            className={cn(
              'px-3 py-1 rounded-full border text-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/40',
              selected
                ? 'bg-steel border-steel text-white'
                : 'bg-navy-secondary/40 border-navy-secondary text-silver hover:text-white',
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
