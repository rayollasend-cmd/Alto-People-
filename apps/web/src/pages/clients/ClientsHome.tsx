import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Building2, FileText, LayoutGrid, List, MapPin, Plus } from '@/components/ui/icons';
import type { ClientListItem } from '@alto-people/shared';
import { clientServiceReportUrl, listClients } from '@/lib/clientsApi';
import { listProspects, PROSPECTS_KEY } from '@/lib/prospectsApi';
import { ApiError } from '@/lib/api';
import { fmtDate, fmtMoney, fmtRelativeDate, ymdLocal } from '@/lib/format';
// Org-week helper — despite the name it starts weeks on SATURDAY, the
// Sat→Fri week every payroll/report surface runs on.
import { startOfWeekMonday } from '@/pages/scheduling/WeekCalendarView';
import { useAuth, useTerm } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { StatusBadge } from '@/lib/status';
import { useDesktopTable, useMinWidth } from '@/lib/useViewport';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { MetricCard } from '@/components/ui/MetricCard';
import { MetricStrip } from '@/components/ui/MetricStrip';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { FilterChip, SearchInput } from '@/components/ui/FilterBar';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { Select } from '@/components/ui/Select';
import { Skeleton, SkeletonRows } from '@/components/ui/Skeleton';
import { ViewToggle } from '@/components/ui/ViewToggle';
import { FilterSheet, filtersSummary } from '@/components/FilterSheet';
import { SavedViewsMenu } from '@/components/SavedViewsMenu';
import { ListTemplate } from '@/components/templates';
import { NewClientDialog } from './NewClientDialog';
import { HealthCell, HealthDot, healthSentence } from './ClientHealthDot';
import {
  BILLED_RANGES,
  BUILT_IN_VIEWS,
  billedRange,
  builtInViewOf,
  daysUntil,
  fromQuery,
  matches,
  nextSort,
  numbersLine,
  sortClients,
  toQuery,
  viewCounts,
  type BilledRangeKey,
  type ClientsFilters,
  type ListState,
  type StatusFilter,
} from './clientsList';

/**
 * Clients — every account at a glance (Clients rebuild, 2026-10-22).
 *
 * Built to RUN accounts, not configure them: who is working there, how
 * well the next week is staffed, the hours, what is billed and owed, when
 * the contract ends, and a health call with its reasons. The table is the
 * default (the choice is remembered per person); cards remain; a phone gets
 * one compact row per account. Built-in views (Needs attention, Mine,
 * Contract ending…) and saved views (name + filters + sort + columns, kept
 * server-side per person) sit over the same rows. Money columns show only
 * to people who can read statements — the API leaves the fields out for
 * everyone else, so there is nothing to hide.
 */

type Layout = 'table' | 'cards';
const LAYOUTS: readonly Layout[] = ['table', 'cards'];
/** Columns off until someone turns them on. */
const DEFAULT_HIDDEN = ['industry', 'state', 'openApplications'];

const layoutKey = (userId: string | null) => `alto.clients.layout.v2.${userId ?? 'anon'}`;
const colsKey = (userId: string | null) => `alto.clients.cols.v1.${userId ?? 'anon'}`;

function readStored<T>(key: string, parse: (raw: string) => T | null): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? null : parse(raw);
  } catch {
    return null;
  }
}
function writeStored(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* a per-person convenience; storage may be unavailable */
  }
}

/** The table or the cards, remembered for this person on this browser. */
function useLayout(userId: string | null): [Layout, (next: Layout) => void] {
  const [layout, setLayout] = useState<Layout>(() => readStored(layoutKey(userId), (raw) => (LAYOUTS.includes(raw as Layout) ? (raw as Layout) : null)) ?? 'table');
  const set = useCallback(
    (next: Layout) => {
      setLayout(next);
      writeStored(layoutKey(userId), next);
    },
    [userId],
  );
  return [layout, set];
}

/** The 8 most recent COMPLETED org weeks (Sat 00:00 → Fri), newest first —
 *  the weeks the service-report endpoint can cover. `value` is the week
 *  start as YYYY-MM-DD, the shape the `week` query param expects. */
export function serviceReportWeekOptions(): Array<{ value: string; label: string }> {
  const currentStart = startOfWeekMonday(new Date());
  const out: Array<{ value: string; label: string }> = [];
  for (let i = 1; i <= 8; i++) {
    const start = new Date(currentStart);
    start.setDate(start.getDate() - 7 * i);
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    out.push({ value: ymdLocal(start), label: `${fmtDate(start)} – ${fmtDate(end)}` });
  }
  return out;
}

const STATUS_CHIPS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'ALL', label: 'All' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'INACTIVE', label: 'Inactive' },
  { value: 'PROSPECT', label: 'Prospect' },
];

