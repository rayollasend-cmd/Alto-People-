import { useMemo, useState } from 'react';
import { useGreeting, greetingName as greetingNameOf } from '@/lib/greeting';
import { Link } from 'react-router-dom';
import { usePullToRefresh, PullToRefreshIndicator } from '@/lib/usePullToRefresh';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CalendarPlus,
  ChevronDown,
  ChevronUp,
  ClipboardList,
  Clock,
  DollarSign,
  FileSearch,
  FileText,
  ShieldCheck,
  Users,
  Wallet,
  type LucideIcon,
} from '@/components/ui/icons';
import type {
  AuditSearchEntry,
  DashboardKPIs,
  KpiTrend,
  TermKey,
} from '@alto-people/shared';
import { useAuth, useTenant, useTerm } from '@/lib/auth';
import { useI18n, type MessageKey } from '@/lib/i18n';
import {
  hasCapability,
  type Capability,
  type Role,
} from '@/lib/roles';
import { getDashboardKPIs } from '@/lib/analyticsApi';
import { getW4RecollectionSummary } from '@/lib/w4RecollectionApi';
import { searchAuditLogs } from '@/lib/auditApi';
import { OpsActivityFeed } from '@/components/home/OpsActivityFeed';
import { ApiError, apiFetch } from '@/lib/api';
import { fmtDayShort, fmtMoney, fmtRelativeDate } from '@/lib/format';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { userPhotoUrl } from '@/lib/photoUrl';
import { LiveNow } from '@/components/ui/LiveNow';
import { Card, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { MetricCard, type TrendGood } from '@/components/ui/MetricCard';
import { MetricStrip } from '@/components/ui/MetricStrip';
import { useMinWidth } from '@/lib/useViewport';
import { OpsStoresToday } from '@/components/home/OpsStoresToday';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/lib/cn';
import { RoleDecisionQueue } from '@/components/RoleDecisionQueue';
import { HomeTemplate } from '@/components/templates';
import { HugoSeat } from '@/components/home/HugoSeat';
import { RoleFocusRow } from '@/components/home/RoleFocusRow';
import { MyPlanCard } from '@/components/MyPlanCard';
import { ProgramAlertsCard } from '@/components/ProgramAlertsCard';
import { useClockParts } from '@/components/ClockStrip';
import { HomeMeta } from '@/components/home/HomeMeta';
import { useNeedsYouCount } from '@/lib/meDecisions';

/**
 * Role-tailored subtitle on the greeting strip. The same dashboard scaffold
 * serves every non-associate role, but the framing copy and the visible
 * sections vary based on what the user can actually act on (see
 * ActionRequiredSection / ActivityFeed gating below).
 */
const SUBTITLE_BY_ROLE: Partial<Record<Role, MessageKey>> = {
  HR_ADMINISTRATOR: 'adminHome.subHr',
  OPERATIONS_MANAGER: 'adminHome.subOps',
  EXECUTIVE_CHAIRMAN: 'adminHome.subExec',
  FINANCE_ACCOUNTANT: 'adminHome.subFinance',
  INTERNAL_RECRUITER: 'adminHome.subRecruiter',
  CLIENT_PORTAL: 'adminHome.subClient',
  MANAGER: 'adminHome.subManager',
  // Harmless fallback — SHIFT_SUPERVISOR normally routes to the dedicated
  // SupervisorDashboard before this component ever renders.
  SHIFT_SUPERVISOR: 'adminHome.subShift',
  FLOOR_SUPERVISOR: 'adminHome.subFloor',
};

// Thousands-separated integer ("1,234"). Kept local because @/lib/format
// has no integer formatter; Intl directly, since toLocale* is lint-banned.
const INT_FMT = new Intl.NumberFormat('en-US');
const fmtInt = (n: number): string => INT_FMT.format(n);
const fmtHours = (n: number): string => `${INT_FMT.format(Math.round(n))}h`;

/**
 * Friendly verbs for audit `action` codes. The audit log emits dotted
 * machine codes (auth.login_succeeded, document.verified, etc.) — in the
 * dashboard activity feed we need short, scannable English. Falls back
 * to a humanized version of the dotted code when the verb isn't mapped.
 */
const ACTION_VERB: Record<string, string> = {
  // The server writes `auth.login`; `auth.login_succeeded` was its old
  // name, and the feed had been printing a bare "login" ever since.
  'auth.login': 'signed in',
  'auth.login_succeeded': 'signed in',
  'auth.login_failed': 'failed to sign in',
  'auth.logout': 'signed out',
  'auth.role_switched': 'switched roles',
  'auth.password_changed': 'changed their password',
  'auth.password_reset_completed': 'reset their password',
  'auth.sessions_revoked': 'signed out everywhere',
  'application.created': 'opened a new application',
  'application.submitted': 'submitted an application',
  'application.approved': 'approved an application',
  'application.rejected': 'rejected an application',
  'document.uploaded': 'uploaded a document',
  'document.verified': 'verified a document',
  'document.rejected': 'rejected a document',
  'i9.section1_completed': 'completed I-9 Section 1',
  'i9.section2_completed': 'completed I-9 Section 2',
  'payroll.disbursed': 'disbursed a payroll run',
  'payroll.finalized': 'finalized a payroll run',
  'time.entry_approved': 'approved a time entry',
  'time.entry_rejected': 'rejected a time entry',
  'kiosk.pin_assigned': 'issued an employee number',
};
const humanizeAction = (action: string): string => {
  if (ACTION_VERB[action]) return ACTION_VERB[action];
  // Fall back: take the part after the last dot, swap underscores.
  const tail = action.split('.').pop() ?? action;
  return tail.replace(/_/g, ' ');
};

export function AdminDashboard() {
  const clockParts = useClockParts();
  const pullQueryClient = useQueryClient();
  const pullState = usePullToRefresh(() => pullQueryClient.invalidateQueries());
  const { user, role, can } = useAuth();
  // Header clock lives in <LiveNow> below — a page-level 60s ticker used
  // to re-render this entire dashboard every minute for a date label.

  // Audit feed only loads when the user has audit access. Saves a
  // pointless 403 round-trip and keeps the section out of view entirely
  // for everyone else.
  const canSeeAudit = can('view:audit');
  // The floor's record (call-outs, publishes, swaps, incidents) replaces the
  // audit feed — on most days a list of sign-ins — for anyone who runs ops.
  const canSeeOps = can('manage:scheduling') || can('manage:time') || can('view:executive') || can('view:analytics');
  const canSeeOnboarding = can('view:onboarding');
  // Every "Action required" item needs one of these. A role holding none
  // (the watch-only FLOOR_SUPERVISOR lands here) would only ever see the
  // "all caught up — no applications, I-9s, documents or payroll" card and
  // a welcome tour describing that section, so both are left out for it.
  const canAct =
    can('manage:onboarding') ||
    can('manage:compliance') ||
    can('manage:documents') ||
    can('process:payroll');

  const { t } = useI18n();
  const kpisQuery = useQuery({
    queryKey: ['dashboard', 'kpis'],
    queryFn: () => getDashboardKPIs(),
  });
  // Key-rotation remediation counter — separate from the KPI payload so
  // the shared DashboardKPIs contract stays untouched; the card (and the
  // query) disappear once the campaign drains to zero.
  const canProcessPayroll = can('process:payroll');
  const ssnRecollectionQuery = useQuery({
    queryKey: ['w4-recollection', 'summary'],
    queryFn: () => getW4RecollectionSummary(),
    enabled: canProcessPayroll,
  });
  const ssnRecollectionOutstanding = canProcessPayroll
    ? (ssnRecollectionQuery.data?.outstanding ?? 0)
    : 0;
  // Field incidents awaiting HR review — the supervisor/WFM who reported
  // one is notified when it's resolved, so leaving these open leaves a
  // colleague in another building waiting.
  const canManageCompliance = can('manage:compliance');
  const incidentsQuery = useQuery({
    queryKey: ['osha', 'incidents', 'open'],
    queryFn: () =>
      apiFetch<{ incidents: Array<{ status: string }> }>('/osha/incidents'),
    enabled: canManageCompliance,
    staleTime: 60_000,
  });
  const openIncidents = canManageCompliance
    ? (incidentsQuery.data?.incidents.filter((i) => i.status !== 'RESOLVED')
        .length ?? 0)
    : 0;
  const activityQuery = useQuery({
    queryKey: ['audit', 'recent', 15],
    queryFn: () => searchAuditLogs({ limit: 15 }),
    enabled: canSeeAudit && !canSeeOps,
  });
  const kpis: DashboardKPIs | null = kpisQuery.data ?? null;
  const activity: AuditSearchEntry[] | null = canSeeAudit
    ? (activityQuery.data?.entries ?? null)
    : [];
  // KPIs are required; the activity feed surfaces its own inline error +
  // retry (see ActivityFeed) instead of masquerading as "no activity".
  const error = kpisQuery.error
    ? kpisQuery.error instanceof ApiError
      ? kpisQuery.error.message
      : t('adminHome.loadFailed')
    : null;

  const greet = useGreeting();
  const greetingName = greetingNameOf(user, '');
  // The operations manager runs the floor: their home is the stores today,
  // not the HR home with one ops row added (F500 G5). No onboarding funnel,
  // no generic snapshot — the floor row and the per-store board say it.
  const isOps = role === 'OPERATIONS_MANAGER';
  // A phone's first screen goes to what needs you, not to a sentence about
  // the page (the greeting and the date line stay).
  const wide = useMinWidth(640);

  return (
    <>
      <PullToRefreshIndicator state={pullState} />
      {/* Design system §4.1 (UX upgrade step 2): the Home template. The ranked
          decision queue is the hero; Hugo has his seat; every section keeps
          its own heading beneath. */}
      <HomeTemplate
        title={
          <>
            <LiveNow render={(now) => greet(now.getHours())} />
            {greetingName && <>, <span className="text-accent">{greetingName}</span></>}.
          </>
        }
        topbarTitle="Home"
        subtitle={wide ? t((role && SUBTITLE_BY_ROLE[role]) ?? 'adminHome.subHr') : undefined}
        // One quiet line, the same on every home (HomeMeta): today, then the
        // company clock. No role pill — the account menu says who you are.
        meta={<HomeMeta items={[<LiveNow key="today" render={(now) => fmtDayShort(now)} />, ...clockParts]} />}
        banners={
          <>
            {error && <ErrorBanner>{error}</ErrorBanner>}
          </>
        }
        // ONE counted, ranked "Needs you": the role's decision queue and the
        // action-required cards together. They used to be two lists — the
        // queue as the hero, "Needs your attention" a screen below it.
        hero={
          <NeedsYou
            title={t('home.needsYou')}
            kpis={kpis}
            canAct={canAct}
            canManageOnboarding={can('manage:onboarding')}
            canManageCompliance={canManageCompliance}
            canManageDocuments={can('manage:documents')}
            canProcessPayroll={canProcessPayroll}
            ssnRecollectionOutstanding={ssnRecollectionOutstanding}
            openIncidents={openIncidents}
          />
        }
        assistant={<HugoSeat />}
      >
        {/* HR admin and Ops manager no longer share one first row (HR pack 2026-10). */}
        <RoleFocusRow />
        {isOps ? <OpsStoresToday /> : <KpiSection kpis={kpis} role={role} />}
        <MyPlanCard />
        {/* J-1 / H-2B dates coming due (Brief 1C-2). Quiet when nothing is. */}
        <ProgramAlertsCard />
        {canSeeOnboarding && !isOps && <OnboardingFunnel kpis={kpis} />}
        {canSeeOps ? (
          <OpsActivityFeed auditLink={canSeeAudit} />
        ) : canSeeAudit && (
          <ActivityFeed
            entries={activity}
            error={Boolean(activityQuery.error)}
            onRetry={() => void activityQuery.refetch()}
          />
        )}
      </HomeTemplate>
    </>
  );
}
/* ============================== Needs you ================================ */
interface ActionItem {
  count: number;
  label: string;
  hint?: string;
  to: string;
  cta: string;
  icon: LucideIcon;
  /** Severity drives the accent color. */
  severity: 'info' | 'attention' | 'urgent';
}
const SEVERITY_RANK: Record<ActionItem['severity'], number> = { urgent: 0, attention: 1, info: 2 };
function NeedsYou({
  title,
  kpis,
  canAct,
  canManageOnboarding,
  canManageCompliance,
  canManageDocuments,
  canProcessPayroll,
  ssnRecollectionOutstanding,
  openIncidents,
}: {
  title: string;
  kpis: DashboardKPIs | null;
  /** Whether this role can act on any of the action-required kinds at all. */
  canAct: boolean;
  canManageOnboarding: boolean;
  canManageCompliance: boolean;
  canManageDocuments: boolean;
  canProcessPayroll: boolean;
  ssnRecollectionOutstanding: number;
  openIncidents: number;
}) {
  const { t } = useI18n();
  const term = useTerm();
  const items: ActionItem[] = useMemo(() => {
    if (!kpis || !canAct) return [];
    const xs: ActionItem[] = [];
    // Submitted and waiting for HR. It used to count drafts too — new
    // hires who haven't started their paperwork, nothing to review — and
    // the link then opened the submitted list, empty.
    const toReview = kpis.applicationStatusCounts.SUBMITTED ?? 0;
    if (canManageOnboarding && toReview > 0) {
      xs.push({
        count: toReview,
        label: toReview === 1 ? t('adminHome.appToReview') : t('adminHome.appsToReview'),
        hint: t('adminHome.appsHint'),
        // Straight to the review slice — the URL param beats the user's
        // persisted status chip on the applications list.
        to: '/onboarding?status=TO_REVIEW',
        cta: t('adminHome.openOnboarding'),
        icon: ClipboardList,
        severity: toReview > 10 ? 'urgent' : 'attention',
      });
    }
    if (canManageCompliance && openIncidents > 0) {
      xs.push({
        count: openIncidents,
        label: openIncidents === 1 ? t('adminHome.incidentToReview') : t('adminHome.incidentsToReview'),
        hint: t('adminHome.incidentsHint', { managerLc: term('manager').toLowerCase() }),
        to: '/compliance/osha',
        cta: t('adminHome.openInjuryLog'),
        icon: AlertTriangle,
        severity: 'urgent',
      });
    }
    if (canManageCompliance && kpis.pendingI9Section2 > 0) {
      xs.push({
        count: kpis.pendingI9Section2,
        label: t('adminHome.i9Due'),
        hint: t('adminHome.i9Hint'),
        // Land on the I-9 tab, not the Scorecard default.
        to: '/compliance?tab=i9',
        cta: t('adminHome.completeSection2'),
        icon: ShieldCheck,
        severity: 'urgent',
      });
    }
    if (canManageDocuments && kpis.pendingDocumentReviews > 0) {
      xs.push({
        count: kpis.pendingDocumentReviews,
        label: kpis.pendingDocumentReviews === 1 ? t('adminHome.docToVerify') : t('adminHome.docsToVerify'),
        to: '/documents',
        cta: t('adminHome.reviewDocuments'),
        icon: FileSearch,
        severity: kpis.pendingDocumentReviews > 20 ? 'urgent' : 'attention',
      });
    }
    if (canProcessPayroll && kpis.netPendingDisbursement > 0) {
      xs.push({
        count: 1,
        label: t('adminHome.pendingPayroll', { amount: fmtMoney(kpis.netPendingDisbursement) }),
        hint: t('adminHome.pendingPayrollHint'),
        to: '/payroll',
        cta: t('adminHome.openPayroll'),
        icon: Wallet,
        severity: 'attention',
      });
    }
    if (canProcessPayroll && ssnRecollectionOutstanding > 0) {
      xs.push({
        count: ssnRecollectionOutstanding,
        label: ssnRecollectionOutstanding === 1 ? t('adminHome.ssnRecollect') : t('adminHome.ssnsRecollect'),
        hint: t('adminHome.ssnHint'),
        to: '/payroll/w4-recollection',
        cta: t('adminHome.openCampaign'),
        icon: ShieldCheck,
        severity: 'urgent',
      });
    }
    // Ranked: urgent first, then the bigger pile.
    return xs.sort((a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.count - a.count,
    );
  }, [
    kpis,
    canAct,
    canManageOnboarding,
    canManageCompliance,
    canManageDocuments,
    canProcessPayroll,
    ssnRecollectionOutstanding,
    openIncidents,
    term,
    t,
  ]);

  const loading = canAct && !kpis;
  const total = items.length;
  // The number beside "Needs you" is what is listed under it: the role
  // queue's rows plus these cards (it said 1 over a list of 8).
  const shownCount = useNeedsYouCount({ queue: true, cards: total });
  return (
    <section aria-labelledby="home-needs-you" className="space-y-3">
      <SectionTitle
        id="home-needs-you"
        icon={AlertTriangle}
        title={
          <>
            {title}
            {!!shownCount && shownCount > 0 && (
              <span className="ml-2 inline-flex min-w-6 items-center justify-center rounded-full bg-accent-fill px-1.5 text-xs font-semibold tabular-nums text-accent-on" data-testid="needs-you-count">
                {shownCount}
              </span>
            )}
          </>
        }
      />
      {/* ONE list: the role's decisions, then the page's own counted rows
          (incidents to review, I-9s due…) inside the same card — a lone
          card in a three-column grid used to leave two empty thirds. The
          queue's "nothing needs your decision" line stays out while rows
          are waiting (or loading), so the section never says all clear
          above rows that disagree. */}
      <RoleDecisionQueue
        title={null}
        hideWhenEmpty={total > 0 || loading}
        footer={total > 0 ? <ActionRows items={items} /> : undefined}
      />
      {loading && (
        <Card aria-busy="true">
          <CardContent className="space-y-3">
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="h-6 w-8 rounded-full" />
                <Skeleton className="h-4 flex-1" />
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </section>
  );
}

const ROW_TONE: Record<ActionItem['severity'], string> = {
  urgent: 'bg-alert/15 text-alert',
  attention: 'bg-warning/15 text-warning',
  info: 'bg-gold/10 text-gold',
};

/**
 * The page's own "needs you" items as rows in the queue's card, the decision
 * rows' grammar: the count, what it is, and where it's worked.
 */
function ActionRows({ items }: { items: ActionItem[] }) {
  return (
    <ul className="space-y-1" data-testid="needs-you-rows">
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <li key={item.to + item.label}>
            <Link
              to={item.to}
              className="group/row flex items-center gap-3 rounded-md px-2 py-2 hover:bg-navy-secondary/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright coarse:min-h-11"
            >
              <span className={cn('inline-flex h-7 min-w-9 shrink-0 items-center justify-center gap-1 rounded-full px-2 text-sm font-semibold tabular-nums', ROW_TONE[item.severity])}>
                <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                {item.count}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm text-white group-hover/row:text-gold">{item.label}</span>
                {item.hint && <span className="block text-2xs text-silver line-clamp-2 sm:line-clamp-1">{item.hint}</span>}
              </span>
              <span className="hidden shrink-0 items-center gap-1 text-xs text-gold sm:inline-flex">
                {item.cta}
                <ArrowRight className="h-3 w-3" aria-hidden="true" />
              </span>
              <ArrowRight className="h-4 w-4 shrink-0 text-silver sm:hidden" aria-hidden="true" />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/* ================================== KPIs ================================= */

interface Kpi {
  label: string;
  value: string;
  hint?: string;
  icon: LucideIcon;
  /** Destination route. When present, the tile becomes clickable and
   *  lifts on hover via the Card primitive's interactive prop. */
  to?: string;
  /** 8-week micro-trend (sparkline + week-over-week delta chip),
   *  present only when the API computed a matching series. */
  trend?: KpiTrend & { deltaLabel: string; format?: (n: number) => string; lastIsPartial?: boolean };
  /** Which way is good news for the trend under the figure. */
  trendGood?: TrendGood;
}

function KpiSection({
  kpis,
  role,
}: {
  kpis: DashboardKPIs | null;
  role: Role | null;
}) {
  const { t } = useI18n();
  const term = useTerm();
  // On a phone the snapshot folds behind "More numbers": the first screens
  // belong to what needs you and the desk row (F500 G5).
  const wide = useMinWidth(640);
  const [open, setOpen] = useState(false);
  const tiles = kpis ? buildKpis(kpis, role, term) : null;
  const shown = wide || open;
  return (
    <section aria-label={t('adminHome.workforceSnapshot')} className="space-y-3">
      <SectionTitle
        icon={Activity}
        title={t('adminHome.workforceSnapshot')}
        trailing={
          wide ? undefined : (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              aria-controls="admin-snapshot"
              className="inline-flex min-h-11 items-center gap-1 text-xs text-accent hover:underline"
            >
              {open ? 'Fewer numbers' : 'More numbers'}
              {open ? <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />}
            </button>
          )
        }
      />
      {shown && (
        <div id="admin-snapshot">
          {tiles ? (
            // One strip: four across from lg, two on a phone, never an
            // orphan; the tiles link to the list behind each number.
            <MetricStrip label={t('adminHome.workforceSnapshot')}>
              {tiles.map((kpi) => (
                <KpiTile key={kpi.label} kpi={kpi} />
              ))}
            </MetricStrip>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4" aria-busy="true">
              {Array.from({ length: 4 }).map((_, i) => (
                <Card key={i}>
                  <CardContent>
                    <Skeleton className="h-3 w-20 mb-3" />
                    <Skeleton className="h-9 w-1/2 mb-2" />
                    <Skeleton className="h-3 w-1/3" />
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** Attach a deltaLabel only when the API sent that series. */
function withLabel(
  trend: KpiTrend | undefined,
  deltaLabel: string,
): Kpi['trend'] {
  // The API's last bucket is this week so far.
  return trend ? { ...trend, deltaLabel, lastIsPartial: true } : undefined;
}

function buildKpis(k: DashboardKPIs, role: Role | null, term: (key: TermKey) => string): Kpi[] {
  const has = (cap: Capability) => (role ? hasCapability(role, cap) : false);
  // A tile links out only when the viewer can actually open the destination
  // module (/people → view:org, /onboarding → view:onboarding, /payroll →
  // view:payroll, /scheduling → view:scheduling); otherwise it renders as a
  // plain, unlinked tile — no dead ends into 403s.
  const linkTo = (to: string, cap: Capability) =>
    has(cap) ? to : undefined;

  const xs: Kpi[] = [
    {
      // Brief 2-1b: the tenant's word for its people (a hotel says team members).
      // "Working" — one of the two named numbers every page shows
      // (apps/api/src/lib/peopleStatus.ts), with "On the books" beside it.
      label: `Working (${k.activeWindowDays ?? 14} days)`,
      value: fmtInt(k.activeAssociates),
      hint: `${k.onTheBooks !== undefined ? `${fmtInt(k.onTheBooks)} ${term('workers').toLowerCase()} on the books · ` : ''}${k.associatesClockedIn > 0 ? `${fmtInt(k.associatesClockedIn)} clocked in now` : 'No one on the clock'}`,
      icon: Users,
      to: linkTo('/people?workStatus=ACTIVE', 'view:org'),
      // No sparkline: the weekly series the API has is hires, not this number.
    },
    {
      label: `Open shifts · next ${k.windowDays}d`,
      value: fmtInt(k.openShiftsNext30d),
      hint: k.openShiftsNext30d === 0 ? 'Schedule fully covered' : 'Still to fill',
      icon: CalendarPlus,
      // The open ones, from today (the scheduling lens ?open=1).
      to: linkTo('/scheduling?open=1', 'view:scheduling'),
      // No sparkline: the weekly series the API has counts shifts SCHEDULED,
      // not open ones — a line under this number measured something else.
    },
  ];
  // Hours worked: the last complete week as the figure, the week so far
  // in the hint, eight weeks on the line.
  const hours = k.trends?.hoursWorked;
  if (hours && hours.series.length >= 2 && has('view:time')) {
    const lastWeek = hours.series[hours.series.length - 2] ?? 0;
    const soFar = hours.series[hours.series.length - 1] ?? 0;
    xs.push({
      label: 'Hours worked · last week',
      value: fmtHours(lastWeek),
      hint: soFar > 0 ? `${fmtHours(soFar)} so far this week` : 'None clocked yet this week',
      icon: Clock,
      to: linkTo('/time-attendance', 'view:time'),
      trend: { ...hours, deltaLabel: 'vs the week before', format: fmtHours, lastIsPartial: true },
      trendGood: 'neutral',
    });
  }
  // Onboarding pipeline (and its I-9 Section 2 hint — compliance-adjacent)
  // only for roles that can see onboarding; the API zeroes these counts for
  // bounded roles anyway, but a permanent "0" tile is just noise.
  if (has('view:onboarding')) {
    xs.push({
      label: 'Onboarding in flight',
      value: fmtInt(k.pendingOnboardingApplications),
      hint:
        k.pendingI9Section2 > 0
          ? `${k.pendingI9Section2} I-9 Section 2 pending`
          : 'I-9s up to date',
      icon: ClipboardList,
      // ACTIVE = the in-flight working set the tile counts — beats a
      // persisted "Archived" chip from a previous visit.
      to: linkTo('/onboarding?status=ACTIVE', 'view:onboarding'),
      // Series is new applications per week.
      trend: withLabel(k.trends?.applications, 'new vs last wk'),
    });
  }
  // Money tiles (net paid + pending disbursement) only for payroll-capable
  // roles — the API clamps these to $0 for bounded roles, and rendering a
  // zeroed money tile reads as "nobody got paid", which is worse than
  // rendering nothing. Not on the HR desk's home: payroll's number lives on
  // payroll's home, and the snapshot stays four across (F500 G5).
  if (has('view:payroll') && role !== 'HR_ADMINISTRATOR') {
    xs.push({
      label: `Net paid · last ${k.windowDays}d`,
      value: fmtMoney(k.netPaidLast30d),
      hint:
        k.netPendingDisbursement > 0
          ? `${fmtMoney(k.netPendingDisbursement)} queued`
          : 'No pending runs',
      icon: DollarSign,
      to: linkTo('/payroll', 'view:payroll'),
    });
  }
  return xs;
}

/** The kit's KPI tile; a destination makes it a link (no "View details" in a strip). */
function KpiTile({ kpi }: { kpi: Kpi }) {
  return (
    <MetricCard
      label={kpi.label}
      value={kpi.value}
      hint={kpi.hint}
      trend={kpi.trend}
      trendGood={kpi.trendGood}
      href={kpi.to}
    />
  );
}

/* =========================== Onboarding funnel =========================== */

const PIPELINE_ORDER = ['DRAFT', 'SUBMITTED', 'IN_REVIEW', 'APPROVED', 'REJECTED'] as const;
const PIPELINE_LABEL: Record<(typeof PIPELINE_ORDER)[number], string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted',
  IN_REVIEW: 'In review',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
};
const PIPELINE_TONE: Record<(typeof PIPELINE_ORDER)[number], string> = {
  DRAFT: 'text-silver',
  SUBMITTED: 'text-warning',
  IN_REVIEW: 'text-warning',
  APPROVED: 'text-success',
  REJECTED: 'text-alert',
};
/** A stage's colour: only a non-zero count wears one ("Rejected 0" in red read as a problem). */
const pipelineTone = (status: (typeof PIPELINE_ORDER)[number], count: number): string =>
  count === 0 ? 'text-silver' : PIPELINE_TONE[status];

function OnboardingFunnel({ kpis }: { kpis: DashboardKPIs | null }) {
  const { t } = useI18n();
  if (!kpis) {
    return (
      <section aria-label={t('adminHome.onboardingPipeline')} className="space-y-3">
        <SectionTitle icon={ClipboardList} title={t('adminHome.onboardingPipeline')} />
        <Card>
          <CardContent className="py-6 grid grid-cols-2 md:grid-cols-5 gap-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i}>
                <Skeleton className="h-3 w-16 mb-2" />
                <Skeleton className="h-7 w-10" />
              </div>
            ))}
          </CardContent>
        </Card>
      </section>
    );
  }
  const counts = kpis.applicationStatusCounts;
  const total = PIPELINE_ORDER.reduce(
    (sum, status) => sum + (counts[status] ?? 0),
    0,
  );
  if (total === 0) {
    return (
      <section aria-label={t('adminHome.onboardingPipeline')} className="space-y-3">
        <SectionTitle icon={ClipboardList} title={t('adminHome.onboardingPipeline')} />
        <EmptyState
          icon={ClipboardList}
          title={t('adminHome.noApplications')}
          description={t('adminHome.noApplicationsBody')}
          action={
            <Link
              to="/onboarding"
              className="inline-flex items-center gap-1 text-sm text-gold hover:text-gold-bright"
            >
              {t('adminHome.openOnboarding')}
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          }
        />
      </section>
    );
  }
  return (
    <section aria-label={t('adminHome.onboardingPipeline')} className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <SectionTitle icon={ClipboardList} title={t('adminHome.onboardingPipeline')} className="mb-0" />
        <Link
          // "View all" means ALL — the explicit param beats the persisted
          // status chip, which could silently narrow the landing.
          to="/onboarding?status=ALL"
          className="text-xs text-gold hover:text-gold-bright inline-flex min-h-6 items-center gap-1"
        >
          View all
          <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
      <Card>
        <CardContent className="py-5">
          {/* Two rows on a phone (three stages, then two), one row from md. */}
          <div className="grid grid-cols-6 md:grid-cols-5 gap-4">
            {PIPELINE_ORDER.map((status, i) => {
              const count = counts[status] ?? 0;
              const pct = total > 0 ? Math.round((count / total) * 100) : 0;
              return (
                <Link
                  key={status}
                  // APPROVED/REJECTED aren't standalone filters in the list —
                  // they live under the "Archived" view; the in-flight states
                  // map straight through.
                  to={`/onboarding?status=${
                    status === 'APPROVED' || status === 'REJECTED'
                      ? 'ARCHIVED'
                      : status
                  }`}
                  className={cn(
                    'min-w-0 block rounded-md -m-1 p-1 hover:bg-navy-secondary/40 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright',
                    i < 3 ? 'col-span-2 md:col-span-1' : 'col-span-3 md:col-span-1',
                  )}
                  title={`View ${PIPELINE_LABEL[status].toLowerCase()} applications`}
                >
                  <div className="text-2xs uppercase tracking-widest text-silver">
                    {PIPELINE_LABEL[status]}
                  </div>
                  <div
                    className={cn(
                      'font-display text-3xl mt-1 tabular-nums',
                      pipelineTone(status, count),
                    )}
                  >
                    {count}
                  </div>
                  {/* Inline funnel bar — width relative to total. */}
                  <div className="mt-2 h-1.5 rounded-full bg-navy-secondary/60 overflow-hidden">
                    <div
                      className={cn(
                        'h-full rounded-full',
                        status === 'APPROVED'
                          ? 'bg-success/70'
                          : status === 'REJECTED'
                            ? 'bg-alert/70'
                            : 'bg-gold/70',
                      )}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <div className="text-2xs text-silver/70 mt-1 tabular-nums">
                    {pct}% of pipeline
                  </div>
                </Link>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </section>
  );
}

/* ============================== Activity feed ============================ */

const ACTIVITY_FEED_PREVIEW = 6;

// Map an audit entry's entity to an in-app route when one exists, so the
// activity row becomes a cross-link. Only the entity types that have a real
// destination are linkable; everything else stays plain text. People have no
// standalone detail page — the directory opens a drawer via ?associateId.
function entityHref(entityType: string, entityId: string): string | null {
  switch (entityType.toLowerCase()) {
    case 'application':
      return `/onboarding/applications/${entityId}`;
    case 'associate':
    case 'person':
      return `/people?associateId=${entityId}`;
    default:
      return null;
  }
}

function ActivityFeed({
  entries,
  error,
  onRetry,
}: {
  entries: AuditSearchEntry[] | null;
  error: boolean;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  const term = useTerm();
  const { moduleOn } = useTenant();
  // A record's kind in the company's own words (a hotel never reads "Client" or "Associate").
  const entityLabel = (type: string): string => {
    switch (type) {
      case 'Client':
        return moduleOn('clientPortal') ? term('label.client') : 'Account';
      case 'Associate':
        return term('role.associate');
      case 'Site':
      case 'Location':
        return term('label.store');
      default: {
        const words = type.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
        return words.charAt(0).toUpperCase() + words.slice(1);
      }
    }
  };
  const [expanded, setExpanded] = useState(false);
  const collapsible =
    entries !== null && entries.length > ACTIVITY_FEED_PREVIEW;
  const visible =
    entries === null
      ? null
      : expanded
        ? entries
        : entries.slice(0, ACTIVITY_FEED_PREVIEW);

  return (
    <section aria-label={t('adminHome.recentActivity')} className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <SectionTitle icon={FileText} title={t('adminHome.recentActivity')} className="mb-0" />
        <Link
          to="/audit"
          className="text-xs text-gold hover:text-gold-bright inline-flex items-center gap-1"
        >
          {t('adminHome.auditLog')}
          <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
      <Card>
        <CardContent className="p-0">
          {error ? (
            <div className="p-6 text-center">
              <div role="alert" className="text-sm text-alert">
                Couldn't load recent activity.
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
          ) : entries === null ? (
            <div className="p-5 space-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3">
                  <Skeleton className="h-8 w-8 rounded-full" />
                  <div className="flex-1">
                    <Skeleton className="h-3 w-2/3 mb-1.5" />
                    <Skeleton className="h-3 w-1/3" />
                  </div>
                </div>
              ))}
            </div>
          ) : entries.length === 0 ? (
            <div className="p-6 text-center text-silver text-sm">
              No activity in the audit log yet — events will appear here as
              people use the platform.
            </div>
          ) : (
            <>
              <ul className="divide-y divide-navy-secondary">
                {visible!.map((e) => {
                  const href = e.entityId
                    ? entityHref(e.entityType, e.entityId)
                    : null;
                  return (
                    <li
                      key={e.id}
                      className="px-5 py-3 flex items-center gap-3 hover:bg-navy-secondary/20 transition-colors"
                    >
                      <Avatar
                        src={userPhotoUrl(e.actorUserId)}
                        name={e.actorEmail ? null : 'System'}
                        email={e.actorEmail}
                        size="sm"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-white truncate">
                          <span className="text-silver">
                            {e.actorEmail ?? 'System'}
                          </span>{' '}
                          {humanizeAction(e.action)}
                        </div>
                        <div className="text-xs2 text-silver/70">
                          {href ? (
                            <Link
                              to={href}
                              className="text-gold hover:text-gold-bright"
                            >
                              {entityLabel(e.entityType)}
                            </Link>
                          ) : (
                            entityLabel(e.entityType)
                          )}{' '}
                          ·{' '}
                          <span className="tabular-nums">
                            {fmtRelativeDate(e.createdAt)}
                          </span>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
              {collapsible && (
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
                        Show {entries.length} most recent
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
