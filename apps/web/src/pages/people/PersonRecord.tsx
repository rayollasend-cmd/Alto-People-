import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CalendarDays, CheckCircle2, Clock, FileWarning, Gauge, KeyRound, MapPin, MessageSquare, Palmtree, PauseCircle, Smartphone, Ticket, UserRound, UserX } from 'lucide-react';
import type { DirectoryEntry, PersonOverview, TimeEntry, TimeOffEntitlement, TimeOffRequest } from '@alto-people/shared';
import { RecordTemplate } from '@/components/templates';
import { personRecordTabs, type PersonTabKey } from '@/lib/personTabs';
import { WorkThreadPanel } from '@/components/WorkThreadPanel';
import { Badge, Button, Card, CardContent, EmptyState, Label, MetricCard, MetricStrip, SectionTitle, Skeleton, SkeletonRows } from '@/components/ui';
import type { PageAction } from '@/components/ui/PageHeader';
import { PeopleStatusBadge, workStatusOf } from '@/components/ui/PeopleStatusBadge';
import { StateCertificateCard } from '@/components/payroll/StateCertificateCard';
import { TaxWithholdingCard } from '@/components/payroll/TaxWithholdingCard';
import { RothCatchUpCard } from '@/components/payroll/RothCatchUpCard';
import { PaySummaryCard } from '@/components/payroll/PaySummaryCard';
import { FederalW4Card } from '@/components/payroll/FederalW4Card';
import { LocalTaxRuleCard } from '@/components/payroll/LocalTaxRuleCard';
import { getCareerPosition } from '@/lib/career126Api';
import { CareerLadderView } from '@/pages/career/CareerPosition';
import { DataGrid } from '@/components/ui/DataGrid';
import { QueryError } from '@/components/ui/QueryError';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Textarea } from '@/components/ui/Input';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { sendNotification } from '@/lib/communicationsApi';
import { useAuth, useTenant, useTerm } from '@/lib/auth';
import { useAssistantRecord } from '@/lib/assistantContext';
import { getDirectoryEntry, personOverviewQuery } from '@/lib/directoryApi';
import { EMPLOYMENT_LABEL } from '@/lib/employmentLabels';
import { fmtDate, fmtDateTz, fmtHours, fmtMinutes, fmtRelativeDayTz, fmtShiftRangeTz, parseYmd, ymdLocal, ymdToIsoStart } from '@/lib/format';
import { useUrlParam } from '@/lib/useUrlState';
import { fmtPunchTime } from '@/pages/time/punchFormat';

/** "Jun 13, 2026": a punch's day on its site's clock (the display zone with no site). */
const punchDay = (e: { clockInAt: string; locationTimezone?: string | null }) =>
  e.locationTimezone ? fmtDateTz(e.clockInAt, e.locationTimezone, { year: true }) : fmtDate(e.clockInAt);
import { getAssociateKioskPin, type KioskPin } from '@/lib/kiosk99Api';
import { listAdminTimeEntries } from '@/lib/timeApi';
import { TIME_ENTRY_STATUS_TONES } from '@/lib/timeLabels';
import { listAdminEntitlements, listAdminRequests } from '@/lib/timeOffApi';
import { getPerfTimeline, listGoals, listOneOnOnes, listPips, type PerfTimelineEntry } from '@/lib/perf84Api';
import { getLadder, KIND_LABELS, type DisciplineKind } from '@/lib/discipline118Api';
import { CATEGORY_LABELS as CASE_CATEGORY_LABELS, listCaseQueue, type QueueCaseRow } from '@/lib/hrCases123Api';
import { StatusBadge, statusLabel, statusTone } from '@/lib/status';
import {
  CompensationTab,
  DeactivateDialog,
  DocumentsTab,
  EmploymentTab,
  EraseDialog,
  PaymentsTab,
  PersonTransferDialog,
  ProfilePhoto,
  ProfileTab,
  canPause,
  fmtPay,
  useReactivate,
} from './PeopleDirectory';
import { withReturn } from '@/lib/returnPath';
import { PromoteDialog } from './PromoteDialog';
import { OnBehalfCaseDrawer } from '../hrCases/OnBehalfCaseDrawer';
import { PunchPhotoCard } from '@/components/PunchPhotoCard';
import { ProtectedLeaveFlag } from '../leave/ProtectedLeaveFlag';

/**
 * One person's record (UX upgrade, 2026-10-16 — Rippling's one-record
 * model): who they are, where they work, their hours, their leave, their
 * performance and their cases on one URL. `?tab=` is the open facet, so a
 * notification can land on Time off or Cases.
 *
 * It opens on Overview (F500 fix-up, G1): what needs attention (onboarding
 * not finished, a clock-in number that won't work, not placed, no manager,
 * documents running out), their work (hours in the window, last and next
 * shift, time waiting approval, no-shows), their pay and their open cases
 * — the 13-section Profile is one tab over. It is the person's one home:
 * the People list opens it, and the old profile drawer's links land here.
 *
 * The facets are the directory's sections, reused (PeopleDirectory.tsx);
 * Time, Time off, Performance and Cases read the modules' per-person
 * endpoints and hide themselves from roles the API would turn away.
 */
type TabKey = PersonTabKey;

const TIME_WINDOW_DAYS = 30;

