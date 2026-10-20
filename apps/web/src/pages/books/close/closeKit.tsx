import { useQuery } from '@tanstack/react-query';
import type { ClosePeriodStatus } from '@alto-people/shared';
import { listAccountOptions, type BooksAccountOption } from '@/lib/books/closeApi';
import { fmtMonthShortYear } from '@/lib/format';
import { Badge } from '@/components/ui/Badge';
import { Select } from '@/components/ui/Select';

/** Shared bits for the month-end close pages. */

export function CloseStatusBadge({ status, ended, size }: { status: ClosePeriodStatus; ended: boolean; size?: 'sm' | 'default' | 'lg' }) {
  if (status === 'CLOSED') return <Badge variant="success" size={size}>Closed</Badge>;
  if (status === 'READY') return <Badge variant="accent" size={size}>Ready to sign off</Badge>;
  if (!ended) return <Badge variant="default" size={size}>In progress</Badge>;
  return <Badge variant="pending" size={size}>Open</Badge>;
}

export const pct = (done: number, total: number) => (total ? Math.round((done / total) * 100) : 0);

/** "2026-09" → "Sep 2026". */
export function shortMonth(periodKey: string): string {
  // Mid-month, midday: no display time zone moves it into the next or last month.
  return fmtMonthShortYear(`${periodKey}-15T12:00:00.000Z`);
}

/** The chart of accounts, for pickers (shared cache with the ledger pages). */
export function useAccountOptions() {
  return useQuery({ queryKey: ['books', 'accounts', 'options'], queryFn: listAccountOptions, staleTime: 5 * 60_000 });
}

/** An account picker over the chart, filtered by type (and optionally subtype). */
export function AccountSelect({
  value,
  onChange,
  types,
  subtypes,
  placeholder = 'Choose an account…',
  ...rest
}: {
  value: string;
  onChange: (id: string) => void;
  types?: string[];
  subtypes?: string[];
  placeholder?: string;
  id?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
}) {
  const q = useAccountOptions();
  const options = (q.data?.accounts ?? []).filter(
    (a: BooksAccountOption) => a.isActive !== false && (!types || types.includes(a.type)) && (!subtypes || subtypes.includes(a.subtype)),
  );
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} disabled={q.isLoading} {...rest}>
      <option value="">{q.isLoading ? 'Loading accounts…' : placeholder}</option>
      {options.map((a) => (
        <option key={a.id} value={a.id}>
          {a.code} {a.name}
        </option>
      ))}
    </Select>
  );
}

/** The account a systemKey names, once the chart has loaded. */
export function accountIdForKey(accounts: BooksAccountOption[] | undefined, key: string): string {
  return accounts?.find((a) => a.systemKey === key)?.id ?? '';
}