const pct = (v: number) => `${Math.round(v)}%`;
/** Hours with one decimal, like every hours figure in the app ("367.3h"). */
const hoursText = (h: number) => `${(Math.round(h * 10) / 10).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}h`;

export function ClientsHome() {
  const term = useTerm();
  const { user, can } = useAuth();
  const me = user?.id ?? null;
  const canManage = can('manage:clients');
  // Statements readers: the money columns, the service-report PDF and the weekly statements desk.
  const canMoney = can('process:payroll') || can('view:executive');
  const canStatementsTab = can('process:payroll');
  const canPipeline = can('manage:clients') || can('view:executive');
  const canSchedule = can('manage:scheduling') || can('view:scheduling');
  const canTime = can('manage:time');
  const today = ymdLocal();

  const desktopTable = useDesktopTable();
  const phone = !useMinWidth(640);
  const [layout, setLayout] = useLayout(me);

  /* ----- The list's state lives in the URL (Back restores it; a view is a link) ----- */
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const [hidden, setHiddenState] = useState<string[]>(
    () => readStored(colsKey(me), (raw) => {
      const v: unknown = JSON.parse(raw);
      return Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string') : null;
    }) ?? DEFAULT_HIDDEN,
  );
  const setHidden = useCallback(
    (next: string[]) => {
      setHiddenState(next);
      writeStored(colsKey(me), JSON.stringify(next));
    },
    [me],
  );
  const state: ListState = useMemo(
    () => ({ ...fromQuery(Object.fromEntries(searchParams.entries()), { hidden: DEFAULT_HIDDEN }), hidden }),
    [searchParams, hidden],
  );
  const writeState = useCallback(
    (next: Partial<ListState>, opts: { keepView?: boolean } = {}) => {
      const merged: ListState = { ...state, ...next };
      setSearchParams(
        (prev) => {
          const p = new URLSearchParams(toQuery(merged));
          // The applied saved view rides along (?sv=) — its menu says when the filters drift from it —
          // until a built-in view replaces it.
          const sv = prev.get('sv');
          if (sv && opts.keepView !== false) p.set('sv', sv);
          return p;
        },
        { replace: true },
      );
    },
    [state, setSearchParams],
  );
  const setFilters = (f: Partial<ClientsFilters>) => writeState({ filters: { ...state.filters, ...f } });

  // The search box answers at once; the URL (and the server search) follow a beat later.
  const [query, setQuery] = useState(state.q);
  const lastWrittenQ = useRef(state.q);
  useEffect(() => {
    if (query === state.q) return;
    const t = setTimeout(() => {
      lastWrittenQ.current = query;
      writeState({ q: query });
    }, 250);
    return () => clearTimeout(t);
  }, [query, state.q, writeState]);
  // Only when the URL changes underneath the box (Back, a view applied) — never an echo of typing.
  useEffect(() => {
    if (state.q === lastWrittenQ.current) return;
    lastWrittenQ.current = state.q;
    setQuery(state.q);
  }, [state.q]);

  const range = billedRange(state.range, today);

  /* ----- Data ----- */
  // Every status is loaded and narrowed here, so the views can count what they hold.
  const clientsQuery = useInfiniteQuery({
    queryKey: ['clients', 'list', state.q, range.from, range.to],
    queryFn: ({ pageParam }) => listClients({ q: state.q, metrics: true, from: range.from, to: range.to, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: (prev) => prev,
  });
  const pipelineQuery = useQuery({ queryKey: PROSPECTS_KEY, queryFn: listProspects, enabled: canPipeline, retry: false, staleTime: 60_000 });
  const openProspects = pipelineQuery.data?.totals.open ?? null;

  const all = useMemo(() => (clientsQuery.data ? clientsQuery.data.pages.flatMap((pg) => pg.clients) : null), [clientsQuery.data]);
  const ctx = useMemo(() => ({ me, today }), [me, today]);
  const counts = useMemo(() => viewCounts(all ?? [], ctx), [all, ctx]);
  const rows = useMemo(() => (all ? sortClients(all.filter((c) => matches(c, state.filters, ctx)), state.sort) : null), [all, state.filters, state.sort, ctx]);
  const prospectsListed = (all ?? []).some((c) => c.status === 'PROSPECT');
  const moreOnServer = clientsQuery.hasNextPage;
  const error = clientsQuery.error ? (clientsQuery.error instanceof ApiError ? clientsQuery.error.message : 'The clients could not be loaded.') : null;
  const activeView = builtInViewOf(state.filters);
  const showGrid = !phone && layout === 'table' && desktopTable && !!rows && rows.length > 0;
  const filtered = activeView !== 'all' || state.q.trim().length > 0;

  /* ----- Saved views ----- */
  const savedViewId = searchParams.get('sv');
  const viewQuery = useMemo(() => toQuery(state, { cols: true, defaultHidden: DEFAULT_HIDDEN }), [state]);
  const applySavedView = (id: string | null, q: Record<string, string>) => {
    const next = fromQuery(q, { hidden: DEFAULT_HIDDEN });
    setHidden(next.hidden);
    setQuery(next.q);
    const p = new URLSearchParams(toQuery(next));
    if (id) p.set('sv', id);
    setSearchParams(p, { replace: true });
  };

  /* ----- The service-report PDF (unchanged behaviour) ----- */
  const [reportBusyIds, setReportBusyIds] = useState<Set<string>>(new Set());
  const reportWeeks = useMemo(serviceReportWeekOptions, []);
  const [reportWeek, setReportWeek] = useState(reportWeeks[0]!.value);
  const downloadReport = async (clientId: string, clientName: string) => {
    if (reportBusyIds.has(clientId)) return;
    setReportBusyIds((prev) => new Set(prev).add(clientId));
    try {
      const res = await fetch(clientServiceReportUrl(clientId, reportWeek), { credentials: 'include' });
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      const m = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '');
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objUrl;
      a.download = m?.[1] ?? `service-report-${clientName}-${reportWeek}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objUrl);
      toast.success(`Service report for ${clientName} downloaded.`);
    } catch {
      toast.error(`Could not generate the report for ${clientName}.`);
    } finally {
      setReportBusyIds((prev) => {
        const n = new Set(prev);
        n.delete(clientId);
        return n;
      });
    }
  };

  const [showNew, setShowNew] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);

  /* ----- Links behind the numbers ----- */
  // The same link the client's overview puts behind its On assignment tile.
  const peopleHref = (c: ClientListItem) => (can('view:org') ? `/people?client=${c.id}&status=ACTIVE` : `/clients/${c.id}`);
  const moneyHref = (c: ClientListItem) => `/clients/${c.id}?section=${canStatementsTab ? 'statements' : 'performance'}`;
  const fillHref = (c: ClientListItem) => (canSchedule ? `/scheduling?client=${c.id}` : `/clients/${c.id}?section=performance`);
  const hoursHref = (c: ClientListItem) => (canTime ? `/time-attendance/timesheets?client=${c.id}` : `/clients/${c.id}?section=performance`);

  /* ----- The table ----- */
  const billedHeader = `Billed · ${range.short}`;
  const columns: Array<GridColumn<ClientListItem>> = [
    {
      key: 'name',
      header: 'Name',
      accessor: (c) => c.name,
      sortable: true,
      primary: true,
      className: 'min-w-[10rem]',
      cell: (c) => (
        <div className="flex items-center gap-2.5">
          <Avatar name={c.name} size="sm" />
          <div className="min-w-0">
            <Link to={`/clients/${c.id}`} className="block font-medium text-ink underline-offset-4 hover:text-gold-bright hover:underline [overflow-wrap:anywhere] sm:[overflow-wrap:normal]">
              {c.name}
            </Link>
            {c.state && (
              <div className="flex items-center gap-0.5 text-2xs text-ink-muted">
                <MapPin className="h-3 w-3" aria-hidden="true" />
                {c.state}
              </div>
            )}
          </div>
        </div>
      ),
    },
    {
      key: 'health',
      header: 'Health',
      accessor: (c) => (c.health ? ({ risk: 0, watch: 1, good: 2 } as const)[c.health] : null),
      csv: (c) => (c.health ? healthSentence(c.health, c.healthReasons ?? []) : ''),
      sortable: true,
      searchable: false,
      cell: (c) => <HealthCell health={c.health} reasons={c.healthReasons} />,
    },
    {
      key: 'owner',
      header: 'Owner',
      accessor: (c) => c.accountOwner?.name ?? null,
      sortable: true,
      cell: (c) =>
        c.accountOwner ? (
          // An owner with no name on file reads as their email; the part before the @ is enough in a column.
          <span className="text-ink" title={c.accountOwner.name}>
            {c.accountOwner.name.includes('@') ? c.accountOwner.name.split('@')[0] : c.accountOwner.name}
          </span>
        ) : (
          <span className="whitespace-nowrap text-ink-muted">No owner</span>
        ),
    },
    {
      key: 'onAssignment',
      header: 'On assignment',
      accessor: (c) => c.onAssignment ?? c.activeAssociateCount,
      sortable: true,
      align: 'right',
      className: 'tabular-nums',
      cell: (c) => {
        const n = c.onAssignment ?? c.activeAssociateCount;
        return (
          <Link to={peopleHref(c)} className={cn('hover:underline', n > 0 ? 'text-ink' : 'text-ink-muted')} title={`${n} working at ${c.name} now`}>
            {n.toLocaleString('en-US')}
          </Link>
        );
      },
    },
    {
      key: 'fillRate',
      header: 'Filled, next\u00a07\u00a0days',
      accessor: (c) => c.fillRatePct ?? null,
      csv: (c) => (c.fillRatePct == null ? '' : `${Math.round(c.fillRatePct)}%`),
      sortable: true,
      align: 'right',
      className: 'tabular-nums',
      cell: (c) =>
        c.fillRatePct == null || !c.shiftsNext7 ? (
          <span className="whitespace-nowrap text-ink-muted" title="No shifts start in the next 7 days">No shifts</span>
        ) : (
          <Link to={fillHref(c)} className="inline-flex flex-col items-end leading-tight hover:underline">
            <span className={c.fillRatePct < 80 ? 'text-alert' : c.fillRatePct < 95 ? 'text-warning' : 'text-ink'}>{pct(c.fillRatePct)}</span>
            <span className="text-2xs text-ink-muted">
              {c.shiftsNext7.filled} of {c.shiftsNext7.total}
            </span>
          </Link>
        ),
    },
    {
      key: 'hours',
      header: 'Hours this\u00a0week',
      accessor: (c) => c.hoursThisWeek ?? null,
      csv: (c) => (c.hoursThisWeek == null ? '' : String(c.hoursThisWeek)),
      sortable: true,
      align: 'right',
      className: 'tabular-nums',
      cell: (c) =>
        !c.hoursThisWeek ? (
          <span className="whitespace-nowrap text-ink-muted" title="No hours worked here yet this week">No hours</span>
        ) : (
          <Link to={hoursHref(c)} className="text-ink hover:underline">
            {hoursText(c.hoursThisWeek)}
          </Link>
        ),
    },
    ...(canMoney
      ? ([
          {
            key: 'billed',
            header: billedHeader,
            accessor: (c) => c.billedInRange ?? null,
            csv: (c) => (c.billedInRange == null ? '' : c.billedInRange.toFixed(2)),
            sortable: true,
            align: 'right',
            className: 'tabular-nums',
            cell: (c) =>
              c.billedInRange == null ? (
                <span className="text-ink-muted">—</span>
              ) : c.billedInRange === 0 ? (
                <span className="text-ink-muted">{fmtMoney(0)}</span>
              ) : (
                // Money in a table is the whole amount ("$5,760.00"), never "$5.8k".
                <Link to={moneyHref(c)} className="whitespace-nowrap text-ink hover:underline">
                  {fmtMoney(c.billedInRange)}
                </Link>
              ),
          },
          {
            key: 'outstanding',
            header: 'Outstanding',
            accessor: (c) => c.outstanding ?? null,
            csv: (c) => (c.outstanding == null ? '' : c.outstanding.toFixed(2)),
            sortable: true,
            align: 'right',
            className: 'tabular-nums',
            cell: (c) => {
              if (c.outstanding == null) return <span className="text-ink-muted">—</span>;
              if (c.outstanding === 0) return <span className="text-ink-muted">{fmtMoney(0)}</span>;
              const late = (c.healthReasons ?? []).some((r) => r.includes('past due'));
              return (
                <Link to={moneyHref(c)} className={cn('whitespace-nowrap hover:underline', late ? 'text-alert' : 'text-ink')}>
                  {fmtMoney(c.outstanding)}
                </Link>
              );
            },
          },
        ] satisfies Array<GridColumn<ClientListItem>>)
      : []),
    {
      key: 'contractEnds',
      header: 'Contract ends',
      accessor: (c) => c.contractEndDate ?? null,
      csv: (c) => c.contractEndDate ?? '',
      sortable: true,
      hideBelow: 1000,
      cell: (c) => <ContractEnds date={c.contractEndDate ?? null} today={today} />,
    },
    {
      key: 'lastPayroll',
      header: 'Last payroll',
      accessor: (c) => (c.lastPayrollDisbursedAt ? Date.parse(c.lastPayrollDisbursedAt) : null),
      csv: (c) => c.lastPayrollDisbursedAt ?? '',
      sortable: true,
      // Column priority by room: the names and money keep theirs at 1440 with the sidebar open.
      hideBelow: 1260,
      className: 'whitespace-nowrap text-ink-muted',
      cell: (c) => (c.lastPayrollDisbursedAt ? <span title={fmtDate(c.lastPayrollDisbursedAt)}>{fmtRelativeDate(c.lastPayrollDisbursedAt)}</span> : <span className="text-ink-muted">None yet</span>),
    },
    {
      key: 'status',
      header: 'Status',
      accessor: (c) => c.status,
      sortable: true,
      cell: (c) => <StatusBadge status={c.status} />,
    },
    { key: 'industry', header: 'Industry', accessor: (c) => c.industry, sortable: true, defaultHidden: true, className: 'text-ink-muted' },
    { key: 'state', header: 'State', accessor: (c) => c.state, sortable: true, defaultHidden: true, cell: (c) => (c.state ? <span className="text-ink-muted">{c.state}</span> : <span className="text-ink-muted">—</span>) },
    {
      key: 'openApplications',
      header: 'Open apps',
      accessor: (c) => c.openApplications,
      sortable: true,
      defaultHidden: true,
      align: 'right',
      className: 'tabular-nums text-ink-muted',
    },
    ...(canMoney
      ? ([
          {
            key: 'report',
            header: 'Report',
            accessor: () => null,
            searchable: false,
            csv: () => '',
            hideBelow: 1260,
            cell: (c) => (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void downloadReport(c.id, c.name)}
                loading={reportBusyIds.has(c.id)}
                title={`Download ${c.name}'s weekly service report for the selected week — the client-facing PDF.`}
                aria-label={`Download service report for ${c.name}`}
              >
                <FileText className="h-3.5 w-3.5" />
                <span className="sr-only">PDF</span>
              </Button>
            ),
          },
        ] satisfies Array<GridColumn<ClientListItem>>)
      : []),
  ];
  const hiddenSet = useMemo(() => new Set(hidden), [hidden]);

  /* ----- Controls ----- */
  const viewChips = (
    <div role="group" aria-label="Views" className="flex flex-wrap items-center gap-1.5">
      {BUILT_IN_VIEWS.map((v) => (
        <FilterChip key={v.key} active={activeView === v.key && !savedViewId} title={v.hint} onClick={() => writeState({ filters: v.filters }, { keepView: false })}>
          {v.label}
          {all && v.key !== 'all' && <span className="ml-1 tabular-nums text-ink-muted">{counts[v.key]}</span>}
        </FilterChip>
      ))}
      {/* A status no view names (the Active tile, a Prospect link): said here, one tap to clear. */}
      {(state.filters.status === 'ACTIVE' || state.filters.status === 'PROSPECT') && (
        <FilterChip active title="Clear the status filter" aria-label={`Clear status: ${state.filters.status === 'ACTIVE' ? 'Active' : 'Prospect'}`} onClick={() => setFilters({ status: 'ALL' })}>
          {state.filters.status === 'ACTIVE' ? 'Active' : 'Prospect'}
          <span aria-hidden="true" className="ml-1 text-ink-muted">×</span>
        </FilterChip>
      )}
    </div>
  );
  const savedViews = (
    <SavedViewsMenu scope="clients.list" current={viewQuery} activeId={savedViewId} onApply={applySavedView} allLabel="Saved views" />
  );
  const statusChips = (
    <div role="group" aria-label="Status" className="flex flex-wrap items-center gap-1.5">
      {STATUS_CHIPS.filter((s) => s.value !== 'PROSPECT' || prospectsListed || state.filters.status === 'PROSPECT').map((s) => (
        <FilterChip key={s.value} active={state.filters.status === s.value} onClick={() => setFilters({ status: s.value })}>
          {s.label}
        </FilterChip>
      ))}
    </div>
  );
  const rangeSelect = canMoney ? (
    <Select size="sm" aria-label="Billed in" title="The period the Billed column covers" value={state.range} onChange={(e) => writeState({ range: e.target.value as BilledRangeKey })} className="w-auto">
      {BILLED_RANGES.map((r) => (
        <option key={r.key} value={r.key}>
          Billed: {r.label.toLowerCase()}
        </option>
      ))}
    </Select>
  ) : null;
  const searchBox = (
    <SearchInput value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search accounts…" aria-label="Search clients" wrapperClassName={phone ? 'w-full' : 'w-64'} />
  );
  const countLine = rows ? `${rows.length.toLocaleString('en-US')} ${rows.length === 1 ? 'account' : 'accounts'}${moreOnServer ? ' shown' : ''}` : '';
  // One filter row (F500 2026-10-26: "Inactive" was both a view chip and a
  // Status chip): the views say which accounts; this row searches and sets
  // the ranges. A status set elsewhere (the Active tile) shows as a chip in
  // the views row, with its ×.
  const listControls = (
    <>
      {searchBox}
      {rangeSelect}
      {canMoney && layout === 'table' && desktopTable && (
        <Select size="sm" aria-label="Service report week" title="Org week (Sat–Fri) each row's service-report PDF covers" value={reportWeek} onChange={(e) => setReportWeek(e.target.value)} className="w-auto">
          {reportWeeks.map((w) => (
            <option key={w.value} value={w.value}>
              Report: {w.label}
            </option>
          ))}
        </Select>
      )}
      {(layout === 'cards' || !rows || rows.length === 0) && <span className="ml-auto text-2xs tabular-nums text-ink-muted">{countLine}</span>}
      <ViewToggle<Layout>
        value={layout}
        onChange={setLayout}
        className={layout === 'cards' || !rows || rows.length === 0 ? undefined : 'ml-auto'}
        options={[
          { value: 'table', label: 'Table', icon: List },
          { value: 'cards', label: 'Cards', icon: LayoutGrid },
        ]}
      />
    </>
  );
  const activeFilterCount = (activeView === 'all' ? 0 : 1) + (state.range !== 'month' ? 1 : 0);

  return (
    <ListTemplate
      title={term('nav.clients')}
      subtitle="Every account at a glance: who's working, what's billed, and what needs you."
      // The nav trail, not a crumb of our own; sibling pages are links (related), one primary action.
      related={[
        ...(canMoney ? [{ label: 'Weekly statements', to: '/clients/statements' }] : []),
        ...(canPipeline ? [{ label: openProspects ? `Pipeline (${openProspects})` : 'Pipeline', to: '/clients/pipeline' }] : []),
      ]}
      actions={canManage ? [{ key: 'new', label: 'New client', icon: Plus, primary: true, onSelect: () => setShowNew(true) }] : undefined}
    >
      {error && (
        <ErrorBanner>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>{error}</span>
            <Button size="sm" variant="outline" onClick={() => void clientsQuery.refetch()}>
              Retry
            </Button>
          </div>
        </ErrorBanner>
      )}

      {!phone && all && all.length > 0 && <PortfolioStrip rows={all} canMoney={canMoney} attention={counts.attention} onAttention={() => writeState({ filters: BUILT_IN_VIEWS[1]!.filters }, { keepView: false })} onActive={() => setFilters({ status: 'ACTIVE' })} />}

      {phone ? (
        <div className="space-y-2">
          {searchBox}
          <div className="flex items-center justify-between gap-2">
            <FilterSheet mobile open={sheetOpen} onOpenChange={setSheetOpen} summary={filtersSummary(activeFilterCount)} description="Pick a view or narrow the accounts, then close to see them.">
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-ink-muted">View</p>
                {viewChips}
                <div className="pt-1">{savedViews}</div>
              </div>
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-ink-muted">Status</p>
                {statusChips}
              </div>
              {rangeSelect}
            </FilterSheet>
            <span className="text-2xs tabular-nums text-ink-muted">{countLine}</span>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            {viewChips}
            {savedViews}
          </div>
          {!showGrid && <div className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-surface-sunken/40 px-3 py-2">{listControls}</div>}
        </div>
      )}

      {!rows && !error && (phone || layout === 'table' ? (
        <Card>
          <div className="p-2">
            <SkeletonRows count={phone ? 5 : 6} rowHeight={phone ? 'h-14' : 'h-12'} />
          </div>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-44" />
          ))}
        </div>
      ))}

      {rows && rows.length === 0 && (
        <EmptyState
          icon={Building2}
          title={filtered ? 'No accounts match' : 'No clients yet'}
          description={
            filtered
              ? activeView === 'mine'
                ? 'No account names you as its owner. Owners are set on each client.'
                : 'Try another view or clear the search.'
              : canManage
                ? 'Add your first client with “New client” above.'
                : 'Accounts appear here once one is created.'
          }
          action={
            filtered ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setQuery('');
                  writeState({ filters: BUILT_IN_VIEWS[0]!.filters, q: '' }, { keepView: false });
                }}
              >
                Show every account
              </Button>
            ) : undefined
          }
        />
      )}

      {rows && rows.length > 0 && (phone || (layout === 'table' && !desktopTable)) && <PhoneRows rows={rows} />}

      {rows && rows.length > 0 && !phone && layout === 'cards' && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((c) => (
            <ClientCard key={c.id} client={c} today={today} />
          ))}
        </div>
      )}

      {showGrid && (
        // Twelve columns side by side at 1440px: the headers wrap to two lines and the cells pad a little less, so nothing is cut off.
        <div className="[--d-cell-x:0.5rem] [&_th_.truncate]:whitespace-normal [&_th_button]:h-auto [&_th_button]:min-h-10 [&_th_button]:px-2 [&_th_button]:py-1.5 [&_th_svg.opacity-0]:hidden">
          <DataGrid<ClientListItem>
            id="clients-accounts"
            caption="Clients"
            noun={{ one: 'account', many: 'accounts' }}
            rows={rows}
            rowKey={(c) => c.id}
            search={false}
            urlState={false}
            cards={false}
            keyboard={false}
            filters={listControls}
            sort={{ state: state.sort, onToggle: (key) => writeState({ sort: nextSort(state.sort, key) }) }}
            columnsState={{ hidden: hiddenSet, onChange: (next) => setHidden([...next]) }}
            exportCsv={{ filename: `clients-${today}` }}
            footnote={moreOnServer ? 'more on the server — load more below' : undefined}
            columns={columns}
          />
        </div>
      )}

      {rows && moreOnServer && (
        <div className="flex justify-center">
          <Button variant="outline" onClick={() => void clientsQuery.fetchNextPage()} loading={clientsQuery.isFetchingNextPage}>
            Load more
          </Button>
        </div>
      )}

      {/* The next jobs (sites, jobs, rates) live on the record: open it. */}
      <NewClientDialog
        open={showNew}
        onOpenChange={setShowNew}
        onCreated={(c) => {
          void clientsQuery.refetch();
          navigate(`/clients/${c.id}`);
        }}
      />
    </ListTemplate>
  );
}

