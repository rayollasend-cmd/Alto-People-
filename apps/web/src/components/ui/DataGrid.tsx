import * as React from 'react';
import { useInRouterContext, useSearchParams } from 'react-router-dom';
import { Columns3, Download, Inbox, type LucideIcon } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { cn } from '@/lib/cn';
import { downloadCsv } from '@/lib/csv';
import { useDesktopTable } from '@/lib/useViewport';
import { AuthContext } from '@/lib/auth';
import { Button } from './Button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './DropdownMenu';
import { EmptyState } from './EmptyState';
import { FilterBar, SearchInput } from './FilterBar';
import { Skeleton } from './Skeleton';
import {
  SortableTableHead,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  useTableSort,
  type TableSortState,
} from './Table';

/**
 * DataGrid — the one way a list of records is shown.
 *
 * Seventy-five tables were hand-built from the Table primitives, and five
 * of them could sort. Each reinvented — or skipped — search, column
 * hiding, export, selection and the empty state, and 64 of them dealt
 * with phones by hiding columns until only a name was left. `Table.tsx`
 * has carried "Phase 28 will swap to TanStack Table" since the
 * beginning; the pieces it was waiting for already existed in the
 * flagship pages (useTableSort, the virtualizer, downloadCsv, the bulk
 * pattern). This packages them.
 *
 * What every grid gets, for the price of a column list:
 *
 *   sort         any sortable column, third click restores server order
 *   search       tokens across every searchable column
 *   columns      a chooser; the choice is kept per grid, per person
 *   export       CSV of exactly what is on screen — visible columns,
 *                current sort, current search — never "the whole table"
 *   select       checkboxes and a bulk-action bar, when asked for
 *   url          ?sort= ?dir= ?q= so a filtered view is a link you can send
 *   phones       a card per row, built from the same column list, instead
 *                of a table that hides itself — and only the layout the
 *                viewport can show is mounted, never both
 *   virtualize   only the visible rows are in the DOM once a list is long
 *   states       skeleton, error, empty and "N of M" are not optional
 *
 * Server-paged lists (audit, statements) keep their own loaders and hand
 * the loaded page to the grid; the grid never fetches.
 */

export type GridAlign = 'left' | 'right' | 'center';

export interface GridColumn<T> {
  /** Stable key — also the URL sort key and the column-chooser id. */
  key: string;
  header: string;
  /** The comparable / searchable / exportable value. */
  accessor: (row: T) => string | number | null | undefined;
  /** What to draw. Defaults to the accessor's value. */
  cell?: (row: T) => React.ReactNode;
  /** What to export. Defaults to the accessor's value. */
  csv?: (row: T) => string | number | null | undefined;
  sortable?: boolean;
  /** Excluded from the search haystack when false. Default true. */
  searchable?: boolean;
  align?: GridAlign;
  /** A width hint for the column (any CSS width). */
  width?: string;
  /** Always visible in the chooser and never hidden. The row's identity. */
  primary?: boolean;
  /** Hidden by default; the chooser can turn it on. */
  defaultHidden?: boolean;
  /** On phones, show this column under the card title as its subtitle. */
  cardMeta?: boolean;
  /** Extra classes on header and cells (e.g. tabular-nums). */
  className?: string;
  /** A cell of buttons: clicks inside it must not also open the row. */
  stopRowClick?: boolean;
}

