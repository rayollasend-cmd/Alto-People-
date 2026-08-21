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
  rates: { payRate: number; billRate: number; burdenPct: number; overheadPerHour: number };
  league: Array<{
    clientId: string;
    clientName: string;
    locationId: string;
    locationName: string;
    hours: number;
    otHours: number;
    estBilled: number;
    estMargin: number;
  }>;
  concentration: Array<{ clientId: string; clientName: string; sharePct: number }>;
  turnover: { separations90d: number; costPerSeparation: number; estCost90d: number };
}

interface Receivables {
  outstanding: Array<{
    id: string;
    clientName: string;
    number: number | null;
    periodStart: string;
    amount: number;
    ageDays: number;
  }>;
  totals: {
    outstandingAmount: number;
    outstandingCount: number;
    aging: { current: number; days30: number; days45: number; days60plus: number };
    avgDaysToPay: number | null;
    paidCount: number;
  };
}

interface TargetsResponse {
  quarter: string;
  elapsedPct: number;
  targets: {
    revenueTarget: number | null;
    marginTarget: number | null;
    headcountTarget: number | null;
    turnoverPctTarget: number | null;
    fillRatePctTarget: number | null;
  } | null;
  actuals: {
    revenueQtd: number;
    marginQtd: number;
    headcount: number;
    turnoverAnnualizedPct: number;
    fillRatePct: number | null;
  };
}

interface ProspectsResponse {
  prospects: Array<{
    id: string;
    name: string;
    stage: string;
    estWeeklyHours: number | null;
    estBillRate: number | null;
  }>;
}