/* ----- Pieces ------------------------------------------------------------------ */

function ContractEnds({ date, today }: { date: string | null; today: string }) {
  const days = daysUntil(date, today);
  if (!date || days === null) return <span className="text-ink-muted">Not set</span>;
  const tone = days < 0 || days <= 30 ? 'text-alert' : days <= 60 ? 'text-warning' : 'text-ink-muted';
  const when = days < 0 ? 'ended' : days === 0 ? 'today' : `in ${days} day${days === 1 ? '' : 's'}`;
  return (
    <span className="inline-flex flex-col leading-tight">
      <span className="whitespace-nowrap text-ink">{fmtDate(date)}</span>
      <span className={cn('text-2xs', tone)}>{when}</span>
    </span>
  );
}

/**
 * Four numbers over the whole book of accounts — two of them open the list
 * behind them. The kit's MetricStrip/MetricCard (F500 2026-10-26: hand-rolled
 * filled tiles with white numbers), ink values, money in whole dollars.
 */
function PortfolioStrip({ rows, canMoney, attention, onAttention, onActive }: { rows: ClientListItem[]; canMoney: boolean; attention: number; onAttention: () => void; onActive: () => void }) {
  const active = rows.filter((c) => c.status === 'ACTIVE');
  const atRisk = rows.filter((c) => c.health === 'risk').length;
  const working = rows.reduce((n, c) => n + (c.onAssignment ?? c.activeAssociateCount), 0);
  const hours = rows.reduce((n, c) => n + (c.hoursThisWeek ?? 0), 0);
  const outstanding = rows.reduce((n, c) => n + (c.outstanding ?? 0), 0);
  const owing = rows.filter((c) => (c.outstanding ?? 0) > 0).length;
  const shifts = rows.reduce((n, c) => n + (c.shiftsNext7?.total ?? 0), 0);
  const stillOpen = rows.reduce((n, c) => n + (c.shiftsNext7 ? c.shiftsNext7.total - c.shiftsNext7.filled : 0), 0);
  const accounts = (n: number) => `${n.toLocaleString('en-US')} account${n === 1 ? '' : 's'}`;
  return (
    <MetricStrip label="All accounts">
      <MetricCard
        label="Active accounts"
        value={active.length.toLocaleString('en-US')}
        hint={`of ${accounts(rows.length)} on the list`}
        onClick={onActive}
      />
      <MetricCard
        label="Needs attention"
        value={attention.toLocaleString('en-US')}
        // Status colour only when there is something to attend to.
        tone={attention > 0 ? 'warning' : 'default'}
        hint={atRisk > 0 ? `${atRisk} at risk` : attention > 0 ? 'None at risk' : undefined}
        nothing={attention === 0 ? 'Every account is in good shape' : undefined}
        onClick={onAttention}
      />
      <MetricCard
        label="On assignment"
        value={working.toLocaleString('en-US')}
        hint={hours > 0 ? `${hours.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} hours worked this week` : 'No hours yet this week'}
      />
      {canMoney ? (
        <MetricCard
          label="Outstanding"
          value={fmtMoney(outstanding)}
          hint={owing > 0 ? `Owed by ${accounts(owing)}` : undefined}
          nothing={owing === 0 ? 'Nothing owed' : undefined}
        />
      ) : (
        <MetricCard label="Shifts next 7 days" value={shifts.toLocaleString('en-US')} hint={`${stillOpen.toLocaleString('en-US')} still open`} />
      )}
    </MetricStrip>
  );
}