export interface DataGridProps<T> {
  /** Distinguishes this grid's column preference from every other grid's. */
  id: string;
  rows: T[] | null | undefined;
  columns: GridColumn<T>[];
  rowKey: (row: T) => string;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  /** Accessible name for the table (and the CSV's base filename). */
  caption: string;
  search?: { placeholder?: string } | false;
  /** Column key to sort by initially. */
  defaultSort?: TableSortState<string>;
  /** Keep sort/search in the URL so the view is shareable. Default true. */
  urlState?: boolean;
  /** CSV export of what is on screen. Default on; pass false to disable. */
  exportCsv?: boolean | { filename: string };
  columnChooser?: boolean;
  /** Row selection + a bulk-action bar. `actions` renders with the chosen ids. */
  selectable?: {
    /** Rows that cannot be picked (e.g. the signed-in user). */
    disabled?: (row: T) => boolean;
    /** The bulk bar. Omit when the page draws its own from `selection`. */
    actions?: (selected: string[], clear: () => void) => React.ReactNode;
    /**
     * Controlled selection — when a page keeps the chosen ids itself,
     * because one choice spans several grids (renew across every
     * expiry bucket) or feeds a dialog that opens later (deny the
     * selected requests). Uncontrolled otherwise.
     */
    selection?: { selected: ReadonlySet<string>; onChange: (next: Set<string>) => void };
  };
  onRowClick?: (row: T) => void;
  /** Label for the row's click affordance, for screen readers. */
  rowActionLabel?: (row: T) => string;
  /** Extra classes on a row (an overdue tint, a highlighted match). */
  rowClassName?: (row: T) => string | undefined;
  /** Rows beyond this count are virtualized. Default 150. */
  virtualizeAfter?: number;
  rowHeight?: number;
  empty?: { icon?: LucideIcon; title: string; description?: React.ReactNode; action?: React.ReactNode };
  /** Under the search: chips, pickers, anything that narrows the rows. */
  filters?: React.ReactNode;
  /** A note beside the row count ("capped at 500, narrow the dates"). */
  footnote?: React.ReactNode;
  /** The card layout on phones. Default on when the grid has a primary column. */
  cards?: boolean;
  /** Total the rows were drawn from, when the caller only has a page. */
  total?: number;
  /**
   * Row grouping — one table, with a heading row where the group changes
   * (the audit log by day, a roster by store). Groups keep the sorted
   * order of their first row; search filters across all of them; export
   * flattens them. Virtualization is off while grouping is on.
   */
  groupBy?: {
    key: (row: T) => string;
    /** The heading for a group, given its key and the rows in it. */
    header: (key: string, rows: T[]) => React.ReactNode;
  };
  className?: string;
}

const COLS_KEY = (id: string, userId: string | null) => `alto.grid.${id}.cols.v1.${userId ?? 'anon'}`;

function readHidden(id: string, userId: string | null): Set<string> | null {
  try {
    const raw = window.localStorage.getItem(COLS_KEY(id, userId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((k): k is string => typeof k === 'string')) : null;
  } catch {
    return null;
  }
}

function writeHidden(id: string, userId: string | null, hidden: Set<string>) {
  try {
    window.localStorage.setItem(COLS_KEY(id, userId), JSON.stringify([...hidden]));
  } catch {
    /* a per-viewer convenience; storage may be unavailable */
  }
}

const tokensOf = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean);

/**
 * The grid, with its search and sort kept wherever the caller wants them.
 *
 * Inside a router with `urlState` on, they live in ?q= ?sort= ?dir= so a
 * narrowed view is a link you can send. Anywhere else — a page that owns
 * those params itself, a preview, a test with no router — they live in
 * component state. The split is two thin shells around one body, because
 * a hook cannot be called conditionally and a list primitive must render
 * in every context the app has.
 */
export function DataGrid<T>(props: DataGridProps<T>) {
  const inRouter = useInRouterContext();
  if (props.urlState !== false && inRouter) return <UrlStateGrid {...props} />;
  return <LocalStateGrid {...props} />;
}

function UrlStateGrid<T>(props: DataGridProps<T>) {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const setQ = React.useCallback(
    (next: string) => {
      setParams(
        (p) => {
          if (next) p.set('q', next);
          else p.delete('q');
          return p;
        },
        { replace: true },
      );
    },
    [setParams],
  );
  const sortKey = params.get('sort');
  const sortDir = params.get('dir');
  const initialSort = React.useMemo<TableSortState<string> | undefined>(() => {
    if (!sortKey || !props.columns.some((c) => c.key === sortKey)) return undefined;
    return { key: sortKey, direction: sortDir === 'desc' ? 'desc' : 'asc' };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortKey, sortDir]);
  const onSortChange = React.useCallback(
    (s: TableSortState<string>) => {
      setParams(
        (p) => {
          if (s.key) {
            p.set('sort', s.key);
            p.set('dir', s.direction);
          } else {
            p.delete('sort');
            p.delete('dir');
          }
          return p;
        },
        { replace: true },
      );
    },
    [setParams],
  );
  return <GridCore {...props} q={q} setQ={setQ} initialSort={initialSort} onSortChange={onSortChange} />;
}

