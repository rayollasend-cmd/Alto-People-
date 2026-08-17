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
import type {
  FloorNowResponse,
  LaborCostRow,
  StaffingTargetLocation,
} from '@alto-people/shared';
import { DonutChart } from '@/components/ui/DonutChart';
import {
  floorNow,
  laborCosts,
  listStaffingTargets,
  setStaffingTarget,
} from '@/lib/schedulingApi';
import { toast } from 'sonner';
import {
  Drawer,
  DrawerBody,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui';
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

// The trend adds the revenue side. Three hues max — the same validated
// gold/steel/teal trio the donut uses, in the same fixed order.
const LINE_SERIES = [
  ...SERIES,
  { key: 'revenue', name: 'Billable', color: 'rgb(var(--color-chart-teal))' },
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

function ChartLegend({
  marks,
  series = SERIES,
}: {
  marks: 'line' | 'bar';
  series?: ReadonlyArray<{ key: string; name: string; color: string }>;
}) {
  return (
    <div className="flex items-center gap-4 text-xs text-silver">
      {series.map((s) => (
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
        const s = LINE_SERIES.find((x) => x.key === p.dataKey);
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

/** Daily trend — three 2px lines, ringed markers, crosshair tooltip. */
function CostTrendCard({
  data,
}: {
  data: Array<{ date: string; scheduled: number; worked: number; revenue: number }>;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm font-medium text-white">
            Daily labor cost vs billable value
          </div>
          <ChartLegend marks="line" series={LINE_SERIES} />
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
              {LINE_SERIES.map((s) => (
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

const minuteToHhmm = (m: number): string =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const hhmmToMinute = (s: string): number | null => {
  const [h, m] = s.split(':').map(Number);
  if (!Number.isInteger(h) || !Number.isInteger(m)) return null;
  return h * 60 + m;
};

/**
 * Live floor board — clocked-in RIGHT NOW vs the expected headcount (the
 * shift window covering the store's local time, else the total floor
 * target). Polls every 60s while the page is open.
 */
function FloorNowCard() {
  const [data, setData] = useState<FloorNowResponse | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await floorNow();
        if (!cancelled) {
          setData(r);
          setFailed(false);
        }
      } catch {
        if (!cancelled) setFailed(true);
      }
    };
    void tick();
    const t = setInterval(() => void tick(), 60_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  if (failed || data === null || data.rows.length === 0) return null;

  // Per-client rollup — the "live labor cost for a particular client"
  // number: loaded burn rate vs billing rate, and the margin between them.
  const clients = new Map<
    string,
    { name: string; clockedIn: number; loadedPerHour: number; billedPerHour: number; loadedSoFar: number; billedSoFar: number; otHeads: number }
  >();
  for (const r of data.rows) {
    const c = clients.get(r.clientId) ?? {
      name: r.clientName,
      clockedIn: 0,
      loadedPerHour: 0,
      billedPerHour: 0,
      loadedSoFar: 0,
      billedSoFar: 0,
      otHeads: 0,
    };
    c.clockedIn += r.clockedIn;
    c.loadedPerHour += r.loadedPerHour ?? 0;
    c.billedPerHour += r.billedPerHour ?? 0;
    c.loadedSoFar += r.loadedSoFar ?? 0;
    c.billedSoFar += r.billedSoFar ?? 0;
    c.otHeads += r.otHeads ?? 0;
    clients.set(r.clientId, c);
  }

  return (
    <Card>
      <CardContent className="p-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm font-medium text-white">On the floor right now</div>
          <div className="text-2xs text-silver/60">
            clocked in vs expected · live loaded cost
            {data.burden ? ` (wages + ${data.burden.percent}% burden${data.burden.overheadPerHour > 0 ? ` + ${money(data.burden.overheadPerHour)}/hr overhead` : ''})` : ''}
            {' '}vs billed · OT past 40h/wk at 1.5× · refreshes every minute
          </div>
        </div>

        {/* Client rollups first — the per-client live margin. */}
        <div className="mb-3 space-y-1">
          {[...clients.values()]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((c) => {
              const marginPerHour = c.billedPerHour - c.loadedPerHour;
              return (
                <div
                  key={c.name}
                  className="flex flex-wrap items-center gap-x-3 gap-y-0.5 rounded-md bg-navy-secondary/30 px-3 py-1.5 text-xs"
                >
                  <span className="font-medium text-white">{c.name}</span>
                  <span className="tabular-nums text-silver">
                    {c.clockedIn} in
                    {c.otHeads > 0 && (
                      <span className="text-warning"> · {c.otHeads} in OT</span>
                    )}
                  </span>
                  <span className="tabular-nums text-silver">
                    burning {money(c.loadedPerHour)}/hr → billing {money(c.billedPerHour)}/hr
                  </span>
                  <span
                    className={`tabular-nums font-medium ${marginPerHour >= 0 ? 'text-success' : 'text-alert'}`}
                  >
                    {marginPerHour >= 0 ? '+' : '−'}
                    {money(Math.abs(marginPerHour))}/hr
                  </span>
                  <span className="tabular-nums text-silver/70">
                    shift so far: {money(c.loadedSoFar)} cost · {money(c.billedSoFar)} billed
                  </span>
                </div>
              );
            })}
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {data.rows.map((r) => {
            const over = r.expected !== null && r.clockedIn > r.expected;
            const under = r.expected !== null && r.clockedIn < r.expected;
            const margin = (r.billedPerHour ?? 0) - (r.loadedPerHour ?? 0);
            return (
              <div
                key={r.locationId}
                className={`rounded-md border px-3 py-2 ${
                  over
                    ? 'border-alert/50 bg-alert/[0.07]'
                    : under
                      ? 'border-warning/50 bg-warning/[0.07]'
                      : 'border-navy-secondary bg-navy/60'
                }`}
                title={
                  (r.windowLabel
                    ? `Expected from the "${r.windowLabel}" shift window. `
                    : r.totalTarget !== null
                      ? 'Expected from the total floor target. '
                      : 'No target set for this store. ') +
                  `Shift so far: ${money(r.loadedSoFar ?? 0)} loaded cost · ${money(r.billedSoFar ?? 0)} billed.`
                }
              >
                <div className="truncate text-xs text-silver/80">{r.locationName}</div>
                <div className="mt-0.5 text-lg font-semibold tabular-nums">
                  <span className={over ? 'text-alert' : under ? 'text-warning' : 'text-white'}>
                    {r.clockedIn}
                  </span>
                  <span className="text-silver/60">
                    {' '}/ {r.expected !== null ? r.expected : '—'}
                  </span>
                  {(r.otHeads ?? 0) > 0 && (
                    <span className="ml-1 align-middle text-2xs text-warning">
                      {r.otHeads} OT
                    </span>
                  )}
                </div>
                {r.clockedIn > 0 && (
                  <div className="tabular-nums text-2xs text-silver">
                    {money(r.loadedPerHour ?? 0)}/hr →{' '}
                    {money(r.billedPerHour ?? 0)}/hr{' '}
                    <span className={margin >= 0 ? 'text-success' : 'text-alert'}>
                      ({margin >= 0 ? '+' : '−'}
                      {money(Math.abs(margin))})
                    </span>
                  </div>
                )}
                <div className="truncate text-2xs text-silver/60">
                  {r.windowLabel ?? (r.expected !== null ? 'floor total' : 'no target')}
                  {' · '}
                  {r.clientName}
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
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
  const [locations, setLocations] = useState<StaffingTargetLocation[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadTargets = useCallback(async () => {
    try {
      setError(null);
      const r = await listStaffingTargets();
      setLocations(r.locations);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load targets.');
      setLocations([]);
    }
  }, []);

  useEffect(() => {
    void loadTargets();
  }, [loadTargets]);

  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} width="max-w-xl">
      <DrawerHeader>
        <DrawerTitle>Floor targets</DrawerTitle>
      </DrawerHeader>
      <DrawerBody>
        <p className="mb-3 text-xs text-silver">
          The number of associates each store is expected to run. Saving takes
          effect from the chosen date forward — history is kept, so past days
          stay measured against the target that applied then.
        </p>
        {error && <ErrorBanner className="mb-3">{error}</ErrorBanner>}
        {locations === null ? (
          <SkeletonRows count={4} />
        ) : locations.length === 0 ? (
          <p className="text-sm text-silver">No active stores in your scope.</p>
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
  const [from, setFrom] = useState(todayYmd());
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
            <span className="text-silver/50">since {w.effectiveFrom}</span>
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

export function LaborCostsHome() {
  const [from, setFrom] = useState(todayYmd);
  const [toInclusive, setToInclusive] = useState(todayYmd);
  const [rows, setRows] = useState<LaborCostRow[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [fallbacks, setFallbacks] = useState<{
    associatePayRate: number | null;
    leadPayRate?: number | null;
    associateBillRate: number | null;
    leadBillRate: number | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clientFilter, setClientFilter] = useState('');
  const [locationFilter, setLocationFilter] = useState('');
  const [targetsOpen, setTargetsOpen] = useState(false);

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
      setFallbacks(res.fallbacks ?? null);
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
        revenue: Math.round(d.totals.scheduledRevenue * 100) / 100,
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
        'Date', 'Client', 'Store', 'Heads', 'Target heads', 'Overstaff cost',
        'Lead heads', 'Associate heads', 'Lead cost', 'Associate cost',
        'Shifts', 'Scheduled hours', 'Scheduled cost', 'Shifts without rate',
        'Billable value', 'Margin', 'Shifts without bill rate',
        'Punches', 'Worked hours', 'Worked cost', 'Punches without rate',
      ],
      ...visible.map((r) => [
        r.date,
        r.clientName ?? '',
        r.locationName ?? '',
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

      {/* Live board — deliberately ABOVE the filter row: it is "right now",
          not scoped by the date range below. */}
      <div className="mb-4">
        <FloorNowCard />
      </div>

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
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="outline" onClick={() => setTargetsOpen(true)}>
            Floor targets
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={exportCsv}
            disabled={visible.length === 0}
          >
            <Download className="h-4 w-4" />
            Export CSV
          </Button>
        </div>
      </div>

      {targetsOpen && (
        <TargetsDrawer
          onClose={() => setTargetsOpen(false)}
          onChanged={() => void load()}
        />
      )}

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
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
            <StatTile
              label="Scheduled cost"
              value={money(grand.scheduledCost)}
              sub={`${hours(grand.scheduledMinutes)} · ${grand.scheduledShifts} shift${grand.scheduledShifts === 1 ? '' : 's'} · ${grand.leadHeads} lead / ${grand.associateHeads} assoc. head-days`}
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
              label="Billable value"
              value={money(grand.scheduledRevenue)}
              sub={
                grand.revenueNoRate > 0
                  ? `${grand.revenueNoRate} shift${grand.revenueNoRate === 1 ? '' : 's'} without a bill rate`
                  : 'scheduled hours × bill rate'
              }
            />
            <StatTile
              label="Margin (billable − cost)"
              value={`${grand.scheduledRevenue - grand.scheduledCost >= 0 ? '+' : '−'}${money(Math.abs(grand.scheduledRevenue - grand.scheduledCost))}`}
              sub={
                grand.scheduledRevenue > 0
                  ? `${(((grand.scheduledRevenue - grand.scheduledCost) / grand.scheduledRevenue) * 100).toFixed(0)}% of billable`
                  : 'set bill rates to see margin'
              }
              tone={
                grand.scheduledRevenue > 0
                  ? grand.scheduledRevenue - grand.scheduledCost >= 0
                    ? 'success'
                    : 'alert'
                  : undefined
              }
            />
            <StatTile
              label="Overstaffing cost"
              value={money(grand.overstaffCost)}
              sub={
                grand.overstaffHeads > 0
                  ? `${grand.overstaffHeads} head-day${grand.overstaffHeads === 1 ? '' : 's'} above target`
                  : 'no days above the floor targets'
              }
              tone={grand.overstaffCost > 0.005 ? 'alert' : undefined}
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
                      <TableHead className="text-right">Heads</TableHead>
                      <TableHead className="text-right hidden sm:table-cell">
                        Shifts
                      </TableHead>
                      <TableHead className="text-right">Sched. cost</TableHead>
                      <TableHead className="text-right hidden md:table-cell">
                        Billable
                      </TableHead>
                      <TableHead className="text-right hidden md:table-cell">
                        Margin
                      </TableHead>
                      <TableHead className="text-right hidden sm:table-cell">
                        Worked cost
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {day.rows.map((r) => {
                      const over =
                        r.targetHeads !== null && r.scheduledHeads > r.targetHeads;
                      const overCost = overstaffCostOf(r);
                      const rowMargin = r.scheduledRevenue - r.scheduledCost;
                      return (
                        <TableRow key={`${r.date}|${r.clientId}|${r.locationId}`}>
                          <TableCell className="text-white">
                            {r.clientName ?? '—'}
                          </TableCell>
                          <TableCell className="text-silver">
                            {r.locationName ?? '—'}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            <span
                              className={over ? 'text-alert font-medium' : 'text-white'}
                              title={
                                over
                                  ? `${r.scheduledHeads - r.targetHeads!} above target — ≈${money(overCost)} extra`
                                  : r.targetHeads !== null &&
                                      r.scheduledHeads < r.targetHeads
                                    ? `${r.targetHeads - r.scheduledHeads} below target`
                                    : undefined
                              }
                            >
                              {r.scheduledHeads}
                              {r.targetHeads !== null ? ` / ${r.targetHeads}` : ''}
                            </span>
                            {(r.leadHeads > 0 || r.associateHeads > 0) && (
                              <div className="text-2xs text-silver/60">
                                {r.leadHeads}L + {r.associateHeads}A
                              </div>
                            )}
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-silver hidden sm:table-cell">
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
                          <TableCell
                            className="text-right tabular-nums text-white"
                            title={`${hours(r.scheduledMinutes)} · leads ${money(r.leadCost)} / associates ${money(r.associateCost)}`}
                          >
                            {money(r.scheduledCost)}
                          </TableCell>
                          <TableCell
                            className="text-right tabular-nums text-silver hidden md:table-cell"
                            title={
                              r.revenueNoRate > 0
                                ? `${r.revenueNoRate} shift(s) without a bill rate`
                                : undefined
                            }
                          >
                            {money(r.scheduledRevenue)}
                            {r.revenueNoRate > 0 && (
                              <span className="ml-1 text-warning">!</span>
                            )}
                          </TableCell>
                          <TableCell
                            className={`text-right tabular-nums hidden md:table-cell ${
                              r.scheduledRevenue > 0
                                ? rowMargin >= 0
                                  ? 'text-success'
                                  : 'text-alert'
                                : 'text-silver/50'
                            }`}
                          >
                            {r.scheduledRevenue > 0
                              ? `${rowMargin >= 0 ? '+' : '−'}${money(Math.abs(rowMargin))}`
                              : '—'}
                          </TableCell>
                          <TableCell
                            className="text-right tabular-nums text-silver hidden sm:table-cell"
                            title={`${hours(r.workedMinutes)} · ${r.workedPunches} punches`}
                          >
                            {money(r.workedCost)}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          ))}

          <p className="text-2xs text-silver/60">
            Scheduled cost prices each shift at its own rate, else the client's
            per-position default
            {fallbacks?.associatePayRate
              ? `, else the standard rates (${money(fallbacks.associatePayRate)}/hr associates${fallbacks.leadPayRate ? ` · ${money(fallbacks.leadPayRate)}/hr leads` : ''})`
              : ''}
            . Billable value uses the shift's bill rate, else the client's
            default
            {fallbacks?.associateBillRate && fallbacks?.leadBillRate
              ? `, else the SOW rates (${money(fallbacks.associateBillRate)}/hr associates · ${money(fallbacks.leadBillRate)}/hr leads)`
              : ''}
            . Worked cost prices each clocked-out punch (net of breaks) at the
            rate captured at clock-in. Per-shift rates are visible on each
            shift in{' '}
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
