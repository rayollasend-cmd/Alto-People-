import * as React from 'react';
import { createPortal } from 'react-dom';
import { Link, useInRouterContext, useLocation, useNavigate } from 'react-router-dom';
import { ChevronRight, Columns3, Download, Inbox, MoreHorizontal, type LucideIcon } from 'lucide-react';
import { useVirtualizer, type VirtualItem } from '@tanstack/react-virtual';
import { cn } from '@/lib/cn';
import { downloadCsv } from '@/lib/csv';
import { useDesktopTable, useMinWidth } from '@/lib/useViewport';
import { countSetParams, useUrlWriter } from '@/lib/useUrlState';
import { AuthContext } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { Button } from './Button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
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
 *   select       checkboxes and a bulk-action bar, when asked for;
 *                shift-click a second box to take the whole run between
 *   keyboard     with the table focused (a click on a row does it), j/k
 *                or ↑/↓ move a cursor, Enter opens the row, x selects it
 *   url          ?sort= ?dir= ?q= so a filtered view is a link you can send
 *                (namespaced by `urlKey` when a page has several grids)
 *   phones       a card per row, built from the same column list, instead
 *                of a table that hides itself — and only the layout the
 *                viewport can show is mounted, never both
 *   virtualize   only the visible rows are in the DOM once a list is long
 *   states       skeleton, error, empty and "N of M" are not optional;
 *                an empty list is the empty state alone — no toolbar
 *                chrome over nothing
 *   toolbar      a box when there is a search or filters, a quiet line
 *                when there is only the count; on a phone Columns and
 *                Export fold into one ⋯ and filters into a sheet
 *   groups       one table with heading rows, collapsible when asked
 *   details      a panel under a row, and child rows that travel with
 *                their parent
 *
 * Server-paged lists (audit, statements, the journal) keep their own
 * loaders and hand the loaded page to the grid; the grid never fetches.
 * `server` tells it the real total (the count reads "1,060 entries", not
 * the page size) and lets the page export every match. When the server
 * also sorts, the page owns the sort state and the grid only reports
 * header clicks.
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
  /**
   * What one record is called, for the count line: "12 people" instead of
   * "12 rows". Pass the tenant's words (`{ one: term('worker'), many:
   * term('workers') }`) so the line reads in their language and nouns.
   */
  noun?: { one: string; many: string };
  search?: { placeholder?: string } | false;
  /** Column key to sort by initially. */
  defaultSort?: TableSortState<string>;
  /**
   * Controlled sort — the page owns the order because the server sorted
   * a page of a larger set (the document vault) and re-sorting the page
   * would order the wrong thing. The grid shows the state and reports
   * header clicks; it never reorders the rows it is given.
   */
  sort?: { state: TableSortState<string>; onToggle: (key: string) => void };
  /** Keep sort/search in the URL so the view is shareable. Default true. */
  urlState?: boolean;
  /**
   * Keep this grid's search and sort in the URL under its own names —
   * ?<urlKey>.q= ?<urlKey>.sort= ?<urlKey>.dir= — so a page with several
   * grids (or one that owns ?q= itself) can still link each view. Turns
   * URL state on even where `urlState` was false.
   */
  urlKey?: string;
  /** CSV export of what is on screen. Default on; pass false to disable. */
  exportCsv?: boolean | { filename: string };
  columnChooser?: boolean;
  /**
   * Controlled column visibility — a page that saves its layout in a named
   * view (the clients list) keeps the hidden set itself; the chooser
   * reports toggles. Uncontrolled (kept per grid, per person) otherwise.
   */
  columnsState?: { hidden: ReadonlySet<string>; onChange: (next: Set<string>) => void };
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
    /** The header checkbox's name while nothing is selected — say what
     *  "all" means when only some rows qualify ("Select all 4 waiting for
     *  a van"). Default "Select every row". */
    selectAllLabel?: string;
  };
  onRowClick?: (row: T) => void;
  /**
   * The row IS a link: the primary cell renders an <a> to this path (so
   * open-in-new-tab and middle-click work) and a click anywhere on the row
   * navigates there. Prefer this over `onRowClick={() => navigate(…)}`.
   * Ignored outside a router.
   */
  rowHref?: (row: T) => string;
  /** Label for the row's click affordance, for screen readers. */
  rowActionLabel?: (row: T) => string;
  /** Extra classes on a row (an overdue tint, a highlighted match). */
  rowClassName?: (row: T) => string | undefined;
  /** A DOM id per row, for deep links that scroll to and flash one record. */
  rowId?: (row: T) => string;
  /**
   * A detail panel under a row — a workflow run's steps, an entry's
   * punches. The row gains a chevron, and clicking the row toggles it
   * when nothing else claims the click. `single` keeps one open at a
   * time; `onExpand` fires as a row opens, for a lazy load.
   */
  expandable?: {
    render: (row: T) => React.ReactNode;
    single?: boolean;
    onExpand?: (row: T) => void;
    /** The toggle's screen-reader name. Default "Details for <primary>". */
    label?: (row: T) => string;
  };
  /**
   * Child rows under a parent, drawn with the same columns and indented
   * — a store's shift windows under its day line. They travel with the
   * parent through sort, search and export, and are never selected or
   * expanded themselves.
   */
  subRows?: (row: T) => T[] | undefined;
  /** Rows beyond this count are virtualized. Default 150. */
  virtualizeAfter?: number;
  rowHeight?: number;
  /**
   * What an empty list says. Give every grid one: a title that names what
   * is missing, a description with the next step, and the action that
   * takes it ("No statements yet" · "Finalize a week to send the first
   * one." · [Open this week]). Without it the grid says "No <noun> yet"
   * (from `noun`, else the caption) and nothing more.
   */
  empty?: { icon?: LucideIcon; title: string; description?: React.ReactNode; action?: React.ReactNode };
  /** Under the search: chips, pickers, anything that narrows the rows. On a phone they fold into a "Filters (n)" sheet. */
  filters?: React.ReactNode;
  /**
   * How many of the page's filters are off their default. With 0 (and no
   * rows, no search) the grid shows its empty state alone; above 0 an
   * empty result says "Nothing matches these filters" and offers
   * `onClearFilters`. Unknown (omitted) with `filters` passed counts as in
   * use, so a control that emptied the list is never hidden.
   */
  activeFilters?: number;
  /**
   * The URL params the page's filters keep (useUrlParam keys). The grid
   * counts the set ones as `activeFilters` and clears them all as
   * `onClearFilters`, unless those are passed.
   */
  filterKeys?: readonly string[];
  /** Puts the page's filters back to their defaults (the empty result's "Clear filters"). */
  onClearFilters?: () => void;
  /**
   * Where the count, Columns and Export sit.
   *   'auto' (default) — in the boxed bar when there is a search or
   *                      filters; otherwise on one quiet right-aligned line
   *   'bar'            — always the box
   *   'inline'         — never a box: a grid right under the page's own
   *                      filter row, so there is one tray, not two
   *   { into }         — inside the page's own row: pass the element (from
   *                      a ref callback) the controls render into
   * A page with its own Export passes `exportCsv={false}` so there is one.
   */
  toolbar?: 'auto' | 'bar' | 'inline' | { into: HTMLElement | null };
  /** A note about the list ("capped at 500, narrow the dates"). Drawn under the table. */
  footnote?: React.ReactNode;
  /** The card layout on phones. Default on when the grid has a primary column. */
  cards?: boolean;
  /** Total the rows were drawn from, when the caller only has a page ("500 of 612"). */
  total?: number;
  /**
   * A server-paged list: the rows are one page of `total`. The count reads
   * the real total ("1,060 entries · 1–200 shown"), `onExport` replaces
   * the on-screen CSV with the page's export of every match, and the sort
   * should be the controlled `sort` so header clicks reach the server.
   */
  server?: {
    total: number;
    /** Where this page starts in the total (0-based). Default 0. */
    offset?: number;
    /** Export every match, not just this page. */
    onExport?: () => void;
  };
  /**
   * Row grouping — one table, with a heading row where the group changes
   * (the audit log by day, a roster by store). Groups keep the sorted
   * order of their first row; search filters across all of them; export
   * flattens them. Virtualization is off while grouping is on.
   * `collapsible` turns each heading into a toggle; `defaultOpen` says
   * which groups start open (the first day, every day this week).
   */
  groupBy?: {
    key: (row: T) => string;
    /** The heading for a group, given its key and the rows in it. */
    header: (key: string, rows: T[]) => React.ReactNode;
    collapsible?: { defaultOpen: (key: string, index: number) => boolean };
  };
  className?: string;
  /** j/k ↑/↓ Enter x on the focused table. Default on; false for a grid
   *  whose page already drives the rows with its own keys. */
  keyboard?: boolean;
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
 * Inside a router with `urlState` on (or a `urlKey`), they live in ?q=
 * ?sort= ?dir= (or ?<urlKey>.q= …) so a narrowed view is a link you can
 * send. Anywhere else — a page that owns those params itself, a preview, a
 * test with no router — they live in component state. The split is two
 * thin shells around one body, because a hook cannot be called
 * conditionally and a list primitive must render in every context the app
 * has.
 */
