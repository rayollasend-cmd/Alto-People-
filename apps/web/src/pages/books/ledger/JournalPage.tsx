import { useSearchParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { JOURNAL_SOURCE_LABELS, type BooksJournalRow } from '@alto-people/shared';
import { useAuth } from '@/lib/auth';
import { listJournal } from '@/lib/books/ledgerApi';
import { fmtDate } from '@/lib/format';
import { ListTemplate } from '@/components/templates';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Amount, AccountSelect, sourceLabel, useLedgerAccounts, yearStart } from './ledgerKit';

/**
 * Every entry in the books, newest first: what posted it (payroll, a
 * statement, a bill, the bank, QuickBooks, a person), the accounts it
 * touched and its amount — filtered by date, source, account or words.
 */

const PAGE = 200;

export function JournalPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const today = new Date().toISOString().slice(0, 10);
  const filters = {
    from: params.get('from') ?? yearStart(today),
    to: params.get('to') ?? today,
    source: params.get('source') ?? '',
    accountId: params.get('accountId') ?? '',
    q: params.get('q') ?? '',
    status: (params.get('status') as 'POSTED' | 'VOID' | null) ?? undefined,
  };
  const page = Number(params.get('page') ?? 0);
  const set = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    if (!('page' in patch)) next.delete('page');
    setParams(next, { replace: true });
  };
  const accounts = useLedgerAccounts();
  const q = useQuery({
    queryKey: ['books', 'journal', filters, page],
    queryFn: () => listJournal({ ...filters, source: filters.source || undefined, accountId: filters.accountId || undefined, q: filters.q || undefined, limit: PAGE, offset: page * PAGE }),
  });

  const columns: GridColumn<BooksJournalRow>[] = [
    { key: 'number', header: 'No.', accessor: (r) => r.number, sortable: true, width: '5rem', className: 'tabular-nums', primary: true },
    { key: 'date', header: 'Date', accessor: (r) => r.date, sortable: true, cardMeta: true, cell: (r) => fmtDate(r.date) },
    { key: 'memo', header: 'Memo', accessor: (r) => r.memo ?? '', cell: (r) => <span className="text-ink">{r.memo ?? '—'}</span> },
    { key: 'accounts', header: 'Accounts', accessor: (r) => r.accounts, cell: (r) => <span className="text-ink-muted">{r.accounts}</span> },
    {
      key: 'source',
      header: 'From',
      accessor: (r) => sourceLabel(r.source),
      sortable: true,
      cell: (r) => (
        <span className="flex flex-wrap items-center gap-1">
          <Badge variant={r.origin === 'QUICKBOOKS' ? 'info' : 'outline'} size="sm">
            {r.origin === 'QUICKBOOKS' ? 'QuickBooks' : sourceLabel(r.source)}
          </Badge>
          {r.status === 'VOID' && (
            <Badge variant="destructive" size="sm">
              Void
            </Badge>
          )}
          {r.reverseOn && (
            <Badge variant="pending" size="sm">
              Reverses {fmtDate(r.reverseOn)}
            </Badge>
          )}
        </span>
      ),
    },
    { key: 'amount', header: 'Amount', accessor: (r) => r.amount, sortable: true, align: 'right', cell: (r) => <Amount value={r.amount} className={r.status === 'VOID' ? 'line-through' : undefined} /> },
  ];

  const total = q.data?.total ?? 0;
  return (
    <ListTemplate
      title="Journal"
      subtitle="Every entry in the books — posted on their own by payroll, statements, bills and the bank, or by hand."
      breadcrumbs={[{ label: 'Books', to: '/books' }, { label: 'Journal' }]}
      primaryAction={
        can('manage:books') ? (
          <Button asChild>
            <Link to="/books/journal/new">
              <Plus className="h-4 w-4" aria-hidden="true" />
              New entry
            </Link>
          </Button>
        ) : undefined
      }
      filters={
        <Card>
          <CardContent className="flex flex-wrap items-end gap-3 p-3">
            <label className="flex flex-col gap-1 text-xs text-ink-muted">
              From
              <Input type="date" aria-label="From" value={filters.from} onChange={(e) => set({ from: e.target.value })} />
            </label>
            <label className="flex flex-col gap-1 text-xs text-ink-muted">
              To
              <Input type="date" aria-label="To" value={filters.to} onChange={(e) => set({ to: e.target.value })} />
            </label>
            <label className="flex flex-col gap-1 text-xs text-ink-muted">
              From where
              <Select aria-label="Source" value={filters.source} onChange={(e) => set({ source: e.target.value })}>
                <option value="">Everything</option>
                {Object.entries(JOURNAL_SOURCE_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-ink-muted">
              Account
              <AccountSelect accounts={accounts.data?.accounts ?? []} value={filters.accountId} onChange={(v) => set({ accountId: v })} placeholder="Any account" />
            </label>
            <label className="flex flex-col gap-1 text-xs text-ink-muted">
              Status
              <Select aria-label="Status" value={filters.status ?? ''} onChange={(e) => set({ status: e.target.value })}>
                <option value="">Posted and void</option>
                <option value="POSTED">Posted</option>
                <option value="VOID">Void</option>
              </Select>
            </label>
            <label className="flex flex-1 flex-col gap-1 text-xs text-ink-muted">
              Memo or number
              <Input type="search" aria-label="Search memo or number" defaultValue={filters.q} placeholder="Rent, 1042…" onKeyDown={(e) => e.key === 'Enter' && set({ q: (e.target as HTMLInputElement).value })} onBlur={(e) => e.target.value !== filters.q && set({ q: e.target.value })} />
            </label>
          </CardContent>
        </Card>
      }
    >
      <DataGrid
        id="books-journal"
        caption="Journal entries"
        noun={{ one: 'entry', many: 'entries' }}
        rows={q.data?.entries}
        loading={q.isLoading}
        error={q.isError ? 'Couldn’t load the journal.' : null}
        onRetry={() => void q.refetch()}
        columns={columns}
        rowKey={(r) => r.id}
        search={false}
        urlState={false}
        exportCsv={{ filename: 'journal' }}
        rowHref={(r) => `/books/journal/${r.id}`}
      />
      {total > PAGE && (
        <div className="flex items-center justify-between text-sm text-ink-muted">
          <span>
            {page * PAGE + 1}–{Math.min(total, (page + 1) * PAGE)} of {total}
          </span>
          <span className="flex gap-2">
            <Button size="sm" variant="secondary" disabled={page === 0} onClick={() => set({ page: String(page - 1) })}>
              Newer
            </Button>
            <Button size="sm" variant="secondary" disabled={(page + 1) * PAGE >= total} onClick={() => set({ page: String(page + 1) })}>
              Older
            </Button>
          </span>
        </div>
      )}
    </ListTemplate>
  );
}
