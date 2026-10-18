import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, Clock, Eye, Gauge, MessageSquare, Palmtree, Smartphone, Ticket } from 'lucide-react';
import type { DirectoryEntry, TimeEntry, TimeOffEntitlement, TimeOffRequest } from '@alto-people/shared';
import { RecordTemplate } from '@/components/templates';
import { WorkThreadPanel } from '@/components/WorkThreadPanel';
import { Avatar, Badge, Button, Card, CardContent, EmptyState, Label, MetricCard, SectionTitle, Skeleton, SkeletonRows } from '@/components/ui';
import { StateCertificateCard } from '@/components/payroll/StateCertificateCard';
import { TaxWithholdingCard } from '@/components/payroll/TaxWithholdingCard';
import { RothCatchUpCard } from '@/components/payroll/RothCatchUpCard';
import { getCareerPosition } from '@/lib/career126Api';
import { CareerLadderView } from '@/pages/career/CareerPosition';
import { DataGrid } from '@/components/ui/DataGrid';
import { QueryError } from '@/components/ui/QueryError';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Textarea } from '@/components/ui/Input';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { sendNotification } from '@/lib/communicationsApi';
import { useAuth, useTenant, useTerm } from '@/lib/auth';
import { useAssistantRecord } from '@/lib/assistantContext';
import { getDirectoryEntry } from '@/lib/directoryApi';
import { EMPLOYMENT_LABEL } from '@/lib/employmentLabels';
import { fmtDate, fmtHours, fmtMinutes, fmtTime, parseYmd, ymdLocal, ymdToIsoStart } from '@/lib/format';
import { getAssociateKioskPin } from '@/lib/kiosk99Api';
import { listAdminTimeEntries } from '@/lib/timeApi';
import { TIME_ENTRY_STATUS_TONES } from '@/lib/timeLabels';
import { listAdminEntitlements, listAdminRequests } from '@/lib/timeOffApi';
import { getPerfTimeline, listGoals, listOneOnOnes, listPips, type PerfTimelineEntry } from '@/lib/perf84Api';
import { getLadder, KIND_LABELS, type DisciplineKind } from '@/lib/discipline118Api';
import { CATEGORY_LABELS as CASE_CATEGORY_LABELS, listCaseQueue, type QueueCaseRow } from '@/lib/hrCases123Api';
import { StatusBadge, statusLabel, statusTone } from '@/lib/status';
import { CompensationTab, DocumentsTab, EmploymentTab, PaymentsTab, ProfileTab } from './PeopleDirectory';
import { PromoteDialog } from './PromoteDialog';
import { ProtectedLeaveFlag } from '../leave/ProtectedLeaveFlag';

/**
 * One person's record (UX upgrade, 2026-10-16 — Rippling's one-record
 * model). The directory drawer is the quick look; this page is the whole
 * person on one URL: who they are, where they work, their hours, their
 * leave, their performance and their cases — each a facet of the same
 * Record template an agent or a robot gets. `?tab=` is the open facet, so
 * a notification can land on Time off or Cases.
 *
 * The drawer's sections are reused, not copied: Profile, Employment,
 * Compensation, Payments and Documents come from PeopleDirectory.tsx. The
 * four new facets (Time, Time off, Performance, Cases) read the modules'
 * existing per-person endpoints and hide themselves from roles the API
 * would turn away.
 */
type TabKey = 'profile' | 'employment' | 'pay' | 'time' | 'timeoff' | 'performance' | 'cases' | 'documents' | 'thread';

const TIME_WINDOW_DAYS = 30;

