import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Building2,
  CalendarDays,
  ClipboardCheck,
  FileText,
  HardHat,
  Mail,
  MapPin,
  Phone,
  ShieldCheck,
  Users,
} from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useI18n, type MessageKey } from '@/lib/i18n';
import {
  fmtDate,
  fmtHours,
  fmtMoney,
  fmtShiftRangeTz,
  fmtTime,
  parseYmd,
  zonedDayKey,
  zonedMinutesOfDay,
} from '@/lib/format';
import { coverageByHour } from './coverage';
import { cn } from '@/lib/cn';
import { enterStagger } from '@/lib/motion';
import { PageHeader } from '@/components/ui/PageHeader';
import { Card, CardContent } from '@/components/ui/Card';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { downloadStatementFile } from '@/pages/clients/statementsShared';
import { PortalRequests, type RequestPrefill } from './PortalRequests';
import { groupWaves } from './waves';
import {
  CoverageCurve,
  DetailsTable,
  ReliabilityChart,
  RingMeter,
  StatTile,
  WeekFillChart,
} from './portalCharts';

/**
 * The client portal home — the store manager's site.
 *
 * Reads top-down the way a manager reads a morning brief: the hero is
 * the floor RIGHT NOW against the contracted line, drawn hour by hour
 * across today; a KPI strip carries the four numbers they report upward
 * (fill, reliability grade, hours delivered, tomorrow); then the cards,
 * each one question, each with a figure or a chart and a table twin
 * behind "Details". Store accounts see one store; client-wide accounts
 * get a per-store strip and can drill in.
 *
 * Admins with view:executive / manage:org preview any client via
 * ?clientId= (+ optional ?locationId=) — the pitch-demo path.
 */

interface RosterRow {
  shiftId: string;
  associateId: string | null;
  name: string | null;
  position: string;
  isLead: boolean;
  clockInAt: string | null;
  startsAt: string;
  endsAt: string;
  timezone: string;
  locationName: string | null;
  state: 'open' | 'on-floor' | 'done' | 'confirmed' | 'unconfirmed';
}

interface WeekRow {
  start: string;
  end: string;
  filled: number;
  total: number;
  fillPct: number | null;
  showed: number;
  reliabilityPct: number | null;
  noCallNoShows: number;
  callOuts: number;
  lates: number;
  replaced: number;
  current: boolean;
}

interface OpsDay {
  dateKey: string;
  shifts: number;
  open: number;
  sopDone: number;
  sopTotal: number;
  taskDone: number;
  taskTotal: number;
  tempAlerts: number;
  incomplete: number;
  photos: number;
  notes: Array<{ department: string; period: string; summary: string }>;
}

interface PortalOverview {
  client: { id: string; name: string };
  store: { id: string; name: string; timezone: string; address: string | null } | null;
  stores: Array<{
    id: string;
    name: string;
    onFloor: number;
    scheduledNow: number;
    openToday: number;
  }>;
  generatedAt: string;
  now: {
    onFloor: Array<{
      associateId: string;
      name: string;
      position: string | null;
      isLead: boolean;
      clockInAt: string;
    }>;
    scheduledNow: number;
    target: number | null;
    targetLabel: string | null;
  };
  today: { date: string; roster: RosterRow[]; filled: number; open: number };
  week: {
    start: string;
    end: string;
    days: Array<{ date: string; filled: number; open: number }>;
    filled: number;
    open: number;
    fillRatePct: number | null;
    hours: number;
    workedHours: number;
  };
  tomorrow: { confirmed: number; unconfirmed: number; open: number; coverInFlight: number };
  leads: {
    people: Array<{
      name: string;
      phone: string | null;
      email: string;
      title: 'supervisor' | 'floor-lead';
      onFloor: boolean;
      runningOps: boolean;
    }>;
    supportEmail: string | null;
  };
  ops: { yesterday: OpsDay | null; today: OpsDay | null } | null;
  reliability: {
    weeks: WeekRow[];
    grade: 'A' | 'B' | 'C' | 'D' | 'F' | null;
    score: number | null;
  };
  clearance: { total: number; i9Complete: number; checksInFlight: number; flagged: number };
  statements: Array<{
    id: string;
    number: number | null;
    periodStart: string;
    periodEnd: string;
    amount: number | null;
    hours: number | null;
    storeHours: number | null;
    storeAmount: number | null;
    finalizedAt: string | null;
    paidAt: string | null;
    pdfUrl: string;
  }>;
  coverage: {
    weekStart: string;
    noCallNoShows: number;
    callOuts: number;
    lates: number;
    replacementsFound: number;
  };
  safety: { monthIncidents: number; open: number; daysSinceLast: number | null };
  serviceReport: { weekStart: string; url: string };
}

const photoUrl = (associateId: string) => `/api/associates/${associateId}/photo`;

