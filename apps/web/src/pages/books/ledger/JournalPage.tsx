import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { NotebookPen, Plus } from '@/components/ui/icons';
import { JOURNAL_SOURCE_LABELS, type BooksJournalRow } from '@alto-people/shared';
import { useAuth } from '@/lib/auth';
import { downloadJournalCsv, listJournal, type JournalFilters } from '@/lib/books/ledgerApi';
import { fmtDate, ymdLocal } from '@/lib/format';
import { useUrlWriter } from '@/lib/useUrlState';
import { ListTemplate } from '@/components/templates';
import { SavedViewsMenu } from '@/components/SavedViewsMenu';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { FilterBar, FilterChip, SearchInput } from '@/components/ui/FilterBar';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import type { TableSortState } from '@/components/ui/Table';
import { toast } from '@/components/ui/Toaster';
import { Amount, AccountSelect, PostHistoryButton, monthStart, sourceLabel, useLedgerAccounts, yearStart } from './ledgerKit';

/**
 * Every entry in the books, newest first: what posted it (payroll, a
 * statement, a bill, the bank, QuickBooks, a person), the accounts it
 * touched and its amount — filtered by date, source, account or words.
 *
 * The journal runs to thousands of entries, so the server does the work:
 * it counts every match, sorts the whole filtered set (a header click
 * re-reads it), and the export is every match, not the page on screen.
 * The filters live in the URL, so a view is a link — and a saved view.
 */

const PAGE = 200;
/** The URL params that are filters (a saved view stores exactly these). */
const FILTER_KEYS = ['from', 'to', 'source', 'accountId', 'status', 'q'] as const;
type SortKey = 'date' | 'number' | 'amount';
const SORTS: readonly SortKey[] = ['date', 'number', 'amount'];

