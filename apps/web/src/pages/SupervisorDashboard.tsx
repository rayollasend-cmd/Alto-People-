import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, ClipboardCheck, MapPin, Timer, Users } from 'lucide-react';
import { usePullToRefresh, PullToRefreshIndicator } from '@/lib/usePullToRefresh';
import { ApiError, apiFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { boundedClientOf } from '@/lib/roles';
import { listClientLocations } from '@/lib/clientsApi';
import { getMySop } from '@/lib/opsApi';
import { getSchedulingKpis, listShifts } from '@/lib/schedulingApi';
import {
  fmtDate,
  fmtShiftRangeTz,
  fmtTime,
  parseYmd,
  ymdLocal,
  zonedDayKey,
  zonedMinutesOfDay,
} from '@/lib/format';
import { cn } from '@/lib/cn';
import { enterStagger } from '@/lib/motion';
import { PageHeader } from '@/components/ui/PageHeader';
import { Card, CardContent } from '@/components/ui/Card';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Skeleton } from '@/components/ui/Skeleton';
import { RoleDecisionQueue } from '@/components/RoleDecisionQueue';
import { MyPlanCard } from '@/components/MyPlanCard';
import { coverageByHour } from '@/pages/portal/coverage';
import { groupWaves, wavePresent, type WaveRow } from '@/pages/portal/waves';
import { shiftDays } from '@/pages/portal/scope';
import { CoverageCurve, DetailsTable, StatTile, WeekFillChart } from '@/pages/portal/portalCharts';
import { FocusToggle } from '@/pages/portal/FocusToggle';
import {
  activeWindows,
  crewOnFloor,
  focusName,
  inWindows,
  useShiftFocus,
} from '@/pages/portal/shiftFocus';
import { fmtClockMinute, fmtShiftWindow, minuteOfDayInZone } from '@alto-people/shared';

/**
 * My floor — the SHIFT_SUPERVISOR's home, in the store manager's grammar.
 *
 * It reads top-down like the portal's morning brief, from the other side
 * of the counter: the place (the store, not the app), the floor RIGHT NOW
 * against the contracted line drawn across today, the four numbers a
 * supervisor runs the week by, then the cards — what's waiting on them,
 * today shift by shift, the next seven days, and their own plan. The
 * roster is faces on /today, never a wall of names here.
 *
 * Their shift — the store shift windows they lead — is the default focus:
 * the hero counts their crew against their window's target, the waves
 * and the week ahead are their shift, and the coverage curve shades their
 * hours inside the store's day. "Whole store" is one tap away; focus never
 * narrows what they may see.
 *
 * Every read is clamped to the supervisor's client server-side. The day
 * roster is the portal's own /client-portal/day (the route opts this role
 * in), so the supervisor and the store manager can never disagree about
 * who is on the floor. No money anywhere — labor cost is withheld from
 * this role.
 */

interface DayPayload {
  client: { id: string; name: string };
  store: { id: string; name: string; timezone: string } | null;
  date: string;
  today: string;
  generatedAt: string;
  target: number | null;
  roster: WaveRow[];
  /** Every open clock-in right now (today only) — the live board's count. */
  onFloorNow?: Array<{ associateId: string; name: string; clockInAt: string; position: string | null }>;
  summary: { expected: number; worked: number; onFloor: number; missed: number; open: number };
}

interface ApprovalsCount {
  swaps: number;
  pickups: number;
  timeOff: number;
  timesheets: number;
  clockIns: number;
  total: number;
}

const photoUrl = (associateId: string) => `/api/associates/${associateId}/photo`;
const DAY_MS = 86_400_000;

