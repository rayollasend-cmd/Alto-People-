import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { disambiguateStores } from '@/lib/laborCostLabels';
import { withReturn } from '@/lib/returnPath';
import { termizeText } from '@/lib/modules';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  BadgeDollarSign,
  CalendarClock,
  ChevronDown,
  DollarSign,
  Download,
  Hourglass,
  RefreshCw,
  Scale,
  Search,
  Target,
  Timer,
  Users,
} from '@/components/ui/icons';
import type {
  FloorNowResponse,
  OtOutlookResponse,
  LaborCostRow,
  StaffingTargetLocation,
} from '@alto-people/shared';
import { PALETTE, Sparkline as KitSparkline, StackedBarChart, Treemap, TrendLineChart, type TreeNode } from '@/components/ui/charts';
import { ChartFrame } from '@/components/ui/ChartFrame';
import { MetricCard } from '@/components/ui/MetricCard';
import { MetricStrip } from '@/components/ui/MetricStrip';
import { FilterBar } from '@/components/ui/FilterBar';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import {
  floorNow,
  otOutlook,
  laborCosts,
  laborCostPeriods,
  listStaffingTargets,
  setStaffingTarget,
  storeTrends,
} from '@/lib/schedulingApi';
import { toast } from 'sonner';
import {
  Drawer,
  DrawerBody,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui';
import { ApiError, apiFetch } from '@/lib/api';
import { useAuth, useTerm, useTenant } from '@/lib/auth';
import { useStoreScope } from '@/lib/storeScope';
import { downloadCsv } from '@/lib/csv';
import { fmtDateOnly, fmtDateOnlyRange, fmtMoney, fmtMoneyCompact, fmtTime } from '@/lib/format';
import { cn } from '@/lib/cn';
import { usePersistentState } from '@/lib/usePersistentState';
import { useMinWidth } from '@/lib/useViewport';
import { urlDay, useUrlParam, useUrlState, useUrlWriter } from '@/lib/useUrlState';
import { ymd } from './calendarDates';
// Despite the legacy name, this is the ORG workweek start (Saturday).
import { startOfWeekMonday } from './WeekCalendarView';
import {
  MAX_RANGE_DAYS,
  addDaysYmd,
  daysInRange,
  everyDay,
  localYmd,
  presetRange,
  resolveRange,
  type RangePreset,
} from './laborCostRange';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { ListTemplate } from '@/components/templates';
import {
  Button,
  Card,
  CardContent,
  EmptyState,
  ErrorBanner,
  Input,
  Select,
  Skeleton,
  SkeletonRows,
} from '@/components/ui';

/**
 * Labor costs — the daily "what is this schedule costing us" report HR
 * asked for: one row per (day, client, store), scheduled cost next to
 * worked cost.
 *
 * Scheduled = every non-cancelled shift priced at its own payRate, else
 * the (client, position) rate default — identical resolution to the
 * scheduling page's KPI strip, so the two never disagree. Worked = every
 * clocked-out punch (approved or awaiting review) net of breaks, priced
 * at the rate snapshotted at clock-in. Rows missing rates are flagged,
 * not silently $0 — the fix lives in Clients → Rate defaults.
 */

// Delegates to the shared formatters — the private copies here had drifted
// from fmtMoneyCompact's tiering ($24.4k here vs $24k elsewhere).
const money = (v: number): string => fmtMoney(v);
const moneyCompact = (v: number): string => fmtMoneyCompact(v);
const hours = (minutes: number): string => `${(minutes / 60).toFixed(1)}h`;
const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/* ----- Chart series --------------------------------------------------------
 * The kit's palette in its fixed categorical order, so Scheduled / Worked /
 * Billable read the same here as on every other chart: scheduled = gold,
 * worked = steel, billable = the third hue.
 */
const SERIES = [
  { key: 'scheduled', name: 'Scheduled', color: PALETTE.primary },
  { key: 'worked', name: 'Worked', color: PALETTE.secondary },
];
const LINE_SERIES = [...SERIES, { key: 'revenue', name: 'Billable', color: PALETTE.tertiary }];

/** Small uppercase section label — the page's visual table of contents. */
function SectionLabel({ children, id }: { children: React.ReactNode; id?: string }) {
  return (
    <div id={id} className="mb-2 scroll-mt-20 text-2xs font-medium uppercase tracking-[0.18em] text-silver/60">
      {children}
    </div>
  );
}

/**
 * Daily trend — every day of the range on the axis (a day with nothing
 * scheduled is a real $0, not a missing tick: the gap between Oct 2 and
 * Oct 18 used to draw as one step), kit date ticks ("Sep 23"), and the
 * table/CSV alternative from the frame. Lines, not bars: at 30–92 days
 * three bars a day were too thin to draw on a phone.
 */
function CostTrendCard({
  data,
}: {
  data: Array<{ date: string; scheduled: number; worked: number; revenue: number }>;
}) {
  const sum = (k: 'scheduled' | 'worked' | 'revenue') => data.reduce((s, d) => s + d[k], 0);
  const first = data[0]?.date;
  const last = data[data.length - 1]?.date;
  return (
    <ChartFrame
      title="Daily labor cost vs billable value"
      summary={`${fmtDateOnlyRange(first, last)}: scheduled ${money(sum('scheduled'))}, worked ${money(sum('worked'))}, billable ${money(sum('revenue'))}.`}
      columns={[
        { key: 'date', label: 'Day', format: (v) => fmtDateOnly(String(v), { weekday: true, year: 'auto' }) },
        { key: 'scheduled', label: 'Scheduled', numeric: true, format: (v) => money(Number(v)) },
        { key: 'worked', label: 'Worked', numeric: true, format: (v) => money(Number(v)) },
        { key: 'revenue', label: 'Billable', numeric: true, format: (v) => money(Number(v)) },
      ]}
      rows={data}
      csvName="labor-cost-by-day"
      height={260}
    >
      <TrendLineChart data={data} x="date" xDates="day" series={LINE_SERIES} format={moneyCompact} />
    </ChartFrame>
  );
}

/** Horizontal grouped bars — scheduled vs worked per client (or store). */
function CostByGroupCard({
  title,
  data,
}: {
  title: string;
  data: Array<{ name: string; scheduled: number; worked: number }>;
}) {
  const height = Math.max(140, data.length * 44 + 40) + 24;
  const top = data[0];
  return (
    <ChartFrame
      title={title}
      summary={
        top
          ? `${top.name} leads with ${money(top.scheduled)} scheduled and ${money(top.worked)} worked, of ${data.length} ${data.length === 1 ? 'group' : 'groups'}.`
          : 'Nothing scheduled or worked.'
      }
      columns={[
        { key: 'name', label: title.replace(/^Cost by /, '').replace(/^\w/, (c) => c.toUpperCase()) },
        { key: 'scheduled', label: 'Scheduled', numeric: true, format: (v) => money(Number(v)) },
        { key: 'worked', label: 'Worked', numeric: true, format: (v) => money(Number(v)) },
      ]}
      rows={data}
      csvName={title.toLowerCase().replace(/\s+/g, '-')}
      height={height}
    >
      <StackedBarChart data={data} x="name" series={SERIES} stacked={false} layout="horizontal" format={moneyCompact} />
    </ChartFrame>
  );
}

/* ----- Where the money goes ------------------------------------------------
 * The range's labor cost as nested blocks — client, then store, then the
 * shift positions inside it — sized by scheduled or worked cost. The server
 * splits every (day, client, store) row by position so the parts add up to
 * the row to the cent; this folds the days together.
 */
const MONEY_SIDES = ['scheduled', 'worked'] as const;
type MoneySide = (typeof MONEY_SIDES)[number];
/** Where the blocks start: every client, one client's stores, or one store's positions. */
type MoneyDepth = 'client' | 'store' | 'position';

interface MoneyLeaf {
  clientKey: string;
  client: string;
  storeKey: string;
  store: string;
  positionKey: string;
  position: string;
  scheduled: number;
  worked: number;
}

const roundCents = (v: number) => Math.round(v * 100) / 100;
const shareText = (v: number, total: number): string => {
  if (total <= 0) return '0%';
  const pct = (v / total) * 100;
  return pct > 0 && pct < 1 ? '<1%' : `${Math.round(pct)}%`;
};

/** The (client, store, position) cells of the rows, their days added together. */
function moneyLeaves(rows: LaborCostRow[], names: { noClient: string; noStore: string }): MoneyLeaf[] {
  const byKey = new Map<string, MoneyLeaf>();
  for (const r of rows) {
    // A row with no breakdown (an older server) counts whole, as "All positions".
    const parts: Array<{ key: string; label: string; scheduled: number; worked: number }> = r.positions
      ? r.positions.map((p) => ({
          key: p.position === null ? '\u0000unscheduled' : p.position,
          // null = punches tied to no shift.
          label: p.position === null ? 'Unscheduled' : p.position || 'No position',
          scheduled: p.scheduledCost,
          worked: p.workedCost,
        }))
      : [{ key: '\u0000all', label: 'All positions', scheduled: r.scheduledCost, worked: r.workedCost }];
    for (const p of parts) {
      const key = `${r.clientId ?? ''}|${r.locationId ?? ''}|${p.key}`;
      const leaf = byKey.get(key) ?? {
        clientKey: r.clientId ?? '',
        client: r.clientName ?? names.noClient,
        storeKey: r.locationId ?? '',
        store: r.locationName ?? names.noStore,
        positionKey: p.key,
        position: p.label,
        scheduled: 0,
        worked: 0,
      };
      leaf.scheduled += p.scheduled;
      leaf.worked += p.worked;
      byKey.set(key, leaf);
    }
  }
  return [...byKey.values()].map((l) => ({ ...l, scheduled: roundCents(l.scheduled), worked: roundCents(l.worked) }));
}

const LEVELS: Record<MoneyDepth, Array<(l: MoneyLeaf) => [key: string, name: string]>> = {
  client: [(l) => [l.clientKey, l.client], (l) => [l.storeKey, l.store], (l) => [l.positionKey, l.position]],
  store: [(l) => [l.storeKey, l.store], (l) => [l.positionKey, l.position]],
  position: [(l) => [l.positionKey, l.position]],
};

/** Nest the cells level by level, biggest first; empty blocks are dropped. */
function moneyTree(leaves: MoneyLeaf[], side: MoneySide, levels: Array<(l: MoneyLeaf) => [string, string]>): TreeNode[] {
  const [level, ...rest] = levels;
  if (!level) return [];
  const groups = new Map<string, { name: string; items: MoneyLeaf[] }>();
  for (const l of leaves) {
    const [key, name] = level(l);
    const g = groups.get(key) ?? { name, items: [] };
    g.items.push(l);
    groups.set(key, g);
  }
  return [...groups.values()]
    .map((g): TreeNode => {
      const value = roundCents(g.items.reduce((s, l) => s + l[side], 0));
      return rest.length > 0 ? { name: g.name, value, children: moneyTree(g.items, side, rest) } : { name: g.name, value };
    })
    .filter((n) => n.value > 0)
    .sort((a, z) => z.value - a.value || a.name.localeCompare(z.name));
}

/** "$48,210.00 scheduled this pay period; Front Beach is 41%, led by Housekeeper ($9,870.00)." */
function moneySummary(tree: TreeNode[], side: MoneySide, when: string, start: MoneyDepth): string {
  const total = roundCents(tree.reduce((s, n) => s + n.value, 0));
  const top = tree[0];
  if (!top || total <= 0) return `No ${side} labor cost ${when}.`;
  const head = `${money(total)} ${side} ${when}`;
  const share =
    tree.length === 1 ? `all of it ${start === 'position' ? 'on' : 'at'} ${top.name}` : `${top.name} is ${shareText(top.value, total)}`;
  if (start === 'position') return `${head}; ${share} (${money(top.value)}).`;
  // The biggest position inside the biggest block (through its stores, from the client level).
  let lead: { name: string; value: number; store?: string } | null = null;
  for (const child of top.children ?? []) {
    if (start === 'store') {
      if (!lead || child.value > lead.value) lead = { name: child.name, value: child.value };
      continue;
    }
    for (const pos of child.children ?? []) {
      if (!lead || pos.value > lead.value) lead = { name: pos.name, value: pos.value, store: child.name };
    }
  }
  if (!lead) return `${head}; ${share}.`;
  return `${head}; ${share}, led by ${lead.name}${lead.store ? ` at ${lead.store}` : ''} (${money(lead.value)}).`;
}

function MoneyTreemapCard({
  rows,
  start,
  when,
  hasClients,
  term,
}: {
  rows: LaborCostRow[];
  start: MoneyDepth;
  /** "this pay period", "last pay period", "in Sep 1 – Oct 1". */
  when: string;
  hasClients: boolean;
  term: Parameters<typeof termizeText>[1];
}) {
  // The page's primary measure is the plan: scheduled first, worked one tap away.
  const [side, setSide] = useUrlParam<MoneySide>('money', 'scheduled', MONEY_SIDES);
  // A phone's column is narrow: a squarer box keeps the blocks readable.
  const wide = useMinWidth(640);
  const noStore = termizeText('No store', term);
  const leaves = useMemo(() => moneyLeaves(rows, { noClient: 'No client set', noStore }), [rows, noStore]);
  const tree = useMemo(() => moneyTree(leaves, side, LEVELS[start]), [leaves, side, start]);
  const total = useMemo(() => roundCents(tree.reduce((s, n) => s + n.value, 0)), [tree]);
  const tableRows = useMemo(
    () =>
      leaves
        .filter((l) => l[side] > 0)
        .sort((a, z) => z[side] - a[side])
        .map((l) => ({ client: l.client, store: l.store, position: l.position, cost: l[side], share: total > 0 ? l[side] / total : 0 })),
    [leaves, side, total],
  );
  const sized = side === 'scheduled' ? 'scheduled cost (shift hours at their pay rates)' : 'worked cost (punches at their pay, overtime included)';
  const inside = termizeText(start === 'client' ? ', inside its store and client' : start === 'store' ? ', inside its store' : ' at this store', term);
  return (
    <ChartFrame
      title="Where the money goes"
      description={
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <span className="min-w-0 flex-1 basis-64">
            Which jobs the labor money pays for. Each block is a position&rsquo;s {sized}
            {inside}; tap one to zoom in.
            {side === 'worked' && ' Time worked on no shift shows as Unscheduled.'}
          </span>
          <SegmentedControl<MoneySide>
            ariaLabel="Size blocks by"
            value={side}
            onChange={setSide}
            options={[
              { value: 'scheduled', label: 'Scheduled' },
              { value: 'worked', label: 'Worked' },
            ]}
          />
        </div>
      }
      summary={moneySummary(tree, side, when, start)}
      columns={[
        ...(hasClients ? [{ key: 'client', label: 'Client' }] : []),
        { key: 'store', label: termizeText('Store', term) },
        { key: 'position', label: 'Position' },
        { key: 'cost', label: side === 'scheduled' ? 'Scheduled cost' : 'Worked cost', numeric: true, format: (v) => money(Number(v)) },
        { key: 'share', label: 'Share', numeric: true, format: (v) => shareText(Number(v), 1) },
      ]}
      rows={tableRows}
      csvName={`labor-cost-by-position-${side}`}
      height={wide ? 420 : 360}
      empty={
        <EmptyState
          size="sm"
          icon={DollarSign}
          title={side === 'scheduled' ? 'No scheduled cost in this range' : 'No worked cost in this range'}
          description={side === 'scheduled' ? 'Shifts show here once they are on the schedule.' : 'Punches show here once people clock out.'}
        />
      }
    >
      <Treemap data={tree} format={moneyCompact} />
    </ChartFrame>
  );
}

const minuteToHhmm = (m: number): string =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const hhmmToMinute = (s: string): number | null => {
  const [h, m] = s.split(':').map(Number);
  if (!Number.isInteger(h) || !Number.isInteger(m)) return null;
  return h * 60 + m;
};

/**
 * OT outlook — the names behind the floor board's "OT risk" chips: every
 * associate whose week lands in overtime (worked + remaining scheduled,
 * cross-client), split and priced by the server's labor-rules engine as
 * payroll will pay it. Quiet when clean.
 */
function OtOutlookCard() {
  const hasClients = useTenant().moduleOn('clientPortal');
  const [refreshing, setRefreshing] = useState(false);
  // Collapsed state survives visits — a supervisor who works from the
  // daily tables can keep the radar folded to its one-line summary.
  const [open, setOpen] = usePersistentState<boolean>(
    'alto:laborcosts.otOutlook.open.v1',
    true,
    (v): v is boolean => typeof v === 'boolean',
  );
  const [q, setQ] = useState('');
  const [clientFilter, setClientFilter] = useState('');
  const [minOtHours, setMinOtHours] = useState(0);

  // Initial-load failure renders nothing — this card is an extra lens
  // and the floor board above shows the aggregate chips. An explicit
  // REFRESH failure must speak, though (handled at the button).
  // The Topbar store scope narrows on the server, before its cap.
  const otScopeForQuery = useStoreScope();
  const otClientId = otScopeForQuery.enabled ? otScopeForQuery.clientId : null;
  const outlookQuery = useQuery({
    queryKey: ['OtOutlookCard', 'outlook', otClientId ?? ''],
    queryFn: () => otOutlook(otClientId),
  });
  const data: OtOutlookResponse | null = outlookQuery.data ?? null;
  const load = async (): Promise<boolean> => {
    const r = await outlookQuery.refetch();
    return r.status === 'success';
  };

  // Follow the global Topbar store scope. This lens filters by client NAME
  // (rows carry a display string, not ids), so the scope id is mapped
  // through the scope's own client list.
  const otScope = useStoreScope();
  const otScopeClientName = otScope.enabled
    ? (otScope.clients.find((c) => c.id === otScope.clientId)?.name ?? '')
    : null;
  useEffect(() => {
    if (otScopeClientName === null) return;
    setClientFilter((prev) => (prev === otScopeClientName ? prev : otScopeClientName));
  }, [otScopeClientName]);

  // Client options come from the rows themselves (an associate can span
  // clients within the week — they match any of theirs).
  const clientOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of data?.rows ?? []) {
      for (const name of r.clientNames.split(' · ')) set.add(name);
    }
    return [...set].sort();
  }, [data]);

  const filtered = useMemo(() => {
    let list = data?.rows ?? [];
    if (clientFilter) {
      list = list.filter((r) => r.clientNames.split(' · ').includes(clientFilter));
    }
    const term = q.trim().toLowerCase();
    if (term) list = list.filter((r) => r.associateName.toLowerCase().includes(term));
    if (minOtHours > 0) {
      list = list.filter((r) => r.projectedOtMinutes >= minOtHours * 60);
    }
    return list;
  }, [data, clientFilter, q, minOtHours]);

  if (!data || data.rows.length === 0) return null;
  const h = (min: number) => (min / 60).toFixed(1);
  const totalOtMin = data.rows.reduce((s, r) => s + r.projectedOtMinutes, 0);
  const totalBilled = data.rows.reduce((s, r) => s + (r.estOtBilled ?? 0), 0);
  // The bill, named: the single biggest contributor to this week's OT.
  const topContributor = [...data.rows].sort(
    (a, b) => (b.estOtBilled ?? 0) - (a.estOtBilled ?? 0),
  )[0];
  const anyFilter = clientFilter !== '' || q.trim() !== '' || minOtHours > 0;

  return (
    <div className="rounded-lg border border-warning/40 bg-warning/[0.04]">
      {/* Header doubles as the collapse toggle; the one-line summary stays
          readable either way. */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex min-w-0 items-center gap-2 text-left"
        >
          <ChevronDown
            className={cn(
              'h-4 w-4 shrink-0 text-warning/70 transition-transform',
              !open && '-rotate-90',
            )}
          />
          <h2 className="text-sm font-semibold text-white">
            Overtime ahead this week
          </h2>
          <span className="rounded-full bg-warning/15 px-2 py-0.5 text-2xs font-medium tabular-nums text-warning">
            {data.rows.length} {data.rows.length === 1 ? 'person' : 'people'} ·{' '}
            {h(totalOtMin)} h · ≈ {money(totalBilled)}
          </span>
        </button>
        <div className="flex items-center gap-2">
          <span className="text-2xs text-silver/60">
            as of {fmtTime(data.generatedAt)}
          </span>
          <Button
            size="xs"
            variant="ghost"
            aria-label="Refresh overtime outlook"
            loading={refreshing}
            onClick={async () => {
              setRefreshing(true);
              const ok = await load();
              setRefreshing(false);
              // Silent failure left the "as of" time lying about freshness.
              if (!ok) toast.error('Could not refresh the overtime outlook.');
            }}
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {open && (
        <div className="border-t border-warning/20 px-4 pb-4 pt-3">
          <p className="mb-3 text-xs text-silver">
            <span className="font-medium text-warning">
              Unchecked, this week&apos;s overtime bills ≈ {money(totalBilled)}
            </span>
            {topContributor && (topContributor.estOtBilled ?? 0) > 0 && (
              <>
                {' '}
                — biggest single line: {topContributor.associateName} (≈{' '}
                {money(topContributor.estOtBilled ?? 0)}).
              </>
            )}{' '}
            Worked so far plus remaining scheduled shifts lands in overtime,
            split the way payroll will pay it. Trimming or reassigning a shift on the{' '}
            <Link to="/scheduling" className="text-gold hover:underline">
              schedule
            </Link>{' '}
            removes the overtime before it exists.
          </p>

          {/* Filters — client-side lenses over the fetched week. */}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {hasClients && clientOptions.length > 1 && (
              <Select
                size="sm"
                aria-label="Filter by client"
                value={clientFilter}
                onChange={(e) => setClientFilter(e.target.value)}
                className="w-44"
              >
                <option value="">All clients</option>
                {clientOptions.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            )}
            <Select
              size="sm"
              aria-label="Minimum projected overtime"
              value={String(minOtHours)}
              onChange={(e) => setMinOtHours(Number(e.target.value))}
              className="w-36"
            >
              <option value="0">Any OT</option>
              <option value="1">≥ 1 h OT</option>
              <option value="4">≥ 4 h OT</option>
              <option value="8">≥ 8 h OT</option>
            </Select>
            <div className="relative w-full sm:w-56">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-silver/60" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Find an associate…"
                aria-label="Search at-risk associates by name"
                className="h-8 pl-8 text-sm"
              />
            </div>
            {anyFilter && (
              <span className="text-2xs tabular-nums text-silver/60">
                {filtered.length} of {data.rows.length} shown
              </span>
            )}
          </div>

          {filtered.length === 0 ? (
            <p className="text-sm text-silver">
              No one matches those filters — clear them to see all{' '}
              {data.rows.length} at-risk {data.rows.length === 1 ? 'person' : 'people'}.
            </p>
          ) : (
            <OtOutlookTable rows={filtered} />
          )}
        </div>
      )}
    </div>
  );
}

function OtOutlookTable({ rows }: { rows: OtOutlookResponse['rows'] }) {
  const h = (min: number) => (min / 60).toFixed(1);
  // The radar projects the CURRENT org workweek (Sat→Fri), so each name
  // deep-links to that exact week in the schedule, focused on the person.
  // The rows carry no client/location ids, so those params are omitted.
  const weekParam = ymd(startOfWeekMonday(new Date()));
  const scheduleLink = (associateId: string) =>
    `/scheduling?view=week&week=${weekParam}&associate=${associateId}`;
  return (
    <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-navy-secondary text-2xs uppercase tracking-wider text-silver/60">
              <th className="py-1.5 pr-3 text-left font-medium">Associate</th>
              <th className="py-1.5 px-3 text-left font-medium hidden md:table-cell">
                Client
              </th>
              <th className="py-1.5 px-3 text-right font-medium">Worked</th>
              <th className="py-1.5 px-3 text-right font-medium hidden sm:table-cell">
                Still scheduled
              </th>
              <th className="py-1.5 px-3 text-right font-medium">Projected</th>
              <th className="py-1.5 pl-3 text-right font-medium">OT · est. billed</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-navy-secondary/50">
            {rows.map((r) => (
              <tr key={r.associateId}>
                <td className="py-1.5 pr-3">
                  <Link
                    to={scheduleLink(r.associateId)}
                    className="text-white hover:text-gold hover:underline"
                    title={`Open ${r.associateName}'s week on the schedule to trim a shift`}
                  >
                    {r.associateName}
                  </Link>
                </td>
                <td className="py-1.5 px-3 text-silver hidden md:table-cell">
                  {r.clientNames}
                </td>
                <td className="py-1.5 px-3 text-right tabular-nums text-silver">
                  {h(r.workedMinutes)} h
                </td>
                <td className="py-1.5 px-3 text-right tabular-nums text-silver hidden sm:table-cell">
                  {h(r.remainingScheduledMinutes)} h
                </td>
                <td className="py-1.5 px-3 text-right tabular-nums font-medium text-white">
                  {h(r.projectedMinutes)} h
                </td>
                <td className="py-1.5 pl-3 text-right tabular-nums font-semibold text-warning">
                  {h(r.projectedOtMinutes)} h
                  {r.estOtBilled !== null && (
                    <span className="text-warning/70"> · {money(r.estOtBilled)}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
      </table>
    </div>
  );
}


/**
 * Store benchmarks — each store's 4-week margin/hr trend (sparkline) and
 * where it sits against the org's own "speed of light": the best store's
 * average. A store at 62% of what a sister store proves possible is a
 * conversation, not a mystery.
 */
interface StoreTrend {
  clientId: string;
  locationId: string;
  locationName: string;
  clientName: string;
  weeks: Array<{ start: string; hours: number; marginPerHour: number | null }>;
  avgMarginPerHour: number | null;
  hours4w: number;
}


/** A store's margin per hour, week by week — the kit's sparkline (gaps stay gaps). */
function MarginSparkline({ weeks }: { weeks: StoreTrend['weeks'] }) {
  const vals = weeks.map((w) => w.marginPerHour);
  const present = vals.filter((v): v is number => v !== null);
  if (present.length < 2) return <span className="w-24 text-2xs text-silver/40">—</span>;
  const lastUp = present[present.length - 1]! >= present[present.length - 2]!;
  return <KitSparkline series={vals} tone={lastUp ? 'good' : 'warn'} width={96} height={24} area={false} />;
}

function StoreTrendsCard() {
  const [open, setOpen] = usePersistentState<boolean>(
    'alto:laborcosts.trends.open.v1',
    true,
    (v): v is boolean => typeof v === 'boolean',
  );

  const trendScope = useStoreScope();
  const trendClientId = trendScope.enabled ? trendScope.clientId : null;
  const dataQuery = useQuery({
    queryKey: ['StoreTrendsCard', 'data', trendClientId ?? ''],
    queryFn: () => storeTrends<StoreTrend>(trendClientId),
  });
  const failed = dataQuery.isError;
  const data: { stores: StoreTrend[]; bestMarginPerHour: number } | null = dataQuery.data ?? null;

  if (failed || (data !== null && data.stores.length === 0)) return null;
  if (data === null) return <Skeleton className="h-24" />;
  const best = data.bestMarginPerHour;

  return (
    <Card>
      <CardContent>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex w-full min-w-0 items-center gap-2 text-left"
        >
          <ChevronDown
            className={cn(
              'h-4 w-4 shrink-0 text-silver/60 transition-transform',
              !open && '-rotate-90',
            )}
          />
          <span className="text-sm font-medium text-white">Store benchmarks — 4 weeks</span>
          <span className="ml-auto text-2xs text-silver/60">
            margin/hr vs the best store&apos;s pace
          </span>
        </button>
        {open && (
          <ul className="mt-3 space-y-2.5">
            {data.stores.map((s) => {
              const pct =
                best > 0 && s.avgMarginPerHour !== null
                  ? Math.max(0, Math.min(100, (s.avgMarginPerHour / best) * 100))
                  : null;
              return (
                <li key={s.locationId} className="flex items-center gap-3">
                  <span className="w-40 min-w-0 shrink-0 truncate text-sm text-white">
                    {s.locationName}
                  </span>
                  <MarginSparkline weeks={s.weeks} />
                  <span
                    className={cn(
                      'w-20 shrink-0 text-right text-sm tabular-nums',
                      s.avgMarginPerHour === null
                        ? 'text-silver/40'
                        : s.avgMarginPerHour >= 0
                          ? 'text-success'
                          : 'text-alert',
                    )}
                  >
                    {s.avgMarginPerHour === null
                      ? '—'
                      : `${s.avgMarginPerHour >= 0 ? '+' : '−'}${money(Math.abs(s.avgMarginPerHour))}/h`}
                  </span>
                  <span className="hidden flex-1 items-center gap-2 sm:flex">
                    <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-navy-secondary/70">
                      {pct !== null && (
                        <span
                          className={cn(
                            'block h-full rounded-full',
                            pct >= 85 ? 'bg-success/80' : pct >= 60 ? 'bg-gold/80' : 'bg-warning/80',
                          )}
                          style={{ width: `${pct}%` }}
                        />
                      )}
                    </span>
                    <span className="w-12 shrink-0 text-right text-2xs tabular-nums text-silver/60">
                      {pct !== null ? `${Math.round(pct)}%` : ''}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}


/**
 * Live floor — ONE line under the range summary: who is clocked in right
 * now against the expected headcount, and what that burns and bills per
 * hour. It used to lead this historical report as a full card; the live
 * picture is the Control room's, linked from the line, and the store
 * ledger (with Broadcast to bench) is one click down. With nobody on the
 * floor there is no rate to show — "No one on the floor", never a green
 * "+$0.00/hr". Polls every 60s while the tab is visible.
 */
function LiveFloorLine() {
  const floorScope = useStoreScope();
  const floorClientId = floorScope.enabled ? floorScope.clientId : null;
  const [data, setData] = useState<FloorNowResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // Folded by default (a new key: the old card defaulted open).
  const [open, setOpen] = usePersistentState<boolean>(
    'alto:laborcosts.floor.open.v2',
    false,
    (v): v is boolean => typeof v === 'boolean',
  );

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await floorNow(floorClientId);
        if (!cancelled) {
          setData(r);
          setFailed(false);
        }
      } catch {
        if (!cancelled) setFailed(true);
      }
    };
    void tick();
    // Pause in backgrounded tabs (this poll kept firing all night in a
    // hidden tab); refresh immediately when the tab comes back.
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void tick();
    }, 60_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [reloadKey, floorClientId]);

  const { can } = useAuth();
  const canManage = can('manage:scheduling');
  const canLive = can('view:time-live');
  const [showNominal, setShowNominal] = useState(false);
  const [broadcasting, setBroadcasting] = useState<string | null>(null);
  const broadcast = async (clientId: string) => {
    if (broadcasting) return;
    setBroadcasting(clientId);
    try {
      const r = await apiFetch<{ shiftsScanned: number; invitesSent: number }>(
        '/scheduling/broadcast-bench',
        { method: 'POST', body: { clientId } },
      );
      toast.success(
        r.invitesSent > 0
          ? `Invited ${r.invitesSent} bench associate${r.invitesSent === 1 ? '' : 's'} across ${r.shiftsScanned} open shift${r.shiftsScanned === 1 ? '' : 's'}.`
          : r.shiftsScanned > 0
            ? 'Every eligible bench associate was already invited — nothing new to send.'
            : 'No open shifts in the next 48h for this client.',
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not broadcast.');
    } finally {
      setBroadcasting(null);
    }
  };

  // Anomaly-first: short-staffed and negative-margin stores rise; clean
  // stores fold into a single "nominal" strip below.
  const badnessOf = useCallback(
    (r: NonNullable<typeof data>['rows'][number]): number => {
      const short = r.expected !== null ? Math.max(0, r.expected - r.clockedIn) : 0;
      const margin = (r.billedPerHour ?? 0) - (r.loadedPerHour ?? 0);
      const negMargin = r.clockedIn > 0 && margin < 0 ? 1.5 : 0;
      return short * 2 + negMargin + (r.projectedOtHeads ?? 0) * 0.5;
    },
    [],
  );
  const { anomalyRows, nominalRows } = useMemo(() => {
    const rows = [...(data?.rows ?? [])].sort(
      (a, b) =>
        badnessOf(b) - badnessOf(a) ||
        a.clientName.localeCompare(b.clientName) ||
        a.locationName.localeCompare(b.locationName),
    );
    return {
      anomalyRows: rows.filter((r) => badnessOf(r) > 0),
      nominalRows: rows.filter((r) => badnessOf(r) === 0),
    };
  }, [data, badnessOf]);

  // A failed board must SAY so — silently dropping it reads as "nobody's
  // working", which is worse than an error.
  if (failed && data === null) {
    return (
      <ErrorBanner
        severity="warning"
        action={
          <Button size="sm" variant="secondary" onClick={() => setReloadKey((k) => k + 1)}>
            Retry
          </Button>
        }
      >
        Couldn&apos;t load who is on the floor right now.
      </ErrorBanner>
    );
  }
  if (data === null) return <Skeleton className="h-11" />;
  if (data.rows.length === 0) return null;

  const total = data.rows.reduce(
    (t, r) => ({
      clockedIn: t.clockedIn + r.clockedIn,
      expected: t.expected + (r.expected ?? 0),
      loadedPerHour: t.loadedPerHour + (r.loadedPerHour ?? 0),
      billedPerHour: t.billedPerHour + (r.billedPerHour ?? 0),
      otHeads: t.otHeads + (r.otHeads ?? 0),
      projectedOtHeads: t.projectedOtHeads + (r.projectedOtHeads ?? 0),
    }),
    { clockedIn: 0, expected: 0, loadedPerHour: 0, billedPerHour: 0, otHeads: 0, projectedOtHeads: 0 },
  );
  const onFloor = total.clockedIn > 0;
  const margin = total.billedPerHour - total.loadedPerHour;
  const storesPerClient = new Map<string, number>();
  for (const r of data.rows) {
    storesPerClient.set(r.clientId, (storesPerClient.get(r.clientId) ?? 0) + 1);
  }
  const anyMultiStoreClient = [...storesPerClient.values()].some((n) => n > 1);

  return (
    <div className="rounded-lg border border-navy-secondary bg-navy/40" data-testid="live-floor">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? 'Hide the stores' : 'Show the stores'}
          className="flex shrink-0 items-center gap-2 text-left"
        >
          <ChevronDown
            className={cn('h-4 w-4 shrink-0 text-silver/60 transition-transform', !open && '-rotate-90')}
            aria-hidden="true"
          />
          <span className="relative flex h-2 w-2" aria-hidden="true">
            {onFloor && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success/60" />}
            <span className={cn('relative inline-flex h-2 w-2 rounded-full', onFloor ? 'bg-success' : 'bg-silver/40')} />
          </span>
          <span className="font-medium text-white">Live now</span>
        </button>
        <span className="min-w-0 tabular-nums text-silver">
          {onFloor ? (
            <>
              <span className="text-white">{total.clockedIn}</span>
              {total.expected > 0 ? ` of ${total.expected}` : ''} on the floor
              {' · '}burn {money(total.loadedPerHour)}/hr
              {' · '}billing {money(total.billedPerHour)}/hr
              {' · '}margin{' '}
              <span className={margin >= 0 ? 'text-success' : 'text-alert'}>
                {margin >= 0 ? '+' : '−'}
                {money(Math.abs(margin))}/hr
              </span>
            </>
          ) : (
            <>
              No one on the floor
              {total.expected > 0 ? ` · ${total.expected} expected` : ''}
            </>
          )}
        </span>
        {total.otHeads > 0 && (
          <span className="rounded bg-warning/15 px-1.5 py-0.5 text-2xs font-medium text-warning">
            {total.otHeads} in overtime
          </span>
        )}
        {total.projectedOtHeads > 0 && (
          <span
            className="rounded border border-warning/40 px-1.5 py-0.5 text-2xs font-medium text-warning/80"
            title="Will pass 40h this week if their remaining shifts run as scheduled — trim a shift to avoid 1.5× billing."
          >
            {total.projectedOtHeads} at overtime risk
          </span>
        )}
        {canLive && (
          <Link to="/control-room" className="ml-auto shrink-0 text-xs text-gold hover:underline">
            Control room →
          </Link>
        )}
      </div>
      {open && (
        <div className="overflow-x-auto border-t border-navy-secondary px-4 pb-3 pt-2">
          <table className="w-full text-sm">
            <caption className="sr-only">Stores on the floor right now</caption>
            <thead>
              <tr className="border-b border-navy-secondary text-2xs uppercase tracking-wider text-silver/60">
                <th className="py-1.5 pr-3 text-left font-medium">Store</th>
                <th className="py-1.5 px-3 text-left font-medium hidden md:table-cell">Window</th>
                <th className="py-1.5 px-3 text-right font-medium">On floor</th>
                <th className="py-1.5 px-3 text-right font-medium hidden sm:table-cell">Cost / hr</th>
                <th className="py-1.5 px-3 text-right font-medium hidden sm:table-cell">Billed / hr</th>
                <th className="py-1.5 px-3 text-right font-medium">Margin / hr</th>
                <th className="py-1.5 pl-3 text-right font-medium hidden lg:table-cell">Shift so far</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-navy-secondary/50">
              {[...anomalyRows, ...(showNominal ? nominalRows : [])].map((r) => {
                const over = r.expected !== null && r.clockedIn > r.expected;
                const under = r.expected !== null && r.clockedIn < r.expected;
                const rowMargin = (r.billedPerHour ?? 0) - (r.loadedPerHour ?? 0);
                const negMargin = r.clockedIn > 0 && rowMargin < 0;
                return (
                  <tr
                    key={r.locationId}
                    className={cn(under && 'bg-warning/[0.045]', !under && (over || negMargin) && 'bg-alert/[0.04]')}
                  >
                    <td className="py-2 pr-3">
                      <div className="text-white">{r.locationName}</div>
                      {anyMultiStoreClient && r.clientName !== r.locationName && (
                        <div className="text-2xs text-silver/70">{r.clientName}</div>
                      )}
                      {/* Act in place: a short floor gets its fix here. */}
                      {under && canManage && (
                        <button
                          type="button"
                          disabled={broadcasting !== null}
                          onClick={() => void broadcast(r.clientId)}
                          className="mt-0.5 text-2xs text-gold hover:text-gold-bright disabled:opacity-50"
                        >
                          {broadcasting === r.clientId ? 'Broadcasting…' : 'Broadcast to bench →'}
                        </button>
                      )}
                    </td>
                    <td className="py-2 px-3 hidden md:table-cell">
                      {r.windowLabel ? (
                        <span className="rounded bg-navy-secondary/50 px-1.5 py-0.5 text-2xs text-silver">
                          {r.windowLabel}
                        </span>
                      ) : r.expected !== null ? (
                        <span className="text-2xs text-silver/70">floor total</span>
                      ) : (
                        <span className="text-2xs text-silver/40">no target</span>
                      )}
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums">
                      <span
                        className={over ? 'font-semibold text-alert' : under ? 'font-semibold text-warning' : 'text-white'}
                        title={
                          over
                            ? `${r.clockedIn - r.expected!} above the expected headcount`
                            : under
                              ? `${r.expected! - r.clockedIn} below the expected headcount`
                              : undefined
                        }
                      >
                        {r.clockedIn}
                        <span className="text-silver/70"> / {r.expected !== null ? r.expected : '—'}</span>
                      </span>
                      {(r.otHeads ?? 0) > 0 && (
                        <span className="ml-1.5 rounded bg-warning/15 px-1.5 py-0.5 text-2xs font-medium text-warning">
                          {r.otHeads} OT
                        </span>
                      )}
                      {(r.projectedOtHeads ?? 0) > 0 && (
                        <span
                          className="ml-1.5 rounded border border-warning/40 px-1.5 py-0.5 text-2xs font-medium text-warning/80"
                          title="Will pass 40h this week if remaining shifts run as scheduled."
                        >
                          {r.projectedOtHeads} OT risk
                        </span>
                      )}
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums text-silver hidden sm:table-cell">
                      {r.clockedIn > 0 ? money(r.loadedPerHour ?? 0) : '—'}
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums text-silver hidden sm:table-cell">
                      {r.clockedIn > 0 ? money(r.billedPerHour ?? 0) : '—'}
                    </td>
                    <td
                      className={`py-2 px-3 text-right tabular-nums font-medium ${
                        r.clockedIn > 0 ? (rowMargin >= 0 ? 'text-success' : 'text-alert') : 'text-silver/40'
                      }`}
                    >
                      {r.clockedIn > 0 ? `${rowMargin >= 0 ? '+' : '−'}${money(Math.abs(rowMargin))}` : '—'}
                    </td>
                    <td className="py-2 pl-3 text-right tabular-nums text-2xs text-silver/60 hidden lg:table-cell">
                      {r.clockedIn > 0 ? `${money(r.loadedSoFar ?? 0)} · billed ${money(r.billedSoFar ?? 0)}` : '—'}
                    </td>
                  </tr>
                );
              })}
              {/* Clean stores fold into one calm line. */}
              {nominalRows.length > 0 && (
                <tr>
                  <td colSpan={7} className="py-1.5">
                    <button
                      type="button"
                      onClick={() => setShowNominal((v) => !v)}
                      aria-expanded={showNominal}
                      className="flex w-full items-center gap-2 rounded-md border border-navy-secondary bg-navy-secondary/20 px-3 py-1.5 text-xs text-silver transition-colors hover:bg-navy-secondary/40"
                    >
                      {nominalRows.length} store{nominalRows.length === 1 ? '' : 's'} staffed to target, nothing to act on
                      <span className="ml-auto text-silver/60">{showNominal ? 'hide' : 'show'}</span>
                    </button>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {data.burden && (
            <p className="mt-2 text-2xs text-silver/60">
              Loaded cost = wages × (1 + {data.burden.percent}% burden)
              {data.burden.overheadPerHour > 0 ? ` + ${money(data.burden.overheadPerHour)}/hr overhead` : ''}. Overtime past
              40h a week (all sites) at 1.5×. Refreshes every minute.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Expected floor headcount per store — "we should run 6 at Destin".
 * Effective-dated on the server: saving records a NEW row from the chosen
 * date, so past days keep being judged by the target that applied then.
 */
function TargetsDrawer({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  onChanged: () => void;
}) {
  const term = useTerm();
  const loadTargetsQuery = useQuery({
    queryKey: ['TargetsDrawer', 'locations'],
    queryFn: () => listStaffingTargets(),
  });
  const locations: StaffingTargetLocation[] | null = loadTargetsQuery.isError ? [] : (loadTargetsQuery.data?.locations ?? null);
  const error = loadTargetsQuery.error ? loadTargetsQuery.error instanceof ApiError ? loadTargetsQuery.error.message : 'Could not load targets.' : null;
  const loadTargets = async () => {
    await loadTargetsQuery.refetch();
  };


  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} width="max-w-xl">
      <DrawerHeader>
        <DrawerTitle>Floor targets</DrawerTitle>
      </DrawerHeader>
      <DrawerBody>
        <p className="mb-3 text-xs text-silver">
          The number of {term('workers').toLowerCase()} each {term('site').toLowerCase()} is expected to run. Saving takes
          effect from the chosen date forward — history is kept, so past days
          stay measured against the target that applied then.
        </p>
        {error && <ErrorBanner className="mb-3">{error}</ErrorBanner>}
        {locations === null ? (
          <SkeletonRows count={4} />
        ) : locations.length === 0 ? (
          <EmptyState title={`No active ${term('sites').toLowerCase()} in your scope`} description="Targets can be set once a location is active." />
        ) : (
          <ul className="divide-y divide-navy-secondary">
            {locations.map((l) => (
              <TargetRow key={l.locationId} location={l} onSaved={() => {
                void loadTargets();
                onChanged();
              }} />
            ))}
          </ul>
        )}
      </DrawerBody>
    </Drawer>
  );
}

function TargetRow({
  location,
  onSaved,
}: {
  location: StaffingTargetLocation;
  onSaved: () => void;
}) {
  const [count, setCount] = useState(
    location.targetCount !== null ? String(location.targetCount) : '',
  );
  const [from, setFrom] = useState(localYmd());
  const [busy, setBusy] = useState(false);
  const dirty = count !== (location.targetCount !== null ? String(location.targetCount) : '');

  const save = async () => {
    const n = Number(count);
    if (!count || !Number.isInteger(n) || n < 0) {
      toast.error('Enter a whole number of associates.');
      return;
    }
    setBusy(true);
    try {
      await setStaffingTarget({
        locationId: location.locationId,
        targetCount: n,
        effectiveFrom: from,
      });
      toast.success(`${location.locationName}: target ${n} from ${from}.`);
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not save the target.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm text-white">{location.locationName}</div>
          <div className="truncate text-xs text-silver/70">
            {location.clientName}
            {location.targetCount !== null && location.effectiveFrom
              ? ` · floor total: ${location.targetCount} since ${location.effectiveFrom}`
              : ' · no total target set'}
          </div>
        </div>
        <Input
          type="number"
          min={0}
          step={1}
          value={count}
          onChange={(e) => setCount(e.target.value)}
          placeholder="Heads"
          className="h-9 w-20"
          aria-label={`Expected associates at ${location.locationName}`}
        />
        <Input
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          className="h-9 w-36"
          aria-label={`Effective from date for ${location.locationName}`}
        />
        <Button size="sm" onClick={() => void save()} loading={busy} disabled={busy || !dirty}>
          Save
        </Button>
      </div>

      {/* Per-shift windows — what the live board compares clock-ins to
          while the window covers the store's local time. */}
      <div className="mt-1.5 pl-3 border-l border-navy-secondary/60">
        {location.windows.map((w) => (
          <div key={w.label} className="flex items-center gap-2 py-0.5 text-xs text-silver">
            <span className="text-white">{w.label}</span>
            <span className="tabular-nums">
              {minuteToHhmm(w.startMinute)}–{minuteToHhmm(w.endMinute)}
            </span>
            <span className="tabular-nums text-white">{w.targetCount} heads</span>
            <span className="text-silver/70">since {w.effectiveFrom}</span>
          </div>
        ))}
        <WindowForm location={location} onSaved={onSaved} />
      </div>
    </li>
  );
}

/** Add (or re-date) a per-shift window target: label + times + heads. */
function WindowForm({
  location,
  onSaved,
}: {
  location: StaffingTargetLocation;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [start, setStart] = useState('06:00');
  const [end, setEnd] = useState('14:00');
  const [count, setCount] = useState('');
  const [busy, setBusy] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-0.5 text-2xs uppercase tracking-wider text-silver/60 underline underline-offset-2 hover:text-gold"
      >
        + shift window
      </button>
    );
  }

  const save = async () => {
    const n = Number(count);
    const startMinute = hhmmToMinute(start);
    const endMinute = hhmmToMinute(end);
    if (!label.trim() || startMinute === null || endMinute === null) {
      toast.error('Give the window a name and both times.');
      return;
    }
    if (!count || !Number.isInteger(n) || n < 0) {
      toast.error('Enter a whole number of heads.');
      return;
    }
    setBusy(true);
    try {
      await setStaffingTarget({
        locationId: location.locationId,
        targetCount: n,
        label: label.trim(),
        startMinute,
        endMinute,
      });
      toast.success(`${location.locationName}: "${label.trim()}" → ${n} heads.`);
      setOpen(false);
      setLabel('');
      setCount('');
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not save the window.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5">
      <Input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="Morning"
        maxLength={60}
        className="h-8 w-28 text-xs"
        aria-label="Shift window name"
      />
      <Input
        type="time"
        value={start}
        onChange={(e) => setStart(e.target.value)}
        className="h-8 w-24 text-xs"
        aria-label="Window start"
      />
      <span className="text-xs text-silver/60">to</span>
      <Input
        type="time"
        value={end}
        onChange={(e) => setEnd(e.target.value)}
        className="h-8 w-24 text-xs"
        aria-label="Window end (past-midnight wraps)"
      />
      <Input
        type="number"
        min={0}
        step={1}
        value={count}
        onChange={(e) => setCount(e.target.value)}
        placeholder="Heads"
        className="h-8 w-18 text-xs"
        aria-label="Expected heads in this window"
      />
      <Button size="sm" onClick={() => void save()} loading={busy} disabled={busy}>
        Save
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
        Cancel
      </Button>
    </div>
  );
}

interface Totals {
  scheduledMinutes: number;
  scheduledCost: number;
  scheduledShifts: number;
  scheduledNoRate: number;
  workedMinutes: number;
  workedCost: number;
  workedPunches: number;
  workedNoRate: number;
  approvedMinutes: number;
  approvedCost: number;
  scheduledRevenue: number;
  revenueNoRate: number;
  scheduledHeads: number;
  leadHeads: number;
  associateHeads: number;
  leadCost: number;
  associateCost: number;
  /** Extra-heads cost, priced at each row's own average cost per head. */
  overstaffCost: number;
  overstaffHeads: number;
}
const emptyTotals = (): Totals => ({
  scheduledMinutes: 0,
  scheduledCost: 0,
  scheduledShifts: 0,
  scheduledNoRate: 0,
  workedMinutes: 0,
  workedCost: 0,
  workedPunches: 0,
  workedNoRate: 0,
  approvedMinutes: 0,
  approvedCost: 0,
  scheduledRevenue: 0,
  revenueNoRate: 0,
  scheduledHeads: 0,
  leadHeads: 0,
  associateHeads: 0,
  leadCost: 0,
  associateCost: 0,
  overstaffCost: 0,
  overstaffHeads: 0,
});
/** Cost of the heads above target: extras × the row's avg cost per head. */
/** One line of a day's table: a store, or one of its shift windows. */
interface DayLine {
  key: string;
  r: LaborCostRow;
  w?: NonNullable<LaborCostRow['windows']>[number];
}

const marginClass = (revenue: number, margin: number, child: boolean) =>
  revenue > 0
    ? margin >= 0
      ? child
        ? 'text-success/80'
        : 'text-success'
      : child
        ? 'text-alert/80'
        : 'text-alert'
    : child
      ? 'text-silver/40'
      : 'text-silver/70';

const fmtMargin = (revenue: number, margin: number) =>
  revenue > 0 ? `${margin >= 0 ? '+' : '−'}${money(Math.abs(margin))}` : '—';

const DAY_COLUMNS: GridColumn<DayLine>[] = [
  {
    key: 'client',
    header: 'Client',
    accessor: (l) => (l.w ? null : l.r.clientName),
    sortable: true,
    cardMeta: true,
    className: 'text-white',
    // A shift with no client is a data gap, said as one (it used to read as a client called "No client").
    cell: (l) => (l.w ? '' : l.r.clientName ?? <span className="text-warning">No client set</span>),
  },
  {
    key: 'store',
    header: 'Store',
    accessor: (l) => (l.w ? l.w.label : l.r.locationName),
    sortable: true,
    primary: true,
    className: 'text-silver',
    cell: (l) =>
      l.w ? (
        <span className="text-xs text-silver/80">
          ↳ {l.w.label}
          {l.w.startMinute !== null && l.w.endMinute !== null && (
            <span className="ml-1 text-2xs tabular-nums text-silver/70">
              {minuteToHhmm(l.w.startMinute)}–{minuteToHhmm(l.w.endMinute)}
            </span>
          )}
        </span>
      ) : (
        (l.r.locationName ?? '—')
      ),
  },
  {
    key: 'heads',
    header: 'Heads',
    accessor: (l) => (l.w ? l.w.scheduledHeads : l.r.scheduledHeads),
    csv: (l) => {
      const t = l.w ? l.w.targetHeads : l.r.targetHeads;
      const h = l.w ? l.w.scheduledHeads : l.r.scheduledHeads;
      return t !== null ? `${h} / ${t}` : h;
    },
    sortable: true,
    searchable: false,
    align: 'right',
    className: 'tabular-nums',
    cell: (l) => {
      if (l.w) {
        const over = l.w.targetHeads !== null && l.w.scheduledHeads > l.w.targetHeads;
        return (
          <span
            className={over ? 'font-medium text-alert' : 'text-silver'}
            title={over ? `${l.w.scheduledHeads - l.w.targetHeads!} above this window's target` : undefined}
          >
            {l.w.scheduledHeads}
            {l.w.targetHeads !== null ? ` / ${l.w.targetHeads}` : ''}
          </span>
        );
      }
      const r = l.r;
      const over = r.targetHeads !== null && r.scheduledHeads > r.targetHeads;
      return (
        <>
          <span
            className={over ? 'font-medium text-alert' : 'text-white'}
            title={
              over
                ? `${r.scheduledHeads - r.targetHeads!} above target — ≈${money(overstaffCostOf(r))} extra`
                : r.targetHeads !== null && r.scheduledHeads < r.targetHeads
                  ? `${r.targetHeads - r.scheduledHeads} below target`
                  : undefined
            }
          >
            {r.scheduledHeads}
            {r.targetHeads !== null ? ` / ${r.targetHeads}` : ''}
          </span>
          {(r.leadHeads > 0 || r.associateHeads > 0) && (
            <div
              className="text-2xs text-silver/60"
              title={`${r.leadHeads} lead${r.leadHeads === 1 ? '' : 's'} · ${r.associateHeads} associate${r.associateHeads === 1 ? '' : 's'}`}
            >
              {r.leadHeads} L · {r.associateHeads} A
            </div>
          )}
        </>
      );
    },
  },
  {
    key: 'shifts',
    header: 'Shifts',
    accessor: (l) => (l.w ? l.w.scheduledShifts : l.r.scheduledShifts),
    sortable: true,
    searchable: false,
    align: 'right',
    className: 'tabular-nums text-silver',
    cell: (l) =>
      l.w ? (
        l.w.scheduledShifts
      ) : (
        <>
          {l.r.scheduledShifts}
          {l.r.scheduledNoRate > 0 && (
            <span
              className="ml-1.5 rounded bg-warning/15 px-1.5 py-0.5 text-2xs font-medium text-warning"
              title={`${l.r.scheduledNoRate} shift${l.r.scheduledNoRate === 1 ? '' : 's'} without a pay rate`}
            >
              {l.r.scheduledNoRate} unpriced
            </span>
          )}
        </>
      ),
  },
  {
    key: 'schedCost',
    header: 'Sched. cost',
    accessor: (l) => (l.w ? l.w.scheduledCost : l.r.scheduledCost),
    csv: (l) => (l.w ? l.w.scheduledCost : l.r.scheduledCost).toFixed(2),
    sortable: true,
    searchable: false,
    align: 'right',
    className: 'tabular-nums',
    cell: (l) =>
      l.w ? (
        <span className="text-silver" title={hours(l.w.scheduledMinutes)}>
          {money(l.w.scheduledCost)}
        </span>
      ) : (
        <span
          className="text-white"
          title={`${hours(l.r.scheduledMinutes)} · leads ${money(l.r.leadCost)} / associates ${money(l.r.associateCost)}`}
        >
          {money(l.r.scheduledCost)}
        </span>
      ),
  },
  {
    key: 'billable',
    header: 'Billable',
    accessor: (l) => (l.w ? l.w.scheduledRevenue : l.r.scheduledRevenue),
    csv: (l) => (l.w ? l.w.scheduledRevenue : l.r.scheduledRevenue).toFixed(2),
    sortable: true,
    searchable: false,
    align: 'right',
    className: 'tabular-nums text-silver',
    cell: (l) =>
      l.w ? (
        money(l.w.scheduledRevenue)
      ) : (
        <span title={l.r.revenueNoRate > 0 ? `${l.r.revenueNoRate} shift(s) without a bill rate` : undefined}>
          {money(l.r.scheduledRevenue)}
          {l.r.revenueNoRate > 0 && (
            <span className="ml-1 text-warning" aria-label={`${l.r.revenueNoRate} shifts without a bill rate`}>
              •
            </span>
          )}
        </span>
      ),
  },
  {
    key: 'margin',
    header: 'Margin',
    accessor: (l) => (l.w ? l.w.scheduledRevenue - l.w.scheduledCost : l.r.scheduledRevenue - l.r.scheduledCost),
    csv: (l) => (l.w ? l.w.scheduledRevenue - l.w.scheduledCost : l.r.scheduledRevenue - l.r.scheduledCost).toFixed(2),
    sortable: true,
    searchable: false,
    align: 'right',
    className: 'tabular-nums',
    cell: (l) => {
      const revenue = l.w ? l.w.scheduledRevenue : l.r.scheduledRevenue;
      const margin = revenue - (l.w ? l.w.scheduledCost : l.r.scheduledCost);
      return <span className={marginClass(revenue, margin, Boolean(l.w))}>{fmtMargin(revenue, margin)}</span>;
    },
  },
  {
    key: 'workedCost',
    header: 'Worked cost',
    accessor: (l) => (l.w ? l.w.workedCost : l.r.workedCost),
    csv: (l) => (l.w ? l.w.workedCost : l.r.workedCost).toFixed(2),
    sortable: true,
    searchable: false,
    align: 'right',
    className: 'tabular-nums text-silver',
    cell: (l) =>
      l.w ? (
        <span title={`${hours(l.w.workedMinutes)} · ${l.w.workedPunches} punches`}>{money(l.w.workedCost)}</span>
      ) : (
        <span
          title={`${hours(l.r.workedMinutes)} · ${l.r.workedPunches} punches · ${hours(l.r.approvedMinutes ?? 0)} approved`}
        >
          {money(l.r.workedCost)}
          {l.r.workedMinutes - (l.r.approvedMinutes ?? 0) > 0 && (
            <div className="text-2xs text-warning">
              {hours(l.r.workedMinutes - (l.r.approvedMinutes ?? 0))} unapproved
            </div>
          )}
        </span>
      ),
  },
];

const overstaffCostOf = (r: LaborCostRow): number => {
  if (r.targetHeads === null || r.scheduledHeads <= r.targetHeads) return 0;
  if (r.scheduledHeads === 0) return 0;
  const extras = r.scheduledHeads - r.targetHeads;
  return (r.scheduledCost / r.scheduledHeads) * extras;
};
const addRow = (t: Totals, r: LaborCostRow): void => {
  t.scheduledMinutes += r.scheduledMinutes;
  t.scheduledCost += r.scheduledCost;
  t.scheduledShifts += r.scheduledShifts;
  t.scheduledNoRate += r.scheduledNoRate;
  t.workedMinutes += r.workedMinutes;
  t.workedCost += r.workedCost;
  t.workedPunches += r.workedPunches;
  t.workedNoRate += r.workedNoRate;
  t.approvedMinutes += r.approvedMinutes ?? 0;
  t.approvedCost += r.approvedCost ?? 0;
  t.scheduledRevenue += r.scheduledRevenue;
  t.revenueNoRate += r.revenueNoRate;
  t.scheduledHeads += r.scheduledHeads;
  t.leadHeads += r.leadHeads;
  t.associateHeads += r.associateHeads;
  t.leadCost += r.leadCost;
  t.associateCost += r.associateCost;
  t.overstaffCost += overstaffCostOf(r);
  if (r.targetHeads !== null && r.scheduledHeads > r.targetHeads) {
    t.overstaffHeads += r.scheduledHeads - r.targetHeads;
  }
};


const NO_COST_ROWS: LaborCostRow[] = [];

/** The daily-detail lens: every row, the rows over their floor target, or the rows with a data gap. */
const FOCI = ['all', 'over', 'gaps'] as const;
type Focus = (typeof FOCI)[number];

const PRESET_LABEL: Record<RangePreset, string> = {
  period: 'This period',
  last: 'Last period',
  '30d': '30 days',
};

const urlFlag = {
  parse: (raw: string) => (raw === '1' ? true : raw === '0' ? false : undefined),
  serialize: (v: boolean) => (v ? '1' : '0'),
};

/** A row the report can't price or place: no client (where clients exist) or a missing rate. */
const hasGap = (r: LaborCostRow, hasClients: boolean) =>
  (hasClients && !r.clientId) || r.scheduledNoRate > 0 || r.revenueNoRate > 0 || r.workedNoRate > 0;
const overTarget = (r: LaborCostRow) => r.targetHeads !== null && r.scheduledHeads > r.targetHeads;

export function LaborCostsHome() {
  const term = useTerm();
  const { can } = useAuth();
  // A tenant with no clients has its own sites only: no client lens.
  const hasClients = useTenant().moduleOn('clientPortal');
  const today = localYmd();

  // ---- The range: the current pay period to date unless the URL says otherwise.
  const periodsQuery = useQuery({
    queryKey: ['LaborCostsHome', 'periods'],
    queryFn: () => laborCostPeriods(),
    staleTime: 5 * 60_000,
  });
  // No pay schedule (or the read failed): the report still opens, on 30 days.
  const periods = periodsQuery.data?.periods ?? (periodsQuery.isError ? [] : null);
  const [fromParam] = useUrlState('from', '', urlDay);
  const [toParam] = useUrlState('to', '', urlDay);
  const writeUrl = useUrlWriter();
  const range = periods ? resolveRange({ from: fromParam || null, to: toParam || null }, today, periods) : null;
  const spanDays = range ? daysInRange(range.from, range.to) : 0;
  const tooWide = spanDays > MAX_RANGE_DAYS;
  const setRange = (from: string, to: string) => {
    if (!periods || !range) return;
    const [a, b] = from <= to ? [from, to] : [to, from];
    const def = presetRange(range.defaultPreset, today, periods);
    writeUrl((p) => {
      if (def && def.from === a && def.to === b) {
        p.delete('from');
        p.delete('to');
      } else {
        p.set('from', a);
        p.set('to', b);
      }
    });
  };
  const pickPreset = (preset: RangePreset) => {
    if (!periods) return;
    const r = presetRange(preset, today, periods);
    if (r) setRange(r.from, r.to);
  };
  const presetOptions = (['period', 'last', '30d'] as const)
    .filter((p) => periods !== null && presetRange(p, today, periods) !== null)
    .map((p) => ({ value: p as RangePreset | 'custom', label: PRESET_LABEL[p] }));
  if (range?.preset === 'custom') presetOptions.push({ value: 'custom', label: 'Custom' });

  // The last range's rows stay on screen while a new one loads.
  const costsQuery = useQuery({
    queryKey: ['LaborCostsHome', 'costs', range?.from ?? '', range?.to ?? ''],
    queryFn: () =>
      // Server takes an exclusive upper bound; the range is inclusive.
      laborCosts({
        from: new Date(`${range!.from}T00:00:00`).toISOString(),
        to: new Date(`${addDaysYmd(range!.to, 1)}T00:00:00`).toISOString(),
      }),
    enabled: Boolean(range) && !tooWide,
    placeholderData: keepPreviousData,
  });
  const rawRows: LaborCostRow[] | null = costsQuery.isError ? NO_COST_ROWS : costsQuery.data?.rows ?? null;
  // Two stores with one name ("The Grand Hotel" ×4) were four identical
  // options and four identical rows: name each by its client, and by a
  // short id when the client is the same too.
  const rows = useMemo(() => (rawRows ? disambiguateStores(rawRows) : null), [rawRows]);
  const truncated = costsQuery.data?.truncated ?? false;
  const fallbacks = costsQuery.data?.fallbacks ?? null;
  const error = costsQuery.error
    ? costsQuery.error instanceof ApiError
      ? costsQuery.error.message
      : 'Could not load labor costs.'
    : null;
  const load = async () => {
    await costsQuery.refetch();
  };

  // ---- Lenses, all in the URL so a link sends the same view.
  const [clientFilter] = useUrlParam<string>('client', '');
  const [locationFilter, setLocationFilter] = useUrlParam<string>('store', '');
  const [focus, setFocus] = useUrlParam<Focus>('focus', 'all', FOCI);
  const [showWindows, setShowWindows] = useUrlState('windows', false, urlFlag);
  const [targetsOpen, setTargetsOpen] = useState(false);
  // Follow the global Topbar store scope (one-way — this select is a local
  // lens, so it doesn't write back). Manual picks stand until the next
  // scope change.
  const boardScope = useStoreScope();
  const boardScopeClientId = boardScope.enabled ? boardScope.clientId : null;
  const lastScope = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const first = lastScope.current === undefined;
    if (lastScope.current === boardScopeClientId) return;
    lastScope.current = boardScopeClientId;
    // On arrival only a picked store scope applies (a link's own client
    // stands); after that every scope change does, "all" included.
    if (boardScopeClientId === null || (first && !boardScopeClientId)) return;
    writeUrl((p) => {
      if ((p.get('client') ?? '') === boardScopeClientId) return;
      if (boardScopeClientId) p.set('client', boardScopeClientId);
      else p.delete('client');
      p.delete('store');
    });
  }, [boardScopeClientId, writeUrl]);

  // Filter options come from the loaded rows — no extra fetch, and bounded
  // roles automatically only see their own client.
  const clientOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows ?? []) {
      if (r.clientId) m.set(r.clientId, r.clientName ?? r.clientId);
    }
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [rows]);
  const locationOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows ?? []) {
      if (clientFilter && r.clientId !== clientFilter) continue;
      if (r.locationId) m.set(r.locationId, r.locationName ?? r.locationId);
    }
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [rows, clientFilter]);

  const visible = useMemo(
    () =>
      (rows ?? []).filter(
        (r) =>
          (!clientFilter || r.clientId === clientFilter) &&
          (!locationFilter || r.locationId === locationFilter),
      ),
    [rows, clientFilter, locationFilter],
  );

  const byDay = useMemo(() => {
    const days = new Map<string, Totals>();
    for (const r of visible) {
      let d = days.get(r.date);
      if (!d) {
        d = emptyTotals();
        days.set(r.date, d);
      }
      addRow(d, r);
    }
    return days;
  }, [visible]);

  const grand = useMemo(() => {
    const t = emptyTotals();
    for (const r of visible) addRow(t, r);
    return t;
  }, [visible]);

  // Every day of the range, so the axis is continuous: a day with nothing
  // scheduled is a real $0 on the chart, not a skipped tick.
  const trendData = useMemo(() => {
    if (!range || tooWide) return [];
    const r2 = (v: number) => Math.round(v * 100) / 100;
    return everyDay(range.from, range.to).map((date) => {
      const d = byDay.get(date);
      return {
        date,
        scheduled: r2(d?.scheduledCost ?? 0),
        worked: r2(d?.workedCost ?? 0),
        revenue: r2(d?.scheduledRevenue ?? 0),
      };
    });
  }, [range, tooWide, byDay]);

  // Client breakdown normally; store breakdown once a client is picked
  // (and always for a tenant with no clients).
  const byStore = Boolean(clientFilter) || !hasClients;
  const groupData = useMemo(() => {
    const byKey = new Map<string, { name: string; scheduled: number; worked: number }>();
    for (const r of visible) {
      const key = byStore ? r.locationId ?? 'none' : r.clientId ?? 'none';
      const name = byStore
        ? r.locationName ?? termizeText('No store', term)
        : r.clientName ?? 'No client set';
      const g = byKey.get(key) ?? { name, scheduled: 0, worked: 0 };
      g.scheduled += r.scheduledCost;
      g.worked += r.workedCost;
      byKey.set(key, g);
    }
    const round2 = (v: number) => Math.round(v * 100) / 100;
    const all = [...byKey.values()]
      .map((g) => ({ ...g, scheduled: round2(g.scheduled), worked: round2(g.worked) }))
      .sort((a, b) => b.scheduled - a.scheduled || b.worked - a.worked);
    // Fold the tail past 8 rows into "Other" — never endless bars.
    if (all.length <= 8) return all;
    const tail = all.slice(7);
    return [
      ...all.slice(0, 7),
      {
        name: `Other (${tail.length})`,
        scheduled: round2(tail.reduce((s, g) => s + g.scheduled, 0)),
        worked: round2(tail.reduce((s, g) => s + g.worked, 0)),
      },
    ];
  }, [visible, byStore, term]);

  // ---- Data gaps: shifts the report can't place or price, named and linked.
  const gaps = useMemo(() => {
    let noClientShifts = 0;
    let noClientCost = 0;
    for (const r of visible) {
      if (hasClients && !r.clientId) {
        noClientShifts += r.scheduledShifts;
        noClientCost += r.scheduledCost;
      }
    }
    return {
      noClientShifts,
      noClientCost,
      rows: visible.filter((r) => hasGap(r, hasClients)).length,
    };
  }, [visible, hasClients]);
  const overRows = useMemo(() => visible.filter(overTarget).length, [visible]);
  const anyTarget = visible.some((r) => r.targetHeads !== null);

  const gridRows = useMemo(() => {
    const list =
      focus === 'over' ? visible.filter(overTarget) : focus === 'gaps' ? visible.filter((r) => hasGap(r, hasClients)) : visible;
    // Newest day first; within a day, the costliest store first.
    return [...list]
      .sort((a, b) => b.date.localeCompare(a.date) || b.scheduledCost - a.scheduledCost)
      .map((r) => ({ key: `${r.date}|${r.clientId}|${r.locationId}`, r }));
  }, [visible, focus, hasClients]);
  const detailRef = useRef<HTMLDivElement>(null);
  const showRows = (next: Focus) => {
    setFocus((prev) => (prev === next ? 'all' : next));
    requestAnimationFrame(() => detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  const variance = grand.workedCost - grand.scheduledCost;
  const unapprovedMinutes = grand.workedMinutes - grand.approvedMinutes;
  const margin = grand.scheduledRevenue - grand.scheduledCost;

  const exportCsv = () => {
    if (!range) return;
    downloadCsv(`labor-costs-${range.from}-to-${range.to}.csv`, [
      [
        'Date', 'Client', 'Store', 'Shift window', 'Heads', 'Target heads', 'Overstaff cost',
        'Lead heads', 'Associate heads', 'Lead cost', 'Associate cost',
        'Shifts', 'Scheduled hours', 'Scheduled cost', 'Shifts without rate',
        'Billable value', 'Margin', 'Shifts without bill rate',
        'Punches', 'Worked hours', 'Worked cost', 'Punches without rate',
        'Approved hours', 'Approved cost', 'Unapproved hours',
      ],
      ...visible.flatMap((r) => [
        [
          r.date,
          r.clientName ?? '',
          r.locationName ?? '',
          '',
          r.scheduledHeads,
          r.targetHeads ?? '',
          overstaffCostOf(r).toFixed(2),
          r.leadHeads,
          r.associateHeads,
          r.leadCost.toFixed(2),
          r.associateCost.toFixed(2),
          r.scheduledShifts,
          (r.scheduledMinutes / 60).toFixed(2),
          r.scheduledCost.toFixed(2),
          r.scheduledNoRate,
          r.scheduledRevenue.toFixed(2),
          (r.scheduledRevenue - r.scheduledCost).toFixed(2),
          r.revenueNoRate,
          r.workedPunches,
          (r.workedMinutes / 60).toFixed(2),
          r.workedCost.toFixed(2),
          r.workedNoRate,
          ((r.approvedMinutes ?? 0) / 60).toFixed(2),
          (r.approvedCost ?? 0).toFixed(2),
          ((r.workedMinutes - (r.approvedMinutes ?? 0)) / 60).toFixed(2),
        ],
        ...(r.windows ?? []).map((w) => [
          r.date,
          r.clientName ?? '',
          r.locationName ?? '',
          w.startMinute !== null && w.endMinute !== null
            ? `${w.label} ${minuteToHhmm(w.startMinute)}-${minuteToHhmm(w.endMinute)}`
            : w.label,
          w.scheduledHeads,
          w.targetHeads ?? '',
          '',
          '',
          '',
          '',
          '',
          w.scheduledShifts,
          (w.scheduledMinutes / 60).toFixed(2),
          w.scheduledCost.toFixed(2),
          '',
          w.scheduledRevenue.toFixed(2),
          (w.scheduledRevenue - w.scheduledCost).toFixed(2),
          '',
          w.workedPunches,
          (w.workedMinutes / 60).toFixed(2),
          w.workedCost.toFixed(2),
          '',
          '',
          '',
          '',
        ]),
      ]),
    ]);
  };

  const rangeText = range ? fmtDateOnlyRange(range.from, range.to) : '';
  const rangeWhat =
    range?.preset === 'period' ? 'pay period to date' : range?.preset === 'last' ? 'last pay period' : range ? plural(spanDays, 'day', 'days') : '';
  const anyActivity = grand.scheduledShifts > 0 || grand.workedPunches > 0;

  return (
    // Design system §4.2 (UX upgrade step 6, the sweep): the List template.
    <ListTemplate
      title="Labor costs"
      subtitle={
        hasClients
          ? termizeText('Scheduled vs worked labor spend, per client and store, day by day', term)
          : termizeText('Scheduled vs worked labor spend, per store, day by day', term)
      }
      actions={[
        { label: 'Export CSV', icon: Download, onSelect: exportCsv, disabled: visible.length === 0 },
        { label: 'Floor targets', icon: Target, onSelect: () => setTargetsOpen(true), hint: termizeText('How many people each store should run', term), hidden: !can('manage:scheduling') },
      ]}
      filters={
        <FilterBar
          urlKey={['client', 'store']}
          sheetDescription="Pick exact dates, or narrow the report to one client or store."
          search={
            presetOptions.length > 0 && range ? (
              <SegmentedControl<RangePreset | 'custom'>
                options={presetOptions}
                value={range.preset}
                onChange={(v) => v !== 'custom' && pickPreset(v)}
                ariaLabel="Date range"
              />
            ) : (
              <Skeleton className="h-8 w-64" />
            )
          }
          count={
            range ? (
              <span>
                <span className="text-white">{rangeText}</span> · {rangeWhat}
              </span>
            ) : null
          }
        >
          <label className="flex items-center gap-1.5 text-xs text-silver">
            From
            <Input
              type="date"
              aria-label="From date"
              value={range?.from ?? ''}
              max={range?.to}
              onChange={(e) => range && e.target.value && setRange(e.target.value, range.to < e.target.value ? e.target.value : range.to)}
              className="h-8 w-[9.5rem]"
            />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-silver">
            To
            <Input
              type="date"
              aria-label="To date"
              value={range?.to ?? ''}
              min={range?.from}
              onChange={(e) => range && e.target.value && setRange(range.from > e.target.value ? e.target.value : range.from, e.target.value)}
              className="h-8 w-[9.5rem]"
            />
          </label>
          {hasClients && (
            <Select
              value={clientFilter}
              onChange={(e) =>
                writeUrl((p) => {
                  if (e.target.value) p.set('client', e.target.value);
                  else p.delete('client');
                  p.delete('store');
                })
              }
              size="sm"
              className="w-auto max-w-[16rem]"
              aria-label="Filter by client"
            >
              <option value="">All clients</option>
              {clientOptions.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </Select>
          )}
          <Select
            value={locationFilter}
            onChange={(e) => setLocationFilter(e.target.value)}
            size="sm"
            className="w-auto max-w-[16rem]"
            aria-label={termizeText('Filter by store', term)}
          >
            <option value="">{termizeText('All stores', term)}</option>
            {locationOptions.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </Select>
        </FilterBar>
      }
      drawer={targetsOpen && <TargetsDrawer onClose={() => setTargetsOpen(false)} onChanged={() => void load()} />}
    >
      {tooWide && (
        <ErrorBanner severity="warning">
          That range is {plural(spanDays, 'day', 'days')}. The report covers {MAX_RANGE_DAYS} days at most — shorten it.
        </ErrorBanner>
      )}
      {error && <ErrorBanner>{error}</ErrorBanner>}

      {truncated && (
        <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/[0.07] p-3 text-sm text-silver">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
          The range has more activity than one report covers — totals are a floor. Narrow the date range for exact numbers.
        </div>
      )}

      {rows === null || range === null ? (
        tooWide ? null : <SkeletonRows count={6} />
      ) : (
        <div className="space-y-5">
          {/* Headline numbers. Honest when there's nothing to count: a tile
              with no shifts or no punches says so in words, and only a
              real variance over a real plan wears a colour. */}
          <section aria-labelledby="labor-summary">
            <SectionLabel id="labor-summary">Range summary · {rangeText}</SectionLabel>
            {!anyActivity ? (
              <EmptyState
                icon={DollarSign}
                title="No shifts or punches in this range"
                description={
                  range.preset === 'period'
                    ? 'Nothing has been scheduled or worked yet this pay period. Try last period.'
                    : 'Nothing was scheduled or worked on these dates for the selected filters.'
                }
                action={
                  range.preset === 'period' && presetRange('last', today, periods ?? []) ? (
                    <Button size="sm" variant="outline" onClick={() => pickPreset('last')}>
                      Show last period
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <MetricStrip label="Labor cost in this range">
                <MetricCard
                  icon={CalendarClock}
                  label="Scheduled cost"
                  value={money(grand.scheduledCost)}
                  nothing={grand.scheduledShifts === 0 ? 'No shifts in range' : undefined}
                  hint={`${hours(grand.scheduledMinutes)} · ${plural(grand.scheduledShifts, 'shift', 'shifts')} · ${grand.leadHeads} lead / ${grand.associateHeads} associate head-days`}
                />
                <MetricCard
                  icon={Timer}
                  label="Worked cost"
                  value={money(grand.workedCost)}
                  nothing={grand.workedPunches === 0 ? 'No punches in range' : undefined}
                  deltaText={
                    grand.workedPunches > 0 && grand.scheduledCost > 0
                      ? {
                          text: `${variance >= 0 ? '+' : '−'}${money(Math.abs(variance))} vs scheduled (${Math.round((grand.workedCost / grand.scheduledCost) * 100)}%)`,
                          // Over plan is the alarming direction; under plan is a fact.
                          tone: variance > 0.005 ? 'bad' : 'neutral',
                        }
                      : null
                  }
                  hint={`${hours(grand.workedMinutes)} · ${plural(grand.workedPunches, 'punch', 'punches')} · ${hours(grand.approvedMinutes)} approved`}
                />
                <MetricCard
                  icon={Hourglass}
                  label="Awaiting approval"
                  value={
                    fallbacks?.associateBillRate
                      ? money((unapprovedMinutes / 60) * fallbacks.associateBillRate)
                      : hours(unapprovedMinutes)
                  }
                  nothing={grand.workedPunches === 0 ? 'No punches in range' : undefined}
                  tone={unapprovedMinutes > 0 ? 'warning' : 'good'}
                  href={unapprovedMinutes > 0 && can('manage:time') ? '/time-attendance?tab=queue' : undefined}
                  hint={
                    unapprovedMinutes > 0
                      ? `${hours(unapprovedMinutes)} worked but not approved — can't be billed until approved${fallbacks?.associateBillRate ? ' (est. at the SOW rate)' : ''}`
                      : `All ${hours(grand.workedMinutes)} worked are approved`
                  }
                />
                <MetricCard
                  icon={BadgeDollarSign}
                  label="Billable value"
                  value={money(grand.scheduledRevenue)}
                  nothing={grand.scheduledShifts === 0 ? 'No shifts in range' : undefined}
                  hint={
                    grand.revenueNoRate > 0
                      ? `${plural(grand.revenueNoRate, 'shift', 'shifts')} without a bill rate`
                      : 'Scheduled hours × contract bill rates'
                  }
                />
                <MetricCard
                  icon={Scale}
                  label="Margin"
                  value={`${margin >= 0 ? '+' : '−'}${money(Math.abs(margin))}`}
                  nothing={
                    grand.scheduledShifts === 0
                      ? 'No shifts in range'
                      : grand.scheduledRevenue === 0
                        ? 'No bill rates set — no margin to show'
                        : undefined
                  }
                  tone={margin >= 0 ? 'good' : 'alert'}
                  hint={`${Math.round((margin / (grand.scheduledRevenue || 1)) * 100)}% of billable value`}
                />
                <MetricCard
                  icon={Users}
                  label="Overstaffing cost"
                  value={money(grand.overstaffCost)}
                  nothing={!anyTarget ? 'No floor targets set' : undefined}
                  tone={grand.overstaffCost > 0.005 ? 'alert' : 'neutral'}
                  hint={
                    grand.overstaffHeads > 0
                      ? `${plural(grand.overstaffHeads, 'head-day', 'head-days')} above the floor targets`
                      : 'No days above the floor targets'
                  }
                  onClick={overRows > 0 ? () => showRows('over') : undefined}
                  selected={overRows > 0 ? focus === 'over' : undefined}
                />
              </MetricStrip>
            )}
          </section>

          {gaps.rows > 0 && (
            <div className="flex flex-wrap items-start gap-2 rounded-md border border-warning/40 bg-warning/[0.07] p-3 text-sm text-silver" role="status">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="font-medium text-white">Some of this can&apos;t be priced or placed. </span>
                {[
                  gaps.noClientShifts > 0 &&
                    `${plural(gaps.noClientShifts, 'shift has', 'shifts have')} no client (${money(gaps.noClientCost)} scheduled)`,
                  grand.scheduledNoRate > 0 &&
                    `${plural(grand.scheduledNoRate, 'shift has', 'shifts have')} no pay rate and count as $0`,
                  grand.revenueNoRate > 0 && `${plural(grand.revenueNoRate, 'shift has', 'shifts have')} no bill rate`,
                  grand.workedNoRate > 0 && `${plural(grand.workedNoRate, 'punch has', 'punches have')} no pay rate`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
                .{' '}
                {(grand.scheduledNoRate > 0 || grand.revenueNoRate > 0) && (
                  <>
                    Rates are set in{' '}
                    <Link to={withReturn('/clients', '/labor-costs')} className="text-gold hover:underline">
                      Clients → Rate defaults
                    </Link>
                    .
                  </>
                )}
              </span>
              <Button size="xs" variant="outline" onClick={() => showRows('gaps')} aria-pressed={focus === 'gaps'}>
                {focus === 'gaps' ? 'Show every row' : gaps.rows === 1 ? 'Show this row' : `Show these ${gaps.rows} rows`}
              </Button>
            </div>
          )}

          {/* Right now — one line, then this week's overtime when there is any. */}
          <div className="space-y-3">
            <LiveFloorLine />
            <OtOutlookCard />
          </div>

          {anyActivity && (trendData.length > 1 || groupData.length > 0) && (
            <div className="space-y-3">
              <SectionLabel>Trends &amp; breakdown</SectionLabel>
              {/* A trend needs at least two days. */}
              {trendData.length > 1 && <CostTrendCard data={trendData} />}
              {groupData.length > 0 && (
                <CostByGroupCard title={byStore ? termizeText('Cost by store', term) : 'Cost by client'} data={groupData} />
              )}
              {/* Then the detail inside the split: client → store → position. */}
              <MoneyTreemapCard
                rows={visible}
                start={locationFilter ? 'position' : byStore ? 'store' : 'client'}
                when={range.preset === 'period' ? 'this pay period' : range.preset === 'last' ? 'last pay period' : `in ${rangeText}`}
                hasClients={hasClients}
                term={term}
              />
            </div>
          )}

          {anyActivity && (
            <section ref={detailRef} className="scroll-mt-20" aria-labelledby="labor-detail">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <div id="labor-detail" className="text-2xs font-medium uppercase tracking-[0.18em] text-silver/60">
                  Daily detail
                </div>
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  <SegmentedControl<Focus>
                    ariaLabel="Which rows"
                    value={focus}
                    onChange={setFocus}
                    options={[
                      { value: 'all', label: 'Every row' },
                      ...(overRows > 0 || focus === 'over' ? [{ value: 'over' as const, label: 'Over target', count: overRows }] : []),
                      ...(gaps.rows > 0 || focus === 'gaps' ? [{ value: 'gaps' as const, label: 'Missing client or rate', count: gaps.rows }] : []),
                    ]}
                  />
                  {visible.some((r) => (r.windows ?? []).length > 0) && (
                    <Button
                      size="xs"
                      variant="outline"
                      aria-pressed={showWindows}
                      onClick={() => setShowWindows((v) => !v)}
                      title="Each store's day split by its shift windows"
                    >
                      {showWindows ? 'Hide shift windows' : 'Show shift windows'}
                    </Button>
                  )}
                </div>
              </div>
              <DataGrid<DayLine>
                id="labor-daily"
                caption="Daily labor detail"
                noun={{ one: termizeText('store day', term), many: termizeText('store days', term) }}
                rows={gridRows}
                columns={DAY_COLUMNS}
                rowKey={(l) => l.key}
                // A store's shift windows, judged against each window's own
                // target — folded until asked for, and then only the windows
                // that had anything in them.
                subRows={
                  showWindows
                    ? (l) =>
                        l.w
                          ? undefined
                          : (l.r.windows ?? [])
                              .filter((w) => w.scheduledShifts > 0 || w.workedPunches > 0)
                              .map((w) => ({ key: `${l.key}|${w.label}`, r: l.r, w }))
                    : undefined
                }
                groupBy={{
                  key: (l) => l.r.date,
                  header: (date) => {
                    const d = byDay.get(date);
                    return (
                      <span className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                        <span className="font-medium text-white">{fmtDateOnly(date, { weekday: true, year: 'auto' })}</span>
                        {d && (
                          <span className="text-xs font-normal tabular-nums text-silver">
                            Scheduled {hours(d.scheduledMinutes)} · <span className="text-white">{money(d.scheduledCost)}</span>
                            {' · '}Worked {hours(d.workedMinutes)} · <span className="text-white">{money(d.workedCost)}</span>
                          </span>
                        )}
                      </span>
                    );
                  },
                  collapsible: { defaultOpen: (_k, i) => i < 7 },
                }}
                urlKey="day"
                search={false}
                exportCsv={false}
                activeFilters={focus === 'all' ? 0 : 1}
                onClearFilters={() => setFocus('all')}
                empty={{ icon: DollarSign, title: 'No labor activity on these dates' }}
                footnote={
                  gridRows.length > 0 ? 'The page’s Export CSV carries every column, shift windows included.' : undefined
                }
              />
            </section>
          )}

          <StoreTrendsCard />

          {anyActivity && (
          <div className="rounded-lg border border-navy-secondary/60 bg-navy/40 px-4 py-3">
            <div className="mb-1.5 text-2xs font-medium uppercase tracking-widest text-silver/60">
              How these numbers are calculated
            </div>
            <dl className="grid gap-x-6 gap-y-1.5 text-2xs text-silver/70 sm:grid-cols-2">
              <div>
                <dt className="inline font-medium text-silver">Scheduled cost — </dt>
                <dd className="inline">
                  each shift at its own pay rate, else the {hasClients ? <>client&rsquo;s </> : ''}
                  per-position default
                  {fallbacks?.associatePayRate
                    ? `, else the company standards (${money(fallbacks.associatePayRate)}/hr ${term('workers').toLowerCase()}${fallbacks.leadPayRate ? ` · ${money(fallbacks.leadPayRate)}/hr leads` : ''})`
                    : ''}
                  .
                </dd>
              </div>
              <div>
                <dt className="inline font-medium text-silver">Billable value — </dt>
                <dd className="inline">
                  {hasClients ? <>the shift&rsquo;s bill rate, else the client&rsquo;s default</> : 'each shift’s billing rate, else the position’s default'}
                  {hasClients && fallbacks?.associateBillRate && fallbacks?.leadBillRate
                    ? `, else the SOW rates (${money(fallbacks.associateBillRate)}/hr ${term('workers').toLowerCase()} · ${money(fallbacks.leadBillRate)}/hr leads)`
                    : ''}
                  .
                </dd>
              </div>
              <div>
                <dt className="inline font-medium text-silver">Worked cost — </dt>
                <dd className="inline">
                  each clocked-out punch, net of breaks, at the rate captured at
                  clock-in; approved hours are the billable subset.
                </dd>
              </div>
              <div>
                <dt className="inline font-medium text-silver">Per-shift rates — </dt>
                <dd className="inline">
                  visible on each shift in{' '}
                  <Link to="/scheduling" className="text-gold hover:underline">
                    Scheduling
                  </Link>
                  {hasClients ? <>; defaults live in Clients&nbsp;→&nbsp;Rate defaults.</> : '.'}
                </dd>
              </div>
            </dl>
          </div>
          )}
        </div>
      )}
    </ListTemplate>
  );
}
