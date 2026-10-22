import { useMemo, useState } from 'react';
import { useGreeting, greetingName as greetingNameOf } from '@/lib/greeting';
import { Link } from 'react-router-dom';
import { useInbox } from '@/lib/inboxApi';
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
  CalendarCheck,
  Cake,
  ClipboardList,
  Clock,
  FileWarning,
  Lightbulb,
  Sparkles,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { useAuth, useTerm } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { ApiError } from '@/lib/api';
import { fmtDate, fmtRelativeDate, fmtShiftSpanTz, ymdLocal } from '@/lib/format';
import { useConfirm } from '@/lib/confirm';
import { associatePhotoUrl } from '@/lib/photoUrl';
import {
  bulkApproveTeamTimesheets,
  getTeamDashboard,
  getTeamHome,
  listReports,
  listTeamTimeOff,
  listTeamTimesheets,
  type DirectReport,
  type TeamDashboard,
  type TeamHome,
  type TeamTimeEntry,
  type TeamTimeOffRequest,
} from '@/lib/teamApi';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { LiveNow } from '@/components/ui/LiveNow';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { MetricCard } from '@/components/ui/MetricCard';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { CrewSignalsCard } from '@/components/home/CrewSignalsCard';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/lib/cn';
import { RoleDecisionQueue } from '@/components/RoleDecisionQueue';
import { MyPlanCard } from '@/components/MyPlanCard';
import { TeamHoursCard } from '@/components/attendance/TeamHoursCard';
import { HomeTemplate } from '@/components/templates';
import { HugoSeat } from '@/components/home/HugoSeat';

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
  // Beyond the queues (HR pack 2026-10): what is due on the team, today on
  // the team, and the actions those suggest. One call.
  const homeQuery = useQuery({ queryKey: ['team', 'home'], queryFn: () => getTeamHome() });
  const home: TeamHome | null = homeQuery.data ?? null;
  const dueCount = home
    ? home.due.reviews.length + home.due.oneOnOnes.length + home.due.probations.length + home.due.rampMilestones.length + home.due.documents.length + home.due.credentials.length + home.due.pips.length
    : null;

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

  const greet = useGreeting();
  // No first name on the account: a "first.last@" address still names them.
  const greetingName = greetingNameOf(user, '') || nameFromEmail(user?.email);
  const { t } = useI18n();

  // Index of associateId → active time entry (so we can mark "on the
  // clock" badges in the team list).
  const activeByReport = useMemo(() => {
    const m = new Map<string, TeamTimeEntry>();
    for (const e of activeEntries ?? []) m.set(e.associateId, e);
    return m;
  }, [activeEntries]);

  return (
    <>
      <PullToRefreshIndicator state={pullState} />
      {/* Design system §4.1 (UX upgrade step 2): the Home template. */}
      <HomeTemplate
        title={
          <>
            <LiveNow render={(now) => greet(now.getHours())} />
            {greetingName && <>, <span className="text-accent">{greetingName}</span></>}.
          </>
        }
        topbarTitle="Home"
        subtitle={
          summary && summary.directReports > 0
            ? summary.directReports === 1
              ? t('managerHome.oneReport')
              : t('managerHome.nReports', { n: summary.directReports })
            : t('managerHome.teamScoped')
        }
        meta={
          <span className="flex items-center gap-2 text-xs2 uppercase tracking-[0.18em] text-ink-muted">
            <Calendar className="h-3 w-3" aria-hidden="true" />
            <LiveNow render={(now) => fmtDate(now)} />
          </span>
        }
        banners={error ? <ErrorBanner>{error}</ErrorBanner> : undefined}
        // The one thing a manager opens this page for: everything waiting on
        // them, counted and ranked, in ONE section. It used to be two lists —
        // the decision queue as the hero and "Needs your approval" under the
        // plan card — with a vanity "Direct reports" count leading the tiles.
        hero={
          <NeedsYou
            title={t('home.needsYou')}
            pendingTimesheets={pendingTimesheets}
            pendingPto={pendingPto}
            error={approvalsError}
            onRetry={retryApprovals}
          />
        }
        assistant={<HugoSeat />}
      >
        {home && home.suggestions.length > 0 && <Suggestions items={home.suggestions} />}
        <CrewSignalsCard />
        <TeamSnapshot
          summary={summary}
          activeCount={activeByReport.size}
          activeError={Boolean(activeQuery.error)}
          onRetryActive={() => void activeQuery.refetch()}
          dueCount={dueCount}
          outToday={home ? home.today.out.length : null}
        />
        <TodayOnYourTeam home={home} error={Boolean(homeQuery.error)} onRetry={() => void homeQuery.refetch()} />
        {/* Hours per person this week against 40 — who's heading into overtime. */}
        <TeamHoursCard />
        <DueOnYourTeam home={home} />
        <MyPlanCard />
        <TeamRoster
          reports={reports}
          activeByReport={activeByReport}
          pendingPto={pendingPto}
          approvedPto={approvedPto}
        />
      </HomeTemplate>
    </>
  );
}

