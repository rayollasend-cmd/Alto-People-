import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { usePullToRefresh, PullToRefreshIndicator } from '@/lib/usePullToRefresh';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  AlertCircle,
  ArrowLeftRight,
  ArrowRight,
  Building2,
  Calendar,
  CalendarOff,
  CheckCircle2,
  ClipboardList,
  Clock,
  Inbox,
  Store,
  Users,
  type LucideIcon,
} from 'lucide-react';
import type { ActiveDashboardEntry, Shift } from '@alto-people/shared';
import { useAuth } from '@/lib/auth';
import {
  fmtDate,
  fmtShiftRangeTz,
  fmtTime,
  ymdLocal,
  zonedDayKey,
} from '@/lib/format';
import { getActiveDashboard } from '@/lib/timeApi';
import {
  listAdminSwaps,
  listOpenShiftClaims,
  listShifts,
} from '@/lib/schedulingApi';
import { listAdminRequests } from '@/lib/timeOffApi';
import { useApprovalsCount } from '@/lib/useApprovalsCount';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/lib/cn';
import { RoleDecisionQueue } from '@/components/RoleDecisionQueue';

const greetingFor = (hour: number): string => {
  if (hour < 5) return 'Up late';
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  if (hour < 22) return 'Good evening';
  return 'Burning the midnight oil';
};

const firstNameFromEmail = (email: string): string => {
  const local = email.split('@')[0] ?? '';
  const first = local.split(/[._-]+/)[0] ?? local;
  return first ? first.charAt(0).toUpperCase() + first.slice(1) : 'there';
};

/**
 * Supervisor dashboard — the SHIFT_SUPERVISOR landing surface. Every
 * endpoint used here is already client-scoped server-side (the scope*
 * helpers pin the caller to their bound client), so this page just
 * composes "your site today": who's on the clock, today's shifts, open
 * coverage, and the decisions waiting in the approvals inbox.
 */
