import { useMemo, useState } from 'react';
import { useGreeting, greetingName } from '@/lib/greeting';
import { HomeTemplate } from '@/components/templates';
import { HugoSeat } from '@/components/home/HugoSeat';
import { EmptyState } from '@/components/ui/EmptyState';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowDownRight, ArrowUpRight, Download, TrendingUp } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError, apiFetch } from '@/lib/api';
import { useAuth, useTenant, useTerm } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { fmtDate, fmtDateTz, fmtMoney, fmtMoneyCompact, fmtRelativeDate } from '@/lib/format';
import { associatePhotoUrl } from '@/lib/photoUrl';
import { floorNow, otOutlook } from '@/lib/schedulingApi';
import { getOpsBoard, getOpsScorecard } from '@/lib/opsApi';
import { cn } from '@/lib/cn';
import { DecisionRoom } from '@/components/DecisionRoom';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { LiveNow } from '@/components/ui/LiveNow';
import { Skeleton } from '@/components/ui/Skeleton';
import { ChartFrame } from '@/components/ui/ChartFrame';
import { MetricCard, type MetricTrend, type TrendGood } from '@/components/ui/MetricCard';
import { DetailsTable, PALETTE, StackedBarChart, TrendLineChart } from '@/components/ui/charts';
import { DonutChart } from '@/components/ui/DonutChart';
import { AgentRoiTile } from '@/pages/executive/AgentRoiTile';
import { MoneyBand } from '@/pages/executive/MoneyBand';
import { ClientNpsCard } from '@/pages/executive/ClientNpsCard';
import { WhatIfClientCard } from '@/pages/executive/WhatIfClientCard';
import { rateWhatIfAnnualMargin } from '@/lib/execWhatIf';

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
  /** Overtime plus double time, as the paycheck splits the hours (the server's labor-rules engine). */
  otHours: number;
  /** What the multipliers add, in straight-time hours (absent from an older API). */
  premiumHours?: number;
  headsWorked: number;
  estBilled: number;
  estLaborCost: number;
  estMargin: number;
}
interface ExecSummary {
  generatedAt: string;
  /** The week in a few sentences — the same words the digest and board pack carry. */
  narrative: string[];
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
    /** By days past due — the one aging definition the finance home and Books use. */
    aging: { current: number; days1to30: number; days31to60: number; days61to90: number; over90: number };
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

interface ExecBatons {
  generatedAt: string;
  batons: {
    fieldglass: { closeOuts: number; transfers: number; adds: number };
    readyToSchedule: number;
    unapprovedTimesheets: number;
    payrollCasesOpen: number;
    incidentsOpen: number;
  };
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
    claimedBy: { id: string; name: string; photoUrl: string | null } | null;
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

// Intl directly — toLocale* is lint-banned in favor of the shared fmt*
// helpers, but these headers need shapes fmt* doesn't offer.
const LONG_DAY_FMT = new Intl.DateTimeFormat('en-US', {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
});
const CLOCK_FMT = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
const SHORT_WEEKDAY_UTC_FMT = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  timeZone: 'UTC',
});

const ATTENDANCE_LABEL: Record<string, string> = {
  LATE: 'Late arrivals',
  EARLY_OUT: 'Left early',
  CALL_OUT: 'Call-outs',
  NO_CALL_NO_SHOW: 'No-call no-shows',
};

const fmtHours = (n: number) => `${n.toLocaleString('en-US', { maximumFractionDigits: 1 })}h`;