export function PersonRecord() {
  const { associateId = '' } = useParams();
  const term = useTerm();
  const { can, user } = useAuth();
  const [textOpen, setTextOpen] = useState(false);
  const [promoteOpen, setPromoteOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [deactivateOpen, setDeactivateOpen] = useState(false);
  const [eraseOpen, setEraseOpen] = useState(false);
  const { moduleOn } = useTenant();
  const qc = useQueryClient();
  const navigate = useNavigate();

  const hasClients = moduleOn('clientPortal');
  // What the API lets this role read — a tab the server would 403 is not shown.
  const canSeeComp = can('view:comp');
  const canSeePayments = can('process:payroll');
  const canSeeTime = can('manage:time') && moduleOn('time');
  const canSeeTimeOff = can('manage:time');
  const canSeePerformance = can('view:hr-admin');
  const canSeeLadder = canSeePerformance && moduleOn('hrCases');
  const canSeeCases = moduleOn('hrCases') && (can('manage:onboarding') || can('process:payroll'));

  // Same key as the directory's deep-link lookup, so a row opened there and
  // the record here share one cached person.
  const detail = useQuery({
    queryKey: ['directory', 'entry', associateId],
    queryFn: () => getDirectoryEntry(associateId),
    enabled: associateId.length > 0,
  });
  // The pane knows whose record this is: "this {term('worker')}" means them.
  useAssistantRecord(detail.data ? { type: term('worker'), id: detail.data.id, name: `${detail.data.firstName} ${detail.data.lastName}` } : null);
  const a = detail.data;

  const overview = useQuery({ ...personOverviewQuery(associateId), enabled: associateId.length > 0 && Boolean(a) });
  const time = usePersonTime(associateId, canSeeTime && Boolean(a));
  const timeOffRequests = usePersonTimeOffRequests(associateId, canSeeTimeOff && Boolean(a));
  const cases = usePersonCases(associateId, canSeeCases && Boolean(a));

  // The same rule ⌘K's person shortcuts use (lib/personTabs).
  const visibleTabs = useMemo(() => personRecordTabs(can, moduleOn), [can, moduleOn]);
  // A tab is a place: it pushes history, so Back returns to the last one.
  const [activeTab, setActiveTab] = useUrlParam<TabKey>('tab', 'overview', visibleTabs, { history: 'push' });

  // The sections patch the person as they save; here that patch lands on
  // the cached record, and the directory's lists refetch so a row there
  // agrees with the page.
  const onAssociateChange = (patch: Partial<DirectoryEntry>) => {
    qc.setQueryData<DirectoryEntry>(['directory', 'entry', associateId], (old) => (old ? { ...old, ...patch } : old));
    void qc.invalidateQueries({
      queryKey: ['directory'],
      predicate: (q) => q.queryKey[1] !== 'entry',
    });
  };
  const reactivation = useReactivate(a ?? ({ id: associateId } as DirectoryEntry), onAssociateChange);

  if (detail.isError) {
    return <QueryError what="this person" query={detail} />;
  }
  if (!a) {
    return (
      <div className="space-y-4" aria-busy="true" aria-label="Loading the person">
        <div className="flex items-center gap-4">
          <Skeleton className="h-16 w-16 rounded-full" />
          <div className="space-y-2">
            <Skeleton className="h-7 w-56" />
            <Skeleton className="h-4 w-80" />
          </div>
        </div>
        <Skeleton className="h-24" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  const name = `${a.firstName} ${a.lastName}`;
  const workerWord = term('worker').toLowerCase();
  const managerWord = term('manager');
  const siteWord = term('site');
  const status = workStatusOf(a);
  const tabHref = (tab: TabKey) => `/people/${a.id}${tab === 'overview' ? '' : `?tab=${tab}`}`;
  // Separation is an org change (manage:org), offered while they still work here.
  const canSeparate = can('manage:org') && !a.separatedAt;
  const canTransfer = can('manage:org') && Boolean(a.workplaceClientId) && !a.separatedAt;
  const subtitle = [
    a.position,
    hasClients ? a.workplaceClientName : null,
    a.currentLocationName,
    EMPLOYMENT_LABEL[a.employmentType] ?? a.employmentType,
  ]
    .filter(Boolean)
    .join(' · ');
  // The "why" beside the status, the same facts the list explains.
  const statusWhy =
    status === 'ONBOARDING' && a.onboardingPercent !== null
      ? `Onboarding ${a.onboardingPercent}% complete`
      : a.deactivatedAt
        ? `Paused ${fmtDate(a.deactivatedAt)}${a.deactivationReason ? ` — ${a.deactivationReason}` : ''}`
        : a.separatedAt
          ? `Separated ${fmtDate(a.separatedAt)}`
          : null;

  const ov = overview.data;
  const windowDays = ov?.windowDays ?? 14;

  // The header's actions: one primary (reach them), the life-cycle moves
  // in More, the ones that end or erase something kept apart at its foot.
  const canMessage = Boolean(a.messageUserId) && user?.role !== 'ASSOCIATE';
  const canText = !a.messageUserId && Boolean(a.phone) && can('manage:communications');
  const actionList: Array<PageAction | null> = [
    canMessage
      ? { key: 'message', label: 'Message', icon: MessageSquare, to: `/messages?to=${a.messageUserId}`, primary: true }
      : null,
    canText ? { key: 'text', label: 'Text', icon: Smartphone, onSelect: () => setTextOpen(true), primary: true } : null,
    a.deactivatedAt && can('manage:org')
      ? { key: 'reactivate', label: 'Reactivate', onSelect: () => void reactivation.reactivate(), loading: reactivation.busy }
      : null,
    canTransfer
      ? { key: 'transfer', label: a.currentLocationId ? 'Transfer…' : `Assign to a ${siteWord.toLowerCase()}…`, onSelect: () => setTransferOpen(true), overflow: true }
      : null,
    can('manage:comp') && !a.separatedAt ? { key: 'promote', label: 'Promote…', onSelect: () => setPromoteOpen(true), overflow: true } : null,
    can('manage:org') && canPause(a) ? { key: 'deactivate', label: `Deactivate…`, onSelect: () => setDeactivateOpen(true), overflow: true } : null,
    canSeparate ? { key: 'separate', label: 'Separate…', onSelect: () => navigate(withReturn(`/separations?associateId=${a.id}`, `/people/${a.id}`)), destructive: true } : null,
    can('view:hr-admin') ? { key: 'erase', label: 'Erase personal data…', onSelect: () => setEraseOpen(true), destructive: true } : null,
  ];
  const actions = actionList.filter((x): x is PageAction => x !== null);

  const tabs = [
    {
      key: 'overview',
      label: 'Overview',
      content: (
        <OverviewTab
          associate={a}
          overview={overview}
          windowDays={windowDays}
          tabHref={tabHref}
          canSeeTime={canSeeTime}
          canSeePay={canSeeComp}
          cases={canSeeCases ? cases : null}
          onTransfer={canTransfer ? () => setTransferOpen(true) : null}
          onReactivate={a.deactivatedAt && can('manage:org') ? () => void reactivation.reactivate() : null}
        />
      ),
    },
    {
      key: 'profile',
      label: 'Profile',
      content: <ProfileTab associate={a} onAssociateChange={onAssociateChange} />,
    },
    { key: 'employment', label: 'Employment', content: <EmploymentTab associateId={a.id} /> },
    {
      key: 'pay',
      label: 'Pay',
      content: (
        <div className="space-y-8">
          {/* In-house payroll first (finance walk 19): schedule, pay account, paystubs, year to date. */}
          {can('process:payroll') && <PaySummaryCard associateId={a.id} />}
          {canSeeComp && <CompensationTab associate={a} />}
          {can('process:payroll') && <FederalW4Card associateId={a.id} />}
          {can('process:payroll') && <StateCertificateCard mode="hr" associateId={a.id} />}
          {can('process:payroll') && <TaxWithholdingCard associateId={a.id} />}
          {can('process:payroll') && <LocalTaxRuleCard associateId={a.id} />}
          {can('process:payroll') && <RothCatchUpCard associateId={a.id} />}
          {canSeePayments && (
            <div className="space-y-3">
              <SectionTitle title="Before in-house payroll" description="Pay periods an outside provider paid, with the evidence on file." />
              <PaymentsTab associateId={a.id} />
            </div>
          )}
        </div>
      ),
    },
    { key: 'time', label: 'Time', count: time.data?.entries.length, content: <TimeTab associateId={a.id} query={time} /> },
    {
      key: 'timeoff',
      label: 'Time off',
      count: timeOffRequests.data?.requests.length,
      content: <TimeOffTab associateId={a.id} requests={timeOffRequests} />,
    },
    { key: 'performance', label: 'Performance', content: <PerformanceTab associateId={a.id} showLadder={canSeeLadder} /> },
    { key: 'cases', label: 'Cases', count: cases.data?.cases.length, content: <CasesTab query={cases} workerWord={workerWord} person={{ id: a.id, name }} canOpen={can('manage:onboarding')} /> },
    { key: 'documents', label: 'Documents', content: <DocumentsTab associateId={a.id} /> },
    { key: 'thread', label: 'Thread', content: <WorkThreadPanel associateId={a.id} /> },
  ].filter((t) => (visibleTabs as readonly string[]).includes(t.key));

  const next = ov?.work.nextShift ?? null;
  const nextDay = next ? fmtRelativeDayTz(next.startsAt, next.timezone) : null;
  const nextTimes = next ? fmtShiftRangeTz(next.startsAt, next.endsAt, next.timezone) : null;
  const hoursText = ov ? fmtHours(Math.round((ov.work.minutes / 60) * 10) / 10) : '…';
  const lastWorked = ov?.work.lastWorkedAt ?? a.lastWorkedAt ?? null;

  return (
    <RecordTemplate
      breadcrumbs={[{ label: term('nav.people'), to: '/people' }, { label: name }]}
      identity={<ProfilePhoto associate={a} onAssociateChange={onAssociateChange} />}
      title={name}
      subtitle={subtitle || `No position on record for this ${workerWord}`}
      status={
        <span className="inline-flex flex-wrap items-center gap-2">
          <PeopleStatusBadge status={status} windowDays={windowDays} size="lg" />
          {a.j1Status && <Badge variant="default">J-1</Badge>}
          <ProtectedLeaveFlag associateId={associateId} />
          {statusWhy && <span className="text-xs text-ink-muted">{statusWhy}</span>}
        </span>
      }
      actions={actions.length > 0 ? actions : undefined}
      related={[
        { label: 'Schedule', to: `/scheduling?associate=${a.id}` },
        ...(canSeeTime ? [{ label: term('label.timesheet'), to: `/time-attendance?associate=${a.id}&name=${encodeURIComponent(name)}` }] : []),
      ]}
      summary={
        <>
          {/* A phone reads the record in two lines, not five half-width
              tiles (role walk HR 15); the Overview tab below has the rest. */}
          <div className="space-y-0.5 text-sm sm:hidden" data-testid="person-summary-phone">
            <p className="truncate text-ink">
              {[
                ov ? `${hoursText} in ${windowDays} days` : null,
                next ? `Next shift ${nextDay}` : ov ? 'No shift scheduled' : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
            <p className="truncate text-ink-muted">
              {[a.currentLocationName ?? 'Not placed', a.managerName ? `${managerWord}: ${a.managerName}` : `No ${managerWord.toLowerCase()}`].join(' · ')}
            </p>
          </div>
          <div className="hidden sm:block">
            <MetricStrip label="At a glance">
              <MetricCard
                label={siteWord}
                value={a.currentLocationName ?? 'Not placed'}
                hint={
                  a.currentLocationName
                    ? [hasClients ? a.workplaceClientName : null, a.currentAssignmentStartedAt ? `since ${fmtDate(parseYmd(a.currentAssignmentStartedAt) ?? a.currentAssignmentStartedAt)}` : null].filter(Boolean).join(' · ') || undefined
                    : hasClients && a.workplaceClientName
                      ? `Hired for ${a.workplaceClientName}`
                      : undefined
                }
                compact
              />
              <MetricCard
                label={managerWord}
                value={
                  a.managerName ? (
                    a.managerId ? (
                      <Link to={`/people/${a.managerId}`} className="hover:text-gold-bright">
                        {a.managerName}
                      </Link>
                    ) : (
                      a.managerName
                    )
                  ) : (
                    'None'
                  )
                }
                hint={a.departmentName ?? 'No department'}
                nothing={a.managerName ? undefined : `No ${managerWord.toLowerCase()} assigned`}
                compact
              />
              <MetricCard
                label={`Hours (${windowDays} days)`}
                value={hoursText}
                hint={ov ? (ov.work.entries === 0 ? 'No clock-ins' : `${ov.work.entries} clock-in${ov.work.entries === 1 ? '' : 's'}`) : undefined}
                href={canSeeTime ? tabHref('time') : undefined}
                compact
              />
              <MetricCard
                label="Last worked"
                value={lastWorked ? fmtDate(lastWorked) : 'Never'}
                nothing={lastWorked ? undefined : 'No clock-ins yet'}
                compact
              />
              <MetricCard
                label="Next shift"
                value={next ? nextDay : '…'}
                hint={next ? [nextTimes, next.locationName].filter(Boolean).join(' · ') : undefined}
                nothing={ov && !next ? 'None scheduled' : undefined}
                compact
              />
            </MetricStrip>
          </div>
          {textOpen && <TextDialog phone={a.phone!} name={name} onClose={() => setTextOpen(false)} />}
          {promoteOpen && (
            <PromoteDialog
              associate={{ id: a.id, firstName: a.firstName, lastName: a.lastName }}
              currentAmount={a.payAmount ? Number(a.payAmount) : null}
              currentPayType={a.payType === 'SALARY' ? 'SALARY' : a.payType === 'HOURLY' ? 'HOURLY' : null}
              open={promoteOpen}
              onOpenChange={setPromoteOpen}
            />
          )}
          {canTransfer && (
            <PersonTransferDialog open={transferOpen} onOpenChange={setTransferOpen} associate={a} onAssociateChange={onAssociateChange} />
          )}
          <DeactivateDialog associate={a} open={deactivateOpen} onOpenChange={setDeactivateOpen} onAssociateChange={onAssociateChange} />
          <EraseDialog associate={a} open={eraseOpen} onOpenChange={setEraseOpen} onErased={() => navigate('/people')} />
        </>
      }
      activeTab={activeTab}
      onTabChange={(k) => setActiveTab(k as TabKey)}
      tabs={tabs}
    />
  );
}

/* ---------------------------------------------------------------- overview */

interface AttentionItem {
  key: string;
  icon: React.ComponentType<{ className?: string }>;
  tone: 'alert' | 'warning' | 'info';
  text: React.ReactNode;
  action?: { label: string; to?: string; onSelect?: () => void };
}

/** "1 document" / "3 documents". */
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Where the kiosk admin issues (or re-issues) their number, preselected on them. */
function issueLinkFor(a: DirectoryEntry): string {
  return `/time-attendance/kiosk?tab=pins&issue=${a.id}${a.workplaceClientId ? `&client=${a.workplaceClientId}` : ''}&return=${encodeURIComponent(`/people/${a.id}`)}`;
}

/** What needs someone's attention on this record, most pressing first. */
function attentionItems(opts: {
  a: DirectoryEntry;
  ov: PersonOverview | undefined;
  pin: KioskPin | null | undefined;
  windowDays: number;
  managerWord: string;
  siteWord: string;
  tabHref: (tab: TabKey) => string;
  canSeeTime: boolean;
  onTransfer: (() => void) | null;
  onReactivate: (() => void) | null;
}): AttentionItem[] {
  const { a, ov, pin, windowDays, managerWord, siteWord, tabHref } = opts;
  const status = workStatusOf(a);
  const onBooks = status === 'ACTIVE' || status === 'PLACED_NOT_ACTIVE' || status === 'NOT_PLACED';
  const items: AttentionItem[] = [];
  if (a.deactivatedAt) {
    items.push({
      key: 'paused',
      icon: PauseCircle,
      tone: 'warning',
      text: `Paused since ${fmtDate(a.deactivatedAt)}${a.deactivationReason ? ` — ${a.deactivationReason}` : ''}. They can't clock in or be scheduled.`,
      ...(opts.onReactivate ? { action: { label: 'Reactivate', onSelect: opts.onReactivate } } : {}),
    });
  }
  if (status === 'ONBOARDING') {
    items.push({
      key: 'onboarding',
      icon: UserRound,
      tone: 'info',
      text: a.onboardingPercent !== null ? `Onboarding is ${a.onboardingPercent}% done.` : 'Onboarding is in progress.',
      ...(a.applicationId ? { action: { label: 'Open the application', to: `/onboarding/applications/${a.applicationId}` } } : {}),
    });
  }
  if (opts.canSeeTime && pin && !a.deactivatedAt && !a.separatedAt) {
    const mismatch = Boolean(a.workplaceClientId && pin.clientId !== a.workplaceClientId);
    if (mismatch || pin.wontClockIn) {
      items.push({
        key: 'pin',
        icon: KeyRound,
        tone: 'alert',
        text: mismatch
          ? `Their clock-in number won't work: it's filed under ${pin.clientName}, not ${a.workplaceClientName ?? 'their current client'}.`
          : "Their clock-in number won't work at the kiosk (the PIN secret changed since it was issued).",
        action: { label: 'Re-issue', to: issueLinkFor(a) },
      });
    }
  } else if (opts.canSeeTime && pin === null && onBooks && !a.deactivatedAt) {
    items.push({ key: 'pin', icon: KeyRound, tone: 'warning', text: 'No clock-in number issued yet.', action: { label: 'Issue a number', to: issueLinkFor(a) } });
  }
  if (status === 'NOT_PLACED') {
    items.push({
      key: 'placed',
      icon: MapPin,
      tone: 'warning',
      text: `Hired, but not placed at a ${siteWord.toLowerCase()}.`,
      ...(opts.onTransfer ? { action: { label: `Assign to a ${siteWord.toLowerCase()}`, onSelect: opts.onTransfer } } : {}),
    });
  }
  if (status === 'PLACED_NOT_ACTIVE') {
    items.push({
      key: 'idle',
      icon: CalendarDays,
      tone: 'warning',
      text: `No shift worked in the last ${windowDays} days, and nothing scheduled.`,
      action: { label: 'Schedule them', to: `/scheduling?associate=${a.id}` },
    });
  }
  if (onBooks && !a.managerId) {
    items.push({ key: 'manager', icon: UserX, tone: 'info', text: `No ${managerWord.toLowerCase()} assigned.`, action: { label: `Set a ${managerWord.toLowerCase()}`, to: tabHref('profile') } });
  }
  if (ov?.documents && ov.documents.expired > 0) {
    items.push({ key: 'expired', icon: FileWarning, tone: 'alert', text: `${plural(ov.documents.expired, 'document')} expired.`, action: { label: 'Open documents', to: tabHref('documents') } });
  }
  if (ov?.documents && ov.documents.expiringSoon > 0) {
    items.push({
      key: 'expiring',
      icon: FileWarning,
      tone: 'warning',
      text: `${plural(ov.documents.expiringSoon, 'document')} ${ov.documents.expiringSoon === 1 ? 'expires' : 'expire'} in the next 30 days.`,
      action: { label: 'Open documents', to: tabHref('documents') },
    });
  }
  if (ov && ov.work.noShows30d > 0) {
    items.push({ key: 'noshow', icon: AlertTriangle, tone: 'alert', text: `${plural(ov.work.noShows30d, 'no-call no-show')} in the last 30 days.` });
  }
  if (opts.canSeeTime && ov && ov.work.awaitingReview > 0) {
    items.push({
      key: 'review',
      icon: Clock,
      tone: 'info',
      text: `${plural(ov.work.awaitingReview, 'clock-in')} waiting for approval.`,
      // Any date, so the full history (the Time tab shows 30 days).
      action: { label: 'Review time', to: `/time-attendance/timesheets/history/${a.id}` },
    });
  }
  return items;
}

const TONE_ICON: Record<AttentionItem['tone'], string> = {
  alert: 'text-alert',
  warning: 'text-warning',
  info: 'text-ink-muted',
};

function OverviewTab({
  associate: a,
  overview,
  windowDays,
  tabHref,
  canSeeTime,
  canSeePay,
  cases,
  onTransfer,
  onReactivate,
}: {
  associate: DirectoryEntry;
  overview: { data?: PersonOverview; isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown; isFetching: boolean };
  windowDays: number;
  tabHref: (tab: TabKey) => string;
  canSeeTime: boolean;
  canSeePay: boolean;
  /** Their cases, when this login works cases. */
  cases: ReturnType<typeof usePersonCases> | null;
  onTransfer: (() => void) | null;
  onReactivate: (() => void) | null;
}) {
  const term = useTerm();
  const pin = useQuery({ queryKey: ['kiosk-pin', a.id], queryFn: () => getAssociateKioskPin(a.id), enabled: canSeeTime });
  const ov = overview.data;
  const items = attentionItems({
    a,
    ov,
    pin: canSeeTime ? (pin.isSuccess ? pin.data : undefined) : undefined,
    windowDays,
    managerWord: term('manager'),
    siteWord: term('site'),
    tabHref,
    canSeeTime,
    onTransfer,
    onReactivate,
  });
  const next = ov?.work.nextShift ?? null;
  const openCases = cases?.data ? cases.data.cases.filter((c) => c.status !== 'RESOLVED' && c.status !== 'CLOSED').length : null;
  const hasPay = canSeePay || ov?.pay !== undefined;

  return (
    <div className="grid items-start gap-[var(--d-stack)] lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <Card>
        <CardContent className="space-y-3 py-4">
          <SectionTitle title="Needs attention" size="sm" className="mb-0" />
          {overview.isPending && !ov ? (
            <SkeletonRows count={2} rowHeight="h-8" />
          ) : items.length === 0 ? (
            <p className="flex items-center gap-2 text-sm text-ink-muted" data-testid="attention-none">
              <CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" />
              All clear on this record.
            </p>
          ) : (
            <ul className="divide-y divide-line" data-testid="attention-list">
              {items.map((it) => (
                <li key={it.key} className="flex flex-wrap items-start gap-x-3 gap-y-1 py-2 first:pt-0 last:pb-0">
                  <it.icon className={cn('mt-0.5 h-4 w-4 shrink-0', TONE_ICON[it.tone])} aria-hidden="true" />
                  <p className="min-w-0 flex-1 text-sm text-ink">{it.text}</p>
                  {it.action &&
                    (it.action.to ? (
                      <Link to={it.action.to} className="basis-full pl-7 text-sm font-medium text-gold hover:text-gold-bright sm:basis-auto sm:pl-0">
                        {it.action.label}
                      </Link>
                    ) : (
                      <button type="button" onClick={it.action.onSelect} className="basis-full pl-7 text-left text-sm font-medium text-gold hover:text-gold-bright sm:basis-auto sm:pl-0">
                        {it.action.label}
                      </button>
                    ))}
                </li>
              ))}
            </ul>
          )}
          {overview.isError && <QueryError what="their numbers" query={overview} />}
        </CardContent>
      </Card>

      <div className="space-y-[var(--d-stack)]">
        <Card>
          <CardContent className="space-y-3 py-4">
            <SectionTitle title="Work" size="sm" className="mb-0" />
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
              <dt className="text-ink-muted">Hours ({windowDays} days)</dt>
              <dd className="tabular-nums text-ink">
                {ov ? (
                  canSeeTime ? (
                    <Link to={tabHref('time')} className="hover:text-gold-bright">
                      {fmtHours(Math.round((ov.work.minutes / 60) * 10) / 10)}
                    </Link>
                  ) : (
                    fmtHours(Math.round((ov.work.minutes / 60) * 10) / 10)
                  )
                ) : (
                  '…'
                )}
              </dd>
              <dt className="text-ink-muted">Last worked</dt>
              <dd className="text-ink">{ov ? (ov.work.lastWorkedAt ? fmtDate(ov.work.lastWorkedAt) : 'Never') : '…'}</dd>
              <dt className="text-ink-muted">Next shift</dt>
              <dd className="text-ink">
                {ov ? (
                  next ? (
                    <>
                      {fmtRelativeDayTz(next.startsAt, next.timezone)} · {fmtShiftRangeTz(next.startsAt, next.endsAt, next.timezone)}
                      <span className="block text-xs text-ink-muted">{[next.position, next.locationName].filter(Boolean).join(' · ')}</span>
                    </>
                  ) : (
                    <span className="text-ink-muted">None scheduled</span>
                  )
                ) : (
                  '…'
                )}
              </dd>
              {canSeeTime && (
                <>
                  <dt className="text-ink-muted">Waiting approval</dt>
                  <dd className="tabular-nums text-ink">{ov ? plural(ov.work.awaitingReview, 'clock-in') : '…'}</dd>
                </>
              )}
              <dt className="text-ink-muted">No-shows (30 days)</dt>
              <dd className={cn('tabular-nums', ov && ov.work.noShows30d > 0 ? 'text-alert' : 'text-ink')}>{ov ? ov.work.noShows30d : '…'}</dd>
            </dl>
          </CardContent>
        </Card>

        {hasPay && (
          <Card>
            <CardContent className="space-y-3 py-4">
              <SectionTitle
                title="Pay"
                size="sm"
                className="mb-0"
                trailing={
                  <Link to={tabHref('pay')} className="text-xs text-gold hover:text-gold-bright">
                    Open Pay
                  </Link>
                }
              />
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
                {canSeePay && (
                  <>
                    <dt className="text-ink-muted">Rate</dt>
                    <dd className="tabular-nums text-ink">{a.payAmount ? fmtPay(a.payAmount, a.payType ?? null, a.payCurrency ?? null) : <span className="text-ink-muted">No rate on file</span>}</dd>
                  </>
                )}
                {ov?.pay && (
                  <>
                    <dt className="text-ink-muted">Pay schedule</dt>
                    <dd className="text-ink">{ov.pay.scheduleName ?? <span className="text-ink-muted">Not on a pay schedule</span>}</dd>
                  </>
                )}
              </dl>
            </CardContent>
          </Card>
        )}

        {cases && (
          <Card>
            <CardContent className="flex items-baseline justify-between gap-3 py-4">
              <div className="min-w-0">
                <SectionTitle title="Cases" size="sm" className="mb-1" />
                <p className="text-sm text-ink-muted">
                  {cases.isError
                    ? "Couldn't load their cases."
                    : openCases === null
                      ? '…'
                      : openCases === 0
                        ? cases.data!.cases.length === 0
                          ? 'No cases on record.'
                          : `None open · ${plural(cases.data!.cases.length, 'case')} on record`
                        : `${openCases} open · ${plural(cases.data!.cases.length, 'case')} on record`}
                </p>
              </div>
              <Link to={tabHref('cases')} className="shrink-0 text-xs text-gold hover:text-gold-bright">
                Open Cases
              </Link>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------- time */

/** The first day of the window, as a local date — stable within a day, so the key is too. */
function windowStartYmd(): string {
  const d = new Date();
  d.setDate(d.getDate() - TIME_WINDOW_DAYS);
  return ymdLocal(d);
}

function usePersonTime(associateId: string, enabled: boolean) {
  const from = useMemo(windowStartYmd, []);
  return useQuery({
    queryKey: ['person-record', 'time', associateId, from],
    queryFn: () => listAdminTimeEntries({ associateId, from: ymdToIsoStart(from) }),
    enabled,
  });
}

const TIME_STATUS_LABELS = { COMPLETED: 'Awaiting review' } as const;

function entryMinutes(e: TimeEntry): number | null {
  if (!e.clockOutAt) return null;
  return e.netMinutes ?? e.minutesElapsed;
}

function TimeTab({ associateId, query }: { associateId: string; query: ReturnType<typeof usePersonTime> }) {
  const term = useTerm();
  if (query.isError) return <QueryError what="their time entries" query={query} />;
  if (query.isPending) return <SkeletonRows count={5} rowHeight="h-10" />;
  const entries = query.data.entries;
  const totalMinutes = entries.reduce((n, e) => n + (entryMinutes(e) ?? 0), 0);
  const awaiting = entries.filter((e) => e.status === 'COMPLETED').length;
  const historyLink = (
    <Button asChild variant="outline" size="sm">
      <Link to={`/time-attendance/timesheets/history/${associateId}`}>
        <Clock className="h-3.5 w-3.5" />
        Full {term('label.timesheet').toLowerCase()} history
      </Link>
    </Button>
  );
  if (entries.length === 0) {
    return (
      <div className="space-y-4">
      <PunchPhotoCard associateId={associateId} />
      <EmptyState
        icon={Clock}
        title={`No hours in the last ${TIME_WINDOW_DAYS} days`}
        description={`Punches from the kiosk and the clock widget land here as they happen; the full ${term('label.timesheet').toLowerCase()} history goes back further.`}
        action={historyLink}
      />
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <PunchPhotoCard associateId={associateId} />
      <div className="grid gap-[var(--d-stack)] sm:grid-cols-3">
        <MetricCard label={`Hours · ${TIME_WINDOW_DAYS} days`} value={fmtHours(totalMinutes / 60)} hint="Net of breaks" />
        <MetricCard label="Entries" value={String(entries.length)} hint={query.data.truncated ? 'The list was cut at the server cap' : `Since ${fmtDate(parseYmd(windowStartYmd()) ?? windowStartYmd())}`} />
        <MetricCard label="Awaiting review" value={String(awaiting)} accent={awaiting > 0} hint={awaiting > 0 ? 'Clocked out, not yet approved' : 'Everything reviewed'} />
      </div>
      <Card className="p-3">
        <DataGrid<TimeEntry>
          id="person-record-time"
          caption={`${term('label.timesheet')} · last ${TIME_WINDOW_DAYS} days`}
          rows={entries}
          rowKey={(e) => e.id}
          search={false}
          urlState={false}
          exportCsv={false}
          columnChooser={false}
          defaultSort={{ key: 'date', direction: 'desc' }}
          columns={[
            {
              key: 'date',
              header: 'Date',
              accessor: (e) => e.clockInAt,
              csv: (e) => punchDay(e),
              sortable: true,
              primary: true,
              className: 'tabular-nums whitespace-nowrap',
              cell: (e) => punchDay(e),
            },
            // Punches on the site's clock (one punch, one time).
            { key: 'in', header: 'In', accessor: (e) => fmtPunchTime(e.clockInAt, e.locationTimezone), searchable: false, className: 'tabular-nums text-ink-muted' },
            { key: 'out', header: 'Out', accessor: (e) => (e.clockOutAt ? fmtPunchTime(e.clockOutAt, e.locationTimezone) : '—'), searchable: false, className: 'tabular-nums text-ink-muted' },
            {
              key: 'hours',
              header: 'Hours',
              accessor: (e) => entryMinutes(e),
              csv: (e) => fmtMinutes(entryMinutes(e)),
              sortable: true,
              searchable: false,
              cardMeta: true,
              className: 'tabular-nums',
              cell: (e) => (e.clockOutAt ? fmtMinutes(entryMinutes(e)) : 'Still clocked in'),
            },
            {
              key: 'status',
              header: 'Status',
              accessor: (e) => statusLabel(e.status, { overrides: TIME_STATUS_LABELS }),
              sortable: true,
              cardMeta: true,
              width: '9rem',
              cell: (e) => (
                <Badge variant={statusTone(e.status, { overrides: TIME_ENTRY_STATUS_TONES })} caps={false}>
                  {statusLabel(e.status, { overrides: TIME_STATUS_LABELS })}
                </Badge>
              ),
            },
          ]}
        />
      </Card>
      <div className="flex justify-end">{historyLink}</div>
    </div>
  );
}

/* ---------------------------------------------------------------- time off */

const TIME_OFF_CATEGORY_LABELS: Record<TimeOffEntitlement['category'], string> = {
  SICK: 'Sick',
  VACATION: 'Vacation',
  PTO: 'PTO',
  BEREAVEMENT: 'Bereavement',
  JURY_DUTY: 'Jury duty',
  OTHER: 'Other',
};

/**
 * This person's requests, from the desk list filtered server-side.
 */
function usePersonTimeOffRequests(associateId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['person-record', 'time-off-requests', associateId],
    queryFn: async () => {
      const r = await listAdminRequests(undefined, { associateId });
      return { requests: r.requests, truncated: r.total !== undefined && r.total > r.requests.length };
    },
    enabled,
  });
}

function TimeOffTab({ associateId, requests }: { associateId: string; requests: ReturnType<typeof usePersonTimeOffRequests> }) {
  const entitlements = useQuery({
    queryKey: ['person-record', 'entitlements', associateId],
    queryFn: () => listAdminEntitlements(associateId),
  });
  const openLink = (
    <Button asChild variant="outline" size="sm">
      <Link to="/time-off">
        <Palmtree className="h-3.5 w-3.5" />
        Open Time off
      </Link>
    </Button>
  );
  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <SectionTitle title="Entitlements" description="The annual allowance per category, and the carryover cap." />
        {entitlements.isError ? (
          <QueryError what="their time-off entitlements" query={entitlements} />
        ) : entitlements.isPending ? (
          <SkeletonRows count={2} rowHeight="h-16" />
        ) : entitlements.data.entitlements.length === 0 ? (
          <EmptyState
            icon={Palmtree}
            title="No time-off policy applies to them"
            description="Set an entitlement on the Time off page and the balance starts accruing from the policy anchor date."
            action={openLink}
          />
        ) : (
          <div className="grid gap-[var(--d-stack)] sm:grid-cols-2 xl:grid-cols-3">
            {entitlements.data.entitlements.map((e) => (
              <MetricCard
                key={e.id}
                label={TIME_OFF_CATEGORY_LABELS[e.category] ?? e.category}
                value={`${fmtHours(e.annualMinutes / 60)} a year`}
                hint={`Carryover up to ${fmtHours(e.carryoverMaxMinutes / 60)}${e.lastGrantedAt ? ` · granted ${fmtDate(e.lastGrantedAt)}` : ' · not granted yet'}`}
              />
            ))}
          </div>
        )}
      </div>
      <div className="space-y-3">
        <SectionTitle title="Requests" description="Their leave requests and how each was decided." />
        {requests.isError ? (
          <QueryError what="their time-off requests" query={requests} />
        ) : requests.isPending ? (
          <SkeletonRows count={3} rowHeight="h-10" />
        ) : requests.data.requests.length === 0 ? (
          <EmptyState
            icon={Palmtree}
            title="They have not requested time off"
            description="A request they make from their phone or the kiosk shows up here with its decision."
            action={openLink}
          />
        ) : (
          <>
            <Card className="p-3">
              <DataGrid<TimeOffRequest>
                id="person-record-time-off"
                caption="Time-off requests"
                rows={requests.data.requests}
                rowKey={(r) => r.id}
                search={false}
                urlState={false}
                exportCsv={false}
                columnChooser={false}
                columns={[
                  {
                    key: 'dates',
                    header: 'Dates',
                    accessor: (r) => r.startDate,
                    csv: (r) => `${r.startDate} – ${r.endDate}`,
                    sortable: true,
                    primary: true,
                    className: 'tabular-nums whitespace-nowrap',
                    cell: (r) =>
                      r.startDate === r.endDate
                        ? fmtDate(parseYmd(r.startDate) ?? r.startDate)
                        : `${fmtDate(parseYmd(r.startDate) ?? r.startDate)} – ${fmtDate(parseYmd(r.endDate) ?? r.endDate)}`,
                  },
                  { key: 'category', header: 'Category', accessor: (r) => TIME_OFF_CATEGORY_LABELS[r.category] ?? r.category, sortable: true, cardMeta: true },
                  { key: 'requested', header: 'Requested', accessor: (r) => r.requestedMinutes, csv: (r) => fmtHours(r.requestedMinutes / 60), sortable: true, searchable: false, className: 'tabular-nums', cell: (r) => fmtHours(r.requestedMinutes / 60) },
                  {
                    key: 'status',
                    header: 'Status',
                    accessor: (r) => statusLabel(r.status),
                    sortable: true,
                    cardMeta: true,
                    width: '8rem',
                    cell: (r) => <StatusBadge status={r.status} caps={false} />,
                  },
                  {
                    key: 'decision',
                    header: 'Decision',
                    accessor: (r) => r.reviewerEmail,
                    className: 'text-ink-muted text-xs',
                    cell: (r) => (r.decidedAt ? `${fmtDate(r.decidedAt)}${r.reviewerEmail ? ` · ${r.reviewerEmail}` : ''}` : r.cancelledAt ? `Cancelled ${fmtDate(r.cancelledAt)}` : '—'),
                  },
                ]}
              />
            </Card>
            {requests.data.truncated && <p className="text-xs text-ink-muted">Showing the most recent 200 — the Time off page has the rest.</p>}
            <div className="flex justify-end">{openLink}</div>
          </>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- performance */

const TIMELINE_KIND_LABEL: Record<PerfTimelineEntry['kind'], string> = {
  GOAL: 'Goal',
  PIP: 'Improvement plan',
  REVIEW: 'Review',
};

const LADDER_ORDER: DisciplineKind[] = ['VERBAL_WARNING', 'WRITTEN_WARNING', 'FINAL_WARNING', 'SUSPENSION', 'TERMINATION'];

/** Where they stand on a career ladder and what the next rung asks of them. */
function CareerSection({ associateId }: { associateId: string }) {
  const position = useQuery({ queryKey: ['person-record', 'career', associateId], queryFn: () => getCareerPosition(associateId) });
  return (
    <div className="space-y-3">
      <SectionTitle title="Career" description="Their rung on a career ladder, and how close they are to the next one." />
      {position.isError ? (
        <QueryError what="their career position" query={position} />
      ) : position.isPending ? (
        <Skeleton className="h-24" />
      ) : (
        <CareerLadderView position={position.data} self={false} />
      )}
    </div>
  );
}

function PerformanceTab({ associateId, showLadder }: { associateId: string; showLadder: boolean }) {
  const timeline = useQuery({ queryKey: ['person-record', 'perf-timeline', associateId], queryFn: () => getPerfTimeline(associateId) });
  const goals = useQuery({ queryKey: ['person-record', 'goals', associateId], queryFn: () => listGoals(associateId) });
  const oneOnOnes = useQuery({ queryKey: ['person-record', 'one-on-ones', associateId], queryFn: () => listOneOnOnes(associateId) });
  const pips = useQuery({ queryKey: ['person-record', 'pips', associateId], queryFn: () => listPips(associateId) });
  const ladder = useQuery({ queryKey: ['person-record', 'ladder', associateId], queryFn: () => getLadder(associateId), enabled: showLadder });

  const count = (q: { isPending: boolean; isError: boolean }, n: number | undefined) => (q.isPending ? '…' : q.isError || n === undefined ? '—' : String(n));
  const activeGoals = goals.data?.goals.filter((g) => g.status === 'ACTIVE' || g.status === 'AT_RISK').length ?? 0;
  const activePips = pips.data?.pips.filter((p) => p.status === 'ACTIVE').length ?? 0;
  const ladderTotal = ladder.data ? LADDER_ORDER.reduce((n, k) => n + (ladder.data.ladder[k] ?? 0), 0) : 0;

  return (
    <div className="space-y-6">
      <div className="grid gap-[var(--d-stack)] sm:grid-cols-3">
        <MetricCard label="Goals" value={count(goals, goals.data?.goals.length)} hint={goals.data ? `${activeGoals} in progress` : undefined} />
        <MetricCard label="1:1s" value={count(oneOnOnes, oneOnOnes.data?.meetings.length)} hint={oneOnOnes.data ? `${oneOnOnes.data.meetings.filter((m) => m.status === 'SCHEDULED').length} scheduled` : undefined} />
        <MetricCard label="Improvement plans" value={count(pips, pips.data?.pips.length)} accent={activePips > 0} hint={pips.data ? (activePips > 0 ? `${activePips} active` : 'None active') : undefined} />
      </div>

      {showLadder && (
        <div className="space-y-3">
          <SectionTitle title="Warning ladder" description="Formal warnings on record, lowest rung first. Rescinded warnings are not counted." />
          {ladder.isError ? (
            <QueryError what="their warning ladder" query={ladder} />
          ) : ladder.isPending ? (
            <Skeleton className="h-16" />
          ) : ladderTotal === 0 ? (
            <p className="text-sm text-ink-muted">A clean record — no formal warnings have been issued.</p>
          ) : (
            <div className="grid gap-[var(--d-stack)] sm:grid-cols-5">
              {LADDER_ORDER.map((k) => (
                <MetricCard key={k} label={KIND_LABELS[k]} value={String(ladder.data.ladder[k] ?? 0)} accent={(ladder.data.ladder[k] ?? 0) > 0} />
              ))}
            </div>
          )}
        </div>
      )}

      <CareerSection associateId={associateId} />

      <div className="space-y-3">
        <SectionTitle title="Timeline" description="Goals, improvement plans and reviews in the order they happened." />
        {timeline.isError ? (
          <QueryError what="their performance timeline" query={timeline} />
        ) : timeline.isPending ? (
          <SkeletonRows count={4} rowHeight="h-12" />
        ) : timeline.data.entries.length === 0 ? (
          <EmptyState
            icon={Gauge}
            title="Their performance record is empty so far"
            description="Goals, 1:1s, improvement plans and reviews appear here as managers create them on the Performance page."
            action={
              <Button asChild variant="outline" size="sm">
                <Link to="/performance">Open Performance</Link>
              </Button>
            }
          />
        ) : (
          <ol className="space-y-2">
            {timeline.data.entries.map((e) => (
              <li key={`${e.kind}-${e.id}`}>
                <Card>
                  <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <Badge variant={e.kind === 'PIP' ? 'pending' : e.kind === 'REVIEW' ? 'info' : 'default'} caps={false} withDot={false}>
                        {TIMELINE_KIND_LABEL[e.kind]}
                      </Badge>
                      <Link to={e.link} className={e.parentId ? 'ml-4 truncate text-sm text-ink hover:text-gold-bright' : 'truncate text-sm text-ink hover:text-gold-bright'}>
                        {e.title}
                      </Link>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-ink-muted tabular-nums">
                      <StatusBadge status={e.status} caps={false} size="sm" />
                      <span>{fmtDate(parseYmd(e.date) ?? e.date)}</span>
                    </div>
                  </CardContent>
                </Card>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- cases */

function usePersonCases(associateId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['person-record', 'cases', associateId],
    queryFn: () => listCaseQueue({ associateId }),
    enabled,
  });
}

const CASE_PRIORITY_TONE = { LOW: 'default', MEDIUM: 'info', HIGH: 'pending', URGENT: 'destructive' } as const;

function CasesTab({
  query,
  workerWord,
  person,
  canOpen,
}: {
  query: ReturnType<typeof usePersonCases>;
  workerWord: string;
  person: { id: string; name: string };
  /** HR can open a case for them — a call or a walk-in (HR walk 13). */
  canOpen: boolean;
}) {
  const caseStatusLabels = useMemo(() => ({ WAITING_ASSOCIATE: `Waiting on ${workerWord}` }), [workerWord]);
  const [opening, setOpening] = useState(false);
  const drawer = opening ? (
    <OnBehalfCaseDrawer
      initialAssociate={person}
      onClose={() => setOpening(false)}
      onSaved={() => {
        setOpening(false);
        void query.refetch();
      }}
    />
  ) : null;
  const newCase = canOpen ? (
    <Button variant="outline" size="sm" onClick={() => setOpening(true)}>
      New case
    </Button>
  ) : null;
  if (query.isError) return <QueryError what="their cases" query={query} />;
  if (query.isPending) return <SkeletonRows count={3} rowHeight="h-10" />;
  const rows = query.data.cases;
  const open = rows.filter((c) => c.status !== 'RESOLVED' && c.status !== 'CLOSED').length;
  if (rows.length === 0) {
    return (
      <>
        <EmptyState
          icon={Ticket}
          title="No cases yet"
          description={`A case this ${workerWord} files — or one HR opens after a call or a visit — shows up here with who is working it.`}
          action={
            newCase ?? (
              <Button asChild variant="outline" size="sm">
                <Link to="/hr-cases">Open the case desk</Link>
              </Button>
            )
          }
        />
        {drawer}
      </>
    );
  }
  return (
    <div className="space-y-4">
      {newCase && <div className="flex justify-end">{newCase}</div>}
      {drawer}
      <div className="grid grid-cols-2 gap-[var(--d-stack)]">
        <MetricCard label="Open cases" value={String(open)} accent={open > 0} hint={open > 0 ? 'Still being worked' : 'Everything resolved'} />
        <MetricCard label="All cases" value={String(rows.length)} hint="Filed by them or opened by HR" />
      </div>
      <Card className="p-3">
        <DataGrid<QueueCaseRow>
          id="person-record-cases"
          caption="Cases"
          rows={rows}
          rowKey={(c) => c.id}
          search={false}
          urlState={false}
          exportCsv={false}
          columnChooser={false}
          columns={[
            {
              key: 'subject',
              header: 'Subject',
              accessor: (c) => c.subject,
              sortable: true,
              primary: true,
              cell: (c) => (
                <Link to={`/hr-cases?case=${c.id}`} className="font-medium text-ink hover:text-gold-bright">
                  {c.subject}
                </Link>
              ),
            },
            { key: 'category', header: 'Category', accessor: (c) => CASE_CATEGORY_LABELS[c.category] ?? c.category, sortable: true, cardMeta: true, className: 'text-ink-muted' },
            {
              key: 'priority',
              header: 'Priority',
              accessor: (c) => c.priority,
              sortable: true,
              width: '7rem',
              cell: (c) => (
                <Badge variant={CASE_PRIORITY_TONE[c.priority]} caps={false} withDot={false}>
                  {statusLabel(c.priority)}
                </Badge>
              ),
            },
            {
              key: 'status',
              header: 'Status',
              accessor: (c) => statusLabel(c.status, { overrides: caseStatusLabels }),
              sortable: true,
              cardMeta: true,
              width: '10rem',
              cell: (c) => <StatusBadge status={c.status} label={statusLabel(c.status, { overrides: caseStatusLabels })} caps={false} />,
            },
            { key: 'assigned', header: 'Working it', accessor: (c) => c.assignedToEmail ?? 'Unassigned', className: 'text-ink-muted text-xs' },
            { key: 'opened', header: 'Opened', accessor: (c) => c.createdAt, csv: (c) => fmtDate(c.createdAt), sortable: true, searchable: false, width: '7rem', className: 'tabular-nums text-xs text-ink-muted', cell: (c) => fmtDate(c.createdAt) },
          ]}
        />
      </Card>
    </div>
  );
}


/** One SMS to the phone on file, sent through the communications desk so it
 *  lands in the log like every other message to this person. */
function TextDialog({ phone, name, onClose }: { phone: string; name: string; onClose: () => void }) {
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const send = async () => {
    if (!body.trim()) return;
    setSending(true);
    try {
      await sendNotification({ channel: 'SMS', recipientPhone: phone, body: body.trim(), category: 'person-record' });
      toast.success(`Text sent to ${name}.`);
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : `Couldn't send the text to ${name}.`);
    } finally {
      setSending(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} confirmDiscard={() => body.trim().length > 0}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Text {name}</DialogTitle>
          <DialogDescription>Goes to {phone} as an SMS, and is kept in the communications log.</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="person-text-body">Message</Label>
          <Textarea id="person-text-body" value={body} onChange={(e) => setBody(e.target.value)} rows={4} maxLength={1000} autoFocus />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={sending}>Cancel</Button>
          <Button onClick={() => void send()} disabled={sending || !body.trim()}>{sending ? 'Sending…' : 'Send text'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