export function JournalPage() {
  const { can } = useAuth();
  const [params] = useSearchParams();
  const write = useUrlWriter();
  const today = ymdLocal();
  const status = params.get('status');
  const filters = {
    from: params.get('from') ?? yearStart(today),
    to: params.get('to') ?? today,
    source: params.get('source') ?? '',
    accountId: params.get('accountId') ?? '',
    q: params.get('q') ?? '',
    status: status === 'POSTED' || status === 'VOID' ? (status as 'POSTED' | 'VOID') : undefined,
  };
  const sortParam = params.get('sort') as SortKey | null;
  const sort: SortKey = sortParam && SORTS.includes(sortParam) ? sortParam : 'date';
  const dir: 'asc' | 'desc' = params.get('dir') === 'asc' ? 'asc' : 'desc';
  const page = Math.max(0, Number(params.get('page') ?? 0) || 0);
  const savedViewId = params.get('sv');
  const activeFilters = FILTER_KEYS.filter((k) => params.get(k)).length;

  /** Change filters: back to the first page, and off any saved view's exact match is the menu's to judge. */
  const set = (patch: Partial<Record<(typeof FILTER_KEYS)[number] | 'sort' | 'dir' | 'page', string | undefined>>) =>
    write((p) => {
      for (const [k, v] of Object.entries(patch)) {
        if (v) p.set(k, v);
        else p.delete(k);
      }
      if (!('page' in patch)) p.delete('page');
    });
  const clearFilters = () =>
    write((p) => {
      for (const k of FILTER_KEYS) p.delete(k);
      p.delete('page');
      p.delete('sv');
    });
  const applyView = (id: string | null, query: Record<string, string>) =>
    write((p) => {
      for (const k of FILTER_KEYS) p.delete(k);
      for (const k of FILTER_KEYS) if (query[k]) p.set(k, query[k]);
      p.delete('page');
      if (id) p.set('sv', id);
      else p.delete('sv');
    });

  // The search box answers at once and asks the server a beat later.
  const [qDraft, setQDraft] = useState(filters.q);
  useEffect(() => setQDraft(filters.q), [filters.q]);
  useEffect(() => {
    if (qDraft === filters.q) return;
    const t = window.setTimeout(() => set({ q: qDraft.trim() || undefined }), 400);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `set` writes the URL; the draft is the trigger
  }, [qDraft]);

  const accounts = useLedgerAccounts();
  const listFilters: Omit<JournalFilters, 'limit' | 'offset'> = {
    from: filters.from,
    to: filters.to,
    source: filters.source || undefined,
    accountId: filters.accountId || undefined,
    q: filters.q || undefined,
    status: filters.status,
    sort: sort === 'date' ? undefined : sort,
    dir: dir === 'desc' ? undefined : dir,
  };
  const q = useQuery({
    queryKey: ['books', 'journal', listFilters, page],
    queryFn: () => listJournal({ ...listFilters, limit: PAGE, offset: page * PAGE }),
  });
  const total = q.data?.total ?? 0;
  // An empty year-to-date with no filters: is the whole journal empty, or just these dates?
  const anyAtAll = useQuery({
    queryKey: ['books', 'journal', 'any'],
    queryFn: () => listJournal({ limit: 1 }),
    enabled: q.isSuccess && total === 0 && activeFilters === 0,
  });
  const nothingYet = q.isSuccess && total === 0 && activeFilters === 0 && anyAtAll.data?.total === 0;

  const sortState: TableSortState<string> = { key: sort, direction: dir };
  const toggleSort = (key: string) => {
    if (!SORTS.includes(key as SortKey)) return;
    const next = key === sort ? (dir === 'desc' ? 'asc' : 'desc') : 'desc';
    set({ sort: key === 'date' ? undefined : key, dir: next === 'desc' ? undefined : next });
  };

  const columns: GridColumn<BooksJournalRow>[] = [
    { key: 'number', header: 'No.', accessor: (r) => r.number, sortable: true, width: '5rem', className: 'tabular-nums', cardMeta: true, cell: (r) => `#${r.number}` },
    { key: 'date', header: 'Date', accessor: (r) => r.date, sortable: true, cardMeta: true, cell: (r) => fmtDate(r.date) },
    { key: 'memo', header: 'Memo', primary: true, accessor: (r) => r.memo ?? '', cell: (r) => <span className="text-ink">{r.memo ?? `${sourceLabel(r.source)} entry`}</span> },
    { key: 'accounts', header: 'Accounts', accessor: (r) => r.accounts, cell: (r) => <span className="text-ink-muted">{r.accounts}</span> },
    {
      key: 'source',
      header: 'From',
      accessor: (r) => (r.origin === 'QUICKBOOKS' ? 'QuickBooks' : sourceLabel(r.source)),
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

  const viewQuery = useMemo(() => Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k) ?? '']).filter(([, v]) => v)), [params]);
  const builtIn: Array<{ key: string; label: string; query: Record<string, string> }> = [
    { key: 'manual', label: 'Manual entries this month', query: { source: 'MANUAL', from: monthStart(today) } },
    { key: 'voids', label: 'Voids', query: { status: 'VOID' } },
  ];
  const isView = (v: Record<string, string>) => {
    const keys = Object.keys(viewQuery);
    return keys.length === Object.keys(v).length && keys.every((k) => v[k] === viewQuery[k]);
  };
  const [toolbarEl, setToolbarEl] = useState<HTMLElement | null>(null);
  const exportAll = () =>
    void downloadJournalCsv(listFilters).catch((err: unknown) => toast.error(err instanceof Error ? err.message : 'The download failed.'));

  return (
    <ListTemplate
      title="Journal"
      subtitle="Every entry in the books — posted on their own by payroll, statements, bills and the bank, or by hand."
      actions={can('manage:books') ? [{ key: 'new', label: 'New entry', icon: Plus, primary: true, to: '/books/journal/new' }] : undefined}
    >
      {!nothingYet && (
        <FilterBar
          urlKey={FILTER_KEYS}
          onClearFilters={clearFilters}
          sheetDescription="Narrow the journal by date, where an entry came from, an account or its status."
          search={<SearchInput aria-label="Search memo or number" placeholder="Memo or number" value={qDraft} onChange={(e) => setQDraft(e.target.value)} />}
          count={<span ref={setToolbarEl} className="flex items-center gap-2" />}
          actions={<SavedViewsMenu scope="books.journal" current={viewQuery} activeId={savedViewId} onApply={applyView} allLabel="Saved views" />}
        >
          <label className="flex items-center gap-1.5 text-xs text-ink-muted">
            From
            <Input size="sm" type="date" aria-label="From" value={filters.from} max={filters.to} onChange={(e) => set({ from: e.target.value || undefined })} className="w-auto" />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-ink-muted">
            To
            <Input size="sm" type="date" aria-label="To" value={filters.to} min={filters.from} onChange={(e) => set({ to: e.target.value || undefined })} className="w-auto" />
          </label>
          <Select size="sm" aria-label="Source" value={filters.source} onChange={(e) => set({ source: e.target.value || undefined })} className="w-auto">
            <option value="">From anywhere</option>
            {Object.entries(JOURNAL_SOURCE_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
          <AccountSelect size="sm" accounts={accounts.data?.accounts ?? []} value={filters.accountId} onChange={(v) => set({ accountId: v || undefined })} placeholder="Any account" className="w-auto max-w-[16rem]" />
          <Select size="sm" aria-label="Status" value={filters.status ?? ''} onChange={(e) => set({ status: e.target.value || undefined })} className="w-auto">
            <option value="">Posted and void</option>
            <option value="POSTED">Posted</option>
            <option value="VOID">Void</option>
          </Select>
          <span role="group" aria-label="Quick views" className="flex flex-wrap items-center gap-1.5">
            {builtIn.map((v) => (
              <FilterChip key={v.key} active={isView(v.query)} onClick={() => (isView(v.query) ? clearFilters() : applyView(null, v.query))}>
                {v.label}
              </FilterChip>
            ))}
          </span>
        </FilterBar>
      )}
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
        sort={{ state: sortState, onToggle: toggleSort }}
        server={{ total, offset: page * PAGE, onExport: exportAll }}
        toolbar={{ into: toolbarEl }}
        activeFilters={activeFilters}
        onClearFilters={clearFilters}
        rowHref={(r) => `/books/journal/${r.id}`}
        rowActionLabel={(r) => `Open entry #${r.number}`}
        empty={
          nothingYet
            ? {
                icon: NotebookPen,
                title: 'Nothing in the books yet',
                description: 'Post history to bring payroll runs, client statements and payments in — or post an entry by hand.',
                action: <PostHistoryButton />,
              }
            : {
                icon: NotebookPen,
                title: `No entries since ${fmtDate(filters.from)}`,
                description: 'Earlier entries are outside these dates.',
                action: (
                  <Button variant="secondary" onClick={() => set({ from: `${Number(filters.from.slice(0, 4)) - 1}-01-01` })}>
                    Show {Number(filters.from.slice(0, 4)) - 1} too
                  </Button>
                ),
              }
        }
      />
      {total > PAGE && (
        <div className="flex items-center justify-end gap-2">
          <Button size="sm" variant="secondary" disabled={page === 0} onClick={() => set({ page: page - 1 > 0 ? String(page - 1) : undefined })}>
            Newer
          </Button>
          <Button size="sm" variant="secondary" disabled={(page + 1) * PAGE >= total} onClick={() => set({ page: String(page + 1) })}>
            Older
          </Button>
        </div>
      )}
    </ListTemplate>
  );
}