export function DataGrid<T>(props: DataGridProps<T>) {
  const inRouter = useInRouterContext();
  if (inRouter) return <RoutedGrid {...props} />;
  return <LocalStateGrid {...props} />;
}

/** How long the search box waits before the URL follows it. */
const URL_WRITE_DELAY_MS = 300;

function RoutedGrid<T>(props: DataGridProps<T>) {
  const location = useLocation();
  const navigate = useNavigate();
  // `rowHref` makes the whole row navigate; an explicit onRowClick wins.
  const rowHref = props.rowHref;
  const onRowClick = props.onRowClick ?? (rowHref ? (row: T) => navigate(rowHref(row)) : undefined);
  const write = useUrlWriter();
  const urlOn = Boolean(props.urlKey) || props.urlState !== false;
  const prefix = props.urlKey ? `${props.urlKey}.` : '';
  const qKey = `${prefix}q`;
  const sortParam = `${prefix}sort`;
  const dirParam = `${prefix}dir`;
  const params = React.useMemo(() => new URLSearchParams(location.search), [location.search]);
  const urlQ = urlOn ? (params.get(qKey) ?? '') : '';
  // The box answers at once; the URL follows a beat later, and only when
  // it has actually changed. Writing on every keystroke was one
  // history.replaceState per character — Safari allows a hundred in ten
  // seconds for the whole page — and the rows never needed the URL to
  // filter. Back/forward (or a link) still seeds the box from the URL.
  const [q, setLocalQ] = React.useState(urlQ);
  const mirrored = React.useRef(urlQ);
  React.useEffect(() => {
    if (!urlOn || urlQ === mirrored.current) return;
    mirrored.current = urlQ;
    setLocalQ(urlQ);
  }, [urlQ, urlOn]);
  React.useEffect(() => {
    if (!urlOn || q === mirrored.current) return;
    const timer = window.setTimeout(() => {
      mirrored.current = q;
      write((p) => {
        if (q) p.set(qKey, q);
        else p.delete(qKey);
      });
    }, URL_WRITE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [q, urlOn, qKey, write]);
  const setQ = React.useCallback((next: string) => setLocalQ(next), []);
  const sortKey = urlOn ? params.get(sortParam) : null;
  const sortDir = urlOn ? params.get(dirParam) : null;
  const initialSort = React.useMemo<TableSortState<string> | undefined>(() => {
    if (!sortKey || !props.columns.some((c) => c.key === sortKey)) return undefined;
    return { key: sortKey, direction: sortDir === 'desc' ? 'desc' : 'asc' };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortKey, sortDir]);
  const onSortChange = React.useCallback(
    (s: TableSortState<string>) => {
      write((p) => {
        if (s.key) {
          p.set(sortParam, s.key);
          p.set(dirParam, s.direction);
        } else {
          p.delete(sortParam);
          p.delete(dirParam);
        }
      });
    },
    [write, sortParam, dirParam],
  );
  // Filters the page keeps in the URL: a set param is a filter in use
  // (useUrlParam never writes a default), and clearing is one write.
  const filterKeys = props.filterKeys;
  const keyedActive = filterKeys ? countSetParams(location.search, filterKeys) : undefined;
  const clearKeyed = React.useCallback(() => {
    if (!filterKeys) return;
    write((p) => {
      for (const k of filterKeys) p.delete(k);
    });
  }, [filterKeys, write]);
  return (
    <GridCore
      {...props}
      onRowClick={onRowClick}
      activeFilters={props.activeFilters ?? keyedActive}
      onClearFilters={props.onClearFilters ?? (filterKeys ? clearKeyed : undefined)}
      q={q}
      setQ={setQ}
      initialSort={urlOn ? initialSort : undefined}
      onSortChange={urlOn ? onSortChange : undefined}
    />
  );
}

function LocalStateGrid<T>(props: DataGridProps<T>) {
  const [q, setQ] = React.useState('');
  // No router here: a row link has nowhere to go, so the grid stays inert.
  return <GridCore {...props} rowHref={undefined} q={q} setQ={setQ} />;
}

/**
 * "No staff yet" from a noun or a caption. The first letter drops to lower
 * case unless the first word is an acronym or a brand (COBRA, J-1,
 * WhatsApp), which keep their capitals.
 */
function emptyPhrase(caption: string): string {
  const first = caption.split(/\s+/)[0] ?? '';
  const keepCase = /\d/.test(first) || (first.length > 1 && first.slice(1) !== first.slice(1).toLowerCase());
  return keepCase || !caption ? caption : caption[0]!.toLowerCase() + caption.slice(1);
}

/** One line of the table body, in the order it is drawn. */
type GridItem<T> =
  | { kind: 'group'; group: { key: string; rows: T[] }; v?: VirtualItem | null }
  | { kind: 'row'; row: T; child: boolean; v: VirtualItem | null }
  | { kind: 'detail'; row: T; v?: VirtualItem | null };

function GridCore<T>({
  id,
  rows,
  columns,
  rowKey,
  loading = false,
  error = null,
  onRetry,
  caption,
  noun,
  search = {},
  defaultSort,
  sort,
  exportCsv = true,
  columnChooser = true,
  columnsState,
  selectable,
  onRowClick,
  rowHref,
  rowActionLabel,
  rowClassName,
  rowId,
  expandable,
  subRows,
  virtualizeAfter = 150,
  rowHeight = 48,
  empty,
  filters,
  activeFilters,
  onClearFilters,
  toolbar = 'auto',
  footnote,
  cards,
  total,
  server,
  groupBy,
  className,
  keyboard = true,
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
  // Works without a provider (English), so the grid still renders anywhere.
  const { t, lang } = useI18n();

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

  // The hook always runs; a controlled sort simply ignores what it did
  // and keeps the rows in the order they arrived.
  const own = useTableSort(searched, accessors, initialSort ?? defaultSort);
  const sorted = sort ? searched : own.sorted;
  const sortState = sort ? sort.state : own.sortState;
  const toggleSort = sort ? sort.onToggle : own.toggleSort;

  // Tell the shell when the sort changes here, so the URL follows. It is
  // one direction per event — the shell seeds the initial sort, this
  // reports the rest — so it can never loop. A controlled sort is the
  // page's to keep wherever it likes.
  const lastReported = React.useRef<string>('');
  React.useEffect(() => {
    if (!onSortChange || sort) return;
    const sig = `${sortState.key ?? ''}|${sortState.direction}`;
    if (sig === lastReported.current) return;
    if (lastReported.current === '' && !sortState.key) {
      // First render with nothing sorted: nothing to report.
      lastReported.current = sig;
      return;
    }
    lastReported.current = sig;
    onSortChange(sortState);
  }, [sortState, onSortChange, sort]);

  /* ---- column visibility ------------------------------------------- */
  const [ownHidden, setHidden] = React.useState<Set<string>>(() => {
    const stored = typeof window !== 'undefined' ? readHidden(id, userId) : null;
    if (stored) return stored;
    return new Set(columns.filter((c) => c.defaultHidden).map((c) => c.key));
  });
  const hidden: ReadonlySet<string> = columnsState ? columnsState.hidden : ownHidden;
  const toggleColumn = (key: string) => {
    if (columnsState) {
      const next = new Set(columnsState.hidden);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      columnsState.onChange(next);
      return;
    }
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
  // The shift-click anchor. Select-all, clear and a re-sort start it over.
  const lastPicked = React.useRef<string | null>(null);
  const allSelected = selectableRows.length > 0 && selectableRows.every((r) => selected.has(rowKey(r)));
  // Union and difference, never replace: a controlled selection may span
  // several grids (renew across every expiry bucket), and this grid's
  // header box must only ever add or remove ITS rows from that choice.
  const toggleAll = () => {
    lastPicked.current = null;
    setSelected((prev) => {
      const next = new Set(prev);
      const mine = selectableRows.map(rowKey);
      if (allSelected) for (const k of mine) next.delete(k);
      else for (const k of mine) next.add(k);
      return next;
    });
  };
  const toggleOne = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  // Shift-click a second box: every selectable row between the two takes
  // the state the clicked one is moving to — the way a mail client works.
  // "Between" is as drawn: group order, and never a row in a folded group.
  const pick = (key: string, shift: boolean) => {
    const anchor = lastPicked.current;
    lastPicked.current = key;
    if (!shift || !anchor || anchor === key) return toggleOne(key);
    const order = navRows.filter((r) => !selectable?.disabled?.(r.row)).map((r) => r.key);
    const a = order.indexOf(anchor);
    const b = order.indexOf(key);
    if (a === -1 || b === -1) return toggleOne(key);
    const on = !selected.has(key);
    setSelected((prev) => {
      const next = new Set(prev);
      for (const k of order.slice(Math.min(a, b), Math.max(a, b) + 1)) {
        if (on) next.add(k);
        else next.delete(k);
      }
      return next;
    });
  };
  const shiftOf = (e: React.SyntheticEvent) => (e.nativeEvent as MouseEvent).shiftKey === true;
  const clearSelection = () => {
    lastPicked.current = null;
    setSelected(new Set());
  };
  React.useEffect(() => {
    lastPicked.current = null;
  }, [sortState.key, sortState.direction]);
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

  /* ---- details ------------------------------------------------------ */
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(new Set());
  const toggleExpand = (row: T) => {
    const k = rowKey(row);
    const opening = !expanded.has(k);
    setExpanded((prev) => {
      const next = expandable?.single ? new Set<string>() : new Set(prev);
      if (opening) next.add(k);
      else next.delete(k);
      return next;
    });
    if (opening) expandable?.onExpand?.(row);
  };
  const detailLabel = (row: T) => expandable?.label?.(row) ?? `Details for ${primaryOf(columns).accessor(row) ?? 'row'}`;

  /* ---- export -------------------------------------------------------- */
  const withChildren = (list: T[]) => (subRows ? list.flatMap((r) => [r, ...(subRows(r) ?? [])]) : list);
  const exportRows = () => {
    const head = visible.map((c) => c.header);
    const body = withChildren(sorted).map((r) => visible.map((c) => (c.csv ?? c.accessor)(r) ?? ''));
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
  // Which groups are folded. Until the reader touches one, `defaultOpen`
  // decides; after that their choice stands, and a group that appears
  // later (a refresh brought a new day) starts open.
  const collapsible = groupBy?.collapsible;
  const [closedGroups, setClosedGroups] = React.useState<ReadonlySet<string> | null>(null);
  const closed = React.useMemo<ReadonlySet<string>>(() => {
    if (!collapsible || !groups) return new Set();
    if (closedGroups) return closedGroups;
    return new Set(groups.filter((g, i) => !collapsible.defaultOpen(g.key, i)).map((g) => g.key));
  }, [collapsible, groups, closedGroups]);
  const toggleGroup = (key: string) => {
    const next = new Set(closed);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setClosedGroups(next);
  };
  const groupHeading = (g: { key: string; rows: T[] }) =>
    collapsible ? (
      <button
        type="button"
        aria-expanded={!closed.has(g.key)}
        onClick={() => toggleGroup(g.key)}
        className="flex w-full items-center gap-2 rounded text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
      >
        <ChevronRight
          className={cn('h-4 w-4 shrink-0 text-silver transition-transform', !closed.has(g.key) && 'rotate-90')}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1">{groupBy!.header(g.key, g.rows)}</span>
      </button>
    ) : (
      groupBy!.header(g.key, g.rows)
    );

  const scrollRef = React.useRef<HTMLDivElement>(null);

  /* ---- phones: cards ------------------------------------------------- */
  const primary = primaryOf(columns);
  const useCards = cards ?? Boolean(primary);
  // Mount the table OR the cards, never both. Hiding the inactive one
  // with CSS still commits every row twice — on a large directory that
  // was ~9,000 dead DOM nodes — so the breakpoint is read in JS and the
  // other layout is not rendered at all.
  const desktop = useDesktopTable();
  const showCards = useCards && !desktop;

  // "12 people", or "12 rows" when the grid was given no noun; "12 of 40"
  // while a search or a capped list narrows the set. A server-paged list
  // reads its real total ("1,060 entries · 1–200 shown"), not the page
  // size. Numbers format in the person's language, never a hard-coded en-US.
  const countLine = (() => {
    const n = sorted.length;
    const loaded = rows?.length ?? n;
    const amount = (k: number, nounWord: string | null) =>
      nounWord
        ? t('grid.count', { count: k.toLocaleString(lang), noun: nounWord })
        : k === 1
          ? t('grid.rowsOne', { count: k.toLocaleString(lang) })
          : t('grid.rowsMany', { count: k.toLocaleString(lang) });
    if (server) {
      const all = Math.max(server.total, loaded);
      const word = noun ? (all === 1 ? noun.one : noun.many) : null;
      if (n !== loaded) {
        // A search inside the loaded page: say it only searched what's loaded.
        return t('grid.countLoaded', { count: n.toLocaleString(lang), loaded: loaded.toLocaleString(lang) });
      }
      if (loaded >= all) return amount(all, word);
      const from = (server.offset ?? 0) + (loaded > 0 ? 1 : 0);
      const to = (server.offset ?? 0) + loaded;
      return t('grid.countPage', { total: amount(all, word), from: from.toLocaleString(lang), to: to.toLocaleString(lang) });
    }
    const of = total ?? loaded;
    const count = n.toLocaleString(lang);
    const nounWord = noun ? (of === 1 && n === of ? noun.one : noun.many) : null;
    if (n === of) return amount(n, nounWord);
    const totalText = of.toLocaleString(lang);
    return nounWord
      ? t('grid.countOfNoun', { count, total: totalText, noun: nounWord })
      : t('grid.countOf', { count, total: totalText });
  })();

  const alignClass = (a?: GridAlign) => (a === 'right' ? 'text-right' : a === 'center' ? 'text-center' : '');

  /* ---- the body, in drawing order ------------------------------------ */
  const leadCols = (selectable ? 1 : 0) + (expandable ? 1 : 0);
  const colSpan = visible.length + leadCols;
  const withDetails = (row: T): GridItem<T>[] => {
    const out: GridItem<T>[] = [{ kind: 'row', row, child: false, v: null }];
    for (const c of subRows?.(row) ?? []) out.push({ kind: 'row', row: c, child: true, v: null });
    if (expandable && expanded.has(rowKey(row))) out.push({ kind: 'detail', row });
    return out;
  };
  // Everything the body draws, in order — group headings, rows, sub-rows,
  // open details. Long lists window over THIS list, so a grouped roster or
  // an expandable payroll run stays fast at 5,000 rows too.
  const flat: GridItem<T>[] = groups
    ? groups.flatMap((g) => [
        { kind: 'group', group: g } as GridItem<T>,
        ...(closed.has(g.key) ? [] : g.rows.flatMap(withDetails)),
      ])
    : sorted.flatMap(withDetails);

  /* ---- virtualization ----------------------------------------------- */
  const virtualize = flat.length > virtualizeAfter;
  const virtualizer = useVirtualizer({
    count: virtualize ? flat.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
  });
  // The rows stay ORDINARY table rows. The first cut made the <tbody>
  // `display:block` and each row `position:absolute` at a fixed 48px pitch;
  // Chromium wraps a block tbody in an anonymous cell in column 1, so the
  // whole body rendered 32px wide and every row taller than the estimate
  // overlapped the next (the "Users & access collapsed" bug). Instead, two
  // spacer rows hold the place of the rows above and below the window, and
  // every rendered row reports its real height back to the virtualizer.
  const vItems = virtualize ? virtualizer.getVirtualItems() : [];
  const padTop = vItems.length ? vItems[0]!.start : 0;
  const padBottom = vItems.length ? virtualizer.getTotalSize() - vItems[vItems.length - 1]!.end : 0;
  const items: GridItem<T>[] = virtualize ? vItems.map((v) => ({ ...flat[v.index]!, v }) as GridItem<T>) : flat;

  /* ---- keyboard ------------------------------------------------------ */
  // A cursor over the top-level rows. Rows that open are focusable already
  // (TableRow), so the cursor is the focused row and moving it moves focus;
  // a selectable list whose rows don't open makes the table box focusable
  // instead. Keys aimed at a control inside a row — a checkbox, a button, a
  // field — stay that control's.
  const [cursor, setCursor] = React.useState<string | null>(null);
  const rowsOpen = Boolean(onRowClick || expandable);
  const boxFocusable = keyboard && !rowsOpen && Boolean(selectable);
  const navRows = flat.flatMap((it, index) => (it.kind === 'row' && !it.child ? [{ key: rowKey(it.row), row: it.row, index }] : []));
  const cursorAt = cursor ? navRows.findIndex((r) => r.key === cursor) : -1;
  const rowEl = (box: HTMLElement, key: string) =>
    [...box.querySelectorAll<HTMLElement>('[data-grid-row]')].find((el) => el.getAttribute('data-grid-row') === key);
  const onGridFocus = (e: React.FocusEvent<HTMLDivElement>) => {
    const k = (e.target as HTMLElement).getAttribute?.('data-grid-row');
    if (k) setCursor(k);
  };
  const onGridKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const onRow = target.hasAttribute?.('data-grid-row');
    if (e.defaultPrevented || (target !== e.currentTarget && !onRow) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (navRows.length === 0) return;
    const box = e.currentTarget;
    const go = (i: number) => {
      e.preventDefault();
      // The grid's cursor, not a page-wide list cursor as well (useListKeyboard listens on window).
      e.stopPropagation();
      const r = navRows[Math.max(0, Math.min(navRows.length - 1, i))]!;
      setCursor(r.key);
      // A windowed row may need a frame or two to be drawn after the jump
      // (End on a long list); until it is, focus stays in the box.
      const land = (tries = 0) => {
        const el = rowEl(box, r.key);
        if (!el && virtualize && tries < 3) {
          requestAnimationFrame(() => land(tries + 1));
          return;
        }
        if (rowsOpen) (el ?? box).focus({ preventScroll: false });
        else el?.scrollIntoView?.({ block: 'nearest' });
      };
      if (virtualize) {
        virtualizer.scrollToIndex(r.index, { align: 'auto' });
        requestAnimationFrame(() => land());
      } else land();
    };
    const current = cursorAt >= 0 ? navRows[cursorAt]! : null;
    // Shift (x for a range) and Caps Lock arrive upper-case.
    switch (e.key.length === 1 ? e.key.toLowerCase() : e.key) {
      case 'j':
      case 'ArrowDown':
        return go(cursorAt + 1);
      case 'k':
      case 'ArrowUp':
        return go(cursorAt <= 0 ? 0 : cursorAt - 1);
      case 'Home':
        return go(0);
      case 'End':
        return go(navRows.length - 1);
      case 'Enter':
        // A focused row opens itself (TableRow); this is the box's cursor.
        if (!current || onRow) return;
        e.preventDefault();
        if (onRowClick) onRowClick(current.row);
        else if (expandable) toggleExpand(current.row);
        return;
      case 'x':
        if (!current || !selectable || selectable.disabled?.(current.row)) return;
        e.preventDefault();
        pick(current.key, e.shiftKey);
        return;
      case 'Escape':
        if (cursor) setCursor(null);
        return;
      default:
        return;
    }
  };

  /* ---- one card ------------------------------------------------------ */
  // Finance walk 20: on a phone every column keeps its label. A cell that
  // holds its own control (stopRowClick) but has a header — a readiness ✗
  // link, a status toggle — is a labelled pair inside the card like any
  // other field; only a true actions column (no header, or keyed
  // "actions") goes to the card's footer, still inside its border.
  const isActionCol = (c: GridColumn<T>) => Boolean(c.stopRowClick) && (!String(c.header ?? '').trim() || c.key === 'actions');
  const cardBody = (row: T, child: boolean) => {
    const key = rowKey(row);
    const metaCols = visible.filter((c) => c.cardMeta && c !== primary);
    const fields = visible.filter((c) => c !== primary && !c.cardMeta && !isActionCol(c));
    return (
      <>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            {/* Cards wrap rather than truncate: a nowrap cell
                ("Today · 2:00 PM – 10:00 PM") inside an
                overflow-hidden line still measures past a
                phone's edge, and the overflow guard is right
                to call that an escape. */}
            <div className={cn('min-w-0 break-words font-medium text-white', child ? 'text-xs' : 'text-sm')}>
              {primary.cell ? primary.cell(row) : (primary.accessor(row) ?? '—')}
            </div>
            {metaCols.length > 0 && (
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-silver/70">
                {(() => {
                  const text = metaCols
                    .map((c) => (c.cell ? null : (c.accessor(row) ?? '')))
                    .filter((v) => v !== null && v !== '')
                    .join(' · ');
                  return text ? <span className="min-w-0 break-words">{text}</span> : null;
                })()}
                {metaCols.filter((c) => c.cell).map((c) => (
                  <span key={c.key} className="min-w-0 break-words [&_*]:whitespace-normal">
                    {c.cell!(row)}
                  </span>
                ))}
              </div>
            )}
          </div>
          {selectable && !child && !selectable.disabled?.(row) && (
            <input
              type="checkbox"
              className="mt-0.5 h-6 w-6 shrink-0 accent-gold"
              checked={selected.has(key)}
              onChange={(e) => pick(key, shiftOf(e))}
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
                <dd className={cn('min-w-0 break-words text-xs text-silver [&_*]:whitespace-normal', c.className)}>
                  {c.cell ? c.cell(row) : (c.accessor(row) ?? '—')}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </>
    );
  };

  const renderCard = (row: T) => {
    const key = rowKey(row);
    // The row's actions go in the card's footer: inside its border, above
    // the open-row overlay — a button never nests inside another.
    const actionCols = visible.filter((c) => isActionCol(c) && c !== primary && c.cell);
    const clickable = Boolean(onRowClick);
    const isOpen = Boolean(expandable) && expanded.has(key);
    const children = subRows?.(row) ?? [];
    return (
      <li key={key} id={rowId?.(row)}>
        <div
          className={cn(
            'relative rounded-lg border border-navy-secondary bg-navy-secondary/20 p-3',
            selected.has(key) && 'border-gold/50',
          )}
        >
          {/* The open-row control is laid over the card, not
              wrapped around it: a button that contained the
              manager link or the row checkbox was a control
              nested in a control. Plain text lets a tap fall
              through to the overlay; anything interactive in
              the card keeps its own hit area above it. */}
          <div
            className={cn(
              clickable &&
                'relative z-10 pointer-events-none [&_a]:pointer-events-auto [&_button]:pointer-events-auto [&_input]:pointer-events-auto [&_select]:pointer-events-auto [&_textarea]:pointer-events-auto [&_label]:pointer-events-auto',
            )}
          >
            {cardBody(row, false)}
          </div>
          {clickable && (
            <button
              type="button"
              onClick={() => onRowClick!(row)}
              aria-label={rowActionLabel?.(row) ?? `Open ${primary.accessor(row) ?? 'row'}`}
              className="absolute -inset-px rounded-lg transition-shadow hover:ring-1 hover:ring-inset hover:ring-gold/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
            />
          )}
          {(actionCols.length > 0 || expandable) && (
          <div className="relative z-10 mt-2 flex flex-wrap items-center justify-end gap-2 border-t border-navy-secondary pt-2" data-card-footer="">
            {expandable && (
              <Button
                variant="ghost"
                size="xs"
                aria-expanded={isOpen}
                aria-label={detailLabel(row)}
                onClick={() => toggleExpand(row)}
                className="mr-auto"
              >
                <ChevronRight
                  className={cn('h-3.5 w-3.5 transition-transform', isOpen && 'rotate-90')}
                  aria-hidden="true"
                />
                Details
              </Button>
            )}
            {actionCols.map((c) => (
              <React.Fragment key={c.key}>{c.cell!(row)}</React.Fragment>
            ))}
          </div>
          )}
        </div>
        {children.length > 0 && (
          <ul className="ml-3 mt-1.5 space-y-1.5 border-l border-navy-secondary pl-2" aria-label={`Under ${primary.accessor(row) ?? 'row'}`}>
            {children.map((c) => (
              <li key={rowKey(c)} className="rounded-md bg-navy-secondary/10 p-2">
                {cardBody(c, true)}
              </li>
            ))}
          </ul>
        )}
        {isOpen && (
          <div className="mt-1.5 rounded-lg border border-navy-secondary bg-navy-secondary/20 p-3">
            {expandable!.render(row)}
          </div>
        )}
      </li>
    );
  };

  /* ---- toolbar ---------------------------------------------------------- */
  // Below sm, Columns and Export fold into one ⋯ so neither wraps onto a
  // row of its own; below md the filters fold behind "Filters (n)".
  const wide = useMinWidth(640);
  const hasRows = (rows?.length ?? 0) > 0;
  const searching = q.trim() !== '';
  // Unknown (filters passed, count not) counts as in use: never hide the
  // control that may be what emptied the list.
  const filtersOn = activeFilters != null ? activeFilters > 0 : Boolean(filters);
  const firstLoad = loading && !rows;
  // An empty list is the empty state alone: no search box, no "0 rows", no
  // disabled Export over nothing.
  const showToolbar = hasRows || searching || filtersOn || (firstLoad && !error);
  const exportAction = server?.onExport ?? (exportCsv ? exportRows : null);
  const canChooseColumns = columnChooser && columns.some((c) => !c.primary) && !showCards;
  const anyShown = sorted.length > 0;
  const columnItems = columns.map((c) => (
    <DropdownMenuCheckboxItem
      key={c.key}
      checked={c.primary || !hidden.has(c.key)}
      disabled={c.primary}
      onCheckedChange={() => toggleColumn(c.key)}
      onSelect={(e) => e.preventDefault()}
    >
      {c.header}
    </DropdownMenuCheckboxItem>
  ));
  const controls = !anyShown ? null : wide ? (
    <>
      {canChooseColumns && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="xs" aria-label={t('grid.chooseColumns')}>
              <Columns3 className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="ml-1">{t('common.columns')}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[12rem]">
            <DropdownMenuLabel>{t('common.columns')}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {columnItems}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {exportAction && (
        <Button
          variant="outline"
          size="xs"
          onClick={exportAction}
          aria-label={t('grid.exportAria', { caption })}
          title={t('grid.exportTitle')}
        >
          <Download className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="ml-1">{t('common.export')}</span>
        </Button>
      )}
    </>
  ) : exportAction || canChooseColumns ? (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon-sm" aria-label={t('grid.moreAria', { caption })}>
          <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[12rem]">
        {exportAction && (
          <DropdownMenuItem onSelect={() => exportAction()} aria-label={t('grid.exportAria', { caption })}>
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            {t('grid.exportCsv')}
          </DropdownMenuItem>
        )}
        {canChooseColumns && (
          <>
            {exportAction && <DropdownMenuSeparator />}
            <DropdownMenuLabel>{t('common.columns')}</DropdownMenuLabel>
            {columnItems}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null;
  const searchBox =
    search !== false ? (
      <SearchInput
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={search?.placeholder ?? t('common.search')}
        aria-label={t('grid.searchAria', { caption })}
      />
    ) : undefined;
  const countText = firstLoad ? t('common.loading') : countLine;
  const into = typeof toolbar === 'object' ? toolbar.into : undefined;
  const boxed = toolbar === 'bar' || (toolbar === 'auto' && (search !== false || Boolean(filters)));
  const toolbarNode = !showToolbar ? null : into !== undefined ? (
    // Inside the page's own row: no tray of ours. Nothing until the row exists.
    into ? (
      createPortal(
        <>
          {searchBox}
          {filters}
          <span className="ml-auto text-xs tabular-nums text-ink-muted" aria-live="polite">
            {countText}
          </span>
          {controls}
        </>,
        into,
      )
    ) : null
  ) : (
    <FilterBar
      bare={!boxed}
      data-grid-toolbar={boxed ? 'bar' : 'line'}
      className={!boxed ? 'justify-end' : undefined}
      search={searchBox}
      count={<span aria-live="polite">{countText}</span>}
      actions={controls}
      collapse={Boolean(filters)}
      activeFilters={activeFilters}
      onClearFilters={onClearFilters}
    >
      {filters}
    </FilterBar>
  );

  /* ---- render ---------------------------------------------------------- */
  return (
    <div className={cn('space-y-3', className)}>
      {toolbarNode}

      {selectable?.actions && selected.size > 0 && (
        <div
          className="flex flex-wrap items-center gap-2 rounded-md border border-gold/40 bg-gold/5 px-3 py-2"
          role="region"
          aria-label={t('grid.bulkActions')}
        >
          <span className="text-xs text-white tabular-nums">
            {t('grid.selected', { count: selected.size.toLocaleString(lang) })}
          </span>
          {selectable.actions([...selected], clearSelection)}
          <Button variant="ghost" size="xs" className="ml-auto" onClick={clearSelection}>
            {t('common.clear')}
          </Button>
        </div>
      )}

      {error ? (
        <div className="rounded-md border border-alert/40 bg-alert/5 px-3 py-3 text-sm text-alert">
          {error}
          {onRetry && (
            <Button variant="outline" size="xs" className="ml-3" onClick={onRetry}>
              {t('common.tryAgain')}
            </Button>
          )}
        </div>
      ) : loading && !rows ? (
        <div className="space-y-2" aria-busy="true" aria-label={t('grid.loadingAria', { caption })}>
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-11 w-full rounded-md" />
          ))}
        </div>
      ) : sorted.length === 0 ? (
        searching ? (
          // The search emptied it: say so, and offer the way back.
          <EmptyState
            icon={empty?.icon ?? Inbox}
            title={t('grid.noMatchTitle')}
            description={t('grid.noMatchDesc')}
            action={
              <Button variant="outline" size="sm" onClick={() => setQ('')}>
                {t('grid.clearSearch')}
              </Button>
            }
          />
        ) : !hasRows && filtersOn && activeFilters != null ? (
          // The page's filters emptied it.
          <EmptyState
            icon={empty?.icon ?? Inbox}
            title={t('grid.noFilterMatchTitle')}
            description={t('grid.noFilterMatchDesc')}
            action={
              onClearFilters ? (
                <Button variant="outline" size="sm" onClick={onClearFilters}>
                  {t('grid.clearFilters')}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <EmptyState
            icon={empty?.icon ?? Inbox}
            title={empty?.title ?? t('grid.emptyNoun', { noun: emptyPhrase(noun?.many ?? caption) })}
            description={empty?.description}
            action={empty?.action}
          />
        )
      ) : (
        <>
          {/* Phones: a card per row, from the same column list. */}
          {showCards && (
            <ul className="space-y-2" aria-label={caption}>
              {(groups ?? [{ key: '', rows: sorted }]).map((g) => (
                <React.Fragment key={groups ? `group:${g.key}` : 'all'}>
                  {groups && (
                    <li className="pt-2 text-xs font-medium text-white">{groupHeading(g)}</li>
                  )}
                  {(!groups || !closed.has(g.key)) && g.rows.map(renderCard)}
                </React.Fragment>
              ))}
            </ul>
          )}

          {/* The table. Scrolls inside its own box only when virtualized —
              and then the box is the ONLY scrollport, so the sticky header
              stays put instead of scrolling away with the rows. */}
          {/* A table worked from its box (rows that don't open) has no
              focused row to announce — say where the cursor is. */}
          {!showCards && boxFocusable && (
            <span className="sr-only" role="status" aria-live="polite">
              {cursorAt >= 0 && primary
                ? t('grid.cursorAt', { n: cursorAt + 1, total: navRows.length, label: String(primary.accessor(navRows[cursorAt]!.row) ?? '') })
                : ''}
            </span>
          )}
          {!showCards && (
            <div
              ref={scrollRef}
              tabIndex={boxFocusable ? 0 : undefined}
              onKeyDown={keyboard ? onGridKey : undefined}
              onFocus={keyboard ? onGridFocus : undefined}
              onBlur={keyboard ? (e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setCursor(null) : undefined}
              role={boxFocusable ? 'group' : undefined}
              aria-label={boxFocusable ? t('grid.keysAria', { caption }) : undefined}
              className={cn(
                virtualize && 'max-h-[70vh] overflow-auto rounded-md border border-navy-secondary',
                boxFocusable && 'rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright/60',
              )}
            >
              <Table caption={caption} wrapperClassName={virtualize ? 'overflow-visible' : undefined}>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    {selectable && (
                      <TableHead className="w-8 pr-0">
                        <input
                          type="checkbox"
                          className="h-6 w-6 accent-gold"
                          checked={allSelected}
                          onChange={toggleAll}
                          disabled={selectableRows.length === 0}
                          aria-label={allSelected ? 'Clear selection' : (selectable.selectAllLabel ?? 'Select every row')}
                        />
                      </TableHead>
                    )}
                    {expandable && (
                      <TableHead className="w-8 pr-0">
                        <span className="sr-only">Details</span>
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
                <TableBody>
                  {padTop > 0 && (
                    <tr aria-hidden="true" style={{ height: padTop }}>
                      <td colSpan={colSpan} className="p-0" />
                    </tr>
                  )}
                  {items.map((item) => {
                    if (item.kind === 'group') {
                      // A heading row where the group changes — one table, so
                      // a screen reader hears one grid with sections, not
                      // fourteen grids with the same five columns.
                      return (
                        <TableRow
                          key={`group:${item.group.key}`}
                          className="bg-navy-secondary/30 hover:bg-navy-secondary/30"
                          data-index={item.v ? item.v.index : undefined}
                          ref={item.v ? virtualizer.measureElement : undefined}
                        >
                          <TableCell colSpan={colSpan} className="py-2 text-xs font-medium text-white">
                            {groupHeading(item.group)}
                          </TableCell>
                        </TableRow>
                      );
                    }
                    if (item.kind === 'detail') {
                      return (
                        <TableRow
                          key={`${rowKey(item.row)}:detail`}
                          className="hover:bg-transparent"
                          data-index={item.v ? item.v.index : undefined}
                          ref={item.v ? virtualizer.measureElement : undefined}
                        >
                          <TableCell colSpan={colSpan} className="bg-navy-secondary/20 p-3">
                            {expandable!.render(item.row)}
                          </TableCell>
                        </TableRow>
                      );
                    }
                    const { row, child, v } = item;
                    const key = rowKey(row);
                    const isSelected = !child && selected.has(key);
                    const isOpen = !child && Boolean(expandable) && expanded.has(key);
                    const rowClick = child
                      ? undefined
                      : onRowClick
                        ? () => onRowClick(row)
                        : expandable
                          ? () => toggleExpand(row)
                          : undefined;
                    return (
                      <TableRow
                        key={child ? `${key}:child` : key}
                        id={child ? undefined : rowId?.(row)}
                        data-state={isSelected ? 'selected' : undefined}
                        data-grid-row={child ? undefined : key}
                        data-kb-cursor={!child && cursor === key ? 'true' : undefined}
                        onClick={rowClick}
                        aria-label={onRowClick && !child ? rowActionLabel?.(row) : undefined}
                        aria-expanded={expandable && !child ? isOpen : undefined}
                        className={cn(
                          rowClick && 'cursor-pointer',
                          child && 'bg-navy-secondary/[0.15] text-xs text-silver',
                          !child && rowClassName?.(row),
                        )}
                        data-index={v ? v.index : undefined}
                        ref={v ? virtualizer.measureElement : undefined}
                      >
                        {selectable && (
                          <TableCell className="w-8 pr-0" onClick={(e) => e.stopPropagation()}>
                            {!child && !selectable.disabled?.(row) && (
                              <input
                                type="checkbox"
                                className="h-6 w-6 accent-gold"
                                checked={isSelected}
                                onChange={(e) => pick(key, shiftOf(e))}
                                aria-label={`Select ${primary.accessor(row) ?? 'row'}`}
                              />
                            )}
                          </TableCell>
                        )}
                        {expandable && (
                          <TableCell className="w-8 pr-0" onClick={(e) => e.stopPropagation()}>
                            {!child && (
                              <button
                                type="button"
                                aria-expanded={isOpen}
                                aria-label={detailLabel(row)}
                                onClick={() => toggleExpand(row)}
                                className="rounded p-0.5 text-silver hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
                              >
                                <ChevronRight
                                  className={cn('h-4 w-4 transition-transform', isOpen && 'rotate-90')}
                                  aria-hidden="true"
                                />
                              </button>
                            )}
                          </TableCell>
                        )}
                        {visible.map((c, i) => (
                          <TableCell
                            key={c.key}
                            className={cn(alignClass(c.align), c.className, child && i === 0 && 'pl-8')}
                            onClick={c.stopRowClick ? (e) => e.stopPropagation() : undefined}
                          >
                            {rowHref && !child && c === primary ? (
                              // A real link in the primary cell: middle-click, ⌘-click
                              // and "open in new tab" work; the row click navigates too.
                              <Link to={rowHref(row)} className="hover:underline" onClick={(e) => e.stopPropagation()}>
                                {c.cell ? c.cell(row) : (c.accessor(row) ?? <span className="text-silver/50">—</span>)}
                              </Link>
                            ) : (
                              c.cell ? c.cell(row) : (c.accessor(row) ?? <span className="text-silver/50">—</span>)
                            )}
                          </TableCell>
                        ))}
                      </TableRow>
                    );
                  })}
                  {padBottom > 0 && (
                    <tr aria-hidden="true" style={{ height: padBottom }}>
                      <td colSpan={colSpan} className="p-0" />
                    </tr>
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </>
      )}
      {/* Under the list, not glued to the count: a long note no longer
          wraps the toolbar (Receivables, Collections). */}
      {footnote && !error && !firstLoad && <p className="text-xs text-ink-muted">{footnote}</p>}
    </div>
  );
}

const primaryOf = <T,>(columns: GridColumn<T>[]) => columns.find((c) => c.primary) ?? columns[0]!;
