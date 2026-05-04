import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  ArrowRight,
  Calendar,
  CalendarOff,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ClipboardList,
  Clock,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { ApiError } from '@/lib/api';
import {
  getTeamDashboard,
  listReports,
  listTeamTimeOff,
  listTeamTimesheets,
  type DirectReport,
  type TeamDashboard,
  type TeamTimeEntry,
  type TeamTimeOffRequest,
} from '@/lib/teamApi';
import { Avatar } from '@/components/ui/Avatar';
import { Card, CardContent } from '@/components/ui/Card';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/lib/cn';

const fmtRelative = (iso: string): string => {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
};

const fmtHM = (mins: number): string => {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
};

const fmtDateRange = (start: string, end: string): string => {
  const a = new Date(start);
  const b = new Date(end);
  const sameDay = a.toDateString() === b.toDateString();
  const opt: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  return sameDay
    ? a.toLocaleDateString('en-US', opt)
    : `${a.toLocaleDateString('en-US', opt)} – ${b.toLocaleDateString('en-US', opt)}`;
};

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

const CATEGORY_LABEL: Record<string, string> = {
  SICK: 'Sick',
  VACATION: 'Vacation',
  PTO: 'PTO',
  BEREAVEMENT: 'Bereavement',
  JURY_DUTY: 'Jury duty',
  OTHER: 'Other',
};

/**
 * Manager dashboard. All data is direct-report-scoped on the server
 * (`managerId == req.user.associateId`). Surfaces what a line manager
 * actually needs to act on: pending timesheet approvals, pending PTO
 * requests, and a roster of direct reports with current status.
 */
export function ManagerDashboard() {
  const { user } = useAuth();
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

  // The five team queries run in parallel via useQuery — same wire shape
  // as the previous Promise.all, but each result is independently cached
  // so revisiting the page is instant.
  const summaryQuery = useQuery({
    queryKey: ['team', 'dashboard'],
    queryFn: () => getTeamDashboard(),
  });
  const reportsQuery = useQuery({
    queryKey: ['team', 'reports'],
    queryFn: async () => (await listReports()).reports,
  });
  const activeQuery = useQuery({
    queryKey: ['team', 'timesheets', 'ACTIVE'],
    queryFn: async () => (await listTeamTimesheets('ACTIVE')).entries,
  });
  const pendingTimesheetsQuery = useQuery({
    queryKey: ['team', 'timesheets', 'COMPLETED'],
    queryFn: async () => (await listTeamTimesheets('COMPLETED')).entries,
  });
  const pendingPtoQuery = useQuery({
    queryKey: ['team', 'timeoff', 'PENDING'],
    queryFn: async () => (await listTeamTimeOff('PENDING')).requests,
  });

  const summary: TeamDashboard | null = summaryQuery.data ?? null;
  const reports: DirectReport[] | null = reportsQuery.data ?? null;
  const activeEntries: TeamTimeEntry[] | null = activeQuery.data ?? null;
  const pendingTimesheets: TeamTimeEntry[] | null =
    pendingTimesheetsQuery.data ?? null;
  const pendingPto: TeamTimeOffRequest[] | null =
    pendingPtoQuery.data ?? null;

  // Only the two essential queries surface a banner. The other three are
  // best-effort (mirror previous .catch(() => empty) behaviour).
  const fatalErr = summaryQuery.error ?? reportsQuery.error;
  const error = fatalErr
    ? fatalErr instanceof ApiError
      ? fatalErr.message
      : 'Failed to load team data.'
    : null;

  const greetingName = user?.email ? firstNameFromEmail(user.email) : 'there';
  const greeting = greetingFor(now.getHours());
  const dateLabel = now.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

  // Index of associateId → active time entry (so we can mark "on the
  // clock" badges in the team list).
  const activeByReport = useMemo(() => {
    const m = new Map<string, TeamTimeEntry>();
    for (const e of activeEntries ?? []) m.set(e.associateId, e);
    return m;
  }, [activeEntries]);

  return (
    <div className="max-w-7xl mx-auto space-y-8">
      {/* Greeting */}
      <header>
        <div className="text-[11px] uppercase tracking-[0.18em] text-silver/70 flex items-center gap-2">
          <Calendar className="h-3 w-3" aria-hidden="true" />
          {dateLabel}
          <span className="text-silver/30">·</span>
          <span className="text-silver">Manager view</span>
        </div>
        <h1 className="font-display text-3xl md:text-4xl text-white mt-2 leading-tight">
          {greeting}, <span className="text-gold">{greetingName}</span>.
        </h1>
        <p className="text-silver mt-2 text-sm md:text-base">
          {summary && summary.directReports > 0
            ? `You have ${summary.directReports} direct ${summary.directReports === 1 ? 'report' : 'reports'} on your team.`
            : 'Your team-scoped overview.'}
        </p>
      </header>

      {error && <ErrorBanner>{error}</ErrorBanner>}

      <ApprovalsSection
        pendingTimesheets={pendingTimesheets}
        pendingPto={pendingPto}
      />

      <TeamSnapshot summary={summary} activeCount={activeByReport.size} />

      <TeamRoster
        reports={reports}
        activeByReport={activeByReport}
        pendingPto={pendingPto}
      />
    </div>
  );
}