/* ============================ Needs you ================================== */

/**
 * The counted, ranked list of what needs this manager: the role's decision
 * queue first (its own kinds of decision), then the approval queues —
 * urgent before attention, the larger pile first. The queue hides its
 * "nothing needs your decision" line while approvals are waiting, so the
 * section never says "all clear" above three cards that disagree.
 */
function NeedsYou({
  title,
  pendingTimesheets,
  pendingPto,
  error,
  onRetry,
}: {
  title: string;
  pendingTimesheets: TeamTimeEntry[] | null;
  pendingPto: TeamTimeOffRequest[] | null;
  error: boolean;
  onRetry: () => void;
}) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const term = useTerm();
  const { t } = useI18n();
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
        `Approved hours are locked for the ${term('worker').toLowerCase()} and included in the next payroll run.`,
      confirmLabel: 'Approve all',
    });
    if (!ok) return;
    bulkApproveM.mutate(ids);
  };

  const total = tsCount + ptoCount;
  const inbox = useInbox();
  const companyWaiting = (inbox.data?.sources ?? []).reduce((n, s) => n + (s.count > 0 ? s.count : 0), 0);
  // Ranked: urgent before attention, then the bigger pile first.
  const cards = [
    {
      key: 'timesheets',
      icon: Clock,
      count: tsCount,
      label: tsCount === 1 ? t('managerHome.timesheetToReview') : t('managerHome.timesheetsToReview'),
      hint: t('managerHome.timesheetsHint'),
      cta: t('managerHome.openQueue'),
      severity: (tsCount > 10 ? 'urgent' : 'attention') as 'urgent' | 'attention',
      action: (
        <Button
          size="sm"
          variant="outline"
          onClick={approveAll}
          loading={bulkApproveM.isPending}
        >
          {t('managerHome.approveAllN', { n: tsCount })}
        </Button>
      ),
    },
    {
      key: 'timeoff',
      icon: CalendarOff,
      count: ptoCount,
      label: ptoCount === 1 ? t('managerHome.timeOffWaiting') : t('managerHome.timeOffsWaiting'),
      hint: t('managerHome.timeOffHint'),
      cta: t('managerHome.openRequests'),
      severity: (ptoCount > 5 ? 'urgent' : 'attention') as 'urgent' | 'attention',
      action: undefined,
    },
  ]
    .filter((c) => c.count > 0)
    .sort((a, b) =>
      a.severity === b.severity ? b.count - a.count : a.severity === 'urgent' ? -1 : 1,
    );

  return (
    <section aria-labelledby="manager-needs-you" className="space-y-3">
      <SectionTitle
        id="manager-needs-you"
        icon={ClipboardList}
        title={
          <>
            {title}
            {total > 0 && (
              <span className="ml-2 inline-flex min-w-6 items-center justify-center rounded-full bg-accent-fill px-1.5 text-xs font-semibold tabular-nums text-accent-on">
                {total}
              </span>
            )}
          </>
        }
      />
      {/* The role's own decisions first. While approvals are waiting, its
          empty line stays out of the way; with none, it is the only voice. */}
      {/* These decisions are the company's, not this team's — said so. */}
      <RoleDecisionQueue title={null} hideWhenEmpty={total > 0 || loading || error} scopeLabel="Company-wide" />
      {error ? (
        <QueryErrorCard label={t('managerHome.queuesError')} onRetry={onRetry} />
      ) : loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {Array.from({ length: 2 }).map((_, i) => (
            <Card key={i}>
              <CardContent>
                <Skeleton className="h-3 w-20 mb-3" />
                <Skeleton className="h-7 w-1/2 mb-2" />
                <Skeleton className="h-3 w-2/3" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : total === 0 ? (
        <Card className="border-success/30 bg-success/5">
          <CardContent className="py-4 flex items-center gap-3">
            <div className="h-9 w-9 rounded-full bg-success/15 grid place-items-center text-success shrink-0">
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            </div>
            <div className="text-sm text-silver">
              {/* "Inbox zero" read wrong beside a sidebar Inbox of 22: this
                  is the team's queue; the company's waits in the Inbox. */}
              <span className="text-white font-medium">{t('managerHome.teamClear')}</span> — {t('managerHome.inboxZeroBody')}
              {companyWaiting > 0 && (
                <>
                  {' '}
                  <Link to="/inbox" className="text-accent underline-offset-2 hover:underline">
                    {t('managerHome.companyWaiting', { n: companyWaiting })}
                  </Link>
                </>
              )}
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {cards.map((c) => (
            <ApprovalCard
              key={c.key}
              icon={c.icon}
              count={c.count}
              label={c.label}
              hint={c.hint}
              to="/team"
              cta={c.cta}
              severity={c.severity}
              show
              action={c.action}
            />
          ))}
        </div>
      )}
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
      <CardContent>
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
  dueCount,
  outToday,
}: {
  summary: TeamDashboard | null;
  activeCount: number;
  activeError: boolean;
  onRetryActive: () => void;
  /** Reviews, 1:1s, probations, checkpoints and expiries due on the team; null while loading. */
  dueCount: number | null;
  outToday: number | null;
}) {
  const { t } = useI18n();
  const toTeam = (card: React.ReactElement) => (
    <Link
      to="/team"
      className="block rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
    >
      {card}
    </Link>
  );
  return (
    <section aria-label={t('managerHome.teamSnapshot')} className="space-y-3">
      <SectionTitle icon={Activity} title={t('managerHome.teamSnapshot')} />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {summary ? (
          <>
            {activeError ? (
              <QueryErrorCard
                label={t('managerHome.onClockError')}
                onRetry={onRetryActive}
              />
            ) : (
              <MetricCard
                label={t('managerHome.onClockNow')}
                value={activeCount}
                hint={
                  summary.directReports > 0
                    ? t('managerHome.xOfY', { a: activeCount, b: summary.directReports })
                    : undefined
                }
                wrap={toTeam}
              />
            )}
            {/* The queues are counted once, in Needs you above; these two
                tiles are what the queues cannot say. */}
            <MetricCard
              label="Due on your team"
              value={dueCount ?? '—'}
              accent={(dueCount ?? 0) > 0}
              hint={dueCount === 0 ? 'Nothing due this month.' : 'Reviews, 1:1s, probations and expiries.'}
            />
            <MetricCard
              label="Out today"
              value={outToday ?? '—'}
              hint={outToday === 0 ? 'Everyone is in.' : 'On approved leave.'}
              wrap={toTeam}
            />
            <MetricCard
              label={t('managerHome.directReports')}
              value={summary.directReports}
              hint={summary.directReports === 0 ? t('managerHome.noReports') : undefined}
              wrap={toTeam}
            />
          </>
        ) : (
          Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}>
              <CardContent>
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
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const term = useTerm();

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
    <section aria-label={t('managerHome.myTeam')} className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <SectionTitle icon={Users} title={t('managerHome.myTeam')} className="mb-0" />
        <Link
          to="/team"
          className="text-xs text-gold hover:text-gold-bright inline-flex items-center gap-1"
        >
          {t('managerHome.openTeamPage')}
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
              No direct reports linked yet. Once HR names you as someone's {term('manager').toLowerCase()}, they show up here.
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
                          src={associatePhotoUrl(r.id)}
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
      <Badge variant="success">
        On the clock · since {fmtRelativeDate(active.clockInAt)}
      </Badge>
    );
  }
  if (out) {
    return (
      <Badge variant="info">
        <CalendarOff className="h-3 w-3" aria-hidden="true" />
        Out today
      </Badge>
    );
  }
  if (pto) {
    return (
      <Badge variant="pending" withDot={false}>
        <CalendarOff className="h-3 w-3" aria-hidden="true" />
        Time off pending today
      </Badge>
    );
  }
  return (
    <Badge variant="default">
      Off the clock
    </Badge>
  );
}

/* ============================ Suggestions ================================ */

/** What the due items add up to, as one line each with a place to go. */
function Suggestions({ items }: { items: TeamHome['suggestions'] }) {
  return (
    <section aria-label="Suggested next steps" className="space-y-3">
      <SectionTitle icon={Lightbulb} title="Suggested next steps" />
      <Card>
        <CardContent className="p-0">
          <ul className="divide-y divide-line">
            {items.map((s) => (
              <li key={s.key}>
                <Link to={s.link} className="flex items-center gap-3 px-5 py-3 text-sm text-ink hover:bg-surface-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                  <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent-fill/15 text-accent">
                    <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">{s.text}</span>
                  <ArrowRight className="h-3.5 w-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </section>
  );
}

/* ========================= Today on your team ============================ */

function TodayOnYourTeam({ home, error, onRetry }: { home: TeamHome | null; error: boolean; onRetry: () => void }) {
  if (error) {
    return (
      <section aria-label="Today on your team" className="space-y-3">
        <SectionTitle icon={CalendarCheck} title="Today on your team" />
        <QueryErrorCard label="Couldn't load today on your team." onRetry={onRetry} />
      </section>
    );
  }
  const today = home?.today;
  return (
    <section aria-label="Today on your team" className="space-y-3">
      <SectionTitle icon={CalendarCheck} title="Today on your team" />
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Card>
          <CardContent>
            <div className="text-xs2 uppercase tracking-wider text-ink-muted">Shifts today</div>
            {!today ? (
              <Skeleton className="mt-3 h-4 w-2/3" />
            ) : today.shifts.length === 0 ? (
              <p className="mt-3 text-sm text-ink-muted">No one on your team is scheduled today.</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {today.shifts.slice(0, 6).map((sh) => (
                  <li key={sh.id} className="flex items-center justify-between gap-2 text-sm">
                    <span className="truncate text-ink">{sh.associateName}</span>
                    <span className="shrink-0 tabular-nums text-ink-muted">
                      {fmtShiftSpanTz(sh.startsAt, sh.endsAt, sh.timezone)}
                    </span>
                  </li>
                ))}
                {today.shifts.length > 6 && <li className="text-xs text-ink-muted">and {today.shifts.length - 6} more</li>}
              </ul>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <div className="text-xs2 uppercase tracking-wider text-ink-muted">Out today</div>
            {!today ? (
              <Skeleton className="mt-3 h-4 w-2/3" />
            ) : today.out.length === 0 ? (
              <p className="mt-3 text-sm text-ink-muted">Everyone is in.</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {today.out.map((o) => (
                  <li key={o.associateId} className="flex items-center justify-between gap-2 text-sm">
                    <span className="truncate text-ink">{o.associateName}</span>
                    <Badge variant="info">
                      <CalendarOff className="h-3 w-3" aria-hidden="true" />
                      Until {fmtDate(o.until)}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <div className="text-xs2 uppercase tracking-wider text-ink-muted">Celebrations</div>
            {!today ? (
              <Skeleton className="mt-3 h-4 w-2/3" />
            ) : today.celebrations.length === 0 ? (
              <p className="mt-3 text-sm text-ink-muted">No birthdays or anniversaries today.</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {today.celebrations.map((c) => (
                  <li key={`${c.associateId}-${c.kind}`} className="flex items-center gap-2 text-sm text-ink">
                    <Cake className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
                    <span className="truncate">{c.associateName}</span>
                    <span className="text-ink-muted">{c.kind === 'BIRTHDAY' ? 'birthday' : `${c.years} ${c.years === 1 ? 'year' : 'years'} with us`}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

/* =========================== Due on your team ============================ */

function DueOnYourTeam({ home }: { home: TeamHome | null }) {
  const due = home?.due;
  const groups: Array<{ key: string; label: string; icon: LucideIcon; link: string; rows: Array<{ id: string; name: string; note: string; urgent?: boolean }> }> = due
    ? [
        { key: 'reviews', label: 'Reviews due', icon: ClipboardList, link: '/performance', rows: due.reviews.map((r) => ({ id: r.associateId, name: r.associateName, note: r.lastPeriodEnd ? `Last review ended ${fmtDate(r.lastPeriodEnd)}` : 'Never reviewed', urgent: r.overdueDays > 90 })) },
        { key: 'oneOnOnes', label: '1:1s coming up', icon: Users, link: '/performance?tab=one-on-ones', rows: due.oneOnOnes.map((o) => ({ id: o.id, name: o.associateName, note: fmtRelativeDate(o.scheduledFor) })) },
        { key: 'probations', label: 'Probation decisions', icon: CalendarCheck, link: '/probation', rows: due.probations.map((p) => ({ id: p.id, name: p.associateName, note: `Ends ${fmtDate(p.endDate)}`, urgent: true })) },
        { key: 'pips', label: 'Improvement plans ending', icon: AlertCircle, link: '/performance?tab=pips', rows: due.pips.map((p) => ({ id: p.id, name: p.associateName, note: `Ends ${fmtDate(p.endDate)}`, urgent: true })) },
        { key: 'ramp', label: 'Ramp checkpoints', icon: Activity, link: '/ramp', rows: due.rampMilestones.map((m) => ({ id: m.id, name: m.associateName, note: `${m.title} · ${fmtDate(m.dueOn)}` })) },
        {
          key: 'expiring',
          label: 'Documents and credentials expiring',
          icon: FileWarning,
          link: '/expirations',
          rows: [
            ...due.documents.map((d) => ({ id: d.id, name: d.associateName, note: `${d.kind.replace(/_/g, ' ').toLowerCase()} · ${d.expired ? 'expired' : 'expires'} ${fmtDate(d.expiresAt)}`, urgent: d.expired })),
            ...due.credentials.map((c) => ({ id: c.id, name: c.associateName, note: `${c.name} · ${c.expired ? 'expired' : 'expires'} ${fmtDate(c.expiresAt)}`, urgent: c.expired })),
          ],
        },
      ].filter((g) => g.rows.length > 0)
    : [];
  return (
    <section aria-label="Due on your team" className="space-y-3">
      <SectionTitle icon={Clock} title="Due on your team" />
      {!due ? (
        <Card>
          <CardContent>
            <Skeleton className="mb-2 h-3 w-1/3" />
            <Skeleton className="h-3 w-2/3" />
          </CardContent>
        </Card>
      ) : groups.length === 0 ? (
        <Card className="border-success/30 bg-success/5">
          <CardContent className="flex items-center gap-3 py-4">
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-success/15 text-success">
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            </div>
            <div className="text-sm text-ink-muted">
              <span className="font-medium text-ink">All clear</span> — no reviews, 1:1s, probations or expiries due on your team this month.
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {groups.map((g) => (
            <Card key={g.key}>
              <CardContent>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-sm font-medium text-ink">
                    <g.icon className="h-4 w-4 text-ink-muted" aria-hidden="true" />
                    {g.label}
                    <span className="rounded-full bg-accent-fill px-1.5 text-xs font-semibold tabular-nums text-accent-on">{g.rows.length}</span>
                  </div>
                  <Link to={g.link} className="inline-flex items-center gap-1 text-xs text-accent hover:underline">
                    Open
                    <ArrowRight className="h-3 w-3" aria-hidden="true" />
                  </Link>
                </div>
                <ul className="mt-3 space-y-2">
                  {g.rows.slice(0, 5).map((r) => (
                    <li key={r.id} className="flex items-center justify-between gap-2 text-sm">
                      <span className="truncate text-ink">{r.name}</span>
                      <span className={cn('shrink-0 text-xs', r.urgent ? 'text-alert' : 'text-ink-muted')}>{r.note}</span>
                    </li>
                  ))}
                  {g.rows.length > 5 && <li className="text-xs text-ink-muted">and {g.rows.length - 5} more</li>}
                </ul>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}

/** "dana.reyes@…" → "Dana"; a role address like "manager@" names nobody. */
function nameFromEmail(email: string | null | undefined): string {
  const local = email?.split('@')[0] ?? '';
  const m = /^([a-z]{2,})[._-][a-z]{2,}/i.exec(local);
  return m ? m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1).toLowerCase() : '';
}
