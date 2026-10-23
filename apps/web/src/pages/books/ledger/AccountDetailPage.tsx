import { useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { LEDGER_SUBTYPE_LABELS, LEDGER_TYPE_LABELS, type BooksDimensionsFilter, type LedgerAccountDetailRow } from '@alto-people/shared';
import { getAccountDetail } from '@/lib/books/ledgerApi';
import { fmtDate, fmtDateOnlyRange, fmtMoney, ymdLocal } from '@/lib/format';
import { useUrlWriter } from '@/lib/useUrlState';
import { ListTemplate } from '@/components/templates';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { FilterBar } from '@/components/ui/FilterBar';
import { Input } from '@/components/ui/Input';
import { MetricCard } from '@/components/ui/MetricCard';
import { MetricStrip } from '@/components/ui/MetricStrip';
import { QueryError } from '@/components/ui/QueryError';
import { Skeleton } from '@/components/ui/Skeleton';
import { Amount, DimensionFilters, sourceLabel, yearStart } from './ledgerKit';

/**
 * One account's register for a range: the balance it opened with, every
 * line that moved it (each opening its entry), and the running balance to
 * where it closed. The statements link here with their range and filter.
 */

const FILTER_KEYS = ['from', 'to', 'clientId', 'siteId', 'departmentId'] as const;

export function AccountDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const write = useUrlWriter();
  const today = ymdLocal();
  const from = params.get('from') ?? yearStart(today);
  const to = params.get('to') ?? today;
  const dims: BooksDimensionsFilter = { clientId: params.get('clientId') ?? undefined, siteId: params.get('siteId') ?? undefined, departmentId: params.get('departmentId') ?? undefined };
  const set = (patch: Record<string, string | undefined>) =>
    write((p) => {
      for (const [k, v] of Object.entries(patch)) {
        if (v) p.set(k, v);
        else p.delete(k);
      }
    });
  const q = useQuery({ queryKey: ['books', 'account-detail', id, from, to, dims], queryFn: () => getAccountDetail(id, { from, to, ...dims }) });
  const d = q.data;
  const earlier = `${Number(from.slice(0, 4)) - 1}-01-01`;

  const columns: GridColumn<LedgerAccountDetailRow>[] = [
    { key: 'date', header: 'Date', accessor: (r) => r.date, cell: (r) => fmtDate(r.date), cardMeta: true },
    { key: 'number', header: 'Entry', accessor: (r) => r.number, className: 'tabular-nums', cell: (r) => `#${r.number}`, cardMeta: true },
    { key: 'memo', header: 'Memo', primary: true, accessor: (r) => r.memo ?? '', cell: (r) => <span className="text-ink">{r.memo ?? `${sourceLabel(r.source)} entry`}</span> },
    {
      key: 'source',
      header: 'From',
      accessor: (r) => (r.origin === 'QUICKBOOKS' ? 'QuickBooks' : sourceLabel(r.source)),
      cell: (r) => (
        <span className="flex flex-wrap gap-1">
          <Badge size="sm" variant={r.origin === 'QUICKBOOKS' ? 'info' : 'outline'}>
            {r.origin === 'QUICKBOOKS' ? 'QuickBooks' : sourceLabel(r.source)}
          </Badge>
          {r.cleared && (
            <Badge size="sm" variant="success">
              Cleared
            </Badge>
          )}
        </span>
      ),
    },
    { key: 'debit', header: 'Debit', accessor: (r) => r.debit, align: 'right', cell: (r) => <Amount value={r.debit} blankZero /> },
    { key: 'credit', header: 'Credit', accessor: (r) => r.credit, align: 'right', cell: (r) => <Amount value={r.credit} blankZero /> },
    { key: 'balance', header: 'Balance', accessor: (r) => r.balance, align: 'right', cell: (r) => <Amount value={r.balance} strong /> },
  ];

  if (q.isError) return <QueryError what="the account" query={q} />;
  const name = d ? `${d.account.code} · ${d.account.name}` : 'Account';
  return (
    <ListTemplate
      title={name}
      subtitle={d ? `${LEDGER_TYPE_LABELS[d.account.type]} · ${LEDGER_SUBTYPE_LABELS[d.account.subtype] ?? d.account.subtype}` : undefined}
      filters={
        <FilterBar urlKey={FILTER_KEYS} sheetDescription="The dates and the part of the company this register covers.">
          <label className="flex items-center gap-1.5 text-xs text-ink-muted">
            From
            <Input size="sm" type="date" aria-label="From" value={from} max={to} onChange={(e) => set({ from: e.target.value || undefined })} className="w-auto" />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-ink-muted">
            To
            <Input size="sm" type="date" aria-label="To" value={to} min={from} onChange={(e) => set({ to: e.target.value || undefined })} className="w-auto" />
          </label>
          <DimensionFilters compact value={dims} onChange={(v) => set({ clientId: v.clientId, siteId: v.siteId, departmentId: v.departmentId })} />
        </FilterBar>
      }
      summary={
        d ? (
          <MetricStrip label="The account over these dates">
            <MetricCard label={`Opening, ${fmtDate(from)}`} value={fmtMoney(d.opening)} />
            <MetricCard label="Debits" value={fmtMoney(d.rows.reduce((s, r) => s + r.debit, 0))} />
            <MetricCard label="Credits" value={fmtMoney(d.rows.reduce((s, r) => s + r.credit, 0))} />
            <MetricCard label={`Closing, ${fmtDate(to)}`} value={fmtMoney(d.closing)} />
          </MetricStrip>
        ) : (
          <Skeleton className="h-24" />
        )
      }
    >
      <DataGrid
        id="books-account-detail"
        caption="Account register"
        noun={{ one: 'line', many: 'lines' }}
        rows={d?.rows}
        loading={q.isLoading}
        columns={columns}
        rowKey={(r) => r.lineId}
        urlState={false}
        search={{ placeholder: 'Search memos' }}
        exportCsv={{ filename: d ? `${d.account.code}-${from}-to-${to}` : 'account' }}
        rowHref={(r) => `/books/journal/${r.entryId}`}
        rowActionLabel={(r) => `Open entry #${r.number}`}
        empty={{
          title: `Nothing posted to ${d?.account.name ?? 'this account'}, ${fmtDateOnlyRange(from, to)}`,
          description: d && d.opening !== 0 ? `It opened the range at ${fmtMoney(d.opening)} and nothing moved it.` : 'Earlier entries, if any, are outside these dates.',
          action: (
            <Button variant="secondary" onClick={() => set({ from: earlier })}>
              Widen the dates to {fmtDate(earlier)}
            </Button>
          ),
        }}
      />
    </ListTemplate>
  );
}
