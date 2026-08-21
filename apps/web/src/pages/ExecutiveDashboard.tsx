import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ArrowDownRight, ArrowUpRight, Download, TrendingUp } from 'lucide-react';
import type { FloorNowResponse, OtOutlookResponse } from '@alto-people/shared';
import { toast } from 'sonner';
import { ApiError, apiFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate, fmtMoney } from '@/lib/format';
import { floorNow, otOutlook } from '@/lib/schedulingApi';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { LiveNow } from '@/components/ui/LiveNow';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * The Executive/Chairman command center — the numbers, their direction,
 * and the people behind them. Hero margin figure with week-over-week
 * delta, eight-week billed/margin and hours/OT infographics, live floor
 * bars, workforce composition donut, the month's new faces, OT exposure,
 * attendance, placements — and the board pack one click away.
 * Everything read-only; every tile deep-links to its full surface.
 */

interface ExecWeek {
  start: string;
  end: string;
  workedHours: number;
  otHours: number;
  headsWorked: number;
  estBilled: number;
  estLaborCost: number;
  estMargin: number;
}
interface ExecSummary {
  generatedAt: string;
  workforce: {
    active: number;
    deactivated: number;
    hires30d: number;
    separations30d: number;
    onboardingInFlight: number;
  };
  lastWeek: ExecWeek;
  thisWeek: ExecWeek;
  trend: ExecWeek[];
  attendance30d: Array<{ kind: string; count: number }>;
  clients: Array<{ clientId: string; clientName: string; activeAssociates: number }>;
  newHires30d: Array<{
    id: string;
    name: string;
    photoUrl: string | null;
    hireDate: string | null;
  }>;
}

const ATTENDANCE_LABEL: Record<string, string> = {
  LATE: 'Late arrivals',
  EARLY_OUT: 'Left early',
  CALL_OUT: 'Call-outs',
  NO_CALL_NO_SHOW: 'No-call no-shows',
};

const GOLD = 'rgb(var(--color-gold))';
const SILVER = 'rgb(var(--color-silver))';
const GRID = 'rgb(var(--color-silver) / 0.12)';
const TOOLTIP_STYLE = {
  background: 'rgb(var(--color-navy))',
  border: '1px solid rgb(var(--color-navy-secondary))',
  borderRadius: 6,
  fontSize: 12,
} as const;

/** WoW delta chip — green up / red down, with margin semantics. */
function Delta({ now, prev, money }: { now: number; prev: number; money?: boolean }) {
  if (!Number.isFinite(prev) || prev === 0) return null;
  const pct = ((now - prev) / Math.abs(prev)) * 100;
  if (Math.abs(pct) < 0.05) return null;
  const up = pct > 0;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={`inline-flex items-center gap-0.5 text-xs font-medium tabular-nums ${up ? 'text-success' : 'text-alert'}`}
      title={`vs prior week: ${money ? fmtMoney(prev) : prev.toFixed(1)}`}
    >
      <Icon className="h-3.5 w-3.5" />
      {Math.abs(pct).toFixed(0)}%
    </span>
  );
}

function Tile({
  label,
  value,
  sub,
  to,
  delta,
}: {
  label: string;
  value: string;
  sub?: string;
  to?: string;
  delta?: React.ReactNode;
}) {
  const body = (
    <Card className={to ? 'h-full transition-colors hover:border-gold/40' : 'h-full'}>
      <CardContent className="p-4">
        <div className="text-xs text-silver">{label}</div>
        <div className="mt-1 flex items-baseline gap-2">
          <span className="text-2xl font-semibold tabular-nums text-white">{value}</span>
          {delta}
        </div>
        {sub && <div className="mt-0.5 text-xs text-silver">{sub}</div>}
      </CardContent>
    </Card>
  );
  return to ? <Link to={to}>{body}</Link> : body;
}