/** A phone's list: one compact row per account, the first visible without scrolling. */
function PhoneRows({ rows }: { rows: ClientListItem[] }) {
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface-raised" aria-label="Clients">
      {rows.map((c) => (
        <li key={c.id}>
          <Link to={`/clients/${c.id}`} className="flex items-start gap-3 px-3 py-2.5 active:bg-surface-sunken focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gold-bright">
            {c.health ? (
              <span className="mt-1.5" title={healthSentence(c.health, c.healthReasons ?? [])}>
                <HealthDot health={c.health} />
                <span className="sr-only">{healthSentence(c.health, c.healthReasons ?? [])}</span>
              </span>
            ) : (
              <span className="mt-1.5 h-2.5 w-2.5 shrink-0" aria-hidden="true" />
            )}
            <span className="min-w-0 flex-1">
              <span className="flex items-start justify-between gap-2">
                <span className="break-words font-medium leading-snug text-ink">{c.name}</span>
                {c.status !== 'ACTIVE' && <StatusBadge status={c.status} size="sm" className="mt-0.5 shrink-0" />}
              </span>
              <span className="mt-0.5 block text-xs tabular-nums text-ink-muted">{numbersLine(c)}</span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function ClientCard({ client: c, today }: { client: ClientListItem; today: string }) {
  const n = c.onAssignment ?? c.activeAssociateCount;
  const days = daysUntil(c.contractEndDate, today);
  return (
    <Link
      to={`/clients/${c.id}`}
      className="group flex flex-col gap-3 rounded-lg border border-line bg-surface-raised p-4 transition-colors hover:border-gold/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
    >
      <div className="flex items-start gap-3">
        <Avatar name={c.name} size="md" />
        <div className="min-w-0 flex-1">
          <div className="break-words text-base font-medium leading-snug text-ink transition-colors group-hover:text-gold-bright">{c.name}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-ink-muted">
            {c.accountOwner ? <span>Owner: {c.accountOwner.name}</span> : <span className="text-ink-muted">No owner</span>}
            {c.state && (
              <>
                <span aria-hidden="true">·</span>
                <span className="inline-flex items-center gap-0.5">
                  <MapPin className="h-3 w-3" aria-hidden="true" />
                  {c.state}
                </span>
              </>
            )}
          </div>
        </div>
        <StatusBadge status={c.status} className="shrink-0" />
      </div>
      {c.health && (
        <div className="flex items-start gap-2 text-xs">
          <HealthDot health={c.health} className="mt-1" />
          <span className={c.health === 'good' ? 'text-ink-muted' : c.health === 'watch' ? 'text-warning' : 'text-alert'}>
            {c.health === 'good' ? 'In good shape' : (c.healthReasons ?? [])[0] ?? ''}
            {(c.healthReasons ?? []).length > 1 && <span className="text-ink-muted"> · {(c.healthReasons ?? []).length - 1} more</span>}
          </span>
        </div>
      )}
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 border-t border-line pt-3">
        <CardNumber label="On assignment" value={n.toLocaleString('en-US')} muted={n === 0} />
        <CardNumber label="Filled · next 7 days" value={c.fillRatePct == null ? 'No shifts' : pct(c.fillRatePct)} muted={c.fillRatePct == null} tone={c.fillRatePct == null ? undefined : c.fillRatePct < 80 ? 'alert' : c.fillRatePct < 95 ? 'warning' : undefined} />
        <CardNumber label="Hours this week" value={c.hoursThisWeek ? hoursText(c.hoursThisWeek) : 'No hours yet'} muted={!c.hoursThisWeek} />
        {c.outstanding !== undefined ? (
          <CardNumber label="Outstanding" value={fmtMoney(c.outstanding)} muted={c.outstanding === 0} />
        ) : (
          <CardNumber label="Contract ends" value={c.contractEndDate ? fmtDate(c.contractEndDate) : 'Not set'} muted={!c.contractEndDate} tone={days !== null && days <= 30 ? 'alert' : days !== null && days <= 60 ? 'warning' : undefined} />
        )}
      </dl>
    </Link>
  );
}

function CardNumber({ label, value, muted, tone }: { label: string; value: string; muted?: boolean; tone?: 'alert' | 'warning' }) {
  return (
    <div className="min-w-0">
      <dt className="text-2xs font-medium uppercase tracking-wider text-ink-muted">{label}</dt>
      <dd className={cn('mt-0.5 text-base font-semibold tabular-nums', tone === 'alert' ? 'text-alert' : tone === 'warning' ? 'text-warning' : muted ? 'text-ink-muted' : 'text-ink')}>{value}</dd>
    </div>
  );
}
