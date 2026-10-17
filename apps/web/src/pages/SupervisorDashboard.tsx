import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, CalendarDays, ClipboardCheck, Flag, MapPin, ShieldAlert, Timer, Users } from 'lucide-react';
import { usePullToRefresh, PullToRefreshIndicator } from '@/lib/usePullToRefresh';
import { ApiError, apiFetch } from '@/lib/api';
import { useAuth, useTerm } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { boundedClientOf } from '@/lib/roles';
import { listClientLocations } from '@/lib/clientsApi';
import { getMySop, type HelpingSop } from '@/lib/opsApi';
import { useShiftClock } from '@/lib/useShiftClock';
import { useInbox } from '@/lib/inboxApi';
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
import { VanArrivalsCard } from '@/components/VanArrivals';
import { IncidentReportDialog } from '@/components/floor/IncidentReportDialog';
import { FloorFlagDialog } from '@/components/floor/FloorFlagDialog';
import { FloorFlagsCard } from '@/components/floor/FloorFlagsCard';
import { HandoverBanner } from '@/components/floor/HandoverBanner';
import { CoverShiftCard } from '@/components/floor/CoverShiftCard';
import { FloorWeekStrip } from '@/components/floor/FloorWeekStrip';
import { ReadyToScheduleCard } from '@/components/ReadyToScheduleCard';
import { ProgramAlertsCard } from '@/components/ProgramAlertsCard';
import { enterStagger } from '@/lib/motion';
import { HomeTemplate } from '@/components/templates';
import { HugoSeat } from '@/components/home/HugoSeat';
import { LiveNow } from '@/components/ui/LiveNow';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { EmptyState } from '@/components/ui/EmptyState';
import { useGreeting, greetingName } from '@/lib/greeting';
import { Card, CardContent } from '@/components/ui/Card';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { RoleDecisionQueue } from '@/components/RoleDecisionQueue';
import { MyPlanCard } from '@/components/MyPlanCard';
import { FloorTeamStrip, MyLeadStrip, useFloorTeam } from '@/components/FloorTeam';
import type { FloorSupervisorTeam } from '@/lib/shiftWindowsApi';
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
 *
 * The FLOOR_SUPERVISOR gets the same floor, watch-only: no schedule, no
 * approvals, no week ahead. In their place, their shift supervisor (on the
 * clock or not, one tap to message) and their shift's SOP — the lead's,
 * which they help on, or their own on a day they're covering. The shift
 * supervisor sees their floor supervisors and hands them the shift.
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

/**
 * The floor supervisor's Needs you: watch-only by design, so nothing here
 * is theirs to decide — but what IS waiting on them (a task the engine
 * queued for a person, a message) is counted and linked, the same row the
 * other homes carry, instead of a hole where the section should be.
 */
