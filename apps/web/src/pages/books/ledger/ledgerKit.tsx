import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { HandCoins, History } from '@/components/ui/icons';
import { LEDGER_TYPE_LABELS, LEDGER_ACCOUNT_TYPES, JOURNAL_SOURCE_LABELS, type BooksDimensionsFilter, type LedgerAccountRow, type PostingBackfillResult } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { getBooksDimensions, listLedgerAccounts } from '@/lib/books/ledgerApi';
import { backfillPosting, settleMarkedPaid } from '@/lib/books/receivablesApi';
import { fmtMoney, ymdLocal } from '@/lib/format';
import { Button, type ButtonProps } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { toast } from '@/components/ui/Toaster';
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

/**
 * Client / site / department pickers in one row; empty means "the whole
 * company". `compact` draws them as small inline selects for a filter bar
 * (each option list names itself: "All clients").
 */
export function DimensionFilters({ value, onChange, className, compact }: { value: BooksDimensionsFilter; onChange: (v: BooksDimensionsFilter) => void; className?: string; compact?: boolean }) {
  const dims = useBooksDimensions();
  const d = dims.data;
  const set = (k: keyof BooksDimensionsFilter, v: string) => onChange({ ...value, [k]: v || undefined });
  const pickers: Array<{ key: keyof BooksDimensionsFilter; label: string; all: string; list: Array<{ id: string; name: string }> }> = [
    { key: 'clientId', label: 'Client', all: 'All clients', list: d?.clients ?? [] },
    { key: 'siteId', label: 'Site', all: 'All sites', list: d?.sites ?? [] },
    { key: 'departmentId', label: 'Department', all: 'All departments', list: d?.departments ?? [] },
  ];
  const shown = pickers.filter((p) => p.list.length > 0);
  if (compact) {
    return (
      <>
        {shown.map((p) => (
          <Select key={p.key} size="sm" aria-label={p.label} value={value[p.key] ?? ''} onChange={(e) => set(p.key, e.target.value)} className={cn('w-auto max-w-[14rem]', className)}>
            <option value="">{p.all}</option>
            {p.list.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        ))}
      </>
    );
  }
  return (
    <div className={cn('flex flex-wrap items-end gap-2', className)}>
      {shown.map((p) => (
        <label key={p.key} className="flex flex-col gap-1 text-xs text-ink-muted">
          {p.label}
          <Select aria-label={p.label} value={value[p.key] ?? ''} onChange={(e) => set(p.key, e.target.value)} className="min-w-36">
            <option value="">{p.all}</option>
            {p.list.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </label>
      ))}
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
  size,
}: {
  accounts: LedgerAccountRow[];
  value: string;
  onChange: (id: string) => void;
  label?: string;
  className?: string;
  placeholder?: string;
  size?: 'sm' | 'md';
}) {
  return (
    <Select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className={className} size={size}>
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

/** What a history post brought in, in words ("Posted 3 payroll runs, 12 statements."). */
export function backfillSummary(r: PostingBackfillResult): string {
  const tax = r.taxPayments + r.taxDeposits;
  const parts = [
    r.payrollRuns && `${r.payrollRuns} payroll ${r.payrollRuns === 1 ? 'run' : 'runs'}`,
    r.statements && `${r.statements} ${r.statements === 1 ? 'statement' : 'statements'}`,
    tax && `${tax} tax ${tax === 1 ? 'payment' : 'payments'}`,
    r.garnishmentRemittances && `${r.garnishmentRemittances} garnishment ${r.garnishmentRemittances === 1 ? 'payment' : 'payments'}`,
    r.wageAdvances && `${r.wageAdvances} wage ${r.wageAdvances === 1 ? 'advance' : 'advances'}`,
    r.clientPayments && `${r.clientPayments} client ${r.clientPayments === 1 ? 'payment' : 'payments'} for statements marked paid`,
  ].filter(Boolean);
  const failed = r.failed.length ? ` ${r.failed.length} couldn’t post: ${r.failed[0]!.error}` : '';
  if (parts.length === 0) return r.failed.length ? `Nothing posted.${failed}` : 'The books already hold everything — nothing to post.';
  return `Posted ${parts.join(', ')}.${failed}`;
}

/**
 * "Record the payments" (audit 2026-10-29 MONEY-3): statements marked paid
 * with no payment behind them get the payment they were marked paid with —
 * dated the day they were marked paid — so the books stop counting them as
 * owed. For the people who keep the books; null for everyone else.
 */
export function RecordMarkedPaidButton({ label = 'Record the payments', ...props }: Omit<ButtonProps, 'onClick' | 'loading' | 'children'> & { label?: string }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const settle = useMutation({
    mutationFn: () => settleMarkedPaid(),
    onSuccess: (r) => {
      const words = r.payments ? `Recorded ${r.payments} ${r.payments === 1 ? 'payment' : 'payments'} (${fmtMoney(r.amount)}) for statements marked paid.` : 'Every statement marked paid already has its payment.';
      if (r.failed.length) toast.error(`${words} ${r.failed.length} couldn’t be recorded: ${r.failed[0]!.error}`);
      else toast.success(words);
      void qc.invalidateQueries({ queryKey: ['books'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not record the payments.'),
  });
  if (!can('manage:books')) return null;
  return (
    <Button {...props} loading={settle.isPending} onClick={() => settle.mutate()} title="Record a payment for each statement that was marked paid without one">
      <HandCoins className="h-4 w-4" aria-hidden="true" />
      {label}
    </Button>
  );
}

/**
 * "Post history": every payroll run, statement and payment the books don't
 * hold yet, posted through the ledger's one door (idempotent — a second
 * press finds nothing new). For the people who keep the books; null for
 * everyone else.
 */
export function PostHistoryButton({ label = 'Post history', ...props }: Omit<ButtonProps, 'onClick' | 'loading' | 'children'> & { label?: string }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const post = useMutation({
    mutationFn: () => backfillPosting(),
    onSuccess: (r) => {
      if (r.failed.length) toast.error(backfillSummary(r));
      else toast.success(backfillSummary(r));
      void qc.invalidateQueries({ queryKey: ['books'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not post history.'),
  });
  if (!can('manage:books')) return null;
  return (
    <Button {...props} loading={post.isPending} onClick={() => post.mutate()} title="Post every payroll run, statement and payment the books don’t hold yet">
      <History className="h-4 w-4" aria-hidden="true" />
      {label}
    </Button>
  );
}
