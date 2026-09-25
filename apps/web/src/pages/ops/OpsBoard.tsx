import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AsOf } from '@/components/ui/AsOf';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ClipboardList,
  Flag,
  Thermometer,
  Users,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceArea,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { Badge } from '@/components/ui/Badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { CountUpValue } from '@/components/ui/MetricCard';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Button } from '@/components/ui/Button';
import { FilterBar, FilterChip } from '@/components/ui/FilterBar';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import {
  getOpsBoard,
  getOpsFeed,
  getOpsInsights,
  getOpsScorecard,
  getOpsStores,
  metricLabel,
} from '@/lib/opsApi';
import { OpsShiftRecordDialog } from './OpsShiftRecord';
import { OpsHistory } from './OpsHistory';
import { OpsFloorFeed, OpsPhotoWall } from './OpsFloorFeed';
import { OpsStandards } from './OpsStandards';
import { OpsProduction } from './OpsProduction';
import { OpsPacketButton } from './OpsPacketButton';
import { OpsReportButton } from './OpsReportButton';
import {
  fmtAgo,
  fmtClock,
  fmtDayKey,
  fmtDuration,
  fmtFull,
  OPS_TZ,
  opsToday,
  shiftDayKey,
} from './opsTime';

/**
 * The operations command center — presence in every store without being
 * in any of them. A live headline band, per-store mission tiles with
 * progress rings, the floor feed (completions, temps, photos ticking in),
 * a photo wall, the production trends and the standards scorecard.
 * Refreshes itself every 30s.
 *
 * Everything here narrows together: the filter bar drives the board, the
 * feed, the charts and the scorecard, and whatever is on screen is what
 * the SOP packet prints.
 */

/* ===== Filters ==========================================================
 * A board that shows today, unordered, cannot answer "what happened on
 * last week's overnight at Destin". Four things make it answerable: a
 * store, a period, a date range, and an order — all carried in the URL,
 * so the answer can be sent to someone as a link.
 *
 * Empty dates mean NOW: the live wall, filtered. Any date range switches
 * to the record.
 * ====================================================================== */

const PERIODS = ['MORNING', 'EVENING', 'CLOSING', 'OVERNIGHT'] as const;

const RANGE_PRESETS: { key: string; label: string; days: number }[] = [
  { key: 'today', label: 'Today', days: 0 },
  { key: '7', label: 'Last 7 days', days: 6 },
  { key: '30', label: 'Last 30 days', days: 29 },
];

const PERIOD_LABEL: Record<string, string> = {
  MORNING: 'Morning',
  EVENING: 'Evening',
  CLOSING: 'Closing',
  OVERNIGHT: 'Overnight',
};

/** SVG completion ring — the tile's heartbeat. */
function ProgressRing({ pct, alert }: { pct: number; alert: boolean }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  return (
    <svg
      viewBox="0 0 64 64"
      className="h-16 w-16 shrink-0"
      role="img"
      // The percentage is drawn INSIDE the svg, so hiding the whole
      // element hid the number from anyone not looking at it.
      aria-label={`${pct}% of this shift's checklist done`}
    >
      <circle cx="32" cy="32" r={r} fill="none" strokeWidth="5" className="stroke-navy-secondary" />
      <circle
        cx="32"
        cy="32"
        r={r}
        fill="none"
        strokeWidth="5"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - pct / 100)}
        transform="rotate(-90 32 32)"
        className={cn(
          'transition-all duration-700',
          alert ? 'stroke-alert' : pct >= 80 ? 'stroke-success' : 'stroke-gold',
        )}
      />
      <text
        x="32"
        y="36"
        textAnchor="middle"
        className={cn(
          'fill-white text-[13px] font-semibold tabular-nums',
        )}
      >
        {pct}%
      </text>
    </svg>
  );
}