const WEEKDAY = new Intl.DateTimeFormat('en-US', { weekday: 'short' });
function weekdayShort(ymd: string): string {
  const d = parseYmd(ymd);
  return d ? WEEKDAY.format(d) : '';
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function SupervisorDashboard() {
  const { t } = useI18n();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const pullState = usePullToRefresh(() => queryClient.invalidateQueries());
  const client = boundedClientOf(user);
  const { windows: myWindows, focus, setFocus, mine } = useShiftFocus();
  const todayKey = ymdLocal();
  const tomorrowKey = shiftDays(todayKey, 1);

  // ---- Reads -------------------------------------------------------------
  const dayQuery = useQuery({
    queryKey: ['floor', 'day', todayKey],
    queryFn: () => apiFetch<DayPayload>('/client-portal/day'),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    placeholderData: (prev) => prev,
  });
  const tomorrowQuery = useQuery({
    queryKey: ['floor', 'day', tomorrowKey],
    queryFn: () => apiFetch<DayPayload>(`/client-portal/day?date=${tomorrowKey}`),
    refetchInterval: 5 * 60_000,
  });
  const locationsQuery = useQuery({
    queryKey: ['floor', 'locations', client?.id],
    queryFn: () => listClientLocations(client!.id),
    enabled: !!client,
    staleTime: 10 * 60_000,
  });
  // The next seven days, today first — the fill chart and the open count.
  const aheadQuery = useQuery({
    queryKey: ['floor', 'ahead', todayKey],
    queryFn: () => {
      const from = new Date();
      from.setHours(0, 0, 0, 0);
      return listShifts({ from: from.toISOString(), to: new Date(from.getTime() + 7 * DAY_MS).toISOString() });
    },
  });
  // Fill rate by the store's workweek (Sat→Fri, on the store's clock) —
  // the week the store manager's portal grades, so both read one number.
  const kpiThis = useQuery({
    queryKey: ['floor', 'kpis', 'this', todayKey],
    queryFn: () => getSchedulingKpis({ week: 'this' }),
  });
  const kpiLast = useQuery({
    queryKey: ['floor', 'kpis', 'last', todayKey],
    queryFn: () => getSchedulingKpis({ week: 'last' }),
  });
  // The SOP their clock-in opened — on top of My floor until submitted.
  const sopQuery = useQuery({
    queryKey: ['ops', 'my-sop'],
    queryFn: getMySop,
    refetchInterval: 60_000,
  });
  const approvalsQuery = useQuery({
    queryKey: ['floor', 'approvals-count'],
    queryFn: () => apiFetch<ApprovalsCount>('/approvals/count'),
    refetchInterval: 60_000,
  });

  const data = dayQuery.data;
  // The rows in view: their shift, or the whole store.
  const focusRows = useMemo(
    () => (data ? (mine ? data.roster.filter((r) => inWindows(r, myWindows)) : data.roster) : []),
    [data, mine, myWindows],
  );
  const waves = useMemo(() => groupWaves(focusRows), [focusRows]);
  const storeTz = data?.store?.timezone ?? data?.roster[0]?.timezone ?? null;
  const curve = useMemo(
    () =>
      data
        ? coverageByHour(
            data.roster.map((r) => ({
              startsAt: r.startsAt,
              endsAt: r.endsAt,
              timezone: r.timezone,
              state: r.state === 'open' ? ('open' as const) : ('confirmed' as const),
            })),
            data.date,
            storeTz,
          )
        : [],
    [data, storeTz],
  );

  // Next seven days, one column per day: filled vs unfilled.
  const aheadDays = useMemo(() => {
    const shifts = aheadQuery.data?.shifts;
    if (!shifts) return null;
    return Array.from({ length: 7 }, (_, i) => {
      const date = shiftDays(todayKey, i);
      const onDay = shifts.filter(
        (s) =>
          s.status !== 'CANCELLED' &&
          s.status !== 'DRAFT' &&
          zonedDayKey(s.startsAt, s.timezone) === date &&
          (!mine || inWindows(s, myWindows)),
      );
      const open = onDay.filter((s) => s.status === 'OPEN').length;
      return {
        date,
        day: weekdayShort(date),
        filled: onDay.length - open,
        open,
      };
    });
  }, [aheadQuery.data, todayKey, mine, myWindows]);

  // ---- The place ---------------------------------------------------------
  const locations = (locationsQuery.data?.locations ?? []).filter((l) => l.isActive);
  const oneStore = locations.length === 1 ? locations[0] : null;
  const placeName = oneStore?.name ?? data?.client.name ?? client?.name ?? t('floor.title');
  const address = oneStore
    ? [
        oneStore.addressLine1,
        [oneStore.city, [oneStore.state, oneStore.zip].filter(Boolean).join(' ')].filter(Boolean).join(', '),
      ]
        .filter(Boolean)
        .join(' · ')
    : null;

  const header = (
    <PageHeader
      title={placeName}
      topbarTitle={t('floor.title')}
      subtitle={
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>
            {oneStore
              ? (data?.client.name ?? client?.name)
              : locations.length > 1
                ? plural(locations.length, 'store', 'stores')
                : t('floor.title')}
          </span>
          {address && (
            <span className="flex items-center gap-1 text-silver/70">
              <MapPin className="h-3 w-3" aria-hidden="true" />
              {address}
            </span>
          )}
          {data && (
            <span className="flex items-center gap-1.5 text-xs text-silver/60">
              <span className="relative flex h-1.5 w-1.5" aria-hidden="true">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60 motion-reduce:hidden" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-success" />
              </span>
              {t('portal.asOf', { time: fmtTime(data.generatedAt) })}
            </span>
          )}
        </span>
      }
      secondaryActions={
        <>
          <Button size="sm" variant="outline" asChild>
            <Link to="/time-attendance">
              <Timer className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              Live board
            </Link>
          </Button>
          <Button size="sm" variant="outline" asChild>
            <Link to="/today">
              <Users className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              {t('portal.todayNav')}
            </Link>
          </Button>
        </>
      }
      primaryAction={
        <Button size="sm" asChild>
          <Link to="/scheduling">
            <CalendarDays className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            Open schedule
          </Link>
        </Button>
      }
    />
  );

  if (dayQuery.isError && !data) {
    return (
      <div className="mx-auto space-y-4">
        {header}
        <ErrorBanner
          action={
            <Button size="sm" variant="secondary" onClick={() => void dayQuery.refetch()}>
              {t('common.retry')}
            </Button>
          }
        >
          {dayQuery.error instanceof ApiError ? dayQuery.error.message : t('portal.loadFailed')}
        </ErrorBanner>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-1/3" />
        <Skeleton className="h-64" />
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
        <Skeleton className="h-64" />
      </div>
    );
  }

  // ---- Hero figures ------------------------------------------------------
  // Everyone clocked in right now — the live board's definition. Counting
  // only roster rows matched to an assigned shift read "0 / 10" while the
  // floor was full of walk-ins, covers and people on draft shifts.
  const everyoneOn: Array<{ associateId: string; name: string; clockInAt?: string }> =
    data.onFloorNow ??
    data.roster
      .filter((r) => r.state === 'on-floor' && r.associateId)
      .map((r) => ({ associateId: r.associateId!, name: r.name ?? '', clockInAt: r.clockInAt ?? undefined }));
  // My shift: their crew is whoever's shift starts in their window — a
  // walk-in (or last night's crew, off today's roster) goes by clock-in.
  const onFloor = mine ? crewOnFloor(everyoneOn, data.roster, myWindows) : everyoneOn;
  const runningNow = mine ? activeWindows(myWindows) : [];
  // Off the clock: the next of their windows to start, on its store's clock.
  const nextUp =
    mine && runningNow.length === 0
      ? ([...myWindows].sort((a, b) => {
          const wait = (w: typeof a) => (w.startMinute - minuteOfDayInZone(new Date(), w.timezone) + 1440) % 1440;
          return wait(a) - wait(b);
        })[0] ?? null)
      : null;
  const target = mine
    ? runningNow.length > 0
      ? runningNow.reduce((n, w) => n + w.targetCount, 0)
      : (nextUp?.targetCount ?? null)
    : data.target;
  const nextScheduled = nextUp
    ? focusRows.filter((r) => r.state !== 'open' && inWindows(r, [nextUp])).length
    : 0;
  const short = target !== null && onFloor.length < target && !nextUp;
  const staffed = target !== null ? onFloor.length >= target : onFloor.length > 0;
  const heroTone = short ? 'warning' : staffed ? 'success' : 'gold';
  const scheduledNow = focusRows.filter((r) => r.state === 'on-floor' || r.state === 'not-in').length;
  const heroWindow = mine && runningNow.length > 0
    ? t('focus.windowTarget', { label: focusName(runningNow) })
    : t('portal.heroContracted');
  const nowHour =
    zonedDayKey(new Date(), storeTz) === data.date
      ? Math.floor(zonedMinutesOfDay(new Date(), storeTz) / 60)
      : null;

  // ---- KPI figures -------------------------------------------------------
  const k = kpiThis.data;
  const kLast = kpiLast.data;
  const filledWeek = k ? k.assignedShifts + k.completedShifts : 0;
  // No shifts yet this week is "—", not 0% (the portal reads it the same).
  const weekBase = k ? filledWeek + k.openShifts : 0;
  const fillDelta =
    k && kLast && weekBase > 0 && kLast.openShifts + kLast.assignedShifts + kLast.completedShifts > 0
      ? k.fillRatePercent - kLast.fillRatePercent
      : null;
  const openAhead = aheadDays?.reduce((n, d) => n + d.open, 0) ?? null;
  const filledAhead = aheadDays?.reduce((n, d) => n + d.filled, 0) ?? 0;
  const tmAll = tomorrowQuery.data?.roster ?? null;
  const tm = tmAll && mine ? tmAll.filter((r) => inWindows(r, myWindows)) : tmAll;
  const tmConfirmed = tm?.filter((r) => r.state === 'confirmed').length ?? 0;
  const tmUnconfirmed = tm?.filter((r) => r.state === 'unconfirmed').length ?? 0;
  const tmOpen = tm?.filter((r) => r.state === 'open').length ?? 0;
  const tmTotal = tmConfirmed + tmUnconfirmed + tmOpen;
  const ap = approvalsQuery.data;

  return (
    <div className="mx-auto space-y-4">
      <PullToRefreshIndicator state={pullState} />
      {header}

      {sopQuery.data?.sop && <SopBanner sop={sopQuery.data.sop} />}

      {myWindows.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 animate-enter">
          <FocusToggle windows={myWindows} focus={focus} onChange={setFocus} />
          {mine && (
            <span className="text-xs text-silver/70">
              {myWindows
                .map((w) => `${w.label} ${fmtShiftWindow(w)}${locations.length > 1 ? ` · ${w.locationName}` : ''}`)
                .join('  ·  ')}
            </span>
          )}
        </div>
      )}

      {/* ---- Hero: the floor right now, drawn across the day ------------- */}
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
                <span>
                  {t('portal.onFloorNow')}
                  {mine && (
                    <span className="normal-case tracking-normal text-silver/70">
                      {' '}· {focusName(runningNow.length > 0 ? runningNow : nextUp ? [nextUp] : myWindows)}
                    </span>
                  )}
                </span>
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
                {nextUp
                  ? t('focus.startsAt', {
                      label: nextUp.label,
                      time: fmtClockMinute(nextUp.startMinute),
                      count: nextScheduled,
                    })
                  : target !== null
                  ? short
                    ? t('portal.heroShort', { missing: target - onFloor.length, window: heroWindow })
                    : t('portal.heroMet', { window: heroWindow })
                  : scheduledNow > 0
                    ? t('portal.onOfSched', { on: onFloor.length, sched: scheduledNow })
                    : onFloor.length > 0
                      ? t('portal.onPlain', { on: onFloor.length })
                      : t('portal.nobodyNow')}
              </p>
              {onFloor.length > 0 && (
                <Link to="/today" className="mt-3 flex items-center -space-x-2" aria-label={t('portal.todayOpen')}>
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
                </Link>
              )}
            </div>
            <div className="md:col-span-8">
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="text-sm font-medium text-white">{t('portal.curveTitle')}</h2>
                <span className="text-xs text-silver/60 tabular-nums">
                  {t('portal.todayMeta', { filled: data.summary.expected, open: data.summary.open })}
                </span>
              </div>
              <div className="mt-2">
                <CoverageCurve
                  points={curve}
                  target={data.target}
                  nowHour={nowHour}
                  bands={mine ? myWindows : []}
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

      {/* ---- KPI strip: the four numbers the week runs on ----------------- */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 animate-enter" style={enterStagger(1)}>
        <StatTile
          label="Fill rate · this week"
          value={k && weekBase > 0 ? `${k.fillRatePercent}%` : '—'}
          delta={fillDelta !== null ? `${fillDelta > 0 ? '+' : ''}${fillDelta} ${t('portal.kpiPts')}` : null}
          deltaTone={fillDelta === null || fillDelta === 0 ? 'neutral' : fillDelta > 0 ? 'good' : 'bad'}
          meter={
            k && weekBase > 0
              ? { percent: k.fillRatePercent, tone: k.fillRatePercent >= 95 ? 'good' : k.fillRatePercent >= 85 ? 'primary' : 'warn' }
              : null
          }
          sub={
            k
              ? weekBase > 0
                ? `${filledWeek} of ${weekBase} shifts filled`
                : 'Nothing scheduled this week yet'
              : undefined
          }
        />
        <TileLink to="/scheduling">
          <StatTile
            className="h-full"
            label="Open shifts · next 7 days"
            value={openAhead ?? '—'}
            meter={
              openAhead !== null && filledAhead + openAhead > 0
                ? {
                    percent: Math.round((filledAhead / (filledAhead + openAhead)) * 100),
                    tone: openAhead > 0 ? 'warn' : 'good',
                  }
                : null
            }
            sub={
              aheadDays
                ? openAhead === 0
                  ? 'Every shift covered'
                  : `${aheadDays[0]!.open} today · ${aheadDays[1]!.open} tomorrow`
                : undefined
            }
          />
        </TileLink>
        <StatTile
          label="Tomorrow · confirmed"
          value={tm === null ? '—' : tmTotal === 0 ? '—' : tmConfirmed}
          unit={tm !== null && tmTotal > 0 ? `/ ${tmTotal}` : undefined}
          meter={
            tmTotal > 0
              ? { percent: Math.round((tmConfirmed / tmTotal) * 100), tone: tmOpen > 0 ? 'warn' : 'good' }
              : null
          }
          sub={
            tm === null
              ? undefined
              : tmTotal === 0
                ? t('portal.tomorrowNone')
                : [
                    tmOpen > 0 && t('portal.openCount', { count: tmOpen }),
                    tmUnconfirmed > 0 && t('portal.awaiting', { count: tmUnconfirmed }),
                  ]
                    .filter(Boolean)
                    .join(' · ') || t('portal.tomorrowAllSet')
          }
        />
        <TileLink to="/approvals">
          <StatTile
            className="h-full"
            label="Waiting on you"
            value={ap ? ap.total : '—'}
            sub={
              ap
                ? ap.total === 0
                  ? 'Nothing waiting — inbox zero'
                  : [
                      ap.clockIns > 0 && plural(ap.clockIns, 'walk-in', 'walk-ins'),
                      ap.swaps > 0 && plural(ap.swaps, 'swap', 'swaps'),
                      ap.pickups > 0 && plural(ap.pickups, 'pickup', 'pickups'),
                      ap.timeOff > 0 && `${ap.timeOff} time off`,
                      ap.timesheets > 0 && plural(ap.timesheets, 'timesheet', 'timesheets'),
                    ]
                      .filter(Boolean)
                      .join(' · ')
                : undefined
            }
          />
        </TileLink>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-12">
        {/* ---- What's waiting on them -------------------------------------- */}
        <div className="animate-enter md:col-span-2 xl:col-span-7" style={enterStagger(2)}>
          <RoleDecisionQueue />
        </div>

        {/* ---- Today by shift (the faces live on /today) ------------------- */}
        <Card className="animate-enter md:col-span-2 xl:col-span-5" style={enterStagger(3)}>
          <CardContent className="p-5">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-sm font-medium text-white">{t('portal.todayByShift')}</h2>
              <Link to="/today" className="text-xs text-gold underline-offset-2 hover:underline">
                {t('portal.todayOpen')}
              </Link>
            </div>
            {waves.length === 0 ? (
              <p className="mt-3 text-sm text-silver/60">{mine ? t('focus.nothingToday') : t('portal.noShiftsToday')}</p>
            ) : (
              <ul className="mt-3 space-y-3">
                {waves.map((w) => {
                  const inCount = w.phase === 'finished' ? wavePresent(w) : w.clockedIn.length;
                  const pct = w.expected > 0 ? Math.round((inCount / w.expected) * 100) : 0;
                  const waveShort = w.phase === 'live' && inCount < w.expected;
                  return (
                    <li key={w.key}>
                      <Link
                        to={`/today?wave=${encodeURIComponent(w.startsAt)}`}
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
                              'shrink-0 text-sm font-semibold tabular-nums',
                              waveShort ? 'text-warning' : w.phase === 'finished' ? 'text-silver/70' : 'text-white',
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
                              w.phase === 'upcoming' ? 'bg-silver/30' : waveShort ? 'bg-warning' : 'bg-success',
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

        {/* ---- The next seven days: fill by day ---------------------------- */}
        <Card className="animate-enter xl:col-span-7" style={enterStagger(4)}>
          <CardContent className="p-5">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="flex items-center gap-1.5 text-sm font-medium text-white">
                <CalendarDays className="h-4 w-4 text-gold" aria-hidden="true" />
                Next 7 days
                {mine && <span className="font-normal text-silver/70">· {focusName(myWindows)}</span>}
              </h2>
              <Link to="/scheduling" className="text-xs text-gold underline-offset-2 hover:underline">
                Open schedule
              </Link>
            </div>
            {aheadDays === null ? (
              <Skeleton className="mt-3 h-40" />
            ) : (
              <>
                <div className="mt-3">
                  <WeekFillChart
                    days={aheadDays}
                    todayKey={todayKey}
                    labels={{
                      filled: t('portal.chartFilled'),
                      open: t('portal.chartOpen'),
                      heading: (d) => {
                        const row = aheadDays.find((x) => x.day === d);
                        return row ? fmtDate(parseYmd(row.date)) : d;
                      },
                    }}
                  />
                </div>
                <p className="mt-2 text-sm text-silver tabular-nums">
                  {filledAhead + (openAhead ?? 0) === 0
                    ? 'Nothing scheduled in the next seven days.'
                    : `${filledAhead} of ${filledAhead + (openAhead ?? 0)} filled`}
                  {openAhead ? <span className="text-alert"> · {t('portal.openCount', { count: openAhead })}</span> : null}
                </p>
                <DetailsTable
                  label={t('portal.details')}
                  columns={['Day', t('portal.chartFilled'), t('portal.chartOpen')]}
                  rows={aheadDays.map((d) => [fmtDate(parseYmd(d.date)), d.filled, d.open])}
                />
              </>
            )}
          </CardContent>
        </Card>

        {/* ---- Their own plan ---------------------------------------------- */}
        <div className="animate-enter xl:col-span-5" style={enterStagger(5)}>
          <MyPlanCard />
        </div>
      </div>
    </div>
  );
}

/** A KPI tile that opens where the number is worked. */
function TileLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <Link
      to={to}
      className="group block rounded-lg transition-transform hover:-translate-y-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright [&>div]:transition-colors [&>div]:hover:border-gold/40"
    >
      {children}
    </Link>
  );
}

/** Their shift's SOP, open until submitted — you can't clock out before. */
function SopBanner({ sop }: { sop: NonNullable<Awaited<ReturnType<typeof getMySop>>['sop']> }) {
  const pct = sop.sopTotal > 0 ? Math.round((sop.sopDone / sop.sopTotal) * 100) : 0;
  const overdue = sop.dueAt !== null && new Date(sop.dueAt).getTime() < Date.now();
  return (
    <Link
      to={`/ops?tab=shift&shift=${sop.id}`}
      className={cn(
        'flex items-center gap-4 rounded-lg border p-4 transition-colors animate-enter',
        overdue ? 'border-alert/50 bg-alert/[0.07] hover:bg-alert/10' : 'border-gold/40 bg-gold/[0.06] hover:bg-gold/10',
      )}
    >
      <ClipboardCheck className={cn('h-6 w-6 shrink-0', overdue ? 'text-alert' : 'text-gold')} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-white">
          Your {sop.windowLabel ?? sop.position} SOP is open
        </div>
        <div className="mt-0.5 text-xs text-silver tabular-nums">
          {sop.sopDone} of {sop.sopTotal} done
          {sop.dueAt && (
            <span className={overdue ? 'text-alert' : undefined}>
              {' '}· {overdue ? 'was due' : 'due'} {fmtTime(sop.dueAt)}
            </span>
          )}
          {' '}· submit it before you clock out
        </div>
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-gold/15" aria-hidden="true">
          <div className={cn('h-full rounded-full', overdue ? 'bg-alert' : 'bg-gold')} style={{ width: `${pct}%` }} />
        </div>
      </div>
      <span className="shrink-0 text-sm font-medium text-gold">Continue →</span>
    </Link>
  );
}