/* ============================ Approvals ================================== */

function ApprovalsSection({
  pendingTimesheets,
  pendingPto,
}: {
  pendingTimesheets: TeamTimeEntry[] | null;
  pendingPto: TeamTimeOffRequest[] | null;
}) {
  const tsCount = pendingTimesheets?.length ?? 0;
  const ptoCount = pendingPto?.length ?? 0;
  const loading = pendingTimesheets === null || pendingPto === null;

  if (loading) {
    return (
      <section aria-label="Pending approvals" className="space-y-3">
        <SectionTitle icon={ClipboardList}>Needs your approval</SectionTitle>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {Array.from({ length: 2 }).map((_, i) => (
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

  if (tsCount === 0 && ptoCount === 0) {
    return (
      <section aria-label="Pending approvals">
        <Card className="border-success/30 bg-success/5">
          <CardContent className="py-5 flex items-center gap-3">
            <div className="h-10 w-10 rounded-full bg-success/15 grid place-items-center text-success shrink-0">
              <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
            </div>
            <div>
              <div className="text-white font-medium">Inbox zero</div>
              <div className="text-sm text-silver">
                No timesheets or time-off requests waiting on you. Nice.
              </div>
            </div>
          </CardContent>
        </Card>
      </section>
    );
  }

  return (
    <section aria-label="Pending approvals" className="space-y-3">
      <SectionTitle icon={ClipboardList}>Needs your approval</SectionTitle>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <ApprovalCard
          icon={Clock}
          count={tsCount}
          label={tsCount === 1 ? 'Timesheet to review' : 'Timesheets to review'}
          hint="Approve so payroll can include the hours."
          to="/team"
          cta="Open queue"
          severity={tsCount > 10 ? 'urgent' : 'attention'}
          show={tsCount > 0}
        />
        <ApprovalCard
          icon={CalendarOff}
          count={ptoCount}
          label={
            ptoCount === 1
              ? 'Time-off request waiting'
              : 'Time-off requests waiting'
          }
          hint="Approve or deny before the requested dates."
          to="/team"
          cta="Open requests"
          severity={ptoCount > 5 ? 'urgent' : 'attention'}
          show={ptoCount > 0}
        />
      </div>
    </section>
  );
}

function ApprovalCard({
  icon: Icon,
  count,
  label,
  hint,
  to,
  cta,
  severity,
  show,
}: {
  icon: LucideIcon;
  count: number;
  label: string;
  hint?: string;
  to: string;
  cta: string;
  severity: 'attention' | 'urgent';
  show: boolean;
}) {
  if (!show) return null;
  const tone =
    severity === 'urgent'
      ? {
          ring: 'border-alert/30 hover:border-alert/60',
          dot: 'bg-alert/15 text-alert',
          count: 'text-alert',
        }
      : {
          ring: 'border-amber-500/25 hover:border-amber-500/55',
          dot: 'bg-amber-500/15 text-amber-400',
          count: 'text-amber-300',
        };
  return (
    <Link
      to={to}
      className={cn(
        'group flex flex-col rounded-lg border bg-navy p-5 transition-all',
        'hover:-translate-y-0.5 hover:shadow-lg hover:shadow-black/20',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright focus-visible:ring-offset-2 focus-visible:ring-offset-midnight',
        tone.ring,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div
          className={cn(
            'h-10 w-10 rounded-lg grid place-items-center shrink-0',
            tone.dot,
          )}
        >
          <Icon className="h-5 w-5" aria-hidden="true" />
        </div>
        <div
          className={cn(
            'font-display text-3xl tabular-nums leading-none',
            tone.count,
          )}
        >
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

/* =========================== Team snapshot KPIs ========================== */

function TeamSnapshot({
  summary,
  activeCount,
}: {
  summary: TeamDashboard | null;
  activeCount: number;
}) {
  return (
    <section aria-label="Team snapshot" className="space-y-3">
      <SectionTitle icon={Activity}>Team snapshot</SectionTitle>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {summary ? (
          <>
            <KpiTile
              icon={Users}
              label="Direct reports"
              value={summary.directReports.toLocaleString()}
              hint={
                summary.directReports === 0
                  ? 'No one currently reports to you.'
                  : undefined
              }
            />
            <KpiTile
              icon={Clock}
              label="On the clock now"
              value={activeCount.toLocaleString()}
              hint={
                summary.directReports > 0
                  ? `${activeCount} of ${summary.directReports}`
                  : undefined
              }
            />
            <KpiTile
              icon={Clock}
              label="Pending timesheets"
              value={summary.pendingTimesheets.toLocaleString()}
              hint={
                summary.pendingTimesheets === 0 ? 'Inbox clear.' : undefined
              }
            />
            <KpiTile
              icon={CalendarOff}
              label="Pending time-off"
              value={summary.pendingTimeOff.toLocaleString()}
              hint={summary.pendingTimeOff === 0 ? 'Nothing waiting.' : undefined}
            />
          </>
        ) : (
          Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="pt-5">
                <Skeleton className="h-3 w-20 mb-3" />
                <Skeleton className="h-9 w-1/2 mb-2" />
                <Skeleton className="h-3 w-1/3" />
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </section>
  );
}

function KpiTile({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <Card className="hover:border-gold/30 transition-colors">
      <CardContent className="pt-5">
        <div className="flex items-center justify-between">
          <div className="text-[10px] md:text-[11px] uppercase tracking-[0.15em] text-silver">
            {label}
          </div>
          <Icon className="h-3.5 w-3.5 text-silver/70" aria-hidden="true" />
        </div>
        <div className="font-display text-3xl md:text-[2rem] text-white mt-3 leading-none tabular-nums">
          {value}
        </div>
        {hint && (
          <div className="text-xs text-silver/80 mt-2 truncate">{hint}</div>
        )}
      </CardContent>
    </Card>
  );
}

/* ============================== Team roster ============================== */

const TODAY_KEY = () => {
  const d = new Date();
  return d.toISOString().slice(0, 10);
};

const TEAM_ROSTER_PREVIEW = 8;

function TeamRoster({
  reports,
  activeByReport,
  pendingPto,
}: {
  reports: DirectReport[] | null;
  activeByReport: Map<string, TeamTimeEntry>;
  pendingPto: TeamTimeOffRequest[] | null;
}) {
  const [expanded, setExpanded] = useState(false);

  // Mark anyone with a PENDING PTO that overlaps today so the manager
  // sees "out today (pending)" status. Approved PTO would use a
  // different feed; for v1 this is the most useful signal.
  const pendingPtoToday = useMemo(() => {
    const today = TODAY_KEY();
    const out = new Set<string>();
    for (const r of pendingPto ?? []) {
      if (r.startDate <= today && r.endDate >= today) {
        out.add(r.associateId);
      }
    }
    return out;
  }, [pendingPto]);

  return (
    <section aria-label="My team" className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <SectionTitle icon={Users}>My team</SectionTitle>
        <Link
          to="/team"
          className="text-xs text-gold hover:text-gold-bright inline-flex items-center gap-1"
        >
          Open team page
          <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
      <Card>
        <CardContent className="p-0">
          {reports === null ? (
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
          ) : reports.length === 0 ? (
            <div className="p-6 text-center text-silver text-sm">
              No direct reports linked yet. Once HR sets your associates'
              <code className="mx-1 px-1 rounded bg-navy-secondary/40 text-silver text-xs">
                managerId
              </code>
              to your associate ID, they'll show up here.
            </div>
          ) : (
            <>
              <ul className="divide-y divide-navy-secondary/60">
                {(expanded
                  ? reports
                  : reports.slice(0, TEAM_ROSTER_PREVIEW)
                ).map((r) => {
                  const active = activeByReport.get(r.id);
                  const isPto = pendingPtoToday.has(r.id);
                  return (
                    <li
                      key={r.id}
                      className="px-5 py-3 flex items-center gap-3 hover:bg-navy-secondary/20 transition-colors"
                    >
                      <Avatar
                        name={`${r.firstName} ${r.lastName}`}
                        email={r.email}
                        size="sm"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-white truncate">
                          {r.firstName} {r.lastName}
                        </div>
                        <div className="text-[11px] text-silver/80 truncate">
                          {r.jobTitle ?? '—'}
                          {r.departmentName ? ` · ${r.departmentName}` : ''}
                        </div>
                      </div>
                      <StatusPill active={active} pto={isPto} />
                    </li>
                  );
                })}
              </ul>
              {reports.length > TEAM_ROSTER_PREVIEW && (
                <div className="px-5 py-3 flex justify-center border-t border-navy-secondary/60">
                  <button
                    type="button"
                    onClick={() => setExpanded((v) => !v)}
                    className="inline-flex items-center gap-1.5 text-xs text-silver hover:text-gold-bright transition-colors"
                    aria-expanded={expanded}
                  >
                    {expanded ? (
                      <>
                        <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
                        Show fewer
                      </>
                    ) : (
                      <>
                        <ChevronDown
                          className="h-3.5 w-3.5"
                          aria-hidden="true"
                        />
                        Show all {reports.length}
                      </>
                    )}
                  </button>
                </div>
              )}
            </>

          )}
        </CardContent>
      </Card>
    </section>
  );
}

function StatusPill({
  active,
  pto,
}: {
  active: TeamTimeEntry | undefined;
  pto: boolean;
}) {
  if (active) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] bg-success/15 text-emerald-400 border border-success/30">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
        On the clock · since {fmtRelative(active.clockInAt)}
      </span>
    );
  }
  if (pto) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] bg-amber-500/15 text-amber-300 border border-amber-500/30">
        <CalendarOff className="h-3 w-3" />
        Pending PTO today
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] bg-navy-secondary/50 text-silver border border-navy-secondary">
      Off the clock
    </span>
  );
}

/* ============================== Section title ============================ */

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

// Helpers re-exported for tests / future use.
export { fmtRelative as _fmtRelative, fmtHM as _fmtHM, fmtDateRange as _fmtDateRange, CATEGORY_LABEL as _CATEGORY_LABEL };