function WatchNeedsYou() {
  const { t } = useI18n();
  const inbox = useInbox();
  const waiting = (inbox.data?.sources ?? []).filter((s) => s.count > 0);
  if (inbox.isPending) return <Skeleton className="h-14" />;
  if (waiting.length === 0) {
    return (
      <Card>
        <CardContent className="p-4 text-sm text-ink-muted">{t('floor.watchNothingWaiting')}</CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <ul className="divide-y divide-line" aria-label={t('home.needsYou')}>
        {waiting.map((s) => (
          <li key={s.key}>
            <Link to={s.path} className="flex items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-surface-raised">
              <Badge variant="pending" size="sm" withDot={false} className="min-w-[2rem] justify-center tabular-nums">
                {s.count >= 999 ? '999+' : s.count}
              </Badge>
              <span className="min-w-0 flex-1 truncate text-ink">{s.label}</span>
              <ArrowRight className="h-3.5 w-3.5 text-ink-muted" aria-hidden="true" />
            </Link>
          </li>
        ))}
      </ul>
      <p className="px-4 pb-3 text-xs2 text-ink-muted">{t('floor.watchLeadDecides')}</p>
    </Card>
  );
}

export function SupervisorDashboard() {
  const { t } = useI18n();
  const term = useTerm();
  const greet = useGreeting();
  const { user, can } = useAuth();
  const queryClient = useQueryClient();
  const pullState = usePullToRefresh(() => queryClient.invalidateQueries());
  const client = boundedClientOf(user);
  // The floor supervisor: the same floor, no scheduling or approval reads.
  const watchOnly = user?.role === 'FLOOR_SUPERVISOR';
  // The floor from a phone (field roles, 2026-10): an incident filed the
  // moment it happens; a flag from the watch-only lead to their supervisor.
  const [incidentOpen, setIncidentOpen] = useState(false);
  const [flagOpen, setFlagOpen] = useState(false);
  const canReport = can('report:incident');
  const { windows: myWindows, focus, setFocus, mine } = useShiftFocus();
  const teamQuery = useFloorTeam();
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
    enabled: !watchOnly,
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
    enabled: !watchOnly,
    queryFn: () => getSchedulingKpis({ week: 'this' }),
  });
  const kpiLast = useQuery({
    queryKey: ['floor', 'kpis', 'last', todayKey],
    enabled: !watchOnly,
    queryFn: () => getSchedulingKpis({ week: 'last' }),
  });
  // The SOP their clock-in opened — on top of My floor until submitted.
  const sopQuery = useQuery({
    queryKey: ['ops', 'my-sop'],
    queryFn: getMySop,
    refetchInterval: 60_000,
  });
  // Off the clock: the shift starts here — clock in, and the SOP opens.
  const clock = useShiftClock();
  const approvalsQuery = useQuery({
    queryKey: ['floor', 'approvals-count'],
    queryFn: () => apiFetch<ApprovalsCount>('/approvals/count'),
    refetchInterval: 60_000,
    enabled: !watchOnly,
  });
  // Floor supervisor: their lead, and a day they're running the shift.
  const teamData = teamQuery.data;
  const floorTeam: FloorSupervisorTeam | null = teamData && teamData.role === 'floor' ? teamData : null;
  const leadFirst = floorTeam?.lead?.name.split(' ')[0] ?? null;
  const coveringToday = floorTeam?.covers.find((c) => c.today) ?? null;

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

  // Design system §4.1 (UX upgrade step 6, the sweep): the Home template.
  // The greeting is the title; the place, its client and address are the
  // subtitle; the live "as of" is the meta line; the floor is the hero.
  const name = greetingName(user, '');
  const greeting = (
    <>
      <LiveNow render={(now) => greet(now.getHours())} />
      {name && <>, <span className="text-accent">{name}</span></>}.
    </>
  );
  const clientLine = oneStore
    ? (data?.client.name ?? client?.name)
    : locations.length > 1
      ? plural(locations.length, term('site').toLowerCase(), term('sites').toLowerCase())
      : null;
  const subtitle = (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="font-medium text-ink">{placeName}</span>
      {clientLine && <span>{clientLine}</span>}
      {address && (
        <span className="flex items-center gap-1 text-ink-muted">
          <MapPin className="h-3 w-3" aria-hidden="true" />
          {address}
        </span>
      )}
    </span>
  );
  const meta = data ? (
    <span className="flex items-center gap-1.5 text-xs text-ink-muted">
      <span className="relative flex h-1.5 w-1.5" aria-hidden="true">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60 motion-reduce:hidden" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-success" />
      </span>
      {t('portal.asOf', { time: fmtTime(data.generatedAt) })}
    </span>
  ) : undefined;
  const primary = watchOnly ? (
    <Button size="sm" asChild>
      <Link to="/today">
        <Users className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
        {t('portal.todayNav')}
      </Link>
    </Button>
  ) : (
    <Button size="sm" asChild>
      <Link to="/scheduling">
        <CalendarDays className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
        Open schedule
      </Link>
    </Button>
  );
  // Ways in (§4.1): the places this person works from, after the decisions.
  const waysIn = (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" asChild>
        <Link to="/time-attendance">
          <Timer className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          Live board
        </Link>
      </Button>
      {!watchOnly && (
        <Button size="sm" variant="outline" asChild>
          <Link to="/today">
            <Users className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            {t('portal.todayNav')}
          </Link>
        </Button>
      )}
      <Button size="sm" variant="outline" asChild>
        <Link to="/ops">
          <ClipboardCheck className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          {t('floor.siteOps')}
        </Link>
      </Button>
      {!watchOnly && (
        <Button size="sm" variant="outline" asChild>
          <Link to="/approvals">Approvals</Link>
        </Button>
      )}
      {canReport && (
        <Button size="sm" variant="outline" onClick={() => setIncidentOpen(true)}>
          <ShieldAlert className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          Report an incident
        </Button>
      )}
      {watchOnly && canReport && (
        <Button size="sm" variant="outline" onClick={() => setFlagOpen(true)}>
          <Flag className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          Flag a no-show or hazard
        </Button>
      )}
    </div>
  );
  const floorDialogs = (
    <>
      {canReport && <IncidentReportDialog open={incidentOpen} onOpenChange={setIncidentOpen} />}
      {watchOnly && canReport && <FloorFlagDialog open={flagOpen} onOpenChange={setFlagOpen} />}
    </>
  );

  if (dayQuery.isError && !data) {
    return (
      <HomeTemplate
        title={greeting}
        topbarTitle={t('floor.title')}
        subtitle={subtitle}
        hero={
          <EmptyState
            icon={Users}
            title={t('portal.onFloorNow')}
            description={dayQuery.error instanceof ApiError ? dayQuery.error.message : t('portal.loadFailed')}
            action={
              <Button size="sm" variant="secondary" onClick={() => void dayQuery.refetch()}>
                {t('common.retry')}
              </Button>
            }
          />
        }
      />
    );
  }

  if (!data) {
    return (
      <HomeTemplate title={greeting} topbarTitle={t('floor.title')} subtitle={subtitle} hero={<Skeleton className="h-64" />}>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
        <Skeleton className="h-64" />
      </HomeTemplate>
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
  // Floor supervisor's strip: the floor today, and their shift's SOP.
  const notIn = focusRows.filter((r) => r.state === 'not-in').length;
  const openToday = focusRows.filter((r) => r.state === 'open').length;
  const runningSop = sopQuery.data?.sop ?? null;
  const helpingSop = sopQuery.data?.helping ?? null;
  const shiftSop = runningSop
    ? { id: runningSop.id, sopDone: runningSop.sopDone, sopTotal: runningSop.sopTotal, mine: true, runBy: '' }
    : helpingSop
      ? {
          id: helpingSop.id,
          sopDone: helpingSop.sopDone,
          sopTotal: helpingSop.sopTotal,
          mine: false,
          runBy: helpingSop.runBy.name.split(' ')[0] ?? helpingSop.runBy.name,
        }
      : null;

  // The interrupting banner (§4.1): the state of their own shift.
  const shiftBanner = sopQuery.data?.sop ? (
        <SopBanner sop={sopQuery.data.sop} />
      ) : clock.active && sopQuery.data?.submitted ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-success/40 bg-success/[0.06] p-4 animate-enter">
          <ClipboardCheck className="h-6 w-6 shrink-0 text-success" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-white">
              {t('floor.sopSubmitted', { window: sopQuery.data.submitted.windowLabel ?? sopQuery.data.submitted.position })}
            </div>
            <div className="mt-0.5 text-xs text-silver">
              {watchOnly ? t('floor.clockOutAtTablet') : t('floor.clockOutWhenDone')}
            </div>
          </div>
          {!watchOnly && (
            <Button variant="secondary" onClick={() => void clock.clockOutNow()} loading={clock.busy}>
              Clock out
            </Button>
          )}
        </div>
      ) : clock.active === null ? (
        <div
          className={cn(
            'flex flex-wrap items-center gap-3 rounded-lg border p-4 animate-enter',
            coveringToday ? 'border-gold/40 bg-gold/[0.06]' : 'border-navy-secondary bg-navy-secondary/20',
          )}
        >
          <Timer className={cn('h-6 w-6 shrink-0', coveringToday ? 'text-gold' : 'text-silver')} aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-white">
              {coveringToday
                ? `You're running ${coveringToday.leadName.split(' ')[0]}'s shift today`
                : "You're off the clock"}
            </div>
            <div className="mt-0.5 text-xs text-silver">
              {/* Floor supervisors punch at the store tablet only (the API
                  refuses app punches) — so no button here, just where. */}
              {coveringToday
                ? t('floor.clockInCovering')
                : watchOnly
                  ? t('floor.clockInHelping', { whose: leadFirst ? `${leadFirst}’s` : t('floor.yourShifts') })
                  : t('floor.clockInHereOrKiosk')}
            </div>
          </div>
          {!watchOnly && (
            <Button onClick={() => void clock.clockInNow()} loading={clock.busy}>
              Clock in
            </Button>
          )}
        </div>
      ) : watchOnly && sopQuery.data?.helping ? (
        <HelpingBanner sop={sopQuery.data.helping} />
      ) : watchOnly && clock.active ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-navy-secondary bg-navy-secondary/20 p-4 animate-enter">
          <ClipboardCheck className="h-6 w-6 shrink-0 text-silver" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-white">
              {leadFirst ? `${leadFirst}'s SOP opens when ${leadFirst} clocks in` : "Your shift's SOP isn't open yet"}
            </div>
            <div className="mt-0.5 text-xs text-silver">
              You help on it. If no shift supervisor is on the clock 30 minutes into the shift, it moves to you.
            </div>
          </div>
        </div>
      ) : null;

  return (
    <>
      <PullToRefreshIndicator state={pullState} />
      <HomeTemplate
        title={greeting}
        topbarTitle={t('floor.title')}
        subtitle={subtitle}
        meta={meta}
        actions={primary}
        banners={
          <>
            {/* The last shift's written handover — the lead coming on reads it first. */}
            <HandoverBanner />
            {shiftBanner}
          </>
        }
        hero={
          <div className="space-y-4">
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
                    <SectionTitle
                      as="h3"
                      className="mb-2"
                      title={t('portal.curveTitle')}
                      trailing={
                        <span className="text-xs tabular-nums text-ink-muted">
                          {t('portal.todayMeta', { filled: data.summary.expected, open: data.summary.open })}
                        </span>
                      }
                    />
                    <div>
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
          </div>
        }
        decisions={{ title: t('home.needsYou'), content: watchOnly ? <WatchNeedsYou /> : <RoleDecisionQueue title={null} /> }}
        assistant={<HugoSeat />}
        waysIn={waysIn}
      >
        {/* ---- KPI strip: the four numbers the week runs on ----------------- */}
        {watchOnly ? (
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4 animate-enter" style={enterStagger(1)}>
            <TileLink to="/today">
              <StatTile
                className="h-full"
                label={t('floor.notInYet')}
                value={notIn}
                sub={notIn === 0 ? t('floor.everyoneIn') : t('floor.noPunchYet')}
              />
            </TileLink>
            <StatTile
              label={t('floor.unfilledToday')}
              value={openToday}
              sub={openToday === 0 ? t('floor.everySlotFilled') : t('floor.openSlots')}
            />
            <StatTile
              label="Tomorrow · confirmed"
              value={tm === null ? '—' : tmTotal === 0 ? '—' : tmConfirmed}
              unit={tm !== null && tmTotal > 0 ? `/ ${tmTotal}` : undefined}
              meter={
                tmTotal > 0
                  ? { percent: Math.round((tmConfirmed / tmTotal) * 100), tone: tmOpen > 0 ? 'warn' : 'good' }
                  : null
              }
              sub={tm === null ? undefined : tmTotal === 0 ? t('portal.tomorrowNone') : t('portal.tomorrowAllSet')}
            />
            <TileLink to={shiftSop ? `/ops?tab=shift&shift=${shiftSop.id}` : '/ops'}>
              <StatTile
                className="h-full"
                label={t('floor.shiftSop')}
                value={shiftSop ? shiftSop.sopDone : '—'}
                unit={shiftSop ? `/ ${shiftSop.sopTotal}` : undefined}
                meter={
                  shiftSop && shiftSop.sopTotal > 0
                    ? {
                        percent: Math.round((shiftSop.sopDone / shiftSop.sopTotal) * 100),
                        tone: shiftSop.sopDone === shiftSop.sopTotal ? 'good' : 'primary',
                      }
                    : null
                }
                sub={
                  shiftSop
                    ? shiftSop.mine
                      ? 'Yours to submit'
                      : `${shiftSop.runBy} is running it`
                    : leadFirst
                      ? `Opens when ${leadFirst} clocks in`
                      : 'Not open yet'
                }
              />
            </TileLink>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4 animate-enter" style={enterStagger(1)}>
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
        )}

        {/* ---- From the floor: flags raised by a floor lead, open shifts to cover -- */}
        {!watchOnly && <FloorFlagsCard />}
        {!watchOnly && <CoverShiftCard />}
        {/* ---- The week, for the watch-only lead who sees only today and tomorrow -- */}
        {watchOnly && <FloorWeekStrip />}

        {/* ---- The floor team: who reports to them / who's in charge -------- */}
        {watchOnly ? <MyLeadStrip /> : <FloorTeamStrip />}

        {/* ---- Who's coming in on the vans (heads-up only) ----------------- */}
        <VanArrivalsCard />
        {/* Hires handed to this store with no first shift yet. */}
        <ReadyToScheduleCard />
        {/* Program dates (J-1 / H-2B) coming due for this floor. */}
        <ProgramAlertsCard />

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-12">
          {/* ---- Today by shift (the faces live on /today) ------------------- */}
          <Card
            className={cn('animate-enter md:col-span-2', watchOnly ? 'xl:col-span-7' : 'xl:col-span-5')}
            style={enterStagger(3)}
          >
            <CardContent className="p-5">
              <SectionTitle
                title={t('portal.todayByShift')}
                trailing={
                  <Link to="/today" className="text-xs text-accent underline-offset-2 hover:underline">
                    {t('portal.todayOpen')}
                  </Link>
                }
              />
              {waves.length === 0 ? (
                <p className="text-sm text-ink-muted">{mine ? t('focus.nothingToday') : t('portal.noShiftsToday')}</p>
              ) : (
                <ul className="space-y-3">
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
          {!watchOnly && (
            <Card className="animate-enter xl:col-span-7" style={enterStagger(4)}>
              <CardContent className="p-5">
                <SectionTitle
                  icon={CalendarDays}
                  title={
                    <>
                      Next 7 days
                      {mine && <span className="font-normal text-ink-muted"> · {focusName(myWindows)}</span>}
                    </>
                  }
                  trailing={
                    <Link to="/scheduling" className="text-xs text-accent underline-offset-2 hover:underline">
                      Open schedule
                    </Link>
                  }
                />
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
          )}

          {/* ---- Their own plan ---------------------------------------------- */}
          <div className={cn('animate-enter md:col-span-2', watchOnly ? 'xl:col-span-5' : 'xl:col-span-12')} style={enterStagger(5)}>
            <MyPlanCard />
          </div>
        </div>
      </HomeTemplate>
      {floorDialogs}
    </>
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
  const ended = sop.dueAt !== null && new Date(sop.dueAt).getTime() < Date.now();
  const late = sop.overdue ?? 0;
  const overdue = ended || late > 0;
  const block = sop.block ?? null;
  const blockLate = block !== null && Date.parse(block.dueAt) < Date.now();
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
          {sop.coveringFor
            ? `You're running ${sop.coveringFor.name.split(' ')[0]}'s ${sop.windowLabel ?? sop.position} SOP`
            : `Your ${sop.windowLabel ?? sop.position} SOP is open`}
        </div>
        {block && (
          <div className={cn('mt-0.5 truncate text-xs font-medium tabular-nums', blockLate ? 'text-alert' : 'text-gold')}>
            Now: {block.section ?? 'Next block'} · {block.open} left ·{' '}
            {blockLate ? `was due ${fmtTime(block.dueAt)}` : `due ${fmtTime(block.dueAt)}`}
          </div>
        )}
        <div className="mt-0.5 text-xs text-silver tabular-nums">
          {sop.sopDone} of {sop.sopTotal} done
          {late > 0 && <span className="text-alert"> · {late} overdue</span>}
          {sop.dueAt && (
            <span className={ended ? 'text-alert' : undefined}>
              {' '}· {ended ? 'was due' : 'due'} {fmtTime(sop.dueAt)}
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

/** A floor supervisor on the clock: the SOP they help on — check items
 *  off as they walk the floor; the one running it submits it. */
function HelpingBanner({ sop }: { sop: HelpingSop }) {
  const pct = sop.sopTotal > 0 ? Math.round((sop.sopDone / sop.sopTotal) * 100) : 0;
  const first = sop.runBy.name.split(' ')[0] ?? sop.runBy.name;
  return (
    <Link
      to={`/ops?tab=shift&shift=${sop.id}`}
      className="flex items-center gap-4 rounded-lg border border-gold/40 bg-gold/[0.06] p-4 transition-colors hover:bg-gold/10 animate-enter"
    >
      <ClipboardCheck className="h-6 w-6 shrink-0 text-gold" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-white">
          {first}&apos;s {sop.windowLabel ?? sop.position} SOP
        </div>
        <div className="mt-0.5 text-xs text-silver tabular-nums">
          {sop.sopDone} of {sop.sopTotal} done · check items off as you walk the floor — {first} submits it
        </div>
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-gold/15" aria-hidden="true">
          <div className="h-full rounded-full bg-gold" style={{ width: `${pct}%` }} />
        </div>
      </div>
      <span className="shrink-0 text-sm font-medium text-gold">Help →</span>
    </Link>
  );
}
