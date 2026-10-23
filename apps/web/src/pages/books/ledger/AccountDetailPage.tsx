import { useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { LEDGER_SUBTYPE_LABELS, LEDGER_TYPE_LABELS, type BooksDimensionsFilter, type LedgerAccountDetailRow } from '@alto-people/shared';
import { getAccountDetail } from '@/lib/books/ledgerApi';
import { fmtDate, ymdLocal } from '@/lib/format';
import { ListTemplate } from '@/components/templates';
import { Badge } from '@/components/ui/Badge';
import { Card, CardContent } from '@/components/ui/Card';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { Input } from '@/components/ui/Input';
import { MetricCard } from '@/components/ui/MetricCard';
import { QueryError } from '@/components/ui/QueryError';
import { Skeleton } from '@/components/ui/Skeleton';
import { fmtMoney } from '@/lib/format';
import { Amount, DimensionFilters, sourceLabel, yearStart } from './ledgerKit';

/**
 * One account's register for a range: the balance it opened with, every
 * line that moved it (each opening its entry), and the running balance to
 * where it closed. The statements link here with their range and filter.
 */
export function AccountDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const [params, setParams] = useSearchParams();
  const today = ymdLocal();
  const from = params.get('from') ?? yearStart(today);
  const to = params.get('to') ?? today;
  const dims: BooksDimensionsFilter = { clientId: params.get('clientId') ?? undefined, siteId: params.get('siteId') ?? undefined, departmentId: params.get('departmentId') ?? undefined };
  const set = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
  };
  const q = useQuery({ queryKey: ['books', 'account-detail', id, from, to, dims], queryFn: () => getAccountDetail(id, { from, to, ...dims }) });
  const d = q.data;

  const columns: GridColumn<LedgerAccountDetailRow>[] = [
    { key: 'date', header: 'Date', accessor: (r) => r.date, cell: (r) => fmtDate(r.date), primary: true },
    { key: 'number', header: 'Entry', accessor: (r) => r.number, className: 'tabular-nums', cell: (r) => `#${r.number}` },
    { key: 'memo', header: 'Memo', accessor: (r) => r.memo ?? '', cell: (r) => <span className="text-ink">{r.memo ?? '—'}</span> },
    {
      key: 'source',
      header: 'From',
      accessor: (r) => sourceLabel(r.source),
      cardMeta: true,
      cell: (r) => (
        <span className="flex gap-1">
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
  return (
    <ListTemplate
      title={d ? `${d.account.code} · ${d.account.name}` : 'Account'}
      subtitle={d ? `${LEDGER_TYPE_LABELS[d.account.type]} · ${LEDGER_SUBTYPE_LABELS[d.account.subtype] ?? d.account.subtype}` : undefined}
      breadcrumbs={[{ label: 'Books', to: '/books' }, { label: 'Chart of accounts', to: '/books/accounts' }, { label: d?.account.name ?? 'Account' }]}
      filters={
        <Card>
          <CardContent className="flex flex-wrap items-end gap-3 p-3">
            <label className="flex flex-col gap-1 text-xs text-ink-muted">
              From
              <Input type="date" aria-label="From" value={from} max={to} onChange={(e) => set({ from: e.target.value })} />
            </label>
            <label className="flex flex-col gap-1 text-xs text-ink-muted">
              To
              <Input type="date" aria-label="To" value={to} min={from} onChange={(e) => set({ to: e.target.value })} />
            </label>
            <DimensionFilters value={dims} onChange={(v) => set({ clientId: v.clientId, siteId: v.siteId, departmentId: v.departmentId })} />
          </CardContent>
        </Card>
      }
      summary={
        d ? (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <MetricCard label={`Opening, ${fmtDate(from)}`} value={fmtMoney(d.opening)} />
            <MetricCard label="Debits" value={fmtMoney(d.rows.reduce((s, r) => s + r.debit, 0))} />
            <MetricCard label="Credits" value={fmtMoney(d.rows.reduce((s, r) => s + r.credit, 0))} />
            <MetricCard label={`Closing, ${fmtDate(to)}`} value={fmtMoney(d.closing)} accent />
          </div>
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
      />
    </ListTemplate>
  );
}