export function SupervisorDashboard() {
  const pullQueryClient = useQueryClient();
  const pullState = usePullToRefresh(() => pullQueryClient.invalidateQueries());
  const { user } = useAuth();
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

  const todayKey = ymdLocal();

  // One week of shifts starting at local midnight — today's list AND the
  // open-shift counts both derive from this single fetch.
  const shiftsQuery = useQuery({
    queryKey: ['supervisor', 'shifts', todayKey],
    queryFn: () => {
      const from = new Date();
      from.setHours(0, 0, 0, 0);
      const to = new Date(from.getTime() + 7 * 86_400_000);
      return listShifts({ from: from.toISOString(), to: to.toISOString() });
    },
  });
  // Live "who's on the clock" — refreshed every minute like the Time page.
  const activeQuery = useQuery({
    queryKey: ['supervisor', 'active-entries'],
    queryFn: async () => (await getActiveDashboard()).entries,
    refetchInterval: 60_000,
  });
  // Decision queues: swaps the peer already accepted (your call now),
  // pending open-shift pickups, and pending time-off requests.
  const swapsQuery = useQuery({
    queryKey: ['supervisor', 'swaps', 'PEER_ACCEPTED'],
    queryFn: async () =>
      (await listAdminSwaps({ status: 'PEER_ACCEPTED' })).requests,
  });
  const claimsQuery = useQuery({
    queryKey: ['supervisor', 'open-shift-claims'],
    queryFn: async () => (await listOpenShiftClaims()).claims,
  });
  const timeOffQuery = useQuery({
    queryKey: ['supervisor', 'timeoff', 'PENDING'],
    queryFn: async () => (await listAdminRequests('PENDING')).requests,
  });
  // Nav-badge hook (server-scoped /approvals/count) doubles as the KPI —
  // it polls, refreshes on focus, and never surfaces an error state.
  const approvalsTotal = useApprovalsCount();

  const shifts: Shift[] | null = shiftsQuery.data?.shifts ?? null;
  const activeEntries: ActiveDashboardEntry[] | null =
    activeQuery.data ?? null;

  // Today's shifts, bucketed by the STORE's calendar day (a shift is a UTC
  // instant but belongs to the site), sorted by start time.
  const todayShifts = useMemo(() => {
    if (!shifts) return null;
    return shifts
      .filter(
        (s) =>
          s.status !== 'CANCELLED' &&
          zonedDayKey(s.startsAt, s.timezone) === todayKey,
      )
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  }, [shifts, todayKey]);
  const openToday =
    todayShifts?.filter((s) => s.status === 'OPEN').length ?? 0;
  const openWeek = shifts?.filter((s) => s.status === 'OPEN').length ?? 0;

  // associateId → active entry, to mark "on the clock" rows.
  const activeByAssociate = useMemo(() => {
    const m = new Map<string, ActiveDashboardEntry>();
    for (const e of activeEntries ?? []) m.set(e.associateId, e);
    return m;
  }, [activeEntries]);

  const pendingSwaps = swapsQuery.data?.length ?? 0;
  const pendingPickups =
    claimsQuery.data?.filter((c) => c.status === 'PENDING').length ?? 0;
  const pendingTimeOff = timeOffQuery.data?.length ?? 0;

  const greetingName =
    user?.firstName?.trim() ||
    (user?.email ? firstNameFromEmail(user.email) : 'there');
  const greeting = greetingFor(now.getHours());
  const clientName = user?.clientName ?? null;

  return (
    <div className="mx-auto space-y-8">
      <PullToRefreshIndicator state={pullState} />
      {/* Greeting strip */}
      <header>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="text-xs2 uppercase tracking-[0.18em] text-silver flex items-center gap-2">
            <Calendar className="h-3 w-3" aria-hidden="true" />
            {fmtDate(now)}
          </div>
          <span className="inline-flex items-center gap-1 rounded-full border border-steel/60 bg-steel/20 px-2 py-0.5 text-2xs uppercase tracking-widest text-white">
            Supervisor view
          </span>
          {clientName && (
            <Badge variant="accent" className="tracking-widest">
              <Building2 className="h-3 w-3" aria-hidden="true" />
              {clientName}
            </Badge>
          )}
        </div>
        <h1 className="font-display text-3xl md:text-4xl text-white mt-2 leading-tight">
          {greeting}, <span className="text-gold">{greetingName}</span>.
        </h1>
        <p className="text-silver mt-2 text-sm md:text-base">
          Your site today — who&apos;s on, who&apos;s late, what&apos;s open.
        </p>
      </header>

      <RoleDecisionQueue />

      {/* KPI tiles */}
      <section aria-label="Site snapshot" className="space-y-3">
        <SectionTitle icon={Activity}>Site snapshot</SectionTitle>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {activeQuery.error ? (
            <QueryErrorCard
              label="On the clock now — failed to load"
              onRetry={() => void activeQuery.refetch()}
            />
          ) : activeEntries === null ? (
            <KpiSkeleton />
          ) : (
            <KpiTile
              icon={Clock}
              label="On the clock now"
              value={String(activeEntries.length)}
              hint={
                activeEntries.length === 0
                  ? 'No one clocked in right now.'
                  : activeEntries.some((e) => e.onBreak)
                    ? `${activeEntries.filter((e) => e.onBreak).length} on break`
                    : undefined
              }
              to="/time-attendance"
            />
          )}
          {shiftsQuery.error ? (
            <QueryErrorCard
              label="Today's shifts — failed to load"
              onRetry={() => void shiftsQuery.refetch()}
            />
          ) : todayShifts === null ? (
            <KpiSkeleton />
          ) : (
            <KpiTile
              icon={Calendar}
              label="Today's shifts"
              value={String(todayShifts.length)}
              hint={
                todayShifts.length === 0
                  ? 'Nothing scheduled today.'
                  : undefined
              }
              to="/scheduling"
            />
          )}
          {shiftsQuery.error ? (
            <QueryErrorCard
              label="Open shifts — failed to load"
              onRetry={() => void shiftsQuery.refetch()}
            />
          ) : shifts === null ? (
            <KpiSkeleton />
          ) : (
            <KpiTile
              icon={Store}
              label="Open shifts today"
              value={String(openToday)}
              hint={
                openWeek > 0
                  ? `${openWeek} open in the next 7 days`
                  : 'Week fully covered'
              }
              to="/scheduling"
            />
          )}
          {approvalsTotal === null ? (
            <KpiSkeleton />
          ) : (
            <KpiTile
              icon={Inbox}
              label="Pending approvals"
              value={String(approvalsTotal)}
              hint="Swaps, pickups, time off, timesheets"
              to="/approvals"
            />
          )}
        </div>
      </section>

      <TodaySection
        clientName={clientName}
        todayShifts={todayShifts}
        error={Boolean(shiftsQuery.error)}
        onRetry={() => void shiftsQuery.refetch()}
        activeByAssociate={activeByAssociate}
        nowMs={now.getTime()}
      />

      <DecisionsSection
        pendingSwaps={pendingSwaps}
        pendingPickups={pendingPickups}
        pendingTimeOff={pendingTimeOff}
        loading={
          (!swapsQuery.error && swapsQuery.data === undefined) ||
          (!claimsQuery.error && claimsQuery.data === undefined) ||
          (!timeOffQuery.error && timeOffQuery.data === undefined)
        }
        error={Boolean(
          swapsQuery.error ?? claimsQuery.error ?? timeOffQuery.error,
        )}
        onRetry={() => {
          if (swapsQuery.error) void swapsQuery.refetch();
          if (claimsQuery.error) void claimsQuery.refetch();
          if (timeOffQuery.error) void timeOffQuery.refetch();
        }}
      />
    </div>
  );
}