const GRADE_STYLE: Record<NonNullable<PortalOverview['reliability']['grade']>, string> = {
  A: 'text-success',
  B: 'text-success',
  C: 'text-warning',
  D: 'text-alert',
  F: 'text-alert',
};

/** Build the API query string for the caller's scope: admins pass the
 *  preview client (+ store); a client-wide portal account may drill into
 *  one of its own stores. */
function scopeQuery(params: URLSearchParams, isPortal: boolean): string {
  const q = new URLSearchParams();
  const client = params.get('clientId');
  const loc = params.get('locationId');
  if (!isPortal && client) q.set('clientId', client);
  if (loc) q.set('locationId', loc);
  const s = q.toString();
  return s ? `?${s}` : '';
}

export function ClientPortalHome() {
  const { t } = useI18n();
  const { user, can } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const isPortal = user?.role === 'CLIENT_PORTAL';
  const canPreview = can('view:executive') || can('manage:org');
  const previewId = searchParams.get('clientId');
  const qs = scopeQuery(searchParams, isPortal);
  const [prefill, setPrefill] = useState<RequestPrefill | null>(null);

  const enabled = isPortal || (canPreview && !!previewId);
  const query = useQuery({
    queryKey: ['clientPortal', 'overview', isPortal ? 'me' : previewId, qs],
    queryFn: () => apiFetch<PortalOverview>(`/client-portal/overview${qs}`),
    enabled,
    refetchInterval: 60_000,
  });
  const data = query.data;

  const waves = useMemo(() => (data ? groupWaves(data.today.roster) : []), [data]);
  const curve = useMemo(
    () =>
      data
        ? coverageByHour(data.today.roster, data.today.date, data.store?.timezone ?? null)
        : [],
    [data],
  );

  if (!isPortal && !canPreview) {
    return <EmptyState icon={Building2} title={t('portal.noAccess')} description="" />;
  }
  if (!isPortal && !previewId) {
    return (
      <EmptyState icon={Building2} title={t('portal.title')} description={t('portal.pickClient')} />
    );
  }

  if (query.isError) {
    return (
      <div className="mx-auto">
        <PageHeader title={t('portal.title')} subtitle={t('portal.subtitle')} />
        <ErrorBanner
          action={
            <Button size="sm" variant="secondary" onClick={() => void query.refetch()}>
              {t('common.retry')}
            </Button>
          }
        >
          {t('portal.loadFailed')}
        </ErrorBanner>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-1/3" />
        <Skeleton className="h-64" />
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
        <Skeleton className="h-64" />
      </div>
    );
  }

  const onFloor = data.now.onFloor;
  const target = data.now.target;
  const staffed = target !== null ? onFloor.length >= target : onFloor.length > 0;
  const short = target !== null && onFloor.length < target;
  const heroTone = short ? 'warning' : staffed ? 'success' : 'gold';
  const scheduleTo = `/portal/schedule${qs}`;
  const drillTo = (locationId: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (locationId) next.set('locationId', locationId);
    else next.delete('locationId');
    setSearchParams(next, { replace: true });
  };
  const storeTz = data.store?.timezone ?? data.today.roster[0]?.timezone ?? null;
  const todayLocalKey = zonedDayKey(new Date(), storeTz);
  const nowHour =
    todayLocalKey === data.today.date ? Math.floor(zonedMinutesOfDay(new Date(), storeTz) / 60) : null;

  const covParts = [
    part(t, data.coverage.noCallNoShows, 'portal.covNoShowOne', 'portal.covNoShow'),
    part(t, data.coverage.callOuts, 'portal.covCallOutOne', 'portal.covCallOut'),
    part(t, data.coverage.lates, 'portal.covLateOne', 'portal.covLate'),
  ].filter(Boolean) as string[];
  const replaced = part(
    t,
    data.coverage.replacementsFound,
    'portal.covReplacedOne',
    'portal.covReplaced',
  );
  const pastWeeks = data.reliability.weeks.filter((w) => !w.current);
  const lastWeek = pastWeeks[pastWeeks.length - 1];
  const sum = (f: (w: WeekRow) => number) => pastWeeks.reduce((a, w) => a + f(w), 0);
  const fillDelta =
    data.week.fillRatePct !== null && lastWeek && lastWeek.fillPct !== null
      ? data.week.fillRatePct - lastWeek.fillPct
      : null;
  const hoursPct =
    data.week.hours > 0 ? Math.min(100, Math.round((data.week.workedHours / data.week.hours) * 100)) : null;
  const tomorrowTotal = data.tomorrow.confirmed + data.tomorrow.unconfirmed + data.tomorrow.open;
  const opsDay = data.ops?.yesterday ?? data.ops?.today ?? null;
  const opsIsToday = !!data.ops && !data.ops.yesterday && !!data.ops.today;
  const sopPct =
    opsDay && opsDay.sopTotal > 0 ? Math.round((opsDay.sopDone / opsDay.sopTotal) * 100) : null;
  const cl = data.clearance;
  const clearedCount = cl.total - cl.flagged - cl.checksInFlight;
  const clearancePct = cl.total > 0 ? Math.round((clearedCount / cl.total) * 100) : null;
  const clearanceClean =
    cl.total > 0 && cl.flagged === 0 && cl.checksInFlight === 0 && cl.i9Complete === cl.total;
  const clearanceParts = [
    part(t, cl.flagged, 'portal.clFlaggedOne', 'portal.clFlagged'),
    part(t, cl.checksInFlight, 'portal.clInFlightOne', 'portal.clInFlight'),
    part(t, cl.total - cl.i9Complete, 'portal.clI9One', 'portal.clI9'),
  ].filter(Boolean) as string[];
  const weekDays = data.week.days.map((d) => ({ ...d, day: dayInitial(d.date) }));
  const relWeeks = data.reliability.weeks.map((w) => ({
    ...w,
    label: w.current ? t('portal.relNowShort') : fmtDate(parseYmd(w.start)).replace(/,.*$/, ''),
  }));

  return (
    <div className="mx-auto space-y-4">
      <PageHeader
        title={data.store ? data.store.name : data.client.name}
        topbarTitle={t('portal.title')}
        subtitle={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {data.store ? (
              <>
                <span>{data.client.name}</span>
                {data.store.address && (
                  <span className="flex items-center gap-1 text-silver/70">
                    <MapPin className="h-3 w-3" aria-hidden="true" />
                    {data.store.address}
                  </span>
                )}
              </>
            ) : (
              <span>{t('portal.subtitle')}</span>
            )}
            <span className="flex items-center gap-1.5 text-xs text-silver/60">
              <span className="relative flex h-1.5 w-1.5" aria-hidden="true">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60 motion-reduce:hidden" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-success" />
              </span>
              {t('portal.asOf', { time: fmtTime(data.generatedAt) })}
            </span>
          </span>
        }
        secondaryActions={
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void downloadStatementFile(
                data.serviceReport.url,
                `service-report-${data.serviceReport.weekStart}.pdf`,
              )
            }
            title={t('portal.svcReportHint', { week: fmtDate(parseYmd(data.serviceReport.weekStart)) })}
          >
            <FileText className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            {t('portal.svcReport')}
          </Button>
        }
        primaryAction={
          <Button size="sm" asChild>
            <Link to={scheduleTo}>
              <CalendarDays className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              {t('portal.openSchedule')}
            </Link>
          </Button>
        }
      />

      {/* ---- Per-store strip for market managers ------------------------ */}
      {data.stores.length > 1 && !data.store && (
        <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 animate-enter">
          {data.stores.map((s) => {
            const pct = s.scheduledNow > 0 ? Math.min(100, Math.round((s.onFloor / s.scheduledNow) * 100)) : null;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => drillTo(s.id)}
                className="rounded-lg border border-navy-secondary bg-navy-secondary/20 p-3 text-left transition-colors hover:border-gold/40 elev-1"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium text-white">{s.name}</span>
                  {s.openToday > 0 ? (
                    <span className="shrink-0 text-2xs font-medium text-alert">
                      {t('portal.openCount', { count: s.openToday })}
                    </span>
                  ) : (
                    <span className="shrink-0 text-2xs text-silver/50">{t('portal.storeOk')}</span>
                  )}
                </div>
                <div className="mt-1.5 flex items-baseline gap-1">
                  <span className="text-2xl font-bold tracking-tight text-white">{s.onFloor}</span>
                  <span className="text-xs text-silver/70">
                    {t('portal.storeOfSched', { sched: s.scheduledNow })}
                  </span>
                </div>
                <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-gold/15" aria-hidden="true">
                  <div
                    className={cn('h-full rounded-full', pct !== null && pct < 100 ? 'bg-warning' : 'bg-success')}
                    style={{ width: `${pct ?? 0}%` }}
                  />
                </div>
              </button>
            );
          })}
        </div>
      )}
      {data.store && data.stores.length === 0 && !user?.locationId && (
        <button
          type="button"
          onClick={() => drillTo(null)}
          className="text-xs text-gold underline-offset-2 hover:underline"
        >
          ← {t('portal.allStores', { client: data.client.name })}
        </button>
      )}

      {/* ---- Hero: the floor right now, drawn across the day --------------- */}
      <Card
        className={cn(
          'relative overflow-hidden animate-enter',
          heroTone === 'warning'
            ? 'border-warning/30 bg-gradient-to-br from-warning/[0.14] via-transparent to-transparent'
            : 'border-gold/30 bg-gradient-to-br from-gold/[0.14] via-transparent to-transparent',
        )}
      >
        <div
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute inset-0',
            heroTone === 'success'
              ? 'bg-[radial-gradient(circle_at_10%_0%,rgb(var(--color-success)/0.14),transparent_50%)]'
              : heroTone === 'warning'
                ? 'bg-[radial-gradient(circle_at_10%_0%,rgb(var(--color-warning)/0.14),transparent_50%)]'
                : 'bg-[radial-gradient(circle_at_10%_0%,rgb(var(--color-gold)/0.14),transparent_50%)]',
          )}
        />
        <CardContent className="relative p-5">
          <div className="grid gap-5 md:grid-cols-12">
            <div className="md:col-span-4">
              <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-gold">
                <Users className="h-3.5 w-3.5" aria-hidden="true" />
                {t('portal.onFloorNow')}
              </span>
              <div className="mt-2 flex items-baseline gap-2">
                <span
                  className={cn(
                    'text-5xl font-bold leading-none tracking-tight sm:text-6xl',
                    short ? 'text-warning' : 'text-white',
                  )}
                >
                  {onFloor.length}
                </span>
                {target !== null && (
                  <span className="text-2xl font-semibold text-silver/60">/ {target}</span>
                )}
              </div>
              <p className="mt-2 text-sm text-silver">
                {target !== null
                  ? short
                    ? t('portal.heroShort', {
                        missing: target - onFloor.length,
                        window: data.now.targetLabel ?? t('portal.heroContracted'),
                      })
                    : t('portal.heroMet', {
                        window: data.now.targetLabel ?? t('portal.heroContracted'),
                      })
                  : data.now.scheduledNow > 0
                    ? t('portal.onOfSched', { on: onFloor.length, sched: data.now.scheduledNow })
                    : onFloor.length > 0
                      ? t('portal.onPlain', { on: onFloor.length })
                      : t('portal.nobodyNow')}
              </p>
              {onFloor.length > 0 && (
                <div className="mt-3 flex items-center -space-x-2">
                  {onFloor.slice(0, 8).map((p) => (
                    <Avatar
                      key={p.associateId}
                      src={photoUrl(p.associateId)}
                      name={p.name}
                      email=""
                      size="md"
                      ringed
                    />
                  ))}
                  {onFloor.length > 8 && (
                    <span className="pl-4 text-sm text-silver tabular-nums">+{onFloor.length - 8}</span>
                  )}
                </div>
              )}
            </div>
            <div className="md:col-span-8">
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="text-sm font-medium text-white">{t('portal.curveTitle')}</h2>
                <span className="text-xs text-silver/60 tabular-nums">
                  {t('portal.todayMeta', { filled: data.today.filled, open: data.today.open })}
                </span>
              </div>
              <div className="mt-2">
                <CoverageCurve
                  points={curve}
                  target={target}
                  nowHour={nowHour}
                  labels={{
                    scheduled: t('portal.chartScheduled'),
                    open: t('portal.chartOpen'),
                    contracted: t('portal.chartContracted'),
                    now: t('portal.chartNow'),
                    at: (h) => t('portal.chartAt', { hour: h }),
                  }}
                />
                <DetailsTable
                  label={t('portal.details')}
                  columns={[t('portal.chartHour'), t('portal.chartScheduled'), t('portal.chartOpen')]}
                  rows={curve.filter((p) => p.scheduled + p.open > 0).map((p) => [p.label, p.scheduled, p.open])}
                />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ---- KPI strip ------------------------------------------------------ */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 animate-enter" style={enterStagger(1)}>
        <StatTile
          label={t('portal.kpiFill')}
          value={data.week.fillRatePct !== null ? `${data.week.fillRatePct}%` : '—'}
          delta={
            fillDelta !== null
              ? `${fillDelta > 0 ? '+' : ''}${fillDelta} ${t('portal.kpiPts')}`
              : null
          }
          deltaTone={fillDelta === null || fillDelta === 0 ? 'neutral' : fillDelta > 0 ? 'good' : 'bad'}
          meter={
            data.week.fillRatePct !== null
              ? {
                  percent: data.week.fillRatePct,
                  tone: data.week.fillRatePct >= 95 ? 'good' : data.week.fillRatePct >= 85 ? 'primary' : 'warn',
                }
              : null
          }
          sub={t('portal.kpiFillSub', { filled: data.week.filled, total: data.week.filled + data.week.open })}
        />
        <StatTile
          label={t('portal.kpiGrade')}
          value={
            <span className={data.reliability.grade ? GRADE_STYLE[data.reliability.grade] : 'text-silver/50'}>
              {data.reliability.grade ?? '—'}
            </span>
          }
          delta={data.reliability.score !== null ? t('portal.relScore', { score: data.reliability.score }) : null}
          sub={
            pastWeeks.some((w) => w.total > 0)
              ? t('portal.kpiGradeSub', { ncns: sum((w) => w.noCallNoShows), replaced: sum((w) => w.replaced) })
              : t('portal.relNoHistory')
          }
        />
        <StatTile
          label={t('portal.kpiHours')}
          value={fmtHours(data.week.workedHours)}
          meter={hoursPct !== null ? { percent: hoursPct, tone: 'primary' } : null}
          sub={t('portal.kpiHoursSub', { scheduled: fmtHours(data.week.hours) })}
        />
        <StatTile
          label={t('portal.kpiTomorrow')}
          value={tomorrowTotal === 0 ? '—' : data.tomorrow.confirmed}
          unit={tomorrowTotal === 0 ? undefined : `/ ${tomorrowTotal}`}
          meter={
            tomorrowTotal > 0
              ? {
                  percent: Math.round((data.tomorrow.confirmed / tomorrowTotal) * 100),
                  tone: data.tomorrow.open > 0 ? 'warn' : 'good',
                }
              : null
          }
          sub={
            tomorrowTotal === 0
              ? t('portal.tomorrowNone')
              : [
                  data.tomorrow.open > 0 && t('portal.openCount', { count: data.tomorrow.open }),
                  data.tomorrow.unconfirmed > 0 &&
                    t('portal.awaiting', { count: data.tomorrow.unconfirmed }),
                  data.tomorrow.coverInFlight > 0 &&
                    t('portal.coverInFlightShort', { count: data.tomorrow.coverInFlight }),
                ]
                  .filter(Boolean)
                  .join(' · ') || t('portal.tomorrowAllSet')
          }
        />
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-12">
        {/* ---- Today by shift (the full list lives on /portal/today) ---- */}
        <Card className="animate-enter xl:col-span-5" style={enterStagger(2)}>
          <CardContent className="p-5">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-sm font-medium text-white">{t('portal.todayByShift')}</h2>
              <Link to={`/portal/today${qs}`} className="text-xs text-gold underline-offset-2 hover:underline">
                {t('portal.todayOpen')}
              </Link>
            </div>
            {waves.length === 0 ? (
              <p className="mt-3 text-sm text-silver/60">{t('portal.noShiftsToday')}</p>
            ) : (
              <ul className="mt-3 space-y-3">
                {waves.map((w) => {
                  const inCount = w.phase === 'finished' ? w.worked : w.clockedIn.length;
                  const pct = w.expected > 0 ? Math.round((inCount / w.expected) * 100) : 0;
                  const short = w.phase === 'live' && inCount < w.expected;
                  return (
                    <li key={w.key}>
                      <Link
                        to={`/portal/today${qs}`}
                        className="-mx-2 block rounded-md px-2 py-1 hover:bg-navy-secondary/30"
                      >
                        <div className="flex items-baseline justify-between gap-3">
                          <span
                            className={cn(
                              'text-sm tabular-nums',
                              w.phase === 'finished' ? 'text-silver/70' : 'text-white',
                            )}
                          >
                            {fmtShiftRangeTz(w.startsAt, w.endsAt, w.timezone)}
                            {w.phase === 'live' && (
                              <span className="ml-2 text-2xs font-medium uppercase tracking-wider text-success">
                                {t('portal.live')}
                              </span>
                            )}
                          </span>
                          <span
                            className={cn(
                              'text-sm font-semibold tabular-nums',
                              short ? 'text-warning' : w.phase === 'finished' ? 'text-silver/70' : 'text-white',
                            )}
                          >
                            {w.phase === 'upcoming'
                              ? t('portal.waveExpected', { expected: w.expected })
                              : t('portal.waveInOfShort', { in: inCount, expected: w.expected })}
                            {w.open.length > 0 && (
                              <span className="text-alert"> · {t('portal.openCount', { count: w.open.length })}</span>
                            )}
                          </span>
                        </div>
                        <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-gold/15" aria-hidden="true">
                          <div
                            className={cn(
                              'h-full rounded-full',
                              w.phase === 'upcoming' ? 'bg-silver/30' : short ? 'bg-warning' : 'bg-success',
                            )}
                            style={{ width: `${w.phase === 'upcoming' ? 100 : pct}%` }}
                          />
                        </div>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* ---- Your Alto lead ------------------------------------------ */}
        <Card className="animate-enter xl:col-span-3" style={enterStagger(3)}>
          <CardContent className="p-5">
            <h2 className="flex items-center gap-1.5 text-sm font-medium text-white">
              <HardHat className="h-4 w-4 text-gold" aria-hidden="true" />
              {t('portal.leadTitle')}
            </h2>
            {data.leads.people.length === 0 ? (
              <p className="mt-3 text-sm text-silver/60">
                {data.leads.supportEmail ? t('portal.leadNoneEmail') : t('portal.leadNone')}
              </p>
            ) : (
              <ul className="mt-3 space-y-3">
                {data.leads.people.map((p) => (
                  <li key={p.email} className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-sm font-medium text-white">
                        <span className="truncate">{p.name}</span>
                        {p.onFloor && (
                          <span className="relative flex h-2 w-2" aria-hidden="true">
                            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60 motion-reduce:hidden" />
                            <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-silver/70">
                        {t(p.title === 'supervisor' ? 'portal.leadSupervisor' : 'portal.leadFloor')}
                        {p.onFloor && <span className="text-success"> · {t('portal.leadOnFloor')}</span>}
                        {p.runningOps && <span className="text-gold"> · {t('portal.leadRunningOps')}</span>}
                      </div>
                    </div>
                    {p.phone && (
                      <Button size="sm" variant="secondary" asChild>
                        <a href={`tel:${p.phone.replace(/[^+\d]/g, '')}`}>
                          <Phone className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                          {t('portal.call')}
                        </a>
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" asChild>
                      <a href={`mailto:${p.email}`} aria-label={t('portal.emailPerson', { name: p.name })}>
                        <Mail className="h-4 w-4" aria-hidden="true" />
                      </a>
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {data.leads.supportEmail && (
              <p className="mt-3 text-xs text-silver/60">
                {t('portal.leadEscalate')}{' '}
                <a className="text-gold hover:underline" href={`mailto:${data.leads.supportEmail}`}>
                  {data.leads.supportEmail}
                </a>
              </p>
            )}
          </CardContent>
        </Card>

        {/* ---- Last night's work (ops evidence) ------------------------- */}
        <Card className="animate-enter xl:col-span-4" style={enterStagger(4)}>
          <CardContent className="p-5">
            <h2 className="flex items-center gap-1.5 text-sm font-medium text-white">
              <ClipboardCheck className="h-4 w-4 text-gold" aria-hidden="true" />
              {opsIsToday ? t('portal.opsToday') : t('portal.opsTitle')}
            </h2>
            {!opsDay ? (
              <p className="mt-3 text-sm text-silver/60">{t('portal.opsNone')}</p>
            ) : (
              <>
                <div className="mt-3 flex items-center gap-4">
                  <RingMeter
                    percent={sopPct}
                    tone={sopPct === null ? 'primary' : sopPct >= 95 ? 'good' : sopPct >= 80 ? 'primary' : 'warn'}
                    label={t('portal.opsSopWord')}
                  >
                    <span className="text-xl font-bold tracking-tight text-white">
                      {sopPct === null ? '—' : `${sopPct}%`}
                    </span>
                  </RingMeter>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-white">{t('portal.opsSopWord')}</div>
                    <p className="mt-1 text-xs text-silver/70 tabular-nums">
                      {t('portal.opsLine', {
                        shifts: opsDay.shifts,
                        tasks: opsDay.taskDone,
                        total: opsDay.taskTotal,
                        photos: opsDay.photos,
                      })}
                    </p>
                    {(opsDay.tempAlerts > 0 || opsDay.incomplete > 0 || opsDay.open > 0) && (
                      <p className="mt-1 text-xs text-warning tabular-nums">
                        {[
                          opsDay.tempAlerts > 0 && t('portal.opsTemp', { count: opsDay.tempAlerts }),
                          opsDay.incomplete > 0 && t('portal.opsIncomplete', { count: opsDay.incomplete }),
                          opsDay.open > 0 && t('portal.opsStillOpen', { count: opsDay.open }),
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </p>
                    )}
                  </div>
                </div>
                {opsDay.notes.length > 0 && (
                  <ul className="mt-3 space-y-1.5 border-t border-navy-secondary/60 pt-3">
                    {opsDay.notes.map((n, i) => (
                      <li key={i} className="text-xs text-silver/80">
                        <span className="font-medium text-white">{n.department}</span>
                        <span className="text-silver/50"> · {n.period.toLowerCase()}</span>
                        <span className="text-silver/60"> — </span>
                        {n.summary}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </CardContent>
        </Card>

        {/* ---- This week: fill by day ------------------------------------ */}
        <Card className="animate-enter xl:col-span-7" style={enterStagger(5)}>
          <CardContent className="p-5">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="flex items-center gap-1.5 text-sm font-medium text-white">
                <CalendarDays className="h-4 w-4 text-gold" aria-hidden="true" />
                {t('portal.week')}
              </h2>
              <span className="text-xs text-silver/60 tabular-nums">
                {fmtDate(parseYmd(data.week.start))} – {fmtDate(parseYmd(data.week.end))}
              </span>
            </div>
            <div className="mt-3">
              <WeekFillChart
                days={weekDays}
                todayKey={data.today.date}
                labels={{
                  filled: t('portal.chartFilled'),
                  open: t('portal.chartOpen'),
                  heading: (d) => {
                    const row = weekDays.find((x) => x.day === d);
                    return row ? fmtDate(parseYmd(row.date)) : d;
                  },
                }}
              />
            </div>
            <p className="mt-2 text-sm text-silver tabular-nums">
              {data.week.fillRatePct !== null
                ? t('portal.weekSentence', { pct: data.week.fillRatePct, hours: fmtHours(data.week.hours) })
                : t('portal.weekHoursOnly', { hours: fmtHours(data.week.hours) })}
              <span className="text-silver/60"> · {t('portal.weekDelivered', { worked: fmtHours(data.week.workedHours) })}</span>
            </p>
            <DetailsTable
              label={t('portal.details')}
              columns={[t('portal.chartDay'), t('portal.chartFilled'), t('portal.chartOpen')]}
              rows={data.week.days.map((d) => [fmtDate(parseYmd(d.date)), d.filled, d.open])}
            />
          </CardContent>
        </Card>

        {/* ---- Reliability (4 weeks) ------------------------------------ */}
        <Card className="animate-enter xl:col-span-5" style={enterStagger(6)}>
          <CardContent className="p-5">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="flex items-center gap-1.5 text-sm font-medium text-white">
                <ShieldCheck className="h-4 w-4 text-gold" aria-hidden="true" />
                {t('portal.reliability')}
              </h2>
              <span
                className={cn(
                  'text-2xl font-bold leading-none tracking-tight',
                  data.reliability.grade ? GRADE_STYLE[data.reliability.grade] : 'text-silver/50',
                )}
              >
                {data.reliability.grade ?? '—'}
              </span>
            </div>
            <div className="mt-3">
              <ReliabilityChart
                weeks={relWeeks}
                labels={{
                  fill: t('portal.chartShowed'),
                  target: t('portal.chartTarget'),
                  heading: (l) => {
                    const w = relWeeks.find((x) => x.label === l);
                    return w ? `${fmtDate(parseYmd(w.start))} – ${fmtDate(parseYmd(w.end))}` : l;
                  },
                }}
              />
            </div>
            <p className="mt-2 text-sm text-silver tabular-nums">
              {pastWeeks.some((w) => w.total > 0)
                ? t('portal.relMonthLine', {
                    ncns: sum((w) => w.noCallNoShows),
                    lates: sum((w) => w.lates),
                    replaced: sum((w) => w.replaced),
                  })
                : t('portal.relNoHistory')}
            </p>
            <p className="mt-1 text-xs text-silver/70 tabular-nums">
              {t('portal.relThisWeek')}{' '}
              {covParts.length === 0 ? (
                <span className="text-success">{t('portal.covClean')}</span>
              ) : (
                covParts.join(' · ')
              )}
              {replaced && <span className="text-success"> · {replaced}</span>}
            </p>
            <DetailsTable
              label={t('portal.details')}
              columns={[
                t('portal.chartWeek'),
                t('portal.chartShowed'),
                t('portal.chartFillPct'),
                t('portal.covNoShowCol'),
                t('portal.covCallOutCol'),
                t('portal.covLateCol'),
                t('portal.covReplacedCol'),
              ]}
              rows={data.reliability.weeks.map((w) => [
                `${fmtDate(parseYmd(w.start))} – ${fmtDate(parseYmd(w.end))}`,
                w.reliabilityPct === null ? '—' : `${w.reliabilityPct}%`,
                w.fillPct === null ? '—' : `${w.fillPct}%`,
                w.noCallNoShows,
                w.callOuts,
                w.lates,
                w.replaced,
              ])}
            />
          </CardContent>
        </Card>

        {/* ---- Crew clearance ------------------------------------------- */}
        <Card className="animate-enter xl:col-span-4" style={enterStagger(7)}>
          <CardContent className="p-5">
            <h2 className="text-sm font-medium text-white">{t('portal.clearance')}</h2>
            {cl.total === 0 ? (
              <p className="mt-3 text-sm text-silver/60">{t('portal.clNone')}</p>
            ) : (
              <div className="mt-3 flex items-center gap-4">
                <RingMeter
                  percent={clearancePct}
                  tone={clearanceClean ? 'good' : cl.flagged > 0 ? 'bad' : 'warn'}
                  label={t('portal.clearance')}
                >
                  <span className="text-xl font-bold tracking-tight text-white">
                    {clearedCount}
                    <span className="text-xs font-normal text-silver/60">/{cl.total}</span>
                  </span>
                </RingMeter>
                <div className="min-w-0 flex-1">
                  {clearanceClean ? (
                    <p className="flex items-start gap-1.5 text-sm text-success">
                      <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                      {t('portal.clAllClear', { count: cl.total })}
                    </p>
                  ) : (
                    <>
                      <p className="text-sm text-white tabular-nums">
                        {t('portal.clCleared', { cleared: clearedCount, total: cl.total })}
                      </p>
                      <p className={cn('mt-1 text-xs tabular-nums', cl.flagged > 0 ? 'text-alert' : 'text-warning')}>
                        {clearanceParts.join(' · ')}
                      </p>
                    </>
                  )}
                </div>
              </div>
            )}
            <p className="mt-3 text-2xs text-silver/50">{t('portal.clFootnote')}</p>
          </CardContent>
        </Card>

        {/* ---- Safety ---------------------------------------------------- */}
        <Card className="animate-enter xl:col-span-4" style={enterStagger(8)}>
          <CardContent className="p-5">
            <h2 className="text-sm font-medium text-white">{t('portal.safety')}</h2>
            <div className="mt-2 text-4xl font-bold tracking-tight text-white">
              {data.safety.daysSinceLast === null ? '365+' : data.safety.daysSinceLast}
              <span className="ml-2 text-base font-normal text-silver">{t('portal.safetyDays')}</span>
            </div>
            <p className={cn('mt-1.5 text-sm tabular-nums', data.safety.open > 0 ? 'text-warning' : 'text-silver')}>
              {data.safety.monthIncidents === 0
                ? t('portal.safetyCleanMonth')
                : t('portal.safetyMonth', { count: data.safety.monthIncidents })}
              {data.safety.open > 0 && ` · ${t('portal.safetyOpen', { count: data.safety.open })}`}
            </p>
          </CardContent>
        </Card>

        {/* ---- Statements ------------------------------------------------ */}
        <Card className="animate-enter xl:col-span-4" style={enterStagger(9)}>
          <CardContent className="p-5">
            <h2 className="text-sm font-medium text-white">{t('portal.statements')}</h2>
            {data.statements.length === 0 ? (
              <p className="mt-3 text-sm text-silver/60">{t('portal.stNone')}</p>
            ) : (
              <ul className="mt-3 divide-y divide-navy-secondary/60">
                {data.statements.slice(0, 4).map((s) => {
                  const amount = data.store && s.storeAmount !== null ? s.storeAmount : s.amount;
                  const hours = data.store && s.storeHours !== null ? s.storeHours : s.hours;
                  return (
                    <li key={s.id} className="py-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-white tabular-nums">
                            {s.number !== null ? t('portal.stNumber', { n: s.number }) : t('portal.statements')}
                            {data.store && s.storeAmount !== null && (
                              <span className="ml-1.5 text-2xs font-normal text-silver/50">
                                {t('portal.stStoreShare')}
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-silver/70 tabular-nums">
                            {fmtDate(parseYmd(s.periodStart))} – {fmtDate(parseYmd(s.periodEnd))}
                            {hours !== null && ` · ${fmtHours(hours)}`}
                          </div>
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-1">
                          {amount !== null && (
                            <span className="text-sm font-semibold tabular-nums text-white">
                              {fmtMoney(amount)}
                            </span>
                          )}
                          {s.paidAt ? (
                            <Badge variant="success" size="sm">{t('portal.paidOn', { date: fmtDate(s.paidAt) })}</Badge>
                          ) : (
                            <Badge variant="pending" size="sm">{t('portal.due')}</Badge>
                          )}
                        </div>
                      </div>
                      <div className="mt-1.5 flex gap-1">
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() => void downloadStatementFile(s.pdfUrl, `statement-${s.periodStart}.pdf`)}
                        >
                          <FileText className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                          {t('portal.stPdf')}
                        </Button>
                        {isPortal && (
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() =>
                              setPrefill({
                                kind: 'BILLING',
                                subject: t('portal.stDisputeSubject', {
                                  n: s.number !== null ? `#${s.number}` : fmtDate(parseYmd(s.periodEnd)),
                                }),
                                nonce: Date.now(),
                              })
                            }
                          >
                            {t('portal.stDispute')}
                          </Button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ---- Requests: the client in the loop -------------------------- */}
      {isPortal && <PortalRequests prefill={prefill} />}
    </div>
  );
}

/** "3 call-outs" / "1 call-out" / null when zero. */
function part(
  t: ReturnType<typeof useI18n>['t'],
  count: number,
  one: MessageKey,
  many: MessageKey,
): string | null {
  if (count <= 0) return null;
  return count === 1 ? t(one) : t(many, { count });
}

/** Weekday initial for a YYYY-MM-DD key, locale-aware. */
function dayInitial(ymd: string): string {
  const d = parseYmd(ymd);
  if (!d) return '';
  return new Intl.DateTimeFormat(
    typeof document !== 'undefined' && document.documentElement.lang === 'es' ? 'es-US' : 'en-US',
    { weekday: 'short' },
  ).format(d);
}