function LocalStateGrid<T>(props: DataGridProps<T>) {
  const [q, setQ] = React.useState('');
  return <GridCore {...props} q={q} setQ={setQ} />;
}

function GridCore<T>({
  id,
  rows,
  columns,
  rowKey,
  loading = false,
  error = null,
  onRetry,
  caption,
  search = {},
  defaultSort,
  exportCsv = true,
  columnChooser = true,
  selectable,
  onRowClick,
  rowActionLabel,
  rowClassName,
  virtualizeAfter = 150,
  rowHeight = 48,
  empty,
  filters,
  footnote,
  cards,
  total,
  groupBy,
  className,
  q,
  setQ,
  initialSort,
  onSortChange,
}: DataGridProps<T> & {
  q: string;
  setQ: (next: string) => void;
  initialSort?: TableSortState<string>;
  onSortChange?: (s: TableSortState<string>) => void;
}) {
  // Read the context directly rather than through useAuth(): a list
  // primitive must render anywhere — a test, a preview, a kiosk — and the
  // signed-in user only decides which column preference to remember.
  const auth = React.useContext(AuthContext);
  const userId = auth?.user?.id ?? null;

  const accessors = React.useMemo(
    () => Object.fromEntries(columns.map((c) => [c.key, c.accessor])) as Record<string, (row: T) => string | number | null | undefined>,
    [columns],
  );

  /* ---- search, then sort ------------------------------------------- */
  const searched = React.useMemo(() => {
    const all = rows ?? [];
    const tokens = tokensOf(q);
    if (tokens.length === 0) return all;
    const cols = columns.filter((c) => c.searchable !== false);
    return all.filter((row) => {
      const hay = cols
        .map((c) => c.accessor(row))
        .filter((v) => v != null && v !== '')
        .join(' ')
        .toLowerCase();
      return tokens.every((t) => hay.includes(t));
    });
  }, [rows, q, columns]);

  const { sorted, sortState, toggleSort } = useTableSort(searched, accessors, initialSort ?? defaultSort);

  // Tell the shell when the sort changes here, so the URL follows. It is
  // one direction per event — the shell seeds the initial sort, this
  // reports the rest — so it can never loop.
  const lastReported = React.useRef<string>('');
  React.useEffect(() => {
    if (!onSortChange) return;
    const sig = `${sortState.key ?? ''}|${sortState.direction}`;
    if (sig === lastReported.current) return;
    if (lastReported.current === '' && !sortState.key) {
      // First render with nothing sorted: nothing to report.
      lastReported.current = sig;
      return;
    }
    lastReported.current = sig;
    onSortChange(sortState);
  }, [sortState, onSortChange]);

  /* ---- column visibility ------------------------------------------- */
  const [hidden, setHidden] = React.useState<Set<string>>(() => {
    const stored = typeof window !== 'undefined' ? readHidden(id, userId) : null;
    if (stored) return stored;
    return new Set(columns.filter((c) => c.defaultHidden).map((c) => c.key));
  });
  const toggleColumn = (key: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      writeHidden(id, userId, next);
      return next;
    });
  };
  const visible = columns.filter((c) => c.primary || !hidden.has(c.key));

  /* ---- selection ---------------------------------------------------- */
  const [ownSelected, setOwnSelected] = React.useState<Set<string>>(new Set());
  const controlled = selectable?.selection;
  const selected: ReadonlySet<string> = controlled ? controlled.selected : ownSelected;
  const setSelected = (next: Set<string> | ((prev: ReadonlySet<string>) => Set<string>)) => {
    const resolved = typeof next === 'function' ? next(selected) : next;
    if (controlled) controlled.onChange(resolved);
    else setOwnSelected(resolved);
  };
  const selectableRows = selectable ? sorted.filter((r) => !selectable.disabled?.(r)) : [];
  const allSelected = selectableRows.length > 0 && selectableRows.every((r) => selected.has(rowKey(r)));
  // Union and difference, never replace: a controlled selection may span
  // several grids (renew across every expiry bucket), and this grid's
  // header box must only ever add or remove ITS rows from that choice.
  const toggleAll = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      const mine = selectableRows.map(rowKey);
      if (allSelected) for (const k of mine) next.delete(k);
      else for (const k of mine) next.add(k);
      return next;
    });
  const toggleOne = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const clearSelection = () => setSelected(new Set());
  // A row that left the list (filtered away, deleted) leaves the selection.
  // Only for a selection this grid owns: a controlled one may span other
  // grids whose rows this one cannot see.
  React.useEffect(() => {
    if (controlled || selected.size === 0) return;
    const present = new Set(sorted.map(rowKey));
    if ([...selected].every((k) => present.has(k))) return;
    setOwnSelected(new Set([...selected].filter((k) => present.has(k))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sorted]);

  /* ---- export -------------------------------------------------------- */
  const exportRows = () => {
    const head = visible.map((c) => c.header);
    const body = sorted.map((r) => visible.map((c) => (c.csv ?? c.accessor)(r) ?? ''));
    const base = typeof exportCsv === 'object' ? exportCsv.filename : caption;
    const slug = base.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
    downloadCsv(`${slug || 'export'}.csv`, [head, ...body]);
  };

  /* ---- grouping ------------------------------------------------------ */
  // Groups are contiguous runs in the SORTED order, so sorting by a
  // grouped column keeps the groups whole and sorting by another column
  // orders rows within the group they belong to.
  const groups = React.useMemo(() => {
    if (!groupBy) return null;
    const order: string[] = [];
    const byKey = new Map<string, T[]>();
    for (const row of sorted) {
      const k = groupBy.key(row);
      if (!byKey.has(k)) {
        byKey.set(k, []);
        order.push(k);
      }
      byKey.get(k)!.push(row);
    }
    return order.map((k) => ({ key: k, rows: byKey.get(k)! }));
  }, [groupBy, sorted]);

  /* ---- virtualization ----------------------------------------------- */
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const virtualize = !groupBy && sorted.length > virtualizeAfter;
  const virtualizer = useVirtualizer({
    count: virtualize ? sorted.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
  });

  /* ---- phones: cards ------------------------------------------------- */
  const primary = columns.find((c) => c.primary) ?? columns[0];
  const useCards = cards ?? Boolean(primary);
  // Mount the table OR the cards, never both. Hiding the inactive one
  // with CSS still commits every row twice — on a large directory that
  // was ~9,000 dead DOM nodes — so the breakpoint is read in JS and the
  // other layout is not rendered at all.
  const desktop = useDesktopTable();
  const showCards = useCards && !desktop;

  const countLine = (() => {
    const n = sorted.length;
    const of = total ?? rows?.length ?? n;
    const noun = n === 1 ? 'row' : 'rows';
    return n === of ? `${n.toLocaleString('en-US')} ${noun}` : `${n.toLocaleString('en-US')} of ${of.toLocaleString('en-US')}`;
  })();

  const alignClass = (a?: GridAlign) => (a === 'right' ? 'text-right' : a === 'center' ? 'text-center' : '');

  /* ---- render ---------------------------------------------------------- */
  return (
    <div className={cn('space-y-3', className)}>
      {(search !== false || filters || columnChooser || exportCsv) && (
        <FilterBar>
          {search !== false && (
            <SearchInput
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={search?.placeholder ?? 'Search…'}
              aria-label={`Search ${caption}`}
              wrapperClassName="min-w-[12rem] flex-1"
            />
          )}
          {filters}
          <span className="ml-auto text-xs tabular-nums text-silver/70" aria-live="polite">
            {loading && !rows ? 'Loading…' : countLine}
            {footnote && <span className="text-silver/50"> · {footnote}</span>}
          </span>
          {columnChooser && columns.some((c) => !c.primary) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="xs" aria-label="Choose columns">
                  <Columns3 className="h-3.5 w-3.5" aria-hidden="true" />
                  <span className="ml-1 hidden sm:inline">Columns</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[12rem]">
                <DropdownMenuLabel>Columns</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {columns.map((c) => (
                  <DropdownMenuCheckboxItem
                    key={c.key}
                    checked={c.primary || !hidden.has(c.key)}
                    disabled={c.primary}
                    onCheckedChange={() => toggleColumn(c.key)}
                    onSelect={(e) => e.preventDefault()}
                  >
                    {c.header}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {exportCsv && (
            <Button
              variant="outline"
              size="xs"
              onClick={exportRows}
              disabled={sorted.length === 0}
              aria-label={`Export ${caption} as CSV — what is on screen`}
              title="Exports the visible columns, in the current order"
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="ml-1 hidden sm:inline">Export</span>
            </Button>
          )}
        </FilterBar>
      )}

      {selectable?.actions && selected.size > 0 && (
        <div
          className="flex flex-wrap items-center gap-2 rounded-md border border-gold/40 bg-gold/5 px-3 py-2"
          role="region"
          aria-label="Bulk actions"
        >
          <span className="text-xs text-white tabular-nums">
            {selected.size} selected
          </span>
          {selectable.actions([...selected], clearSelection)}
          <Button variant="ghost" size="xs" className="ml-auto" onClick={clearSelection}>
            Clear
          </Button>
        </div>
      )}

      {error ? (
        <div className="rounded-md border border-alert/40 bg-alert/5 px-3 py-3 text-sm text-alert">
          {error}
          {onRetry && (
            <Button variant="outline" size="xs" className="ml-3" onClick={onRetry}>
              Try again
            </Button>
          )}
        </div>
      ) : loading && !rows ? (
        <div className="space-y-2" aria-busy="true" aria-label={`Loading ${caption}`}>
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-11 w-full rounded-md" />
          ))}
        </div>
      ) : sorted.length === 0 ? (
        <EmptyState
          icon={empty?.icon ?? Inbox}
          title={empty?.title ?? (q ? 'Nothing matches' : 'Nothing here yet')}
          description={
            empty?.description ?? (q ? 'Try fewer words, or clear the search.' : undefined)
          }
          action={
            empty?.action ??
            (q ? (
              <Button variant="outline" size="sm" onClick={() => setQ('')}>
                Clear search
              </Button>
            ) : undefined)
          }
        />
      ) : (
        <>
          {/* Phones: a card per row, from the same column list. */}
          {showCards && (
            <ul className="space-y-2" aria-label={caption}>
              {sorted.map((row) => {
                const key = rowKey(row);
                const metaCols = visible.filter((c) => c.cardMeta && c !== primary);
                const fields = visible.filter((c) => c !== primary && !c.cardMeta && !c.stopRowClick);
                // Columns that hold their own controls go under the card,
                // outside the button that opens the row — a button never
                // nests inside another.
                const actionCols = visible.filter((c) => c.stopRowClick && c !== primary && c.cell);
                const clickable = Boolean(onRowClick);
                const Body = (
                  <>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-white">
                          {primary.cell ? primary.cell(row) : (primary.accessor(row) ?? '—')}
                        </div>
                        {metaCols.length > 0 && (
                          <div className="mt-0.5 truncate text-xs text-silver/70">
                            {metaCols
                              .map((c) => (c.cell ? null : (c.accessor(row) ?? '')))
                              .filter((v) => v !== null && v !== '')
                              .join(' · ')}
                            {metaCols.filter((c) => c.cell).map((c) => (
                              <span key={c.key} className="mr-2">
                                {c.cell!(row)}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                      {selectable && !selectable.disabled?.(row) && (
                        <input
                          type="checkbox"
                          className="mt-1 h-4 w-4 accent-gold"
                          checked={selected.has(key)}
                          onChange={() => toggleOne(key)}
                          onClick={(e) => e.stopPropagation()}
                          aria-label={`Select ${primary.accessor(row) ?? 'row'}`}
                        />
                      )}
                    </div>
                    {fields.length > 0 && (
                      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
                        {fields.map((c) => (
                          <div key={c.key} className="min-w-0">
                            <dt className="text-2xs uppercase tracking-wider text-silver/50">
                              {c.header}
                            </dt>
                            <dd className={cn('truncate text-xs text-silver', c.className)}>
                              {c.cell ? c.cell(row) : (c.accessor(row) ?? '—')}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </>
                );
                return (
                  <li key={key}>
                    {clickable ? (
                      <button
                        type="button"
                        onClick={() => onRowClick!(row)}
                        aria-label={rowActionLabel?.(row)}
                        className={cn(
                          'w-full rounded-lg border border-navy-secondary bg-navy-secondary/20 p-3 text-left transition-colors hover:border-gold/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright',
                          selected.has(key) && 'border-gold/50',
                        )}
                      >
                        {Body}
                      </button>
                    ) : (
                      <div
                        className={cn(
                          'rounded-lg border border-navy-secondary bg-navy-secondary/20 p-3',
                          selected.has(key) && 'border-gold/50',
                        )}
                      >
                        {Body}
                      </div>
                    )}
                    {actionCols.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap items-center justify-end gap-2 px-1">
                        {actionCols.map((c) => (
                          <React.Fragment key={c.key}>{c.cell!(row)}</React.Fragment>
                        ))}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {/* The table. Scrolls inside its own box only when virtualized. */}
          {!showCards && (
            <div
              ref={scrollRef}
              className={cn(
                virtualize && 'max-h-[70vh] overflow-y-auto rounded-md border border-navy-secondary',
              )}
            >
              <Table caption={caption}>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    {selectable && (
                      <TableHead className="w-8 pr-0">
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-gold"
                          checked={allSelected}
                          onChange={toggleAll}
                          disabled={selectableRows.length === 0}
                          aria-label={allSelected ? 'Clear selection' : 'Select every row'}
                        />
                      </TableHead>
                    )}
                    {visible.map((c) =>
                      c.sortable ? (
                        <SortableTableHead
                          key={c.key}
                          sortKey={c.key}
                          state={sortState}
                          onSort={toggleSort}
                          className={cn(alignClass(c.align), c.className)}
                          style={c.width ? { width: c.width } : undefined}
                        >
                          {c.header}
                        </SortableTableHead>
                      ) : (
                        <TableHead
                          key={c.key}
                          className={cn(alignClass(c.align), c.className)}
                          style={c.width ? { width: c.width } : undefined}
                        >
                          {c.header}
                        </TableHead>
                      ),
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody
                  style={
                    virtualize
                      ? { height: virtualizer.getTotalSize(), position: 'relative', display: 'block' }
                      : undefined
                  }
                >
                  {(virtualize
                    ? virtualizer.getVirtualItems().map((v) => ({ row: sorted[v.index]!, v, group: null }))
                    : groups
                      ? groups.flatMap((g) => [
                          { row: null, v: null, group: g },
                          ...g.rows.map((row) => ({ row, v: null, group: null })),
                        ])
                      : sorted.map((row) => ({ row, v: null, group: null }))
                  ).map(({ row, v, group }) => {
                    if (group) {
                      // A heading row where the group changes — one table, so
                      // a screen reader hears one grid with sections, not
                      // fourteen grids with the same five columns.
                      return (
                        <TableRow key={`group:${group.key}`} className="bg-navy-secondary/30 hover:bg-navy-secondary/30">
                          <TableCell
                            colSpan={visible.length + (selectable ? 1 : 0)}
                            className="py-2 text-xs font-medium text-white"
                          >
                            {groupBy!.header(group.key, group.rows)}
                          </TableCell>
                        </TableRow>
                      );
                    }
                    if (!row) return null;
                    const key = rowKey(row);
                    const isSelected = selected.has(key);
                    return (
                      <TableRow
                        key={key}
                        data-state={isSelected ? 'selected' : undefined}
                        onClick={onRowClick ? () => onRowClick(row) : undefined}
                        aria-label={onRowClick ? rowActionLabel?.(row) : undefined}
                        className={cn(onRowClick && 'cursor-pointer', rowClassName?.(row))}
                        style={
                          v
                            ? {
                                position: 'absolute',
                                top: 0,
                                left: 0,
                                width: '100%',
                                display: 'table',
                                tableLayout: 'fixed',
                                transform: `translateY(${v.start}px)`,
                              }
                            : undefined
                        }
                      >
                        {selectable && (
                          <TableCell className="w-8 pr-0" onClick={(e) => e.stopPropagation()}>
                            {!selectable.disabled?.(row) && (
                              <input
                                type="checkbox"
                                className="h-4 w-4 accent-gold"
                                checked={isSelected}
                                onChange={() => toggleOne(key)}
                                aria-label={`Select ${primary.accessor(row) ?? 'row'}`}
                              />
                            )}
                          </TableCell>
                        )}
                        {visible.map((c) => (
                          <TableCell
                            key={c.key}
                            className={cn(alignClass(c.align), c.className)}
                            onClick={c.stopRowClick ? (e) => e.stopPropagation() : undefined}
                          >
                            {c.cell ? c.cell(row) : (c.accessor(row) ?? <span className="text-silver/50">—</span>)}
                          </TableCell>
                        ))}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