interface ExecBriefing {
  generatedAt: string;
  today: {
    dateKey: string;
    shiftsTotal: number;
    shiftsAssigned: number;
    shiftsOpen: number;
    openShifts: Array<{
      clientName: string;
      locationName: string | null;
      position: string;
      startsAt: string;
      count: number;
    }>;
    estBilledToday: number;
    incidents: Array<{ kind: string; associateName: string; clientName: string | null }>;
  };
  outlook: Array<{ dateKey: string; published: number; assigned: number; open: number }>;
  decisions: Array<{
    key: string;
    category: 'run' | 'develop' | 'move';
    severity: 'critical' | 'high' | 'normal';
    label: string;
    detail: string;
    stakes: number | null;
    ageDays: number | null;
    linkUrl: string;
    status: 'open' | 'delegated';
    delegatedDays: number | null;
  }>;
  clientHealth: Array<{
    clientId: string;
    clientName: string;
    score: number;
    band: 'green' | 'amber' | 'red';
    fillRatePct: number | null;
    fillDeltaPct: number | null;
    reasons: string[];
  }>;
  capacity: {
    bench: number;
    funnel: { inFlight: number; approved30d: number };
    j1Active: number;
    j1Cliff: Array<{ month: string; count: number }>;
  };
  people: {
    topPerformers: Array<{ id: string; name: string; photoUrl: string | null; hours: number }>;
    anniversaries: Array<{
      id: string;
      name: string;
      photoUrl: string | null;
      years: number;
      date: string;
    }>;
  };
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

const CATEGORY_LABEL: Record<string, string> = {
  run: 'Run',
  develop: 'Develop',
  move: 'Move',
};

/** The chairman's queue — stakes-ranked, workable (dismiss/snooze/delegate),
 *  with delegated items held visible until their condition resolves. */
function DecisionQueueCard({
  decisions,
  onChanged,
}: {
  decisions: ExecBriefing['decisions'];
  onChanged: () => void;
}) {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const open = decisions.filter((d) => d.status === 'open');
  const delegated = decisions.filter((d) => d.status === 'delegated');

  const act = async (key: string, action: 'dismiss' | 'snooze' | 'delegate') => {
    if (busyKey) return;
    setBusyKey(`${key}:${action}`);
    try {
      await apiFetch('/executive/decisions/action', {
        method: 'POST',
        body: { key, action },
      });
      toast.success(
        action === 'dismiss'
          ? 'Dismissed — it will re-raise only if the stakes grow.'
          : action === 'snooze'
            ? 'Snoozed for 7 days.'
            : 'Delegated — your admins were notified; it stays listed until resolved.',
      );
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not update the decision.');
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <Card className={open.some((d) => d.severity === 'critical') ? 'border-alert/40' : undefined}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Needs your decision</CardTitle>
          {open.length > 0 && (
            <span className="text-2xs tabular-nums text-silver/70">
              {open.length} open{delegated.length > 0 ? ` · ${delegated.length} with your team` : ''}
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {open.length === 0 && delegated.length === 0 ? (
          <p className="text-sm text-silver">Nothing waiting on you — the queue is clear.</p>
        ) : (
          <>
            <ul className="space-y-2.5">
              {open.slice(0, 5).map((d) => (
                <li
                  key={d.key}
                  className={`rounded-md border-l-2 bg-navy-secondary/30 px-3 py-2 ${
                    d.severity === 'critical'
                      ? 'border-alert'
                      : d.severity === 'high'
                        ? 'border-warning'
                        : 'border-navy-secondary'
                  }`}
                >
                  <Link to={d.linkUrl} className="group block">
                    <div className="flex flex-wrap items-center justify-between gap-x-2">
                      <span className="text-sm text-white group-hover:text-gold">{d.label}</span>
                      <span className="flex items-center gap-1.5 text-2xs tabular-nums">
                        {d.stakes !== null && (
                          <span
                            className={
                              d.severity === 'critical' ? 'font-medium text-alert' : 'text-silver'
                            }
                          >
                            {fmtMoney(d.stakes)} at stake
                          </span>
                        )}
                        {d.ageDays !== null && d.ageDays > 0 && (
                          <span className="text-silver/60">· waiting {d.ageDays}d</span>
                        )}
                        <span className="rounded-full bg-navy-secondary/80 px-1.5 py-0.5 text-silver/70">
                          {CATEGORY_LABEL[d.category]}
                        </span>
                      </span>
                    </div>
                    <div className="text-xs text-silver">{d.detail}</div>
                  </Link>
                  <div className="mt-1.5 flex gap-1.5">
                    <Button
                      size="xs"
                      variant="ghost"
                      loading={busyKey === `${d.key}:delegate`}
                      disabled={busyKey !== null}
                      onClick={() => void act(d.key, 'delegate')}
                    >
                      Delegate to team
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      loading={busyKey === `${d.key}:snooze`}
                      disabled={busyKey !== null}
                      onClick={() => void act(d.key, 'snooze')}
                    >
                      Snooze 7d
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      loading={busyKey === `${d.key}:dismiss`}
                      disabled={busyKey !== null}
                      onClick={() => void act(d.key, 'dismiss')}
                    >
                      Dismiss
                    </Button>
                  </div>
                </li>
              ))}
              {open.length > 5 && (
                <li className="text-center text-2xs text-silver/60">
                  +{open.length - 5} more in the queue
                </li>
              )}
            </ul>
            {delegated.length > 0 && (
              <div className="mt-3">
                <div className="mb-1 text-2xs uppercase tracking-wider text-silver/60">
                  With your team
                </div>
                <ul className="space-y-1">
                  {delegated.map((d) => (
                    <li
                      key={d.key}
                      className="flex items-center justify-between gap-2 text-xs"
                    >
                      <Link
                        to={d.linkUrl}
                        className="min-w-0 truncate text-silver hover:text-gold"
                      >
                        {d.label}
                      </Link>
                      <span className="shrink-0 tabular-nums text-silver/60">
                        delegated{' '}
                        {d.delegatedDays !== null && d.delegatedDays > 0
                          ? `${d.delegatedDays}d ago`
                          : 'today'}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function TargetBar({
  label,
  actual,
  target,
  pacePct,
  fmt,
}: {
  label: string;
  actual: number;
  target: number;
  /** Where "on pace" sits (percent of quarter elapsed; 100 for level targets). */
  pacePct: number;
  fmt: (v: number) => string;
}) {
  const pct = target > 0 ? Math.min(100, Math.max(0, (actual / target) * 100)) : 0;
  const behind = pct < pacePct - 5;
  return (
    <div>
      <div className="flex items-center justify-between text-sm">
        <span className="text-silver">{label}</span>
        <span className="tabular-nums text-white">
          {fmt(actual)} <span className="text-silver/60">/ {fmt(target)}</span>
        </span>
      </div>
      <div className="relative mt-1 h-1.5 overflow-hidden rounded-full bg-navy-secondary/70">
        <div
          className={`h-full rounded-full ${behind ? 'bg-warning' : 'bg-success'}`}
          style={{ width: `${pct}%` }}
        />
        {pacePct < 100 && (
          <div
            className="absolute top-0 h-full w-px bg-silver/60"
            style={{ left: `${pacePct}%` }}
            title={`On-pace marker: ${pacePct}% of the quarter elapsed`}
          />
        )}
      </div>
    </div>
  );
}

function LeagueRow({
  rank,
  row,
  worst,
}: {
  rank: number;
  row: ExecSummary['league'][number];
  worst?: boolean;
}) {
  return (
    <li className="flex items-center justify-between gap-2 py-1.5 text-sm">
      <span className="flex min-w-0 items-center gap-2">
        <span
          className={`w-5 shrink-0 text-right tabular-nums text-xs ${worst ? 'text-alert' : 'text-gold'}`}
        >
          {rank}
        </span>
        <span className="min-w-0 truncate text-white">
          {row.clientName} — {row.locationName}
        </span>
      </span>
      <span className={`tabular-nums ${row.estMargin < 0 ? 'text-alert' : 'text-silver'}`}>
        {fmtMoney(row.estMargin)}
        {row.otHours > 0 ? ` · ${row.otHours.toFixed(1)}h OT` : ''}
      </span>
    </li>
  );
}

function RateCalculator({
  rates,
  trend,
}: {
  rates: ExecSummary['rates'];
  trend: ExecSummary['trend'];
}) {
  const [bill, setBill] = useState(rates.billRate);
  const [pay, setPay] = useState(rates.payRate);
  const recent = trend.slice(-4);
  const weeklyHours =
    recent.length > 0 ? recent.reduce((n, w) => n + w.workedHours, 0) / recent.length : 0;
  const weeklyOt =
    recent.length > 0 ? recent.reduce((n, w) => n + w.otHours, 0) / recent.length : 0;
  const annualMargin = (b: number, p: number) => {
    const billed = weeklyHours * b + weeklyOt * b * 0.5;
    const cost =
      (weeklyHours * p + weeklyOt * p * 0.5) * (1 + rates.burdenPct / 100) +
      weeklyHours * rates.overheadPerHour;
    return (billed - cost) * 52;
  };
  const current = annualMargin(rates.billRate, rates.payRate);
  const adjusted = annualMargin(bill, pay);
  const delta = adjusted - current;
  const num = (v: string, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Rate negotiation model</CardTitle>
        <p className="text-xs text-silver">
          What-if on your real volume — {weeklyHours.toFixed(0)}h/week average over the
          last four weeks ({weeklyOt.toFixed(1)}h OT), burden {rates.burdenPct}%.
        </p>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-end gap-4">
          <label className="text-xs text-silver">
            Bill rate ($/h)
            <input
              type="number"
              step="0.25"
              min="0"
              value={bill}
              onChange={(e) => setBill(num(e.target.value, rates.billRate))}
              className="mt-1 block h-9 w-28 rounded border border-navy-secondary bg-navy-secondary/60 px-2 text-sm text-white tabular-nums focus:border-gold focus:outline-none"
            />
          </label>
          <label className="text-xs text-silver">
            Pay rate ($/h)
            <input
              type="number"
              step="0.25"
              min="0"
              value={pay}
              onChange={(e) => setPay(num(e.target.value, rates.payRate))}
              className="mt-1 block h-9 w-28 rounded border border-navy-secondary bg-navy-secondary/60 px-2 text-sm text-white tabular-nums focus:border-gold focus:outline-none"
            />
          </label>
          <div className="min-w-[180px]">
            <div className="text-xs text-silver">Annualized margin impact</div>
            <div
              className={`text-xl font-semibold tabular-nums ${delta > 0 ? 'text-success' : delta < 0 ? 'text-alert' : 'text-white'}`}
            >
              {delta >= 0 ? '+' : '−'}
              {fmtMoney(Math.abs(delta))}
            </div>
            <div className="text-2xs text-silver/70">
              vs current {fmtMoney(current)} / yr at ${rates.billRate.toFixed(2)} bill · $
              {rates.payRate.toFixed(2)} pay
            </div>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setBill(rates.billRate);
              setPay(rates.payRate);
            }}
          >
            Reset
          </Button>
        </div>
      </CardContent>
    </Card>
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
  const [recv, setRecv] = useState<Receivables | null>(null);
  const [targets, setTargets] = useState<TargetsResponse | null>(null);
  const [prospects, setProspects] = useState<ProspectsResponse | null>(null);
  const [brief, setBrief] = useState<ExecBriefing | null>(null);
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
    apiFetch<Receivables>('/executive/receivables').then(setRecv).catch(() => setRecv(null));
    apiFetch<TargetsResponse>('/executive/targets').then(setTargets).catch(() => setTargets(null));
    apiFetch<ProspectsResponse>('/executive/prospects')
      .then(setProspects)
      .catch(() => setProspects(null));
    apiFetch<ExecBriefing>('/executive/briefing').then(setBrief).catch(() => setBrief(null));
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

      {/* The 6:45am read — today's exposure + the chairman's queue. */}
      {brief && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card className={brief.today.shiftsOpen > 0 ? 'border-warning/40' : undefined}>
            <CardHeader className="pb-2">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <CardTitle className="text-base">Today</CardTitle>
                  <p className="text-2xs text-silver/70">
                    {new Date().toLocaleDateString('en-US', {
                      weekday: 'long',
                      month: 'long',
                      day: 'numeric',
                    })}
                  </p>
                </div>
                <div className="text-right">
                  <div className="text-xl font-semibold tabular-nums text-white">
                    {fmtMoney(brief.today.estBilledToday)}
                  </div>
                  <div className="text-2xs text-silver/70">est. billed today</div>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {/* Coverage gauge. */}
              {brief.today.shiftsTotal === 0 ? (
                <p className="text-sm text-silver">No shifts published today.</p>
              ) : (
                <div>
                  <div className="flex items-baseline justify-between">
                    <span
                      className={`text-3xl font-semibold tabular-nums ${brief.today.shiftsOpen === 0 ? 'text-success' : 'text-white'}`}
                    >
                      {Math.round(
                        (brief.today.shiftsAssigned / brief.today.shiftsTotal) * 100,
                      )}
                      %
                    </span>
                    <span className="text-xs tabular-nums text-silver">
                      {brief.today.shiftsAssigned}/{brief.today.shiftsTotal} covered
                      {brief.today.shiftsOpen > 0 && (
                        <span className="font-medium text-warning">
                          {' '}
                          · {brief.today.shiftsOpen} open
                        </span>
                      )}
                    </span>
                  </div>
                  <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-navy-secondary/70">
                    <div
                      className={`h-full rounded-full ${brief.today.shiftsOpen === 0 ? 'bg-success' : 'bg-gold'}`}
                      style={{
                        width: `${(brief.today.shiftsAssigned / brief.today.shiftsTotal) * 100}%`,
                      }}
                    />
                  </div>
                </div>
              )}

              {/* Open shifts, grouped, with urgency. */}
              {brief.today.openShifts.length > 0 && (
                <ul className="space-y-1.5">
                  {brief.today.openShifts.map((s, i) => {
                    const start = new Date(s.startsAt);
                    const hoursOut = (start.getTime() - Date.now()) / 3_600_000;
                    const urgent = hoursOut >= 0 && hoursOut < 3;
                    const past = hoursOut < 0;
                    return (
                      <li key={i}>
                        <Link
                          to="/scheduling"
                          className="group flex items-center justify-between gap-2 text-sm"
                        >
                          <span className="min-w-0 truncate text-white group-hover:text-gold">
                            {s.count > 1 && (
                              <span className="font-semibold text-warning">{s.count}× </span>
                            )}
                            {s.position}
                            <span className="text-silver">
                              {' '}
                              · {s.locationName ?? s.clientName}
                            </span>
                          </span>
                          <span
                            className={`shrink-0 rounded-full px-2 py-0.5 text-2xs font-medium tabular-nums ${
                              urgent || past
                                ? 'bg-alert/15 text-alert'
                                : 'bg-navy-secondary/70 text-silver'
                            }`}
                          >
                            {past
                              ? 'started'
                              : urgent
                                ? `in ${Math.max(1, Math.round(hoursOut))}h`
                                : start.toLocaleTimeString('en-US', {
                                    hour: 'numeric',
                                    minute: '2-digit',
                                  })}
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}

              {/* The future: 6-day coverage outlook. */}
              {brief.outlook.length > 0 && (
                <div>
                  <div className="mb-1 text-2xs uppercase tracking-wider text-silver/60">
                    Next {brief.outlook.length} days
                  </div>
                  <div className="flex items-end gap-1.5">
                    {brief.outlook.map((d) => {
                      const pct =
                        d.published > 0 ? Math.round((d.assigned / d.published) * 100) : null;
                      const weekday = new Date(`${d.dateKey}T12:00:00Z`).toLocaleDateString(
                        'en-US',
                        { weekday: 'short', timeZone: 'UTC' },
                      );
                      return (
                        <Link
                          key={d.dateKey}
                          to="/scheduling"
                          className="group flex-1 text-center"
                          title={`${d.dateKey}: ${d.assigned}/${d.published} covered${d.open ? `, ${d.open} open` : ''}`}
                        >
                          <div className="flex h-10 items-end overflow-hidden rounded bg-navy-secondary/50">
                            <div
                              className={`w-full ${pct === null ? 'bg-navy-secondary/50' : d.open > 0 ? 'bg-warning/80' : 'bg-success/70'}`}
                              style={{ height: `${pct ?? 4}%` }}
                            />
                          </div>
                          <div className="mt-0.5 text-2xs text-silver/70 group-hover:text-gold">
                            {weekday}
                          </div>
                          <div
                            className={`text-2xs tabular-nums ${d.open > 0 ? 'font-medium text-warning' : 'text-silver/50'}`}
                          >
                            {d.open > 0 ? `${d.open} open` : pct === null ? '—' : '✓'}
                          </div>
                        </Link>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Overnight incidents. */}
              {brief.today.incidents.length === 0 ? (
                <p className="text-2xs text-silver/70">
                  Last 24h: no unexcused attendance events.
                </p>
              ) : (
                <div>
                  <div className="mb-1 text-2xs uppercase tracking-wider text-silver/60">
                    Last 24 hours
                  </div>
                  <ul className="space-y-0.5">
                    {brief.today.incidents.slice(0, 4).map((inc, i) => (
                      <li key={i} className="flex items-center justify-between text-xs">
                        <span className="min-w-0 truncate text-white">{inc.associateName}</span>
                        <span
                          className={`shrink-0 ${inc.kind === 'NO_CALL_NO_SHOW' ? 'text-alert' : 'text-warning'}`}
                        >
                          {inc.kind.toLowerCase().replace(/_/g, ' ')}
                          {inc.clientName ? ` · ${inc.clientName.replace(/^Walmart /, '')}` : ''}
                        </span>
                      </li>
                    ))}
                    {brief.today.incidents.length > 4 && (
                      <li className="text-2xs text-silver/60">
                        +{brief.today.incidents.length - 4} more — see Compliance
                      </li>
                    )}
                  </ul>
                </div>
              )}
            </CardContent>
          </Card>

          <DecisionQueueCard decisions={brief.decisions} onChanged={load} />
        </div>
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
            <Tile
              label="Receivables outstanding"
              value={recv ? fmtMoney(recv.totals.outstandingAmount) : '—'}
              sub={
                recv
                  ? `${recv.totals.outstandingCount} statement${recv.totals.outstandingCount === 1 ? '' : 's'}${recv.totals.avgDaysToPay !== null ? ` · pays in ~${recv.totals.avgDaysToPay}d` : ''}`
                  : undefined
              }
            />
            <Tile
              label="Turnover cost (90d)"
              value={fmtMoney(summary.turnover.estCost90d)}
              sub={`${summary.turnover.separations90d} separations × ${fmtMoney(summary.turnover.costPerSeparation)}`}
              to="/analytics"
            />
          </div>

          {/* Targets vs actuals + receivables aging. */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">
                    {targets ? `${targets.quarter} — plan vs actual` : 'Quarter plan'}
                  </CardTitle>
                  {targets && (
                    <span className="text-2xs text-silver/70">
                      {targets.elapsedPct}% of quarter elapsed
                    </span>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                {!targets || !targets.targets ? (
                  <p className="text-sm text-silver">
                    No targets set for this quarter yet — an administrator can set
                    revenue, margin, headcount, turnover, and fill-rate targets, and
                    this card tracks the pace against them.
                  </p>
                ) : (
                  <div className="space-y-3">
                    {targets.targets.revenueTarget !== null && (
                      <TargetBar
                        label="Revenue"
                        actual={targets.actuals.revenueQtd}
                        target={targets.targets.revenueTarget}
                        pacePct={targets.elapsedPct}
                        fmt={fmtMoney}
                      />
                    )}
                    {targets.targets.marginTarget !== null && (
                      <TargetBar
                        label="Margin"
                        actual={targets.actuals.marginQtd}
                        target={targets.targets.marginTarget}
                        pacePct={targets.elapsedPct}
                        fmt={fmtMoney}
                      />
                    )}
                    {targets.targets.headcountTarget !== null && (
                      <TargetBar
                        label="Headcount"
                        actual={targets.actuals.headcount}
                        target={targets.targets.headcountTarget}
                        pacePct={100}
                        fmt={(v) => String(Math.round(v))}
                      />
                    )}
                    {targets.targets.fillRatePctTarget !== null &&
                      targets.actuals.fillRatePct !== null && (
                        <TargetBar
                          label="Fill rate"
                          actual={targets.actuals.fillRatePct}
                          target={targets.targets.fillRatePctTarget}
                          pacePct={100}
                          fmt={(v) => `${v.toFixed(1)}%`}
                        />
                      )}
                    {targets.targets.turnoverPctTarget !== null && (
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-silver">Turnover (annualized)</span>
                        <span
                          className={`tabular-nums ${targets.actuals.turnoverAnnualizedPct > targets.targets.turnoverPctTarget ? 'text-alert' : 'text-success'}`}
                        >
                          {targets.actuals.turnoverAnnualizedPct.toFixed(1)}% vs ≤
                          {targets.targets.turnoverPctTarget.toFixed(1)}%
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Receivables aging</CardTitle>
              </CardHeader>
              <CardContent>
                {!recv ? (
                  <Skeleton className="h-28" />
                ) : recv.totals.outstandingCount === 0 ? (
                  <p className="text-sm text-silver">
                    Nothing outstanding — every finalized statement is paid.
                    {recv.totals.avgDaysToPay !== null &&
                      ` Clients pay in ~${recv.totals.avgDaysToPay} days on average.`}
                  </p>
                ) : (
                  <>
                    <div className="mb-3 grid grid-cols-4 gap-2 text-center">
                      {(
                        [
                          ['0–30d', recv.totals.aging.current, 'text-white'],
                          ['30–45d', recv.totals.aging.days30, 'text-white'],
                          ['45–60d', recv.totals.aging.days45, 'text-warning'],
                          ['60d+', recv.totals.aging.days60plus, 'text-alert'],
                        ] as const
                      ).map(([label, amount, tone]) => (
                        <div key={label} className="rounded-md bg-navy-secondary/50 p-2">
                          <div className={`text-sm font-semibold tabular-nums ${tone}`}>
                            {fmtMoney(amount)}
                          </div>
                          <div className="text-2xs text-silver/70">{label}</div>
                        </div>
                      ))}
                    </div>
                    <ul className="divide-y divide-navy-secondary/60">
                      {recv.outstanding.slice(0, 5).map((s) => (
                        <li key={s.id} className="flex items-center justify-between py-1.5 text-sm">
                          <span className="min-w-0 truncate text-white">
                            {s.clientName} #{s.number ?? '—'}
                          </span>
                          <span
                            className={`tabular-nums ${s.ageDays >= 45 ? 'text-alert' : 'text-silver'}`}
                          >
                            {fmtMoney(s.amount)} · {s.ageDays}d
                          </span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Store league + concentration & pipeline. */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">Store league — last 4 weeks</CardTitle>
                  <Link to="/labor-costs" className="text-xs text-gold hover:text-gold-bright">
                    Labor board
                  </Link>
                </div>
              </CardHeader>
              <CardContent>
                {summary.league.length === 0 ? (
                  <p className="text-sm text-silver">No worked time in the window.</p>
                ) : (
                  <ul className="divide-y divide-navy-secondary/60">
                    {summary.league.slice(0, 3).map((r, i) => (
                      <LeagueRow key={r.locationId} rank={i + 1} row={r} />
                    ))}
                    {summary.league.length > 4 && (
                      <li className="py-1 text-center text-2xs text-silver/50">···</li>
                    )}
                    {summary.league.length > 3 &&
                      summary.league
                        .slice(-Math.min(3, summary.league.length - 3))
                        .map((r) => (
                          <LeagueRow
                            key={r.locationId}
                            rank={summary.league.indexOf(r) + 1}
                            row={r}
                            worst
                          />
                        ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Concentration & pipeline</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  {summary.concentration.slice(0, 4).map((c) => (
                    <div key={c.clientId} className="mb-2">
                      <div className="flex items-center justify-between text-sm">
                        <span className="min-w-0 truncate text-white">{c.clientName}</span>
                        <span
                          className={`tabular-nums ${c.sharePct >= 70 ? 'text-warning' : 'text-silver'}`}
                        >
                          {c.sharePct.toFixed(1)}%
                        </span>
                      </div>
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-navy-secondary/70">
                        <div
                          className={`h-full rounded-full ${c.sharePct >= 70 ? 'bg-warning' : 'bg-steel'}`}
                          style={{ width: `${Math.min(100, c.sharePct)}%` }}
                        />
                      </div>
                    </div>
                  ))}
                  {summary.concentration[0] && summary.concentration[0].sharePct >= 70 && (
                    <p className="text-2xs text-warning/90">
                      {summary.concentration[0].sharePct.toFixed(0)}% of revenue rides on one
                      client — the pipeline below is the hedge.
                    </p>
                  )}
                </div>
                <div>
                  <div className="mb-1 text-xs uppercase tracking-wider text-silver/70">
                    New-business pipeline
                  </div>
                  {!prospects || prospects.prospects.length === 0 ? (
                    <p className="text-sm text-silver">
                      No prospects tracked yet — admins add them on the Clients page.
                    </p>
                  ) : (
                    <ul className="divide-y divide-navy-secondary/60">
                      {prospects.prospects
                        .filter((p) => p.stage !== 'LOST' && p.stage !== 'WON')
                        .slice(0, 5)
                        .map((p) => (
                          <li key={p.id} className="flex items-center justify-between py-1.5 text-sm">
                            <span className="min-w-0 truncate text-white">{p.name}</span>
                            <span className="tabular-nums text-silver">
                              {p.stage.toLowerCase()}
                              {p.estWeeklyHours && p.estBillRate
                                ? ` · ~${fmtMoney(p.estWeeklyHours * p.estBillRate)}/wk`
                                : ''}
                            </span>
                          </li>
                        ))}
                    </ul>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Client health + capacity & the J-1 cliff. */}
          {brief && (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Client health</CardTitle>
                  <p className="text-xs text-silver">
                    Fill trend, reliability, and payment behavior over the last 4 weeks —
                    the renewal-risk radar.
                  </p>
                </CardHeader>
                <CardContent>
                  {brief.clientHealth.length === 0 ? (
                    <p className="text-sm text-silver">No client activity in the window.</p>
                  ) : (
                    <ul className="space-y-3">
                      {brief.clientHealth.map((c) => (
                        <li key={c.clientId}>
                          <div className="flex items-center justify-between text-sm">
                            <Link
                              to={`/clients/${c.clientId}`}
                              className="min-w-0 truncate text-white hover:text-gold"
                            >
                              {c.clientName}
                            </Link>
                            <span className="flex items-center gap-2">
                              {c.fillRatePct !== null && (
                                <span className="text-xs tabular-nums text-silver">
                                  fill {c.fillRatePct.toFixed(0)}%
                                  {c.fillDeltaPct !== null && c.fillDeltaPct !== 0 && (
                                    <span
                                      className={
                                        c.fillDeltaPct > 0 ? 'text-success' : 'text-alert'
                                      }
                                    >
                                      {' '}
                                      ({c.fillDeltaPct > 0 ? '+' : ''}
                                      {c.fillDeltaPct.toFixed(0)})
                                    </span>
                                  )}
                                </span>
                              )}
                              <span
                                className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium tabular-nums ${
                                  c.band === 'green'
                                    ? 'bg-success/15 text-success'
                                    : c.band === 'amber'
                                      ? 'bg-warning/15 text-warning'
                                      : 'bg-alert/15 text-alert'
                                }`}
                              >
                                {c.score}
                              </span>
                            </span>
                          </div>
                          <p className="mt-0.5 text-xs text-silver/80">
                            {c.reasons.join(' · ')}
                          </p>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Capacity & the J-1 cliff</CardTitle>
                  <p className="text-xs text-silver">
                    Can you say yes to growth — and when does the seasonal workforce
                    roll off?
                  </p>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="grid grid-cols-3 gap-2 text-center">
                    <div className="rounded-md bg-navy-secondary/50 p-2">
                      <div className="text-lg font-semibold tabular-nums text-white">
                        {brief.capacity.bench}
                      </div>
                      <div className="text-2xs text-silver/70">on the bench</div>
                    </div>
                    <div className="rounded-md bg-navy-secondary/50 p-2">
                      <div className="text-lg font-semibold tabular-nums text-white">
                        {brief.capacity.funnel.inFlight}
                      </div>
                      <div className="text-2xs text-silver/70">
                        onboarding · {brief.capacity.funnel.approved30d} approved/30d
                      </div>
                    </div>
                    <div className="rounded-md bg-navy-secondary/50 p-2">
                      <div className="text-lg font-semibold tabular-nums text-white">
                        {brief.capacity.j1Active}
                      </div>
                      <div className="text-2xs text-silver/70">J-1 associates</div>
                    </div>
                  </div>
                  {brief.capacity.j1Cliff.length > 0 ? (
                    <div>
                      <div className="mb-1 text-xs uppercase tracking-wider text-silver/70">
                        Visa / DS-2019 expirations — next 120 days
                      </div>
                      <ul className="space-y-1.5">
                        {brief.capacity.j1Cliff.map((m) => {
                          const max = Math.max(
                            ...brief.capacity.j1Cliff.map((x) => x.count),
                          );
                          return (
                            <li key={m.month} className="flex items-center gap-2 text-xs">
                              <span className="w-14 shrink-0 tabular-nums text-silver">
                                {m.month}
                              </span>
                              <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-navy-secondary/70">
                                <div
                                  className={`h-full rounded-full ${m.count >= Math.max(3, brief.capacity.j1Active * 0.25) ? 'bg-alert' : 'bg-warning'}`}
                                  style={{ width: `${(m.count / max) * 100}%` }}
                                />
                              </div>
                              <span className="w-6 shrink-0 text-right tabular-nums text-white">
                                {m.count}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                      <p className="mt-1 text-2xs text-silver/70">
                        Plan replacements before the tallest bar hits.
                      </p>
                    </div>
                  ) : (
                    <p className="text-xs text-silver">
                      No J-1 documents expiring in the next 120 days.
                    </p>
                  )}
                </CardContent>
              </Card>
            </div>
          )}

          {/* People worth knowing this week. */}
          {brief &&
            (brief.people.topPerformers.length > 0 ||
              brief.people.anniversaries.length > 0) && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">People to know this week</CardTitle>
                </CardHeader>
                <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <div className="mb-2 text-xs uppercase tracking-wider text-silver/70">
                      Hardest workers — last 4 weeks, clean record
                    </div>
                    {brief.people.topPerformers.length === 0 ? (
                      <p className="text-sm text-silver">No qualifying hours yet.</p>
                    ) : (
                      <ul className="space-y-2">
                        {brief.people.topPerformers.map((p, i) => (
                          <li key={p.id} className="flex items-center gap-3">
                            <span className="w-4 text-right text-xs tabular-nums text-gold">
                              {i + 1}
                            </span>
                            <Avatar src={p.photoUrl} name={p.name} size="sm" />
                            <Link
                              to={`/people?associateId=${p.id}`}
                              className="min-w-0 flex-1 truncate text-sm text-white hover:text-gold"
                            >
                              {p.name}
                            </Link>
                            <span className="text-xs tabular-nums text-silver">
                              {p.hours.toFixed(1)}h
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div>
                    <div className="mb-2 text-xs uppercase tracking-wider text-silver/70">
                      Work anniversaries — say congratulations
                    </div>
                    {brief.people.anniversaries.length === 0 ? (
                      <p className="text-sm text-silver">None in the next 7 days.</p>
                    ) : (
                      <ul className="space-y-2">
                        {brief.people.anniversaries.map((p) => (
                          <li key={p.id} className="flex items-center gap-3">
                            <Avatar src={p.photoUrl} name={p.name} size="sm" />
                            <Link
                              to={`/people?associateId=${p.id}`}
                              className="min-w-0 flex-1 truncate text-sm text-white hover:text-gold"
                            >
                              {p.name}
                            </Link>
                            <span className="text-xs tabular-nums text-silver">
                              {p.years} {p.years === 1 ? 'year' : 'years'} ·{' '}
                              {fmtDate(p.date)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}

          {/* What-if rate model on real hours. */}
          <RateCalculator rates={summary.rates} trend={summary.trend} />

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
