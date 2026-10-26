import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, CalendarDays, ClipboardCheck, Flag, MapPin, ShieldAlert, Timer, Users } from '@/components/ui/icons';
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
  fmtWeekday,
  parseYmd,
  ymdLocal,
  zonedDayKey,
  zonedMinutesOfDay,
  mapsUrl,
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
import { CrewSignalsCard } from '@/components/home/CrewSignalsCard';
import { EmptyState } from '@/components/ui/EmptyState';
import { useGreeting, greetingName } from '@/lib/greeting';
import { Card, CardContent } from '@/components/ui/Card';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { RoleDecisionQueue } from '@/components/RoleDecisionQueue';
import { MyPlanCard } from '@/components/MyPlanCard';
import { NotInYetCard } from '@/components/attendance/NotInYetCard';
import { FillRateTrendCard } from '@/components/attendance/FillRateTrendCard';
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
import { fmtClockMinute, fmtShiftWindow, isOpenShift, minuteOfDayInZone } from '@alto-people/shared';
import { CoverageGapNotice, coverageGaps } from '@/components/floor/CoverageGapNotice';
import { getCoverageAhead } from '@/lib/floorApi';
import { MetricCard } from '@/components/ui/MetricCard';
import '@/lib/i18n/en/floor';
import '@/lib/i18n/en/focus';
import '@/lib/i18n/en/home';
import '@/lib/i18n/en/notIn';
import '@/lib/i18n/en/portal';
import '@/lib/i18n/en/sup';
import '@/lib/i18n/en/tabs';

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
/** The KPI strip's desktop columns for the tiles it has (static, so Tailwind sees them). */
const KPI_XL_COLS: Record<number, string> = { 1: 'xl:grid-cols-1', 2: 'xl:grid-cols-2', 3: 'xl:grid-cols-3', 4: 'xl:grid-cols-4' };