export function PersonRecord() {
  const { associateId = '' } = useParams();
  const term = useTerm();
  const { can, user } = useAuth();
  const [textOpen, setTextOpen] = useState(false);
  const [promoteOpen, setPromoteOpen] = useState(false);
  const { moduleOn } = useTenant();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

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

  const time = usePersonTime(associateId, canSeeTime && Boolean(a));
  const timeOffRequests = usePersonTimeOffRequests(associateId, canSeeTimeOff && Boolean(a));
  const cases = usePersonCases(associateId, canSeeCases && Boolean(a));

  const visibleTabs = useMemo(() => {
    const keys: TabKey[] = ['profile', 'employment'];
    if (canSeeComp || canSeePayments) keys.push('pay');
    if (canSeeTime) keys.push('time');
    if (canSeeTimeOff) keys.push('timeoff');
    if (canSeePerformance) keys.push('performance');
    if (canSeeCases) keys.push('cases');
    keys.push('documents', 'thread');
    return keys;
  }, [canSeeComp, canSeePayments, canSeeTime, canSeeTimeOff, canSeePerformance, canSeeCases]);

  const tabParam = searchParams.get('tab');
  const activeTab: TabKey = (visibleTabs as readonly string[]).includes(tabParam ?? '') ? (tabParam as TabKey) : 'profile';
  const setTab = (key: string) => {
    const next = new URLSearchParams(searchParams);
    if (key === 'profile') next.delete('tab');
    else next.set('tab', key);
    setSearchParams(next, { replace: true });
  };

  // The drawer's sections patch the person as they save; here that patch
  // lands on the cached record, and the directory's lists refetch so a
  // row there agrees with the page.
  const onAssociateChange = (patch: Partial<DirectoryEntry>) => {
    qc.setQueryData<DirectoryEntry>(['directory', 'entry', associateId], (old) => (old ? { ...old, ...patch } : old));
    void qc.invalidateQueries({
      queryKey: ['directory'],
      predicate: (q) => q.queryKey[1] !== 'entry',
    });
  };

  if (detail.isError) {
    return (
      <div className="space-y-4">
        <QueryError what="this person" query={detail} />
        <Button asChild variant="ghost" size="sm">
          <Link to="/people">Back to {term('nav.people')}</Link>
        </Button>
      </div>
    );
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
  const subtitle = [
    a.position,
    hasClients ? a.workplaceClientName : null,
    a.currentLocationName,
    EMPLOYMENT_LABEL[a.employmentType] ?? a.employmentType,
  ]
    .filter(Boolean)
    .join(' · ');
  // The "why" beside the status, the same facts the drawer explains.
  const statusWhy =
    a.status === 'PENDING' && a.onboardingPercent !== null
      ? `Onboarding ${a.onboardingPercent}% complete`
      : a.deactivatedAt
        ? `Deactivated ${fmtDate(a.deactivatedAt)}${a.deactivationReason ? ` — ${a.deactivationReason}` : ''}`
        : a.separatedAt
          ? `Separated ${fmtDate(a.separatedAt)}`
          : null;

  const tabs = [
    {
      key: 'profile',
      label: 'Profile',
      content: <ProfileTab associate={a} onAssociateChange={onAssociateChange} onClose={() => navigate('/people')} />,
    },
    { key: 'employment', label: 'Employment', content: <EmploymentTab associateId={a.id} /> },
    {
      key: 'pay',
      label: 'Pay',
      content: (
        <div className="space-y-8">
          {canSeeComp && <CompensationTab associate={a} />}
          {canSeePayments && (
            <div className="space-y-3">
              <SectionTitle title="Payments" />
              <PaymentsTab associateId={a.id} />
            </div>
          )}
          {can('process:payroll') && <StateCertificateCard mode="hr" associateId={a.id} />}
          {can('process:payroll') && <TaxWithholdingCard associateId={a.id} />}
          {can('process:payroll') && <RothCatchUpCard associateId={a.id} />}
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
    { key: 'cases', label: 'Cases', count: cases.data?.cases.length, content: <CasesTab query={cases} workerWord={workerWord} /> },
    { key: 'documents', label: 'Documents', content: <DocumentsTab associateId={a.id} /> },
    { key: 'thread', label: 'Thread', content: <WorkThreadPanel associateId={a.id} /> },
  ].filter((t) => (visibleTabs as readonly string[]).includes(t.key));

  return (
    <RecordTemplate
      breadcrumbs={[{ label: term('nav.people'), to: '/people' }, { label: name }]}
      identity={<Avatar size="xl" src={a.photoUrl} name={name} email={a.email} />}
      title={name}
      subtitle={subtitle || `No position on record for this ${workerWord}`}
      status={
        <span className="inline-flex flex-wrap items-center gap-2">
          <StatusBadge status={a.status} size="lg" />
          {a.j1Status && <Badge variant="default">J-1</Badge>}
          <ProtectedLeaveFlag associateId={associateId} />
          {statusWhy && <span className="text-xs text-ink-muted">{statusWhy}</span>}
        </span>
      }
      actions={
        <>
          {/* Message: a thread with their login, when the messenger serves it
              (staff). Text: an SMS to the phone on file, for everyone else
              who has one — the way the floor actually reaches a person. */}
          {a.messageUserId && user?.role !== 'ASSOCIATE' && (
            <Button asChild variant="outline" size="sm">
              <Link to={`/messages?to=${a.messageUserId}`}>
                <MessageSquare className="h-3.5 w-3.5" />
                Message
              </Link>
            </Button>
          )}
          {!a.messageUserId && a.phone && can('manage:communications') && (
            <Button variant="outline" size="sm" onClick={() => setTextOpen(true)}>
              <Smartphone className="h-3.5 w-3.5" />
              Text
            </Button>
          )}
          {textOpen && <TextDialog phone={a.phone!} name={name} onClose={() => setTextOpen(false)} />}
          <Button asChild variant="outline" size="sm">
            <Link to={`/people?associateId=${a.id}`}>
              <Eye className="h-3.5 w-3.5" />
              Quick view
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link to={`/scheduling?associate=${a.id}`}>
              <CalendarDays className="h-3.5 w-3.5" />
              Schedule
            </Link>
          </Button>
          {canSeeTime && (
            <Button asChild variant="outline" size="sm">
              <Link to={`/time-attendance?associate=${a.id}&name=${encodeURIComponent(name)}`}>
                <Clock className="h-3.5 w-3.5" />
                {term('label.timesheet')}
              </Link>
            </Button>
          )}
          <Button asChild variant="outline" size="sm">
            <Link to={`/org?tab=people&associateId=${a.id}`}>Edit org assignment</Link>
          </Button>
          {can('manage:comp') && (
            <Button variant="outline" size="sm" onClick={() => setPromoteOpen(true)}>
              Promote
            </Button>
          )}
          {promoteOpen && (
            <PromoteDialog
              associate={{ id: a.id, firstName: a.firstName, lastName: a.lastName }}
              currentAmount={a.payAmount ? Number(a.payAmount) : null}
              currentPayType={a.payType === 'SALARY' ? 'SALARY' : a.payType === 'HOURLY' ? 'HOURLY' : null}
              open={promoteOpen}
              onOpenChange={setPromoteOpen}
            />
          )}
        </>
      }
      summary={
        <div className="grid grid-cols-2 gap-[var(--d-stack)] xl:grid-cols-5">
          <MetricCard label="Start date" value={a.startDate ? fmtDate(parseYmd(a.startDate) ?? a.startDate) : '—'} hint={`On record since ${fmtDate(a.createdAt)}`} />
          <MetricCard
            label={term('manager')}
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
                '—'
              )
            }
            hint={a.departmentName ?? 'No department assigned'}
          />
          <MetricCard label="Employment type" value={EMPLOYMENT_LABEL[a.employmentType] ?? a.employmentType} hint={a.jobProfileTitle ?? 'No job profile'} />
          <MetricCard
            label={term('site')}
            value={a.currentLocationName ?? '—'}
            hint={a.currentAssignmentStartedAt ? `Since ${fmtDate(parseYmd(a.currentAssignmentStartedAt) ?? a.currentAssignmentStartedAt)}` : 'Not placed'}
          />
          {canSeeTime && <ClockInNumberCard associate={a} />}
        </div>
      }
      activeTab={activeTab}
      onTabChange={setTab}
      tabs={tabs}
    />
  );
}

/* ----------------------------------------------------------------- summary */

/** Can they clock in? The same query the Profile tab's kiosk section runs. */
function ClockInNumberCard({ associate: a }: { associate: DirectoryEntry }) {
  const pin = useQuery({ queryKey: ['kiosk-pin', a.id], queryFn: () => getAssociateKioskPin(a.id) });
  const value = pin.isPending ? '…' : pin.isError ? '—' : !pin.data ? 'None issued' : pin.data.wontClockIn ? 'Needs re-issue' : pin.data.active ? 'Issued' : 'Inactive';
  const hint = pin.data?.employeeNumber ? `Number ${pin.data.employeeNumber}` : pin.data ? 'Number on file' : 'Kiosk clock-in';
  return <MetricCard label="Clock-in number" value={value} hint={hint} accent={Boolean(pin.data?.wontClockIn)} />;
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
      <EmptyState
        icon={Clock}
        title={`No hours in the last ${TIME_WINDOW_DAYS} days`}
        description={`Punches from the kiosk and the clock widget land here as they happen; the full ${term('label.timesheet').toLowerCase()} history goes back further.`}
        action={historyLink}
      />
    );
  }
  return (
    <div className="space-y-4">
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
              csv: (e) => fmtDate(e.clockInAt),
              sortable: true,
              primary: true,
              className: 'tabular-nums whitespace-nowrap',
              cell: (e) => fmtDate(e.clockInAt),
            },
            { key: 'in', header: 'In', accessor: (e) => fmtTime(e.clockInAt), searchable: false, className: 'tabular-nums text-ink-muted' },
            { key: 'out', header: 'Out', accessor: (e) => (e.clockOutAt ? fmtTime(e.clockOutAt) : '—'), searchable: false, className: 'tabular-nums text-ink-muted' },
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

function CasesTab({ query, workerWord }: { query: ReturnType<typeof usePersonCases>; workerWord: string }) {
  const caseStatusLabels = useMemo(() => ({ WAITING_ASSOCIATE: `Waiting on ${workerWord}` }), [workerWord]);
  if (query.isError) return <QueryError what="their cases" query={query} />;
  if (query.isPending) return <SkeletonRows count={3} rowHeight="h-10" />;
  const rows = query.data.cases;
  const open = rows.filter((c) => c.status !== 'RESOLVED' && c.status !== 'CLOSED').length;
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={Ticket}
        title="They have not filed a case"
        description={`A case this ${workerWord} files — a pay question, a benefits change, a workplace concern — shows up here with who is working it.`}
        action={
          <Button asChild variant="outline" size="sm">
            <Link to="/hr-cases">Open the case desk</Link>
          </Button>
        }
      />
    );
  }
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-[var(--d-stack)]">
        <MetricCard label="Open cases" value={String(open)} accent={open > 0} hint={open > 0 ? 'Still being worked' : 'Everything resolved'} />
        <MetricCard label="All cases" value={String(rows.length)} hint="Filed from their account" />
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