/* ========================= Today at {client} ============================= */

function TodaySection({
  clientName,
  todayShifts,
  error,
  onRetry,
  activeByAssociate,
  nowMs,
}: {
  clientName: string | null;
  todayShifts: Shift[] | null;
  error: boolean;
  onRetry: () => void;
  activeByAssociate: Map<string, ActiveDashboardEntry>;
  nowMs: number;
}) {
  const title = clientName ? `Today at ${clientName}` : 'Today at your site';
  return (
    <section aria-label={title} className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <SectionTitle icon={Users}>{title}</SectionTitle>
        <Link
          to="/scheduling"
          className="text-xs text-gold hover:text-gold-bright inline-flex items-center gap-1"
        >
          Open schedule
          <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
      <Card>
        <CardContent className="p-0">
          {error ? (
            <div className="p-6 text-center">
              <div role="alert" className="text-sm text-alert">
                Couldn&apos;t load today&apos;s shifts.
              </div>
              <Button
                variant="secondary"
                size="sm"
                className="mt-3"
                onClick={onRetry}
              >
                Retry
              </Button>
            </div>
          ) : todayShifts === null ? (
            <div className="p-5 space-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3">
                  <Skeleton className="h-9 w-9 rounded-full" />
                  <div className="flex-1">
                    <Skeleton className="h-3 w-2/3 mb-1.5" />
                    <Skeleton className="h-3 w-1/3" />
                  </div>
                </div>
              ))}
            </div>
          ) : todayShifts.length === 0 ? (
            <div className="p-6 text-center text-silver text-sm">
              No shifts scheduled today.{' '}
              <Link
                to="/scheduling"
                className="text-gold hover:text-gold-bright"
              >
                Plan the week
              </Link>
              .
            </div>
          ) : (
            <ul className="divide-y divide-navy-secondary">
              {todayShifts.map((s) => {
                const activeEntry = s.assignedAssociateId
                  ? activeByAssociate.get(s.assignedAssociateId)
                  : undefined;
                return (
                  <li
                    key={s.id}
                    className="px-5 py-3 flex items-center gap-3 hover:bg-navy-secondary/20 transition-colors"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-white truncate flex items-center gap-2">
                        {s.assignedAssociateName ??
                          (s.status === 'OPEN' ? (
                            <Badge variant="pending" size="sm">
                              Open
                            </Badge>
                          ) : (
                            'Unassigned'
                          ))}
                      </div>
                      <div className="text-xs2 text-silver/80 truncate tabular-nums">
                        {s.position} ·{' '}
                        {fmtShiftRangeTz(s.startsAt, s.endsAt, s.timezone)}
                        {s.locationName ? ` · ${s.locationName}` : ''}
                      </div>
                    </div>
                    <ShiftStatusPill
                      shift={s}
                      activeEntry={activeEntry}
                      nowMs={nowMs}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

function ShiftStatusPill({
  shift,
  activeEntry,
  nowMs,
}: {
  shift: Shift;
  activeEntry: ActiveDashboardEntry | undefined;
  nowMs: number;
}) {
  // Sentence-case status chips on the Badge variant contract: success =
  // live on the clock, default = finished, info = scheduled/upcoming.
  if (activeEntry) {
    return (
      <Badge variant="success" className="shrink-0 normal-case tracking-normal">
        On the clock · since {fmtTime(activeEntry.clockInAt)}
      </Badge>
    );
  }
  const ended =
    shift.status === 'COMPLETED' ||
    new Date(shift.endsAt).getTime() < nowMs;
  if (ended) {
    return (
      <Badge variant="default" className="shrink-0 normal-case tracking-normal">
        Done
      </Badge>
    );
  }
  return (
    <Badge variant="info" className="shrink-0 normal-case tracking-normal">
      Upcoming
    </Badge>
  );
}

/* ========================= Needs your decision =========================== */

function DecisionsSection({
  pendingSwaps,
  pendingPickups,
  pendingTimeOff,
  loading,
  error,
  onRetry,
}: {
  pendingSwaps: number;
  pendingPickups: number;
  pendingTimeOff: number;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
}) {
  if (error) {
    return (
      <section aria-label="Needs your decision" className="space-y-3">
        <SectionTitle icon={ClipboardList}>Needs your decision</SectionTitle>
        <QueryErrorCard
          label="Couldn't load your decision queues"
          onRetry={onRetry}
        />
      </section>
    );
  }
  if (loading) {
    return (
      <section aria-label="Needs your decision" className="space-y-3">
        <SectionTitle icon={ClipboardList}>Needs your decision</SectionTitle>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="pt-5">
                <Skeleton className="h-3 w-20 mb-3" />
                <Skeleton className="h-7 w-1/2 mb-2" />
                <Skeleton className="h-3 w-2/3" />
              </CardContent>
            </Card>
          ))}
        </div>
      </section>
    );
  }
  if (pendingSwaps === 0 && pendingPickups === 0 && pendingTimeOff === 0) {
    return (
      <section aria-label="Needs your decision">
        <Card className="border-success/30 bg-success/5">
          <CardContent className="py-5 flex items-center gap-3">
            <div className="h-10 w-10 rounded-full bg-success/15 grid place-items-center text-success shrink-0">
              <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
            </div>
            <div>
              <div className="text-white font-medium">Inbox zero</div>
              <div className="text-sm text-silver">
                No swaps, pickups, or time-off requests waiting on you.
              </div>
            </div>
          </CardContent>
        </Card>
      </section>
    );
  }
  return (
    <section aria-label="Needs your decision" className="space-y-3">
      <SectionTitle icon={ClipboardList}>Needs your decision</SectionTitle>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <DecisionCard
          icon={ArrowLeftRight}
          count={pendingSwaps}
          label={
            pendingSwaps === 1
              ? 'Swap awaiting approval'
              : 'Swaps awaiting approval'
          }
          hint="The peer already accepted — your call now."
          to="/approvals"
          cta="Open approvals"
          show={pendingSwaps > 0}
        />
        <DecisionCard
          icon={Store}
          count={pendingPickups}
          label={
            pendingPickups === 1
              ? 'Open-shift pickup requested'
              : 'Open-shift pickups requested'
          }
          hint="Approve to fill the shift."
          to="/approvals"
          cta="Open approvals"
          show={pendingPickups > 0}
        />
        <DecisionCard
          icon={CalendarOff}
          count={pendingTimeOff}
          label={
            pendingTimeOff === 1
              ? 'Time-off request waiting'
              : 'Time-off requests waiting'
          }
          hint="Decide before the requested dates."
          to="/time-off"
          cta="Open time off"
          show={pendingTimeOff > 0}
        />
      </div>
    </section>
  );
}

function DecisionCard({
  icon: Icon,
  count,
  label,
  hint,
  to,
  cta,
  show,
}: {
  icon: LucideIcon;
  count: number;
  label: string;
  hint?: string;
  to: string;
  cta: string;
  show: boolean;
}) {
  if (!show) return null;
  return (
    <Link
      to={to}
      className={cn(
        // Same elevation ladder as the AdminDashboard cards: rest at
        // elev-1, lift to elev-2 on hover.
        'group flex flex-col rounded-lg border bg-navy p-5 elev-1 transition-all',
        'border-warning/25 hover:border-warning/55',
        'hover:-translate-y-0.5 hover:elev-2',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright focus-visible:ring-offset-2 focus-visible:ring-offset-midnight',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="h-10 w-10 rounded-lg grid place-items-center shrink-0 bg-warning/15 text-warning">
          <Icon className="h-5 w-5" aria-hidden="true" />
        </div>
        <div className="font-display text-3xl tabular-nums leading-none text-warning">
          {count}
        </div>
      </div>
      <div className="mt-4 text-white font-medium leading-snug">{label}</div>
      {hint && <div className="mt-1 text-xs text-silver">{hint}</div>}
      <div className="mt-4 flex items-center gap-1 text-sm text-gold group-hover:text-gold-bright">
        {cta}
        <ArrowRight className="h-3.5 w-3.5 group-hover:translate-x-0.5 transition-transform" />
      </div>
    </Link>
  );
}

/* ============================ Shared bits ================================ */

function KpiTile({
  icon: Icon,
  label,
  value,
  hint,
  to,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  hint?: string;
  to: string;
}) {
  return (
    <Link
      to={to}
      className={cn(
        'group block rounded-lg border border-navy-secondary border-l-2 border-l-gold/40 bg-navy p-5 elev-1 transition-all',
        'hover:-translate-y-0.5 hover:border-l-gold-bright hover:elev-2',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright focus-visible:ring-offset-2 focus-visible:ring-offset-midnight',
      )}
    >
      <div className="flex items-center justify-between">
        {/* Canonical KPI label spec (matches MetricCard). */}
        <div className="text-xs2 font-medium uppercase tracking-[0.14em] text-silver/70">
          {label}
        </div>
        <Icon
          className="h-3.5 w-3.5 text-gold/70 group-hover:text-gold-bright transition-colors"
          aria-hidden="true"
        />
      </div>
      <div className="font-display text-3xl md:text-hero text-gold-bright mt-3 leading-none tabular-nums">
        {value}
      </div>
      {hint && <div className="text-xs text-silver mt-2 truncate">{hint}</div>}
    </Link>
  );
}

function KpiSkeleton() {
  return (
    <Card>
      <CardContent className="pt-5">
        <Skeleton className="h-3 w-20 mb-3" />
        <Skeleton className="h-9 w-1/2 mb-2" />
        <Skeleton className="h-3 w-1/3" />
      </CardContent>
    </Card>
  );
}

/**
 * Rendered in place of a card whose query failed. Deliberately NOT a
 * skeleton or a zero count — "0 on the clock" when the request never
 * landed is confidently wrong.
 */
function QueryErrorCard({
  label,
  onRetry,
}: {
  label: string;
  onRetry: () => void;
}) {
  return (
    <Card className="border-alert/40">
      <CardContent className="pt-5">
        <div role="alert" className="flex items-start gap-2 text-sm text-alert">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" aria-hidden="true" />
          <span>{label}</span>
        </div>
        <Button
          variant="secondary"
          size="sm"
          className="mt-3"
          onClick={onRetry}
        >
          Retry
        </Button>
      </CardContent>
    </Card>
  );
}

function SectionTitle({
  icon: Icon,
  children,
}: {
  icon: LucideIcon;
  children: React.ReactNode;
}) {
  return (
    <h2 className="text-xs uppercase tracking-[0.18em] text-silver/80 flex items-center gap-2">
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {children}
    </h2>
  );
}