export function ExecutiveDashboard() {
  const { user } = useAuth();
  const [summary, setSummary] = useState<ExecSummary | null>(null);
  const [floor, setFloor] = useState<FloorNowResponse | null>(null);
  const [ot, setOt] = useState<OtOutlookResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [packBusy, setPackBusy] = useState(false);

  const load = useCallback(() => {
    setError(null);
    apiFetch<ExecSummary>('/executive/summary')
      .then(setSummary)
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : 'Could not load the executive summary.'),
      );
    floorNow().then(setFloor).catch(() => setFloor(null));
    otOutlook().then(setOt).catch(() => setOt(null));
  }, []);
  useEffect(() => {
    load();
    // Keep the live tiles honest without a manual refresh.
    const t = setInterval(() => {
      floorNow().then(setFloor).catch(() => undefined);
    }, 120_000);
    return () => clearInterval(t);
  }, [load]);

  const downloadBoardPack = async () => {
    if (packBusy) return;
    setPackBusy(true);
    try {
      const res = await fetch('/api/executive/board-pack.pdf', { credentials: 'include' });
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `board-pack-${new Date().toISOString().slice(0, 10)}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error('Could not generate the board pack — try again.');
    } finally {
      setPackBusy(false);
    }
  };

  const prevWeek = summary && summary.trend.length >= 2
    ? summary.trend[summary.trend.length - 2]
    : null;
  const trendData = useMemo(
    () =>
      (summary?.trend ?? []).map((w) => ({
        week: w.start.slice(5, 10),
        billed: w.estBilled,
        margin: w.estMargin,
        hours: Math.round(w.workedHours * 10) / 10,
        ot: Math.round(w.otHours * 10) / 10,
        regular: Math.round((w.workedHours - w.otHours) * 10) / 10,
      })),
    [summary],
  );
  const composition = useMemo(() => {
    if (!summary) return [];
    return [
      { name: 'Active', value: summary.workforce.active, color: GOLD },
      { name: 'Onboarding', value: summary.workforce.onboardingInFlight, color: 'rgb(var(--color-steel))' },
      { name: 'Paused', value: summary.workforce.deactivated, color: 'rgb(var(--color-silver) / 0.45)' },
    ].filter((s) => s.value > 0);
  }, [summary]);

  const onFloor = floor ? floor.rows.reduce((n, r) => n + r.clockedIn, 0) : null;
  const expected = floor ? floor.rows.reduce((n, r) => n + (r.expected ?? 0), 0) : null;
  const otRisk = ot ? ot.rows.filter((r) => r.projectedOtMinutes > 0) : null;
  const maxPlaced = summary
    ? Math.max(1, ...summary.clients.map((c) => c.activeAssociates))
    : 1;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-white">
            Good {new Date().getHours() < 12 ? 'morning' : 'afternoon'}
            {user ? `, ${user.email.split('@')[0]}` : ''}
          </h1>
          <p className="text-sm text-silver">
            <LiveNow
              render={(now) => (
                <>
                  {now.toLocaleDateString('en-US', {
                    weekday: 'long',
                    month: 'long',
                    day: 'numeric',
                  })}{' '}
                  ·{' '}
                  {now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}{' '}
                  — company posture at a glance, board-ready.
                </>
              )}
            />
          </p>
        </div>
        <Button onClick={() => void downloadBoardPack()} loading={packBusy} disabled={packBusy}>
          <Download className="mr-2 h-4 w-4" />
          Download board pack
        </Button>
      </div>

      {error && (
        <ErrorBanner
          action={
            <Button size="sm" variant="secondary" onClick={load}>
              Retry
            </Button>
          }
        >
          {error}
        </ErrorBanner>
      )}

      {!summary && !error && (
        <>
          <Skeleton className="h-[260px]" />
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-[96px]" />
            ))}
          </div>
        </>
      )}

      {summary && (
        <>
          {/* Hero — the margin story with its eight-week arc behind it. */}
          <Card className="overflow-hidden">
            <CardContent className="p-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="text-xs uppercase tracking-wider text-silver/70">
                    Estimated margin — last week
                  </div>
                  <div className="mt-1 flex items-baseline gap-3">
                    <span className="text-4xl font-semibold tabular-nums text-white">
                      {fmtMoney(summary.lastWeek.estMargin)}
                    </span>
                    {prevWeek && (
                      <Delta now={summary.lastWeek.estMargin} prev={prevWeek.estMargin} money />
                    )}
                  </div>
                  <div className="mt-1 text-sm text-silver">
                    on {fmtMoney(summary.lastWeek.estBilled)} billed ·{' '}
                    {summary.lastWeek.workedHours.toFixed(1)}h worked by{' '}
                    {summary.lastWeek.headsWorked} associates
                  </div>
                </div>
                <Link to="/labor-costs" className="text-xs text-gold hover:text-gold-bright">
                  Open the live margin board
                </Link>
              </div>
              <div className="mt-4 h-44">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={trendData} margin={{ top: 4, right: 8, bottom: 0, left: -6 }}>
                    <defs>
                      <linearGradient id="execBilled" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={GOLD} stopOpacity={0.35} />
                        <stop offset="100%" stopColor={GOLD} stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke={GRID} vertical={false} />
                    <XAxis
                      dataKey="week"
                      tick={{ fill: SILVER, fontSize: 11 }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <YAxis
                      tickFormatter={(v: number) => `$${(v / 1000).toFixed(0)}k`}
                      tick={{ fill: SILVER, fontSize: 11 }}
                      axisLine={false}
                      tickLine={false}
                      width={44}
                    />
                    <Tooltip
                      formatter={(value, name) => [
                        fmtMoney(Number(value)),
                        name === 'billed' ? 'Est. billed' : 'Est. margin',
                      ]}
                      labelFormatter={(l) => `Week of ${l}`}
                      contentStyle={TOOLTIP_STYLE}
                    />
                    <Area
                      type="monotone"
                      dataKey="billed"
                      stroke={GOLD}
                      strokeWidth={2}
                      fill="url(#execBilled)"
                    />
                    <Area
                      type="monotone"
                      dataKey="margin"
                      stroke="rgb(var(--color-success))"
                      strokeWidth={2}
                      fill="transparent"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
              <div className="mt-1 flex gap-4 text-2xs text-silver/70">
                <span className="flex items-center gap-1.5">
                  <span className="h-1.5 w-4 rounded-full bg-gold" /> Est. billed
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-1.5 w-4 rounded-full bg-success" /> Est. margin
                </span>
              </div>
            </CardContent>
          </Card>

          {/* KPI band with week-over-week direction. */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Tile
              label="Active associates"
              value={String(summary.workforce.active)}
              sub={`${summary.workforce.deactivated} paused · ${summary.workforce.onboardingInFlight} onboarding`}
              to="/people"
            />
            <Tile
              label="Hires / separations (30d)"
              value={`${summary.workforce.hires30d} / ${summary.workforce.separations30d}`}
              to="/headcount"
            />
            <Tile
              label="On the floor now"
              value={onFloor === null ? '—' : String(onFloor)}
              sub={expected ? `expected ${expected}` : undefined}
              to="/labor-costs"
            />
            <Tile
              label="OT risk this week"
              value={otRisk === null ? '—' : String(otRisk.length)}
              sub={
                otRisk && otRisk.length > 0
                  ? `${(otRisk.reduce((n, r) => n + r.projectedOtMinutes, 0) / 60).toFixed(1)}h projected`
                  : 'no one projected past 40h'
              }
              to="/labor-costs"
            />
            <Tile
              label="Hours last week"
              value={`${summary.lastWeek.workedHours.toFixed(1)}h`}
              sub={`${summary.lastWeek.otHours.toFixed(1)}h OT`}
              to="/analytics"
              delta={
                prevWeek ? (
                  <Delta now={summary.lastWeek.workedHours} prev={prevWeek.workedHours} />
                ) : undefined
              }
            />
            <Tile
              label="Est. billed last week"
              value={fmtMoney(summary.lastWeek.estBilled)}
              sub="at standard SOW rates"
              to="/clients"
              delta={
                prevWeek ? (
                  <Delta now={summary.lastWeek.estBilled} prev={prevWeek.estBilled} money />
                ) : undefined
              }
            />
            <Tile
              label="Labor cost last week"
              value={fmtMoney(summary.lastWeek.estLaborCost)}
              sub="fully loaded"
              to="/labor-costs"
            />
            <Tile
              label="This week so far"
              value={`${summary.thisWeek.workedHours.toFixed(1)}h`}
              sub={`est. billed ${fmtMoney(summary.thisWeek.estBilled)}`}
              to="/labor-costs"
            />
          </div>

          {/* Infographics row: hours composition + workforce donut. */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Hours & overtime — eight weeks</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="h-52">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={trendData} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
                      <CartesianGrid stroke={GRID} vertical={false} />
                      <XAxis
                        dataKey="week"
                        tick={{ fill: SILVER, fontSize: 11 }}
                        axisLine={false}
                        tickLine={false}
                      />
                      <YAxis
                        tick={{ fill: SILVER, fontSize: 11 }}
                        axisLine={false}
                        tickLine={false}
                        width={40}
                      />
                      <Tooltip
                        formatter={(value, name) => [
                          `${Number(value).toFixed(1)}h`,
                          name === 'regular' ? 'Regular hours' : 'Overtime',
                        ]}
                        labelFormatter={(l) => `Week of ${l}`}
                        contentStyle={TOOLTIP_STYLE}
                      />
                      <Bar dataKey="regular" stackId="h" fill="rgb(var(--color-steel))" radius={[0, 0, 0, 0]} />
                      <Bar dataKey="ot" stackId="h" fill={GOLD} radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div className="mt-1 flex gap-4 text-2xs text-silver/70">
                  <span className="flex items-center gap-1.5">
                    <span className="h-1.5 w-4 rounded-full bg-steel" /> Regular
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="h-1.5 w-4 rounded-full bg-gold" /> Overtime
                  </span>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Workforce composition</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="h-44">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={composition}
                        dataKey="value"
                        nameKey="name"
                        innerRadius="62%"
                        outerRadius="90%"
                        paddingAngle={2}
                        stroke="none"
                      >
                        {composition.map((s) => (
                          <Cell key={s.name} fill={s.color} />
                        ))}
                      </Pie>
                      <Tooltip
                        formatter={(value, name) => [String(value), String(name)]}
                        contentStyle={TOOLTIP_STYLE}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <ul className="mt-2 space-y-1 text-xs text-silver">
                  {composition.map((s) => (
                    <li key={s.name} className="flex items-center justify-between">
                      <span className="flex items-center gap-1.5">
                        <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
                        {s.name}
                      </span>
                      <span className="tabular-nums text-white">{s.value}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          </div>

          {/* Live floor — per-store coverage bars. */}
          {floor && floor.rows.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">Live floor</CardTitle>
                  <span className="text-2xs text-silver/70">
                    refreshes every 2 min ·{' '}
                    <Link to="/labor-costs" className="text-gold hover:text-gold-bright">
                      full board
                    </Link>
                  </span>
                </div>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2.5">
                  {[...floor.rows]
                    .sort((a, b) => b.clockedIn - a.clockedIn)
                    .slice(0, 8)
                    .map((r) => {
                      const target = r.expected ?? r.totalTarget ?? null;
                      const pct = target
                        ? Math.min(100, Math.round((r.clockedIn / target) * 100))
                        : r.clockedIn > 0
                          ? 100
                          : 0;
                      const short = target !== null && r.clockedIn < target;
                      return (
                        <li key={r.locationId}>
                          <div className="flex items-center justify-between text-sm">
                            <span className="min-w-0 truncate text-white">
                              {r.clientName} — {r.locationName}
                            </span>
                            <span className="tabular-nums text-silver">
                              {r.clockedIn}
                              {target !== null ? ` / ${target}` : ''}
                              {r.windowLabel ? ` · ${r.windowLabel}` : ''}
                            </span>
                          </div>
                          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-navy-secondary/70">
                            <div
                              className={`h-full rounded-full ${short ? 'bg-warning' : 'bg-gold'}`}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </li>
                      );
                    })}
                </ul>
              </CardContent>
            </Card>
          )}

          {/* The people behind the numbers. */}
          {summary.newHires30d.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">
                    New to the team — last 30 days ({summary.workforce.hires30d})
                  </CardTitle>
                  <Link to="/people" className="text-xs text-gold hover:text-gold-bright">
                    People directory
                  </Link>
                </div>
              </CardHeader>
              <CardContent>
                <ul className="flex flex-wrap gap-4">
                  {summary.newHires30d.slice(0, 12).map((h) => (
                    <li key={h.id} className="w-20 text-center">
                      <Link to={`/people?associateId=${h.id}`} className="group block">
                        <Avatar
                          src={h.photoUrl}
                          name={h.name}
                          size="lg"
                          className="mx-auto transition-transform group-hover:scale-105"
                        />
                        <div className="mt-1.5 truncate text-xs text-white group-hover:text-gold">
                          {h.name.split(' ')[0]}
                        </div>
                        {h.hireDate && (
                          <div className="text-2xs text-silver/70">{fmtDate(h.hireDate)}</div>
                        )}
                      </Link>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">Client placements</CardTitle>
                  <Link to="/clients" className="text-xs text-gold hover:text-gold-bright">
                    All clients
                  </Link>
                </div>
              </CardHeader>
              <CardContent>
                {summary.clients.length === 0 ? (
                  <p className="text-sm text-silver">No open site placements on record.</p>
                ) : (
                  <ul className="space-y-2.5">
                    {summary.clients.slice(0, 6).map((c) => (
                      <li key={c.clientId}>
                        <div className="flex items-center justify-between text-sm">
                          <Link
                            to={`/clients/${c.clientId}`}
                            className="min-w-0 truncate text-white hover:text-gold"
                          >
                            {c.clientName}
                          </Link>
                          <span className="tabular-nums text-silver">
                            {c.activeAssociates} placed
                          </span>
                        </div>
                        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-navy-secondary/70">
                          <div
                            className="h-full rounded-full bg-steel"
                            style={{
                              width: `${Math.round((c.activeAssociates / maxPlaced) * 100)}%`,
                            }}
                          />
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">Attendance — last 30 days</CardTitle>
                  <Link to="/compliance" className="text-xs text-gold hover:text-gold-bright">
                    Compliance
                  </Link>
                </div>
              </CardHeader>
              <CardContent>
                {summary.attendance30d.length === 0 ? (
                  <p className="flex items-center gap-2 text-sm text-silver">
                    <TrendingUp className="h-4 w-4" />
                    No unexcused attendance events — a clean month.
                  </p>
                ) : (
                  <ul className="divide-y divide-navy-secondary/60">
                    {summary.attendance30d.map((a) => (
                      <li key={a.kind} className="flex items-center justify-between py-2 text-sm">
                        <span className="text-white">{ATTENDANCE_LABEL[a.kind] ?? a.kind}</span>
                        <span className="tabular-nums text-silver">{a.count}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>

          {otRisk && otRisk.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">Overtime outlook — this week</CardTitle>
                  <Link to="/labor-costs" className="text-xs text-gold hover:text-gold-bright">
                    Full radar
                  </Link>
                </div>
              </CardHeader>
              <CardContent>
                <ul className="divide-y divide-navy-secondary/60">
                  {otRisk.slice(0, 5).map((r) => (
                    <li
                      key={r.associateId}
                      className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
                    >
                      <span className="min-w-0 truncate text-white">{r.associateName}</span>
                      <span className="tabular-nums text-silver">
                        {(r.projectedOtMinutes / 60).toFixed(1)}h OT projected
                        {r.estOtBilled !== null ? ` · ${fmtMoney(r.estOtBilled)} billed` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          <p className="text-xs text-silver/70">
            Dollar figures are estimates at org standard rates; finalized client statements
            are the invoice-grade record. Weeks run Saturday to Friday, Florida time.
          </p>
        </>
      )}
    </div>
  );
}
