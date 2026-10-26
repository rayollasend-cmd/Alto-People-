import * as React from 'react';
import { CalendarDays } from '@/components/ui/icons';
import { fmtDateOnly, fmtDateOnlyRange } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/cn';

/**
 * A date, said the app's way ("Oct 24", "Jan 31, 2027"), picked with the
 * device's own calendar. The browser's date box printed "10/24/2026" or
 * "mm/dd/yyyy" beside headings that read "Oct 24 – 26, 2026" (F500 audit
 * 2026-10-26); this shows the formatted day and opens the native picker on
 * a tap or click — on a phone that is the wheel the person already knows.
 *
 * The real <input type="date"> sits over the field, invisible, so a tap
 * reaches it on every platform (iOS opens a date input only from a direct
 * tap) and forms, labels and tests see an ordinary date input. Values are
 * "YYYY-MM-DD" strings, as with the native input.
 */
export interface DateFieldProps {
  value: string;
  onChange: (value: string) => void;
  /** The accessible name — a visible label elsewhere should use htmlFor={id}. */
  'aria-label'?: string;
  id?: string;
  min?: string;
  max?: string;
  /** Shown when there is no value. */
  placeholder?: string;
  size?: 'sm' | 'md';
  disabled?: boolean;
  required?: boolean;
  /** An empty value is allowed (a filter's open end). */
  clearable?: boolean;
  className?: string;
  'data-testid'?: string;
}

const FIELD = 'relative inline-flex items-center gap-2 rounded-md border border-navy-secondary bg-navy-secondary/40 text-white transition-colors hover:border-silver/40 focus-within:border-gold focus-within:ring-2 focus-within:ring-gold/40';

export const DateField = React.forwardRef<HTMLInputElement, DateFieldProps>(function DateField(
  { value, onChange, id, min, max, placeholder, size = 'md', disabled, required, clearable = true, className, ...rest },
  ref,
) {
  const { t } = useI18n();
  const label = value ? fmtDateOnly(value, { year: 'auto' }) : (placeholder ?? t('common.pickDate'));
  return (
    <span
      className={cn(
        FIELD,
        size === 'sm' ? 'h-8 px-2.5 text-xs coarse:h-10 coarse:text-base' : 'h-10 px-3 text-sm coarse:h-11 coarse:text-base',
        disabled && 'cursor-not-allowed opacity-50',
        className,
      )}
    >
      <CalendarDays className="h-4 w-4 shrink-0 text-silver" aria-hidden="true" />
      <span className={cn('whitespace-nowrap tabular-nums', !value && 'text-silver')} aria-hidden="true">
        {label}
      </span>
      <input
        ref={ref}
        id={id}
        type="date"
        value={value}
        min={min}
        max={max}
        disabled={disabled}
        required={required || !clearable}
        aria-label={rest['aria-label']}
        data-testid={rest['data-testid']}
        onChange={(e) => {
          if (!e.target.value && !clearable) return;
          onChange(e.target.value);
        }}
        // A click anywhere opens the calendar, not just on the browser's own icon.
        onClick={(e) => {
          try {
            e.currentTarget.showPicker?.();
          } catch {
            /* older browsers: the input's own behaviour */
          }
        }}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
      />
    </span>
  );
});

/**
 * A from–to range as two fields that read as one ("Oct 24 → Oct 26"), the
 * pair a filter bar needs. The "to" can't be set before the "from".
 */
export function DateRangeField({
  from,
  to,
  onChange,
  fromLabel,
  toLabel,
  size = 'md',
  className,
  min,
  max,
}: {
  from: string;
  to: string;
  onChange: (range: { from: string; to: string }) => void;
  fromLabel?: string;
  toLabel?: string;
  size?: 'sm' | 'md';
  className?: string;
  min?: string;
  max?: string;
}) {
  const { t } = useI18n();
  const fromName = fromLabel ?? t('common.from');
  const toName = toLabel ?? t('common.to');
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-1.5', className)} role="group" aria-label={from && to ? fmtDateOnlyRange(from, to) : `${fromName} – ${toName}`}>
      <DateField size={size} value={from} aria-label={fromName} min={min} max={to || max} onChange={(v) => onChange({ from: v, to: to && v && to < v ? v : to })} />
      <span className="text-silver" aria-hidden="true">
        –
      </span>
      <DateField size={size} value={to} aria-label={toName} min={from || min} max={max} onChange={(v) => onChange({ from, to: v })} />
    </span>
  );
}