/** The day's short name in the reader's language (fmtWeekday follows the chosen language). */
function weekdayShort(ymd: string): string {
  const d = parseYmd(ymd);
  // Noon, so a display zone a few hours off the device's can't move the day.
  return d ? fmtWeekday(new Date(d.getTime() + 12 * 3_600_000)) : '';
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * A store's shift name inside a sentence: "the swing target", "your swing
 * checklist" — not "the Swing target". The names come from one place, the
 * store's labeled shift windows (lib/shiftWindows on the server); only
 * capitalised words are lowered, so an acronym ("AM crew") keeps its case.
 */
function inSentence(label: string): string {
  return label.replace(/(^|[\s(/&+-])(\p{Lu})(\p{Ll}+)/gu, (_m, pre: string, a: string, rest: string) => `${pre}${a.toLowerCase()}${rest}`);
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
  const waiting = (inbox.data?.sources ?? []).filter((s) => s.count > 0 && !s.watching);
  if (inbox.isPending) return <Skeleton className="h-14" />;
  if (waiting.length === 0) {
    return (
      <Card>
        <CardContent className="text-sm text-ink-muted">{t('floor.watchNothingWaiting')}</CardContent>
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
  // Short vs contract over the next 7 days, on the windows this lead runs —
  // the same definition as the Needs-you coverage gap (lib/coverageGaps).
  const coverageAheadQuery = useQuery({
    queryKey: ['floor', 'coverage-ahead', todayKey],
    enabled: !watchOnly,
    queryFn: () => getCoverageAhead(7),
    staleTime: 60_000,
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
      // isOpenShift: OPEN and not over yet — the definition the schedule's
      // own count reads (KPIs' openUpcoming), so the two never disagree. A
      // shift that ended unfilled this morning isn't "open" any more.
      const now = new Date();
      const open = onDay.filter((s) => isOpenShift(s, now)).length;
      const unfilledPast = onDay.filter((s) => s.status === 'OPEN' && !isOpenShift(s, now)).length;
      return {
        date,
        day: weekdayShort(date),
        filled: onDay.length - open - unfilledPast,
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
        <a
          href={mapsUrl(address)}
          target="_blank"
          rel="noreferrer"
          className="flex min-w-0 max-w-full items-center gap-1 text-ink-muted hover:text-gold"
        >
          <MapPin className="h-3 w-3 shrink-0" aria-hidden="true" />
          <span className="truncate">{address}</span>
        </a>
      )}
    </span>
  );
  const meta = data ? (
    <span className="hidden items-center gap-1.5 text-xs text-ink-muted md:flex">
      <span className="relative flex h-1.5 w-1.5" aria-hidden="true">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60 motion-reduce:hidden" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-success" />
      </span>
      {t('portal.asOf', { time: fmtTime(data.generatedAt) })}
    </span>
  ) : undefined;
  // One gold action per screen: while the "Clock in" banner is up, it is the
  // primary and the schedule is a secondary way in.
  const clockInShown = !watchOnly && !sopQuery.data?.sop && clock.active === null;
  const primary = (
    <div className="flex items-center gap-2">
      {canReport && (
        <Button size="sm" variant="secondary" className="md:hidden" onClick={() => setIncidentOpen(true)} data-testid="header-report">
          <ShieldAlert className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          {t('sup.reportIncident')}
        </Button>
      )}
      {watchOnly ? (
        <Button size="sm" asChild className="hidden md:inline-flex">
          <Link to="/today">
            <Users className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            {t('portal.todayNav')}
          </Link>
        </Button>
      ) : (
        <Button size="sm" variant={clockInShown ? 'outline' : 'primary'} asChild className="hidden md:inline-flex">
          <Link to="/scheduling">
            <CalendarDays className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            {t('sup.openSchedule')}
          </Link>
        </Button>
      )}
    </div>
  );
  // Ways in (§4.1): the places this person works from, after the decisions.
  const waysIn = (
    <div className="flex flex-wrap gap-2">
      {/* The watch-only lead has the live board as a tab already. */}
      {!watchOnly && (
        <Button size="sm" variant="outline" asChild>
          <Link to="/time-attendance">
            <Timer className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            {t('tabs.liveBoard')}
          </Link>
        </Button>
      )}
      <Button size="sm" variant="outline" asChild>
        <Link to="/ops">
          <ClipboardCheck className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          {t('floor.siteOps')}
        </Link>
      </Button>
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
            description={dayQuery.error instanceof ApiError && dayQuery.error.status < 500 ? dayQuery.error.message : t('portal.loadFailed')}
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
    ? t('focus.windowTargetOf', { label: inSentence(focusName(runningNow)) })
    : t('portal.heroContracted');
  // Short-staffed windows today (their own windows; the store's contract
  // lines live on those windows). Said in Needs you, with the fix.
  const gaps = !watchOnly && data.date === data.today ? coverageGaps(data.roster, myWindows) : [];
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
  const cov = coverageAheadQuery.data ?? null;
  const filledAhead = aheadDays?.reduce((n, d) => n + d.filled, 0) ?? 0;
  // Nothing on the books for the week ahead, and the short-of-contract tile
  // already says by how much: the week card would only say it again.
  const aheadEmpty = aheadDays !== null && filledAhead + (openAhead ?? 0) === 0;
  const showToday = waves.length > 0;
  const showNext7 = !watchOnly && !(aheadEmpty && cov !== null && cov.windows > 0);
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

  // ---- KPI tiles ---------------------------------------------------------
  // Only the tiles with something to count (F500: "nothing is scheduled"
  // was said six times on one screen — two of them were tiles reading "—").
  const tomorrowTile =
    tm !== null && tmTotal > 0 ? (
      <StatTile
        label={t('sup.tomorrowConfirmed')}
        value={tmConfirmed}
        unit={`/ ${tmTotal}`}
        meter={{ percent: Math.round((tmConfirmed / tmTotal) * 100), tone: tmOpen > 0 ? 'warn' : 'good' }}
        sub={
          [
            tmOpen > 0 && t('portal.openCount', { count: tmOpen }),
            tmUnconfirmed > 0 && t('portal.awaiting', { count: tmUnconfirmed }),
          ]
            .filter(Boolean)
            .join(' · ') || t('portal.tomorrowAllSet')
        }
      />
    ) : null;
  const kpiTiles: Array<{ key: string; node: React.ReactNode }> = watchOnly
    ? [
        {
          key: 'not-in',
          node: (
            <TileLink to="/today">
              <StatTile
                className="h-full"
                label={t('floor.notInYet')}
                value={notIn}
                sub={notIn === 0 ? t('floor.everyoneIn') : t('floor.noPunchYet')}
              />
            </TileLink>
          ),
        },
        {
          key: 'unfilled',
          node: (
            <StatTile
              label={t('floor.unfilledToday')}
              value={openToday}
              sub={openToday === 0 ? t('floor.everySlotFilled') : t('floor.openSlots')}
            />
          ),
        },
        ...(tomorrowTile ? [{ key: 'tomorrow', node: tomorrowTile }] : []),
        ...(shiftSop
          ? [
              {
                key: 'checklist',
                node: (
                  <TileLink to={`/ops?tab=shift&shift=${shiftSop.id}`}>
                    <StatTile
                      className="h-full"
                      label={t('floor.shiftSop')}
                      value={shiftSop.sopDone}
                      unit={`/ ${shiftSop.sopTotal}`}
                      meter={
                        shiftSop.sopTotal > 0
                          ? {
                              percent: Math.round((shiftSop.sopDone / shiftSop.sopTotal) * 100),
                              tone: shiftSop.sopDone === shiftSop.sopTotal ? 'good' : 'primary',
                            }
                          : null
                      }
                      sub={shiftSop.mine ? t('sup.yoursToSubmit') : t('sup.runningIt', { name: shiftSop.runBy })}
                    />
                  </TileLink>
                ),
              },
            ]
          : []),
      ]
    : [
        ...(k && weekBase > 0
          ? [
              {
                key: 'fill',
                node: (
                  <StatTile
                    label={t('sup.fillRateWeek')}
                    value={`${k.fillRatePercent}%`}
                    delta={fillDelta !== null ? `${fillDelta > 0 ? '+' : ''}${fillDelta} ${t('portal.kpiPts')}` : null}
                    deltaTone={fillDelta === null || fillDelta === 0 ? 'neutral' : fillDelta > 0 ? 'good' : 'bad'}
                    meter={{ percent: k.fillRatePercent, tone: k.fillRatePercent >= 95 ? 'good' : k.fillRatePercent >= 85 ? 'primary' : 'warn' }}
                    sub={t('sup.shiftsFilled', { filled: filledWeek, total: weekBase })}
                  />
                ),
              },
            ]
          : []),
        ...(cov && cov.windows > 0
          ? [
              {
                key: 'short',
                node: (
                  // The contract, not just posted open shifts: "0 · Every shift
                  // covered" sat beside a hero reading "0 of 6 · 6 short".
                  <MetricCard
                    href="/scheduling"
                    cta={false}
                    className="h-full"
                    label={t('sup.shortNext7')}
                    value={cov.shortOfContract}
                    tone={cov.shortOfContract > 0 ? 'warning' : 'default'}
                    hint={
                      cov.shortOfContract === 0
                        ? t('sup.contractMet7')
                        : cov.openPosted > 0
                          ? t('sup.openPosted', { count: cov.openPosted })
                          : t('sup.noneOpenPosted')
                    }
                  />
                ),
              },
            ]
          : openAhead !== null && aheadDays && filledAhead + openAhead > 0
            ? [
                {
                  key: 'open',
                  node: (
                    // The tile counts open shifts: open the schedule on them.
                    <TileLink to="/scheduling?open=1">
                      <StatTile
                        className="h-full"
                        label={t('sup.openNext7')}
                        value={openAhead}
                        meter={
                          filledAhead + openAhead > 0
                            ? {
                                percent: Math.round((filledAhead / (filledAhead + openAhead)) * 100),
                                tone: openAhead > 0 ? 'warn' : 'good',
                              }
                            : null
                        }
                        sub={
                          openAhead === 0
                            ? t('sup.everyShiftCovered')
                            : t('sup.todayTomorrow', { today: aheadDays[0]!.open, tomorrow: aheadDays[1]!.open })
                        }
                      />
                    </TileLink>
                  ),
                },
              ]
            : []),
        ...(tomorrowTile ? [{ key: 'tomorrow', node: tomorrowTile }] : []),
        ...(ap
          ? [
              {
                key: 'waiting',
                node: (
                  <TileLink to="/approvals">
                    <StatTile
                      className="h-full"
                      label={t('sup.waitingOnYou')}
                      value={ap.total}
                      sub={
                        ap.total === 0
                          ? t('sup.nothingWaiting')
                          : [
                              ap.clockIns > 0 && t(ap.clockIns === 1 ? 'sup.oneWalkIn' : 'sup.nWalkIns', { n: ap.clockIns }),
                              ap.swaps > 0 && t(ap.swaps === 1 ? 'sup.oneSwap' : 'sup.nSwaps', { n: ap.swaps }),
                              ap.pickups > 0 && t(ap.pickups === 1 ? 'sup.onePickup' : 'sup.nPickups', { n: ap.pickups }),
                              ap.timeOff > 0 && t('sup.nTimeOff', { n: ap.timeOff }),
                              ap.timesheets > 0 && t(ap.timesheets === 1 ? 'sup.oneTimesheet' : 'sup.nTimesheets', { n: ap.timesheets }),
                            ]
                              .filter(Boolean)
                              .join(' · ')
                      }
                    />
                  </TileLink>
                ),
              },
            ]
          : []),
      ];

  // The interrupting banner (§4.1): the state of their own shift.
  const shiftBanner = sopQuery.data?.sop ? (
        <SopBanner sop={sopQuery.data.sop} />
      ) : clock.active && sopQuery.data?.submitted ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-success/40 bg-success/[0.06] p-4 animate-enter">
          <ClipboardCheck className="h-6 w-6 shrink-0 text-success" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-white">
              {t('floor.sopSubmitted', { window: inSentence(sopQuery.data.submitted.windowLabel ?? sopQuery.data.submitted.position) })}
            </div>
            <div className="mt-0.5 text-xs text-silver">
              {watchOnly ? t('floor.clockOutAtTablet') : t('floor.clockOutWhenDone')}
            </div>
          </div>
          {!watchOnly && (
            <Button variant="secondary" onClick={() => void clock.clockOutNow()} loading={clock.busy}>
              {t('sup.clockOut')}
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
                ? t('sup.runningShiftToday', { name: coveringToday.leadName.split(' ')[0] ?? coveringToday.leadName })
                : t('sup.offClock')}
            </div>
            <div className="mt-0.5 text-xs text-silver">
              {/* Floor supervisors punch at the store tablet only (the API
                  refuses app punches) — so no button here, just where. */}
              {coveringToday
                ? t('floor.clockInCoveringList')
                : watchOnly
                  ? t('floor.clockInHelping', { whose: leadFirst ? `${leadFirst}’s` : t('floor.yourShifts') })
                  : t('floor.clockInHereOrKiosk')}
            </div>
          </div>
          {!watchOnly && (
            <Button onClick={() => void clock.clockInNow()} loading={clock.busy}>
              {t('sup.clockIn')}
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
              {leadFirst ? t('sup.listOpensWhen', { name: leadFirst }) : t('sup.listNotOpen')}
            </div>
            <div className="mt-0.5 text-xs text-silver">
              {t('sup.sopHelpBody')}
            </div>
          </div>
        </div>
      ) : null;

  return (
    <>
      {clock.breakPrompt}
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
              <CardContent className="relative space-y-4">
                <div className="grid gap-5 md:grid-cols-12">
                  {/* Nothing on today's roster: the count and its one line are
                      the whole story — no second column saying it again. */}
                  <div className={data.roster.length === 0 ? 'md:col-span-12' : 'md:col-span-4'}>
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
                      {/* Phone: the live "as of" rides in the hero, not above it. */}
                      <span className="ml-auto text-2xs font-normal normal-case tracking-normal text-ink-muted md:hidden" data-testid="hero-asof">
                        {t('portal.asOf', { time: fmtTime(data.generatedAt) })}
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
                        ? t(nextScheduled === 0 ? 'focus.startsAtNone' : 'focus.startsAt', {
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
                  {data.roster.length > 0 && (
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
                          empty: t('portal.chartNothing'),
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
                  )}
                </div>
                {/* ---- Not in yet: started, no punch — call, text, or cover.
                     Part of today's floor, and only there once someone is
                     actually missing: the line above already says when the
                     shift starts, or that everyone is in. ---- */}
                <NotInYetCard
                  bare
                  className="border-t border-line pt-4"
                  canCover={!watchOnly}
                  filter={mine ? (p) => inWindows({ locationId: p.siteId, startsAt: p.startsAt, timezone: p.timezone }, myWindows) : undefined}
                />
              </CardContent>
            </Card>
          </div>
        }
        decisions={{
          title: t('home.needsYou'),
          // Counted as shown: the queue's rows and the coverage-gap cards — a
          // gap that is also a queue row (same key) once, not twice.
          queue: !watchOnly,
          cardKeys: watchOnly ? undefined : gaps.map((g) => `coverage:${g.window.locationId}:${g.window.label}`),
          content: watchOnly ? (
            <WatchNeedsYou />
          ) : (
            <>
              <CoverageGapNotice gaps={gaps} today={todayKey} />
              {/* With a gap above it, an empty queue says nothing — not "all clear". */}
              {/* The gap cards above ARE the queue's coverage items: shown once (F500 SH-4). */}
              <RoleDecisionQueue title={null} hideWhenEmpty={gaps.length > 0} excludeKeyPrefix={gaps.length > 0 ? 'coverage:' : undefined} />
            </>
          ),
        }}
        assistant={<HugoSeat />}
        waysIn={waysIn}
      >
        {/* ---- The crew: call-outs and who might leave ------------------- */}
        {!watchOnly && <CrewSignalsCard className="animate-enter" />}
        {/* ---- KPI strip: the numbers the week runs on. A tile with nothing
             to count ("—") is left out, not drawn empty: the hero and Needs
             you already say what is not scheduled. ------------------------ */}
        {kpiTiles.length > 0 && (
          <div className={cn('grid grid-cols-2 gap-3 animate-enter', KPI_XL_COLS[kpiTiles.length])} style={enterStagger(1)} data-testid="floor-kpis">
            {kpiTiles.map((tile, i) => (
              <div
                key={tile.key}
                className={cn('min-w-0 [&>*]:h-full', kpiTiles.length % 2 === 1 && i === kpiTiles.length - 1 && 'col-span-2 xl:col-span-1')}
              >
                {tile.node}
              </div>
            ))}
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
          {/* ---- Today by shift (the faces live on /today). Nothing today:
               the hero says so, once — no card to say it again. ------------ */}
          {showToday && (
          <Card
            className={cn('animate-enter md:col-span-2', watchOnly ? 'xl:col-span-7' : showNext7 ? 'xl:col-span-5' : 'xl:col-span-12')}
            style={enterStagger(3)}
          >
            <CardContent>
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
          )}

          {/* ---- The next seven days: fill by day ---------------------------- */}
          {showNext7 && (
            <Card className={cn('animate-enter', showToday ? 'xl:col-span-7' : 'md:col-span-2 xl:col-span-12')} style={enterStagger(4)}>
              <CardContent>
                <SectionTitle
                  icon={CalendarDays}
                  title={
                    <>
                      {t('sup.next7')}
                      {mine && <span className="font-normal text-ink-muted"> · {focusName(myWindows)}</span>}
                    </>
                  }
                  trailing={
                    <Link to="/scheduling" className="text-xs text-accent underline-offset-2 hover:underline">
                      {t('sup.openSchedule')}
                    </Link>
                  }
                />
                {aheadDays === null ? (
                  <Skeleton className="mt-3 h-40" />
                ) : aheadEmpty ? (
                  // Only without a contract to measure against (with one, the
                  // short-of-contract tile above already says it).
                  <p className="mt-2 text-sm text-ink-muted">{t('sup.nothingNext7')}</p>
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
                        ? t('sup.nothingNext7')
                        : t('sup.nOfFilled', { filled: filledAhead, total: filledAhead + (openAhead ?? 0) })}
                      {openAhead ? <span className="text-alert"> · {t('portal.openCount', { count: openAhead })}</span> : null}
                    </p>
                    <DetailsTable
                      label={t('portal.details')}
                      columns={[t('sup.day'), t('portal.chartFilled'), t('portal.chartOpen')]}
                      rows={aheadDays.map((d) => [fmtDate(parseYmd(d.date)), d.filled, d.open])}
                    />
                  </>
                )}
              </CardContent>
            </Card>
          )}

          {/* ---- Their own plan ---------------------------------------------- */}
          <div className={cn('animate-enter md:col-span-2', watchOnly && showToday ? 'xl:col-span-5' : 'xl:col-span-12')} style={enterStagger(5)}>
            <MyPlanCard />
          </div>

          {/* ---- Fill rate, eight workweeks, against the 95% line — the look
               back comes after today and the plan, not before them. ---------- */}
          {!watchOnly && <FillRateTrendCard className="animate-enter md:col-span-2 xl:col-span-12" />}
        </div>
      </HomeTemplate>
      {canReport && (
        // One tap from anywhere on a long page: what happens on the floor
        // gets reported the moment it happens, not after seven scrolls.
        <div
          className="pointer-events-none sticky bottom-4 z-20 hidden justify-end px-4 md:flex"
          data-testid="floor-actions"
        >
          <div className="pointer-events-auto flex gap-2 rounded-full border border-line bg-surface/95 p-1.5 shadow-lg backdrop-blur">
            <Button size="sm" variant="secondary" className="rounded-full" onClick={() => setIncidentOpen(true)}>
              <ShieldAlert className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              {t('sup.reportIncident')}
            </Button>
            {watchOnly && (
              <Button size="sm" variant="secondary" className="rounded-full" onClick={() => setFlagOpen(true)}>
                <Flag className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                {t('sup.raiseFlag')}
              </Button>
            )}
          </div>
        </div>
      )}
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
  const { t } = useI18n();
  const pct = sop.sopTotal > 0 ? Math.round((sop.sopDone / sop.sopTotal) * 100) : 0;
  const ended = sop.dueAt !== null && new Date(sop.dueAt).getTime() < Date.now();
  const late = sop.overdue ?? 0;
  const overdue = ended || late > 0;
  const block = sop.block ?? null;
  const blockLate = block !== null && Date.parse(block.dueAt) < Date.now();
  // An SOP opened on another day says which day — "was due 8:00 PM" alone
  // read as tonight on an SOP left open a month ago.
  const openedDay = ymdLocal(new Date(sop.openedAt));
  const notToday = openedDay !== ymdLocal();
  const dayLabel = notToday ? fmtDate(new Date(sop.openedAt)) : null;
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
            ? t('sup.listRunningFor', { name: sop.coveringFor.name.split(' ')[0] ?? sop.coveringFor.name, window: inSentence(sop.windowLabel ?? sop.position) })
            : t('sup.sopOpen', { window: inSentence(sop.windowLabel ?? sop.position) })}
          {dayLabel && <span className="text-alert"> · {t('sup.fromDay', { day: dayLabel })}</span>}
        </div>
        {block && (
          <div className={cn('mt-0.5 truncate text-xs font-medium tabular-nums', blockLate ? 'text-alert' : 'text-gold')}>
            {t('sup.blockNow', { section: block.section ?? t('sup.nextBlock'), left: block.open })} ·{' '}
            {blockLate ? t('sup.wasDue', { when: fmtTime(block.dueAt) }) : t('sup.due', { when: fmtTime(block.dueAt) })}
          </div>
        )}
        <div className="mt-0.5 text-xs text-silver tabular-nums">
          {t('sup.nOfDone', { done: sop.sopDone, total: sop.sopTotal })}
          {late > 0 && <span className="text-alert"> · {t('sup.nOverdue', { n: late })}</span>}
          {sop.dueAt && (
            <span className={ended ? 'text-alert' : undefined}>
              {' '}· {(ended ? t('sup.wasDue', { when: `${notToday ? `${dayLabel}, ` : ''}${fmtTime(sop.dueAt)}` }) : t('sup.due', { when: `${notToday ? `${dayLabel}, ` : ''}${fmtTime(sop.dueAt)}` }))}
            </span>
          )}
          {' '}· {t('sup.submitBeforeClockOut')}
        </div>
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-gold/15" aria-hidden="true">
          <div className={cn('h-full rounded-full', overdue ? 'bg-alert' : 'bg-gold')} style={{ width: `${pct}%` }} />
        </div>
      </div>
      <span className="shrink-0 text-sm font-medium text-gold">{t('sup.continue')} →</span>
    </Link>
  );
}

/** A floor supervisor on the clock: the SOP they help on — check items
 *  off as they walk the floor; the one running it submits it. */
function HelpingBanner({ sop }: { sop: HelpingSop }) {
  const { t } = useI18n();
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
          {t('sup.theirList', { name: first, window: inSentence(sop.windowLabel ?? sop.position) })}
        </div>
        <div className="mt-0.5 text-xs text-silver tabular-nums">
          {t('sup.nOfDone', { done: sop.sopDone, total: sop.sopTotal })} · {t('sup.helpCheckOff', { name: first })}
        </div>
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-gold/15" aria-hidden="true">
          <div className="h-full rounded-full bg-gold" style={{ width: `${pct}%` }} />
        </div>
      </div>
      <span className="shrink-0 text-sm font-medium text-gold">{t('sup.help')} →</span>
    </Link>
  );
}
