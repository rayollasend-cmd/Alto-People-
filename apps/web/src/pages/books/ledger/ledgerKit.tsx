import { useQuery } from '@tanstack/react-query';
import { LEDGER_TYPE_LABELS, LEDGER_ACCOUNT_TYPES, JOURNAL_SOURCE_LABELS, type BooksDimensionsFilter, type LedgerAccountRow } from '@alto-people/shared';
import { getBooksDimensions, listLedgerAccounts } from '@/lib/books/ledgerApi';
import { fmtMoney, ymdLocal } from '@/lib/format';
import { Select } from '@/components/ui/Select';
import { cn } from '@/lib/cn';

/** Small shared pieces for the ledger and statements pages. */

export const ACCOUNTS_KEY = ['books', 'accounts'] as const;
export const DIMENSIONS_KEY = ['books', 'dimensions'] as const;

export function useLedgerAccounts() {
  return useQuery({ queryKey: ACCOUNTS_KEY, queryFn: () => listLedgerAccounts(), staleTime: 60_000 });
}

export function useBooksDimensions() {
  return useQuery({ queryKey: DIMENSIONS_KEY, queryFn: getBooksDimensions, staleTime: 5 * 60_000 });
}

export const sourceLabel = (s: string) => JOURNAL_SOURCE_LABELS[s] ?? s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');

/** An amount in a table: tabular, a negative in red with a true minus. */
export function Amount({ value, strong, blankZero, className }: { value: number | null | undefined; strong?: boolean; blankZero?: boolean; className?: string }) {
  if (value == null || (blankZero && Math.abs(value) < 0.005)) return <span className={cn('tabular-nums text-ink-muted', className)}>—</span>;
  return <span className={cn('tabular-nums', value < 0 && 'text-alert', strong && 'font-semibold text-ink', className)}>{fmtMoney(value)}</span>;
}

/** Calendar helpers for the default ranges. */
export function yearStart(d = ymdLocal()): string {
  return `${d.slice(0, 4)}-01-01`;
}
export function monthStart(d = ymdLocal()): string {
  return `${d.slice(0, 7)}-01`;
}
export function monthEnd(key: string): string {
  const [y, m] = key.slice(0, 7).split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${key.slice(0, 7)}-${String(last).padStart(2, '0')}`;
}
export function lastMonthKey(d = ymdLocal()): string {
  const [y, m] = d.split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/** Client / site / department pickers in one row; empty means "the whole company". */
export function DimensionFilters({ value, onChange, className }: { value: BooksDimensionsFilter; onChange: (v: BooksDimensionsFilter) => void; className?: string }) {
  const dims = useBooksDimensions();
  const d = dims.data;
  const set = (k: keyof BooksDimensionsFilter, v: string) => onChange({ ...value, [k]: v || undefined });
  return (
    <div className={cn('flex flex-wrap items-end gap-2', className)}>
      {(d?.clients.length ?? 0) > 0 && (
        <label className="flex flex-col gap-1 text-xs text-ink-muted">
          Client
          <Select aria-label="Client" value={value.clientId ?? ''} onChange={(e) => set('clientId', e.target.value)} className="min-w-40">
            <option value="">All clients</option>
            {d!.clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </label>
      )}
      {(d?.sites.length ?? 0) > 0 && (
        <label className="flex flex-col gap-1 text-xs text-ink-muted">
          Site
          <Select aria-label="Site" value={value.siteId ?? ''} onChange={(e) => set('siteId', e.target.value)} className="min-w-36">
            <option value="">All sites</option>
            {d!.sites.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </label>
      )}
      {(d?.departments.length ?? 0) > 0 && (
        <label className="flex flex-col gap-1 text-xs text-ink-muted">
          Department
          <Select aria-label="Department" value={value.departmentId ?? ''} onChange={(e) => set('departmentId', e.target.value)} className="min-w-36">
            <option value="">All departments</option>
            {d!.departments.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </label>
      )}
    </div>
  );
}

/** Accounts grouped by type, active ones only (plus the current choice). */
export function AccountSelect({
  accounts,
  value,
  onChange,
  label = 'Account',
  className,
  placeholder = 'Choose an account…',
}: {
  accounts: LedgerAccountRow[];
  value: string;
  onChange: (id: string) => void;
  label?: string;
  className?: string;
  placeholder?: string;
}) {
  return (
    <Select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className={className}>
      <option value="">{placeholder}</option>
      {LEDGER_ACCOUNT_TYPES.map((t) => {
        const list = accounts.filter((a) => a.type === t && (a.isActive || a.id === value));
        if (list.length === 0) return null;
        return (
          <optgroup key={t} label={LEDGER_TYPE_LABELS[t]}>
            {list.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} · {a.name}
              </option>
            ))}
          </optgroup>
        );
      })}
    </Select>
  );
}

/** Query-string pairs for a dimension filter (links to account detail keep the filter). */
export function dimsQuery(d: BooksDimensionsFilter): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(d)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `&${s}` : '';
}