/** WoW delta chip — green up / red down, with margin semantics. */
function Delta({ now, prev, money, upIsBad = false }: { now: number; prev: number; money?: boolean; upIsBad?: boolean }) {
  if (!Number.isFinite(prev) || prev === 0) return null;
  const pct = ((now - prev) / Math.abs(prev)) * 100;
  if (Math.abs(pct) < 0.05) return null;
  const up = pct > 0;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  const good = up !== upIsBad;
  return (
    <span
      className={`inline-flex items-center gap-0.5 text-xs font-medium tabular-nums ${good ? 'text-success' : 'text-alert'}`}
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
/**
 * The chairman's window into the floor: last-4-weeks SOP compliance per
 * store/department plus the live count — "are they doing the work" at a
 * glance, with the full board one click away.
 */
function OpsPulseCard() {
  const term = useTerm();
  const dataQuery = useQuery({
    queryKey: ['OpsPulseCard', 'data'],
    queryFn: () => getOpsScorecard(4),
  });
  const data: Awaited<ReturnType<typeof getOpsScorecard>> | null = dataQuery.data ?? null;
  const failed = dataQuery.isError;
  const live2Query = useQuery({
    queryKey: ['OpsPulseCard', 'live'],
    queryFn: () => getOpsBoard(),
  });
  const live: number | null = live2Query.data ? live2Query.data.active.length : null;
  // Quiet until the ops module has real runs — no empty ceremony.
  if (failed || !data || data.totals.shifts === 0) return null;
  const worst = [...data.rows]
    .filter((r) => r.sopPct != null)
    .sort((a, b) => (a.sopPct ?? 0) - (b.sopPct ?? 0))[0];
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{term('site')} operations — last 4 weeks</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2 tabular-nums">
          <div>
            <div className="text-2xl font-semibold text-white">{data.totals.shifts}</div>
            <div className="text-2xs uppercase tracking-wider text-silver/60">
              SOP shifts run
            </div>
          </div>
          <div>
            <div
              className={cn(
                'text-2xl font-semibold',
                data.totals.tempOutOfRange === 0 ? 'text-success' : 'text-alert',
              )}
            >
              {data.totals.tempOutOfRange}
            </div>
            <div className="text-2xs uppercase tracking-wider text-silver/60">
              temps out of range ({data.totals.tempChecks} checks)
            </div>
          </div>
          {live != null && (
            <div>
              <div className="text-2xl font-semibold text-gold">{live}</div>
              <div className="text-2xs uppercase tracking-wider text-silver/60">
                running right now
              </div>
            </div>
          )}
        </div>
        {worst && worst.sopPct != null && worst.sopPct < 90 && (
          <p className="mt-3 text-xs text-warning">
            Weakest standard: {worst.clientName} · {worst.department} at {worst.sopPct}% SOP
            compliance.
          </p>
        )}
        <Link
          to="/ops?tab=board"
          className="mt-3 inline-flex items-center gap-1 text-xs text-gold hover:underline"
        >
          Open the ops board →
        </Link>
      </CardContent>
    </Card>
  );
}

function DecisionQueueCard({
  decisions,
  onChanged,
  headless = false,
}: {
  decisions: ExecBriefing['decisions'];
  onChanged: () => void;
  /** The home's template titles the section ("Needs you"); the card keeps only its count. */
  headless?: boolean;
}) {
  const { t } = useI18n();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [roomKey, setRoomKey] = useState<string | null>(null);
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
      {(!headless || open.length > 0) && (
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            {!headless && <CardTitle className="text-base">{t('execHome.needsYourDecision')}</CardTitle>}
            {open.length > 0 && (
              <span className="ml-auto text-2xs tabular-nums text-silver/70">
                {open.length} open{delegated.length > 0 ? ` · ${delegated.length} with your team` : ''}
              </span>
            )}
          </div>
        </CardHeader>
      )}
      <CardContent>
        {open.length === 0 && delegated.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-silver">
            <span className="h-2 w-2 shrink-0 rounded-full bg-success" aria-hidden="true" />
            {'Nothing needs you.'}
          </p>
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
                  {/* Label opens the item's room — thread + timeline. */}
                  <button
                    type="button"
                    onClick={() => setRoomKey(d.key)}
                    className="group block w-full text-left"
                  >
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
                    {d.claimedBy && (
                      <div className="mt-1 flex items-center gap-1.5 text-2xs text-silver">
                        <Avatar
                          src={d.claimedBy.photoUrl}
                          name={d.claimedBy.name}
                          size="xs"
                        />
                        <span className="text-white">{d.claimedBy.name}</span> is on it
                      </div>
                    )}
                  </button>
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
            <DecisionRoom itemKey={roomKey} onClose={() => setRoomKey(null)} />
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
  const { t } = useI18n();
  const [bill, setBill] = useState(rates.billRate);
  const [pay, setPay] = useState(rates.payRate);
  const recent = trend.slice(-4);
  const weeklyHours =
    recent.length > 0 ? recent.reduce((n, w) => n + w.workedHours, 0) / recent.length : 0;
  const weeklyOt =
    recent.length > 0 ? recent.reduce((n, w) => n + w.otHours, 0) / recent.length : 0;
  // Overtime priced as the server's engine priced it (lib/execWhatIf).
  const annualMargin = (b: number, p: number) => rateWhatIfAnnualMargin(recent, b, p, rates);
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
        <CardTitle className="text-base">{t('execHome.rateModel')}</CardTitle>
        <p className="text-xs text-silver">
          What-if on your real volume — {weeklyHours.toFixed(0)}h/week average over the
          last four weeks ({weeklyOt.toFixed(1)}h OT), burden {rates.burdenPct}%.
        </p>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-end gap-4">
          <label className="text-xs text-silver">
            Bill rate ($/h)
            <Input
              type="number"
              step="0.25"
              min="0"
              size="sm"
              value={bill}
              onChange={(e) => setBill(num(e.target.value, rates.billRate))}
              className="mt-1 w-28 tabular-nums"
            />
          </label>
          <label className="text-xs text-silver">
            Pay rate ($/h)
            <Input
              type="number"
              step="0.25"
              min="0"
              size="sm"
              value={pay}
              onChange={(e) => setPay(num(e.target.value, rates.payRate))}
              className="mt-1 w-28 tabular-nums"
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

/** One KPI on the chairman's band: the kit tile, a link when it has a home. */
function Tile({
  label,
  value,
  sub,
  to,
  trend,
  good,
}: {
  label: string;
  value: string;
  sub?: string;
  to?: string;
  /** Eight weeks behind the figure, when the summary has them. */
  trend?: MetricTrend;
  good?: TrendGood;
}) {
  return (
    <MetricCard
      label={label}
      value={value}
      hint={sub}
      trend={trend}
      trendGood={good}
      className="h-full"
      cta={false}
      wrap={to ? (card) => <Link to={to} className="block h-full rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright">{card}</Link> : undefined}
    />
  );
}

/** "Oct 12" for a week starting on that day (the API sends ISO dates). */
function weekOf(start: string): string {
  // A calendar date: read it as that day in UTC so no zone shifts it.
  return fmtDateTz(`${start.slice(0, 10)}T00:00:00Z`, 'UTC');
}

function withLabel(t: MetricTrend | undefined, deltaLabel: string): MetricTrend | undefined {
  return t ? { ...t, deltaLabel } : undefined;
}

/** "Estimated margin went from $4.1k to $5.3k over 8 weeks; the high was $5.6k." */
function trendSentence(rows: Array<Record<string, unknown>>, key: string, name: string): string {
  const vals = rows.map((r) => Number(r[key])).filter((n) => Number.isFinite(n));
  if (vals.length < 2) return `${name}: not enough weeks yet.`;
  return `${name} went from ${fmtMoneyCompact(vals[0]!)} to ${fmtMoneyCompact(vals[vals.length - 1]!)} over ${vals.length} weeks; the high was ${fmtMoneyCompact(Math.max(...vals))}.`;
}

/** A weekly series off the summary's trend as a tile trend (last − prior week). */
function weekTrend(weeks: ExecWeek[], pick: (w: ExecWeek) => number, format: (n: number) => string): MetricTrend | undefined {
  if (weeks.length < 2) return undefined;
  const series = weeks.map(pick);
  return { series, delta: Math.round((series[series.length - 1]! - series[series.length - 2]!) * 10) / 10, deltaLabel: 'vs prior wk', format };
}

interface PortalEngagement {
  accounts: Array<{
    id: string;
    email: string;
    status: string;
    scope: string;
    clientId: string | null;
    lastSeenAt: string | null;
    signIns7d: number;
    downloads: Array<{ at: string; from: string; to: string }>;
  }>;
  totals: { accounts: number; active7d: number; neverSignedIn: number; downloads7d: number };
}


export function ExecutiveDashboard() {
  const { t } = useI18n();
  // Brief 2-1b: a direct employer bills no one. The margin story, the
  // client league, receivables, the portal and the J-1 cliff are the
  // staffing company's cards; a hotel's chairman leads with labor cost.
  const { moduleOn } = useTenant();
  const billRates = moduleOn('billRates');
  const clientPortal = moduleOn('clientPortal');
  const programs = moduleOn('programs');
  const term = useTerm();
  const greet = useGreeting();
  const { user } = useAuth();
  const [packBusy, setPackBusy] = useState(false);

  // The summary is the page; every other tile is optional and renders
  // empty when its read fails.
  const summaryQuery = useQuery({
    queryKey: ['ExecutiveDashboard', 'summary'],
    queryFn: () => apiFetch<ExecSummary>('/executive/summary'),
  });
  // Keep the live floor tile honest without a manual refresh.
  const floorQuery = useQuery({
    queryKey: ['ExecutiveDashboard', 'floor'],
    queryFn: () => floorNow(),
    refetchInterval: 120_000,
  });
  const otQuery = useQuery({
    queryKey: ['ExecutiveDashboard', 'ot'],
    queryFn: () => otOutlook(),
  });
  const recvQuery = useQuery({
    queryKey: ['ExecutiveDashboard', 'receivables'],
    queryFn: () => apiFetch<Receivables>('/executive/receivables'),
    enabled: billRates && clientPortal,
  });
  const targetsQuery = useQuery({
    queryKey: ['ExecutiveDashboard', 'targets'],
    queryFn: () => apiFetch<TargetsResponse>('/executive/targets'),
  });
  const prospectsQuery = useQuery({
    queryKey: ['ExecutiveDashboard', 'prospects'],
    queryFn: () => apiFetch<ProspectsResponse>('/executive/prospects'),
    enabled: clientPortal,
  });
  const briefQuery = useQuery({
    queryKey: ['ExecutiveDashboard', 'briefing'],
    queryFn: () => apiFetch<ExecBriefing>('/executive/briefing'),
  });
  const batonsQuery = useQuery({
    queryKey: ['ExecutiveDashboard', 'batons'],
    queryFn: () => apiFetch<ExecBatons>('/executive/batons'),
  });
  const engagementQuery = useQuery({
    queryKey: ['ExecutiveDashboard', 'portal-engagement'],
    queryFn: () => apiFetch<PortalEngagement>('/executive/portal-engagement'),
    enabled: clientPortal,
  });
  const summary = summaryQuery.data ?? null;
  const floor = floorQuery.data ?? null;
  const ot = otQuery.data ?? null;
  const recv = recvQuery.data ?? null;
  const targets = targetsQuery.data ?? null;
  const prospects = prospectsQuery.data ?? null;
  const brief = briefQuery.data ?? null;
  const batons = batonsQuery.data ?? null;
  const engagement = engagementQuery.data ?? null;
  const error = summaryQuery.error
    ? summaryQuery.error instanceof ApiError
      ? summaryQuery.error.message
      : 'Could not load the executive summary.'
    : null;
  const load = () => {
    void summaryQuery.refetch();
    void floorQuery.refetch();
    void otQuery.refetch();
    void recvQuery.refetch();
    void targetsQuery.refetch();
    void prospectsQuery.refetch();
    void briefQuery.refetch();
    void batonsQuery.refetch();
    void engagementQuery.refetch();
  };

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
        week: weekOf(w.start),
        billed: w.estBilled,
        margin: w.estMargin,
        laborCost: w.estLaborCost,
        hours: Math.round(w.workedHours * 10) / 10,
        ot: Math.round(w.otHours * 10) / 10,
        regular: Math.round((w.workedHours - w.otHours) * 10) / 10,
      })),
    [summary],
  );
  const composition = useMemo(() => {
    if (!summary) return [];
    return [
      { name: 'Active', value: summary.workforce.active, color: PALETTE.primary },
      { name: 'Onboarding', value: summary.workforce.onboardingInFlight, color: PALETTE.secondary },
      { name: 'Paused', value: summary.workforce.deactivated, color: PALETTE.other },
    ].filter((s) => s.value > 0);
  }, [summary]);

  const onFloor = floor ? floor.rows.reduce((n, r) => n + r.clockedIn, 0) : null;
  const expected = floor ? floor.rows.reduce((n, r) => n + (r.expected ?? 0), 0) : null;
  const otRisk = ot ? ot.rows.filter((r) => r.projectedOtMinutes > 0) : null;
  // The one number (§4.1), with its eight-week arc behind it: the margin
  // story when the tenant bills clients; the labor-cost story otherwise.
  const workersLc = term('workers').toLowerCase();
  const hoursSummary =
    trendData.length > 0
      ? `Hours over ${trendData.length} weeks: ${fmtHours(trendData[0]!.hours)} to ${fmtHours(trendData[trendData.length - 1]!.hours)}, overtime ${fmtHours(trendData[trendData.length - 1]!.ot)} last week.`
      : 'No hours yet.';
  const heroSummary = trendSentence(trendData, billRates ? 'margin' : 'laborCost', billRates ? 'Estimated margin' : 'Labor cost');
  const heroCard = summary ? (
    <Card className="overflow-hidden">
      <CardContent>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="text-xs uppercase tracking-wider text-silver/70">
              {billRates ? 'Estimated margin — last week' : 'Labor cost — last week'}
            </div>
            <div className="mt-1 flex items-baseline gap-3">
              <span className="text-4xl font-semibold tabular-nums text-white">
                {fmtMoney(billRates ? summary.lastWeek.estMargin : summary.lastWeek.estLaborCost)}
              </span>
              {prevWeek &&
                (billRates ? (
                  <Delta now={summary.lastWeek.estMargin} prev={prevWeek.estMargin} money />
                ) : (
                  <Delta now={summary.lastWeek.estLaborCost} prev={prevWeek.estLaborCost} money upIsBad />
                ))}
            </div>
            <div className="mt-1 text-sm text-silver">
              {billRates && <>on {fmtMoney(summary.lastWeek.estBilled)} billed · </>}
              {summary.lastWeek.workedHours.toFixed(1)}h worked by {summary.lastWeek.headsWorked} {workersLc}
              {!billRates && <> · {summary.lastWeek.otHours.toFixed(1)}h overtime</>}
            </div>
          </div>
          <Link to="/labor-costs" className="text-xs text-gold hover:text-gold-bright">
            {billRates ? 'Open the live margin board' : 'Open the labor board'}
          </Link>
        </div>
        <div className="mt-4" role="img" aria-label={heroSummary}>
          <TrendLineChart
            data={trendData}
            x="week"
            height={196}
            format={(v) => fmtMoneyCompact(v)}
            yLabel="Dollars per week"
            heading={(l) => `Week of ${l}`}
            series={
              billRates
                ? [
                    { key: 'billed', name: 'Est. billed', area: true },
                    { key: 'margin', name: 'Est. margin' },
                  ]
                : [{ key: 'laborCost', name: 'Labor cost, fully loaded', area: true }]
            }
          />
        </div>
        <DetailsTable
          label="Details"
          columns={billRates ? ['Week of', 'Est. billed', 'Est. margin', 'Labor cost'] : ['Week of', 'Labor cost']}
          rows={trendData.map((w) => (billRates ? [w.week, fmtMoney(w.billed), fmtMoney(w.margin), fmtMoney(w.laborCost)] : [w.week, fmtMoney(w.laborCost)]))}
        />
      </CardContent>
    </Card>
  ) : null;
  const openDecisions = brief ? brief.decisions.filter((d) => d.status === 'open').length : 0;
  const maxPlaced = summary
    ? Math.max(1, ...summary.clients.map((c) => c.activeAssociates))
    : 1;

  return (
    // Design system §4.1 (UX upgrade step 6, the sweep): the Home template.
    // The margin is the hero, the chairman's queue the decisions, the
    // narrative what changed; the board pack is the one action.
    <HomeTemplate
      title={
        <>
          <LiveNow render={(now) => greet(now.getHours())} />
          {greetingName(user, '') && <>, <span className="text-accent">{greetingName(user, '')}</span></>}.
        </>
      }
      topbarTitle="Home"
      subtitle={t('execHome.subtitle')}
      meta={
        <span className="flex items-center gap-2 text-xs2 uppercase tracking-[0.18em] text-ink-muted">
          <LiveNow render={(now) => <>{LONG_DAY_FMT.format(now)} · {CLOCK_FMT.format(now)}</>} />
        </span>
      }
      actions={
        <Button onClick={() => void downloadBoardPack()} loading={packBusy} disabled={packBusy}>
          <Download className="mr-2 h-4 w-4" />
          {t('execHome.boardPack')}
        </Button>
      }
      banners={
        error ? (
          <ErrorBanner
            action={
              <Button size="sm" variant="secondary" onClick={load}>
                Retry
              </Button>
            }
          >
            {error}
          </ErrorBanner>
        ) : undefined
      }
      // Decisions first (Principle 1: the person sees decisions), then the
      // one number, then the long tail of cards.
      hero={
        <section aria-labelledby="exec-needs-you" className="space-y-3">
          <SectionTitle
            id="exec-needs-you"
            title={
              <>
                {t('home.needsYou')}
                {openDecisions > 0 && (
                  <span className="ml-2 inline-flex min-w-6 items-center justify-center rounded-full bg-accent-fill px-1.5 text-xs font-semibold tabular-nums text-accent-on">
                    {openDecisions}
                  </span>
                )}
              </>
            }
          />
          {brief ? (
            <DecisionQueueCard decisions={brief.decisions} onChanged={load} headless />
          ) : briefQuery.isError ? (
            <EmptyState title={t('execHome.queueNotLoaded')} description={t('execHome.queueNotLoadedBody')} className="py-6" />
          ) : (
            <Skeleton className="h-24" />
          )}
        </section>
      }
      changes={
        summary && summary.narrative.length > 0
          ? {
              title: 'The week in brief',
              content: <p className="max-w-prose text-sm leading-relaxed text-ink">{summary.narrative.join(' ')}</p>,
            }
          : undefined
      }
      assistant={<HugoSeat />}
    >
      {heroCard ??
        (error ? (
          <EmptyState
            icon={TrendingUp}
            title={billRates ? t('execHome.estimatedMargin') : t('execHome.laborCost')}
            description={t('execHome.summaryNotLoaded')}
            className="py-6"
          />
        ) : (
          <Skeleton className="h-[260px]" />
        ))}

      {!summary && !error && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-[96px]" />
          ))}
        </div>
      )}

      {/* Batons in flight — the handoff spine's health. Every number is
          work sitting between two departments; a deep one names the
          building it's stuck in. */}
      {batons && (
        <Card>
          <CardContent>
            <SectionTitle
              title={t('execHome.batons')}
              trailing={<span className="text-2xs text-ink-muted">{t('execHome.batonsHint')}</span>}
            />
            <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-7">
              {(
                [
                  [
                    batons.batons.fieldglass.closeOuts,
                    'Fieldglass close-outs',
                    '/people',
                    'alert',
                  ],
                  [
                    batons.batons.fieldglass.transfers,
                    'Fieldglass transfers',
                    '/people',
                    'warning',
                  ],
                  [batons.batons.fieldglass.adds, 'Fieldglass adds', '/people', 'warning'],
                  [
                    batons.batons.readyToSchedule,
                    'Ready to schedule',
                    '/scheduling',
                    'warning',
                  ],
                  [
                    batons.batons.unapprovedTimesheets,
                    'Timesheets unapproved',
                    '/time-attendance',
                    'warning',
                  ],
                  [
                    batons.batons.payrollCasesOpen,
                    'Payroll cases open',
                    '/hr-cases',
                    'warning',
                  ],
                  [
                    batons.batons.incidentsOpen,
                    'Incidents open',
                    '/compliance/osha',
                    'alert',
                  ],
                ] as const
              ).map(([value, label, to, tone]) => (
                <Link key={label} to={to} className="group min-w-0">
                  <div
                    className={cn(
                      'text-2xl font-semibold tabular-nums transition-colors',
                      value === 0
                        ? 'text-success'
                        : tone === 'alert'
                          ? 'text-alert'
                          : 'text-warning',
                    )}
                  >
                    {value}
                  </div>
                  <div className="mt-0.5 truncate text-2xs text-silver/70 group-hover:text-silver">
                    {label}
                  </div>
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* The 6:45am read — today's exposure + the chairman's queue. */}
      {brief && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card className={brief.today.shiftsOpen > 0 ? 'border-warning/40' : undefined}>
            <CardHeader className="pb-2">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <CardTitle className="text-base">{t('execHome.today')}</CardTitle>
                  <p className="text-2xs text-silver/70">
                    {LONG_DAY_FMT.format(new Date())}
                  </p>
                </div>
                {billRates && (
                  <div className="text-right">
                    <div className="text-xl font-semibold tabular-nums text-white">
                      {fmtMoney(brief.today.estBilledToday)}
                    </div>
                    <div className="text-2xs text-silver/70">{t('execHome.estBilledToday')}</div>
                  </div>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {/* Coverage gauge. */}
              {brief.today.shiftsTotal === 0 ? (
                <EmptyState
                  title={t('execHome.noShiftsToday')}
                  description={t('execHome.noShiftsTodayBody')}
                  action={
                    <Link to="/scheduling" className="text-xs text-gold hover:text-gold-bright">
                      {t('execHome.openScheduling')}
                    </Link>
                  }
                  className="py-6"
                />
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
                                : CLOCK_FMT.format(start)}
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
                      const weekday = SHORT_WEEKDAY_UTC_FMT.format(
                        new Date(`${d.dateKey}T12:00:00Z`),
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
                          {inc.clientName ? ` · ${inc.clientName}` : ''}
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

          <OpsPulseCard />
        </div>
      )}

      {summary && (
        <>
          {/* KPI band with week-over-week direction. */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Tile
              label={`Active ${workersLc}`}
              value={String(summary.workforce.active)}
              sub={`${summary.workforce.deactivated} paused · ${summary.workforce.onboardingInFlight} onboarding`}
              to="/people"
              trend={withLabel(weekTrend(summary.trend, (w) => w.headsWorked, (n) => String(n)), 'worked vs prior wk')}
            />
            <Tile
              label={t('execHome.hiresSeparations')}
              value={`${summary.workforce.hires30d} / ${summary.workforce.separations30d}`}
              to="/headcount"
            />
            <Tile
              label={t('execHome.onFloorNow')}
              value={onFloor === null ? '—' : String(onFloor)}
              sub={expected ? `expected ${expected}` : undefined}
              to="/labor-costs"
            />
            <Tile
              label={t('execHome.otRisk')}
              value={otRisk === null ? '—' : String(otRisk.length)}
              sub={
                otRisk && otRisk.length > 0
                  ? `${(otRisk.reduce((n, r) => n + r.projectedOtMinutes, 0) / 60).toFixed(1)}h projected`
                  : 'no one projected past 40h'
              }
              to="/labor-costs"
            />
            <Tile
              label={t('execHome.hoursLastWeek')}
              value={`${summary.lastWeek.workedHours.toFixed(1)}h`}
              sub={`${summary.lastWeek.otHours.toFixed(1)}h OT`}
              to="/analytics"
              trend={weekTrend(summary.trend, (w) => w.workedHours, fmtHours)}
            />
            {billRates && (
              <Tile
                label={t('execHome.estBilledLastWeek')}
                value={fmtMoney(summary.lastWeek.estBilled)}
                sub="at standard SOW rates"
                to="/clients"
                trend={weekTrend(summary.trend, (w) => w.estBilled, (n) => fmtMoneyCompact(n))}
              />
            )}
            <Tile
              label={t('execHome.laborCostLastWeek')}
              value={fmtMoney(summary.lastWeek.estLaborCost)}
              sub="fully loaded"
              to="/labor-costs"
              trend={weekTrend(summary.trend, (w) => w.estLaborCost, (n) => fmtMoneyCompact(n))}
              good={billRates ? 'neutral' : 'down'}
            />
            <Tile
              label={t('execHome.thisWeekSoFar')}
              value={`${summary.thisWeek.workedHours.toFixed(1)}h`}
              sub={billRates ? `est. billed ${fmtMoney(summary.thisWeek.estBilled)}` : `${fmtMoney(summary.thisWeek.estLaborCost)} labor so far`}
              to="/labor-costs"
            />
            {billRates && clientPortal && (
              <Tile
                label={t('execHome.receivablesOutstanding')}
                value={recv ? fmtMoney(recv.totals.outstandingAmount) : '—'}
                sub={
                  recv
                    ? `${recv.totals.outstandingCount} statement${recv.totals.outstandingCount === 1 ? '' : 's'}${recv.totals.avgDaysToPay !== null ? ` · pays in ~${recv.totals.avgDaysToPay}d` : ''}`
                    : undefined
                }
                to="/clients/statements"
              />
            )}
            <Tile
              label={t('execHome.turnoverCost')}
              value={fmtMoney(summary.turnover.estCost90d)}
              sub={`${summary.turnover.separations90d} separations × ${fmtMoney(summary.turnover.costPerSeparation)}`}
              to="/analytics"
            />
            {/* What the agents gave back, beside the money (2026-10-17). */}
            <AgentRoiTile />
          </div>

          {/* Real money from the books, the forecast and payroll (finance walk 17). */}
          <MoneyBand />

          {/* Targets vs actuals + receivables aging. */}
          <div id="targets" className="grid scroll-mt-20 grid-cols-1 gap-4 lg:grid-cols-2">
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
                    {billRates && targets.targets.revenueTarget !== null && (
                      <TargetBar
                        label="Revenue"
                        actual={targets.actuals.revenueQtd}
                        target={targets.targets.revenueTarget}
                        pacePct={targets.elapsedPct}
                        fmt={fmtMoney}
                      />
                    )}
                    {billRates && targets.targets.marginTarget !== null && (
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

            {billRates && clientPortal && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">{t('execHome.receivablesAging')}</CardTitle>
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
                    <div className="mb-3 grid grid-cols-3 gap-2 text-center sm:grid-cols-5">
                      {(
                        [
                          ['Not yet due', recv.totals.aging.current, 'text-white'],
                          ['1–30 days', recv.totals.aging.days1to30, 'text-white'],
                          ['31–60 days', recv.totals.aging.days31to60, 'text-warning'],
                          ['61–90 days', recv.totals.aging.days61to90, 'text-alert'],
                          ['Over 90', recv.totals.aging.over90, 'text-alert'],
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
                        <li key={s.id} className="py-1.5 text-sm">
                          <Link
                            to={`/clients/statements?statement=${s.id}`}
                            className="flex items-center justify-between gap-2 hover:text-gold"
                          >
                            <span className="min-w-0 truncate text-white">
                              {s.clientName} #{s.number ?? '—'}
                            </span>
                            <span
                              className={`tabular-nums ${s.ageDays > 30 ? 'text-alert' : 'text-silver'}`}
                            >
                              {fmtMoney(s.amount)} · {s.ageDays > 0 ? `${s.ageDays}d late` : 'not yet due'}
                            </span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </CardContent>
            </Card>
            )}
          </div>

          {/* Site league (margin per site) + client concentration & pipeline:
              the staffing company's cards. */}
          {(billRates || clientPortal) && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {billRates && (
            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">{term('site')} league — last 4 weeks</CardTitle>
                  <Link to="/labor-costs" className="text-xs text-gold hover:text-gold-bright">
                    Labor board
                  </Link>
                </div>
              </CardHeader>
              <CardContent>
                {summary.league.length === 0 ? (
                  <EmptyState
                    title="No worked time in the window"
                    description="Approved hours over the last four weeks rank every site here."
                    action={
                      <Link to="/labor-costs" className="text-xs text-gold hover:text-gold-bright">
                        Open the labor board
                      </Link>
                    }
                    className="py-6"
                  />
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
            )}

            {clientPortal && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">{t('execHome.concentration')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  {summary.concentration.slice(0, 4).map((c) => (
                    <div key={c.clientId} className="mb-2">
                      <div className="flex items-center justify-between text-sm">
                        <Link
                          to={`/clients/${c.clientId}`}
                          className="min-w-0 truncate text-white hover:text-gold"
                        >
                          {c.clientName}
                        </Link>
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
                          <li key={p.id} className="py-1.5 text-sm">
                            {/* Prospects live in the Clients page's pipeline
                                section — no per-prospect page exists. */}
                            <Link
                              to="/clients"
                              className="flex items-center justify-between gap-2 hover:text-gold"
                            >
                              <span className="min-w-0 truncate text-white">{p.name}</span>
                              <span className="tabular-nums text-silver">
                                {p.stage.toLowerCase()}
                                {p.estWeeklyHours && p.estBillRate
                                  ? ` · ~${fmtMoney(p.estWeeklyHours * p.estBillRate)}/wk`
                                  : ''}
                              </span>
                            </Link>
                          </li>
                        ))}
                    </ul>
                  )}
                </div>
              </CardContent>
            </Card>
            )}
          </div>
          )}

          {/* Client NPS: the quarter's one question, lowest clients first (2026-10-17). */}
          {clientPortal && <ClientNpsCard />}

          {/* Portal engagement: are the client's site managers using it. */}
          {clientPortal && engagement && engagement.accounts.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <CardTitle className="text-base">{t('execHome.portalEngagement')}</CardTitle>
                  <span className="text-xs tabular-nums text-silver">
                    {engagement.totals.active7d} of {engagement.totals.accounts} in this week · {engagement.totals.downloads7d} report
                    {engagement.totals.downloads7d === 1 ? '' : 's'} pulled
                    {engagement.totals.neverSignedIn > 0 ? ` · ${engagement.totals.neverSignedIn} never signed in` : ''}
                  </span>
                </div>
                <p className="text-xs text-silver">
                  Who on the client side is using their site — last seen, sign-ins this week, and the reports they pulled. A Monday digest carries the same.
                </p>
              </CardHeader>
              <CardContent>
                <ul className="divide-y divide-navy-secondary/60">
                  {engagement.accounts.map((a) => {
                    const latest = a.downloads[0];
                    return (
                      <li key={a.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2 text-sm">
                        <div className="min-w-0 flex-1">
                          {a.clientId ? (
                            <Link to={`/clients/${a.clientId}?section=portal`} className="truncate text-white underline-offset-2 hover:underline">
                              {a.scope}
                            </Link>
                          ) : (
                            <div className="truncate text-white">{a.scope}</div>
                          )}
                          <div className="truncate text-xs text-silver/70">{a.email}</div>
                        </div>
                        <span className={cn('text-xs tabular-nums', a.lastSeenAt ? 'text-silver' : 'text-warning')}>
                          {a.lastSeenAt ? `seen ${fmtRelativeDate(a.lastSeenAt)}` : a.status === 'INVITED' ? 'invited, not in yet' : 'never signed in'}
                        </span>
                        <span className="text-xs tabular-nums text-silver">
                          {a.signIns7d} sign-in{a.signIns7d === 1 ? '' : 's'} · 7d
                        </span>
                        <span className="text-xs tabular-nums text-silver">
                          {latest
                            ? `report ${latest.from === latest.to ? fmtDate(latest.from) : `${fmtDate(latest.from)} – ${fmtDate(latest.to)}`} · ${fmtRelativeDate(latest.at)}`
                            : 'no reports pulled'}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </CardContent>
            </Card>
          )}

          {/* Client health + capacity & the J-1 cliff. */}
          {brief && (clientPortal || programs) && (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {clientPortal && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">{t('execHome.clientHealth')}</CardTitle>
                  <p className="text-xs text-silver">
                    Fill trend, reliability, and payment behavior over the last 4 weeks —
                    the renewal-risk radar.
                  </p>
                </CardHeader>
                <CardContent>
                  {brief.clientHealth.length === 0 ? (
                    <EmptyState
                      title="No client activity in the window"
                      description="Filled shifts, reliability and payments over four weeks score each client here."
                      action={
                        <Link to="/clients" className="text-xs text-gold hover:text-gold-bright">
                          Open clients
                        </Link>
                      }
                      className="py-6"
                    />
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
              )}

              {programs && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">{t('execHome.capacityJ1')}</CardTitle>
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
                      <div className="text-2xs text-silver/70">J-1 {workersLc}</div>
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
              )}
            </div>
          )}

          {/* People worth knowing this week. */}
          {brief &&
            (brief.people.topPerformers.length > 0 ||
              brief.people.anniversaries.length > 0) && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">{t('execHome.peopleToKnow')}</CardTitle>
                </CardHeader>
                <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <div className="mb-2 text-xs uppercase tracking-wider text-silver/70">
                      Hardest workers — last 4 weeks, clean record
                    </div>
                    {brief.people.topPerformers.length === 0 ? (
                      <EmptyState
                        title="No qualifying hours yet"
                        description="Four clean weeks of approved hours put someone on this list."
                        className="py-6"
                      />
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

          {/* What-if rate model on real hours — only where there is a bill rate. */}
          {billRates && <RateCalculator rates={summary.rates} trend={summary.trend} />}
          {/* And the portfolio question: lose this client, win that one (2026-10-17). */}
          {billRates && clientPortal && <WhatIfClientCard league={summary.league} clients={summary.clients} rates={summary.rates} />}

          {/* Infographics row: hours composition + workforce donut. */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <ChartFrame
                title={t('execHome.hoursOvertime')}
                summary={hoursSummary}
                columns={[
                  { key: 'week', label: 'Week of' },
                  { key: 'regular', label: 'Regular hours', numeric: true, format: (v) => fmtHours(Number(v)) },
                  { key: 'ot', label: 'Overtime', numeric: true, format: (v) => fmtHours(Number(v)) },
                  { key: 'hours', label: 'Total', numeric: true, format: (v) => fmtHours(Number(v)) },
                ]}
                rows={trendData}
                csvName="hours-and-overtime"
                height={232}
              >
                <StackedBarChart
                  data={trendData}
                  x="week"
                  format={(v) => `${Math.round(v).toLocaleString()}h`}
                  yLabel="Hours"
                  heading={(l) => `Week of ${l}`}
                  series={[
                    { key: 'regular', name: 'Regular', color: PALETTE.secondary },
                    { key: 'ot', name: 'Overtime', color: PALETTE.primary },
                  ]}
                />
              </ChartFrame>
            </div>

            <ChartFrame
              title={t('execHome.workforceComposition')}
              summary={composition.map((c) => `${c.value} ${c.name.toLowerCase()}`).join(', ') || 'Nobody on the roster yet.'}
              columns={[
                { key: 'name', label: 'Status' },
                { key: 'value', label: 'People', numeric: true },
              ]}
              rows={composition}
              csvName="workforce-composition"
              height={232}
            >
              <DonutChart data={composition} size={150} centerSublabel="people" className="h-full md:flex-col" empty={null} />
            </ChartFrame>
          </div>

          {/* Live floor — per-store coverage bars. */}
          {floor && floor.rows.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">{t('execHome.liveFloor')}</CardTitle>
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
                              {clientPortal ? `${r.clientName} — ${r.locationName}` : r.locationName}
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

          <div className={cn('grid grid-cols-1 gap-4', clientPortal && 'lg:grid-cols-2')}>
            {clientPortal && (
            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">{t('execHome.clientPlacements')}</CardTitle>
                  <Link to="/clients" className="text-xs text-gold hover:text-gold-bright">
                    All clients
                  </Link>
                </div>
              </CardHeader>
              <CardContent>
                {summary.clients.length === 0 ? (
                  <EmptyState
                    title="No open placements on record"
                    description="Placements appear here as people are assigned to a client's sites."
                    action={
                      <Link to="/clients" className="text-xs text-gold hover:text-gold-bright">
                        Open clients
                      </Link>
                    }
                    className="py-6"
                  />
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
            )}

            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">{t('execHome.attendance30')}</CardTitle>
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
                  <CardTitle className="text-base">{t('execHome.otOutlook')}</CardTitle>
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
                      <span className="flex min-w-0 items-center gap-2">
                        <Avatar src={associatePhotoUrl(r.associateId)} name={r.associateName} size="xs" />
                        <span className="truncate text-white">{r.associateName}</span>
                      </span>
                      <span className="tabular-nums text-silver">
                        {(r.projectedOtMinutes / 60).toFixed(1)}h OT projected
                        {billRates && r.estOtBilled !== null ? ` · ${fmtMoney(r.estOtBilled)} billed` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          <p className="text-xs text-silver/70">
            {billRates
              ? 'Dollar figures are estimates at org standard rates; finalized client statements are the invoice-grade record. '
              : 'Dollar figures are estimates at standard rates; payroll is the record. '}
            Weeks run Saturday to Friday, Florida time.
          </p>
        </>
      )}
    </HomeTemplate>
  );
}
