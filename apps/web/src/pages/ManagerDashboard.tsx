import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { usePullToRefresh, PullToRefreshIndicator } from '@/lib/usePullToRefresh';
import {
  Activity,
  AlertCircle,
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
import { toast } from 'sonner';
import { useAuth } from '@/lib/auth';
import { ApiError } from '@/lib/api';
import { fmtDate, fmtRelativeDate, ymdLocal } from '@/lib/format';
import { useConfirm } from '@/lib/confirm';
import {
  bulkApproveTeamTimesheets,
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
import { Badge } from '@/components/ui/Badge';
import { LiveNow } from '@/components/ui/LiveNow';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
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
 * Manager dashboard. All data is direct-report-scoped on the server
 * (`managerId == req.user.associateId`). Surfaces what a line manager
 * actually needs to act on: pending timesheet approvals, pending PTO
 * requests, and a roster of direct reports with current status.
 */
export function ManagerDashboard() {
  const pullQueryClient = useQueryClient();
  const pullState = usePullToRefresh(() => pullQueryClient.invalidateQueries());
  const { user } = useAuth();
  // Header clock lives in <LiveNow> below — a page-level ticker used to
  // re-render the whole dashboard every minute for a greeting.

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
  // Approved PTO overlapping today drives the roster's "Out today" pill —
  // a genuinely-approved absence, distinct from the pending-request hint.
  const approvedPtoQuery = useQuery({
    queryKey: ['team', 'timeoff', 'APPROVED'],
    queryFn: async () => (await listTeamTimeOff('APPROVED')).requests,
  });

  const summary: TeamDashboard | null = summaryQuery.data ?? null;
  const reports: DirectReport[] | null = reportsQuery.data ?? null;
  const activeEntries: TeamTimeEntry[] | null = activeQuery.data ?? null;
  const pendingTimesheets: TeamTimeEntry[] | null =
    pendingTimesheetsQuery.data ?? null;
  const pendingPto: TeamTimeOffRequest[] | null =
    pendingPtoQuery.data ?? null;
  const approvedPto: TeamTimeOffRequest[] | null =
    approvedPtoQuery.data ?? null;

  // The two essential queries surface a page-level banner; the approval
  // and active-entry queries surface their own inline error + retry so a
  // failure can never masquerade as a permanent skeleton or a zero count.
  const fatalErr = summaryQuery.error ?? reportsQuery.error;
  const error = fatalErr
    ? fatalErr instanceof ApiError
      ? fatalErr.message
      : 'Failed to load team data.'
    : null;

  const approvalsError = Boolean(
    pendingTimesheetsQuery.error ?? pendingPtoQuery.error,
  );
  const retryApprovals = () => {
    if (pendingTimesheetsQuery.error) void pendingTimesheetsQuery.refetch();
    if (pendingPtoQuery.error) void pendingPtoQuery.refetch();
  };

  const greetingName =
    user?.firstName?.trim() ||
    (user?.email ? firstNameFromEmail(user.email) : 'there');

  // Index of associateId → active time entry (so we can mark "on the
  // clock" badges in the team list).
  const activeByReport = useMemo(() => {
    const m = new Map<string, TeamTimeEntry>();
    for (const e of activeEntries ?? []) m.set(e.associateId, e);
    return m;
  }, [activeEntries]);

  return (
    <div className="mx-auto space-y-8">
      <PullToRefreshIndicator state={pullState} />
      {/* Greeting */}
      <header>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="text-xs2 uppercase tracking-[0.18em] text-silver flex items-center gap-2">
            <Calendar className="h-3 w-3" aria-hidden="true" />
            <LiveNow render={(now) => fmtDate(now)} />
          </div>
          <span className="inline-flex items-center gap-1 rounded-full border border-steel/60 bg-steel/20 px-2 py-0.5 text-2xs uppercase tracking-widest text-white">
            Manager view
          </span>
        </div>
        <h1 className="font-display text-3xl md:text-4xl text-white mt-2 leading-tight">
          <LiveNow render={(now) => greetingFor(now.getHours())} />,{' '}
          <span className="text-gold">{greetingName}</span>.
        </h1>
        <p className="text-silver mt-2 text-sm md:text-base">
          {summary && summary.directReports > 0
            ? `You have ${summary.directReports} direct ${summary.directReports === 1 ? 'report' : 'reports'} on your team.`
            : 'Your team-scoped overview.'}
        </p>
      </header>

      <RoleDecisionQueue />

      {error && <ErrorBanner>{error}</ErrorBanner>}

      <ApprovalsSection
        pendingTimesheets={pendingTimesheets}
        pendingPto={pendingPto}
        error={approvalsError}
        onRetry={retryApprovals}
      />

      <TeamSnapshot
        summary={summary}
        activeCount={activeByReport.size}
        activeError={Boolean(activeQuery.error)}
        onRetryActive={() => void activeQuery.refetch()}
      />

      <TeamRoster
        reports={reports}
        activeByReport={activeByReport}
        pendingPto={pendingPto}
        approvedPto={approvedPto}
      />
    </div>
  );
}

/* ============================ Approvals ================================== */

function ApprovalsSection({
  pendingTimesheets,
  pendingPto,
  error,
  onRetry,
}: {
  pendingTimesheets: TeamTimeEntry[] | null;
  pendingPto: TeamTimeOffRequest[] | null;
  error: boolean;
  onRetry: () => void;
}) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const bulkApproveM = useMutation({
    mutationFn: (ids: string[]) => bulkApproveTeamTimesheets(ids),
    onSuccess: (r) => {
      toast.success(
        `Approved ${r.approved}${r.skipped.length ? ` · ${r.skipped.length} skipped` : ''}.`,
      );
      void qc.invalidateQueries({ queryKey: ['team'] });
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'Bulk approve failed.'),
  });

  const tsCount = pendingTimesheets?.length ?? 0;
  const ptoCount = pendingPto?.length ?? 0;
  const loading =
    !error && (pendingTimesheets === null || pendingPto === null);

  const approveAll = async () => {
    const ids = (pendingTimesheets ?? []).map((e) => e.id);
    if (ids.length === 0) return;
    const ok = await confirm({
      title: `Approve all ${ids.length} ${ids.length === 1 ? 'timesheet' : 'timesheets'}?`,
      description:
        'Approved hours are locked for the associate and included in the next payroll run.',
      confirmLabel: 'Approve all',
    });
    if (!ok) return;
    bulkApproveM.mutate(ids);
  };

  if (error) {
    return (
      <section aria-label="Pending approvals" className="space-y-3">
        <SectionTitle icon={ClipboardList}>Needs your approval</SectionTitle>
        <QueryErrorCard
          label="Couldn't load your approval queues"
          onRetry={onRetry}
        />
      </section>
    );
  }

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
          action={
            <Button
              size="sm"
              variant="outline"
              onClick={approveAll}
              loading={bulkApproveM.isPending}
            >
              Approve all {tsCount}
            </Button>
          }
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
  action,
}: {
  icon: LucideIcon;
  count: number;
  label: string;
  hint?: string;
  to: string;
  cta: string;
  severity: 'attention' | 'urgent';
  show: boolean;
  /** Optional inline action (e.g. "Approve all N") rendered beside the CTA.
   *  The card root is a div (not a Link) so buttons can live inside it. */
  action?: React.ReactNode;
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
          ring: 'border-warning/25 hover:border-warning/55',
          dot: 'bg-warning/15 text-warning',
          count: 'text-warning',
        };
  return (
    <div
      className={cn(
        // Same elevation ladder as the AdminDashboard cards: rest at
        // elev-1, lift to elev-2 on hover.
        'group flex flex-col rounded-lg border bg-navy p-5 elev-1 transition-all',
        'hover:-translate-y-0.5 hover:elev-2',
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
      <div className="mt-4 flex items-center justify-between gap-3">
        <Link
          to={to}
          className="flex items-center gap-1 text-sm text-gold hover:text-gold-bright focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright rounded"
        >
          {cta}
          <ArrowRight className="h-3.5 w-3.5 group-hover:translate-x-0.5 transition-transform" />
        </Link>
        {action}
      </div>
    </div>
  );
}

/* ============================ Load-failure card ========================== */

/**
 * Rendered in place of a card whose query failed. Deliberately NOT a
 * skeleton or a zero count — "0 of 12 on the clock" when the request
 * never landed is confidently wrong.
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

/* =========================== Team snapshot KPIs ========================== */

function TeamSnapshot({
  summary,
  activeCount,
  activeError,
  onRetryActive,
}: {
  summary: TeamDashboard | null;
  activeCount: number;
  activeError: boolean;
  onRetryActive: () => void;
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
              value={summary.directReports.toString()}
              hint={
                summary.directReports === 0
                  ? 'No one currently reports to you.'
                  : undefined
              }
              to="/team"
            />
            {activeError ? (
              <QueryErrorCard
                label="On the clock now — failed to load"
                onRetry={onRetryActive}
              />
            ) : (
              <KpiTile
                icon={Clock}
                label="On the clock now"
                value={activeCount.toString()}
                hint={
                  summary.directReports > 0
                    ? `${activeCount} of ${summary.directReports}`
                    : undefined
                }
                to="/team"
              />
            )}
            <KpiTile
              icon={Clock}
              label="Pending timesheets"
              value={summary.pendingTimesheets.toString()}
              hint={
                summary.pendingTimesheets === 0 ? 'Inbox clear.' : undefined
              }
              to="/team"
            />
            <KpiTile
              icon={CalendarOff}
              label="Pending time-off"
              value={summary.pendingTimeOff.toString()}
              hint={summary.pendingTimeOff === 0 ? 'Nothing waiting.' : undefined}
              to="/team"
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
  to,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  hint?: string;
  to?: string;
}) {
  const inner = (
    <>
      <div className="flex items-center justify-between">
        {/* Canonical KPI label spec (matches MetricCard). */}
        <div className="text-xs2 font-medium uppercase tracking-[0.14em] text-silver/70">
          {label}
        </div>
        <Icon
          className={cn(
            'h-3.5 w-3.5 text-gold/70',
            to && 'group-hover:text-gold-bright transition-colors',
          )}
          aria-hidden="true"
        />
      </div>
      <div className="font-display text-3xl md:text-hero text-gold-bright mt-3 leading-none tabular-nums">
        {value}
      </div>
      {hint && (
        <div className="text-xs text-silver mt-2 truncate">{hint}</div>
      )}
    </>
  );
  if (to) {
    return (
      <Link
        to={to}
        className={cn(
          'group block rounded-lg border border-navy-secondary border-l-2 border-l-gold/40 bg-navy p-5 elev-1 transition-all',
          'hover:-translate-y-0.5 hover:border-l-gold-bright hover:elev-2',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright focus-visible:ring-offset-2 focus-visible:ring-offset-midnight',
        )}
      >
        {inner}
      </Link>
    );
  }
  return (
    <Card className="border-l-2 border-l-gold/40">
      <CardContent className="pt-5">{inner}</CardContent>
    </Card>
  );
}

/* ============================== Team roster ============================== */

// Local calendar day — toISOString() is UTC and flips to tomorrow for
// evening users west of UTC, mislabeling who's "out today".
const TODAY_KEY = () => ymdLocal();

const TEAM_ROSTER_PREVIEW = 8;

function TeamRoster({
  reports,
  activeByReport,
  pendingPto,
  approvedPto,
}: {
  reports: DirectReport[] | null;
  activeByReport: Map<string, TeamTimeEntry>;
  pendingPto: TeamTimeOffRequest[] | null;
  approvedPto: TeamTimeOffRequest[] | null;
}) {
  const [expanded, setExpanded] = useState(false);

  // Approved PTO overlapping today → "Out today" (a real absence).
  // Pending PTO overlapping today stays a softer "Pending PTO today"
  // hint so the manager knows a decision is still open.
  const outToday = useMemo(() => {
    const today = TODAY_KEY();
    const out = new Set<string>();
    for (const r of approvedPto ?? []) {
      if (r.startDate <= today && r.endDate >= today) {
        out.add(r.associateId);
      }
    }
    return out;
  }, [approvedPto]);

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
              <ul className="divide-y divide-navy-secondary">
                {(expanded
                  ? reports
                  : reports.slice(0, TEAM_ROSTER_PREVIEW)
                ).map((r) => {
                  const active = activeByReport.get(r.id);
                  const isOut = outToday.has(r.id);
                  const isPto = pendingPtoToday.has(r.id);
                  return (
                    <li key={r.id}>
                      <Link
                        to={`/people?associateId=${r.id}`}
                        className="px-5 py-3 flex items-center gap-3 hover:bg-navy-secondary/20 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
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
                          <div className="text-xs2 text-silver/80 truncate">
                            {r.jobTitle ?? '—'}
                            {r.departmentName ? ` · ${r.departmentName}` : ''}
                          </div>
                        </div>
                        <StatusPill active={active} out={isOut} pto={isPto} />
                      </Link>
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
  out,
  pto,
}: {
  active: TeamTimeEntry | undefined;
  out: boolean;
  pto: boolean;
}) {
  // Sentence-case status chips on the Badge variant contract:
  // success = on the clock, info = scheduled absence, pending = awaiting
  // a decision, default = neutral off-the-clock.
  if (active) {
    return (
      <Badge variant="success" className="normal-case tracking-normal">
        On the clock · since {fmtRelativeDate(active.clockInAt)}
      </Badge>
    );
  }
  if (out) {
    return (
      <Badge variant="info" className="normal-case tracking-normal">
        <CalendarOff className="h-3 w-3" aria-hidden="true" />
        Out today
      </Badge>
    );
  }
  if (pto) {
    return (
      <Badge variant="pending" withDot={false} className="normal-case tracking-normal">
        <CalendarOff className="h-3 w-3" aria-hidden="true" />
        Pending PTO today
      </Badge>
    );
  }
  return (
    <Badge variant="default" className="normal-case tracking-normal">
      Off the clock
    </Badge>
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