/** Store, period, department, dates, order — the whole query, in one row. */
function OpsFilterBar({
  stores,
  storeId,
  period,
  department,
  from,
  to,
  sort,
  historyMode,
  anyFilter,
  departments,
  onParam,
  onRange,
  onClear,
}: {
  stores: { id: string; name: string; clientName: string | null }[];
  unplaced: number;
  storeId: string;
  period: string;
  department: string;
  from: string;
  to: string;
  sort: string;
  historyMode: boolean;
  anyFilter: boolean;
  departments: string[];
  onParam: (key: string, value: string) => void;
  onRange: (days: number) => void;
  onClear: () => void;
}) {
  return (
    <FilterBar className="gap-x-3 gap-y-2">
      <label className="flex items-center gap-1.5 text-2xs uppercase tracking-wider text-silver/70">
        Store
        <Select
          value={storeId}
          onChange={(e) => onParam('store', e.target.value)}
          className="h-9 w-48"
          aria-label="Filter by store"
        >
          <option value="">All stores</option>
          {stores.map((st) => (
            <option key={st.id} value={st.id}>
              {st.name}
            </option>
          ))}
        </Select>
      </label>

      <div
        className="flex flex-wrap items-center gap-1"
        role="group"
        aria-label="Filter by shift period"
      >
        {PERIODS.map((pKey) => (
          <FilterChip
            key={pKey}
            active={period === pKey}
            onClick={() => onParam('period', period === pKey ? '' : pKey)}
          >
            {PERIOD_LABEL[pKey]}
          </FilterChip>
        ))}
      </div>

      {departments.length > 0 && (
        <label className="flex items-center gap-1.5 text-2xs uppercase tracking-wider text-silver/70">
          Dept
          <Select
            value={department}
            onChange={(e) => onParam('dept', e.target.value)}
            className="h-9 w-40"
            aria-label="Filter by department"
          >
            <option value="">All</option>
            {departments.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </Select>
        </label>
      )}

      <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Date range">
        {RANGE_PRESETS.map((r) => {
          const active =
            r.days === 0 ? !historyMode : from === shiftDayKey(opsToday(), -r.days) && to === opsToday();
          return (
            <FilterChip key={r.key} active={active} onClick={() => onRange(r.days)}>
              {r.label}
            </FilterChip>
          );
        })}
        <Input
          type="date"
          value={from}
          max={to || undefined}
          onChange={(e) => onParam('from', e.target.value)}
          className="h-9 w-[9.5rem]"
          aria-label="Shifts on or after"
        />
        <span className="text-xs text-silver/60">to</span>
        <Input
          type="date"
          value={to}
          min={from || undefined}
          onChange={(e) => onParam('to', e.target.value)}
          className="h-9 w-[9.5rem]"
          aria-label="Shifts on or before"
        />
      </div>

      {historyMode && (
        <label className="flex items-center gap-1.5 text-2xs uppercase tracking-wider text-silver/70">
          Order
          <Select
            value={sort}
            onChange={(e) => onParam('sort', e.target.value)}
            className="h-9 w-44"
            aria-label="Order the record"
          >
            <option value="worst">Needs attention first</option>
            <option value="recent">Most recent first</option>
            <option value="store">By store</option>
          </Select>
        </label>
      )}

      {anyFilter && (
        <Button variant="ghost" size="xs" onClick={onClear}>
          Clear
        </Button>
      )}
    </FilterBar>
  );
}

export function OpsBoard() {
  // The record drill-in: which shift's full evidence is open.
  const [recordId, setRecordId] = useState<string | null>(null);

  // Deep link: /ops?tab=board&record=<id> opens the shift record once,
  // then drops the param (replace) so closing the dialog — or a later
  // reload — doesn't reopen it.
  const [searchParams, setSearchParams] = useSearchParams();

  // The four things that make a question answerable, all in the URL.
  const storeId = searchParams.get('store') ?? '';
  const period = searchParams.get('period') ?? '';
  const department = searchParams.get('dept') ?? '';
  const from = searchParams.get('from') ?? '';
  const to = searchParams.get('to') ?? '';
  const sort = (searchParams.get('sort') ?? 'worst') as 'worst' | 'recent' | 'store';
  // Dates switch the page from the live wall to the record.
  const historyMode = from !== '' || to !== '';
  const anyFilter = historyMode || storeId !== '' || period !== '' || department !== '';

  const setParam = (key: string, value: string) =>
    setSearchParams(
      (prev) => {
        if (value) prev.set(key, value);
        else prev.delete(key);
        return prev;
      },
      { replace: true },
    );
  const setRange = (days: number) => {
    const today = opsToday();
    setSearchParams(
      (prev) => {
        if (days <= 0) {
          prev.delete('from');
          prev.delete('to');
        } else {
          prev.set('from', shiftDayKey(today, -days));
          prev.set('to', today);
        }
        return prev;
      },
      { replace: true },
    );
  };
  const clearFilters = () =>
    setSearchParams(
      (prev) => {
        for (const k of ['store', 'period', 'dept', 'from', 'to', 'sort']) prev.delete(k);
        return prev;
      },
      { replace: true },
    );

  useEffect(() => {
    const linked = searchParams.get('record');
    if (!linked) return;
    setRecordId(linked);
    const params = new URLSearchParams(searchParams);
    params.delete('record');
    setSearchParams(params, { replace: true });
  }, [searchParams, setSearchParams]);

  // Five reads, one query layer. What the hand-rolled effect cluster used
  // to do by hand — a 30-second poll, a cancelled flag per request, a
  // banner that had to remember to clear itself, the previous answer kept
  // on screen while a filter change loaded — the query layer does by
  // default, and adds what it never did: the same answer shared with any
  // other surface asking, a retry on a failed poll, and the time the
  // numbers were last true.
  const scope = { locationId: storeId, period, department };
  const live = !historyMode;
  const boardQuery = useQuery({
    queryKey: ['ops', 'board', scope],
    queryFn: () => getOpsBoard(scope),
    enabled: live,
    refetchInterval: live ? 30_000 : false,
    placeholderData: (prev) => prev,
  });
  const feedQuery = useQuery({
    queryKey: ['ops', 'feed', scope],
    queryFn: () => getOpsFeed(scope),
    enabled: live,
    refetchInterval: live ? 30_000 : false,
    placeholderData: (prev) => prev,
  });
  // The charts used to read every store regardless of the filter — so
  // picking Destin left them showing the whole estate.
  const insightsQuery = useQuery({
    queryKey: ['ops', 'insights', scope],
    queryFn: () => getOpsInsights(scope),
    enabled: live,
    refetchInterval: live ? 30_000 : false,
    placeholderData: (prev) => prev,
  });
  const scorecardQuery = useQuery({
    queryKey: ['ops', 'scorecard', 4, 'worst', scope],
    queryFn: () => getOpsScorecard(4, 'worst', scope),
    enabled: live,
    placeholderData: (prev) => prev,
  });
  // The store list is stable; one read serves the picker for the session.
  const storesQuery = useQuery({
    queryKey: ['ops', 'stores'],
    queryFn: getOpsStores,
    staleTime: 10 * 60_000,
  });

  const board = boardQuery.data ?? null;
  const feed = feedQuery.data ?? null;
  const insights = insightsQuery.data ?? null;
  const scorecard = scorecardQuery.data ?? null;
  const stores = storesQuery.data ?? null;
  const error = boardQuery.error
    ? boardQuery.error instanceof ApiError
      ? boardQuery.error.message
      : 'Could not load the board.'
    : null;
  // A feed that failed and a floor that is quiet used to render the same
  // sentence. They are different facts.
  const feedFailed = feedQuery.isError;

  const headline = useMemo(() => {
    if (!board) return null;
    const all = [...board.active, ...board.closedToday];
    const floor = board.active.reduce((n, s) => n + s.actualHeadcount, 0);
    const tempAlerts = all.reduce((n, s) => n + s.tempAlerts, 0);
    const sopDone = all.reduce((n, s) => n + s.taskDone, 0);
    const sopTotal = all.reduce((n, s) => n + s.taskTotal, 0);
    // Buildings, not chains. This counted distinct clients and called
    // them stores, so a client with forty locations read as one.
    const stores = new Set(all.map((s) => s.locationName ?? `client:${s.clientName}`)).size;
    return {
      live: board.active.length,
      floor,
      stores,
      tempAlerts,
      sopPct: sopTotal > 0 ? Math.round((sopDone / sopTotal) * 100) : null,
      incomplete: board.closedToday.filter((s) => s.closedIncomplete).length,
    };
  }, [board]);

  // The store the board is currently pointed at, by name — the packet
  // menu says what it is about to produce in the reader's own terms.
  const storeName = useMemo(
    () => stores?.stores.find((st) => st.id === storeId)?.name ?? null,
    [stores, storeId],
  );
  const packetScope = {
    locationId: storeId || undefined,
    period: period || undefined,
    department: department || undefined,
  };

  const incompleteToday = (board?.closedToday ?? []).filter((s) => s.closedIncomplete).length;

  const departments = useMemo(() => {
    const set = new Set<string>();
    for (const shift of [...(board?.active ?? []), ...(board?.closedToday ?? [])]) {
      set.add(shift.department);
    }
    for (const store of insights?.stores ?? []) for (const d of store.departments) set.add(d);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [board, insights]);

  const filterBar = (
    <OpsFilterBar
      stores={stores?.stores ?? []}
      unplaced={stores?.unplaced ?? 0}
      storeId={storeId}
      period={period}
      department={department}
      from={from}
      to={to}
      sort={sort}
      historyMode={historyMode}
      anyFilter={anyFilter}
      departments={departments}
      onParam={setParam}
      onRange={setRange}
      onClear={clearFilters}
    />
  );

  // The record: a date range switches the page from what is happening to
  // what happened, which is the question the board could never answer.
  if (historyMode) {
    return (
      <div className="space-y-4">
        {filterBar}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-silver/70">
            {from && to
              ? `Shifts from ${fmtDayKey(from)} to ${fmtDayKey(to)}`
              : 'Pick both dates to read a range'}
            {' · times in '}
            {OPS_TZ.split('/')[1]?.replace('_', ' ')}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <OpsReportButton stores={stores?.stores ?? []} storeId={storeId || undefined} />
            <OpsPacketButton scope={packetScope} storeName={storeName} dateKey={to || undefined} />
          </div>
        </div>
        <OpsHistory
          query={{
            from: from || undefined,
            to: to || undefined,
            locationId: storeId || undefined,
            period: period || undefined,
            department: department || undefined,
            sort,
          }}
          onOpenRecord={setRecordId}
        />
        {recordId && (
          <OpsShiftRecordDialog shiftId={recordId} onClose={() => setRecordId(null)} />
        )}
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-4">
        {filterBar}
        <ErrorBanner
          action={
            <Button size="sm" variant="outline" onClick={() => void boardQuery.refetch()}>
              Try again
            </Button>
          }
        >
          {error}
        </ErrorBanner>
      </div>
    );
  }
  if (!board || !headline) return <Skeleton className="h-64" />;

  return (
    <div className="space-y-4">
      {filterBar}
      {/* ===== Headline band — the six numbers that ARE the floor ===== */}
      <div className="relative overflow-hidden rounded-lg border border-navy-secondary bg-gradient-to-br from-navy-secondary/60 via-navy to-navy p-5">
        <div
          aria-hidden
          className="pointer-events-none absolute -right-20 -top-20 h-72 w-72 rounded-full glow [--glow:rgb(var(--color-gold)/0.12)]"
        />
        <div className="relative flex flex-wrap items-center gap-x-8 gap-y-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="relative flex h-2.5 w-2.5">
                <span
                  className={cn(
                    'absolute inline-flex h-full w-full rounded-full opacity-60',
                    headline.live > 0 ? 'animate-ping bg-success' : 'bg-silver/40',
                  )}
                />
                <span
                  className={cn(
                    'relative inline-flex h-2.5 w-2.5 rounded-full',
                    headline.live > 0 ? 'bg-success' : 'bg-silver/40',
                  )}
                />
              </span>
              <span className="text-2xs uppercase tracking-[0.2em] text-gold">
                Floor command · {board.dateKey}
              </span>
              {/* When these numbers were last true, and a way to ask again
                  without waiting for the next poll. */}
              <AsOf
                at={boardQuery.dataUpdatedAt}
                refreshing={boardQuery.isFetching}
                onRefresh={() => {
                  void boardQuery.refetch();
                  void feedQuery.refetch();
                  void insightsQuery.refetch();
                }}
                className="ml-2"
              />
            </div>
            <div className="mt-1 text-xl font-medium text-white">
              {headline.live > 0
                ? `${headline.live} shift${headline.live === 1 ? '' : 's'} running across ${headline.stores} store${headline.stores === 1 ? '' : 's'}`
                : 'All floors quiet'}
            </div>
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              {/* The board is a screen; the packet and the report are the
                  documents that leave the room with whoever asked for them. */}
              <OpsReportButton stores={stores?.stores ?? []} storeId={storeId || undefined} />
              <OpsPacketButton
                scope={packetScope}
                storeName={storeName}
                dateKey={board.dateKey}
              />
            </div>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-x-8 gap-y-3">
            <HeadlineStat
              label="On the floor"
              value={<CountUpValue value={headline.floor} />}
              icon={Users}
              tone="text-white"
            />
            <HeadlineStat
              label="SOP today"
              value={headline.sopPct == null ? '—' : <CountUpValue value={`${headline.sopPct}%`} />}
              icon={ClipboardList}
              tone={
                headline.sopPct == null
                  ? 'text-silver'
                  : headline.sopPct >= 80
                    ? 'text-success'
                    : 'text-warning'
              }
            />
            <HeadlineStat
              label="Temp alerts"
              value={<CountUpValue value={headline.tempAlerts} />}
              icon={Thermometer}
              tone={headline.tempAlerts > 0 ? 'text-alert' : 'text-success'}
            />
            <HeadlineStat
              label="Incomplete closes"
              value={<CountUpValue value={headline.incomplete} />}
              icon={Flag}
              tone={headline.incomplete > 0 ? 'text-warning' : 'text-success'}
            />
          </div>
        </div>
      </div>

      {/* ===== Store windows — one pane of glass per store ===== */}
      {insights && insights.stores.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {insights.stores.map((store) => (
            <div
              key={store.name}
              className={cn(
                'relative overflow-hidden rounded-lg border p-4',
                store.tempAlertsToday > 0
                  ? 'border-alert/50 bg-alert/[0.05]'
                  : 'border-navy-secondary bg-navy-secondary/20',
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0 truncate text-sm font-medium text-white">
                  {store.name}
                </div>
                <span
                  className={cn(
                    'relative flex h-2 w-2 shrink-0',
                    store.liveShifts === 0 && 'opacity-40',
                  )}
                >
                  {store.liveShifts > 0 && (
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
                  )}
                  <span
                    className={cn(
                      'relative inline-flex h-2 w-2 rounded-full',
                      store.liveShifts > 0 ? 'bg-success' : 'bg-silver/40',
                    )}
                  />
                </span>
              </div>
              <div className="mt-2 flex items-end justify-between gap-2">
                <div>
                  <div className="text-2xl font-semibold tabular-nums text-white">
                    {store.floor}
                  </div>
                  <div className="text-2xs uppercase tracking-wider text-silver/60">
                    on the floor
                  </div>
                </div>
                <div className="text-right">
                  <div
                    className={cn(
                      'text-2xl font-semibold tabular-nums',
                      store.sopPct == null
                        ? 'text-silver/40'
                        : store.sopPct >= 80
                          ? 'text-success'
                          : 'text-warning',
                    )}
                  >
                    {store.sopPct == null ? '—' : `${store.sopPct}%`}
                  </div>
                  <div className="text-2xs uppercase tracking-wider text-silver/60">
                    SOP today
                  </div>
                </div>
              </div>
              <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-silver/70">
                <span>
                  {store.liveShifts > 0
                    ? `${store.liveShifts} live: ${store.departments.join(', ')}`
                    : 'no ops shift running'}
                </span>
                {store.tempAlertsToday > 0 && (
                  <span className="inline-flex items-center gap-1 text-alert">
                    <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                    {store.tempAlertsToday} temp
                  </span>
                )}
                {store.incompleteToday > 0 && (
                  <span className="text-warning">{store.incompleteToday} incomplete</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ===== The drawn picture: temps, rhythm, trend ===== */}
      {insights && (
        <div className="grid gap-4 lg:grid-cols-3">
          {/* Temperature watch — every reading in 24h against the safe band. */}
          <Card className="lg:col-span-1">
            <CardHeader className="pb-1">
              <CardTitle className="text-base">
                <Thermometer className="mr-1.5 inline h-4 w-4 text-teal" aria-hidden="true" />
                Temperature watch — 24h
              </CardTitle>
            </CardHeader>
            <CardContent>
              {insights.tempSeries.length === 0 ? (
                <p className="py-6 text-center text-xs text-silver/60">
                  No temperature readings yet.
                </p>
              ) : (
                <>
                  <div className="h-40">
                    <ResponsiveContainer width="100%" height="100%">
                      <ScatterChart margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
                        <CartesianGrid stroke="rgb(var(--color-silver) / 0.10)" />
                        <XAxis
                          dataKey="ts"
                          type="number"
                          domain={['dataMin', 'dataMax']}
                          tick={false}
                          axisLine={{ stroke: 'rgb(var(--color-silver) / 0.2)' }}
                        />
                        <YAxis
                          dataKey="value"
                          type="number"
                          tick={{ fill: 'rgb(var(--color-silver) / 0.7)', fontSize: 10 }}
                          axisLine={false}
                          tickLine={false}
                          width={40}
                          unit="°"
                        />
                        {/* Freezer + cooler safe bands, painted behind. */}
                        <ReferenceArea
                          y1={-10}
                          y2={10}
                          fill="rgb(var(--color-teal) / 0.08)"
                          stroke="none"
                        />
                        <ReferenceArea
                          y1={33}
                          y2={41}
                          fill="rgb(var(--color-teal) / 0.08)"
                          stroke="none"
                        />
                        <Tooltip
                          cursor={{ stroke: 'rgb(var(--color-gold) / 0.4)' }}
                          contentStyle={{
                            background: 'rgb(var(--color-navy))',
                            border: '1px solid rgb(var(--color-navy-secondary))',
                            borderRadius: 8,
                            fontSize: 11,
                          }}
                          formatter={(value) => [`${String(value)}°F`, 'reading']}
                          labelFormatter={() => ''}
                        />
                        <Scatter
                          data={insights.tempSeries.map((t) => ({
                            ...t,
                            ts: new Date(t.at).getTime(),
                          }))}
                        >
                          {insights.tempSeries.map((t, i) => (
                            <Cell
                              key={i}
                              fill={
                                t.out
                                  ? 'rgb(var(--color-alert))'
                                  : 'rgb(var(--color-teal))'
                              }
                            />
                          ))}
                        </Scatter>
                      </ScatterChart>
                    </ResponsiveContainer>
                  </div>
                  <p className="mt-1 text-2xs text-silver/60">
                    Shaded bands = safe ranges (freezer −10–10°F, cooler 33–41°F).{' '}
                    {insights.tempSeries.filter((t) => t.out).length === 0 ? (
                      <span className="text-success">All readings in range.</span>
                    ) : (
                      <span className="text-alert">
                        {insights.tempSeries.filter((t) => t.out).length} out of range —
                        already escalated.
                      </span>
                    )}
                  </p>
                </>
              )}
            </CardContent>
          </Card>

          {/* The day's rhythm — completions per hour. */}
          <Card className="lg:col-span-1">
            <CardHeader className="pb-1">
              <CardTitle className="text-base">
                <Activity className="mr-1.5 inline h-4 w-4 text-gold" aria-hidden="true" />
                Floor rhythm — 24h
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="h-40">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={insights.hourly}
                    margin={{ top: 8, right: 8, bottom: 0, left: -22 }}
                  >
                    <CartesianGrid
                      stroke="rgb(var(--color-silver) / 0.10)"
                      vertical={false}
                    />
                    <XAxis
                      dataKey="hour"
                      tick={{ fill: 'rgb(var(--color-silver) / 0.6)', fontSize: 9 }}
                      interval={3}
                      axisLine={false}
                      tickLine={false}
                    />
                    <YAxis
                      tick={{ fill: 'rgb(var(--color-silver) / 0.7)', fontSize: 10 }}
                      axisLine={false}
                      tickLine={false}
                      allowDecimals={false}
                      width={34}
                    />
                    <Tooltip
                      cursor={{ fill: 'rgb(var(--color-gold) / 0.08)' }}
                      contentStyle={{
                        background: 'rgb(var(--color-navy))',
                        border: '1px solid rgb(var(--color-navy-secondary))',
                        borderRadius: 8,
                        fontSize: 11,
                      }}
                      formatter={(value) => [`${String(value)} tasks`, 'completed']}
                    />
                    <Bar
                      dataKey="count"
                      radius={[3, 3, 0, 0]}
                      fill="rgb(var(--color-gold) / 0.75)"
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <p className="mt-1 text-2xs text-silver/60">
                Task completions per hour across all stores — the floors&apos; heartbeat.
              </p>
              {insights.metrics.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {insights.metrics.slice(0, 5).map((m) => (
                    <span
                      key={m.metricKey}
                      className="inline-flex items-center gap-1.5 rounded-full border border-navy-secondary bg-navy-secondary/30 px-2.5 py-1 text-2xs"
                      title={`${m.readings} reading${m.readings === 1 ? '' : 's'} in 24h`}
                    >
                      <span className="font-semibold tabular-nums text-white">
                        {m.total.toLocaleString('en-US')}
                      </span>
                      <span className="text-silver/70">{metricLabel(m.metricKey)}</span>
                    </span>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* 7-day SOP trend. */}
          <Card className="lg:col-span-1">
            <CardHeader className="pb-1">
              <CardTitle className="text-base">
                <ClipboardList className="mr-1.5 inline h-4 w-4 text-success" aria-hidden="true" />
                SOP compliance — 7 days
              </CardTitle>
            </CardHeader>
            <CardContent>
              {insights.sopTrend.length === 0 ? (
                <p className="py-6 text-center text-xs text-silver/60">
                  Trend appears after the first closed shifts.
                </p>
              ) : (
                <div className="h-40">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart
                      data={insights.sopTrend}
                      margin={{ top: 8, right: 8, bottom: 0, left: -22 }}
                    >
                      <defs>
                        <linearGradient id="sopFill" x1="0" y1="0" x2="0" y2="1">
                          <stop
                            offset="0%"
                            stopColor="rgb(var(--color-success))"
                            stopOpacity={0.35}
                          />
                          <stop
                            offset="100%"
                            stopColor="rgb(var(--color-success))"
                            stopOpacity={0}
                          />
                        </linearGradient>
                      </defs>
                      <CartesianGrid
                        stroke="rgb(var(--color-silver) / 0.10)"
                        vertical={false}
                      />
                      <XAxis
                        dataKey="dateKey"
                        tickFormatter={(v: string) => v.slice(5)}
                        tick={{ fill: 'rgb(var(--color-silver) / 0.6)', fontSize: 9 }}
                        axisLine={false}
                        tickLine={false}
                      />
                      <YAxis
                        domain={[0, 100]}
                        tick={{ fill: 'rgb(var(--color-silver) / 0.7)', fontSize: 10 }}
                        axisLine={false}
                        tickLine={false}
                        width={34}
                        unit="%"
                      />
                      <Tooltip
                        contentStyle={{
                          background: 'rgb(var(--color-navy))',
                          border: '1px solid rgb(var(--color-navy-secondary))',
                          borderRadius: 8,
                          fontSize: 11,
                        }}
                        formatter={(value) => [`${String(value)}%`, 'SOP compliance']}
                      />
                      <Area
                        type="monotone"
                        dataKey="pct"
                        stroke="rgb(var(--color-success))"
                        strokeWidth={2}
                        fill="url(#sopFill)"
                        connectNulls
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
        <div className="space-y-4 min-w-0">
          {/* ===== Live mission tiles ===== */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">
                Live now
                <span className="ml-2 text-xs font-normal tabular-nums text-silver/60">
                  {board.active.length} open · as of {fmtClock(board.generatedAt)}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {board.active.length === 0 ? (
                <EmptyState
                  icon={ClipboardList}
                  title={
                    anyFilter
                      ? 'No shifts running that match these filters'
                      : 'No ops shifts running right now'
                  }
                  description={
                    anyFilter
                      ? 'Clear the filters above to see every floor, or pick a date range to read the record instead.'
                      : 'Supervisors open their shift from Store Ops when they start — it will appear here the moment they do.'
                  }
                />
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  {board.active.map((s) => {
                    const pct =
                      s.taskTotal > 0 ? Math.round((s.taskDone / s.taskTotal) * 100) : 0;
                    return (
                      <button
                        type="button"
                        key={s.id}
                        onClick={() => setRecordId(s.id)}
                        title="Open the full shift record"
                        className={cn(
                          'flex items-center gap-3 rounded-lg border bg-navy-secondary/20 p-3.5 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright',
                          s.tempAlerts > 0
                            ? 'border-alert/60 bg-alert/[0.06]'
                            : 'border-navy-secondary hover:border-gold/30',
                        )}
                      >
                        <ProgressRing pct={pct} alert={s.tempAlerts > 0} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-white">
                            {s.department}
                            <span className="ml-1.5 text-xs font-normal text-gold">
                              {PERIOD_LABEL[s.period]}
                            </span>
                          </div>
                          <div className="mt-0.5 truncate text-xs text-silver">
                            {/* The building, not the chain: two overnight
                                shifts at Destin and Front Beach used to be
                                the same row twice. */}
                            {s.locationName ?? s.clientName}
                            {s.locationName && (
                              <span className="text-silver/50"> · {s.clientName}</span>
                            )}
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-2xs tabular-nums text-silver/80">
                            <span className="inline-flex items-center gap-1">
                              <Users className="h-3 w-3 text-gold" aria-hidden="true" />
                              {s.actualHeadcount}/{s.scheduledHeadcount}
                            </span>
                            <span>
                              {s.taskDone}/{s.taskTotal} tasks
                            </span>
                            {s.tempAlerts > 0 && (
                              <span className="inline-flex items-center gap-1 text-alert">
                                <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                                {s.tempAlerts} temp
                              </span>
                            )}
                          </div>
                          <div className="mt-1 space-y-0.5">
                            <div
                              className="truncate text-2xs text-silver/60"
                              title={`Opened ${fmtFull(s.openedAt)}`}
                            >
                              {/* Who is accountable for this shift right
                                  now — the account, because a first name
                                  is not an audit trail. */}
                              <span className="text-silver">
                                {s.openedByAccount ?? s.openedByEmail ?? 'unknown account'}
                              </span>
                              {s.coveringForName && (
                                <span className="text-gold"> · covering {s.coveringForName}</span>
                              )}
                            </div>
                            <div className="truncate text-2xs tabular-nums text-silver/50">
                              opened {fmtClock(s.openedAt)} ({fmtAgo(s.openedAt)})
                              {s.dueAt && (
                                <span
                                  className={
                                    new Date(s.dueAt).getTime() < Date.now()
                                      ? ' text-alert'
                                      : ' text-silver/50'
                                  }
                                >
                                  {' · due '}
                                  {fmtClock(s.dueAt)}
                                  {new Date(s.dueAt).getTime() < Date.now() && ' — overdue'}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          {/* ===== From the floor — the photographs as evidence ===== */}
          <OpsPhotoWall
            photos={feed?.photos ?? null}
            loading={feed === null && !feedFailed}
            onOpenRecord={setRecordId}
          />

          {/* ===== Closed today ===== */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">
                Closed today
                <span className="ml-2 text-xs font-normal tabular-nums text-silver/60">
                  {board.closedToday.length} submitted
                  {incompleteToday > 0 && ` · ${incompleteToday} incomplete`}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {board.closedToday.length === 0 ? (
                <p className="text-sm text-silver">
                  {anyFilter
                    ? 'Nothing matching these filters has closed yet today.'
                    : 'Nothing closed yet today.'}
                </p>
              ) : (
                <ul className="divide-y divide-navy-secondary/60">
                  {board.closedToday.map((s) => (
                    <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => setRecordId(s.id)}
                      title="Open the full shift record"
                      className="flex w-full flex-wrap items-center justify-between gap-2 rounded py-2.5 text-left transition-colors hover:bg-navy-secondary/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
                    >
                      <div className="min-w-0">
                        <div className="text-sm text-white">
                          {s.department}
                          <span className="ml-1.5 text-xs text-gold">
                            {PERIOD_LABEL[s.period]}
                          </span>
                          <span className="ml-2 text-xs text-silver/70">
                            {s.locationName ?? s.clientName}
                          </span>
                        </div>
                        <div className="mt-0.5 truncate text-2xs text-silver/60">
                          {/* Which supervisor account submitted it. This
                              row used to name nobody at all. */}
                          submitted by{' '}
                          <span className="text-silver">
                            {s.submittedByAccount ?? s.openedByAccount ?? 'unknown account'}
                          </span>
                          {s.submittedByAccount &&
                            s.openedByAccount &&
                            s.submittedByAccount !== s.openedByAccount && (
                              <span className="text-gold"> · opened by {s.openedByAccount}</span>
                            )}
                        </div>
                        {s.closingSummary && (
                          <div className="mt-0.5 max-w-prose truncate text-xs italic text-silver/70">
                            “{s.closingSummary}”
                          </div>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-2 text-xs tabular-nums">
                        {/* When it closed. A shift record with no clock on
                            it cannot answer "what happened overnight". */}
                        <span
                          className="text-silver/80"
                          title={`Opened ${fmtFull(s.openedAt)} · closed ${fmtFull(s.closedAt)}`}
                        >
                          {fmtClock(s.openedAt)}–{fmtClock(s.closedAt)}
                          <span className="ml-1 text-silver/50">
                            ({fmtDuration(s.openedAt, s.closedAt)})
                          </span>
                        </span>
                        <span className="text-silver">
                          SOP <span className="text-white">{s.sopDone}</span>/{s.sopTotal}
                        </span>
                        {s.tempAlerts > 0 && (
                          <Badge variant="destructive">{s.tempAlerts} temp</Badge>
                        )}
                        {s.closedIncomplete ? (
                          <Badge variant="destructive">incomplete</Badge>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-success">
                            <CheckCircle2 className="h-3.5 w-3.5" /> complete
                          </span>
                        )}
                      </div>
                    </button>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {/* ===== Production trends — direction, not only volume ===== */}
          <OpsProduction scorecard={scorecard} />

          {/* ===== Standards — the four-week record, by store and shift ===== */}
          <OpsStandards
            scorecard={scorecard}
            onPickStore={(locationId, pickedPeriod) => {
              setSearchParams(
                (prev) => {
                  if (locationId) prev.set('store', locationId);
                  else prev.delete('store');
                  prev.set('period', pickedPeriod);
                  return prev;
                },
                { replace: true },
              );
            }}
          />
        </div>

        {/* ===== Floor feed — the narration, and a way into each line ===== */}
        <OpsFloorFeed
          events={feed?.events ?? null}
          generatedAt={feed?.generatedAt ?? null}
          hours={feed?.hours ?? 36}
          loading={feed === null && !feedFailed}
          failed={feedFailed}
          onOpenRecord={setRecordId}
        />
      </div>

      {recordId && (
        <OpsShiftRecordDialog shiftId={recordId} onClose={() => setRecordId(null)} />
      )}
    </div>
  );
}

function HeadlineStat({
  label,
  value,
  icon: Icon,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  icon: typeof Users;
  tone: string;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="grid h-9 w-9 place-items-center rounded-md border border-navy-secondary bg-navy/60">
        <Icon className="h-4 w-4 text-gold" aria-hidden="true" />
      </span>
      <div>
        <div className={cn('text-xl font-semibold leading-none tabular-nums', tone)}>
          {value}
        </div>
        <div className="mt-1 text-2xs uppercase tracking-wider text-silver/60">{label}</div>
      </div>
    </div>
  );
}
