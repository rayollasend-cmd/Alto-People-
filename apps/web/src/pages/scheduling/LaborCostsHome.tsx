import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, DollarSign, Download } from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { LaborCostRow } from '@alto-people/shared';
import { DonutChart } from '@/components/ui/DonutChart';
import { laborCosts } from '@/lib/schedulingApi';
import { ApiError } from '@/lib/api';
import { downloadCsv } from '@/lib/csv';
import { fmtDate } from '@/lib/format';
import { PageHeader } from '@/components/ui/PageHeader';
import {
  Button,
  Card,
  CardContent,
  EmptyState,
  ErrorBanner,
  Input,
  Select,
  SkeletonRows,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
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

const todayYmd = (): string => {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
};

const addDaysYmd = (ymd: string, days: number): string => {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(y, m - 1, d + days);
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${dt.getFullYear()}-${mm}-${dd}`;
};

const money = (v: number): string =>
  `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const moneyCompact = (v: number): string =>
  v >= 1000
    ? `$${(v / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })}k`
    : `$${Math.round(v).toLocaleString('en-US')}`;
const hours = (minutes: number): string => `${(minutes / 60).toFixed(1)}h`;

/* ----- Chart tokens -------------------------------------------------------
 * Series colors ride the design-system CSS variables, so they follow the
 * light/dark theme at paint time with no re-render (same idiom as
 * DonutChart). Two categorical series, fixed assignment (never re-ordered):
 * Scheduled = gold, Worked = steel. Palette validated with the dataviz
 * six-check script against both surfaces: light (#B8860B/#2563EB on white)
 * passes all six; dark (#D9B967/#60A5FA on #0B1832) passes chroma, CVD
 * (ΔE 24), normal-vision (ΔE 26) and contrast — the brand tokens sit a
 * step above the generic dark lightness band on purpose (this navy is far
 * darker than a typical dark surface), and the legend + direct labels +
 * table views below carry identity beyond color everywhere.
 */
const SCHED_COLOR = 'rgb(var(--color-gold-fill))';
const WORKED_COLOR = 'rgb(var(--color-steel))';
const GRID_COLOR = 'rgb(var(--color-navy-secondary))';
const TICK_COLOR = 'rgb(var(--color-silver) / 0.75)';
const SURFACE_COLOR = 'rgb(var(--color-navy))';

const SERIES = [
  { key: 'scheduled', name: 'Scheduled', color: SCHED_COLOR },
  { key: 'worked', name: 'Worked', color: WORKED_COLOR },
] as const;

/* Donut slices: three categorical hues (fixed order — gold, steel, teal;
 * validated all-pairs against both surfaces) + the muted de-emphasis gray
 * reserved for the folded "Other" tail. Never more hues — past three named
 * slices the tail folds. */
const SLICE_COLORS = [
  'rgb(var(--color-gold-fill))',
  'rgb(var(--color-steel))',
  'rgb(var(--color-chart-teal))',
];
const OTHER_SLICE_COLOR = 'rgb(var(--color-silver) / 0.45)';

function ChartLegend({ marks }: { marks: 'line' | 'bar' }) {
  return (
    <div className="flex items-center gap-4 text-xs text-silver">
      {SERIES.map((s) => (
        <span key={s.key} className="inline-flex items-center gap-1.5">
          {marks === 'line' ? (
            <span
              aria-hidden="true"
              className="inline-block h-0.5 w-4 rounded-full"
              style={{ background: s.color }}
            />
          ) : (
            <span
              aria-hidden="true"
              className="inline-block h-2.5 w-2.5 rounded-sm"
              style={{ background: s.color }}
            />
          )}
          {s.name}
        </span>
      ))}
    </div>
  );
}

/** One tooltip, every series at the hovered X — values lead, names follow. */
function CostTooltip({
  active,
  payload,
  label,
  labelText,
}: {
  active?: boolean;
  payload?: Array<{ dataKey?: string | number; value?: number | string; color?: string }>;
  label?: string | number;
  labelText?: (label: string) => string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const heading = labelText ? labelText(String(label)) : String(label);
  return (
    <div className="rounded-md border border-navy-secondary bg-navy px-3 py-2 elev-2 text-xs">
      <div className="mb-1 text-silver/80">{heading}</div>
      {payload.map((p) => {
        const s = SERIES.find((x) => x.key === p.dataKey);
        return (
          <div key={String(p.dataKey)} className="flex items-center gap-2 py-0.5">
            <span
              aria-hidden="true"
              className="inline-block h-0.5 w-3.5 rounded-full"
              style={{ background: s?.color ?? p.color }}
            />
            <span className="font-semibold tabular-nums text-white">
              {money(Number(p.value ?? 0))}
            </span>
            <span className="text-silver/80">{s?.name ?? String(p.dataKey)}</span>
          </div>
        );
      })}
    </div>
  );
}

function StatTile({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'success' | 'alert';
}) {
  return (
    <div className="rounded-lg border border-navy-secondary bg-navy/60 px-4 py-3">
      <div className="text-2xs uppercase tracking-widest text-silver/70">{label}</div>
      <div
        className={
          tone === 'success'
            ? 'mt-1 text-2xl font-semibold text-success'
            : tone === 'alert'
              ? 'mt-1 text-2xl font-semibold text-alert'
              : 'mt-1 text-2xl font-semibold text-white'
        }
      >
        {value}
      </div>
      {sub && <div className="mt-0.5 text-xs text-silver/70">{sub}</div>}
    </div>
  );
}

/** Daily trend — two 2px lines, ringed markers, crosshair tooltip. */
function CostTrendCard({
  data,
}: {
  data: Array<{ date: string; scheduled: number; worked: number }>;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm font-medium text-white">Daily labor cost</div>
          <ChartLegend marks="line" />
        </div>
        <div style={{ height: 240 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 4 }}>
              <CartesianGrid stroke={GRID_COLOR} strokeWidth={1} vertical={false} />
              <XAxis
                dataKey="date"
                tickFormatter={(d: string) => d.slice(5).replace('-', '/')}
                tick={{ fill: TICK_COLOR, fontSize: 10 }}
                axisLine={{ stroke: GRID_COLOR }}
                tickLine={false}
              />
              <YAxis
                tickFormatter={(v: number) => moneyCompact(v)}
                tick={{ fill: TICK_COLOR, fontSize: 10 }}
                axisLine={false}
                tickLine={false}
                width={52}
              />
              <ChartTooltip
                cursor={{ stroke: GRID_COLOR, strokeWidth: 1 }}
                content={<CostTooltip labelText={(l) => fmtDate(l)} />}
              />
              {SERIES.map((s) => (
                <Line
                  key={s.key}
                  dataKey={s.key}
                  name={s.name}
                  stroke={s.color}
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  // ≥8px marker with a 2px surface ring, so dots stay
                  // legible where the two lines cross.
                  dot={{ r: 4, fill: s.color, stroke: SURFACE_COLOR, strokeWidth: 2 }}
                  activeDot={{ r: 5, stroke: SURFACE_COLOR, strokeWidth: 2 }}
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
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
  // Thin marks: 12px bars, 2px surface gap inside each pair, air between
  // groups. Height grows with the rows so the axis band always fits.
  const height = Math.max(120, data.length * 44 + 40);
  return (
    <Card>
      <CardContent className="p-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm font-medium text-white">{title}</div>
          <ChartLegend marks="bar" />
        </div>
        <div style={{ height }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              layout="vertical"
              data={data}
              margin={{ top: 0, right: 56, bottom: 0, left: 8 }}
              barGap={2}
              barCategoryGap="28%"
            >
              <CartesianGrid stroke={GRID_COLOR} strokeWidth={1} horizontal={false} />
              <XAxis
                type="number"
                tickFormatter={(v: number) => moneyCompact(v)}
                tick={{ fill: TICK_COLOR, fontSize: 10 }}
                axisLine={{ stroke: GRID_COLOR }}
                tickLine={false}
              />
              <YAxis
                type="category"
                dataKey="name"
                tick={{ fill: TICK_COLOR, fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                width={130}
              />
              <ChartTooltip
                cursor={{ fill: 'rgb(var(--color-navy-secondary) / 0.35)' }}
                content={<CostTooltip />}
              />
              {SERIES.map((s) => (
                <Bar
                  key={s.key}
                  dataKey={s.key}
                  name={s.name}
                  fill={s.color}
                  barSize={12}
                  // Rounded data-end (right, since bars grow rightward),
                  // square at the baseline.
                  radius={[0, 4, 4, 0]}
                  isAnimationActive={false}
                >
                  <LabelList
                    dataKey={s.key}
                    position="right"
                    formatter={(v) => {
                      const n = Number(v);
                      return Number.isFinite(n) && n > 0 ? moneyCompact(n) : '';
                    }}
                    style={{ fill: 'rgb(var(--color-silver))', fontSize: 10 }}
                  />
                </Bar>
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
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
});
const addRow = (t: Totals, r: LaborCostRow): void => {
  t.scheduledMinutes += r.scheduledMinutes;
  t.scheduledCost += r.scheduledCost;
  t.scheduledShifts += r.scheduledShifts;
  t.scheduledNoRate += r.scheduledNoRate;
  t.workedMinutes += r.workedMinutes;
  t.workedCost += r.workedCost;
  t.workedPunches += r.workedPunches;
  t.workedNoRate += r.workedNoRate;
};

export function LaborCostsHome() {
  const [from, setFrom] = useState(todayYmd);
  const [toInclusive, setToInclusive] = useState(todayYmd);
  const [rows, setRows] = useState<LaborCostRow[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clientFilter, setClientFilter] = useState('');
  const [locationFilter, setLocationFilter] = useState('');

  const load = useCallback(async () => {
    if (!from || !toInclusive || toInclusive < from) return;
    setRows(null);
    setError(null);
    try {
      // Server takes an exclusive upper bound; the picker is inclusive.
      const res = await laborCosts({
        from: new Date(`${from}T00:00:00`).toISOString(),
        to: new Date(`${addDaysYmd(toInclusive, 1)}T00:00:00`).toISOString(),
      });
      setRows(res.rows);
      setTruncated(res.truncated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load labor costs.');
      setRows([]);
    }
  }, [from, toInclusive]);

  useEffect(() => {
    void load();
  }, [load]);

  const preset = (days: number) => {
    const today = todayYmd();
    setFrom(days === 0 ? today : addDaysYmd(today, -days + 1));
    setToInclusive(today);
  };

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
    const days = new Map<string, { rows: LaborCostRow[]; totals: Totals }>();
    for (const r of visible) {
      let d = days.get(r.date);
      if (!d) {
        d = { rows: [], totals: emptyTotals() };
        days.set(r.date, d);
      }
      d.rows.push(r);
      addRow(d.totals, r);
    }
    return [...days.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [visible]);

  const grand = useMemo(() => {
    const t = emptyTotals();
    for (const r of visible) addRow(t, r);
    return t;
  }, [visible]);

  const trendData = useMemo(
    () =>
      byDay.map(([date, d]) => ({
        date,
        scheduled: Math.round(d.totals.scheduledCost * 100) / 100,
        worked: Math.round(d.totals.workedCost * 100) / 100,
      })),
    [byDay],
  );

  // Client breakdown normally; store breakdown once a client is picked.
  const groupDataAll = useMemo(() => {
    const byKey = new Map<string, { name: string; scheduled: number; worked: number }>();
    for (const r of visible) {
      const key = clientFilter ? r.locationId ?? 'none' : r.clientId ?? 'none';
      const name = clientFilter
        ? r.locationName ?? 'No store'
        : r.clientName ?? 'No client';
      const g = byKey.get(key) ?? { name, scheduled: 0, worked: 0 };
      g.scheduled += r.scheduledCost;
      g.worked += r.workedCost;
      byKey.set(key, g);
    }
    const round2 = (v: number) => Math.round(v * 100) / 100;
    return [...byKey.values()]
      .map((g) => ({ ...g, scheduled: round2(g.scheduled), worked: round2(g.worked) }))
      .sort((a, b) => b.scheduled - a.scheduled || b.worked - a.worked);
  }, [visible, clientFilter]);

  // Bars: fold the tail past 8 rows into "Other" — never endless bars.
  const groupData = useMemo(() => {
    const round2 = (v: number) => Math.round(v * 100) / 100;
    if (groupDataAll.length <= 8) return groupDataAll;
    const head = groupDataAll.slice(0, 7);
    const tail = groupDataAll.slice(7);
    return [
      ...head,
      {
        name: `Other (${tail.length})`,
        scheduled: round2(tail.reduce((s, g) => s + g.scheduled, 0)),
        worked: round2(tail.reduce((s, g) => s + g.worked, 0)),
      },
    ];
  }, [groupDataAll]);

  const variance = grand.workedCost - grand.scheduledCost;

  // Part-to-whole: where the scheduled spend goes. Top 3 slices in the
  // fixed hue order; everything past them folds into a muted "Other".
  const shareData = useMemo(() => {
    const positive = groupDataAll.filter((g) => g.scheduled > 0);
    if (positive.length < 2) return [];
    const head = positive.slice(0, 3).map((g, i) => ({
      name: g.name,
      value: g.scheduled,
      color: SLICE_COLORS[i],
    }));
    const tail = positive.slice(3);
    if (tail.length > 0) {
      head.push({
        name: tail.length === 1 ? tail[0].name : `Other (${tail.length})`,
        value: Math.round(tail.reduce((s, g) => s + g.scheduled, 0) * 100) / 100,
        color: OTHER_SLICE_COLOR,
      });
    }
    return head;
  }, [groupDataAll]);

  const exportCsv = () => {
    downloadCsv(`labor-costs-${from}-to-${toInclusive}.csv`, [
      [
        'Date', 'Client', 'Store', 'Shifts', 'Scheduled hours', 'Scheduled cost',
        'Shifts without rate', 'Punches', 'Worked hours', 'Worked cost',
        'Punches without rate',
      ],
      ...visible.map((r) => [
        r.date,
        r.clientName ?? '',
        r.locationName ?? '',
        r.scheduledShifts,
        (r.scheduledMinutes / 60).toFixed(2),
        r.scheduledCost.toFixed(2),
        r.scheduledNoRate,
        r.workedPunches,
        (r.workedMinutes / 60).toFixed(2),
        r.workedCost.toFixed(2),
        r.workedNoRate,
      ]),
    ]);
  };

  const noRateTotal = grand.scheduledNoRate + grand.workedNoRate;

  return (
    <div>
      <PageHeader
        title="Labor costs"
        subtitle="Scheduled vs worked labor spend, per client and store, day by day"
      />

      <div className="mb-3 flex flex-wrap items-end gap-2">
        <div>
          <label className="block text-2xs uppercase tracking-widest text-silver/80 mb-1">
            From
          </label>
          <Input
            type="date"
            value={from}
            max={toInclusive}
            onChange={(e) => setFrom(e.target.value)}
            className="h-9 w-40"
          />
        </div>
        <div>
          <label className="block text-2xs uppercase tracking-widest text-silver/80 mb-1">
            To
          </label>
          <Input
            type="date"
            value={toInclusive}
            min={from}
            onChange={(e) => setToInclusive(e.target.value)}
            className="h-9 w-40"
          />
        </div>
        <div className="flex gap-1.5">
          <Button size="sm" variant="outline" onClick={() => preset(0)}>
            Today
          </Button>
          <Button size="sm" variant="outline" onClick={() => preset(7)}>
            Last 7 days
          </Button>
          <Button size="sm" variant="outline" onClick={() => preset(30)}>
            Last 30 days
          </Button>
        </div>
        <Select
          value={clientFilter}
          onChange={(e) => {
            setClientFilter(e.target.value);
            setLocationFilter('');
          }}
          size="sm"
          className="w-auto"
          aria-label="Filter by client"
        >
          <option value="">All clients</option>
          {clientOptions.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </Select>
        <Select
          value={locationFilter}
          onChange={(e) => setLocationFilter(e.target.value)}
          size="sm"
          className="w-auto"
          aria-label="Filter by store"
        >
          <option value="">All stores</option>
          {locationOptions.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </Select>
        <Button
          size="sm"
          variant="secondary"
          onClick={exportCsv}
          disabled={visible.length === 0}
          className="ml-auto"
        >
          <Download className="h-4 w-4" />
          Export CSV
        </Button>
      </div>

      {error && <ErrorBanner className="mb-3">{error}</ErrorBanner>}

      {truncated && (
        <div className="mb-3 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/[0.07] p-3 text-sm text-silver">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          The range has more activity than one report covers — totals are a
          floor. Narrow the date range for exact numbers.
        </div>
      )}

      {noRateTotal > 0 && (
        <div className="mb-3 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/[0.07] p-3 text-sm text-silver">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <span>
            {grand.scheduledNoRate > 0 && (
              <>
                {grand.scheduledNoRate} shift{grand.scheduledNoRate === 1 ? '' : 's'}{' '}
                in range {grand.scheduledNoRate === 1 ? 'has' : 'have'} no pay rate
                and contribute $0 — set per-position defaults in{' '}
                <Link to="/clients" className="text-gold hover:underline">
                  Clients → Rate defaults
                </Link>
                .{' '}
              </>
            )}
            {grand.workedNoRate > 0 && (
              <>
                {grand.workedNoRate} punch{grand.workedNoRate === 1 ? '' : 'es'} had
                no snapshotted rate.
              </>
            )}
          </span>
        </div>
      )}

      {rows === null ? (
        <SkeletonRows count={6} />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={DollarSign}
          title="No labor activity in this range"
          description="No shifts or punches match the selected dates and filters."
        />
      ) : (
        <div className="space-y-5">
          {/* Headline numbers — the KPI row every reader scans first. */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile
              label="Scheduled cost"
              value={money(grand.scheduledCost)}
              sub={`${hours(grand.scheduledMinutes)} · ${grand.scheduledShifts} shift${grand.scheduledShifts === 1 ? '' : 's'}`}
            />
            <StatTile
              label="Worked cost"
              value={money(grand.workedCost)}
              sub={`${hours(grand.workedMinutes)} · ${grand.workedPunches} punch${grand.workedPunches === 1 ? '' : 'es'}`}
            />
            <StatTile
              label="Worked vs scheduled"
              value={`${variance >= 0 ? '+' : '−'}${money(Math.abs(variance))}`}
              sub={
                grand.scheduledCost > 0
                  ? `${((grand.workedCost / grand.scheduledCost) * 100).toFixed(0)}% of scheduled`
                  : 'no scheduled cost in range'
              }
              // Over-plan spend is the alarming direction.
              tone={variance > 0.005 ? 'alert' : variance < -0.005 ? 'success' : undefined}
            />
            <StatTile
              label="Average per day"
              value={money(byDay.length ? grand.scheduledCost / byDay.length : 0)}
              sub={`${byDay.length} day${byDay.length === 1 ? '' : 's'} with activity`}
            />
          </div>

          {/* Trend needs at least two days to be a trend. */}
          {trendData.length > 1 && <CostTrendCard data={trendData} />}
          <div className="grid gap-5 xl:grid-cols-2">
            {groupData.length > 0 && (
              <CostByGroupCard
                title={clientFilter ? 'Cost by store' : 'Cost by client'}
                data={groupData}
              />
            )}
            {/* Part-to-whole share — only meaningful with 2+ groups. */}
            {shareData.length >= 2 && (
              <Card>
                <CardContent className="p-4">
                  <div className="mb-2 text-sm font-medium text-white">
                    {clientFilter
                      ? 'Share of scheduled cost by store'
                      : 'Share of scheduled cost by client'}
                  </div>
                  <DonutChart
                    data={shareData}
                    size={200}
                    centerLabel={moneyCompact(grand.scheduledCost)}
                    centerSublabel="scheduled"
                    valueFormatter={moneyCompact}
                  />
                </CardContent>
              </Card>
            )}
          </div>

          {byDay.map(([date, day]) => (
            <Card key={date} className="overflow-hidden">
              <CardContent className="p-0">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-navy-secondary bg-navy-secondary/30 px-4 py-2.5">
                  <div className="text-sm font-medium text-white">{fmtDate(date)}</div>
                  <div className="text-xs text-silver tabular-nums">
                    Scheduled {hours(day.totals.scheduledMinutes)} ·{' '}
                    <span className="text-white">{money(day.totals.scheduledCost)}</span>
                    {'  ·  '}Worked {hours(day.totals.workedMinutes)} ·{' '}
                    <span className="text-white">{money(day.totals.workedCost)}</span>
                  </div>
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Client</TableHead>
                      <TableHead>Store</TableHead>
                      <TableHead className="text-right">Shifts</TableHead>
                      <TableHead className="text-right hidden sm:table-cell">
                        Sched. hours
                      </TableHead>
                      <TableHead className="text-right">Sched. cost</TableHead>
                      <TableHead className="text-right hidden md:table-cell">
                        Punches
                      </TableHead>
                      <TableHead className="text-right hidden sm:table-cell">
                        Worked hours
                      </TableHead>
                      <TableHead className="text-right">Worked cost</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {day.rows.map((r) => (
                      <TableRow key={`${r.date}|${r.clientId}|${r.locationId}`}>
                        <TableCell className="text-white">
                          {r.clientName ?? '—'}
                        </TableCell>
                        <TableCell className="text-silver">
                          {r.locationName ?? '—'}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-silver">
                          {r.scheduledShifts}
                          {r.scheduledNoRate > 0 && (
                            <span
                              className="ml-1 text-warning"
                              title={`${r.scheduledNoRate} without a pay rate`}
                            >
                              ({r.scheduledNoRate}!)
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-silver hidden sm:table-cell">
                          {hours(r.scheduledMinutes)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-white">
                          {money(r.scheduledCost)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-silver hidden md:table-cell">
                          {r.workedPunches}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-silver hidden sm:table-cell">
                          {hours(r.workedMinutes)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-white">
                          {money(r.workedCost)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          ))}

          <p className="text-2xs text-silver/60">
            Scheduled cost prices each shift at its own rate, else the client's
            per-position default. Worked cost prices each clocked-out punch (net
            of breaks) at the rate captured at clock-in. Per-shift rates are
            visible on each shift in{' '}
            <Link to="/scheduling" className="text-gold hover:underline">
              Scheduling
            </Link>
            .
          </p>
        </div>
      )}
    </div>
  );
}
