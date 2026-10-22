import { cn } from '@/lib/cn';
import { Select } from './Select';

/**
 * The one tax-year picker. Year-to-date, year-end close, reconciliation and
 * the contractors' year-end tab each built their own (a number input in the
 * header's primary slot, a select, a labelled number box). This is a small
 * select for the page's filter row:
 *
 *   - newest year first;
 *   - `years`: the years that have pay, when the page knows them — a year
 *     with nothing in it isn't offered;
 *   - otherwise this year and the `span - 1` years before it, never earlier
 *     than `since` (the first year the company ran payroll here);
 *   - the selected year is always in the list, so a deep link to an old
 *     year still shows what it is.
 */
export function taxYearOptions(opts: { value: number; years?: readonly number[]; since?: number; span?: number; now?: Date }): number[] {
  const thisYear = (opts.now ?? new Date()).getFullYear();
  const base =
    opts.years && opts.years.length > 0
      ? [...opts.years]
      : Array.from({ length: Math.max(1, opts.span ?? 4) }, (_, i) => thisYear - i).filter((y) => opts.since === undefined || y >= opts.since);
  return [...new Set([...base, opts.value])].sort((a, b) => b - a);
}

export function TaxYearSelect({
  value,
  onChange,
  years,
  since,
  span,
  label = 'Tax year',
  className,
}: {
  value: number;
  onChange: (year: number) => void;
  years?: readonly number[];
  since?: number;
  span?: number;
  /** Accessible name; the select shows only the year. */
  label?: string;
  className?: string;
}) {
  const options = taxYearOptions({ value, years, since, span });
  return (
    <Select size="sm" value={String(value)} onChange={(e) => onChange(Number(e.target.value))} aria-label={label} className={cn('w-24', className)}>
      {options.map((y) => (
        <option key={y} value={y}>
          {y}
        </option>
      ))}
    </Select>
  );
}
