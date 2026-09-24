import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { getMyDelegations } from '@/lib/delegationsApi';
import { useAuth } from '@/lib/auth';
import { AlertTriangle, CalendarOff, Clock, Download, Inbox, Receipt, Target, Users } from 'lucide-react';
import { ApiError } from '@/lib/api';
import {
  approveTeamTimeOff,
  approveTeamTimesheet,
  bulkApproveTeamTimeOff,
  bulkApproveTeamTimesheets,
  denyTeamTimeOff,
  getTeamDashboard,
  getTeamInbox,
  listReports,
  listTeamTimeOff,
  listTeamTimesheets,
  rejectTeamTimesheet,
  type DirectReport,
  type InboxItem,
  type TeamTimeEntry,
} from '@/lib/teamApi';
import { fmtDate, fmtDateTime, fmtMoney, parseYmd, ymdLocal } from '@/lib/format';
import { downloadCsv } from '@/lib/csv';
import { statusTone } from '@/lib/status';
import { TIME_ENTRY_STATUS_TONES } from '@/lib/timeLabels';
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  ErrorBanner,
  PageHeader,
  SearchInput,
  SegmentedControl,
  SkeletonRows,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui';
import { DataGrid } from '@/components/ui/DataGrid';
import { toast } from 'sonner';
import { removeFromLists, useOptimisticMutation } from '@/lib/optimistic';
import { usePrompt } from '@/lib/confirm';

// Query keys are tuples so invalidateQueries({ queryKey: ['team'] }) can
// flush the whole namespace after a mutation. The dashboard and the
// inbox both read from the same DB rows, so any approve/deny that bumps
// a count needs to invalidate both — easier as one wildcard.
const teamKeys = {
  all: ['team'] as const,
  dashboard: () => [...teamKeys.all, 'dashboard'] as const,
  reports: () => [...teamKeys.all, 'reports'] as const,
  inbox: () => [...teamKeys.all, 'inbox'] as const,
  timesheets: (status: string) => [...teamKeys.all, 'timesheets', status] as const,
  timeoff: (status: string) => [...teamKeys.all, 'timeoff', status] as const,
};

export function TeamHome() {
  const [tab, setTab] = useState<'inbox' | 'overview' | 'timesheets' | 'timeoff'>('inbox');

  const dashboardQ = useQuery({
    queryKey: teamKeys.dashboard(),
    queryFn: getTeamDashboard,
  });
  const reportsQ = useQuery({
    queryKey: teamKeys.reports(),
    queryFn: async () => (await listReports()).reports,
  });

  const dashboard = dashboardQ.data;
  const error = dashboardQ.error ?? reportsQ.error;

  return (
    <div className="space-y-5">
      <PageHeader
        title="My team"
        subtitle="Direct reports, pending timesheet reviews, and time-off decisions awaiting your sign-off."
        breadcrumbs={[{ label: 'Workforce' }, { label: 'My team' }]}
      />

      {dashboard && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <KpiTile
            label="Direct reports"
            value={dashboard.directReports.toString()}
            icon={Users}
          />
          <KpiTile
            label="Timesheets"
            value={dashboard.pendingTimesheets.toString()}
            icon={Clock}
            highlight={dashboard.pendingTimesheets > 0}
          />
          <KpiTile
            label="Time-off"
            value={dashboard.pendingTimeOff.toString()}
            icon={CalendarOff}
            highlight={dashboard.pendingTimeOff > 0}
          />
          <KpiTile
            label="Reimbursements"
            value={dashboard.pendingReimbursements.toString()}
            icon={Receipt}
            highlight={dashboard.pendingReimbursements > 0}
          />
          <KpiTile
            label="At-risk goals"
            value={dashboard.atRiskGoals.toString()}
            icon={Target}
            highlight={dashboard.atRiskGoals > 0}
          />
          <KpiTile
            label="Onboarding"
            value={dashboard.onboardingInProgress.toString()}
            icon={Users}
          />
        </div>
      )}

      {error && (
        <ErrorBanner
          action={
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                dashboardQ.refetch();
                reportsQ.refetch();
              }}
            >
              Retry
            </Button>
          }
        >
          {error instanceof ApiError ? error.message : 'Failed to load team.'}
        </ErrorBanner>
      )}

      <DelegationBanner />
      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
        <TabsList>
          <TabsTrigger value="inbox">
            <Inbox className="h-3.5 w-3.5" />
            Inbox
            {dashboard &&
              dashboard.pendingTimesheets +
                dashboard.pendingTimeOff +
                dashboard.pendingReimbursements +
                dashboard.atRiskGoals >
                0 && (
                <Badge variant="destructive" className="ml-1">
                  {dashboard.pendingTimesheets +
                    dashboard.pendingTimeOff +
                    dashboard.pendingReimbursements +
                    dashboard.atRiskGoals}
                </Badge>
              )}
          </TabsTrigger>
          <TabsTrigger value="overview">
            <Users className="h-3.5 w-3.5" />
            Reports
          </TabsTrigger>
          <TabsTrigger value="timesheets">
            <Clock className="h-3.5 w-3.5" />
            Timesheets
            {dashboard && dashboard.pendingTimesheets > 0 && (
              <Badge variant="destructive" className="ml-1">
                {dashboard.pendingTimesheets}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="timeoff">
            <CalendarOff className="h-3.5 w-3.5" />
            Time off
            {dashboard && dashboard.pendingTimeOff > 0 && (
              <Badge variant="destructive" className="ml-1">
                {dashboard.pendingTimeOff}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="inbox">
          <InboxTab />
        </TabsContent>
        <TabsContent value="overview">
          <ReportsList reports={reportsQ.data ?? null} />
        </TabsContent>
        <TabsContent value="timesheets">
          <TimesheetsTab />
        </TabsContent>
        <TabsContent value="timeoff">
          <TimeOffTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function KpiTile({
  label,
  value,
  icon: Icon,
  highlight,
}: {
  label: string;
  value: string;
  icon: typeof Users;
  highlight?: boolean;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <div className="text-xs2 font-medium uppercase tracking-[0.14em] text-silver/70">
            {label}
          </div>
          <Icon className={`h-4 w-4 ${highlight ? 'text-gold' : 'text-silver/70'}`} />
        </div>
        <div
          className={`font-display text-3xl tabular-nums mt-1 ${highlight ? 'text-gold' : 'text-white'}`}
        >
          {value}
        </div>
      </CardContent>
    </Card>
  );
}

const KIND_META: Record<
  InboxItem['kind'],
  { label: string; icon: typeof Users; tone: string }
> = {
  TIMESHEET: { label: 'Timesheet', icon: Clock, tone: 'text-steel' },
  TIME_OFF: { label: 'Time off', icon: CalendarOff, tone: 'text-warning' },
  REIMBURSEMENT: { label: 'Reimbursement', icon: Receipt, tone: 'text-success' },
  GOAL_AT_RISK: { label: 'Goal', icon: AlertTriangle, tone: 'text-alert' },
};

function InboxTab() {
  const prompt = usePrompt();
  const q = useQuery({
    queryKey: teamKeys.inbox(),
    queryFn: getTeamInbox,
  });


  // Same API mutations as the Timesheets/Time off queue tabs, so a
  // decision made from the inbox behaves identically (invalidates the
  // whole team namespace → counts, queues, and this list all refresh).
  // A decision is the manager saying what happens — the server almost
  // never disagrees. So the row leaves the moment they tap, and comes back
  // only if the request actually fails. Clearing a morning's queue used to
  // mean forty round-trips watched one at a time.
  const approveTsM = useOptimisticMutation({
    mutationFn: approveTeamTimesheet,
    keys: [teamKeys.all],
    apply: (id: string, c) => removeFromLists(c, [teamKeys.all], [id]),
    errorMessage: 'Approve failed.',
    onSuccess: () => toast.success('Timesheet approved.'),
  });
  const rejectTsM = useOptimisticMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      rejectTeamTimesheet(id, reason),
    keys: [teamKeys.all],
    apply: ({ id }, c) => removeFromLists(c, [teamKeys.all], [id]),
    errorMessage: 'Reject failed.',
    onSuccess: () => toast.success('Timesheet rejected.'),
  });
  const approvePtoM = useOptimisticMutation({
    mutationFn: (id: string) => approveTeamTimeOff(id),
    keys: [teamKeys.all],
    apply: (id: string, c) => removeFromLists(c, [teamKeys.all], [id]),
    errorMessage: 'Approve failed.',
    onSuccess: () => toast.success('Time off approved.'),
  });
  const denyPtoM = useOptimisticMutation({
    mutationFn: ({ id, note }: { id: string; note: string }) =>
      denyTeamTimeOff(id, note),
    keys: [teamKeys.all],
    apply: ({ id }, c) => removeFromLists(c, [teamKeys.all], [id]),
    errorMessage: 'Deny failed.',
    onSuccess: () => toast.success('Time off denied.'),
  });

  const rejectTs = async (id: string) => {
    const reason = (
      await prompt({
        title: 'Reject timesheet',
        reasonLabel: 'Reason for rejection',
        confirmLabel: 'Reject',
        destructive: true,
      })
    )?.trim();
    if (!reason) return;
    rejectTsM.mutate({ id, reason });
  };
  const denyPto = async (id: string) => {
    const note = (
      await prompt({
        title: 'Deny time-off request',
        reasonLabel: 'Reason for denial',
        confirmLabel: 'Deny',
        destructive: true,
      })
    )?.trim();
    if (!note) return;
    denyPtoM.mutate({ id, note });
  };

  const pendingId =
    approveTsM.isPending && typeof approveTsM.variables === 'string'
      ? approveTsM.variables
      : approvePtoM.isPending && typeof approvePtoM.variables === 'string'
      ? approvePtoM.variables
      : rejectTsM.isPending
      ? rejectTsM.variables?.id ?? null
      : denyPtoM.isPending
      ? denyPtoM.variables?.id ?? null
      : null;

  if (q.error) {
    return (
      <ErrorBanner
        action={
          <Button size="sm" variant="secondary" onClick={() => q.refetch()}>
            Retry
          </Button>
        }
      >
        {q.error instanceof ApiError ? q.error.message : 'Failed to load.'}
      </ErrorBanner>
    );
  }
  if (!q.data) return <SkeletonRows count={4} rowHeight="h-14" />;
  if (q.data.items.length === 0) {
    return (
      <EmptyState
        icon={Inbox}
        title="Inbox zero"
        description="Nothing waiting on you. New approvals, time-off requests, reimbursements, and at-risk goals will land here."
      />
    );
  }

  return (
    <DataGrid<NonNullable<typeof q.data>['items'][number]>
      id="team-inbox"
      caption="Waiting on you"
      rows={q.data.items}
      rowKey={(item) => `${item.kind}-${item.id}`}
      search={{ placeholder: 'Associate, type…' }}
      urlState={false}
      exportCsv={false}
      columns={[
        {
          key: 'type',
          header: 'Type',
          accessor: (item) => KIND_META[item.kind].label,
          sortable: true,
          cardMeta: true,
          cell: (item) => {
            const meta = KIND_META[item.kind];
            const Icon = meta.icon;
            return (
              <div className="flex items-center gap-1.5 text-xs">
                <Icon className={`h-3.5 w-3.5 ${meta.tone}`} />
                <span className="text-silver">{meta.label}</span>
              </div>
            );
          },
        },
        {
          key: 'associate',
          header: 'Associate',
          accessor: (item) => item.associateName,
          sortable: true,
          primary: true,
          className: 'font-medium',
          cell: (item) => (
            <div className="flex items-center gap-2.5">
              <Avatar name={item.associateName} size="sm" />
              <div className="truncate">{item.associateName}</div>
            </div>
          ),
        },
        { key: 'details', header: 'Details', accessor: (item) => item.summary, cardMeta: true, className: 'text-silver' },
        {
          key: 'age',
          header: 'Age',
          accessor: (item) => item.ageDays,
          csv: (item) => (item.ageDays === 0 ? 'today' : `${item.ageDays}d`),
          sortable: true,
          searchable: false,
          className: 'tabular-nums',
          cell: (item) => (
            <span className={item.ageDays >= 3 ? 'text-alert' : 'text-silver'}>{item.ageDays === 0 ? 'today' : `${item.ageDays}d`}</span>
          ),
        },
        {
          key: 'action',
          header: 'Action',
          accessor: () => null,
          searchable: false,
          csv: () => '',
          align: 'right',
          stopRowClick: true,
          cell: (item) => (
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" asChild>
                <Link to={item.link}>Open</Link>
              </Button>
              {item.kind === 'TIMESHEET' && (
                <>
                  <Button size="sm" variant="outline" onClick={() => rejectTs(item.id)} disabled={pendingId === item.id}>
                    Reject
                  </Button>
                  <Button size="sm" onClick={() => approveTsM.mutate(item.id)} loading={pendingId === item.id}>
                    Approve
                  </Button>
                </>
              )}
              {item.kind === 'TIME_OFF' && (
                <>
                  <Button size="sm" variant="outline" onClick={() => denyPto(item.id)} disabled={pendingId === item.id}>
                    Deny
                  </Button>
                  <Button size="sm" onClick={() => approvePtoM.mutate(item.id)} loading={pendingId === item.id}>
                    Approve
                  </Button>
                </>
              )}
            </div>
          ),
        },
      ]}
    />
  );
}

function ReportsList({ reports }: { reports: DirectReport[] | null }) {
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    if (!reports) return null;
    const needle = search.trim().toLowerCase();
    if (!needle) return reports;
    return reports.filter((r) =>
      [
        `${r.firstName} ${r.lastName}`,
        r.email,
        r.jobTitle ?? '',
        r.departmentName ?? '',
      ]
        .join(' ')
        .toLowerCase()
        .includes(needle),
    );
  }, [reports, search]);

  if (!reports || !filtered) return <SkeletonRows count={4} rowHeight="h-14" />;
  if (reports.length === 0) {
    return (
      <EmptyState
        icon={Users}
        title="No direct reports"
        description="Once HR assigns you as someone's manager, they'll show up here."
      />
    );
  }
  return (
    <div className="space-y-3">
      <SearchInput
        value={search}
        onChange={(ev) => setSearch(ev.target.value)}
        placeholder="Search by name, email, title, or department…"
        aria-label="Search direct reports"
        wrapperClassName="max-w-sm"
      />
      {filtered.length === 0 ? (
        <p className="text-sm text-silver">
          No reports match “{search.trim()}”.
        </p>
      ) : (
        <DataGrid<(typeof filtered)[number]>
          id="team-reports"
          caption="Direct reports"
          rows={filtered}
          rowKey={(r) => r.id}
          search={false}
          urlState={false}
          exportCsv={{ filename: 'direct-reports' }}
          columns={[
            {
              key: 'associate',
              header: 'Associate',
              accessor: (r) => `${r.firstName} ${r.lastName}`,
              sortable: true,
              primary: true,
              className: 'font-medium',
              cell: (r) => (
                <Link
                  to={`/people?associateId=${r.id}`}
                  className="flex items-center gap-2.5 group focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 rounded"
                >
                  <Avatar name={`${r.firstName} ${r.lastName}`} email={r.email} size="sm" />
                  <div className="truncate group-hover:text-gold-bright transition-colors">
                    {r.firstName} {r.lastName}
                  </div>
                </Link>
              ),
            },
            { key: 'email', header: 'Email', accessor: (r) => r.email, sortable: true, cardMeta: true, className: 'text-silver' },
            { key: 'title', header: 'Title', accessor: (r) => r.jobTitle, sortable: true, className: 'text-silver', cell: (r) => r.jobTitle ?? '—' },
            { key: 'department', header: 'Department', accessor: (r) => r.departmentName, sortable: true, cardMeta: true, className: 'text-silver', cell: (r) => r.departmentName ?? '—' },
          ]}
        />
      )}
    </div>
  );
}

/** Worked hours of a completed entry; 0 while still clocked in. */
function entryHours(e: TeamTimeEntry): number {
  if (!e.clockOutAt) return 0;
  return (
    (new Date(e.clockOutAt).getTime() - new Date(e.clockInAt).getTime()) /
    3_600_000
  );
}

const TS_STATUS_OPTIONS: { value: TeamTimeEntry['status']; label: string }[] = [
  { value: 'COMPLETED', label: 'Pending review' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'REJECTED', label: 'Rejected' },
];

// Human-readable labels — raw enum values never reach the user's eyes.
// COMPLETED reads "Pending review" to match the filter above and the admin
// time queue. Tones come from the shared vocabulary with the time-domain
// overrides (see lib/timeLabels.ts).
const TS_STATUS_LABELS: Record<TeamTimeEntry['status'], string> = {
  ACTIVE: 'Active',
  COMPLETED: 'Pending review',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
};

function TimesheetsTab() {
  const prompt = usePrompt();
  const [status, setStatus] = useState<TeamTimeEntry['status']>('COMPLETED');
  const isQueue = status === 'COMPLETED';
  const q = useQuery({
    queryKey: teamKeys.timesheets(status),
    queryFn: async () => (await listTeamTimesheets(status)).entries,
  });

  // Invalidate the entire team namespace on any approve/reject so the
  // dashboard counts, inbox tab, and timesheet list all re-fetch
  // together. Tradeoff: a few redundant calls vs. one inconsistent
  // counter on screen — keeping the UI honest is worth the extra GETs.

  const approveM = useOptimisticMutation({
    mutationFn: approveTeamTimesheet,
    keys: [teamKeys.all],
    apply: (id: string, c) => removeFromLists(c, [teamKeys.all], [id]),
    errorMessage: 'Approve failed.',
    onSuccess: () => toast.success('Approved.'),
  });

  const rejectM = useOptimisticMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      rejectTeamTimesheet(id, reason),
    keys: [teamKeys.all],
    apply: ({ id }, c) => removeFromLists(c, [teamKeys.all], [id]),
    errorMessage: 'Reject failed.',
    onSuccess: () => toast.success('Rejected.'),
  });

  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Bulk clears every selected row at once. Some may come back — the
  // endpoint skips rows that raced to APPROVED elsewhere — and the settle
  // invalidation brings exactly those back while the toast says how many.
  const bulkM = useOptimisticMutation({
    mutationFn: (ids: string[]) => bulkApproveTeamTimesheets(ids),
    keys: [teamKeys.all],
    apply: (ids: string[], c) => removeFromLists(c, [teamKeys.all], ids),
    errorMessage: 'Bulk approve failed.',
    onSuccess: (r) => {
      toast.success(
        `Approved ${r.approved}${r.skipped.length ? ` · ${r.skipped.length} skipped` : ''}.`,
      );
      setSelected(new Set());
    },
  });
  // No bulk-reject endpoint exists, so mirror the bulk approve by looping
  // the single reject with one shared reason. allSettled: one bad row
  // (e.g. raced to APPROVED elsewhere) shouldn't sink the batch.
  const bulkRejectM = useOptimisticMutation({
    mutationFn: async ({ ids, reason }: { ids: string[]; reason: string }) => {
      const results = await Promise.allSettled(
        ids.map((id) => rejectTeamTimesheet(id, reason)),
      );
      return {
        rejected: results.filter((r) => r.status === 'fulfilled').length,
        failed: results.filter((r) => r.status === 'rejected').length,
      };
    },
    keys: [teamKeys.all],
    apply: ({ ids }, c) => removeFromLists(c, [teamKeys.all], ids),
    errorMessage: 'Bulk reject failed.',
    onSuccess: (r) => {
      if (r.failed > 0) {
        toast.error(`Rejected ${r.rejected} · ${r.failed} failed.`);
      } else {
        toast.success(`Rejected ${r.rejected}.`);
      }
      setSelected(new Set());
    },
  });

  const reject = async (id: string) => {
    const reason = (
      await prompt({
        title: 'Reject timesheet',
        reasonLabel: 'Reason for rejection',
        confirmLabel: 'Reject',
        destructive: true,
      })
    )?.trim();
    if (!reason) return;
    rejectM.mutate({ id, reason });
  };

  const bulkReject = async () => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    const reason = (
      await prompt({
        title: `Reject ${ids.length} ${ids.length === 1 ? 'timesheet' : 'timesheets'}`,
        reasonLabel: 'Shared reason for rejection',
        confirmLabel: 'Reject all',
        destructive: true,
      })
    )?.trim();
    if (!reason) return;
    bulkRejectM.mutate({ ids, reason });
  };

  const exportCsv = () => {
    const entries = q.data ?? [];
    downloadCsv(`team-timesheets-${status.toLowerCase()}-${ymdLocal()}.csv`, [
      [
        'Associate',
        'Client',
        'Clock in',
        'Clock out',
        'Hours',
        'Pay rate',
        'Est. cost',
        'Status',
        'Notes',
        'Rejection reason',
      ],
      ...entries.map((e) => {
        const hours = entryHours(e);
        return [
          e.associateName,
          e.clientName ?? '',
          e.clockInAt,
          e.clockOutAt ?? '',
          e.clockOutAt ? hours.toFixed(2) : '',
          e.payRate ?? '',
          e.payRate && e.clockOutAt
            ? (hours * Number(e.payRate)).toFixed(2)
            : '',
          e.status,
          e.notes ?? '',
          e.rejectionReason ?? '',
        ];
      }),
    ]);
  };

  const pendingId =
    approveM.isPending && typeof approveM.variables === 'string'
      ? approveM.variables
      : rejectM.isPending
      ? rejectM.variables?.id ?? null
      : null;

  const entries = q.data ?? null;
  const selectedEntries = (entries ?? []).filter((e) => selected.has(e.id));
  const selHours = selectedEntries.reduce((sum, e) => sum + entryHours(e), 0);
  const selCost = selectedEntries.reduce(
    (sum, e) => sum + (e.payRate ? entryHours(e) * Number(e.payRate) : 0),
    0,
  );


  const toolbar = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <SegmentedControl
        ariaLabel="Timesheet status"
        options={TS_STATUS_OPTIONS}
        value={status}
        onChange={(v) => {
          setStatus(v);
          setSelected(new Set());
        }}
      />
      <Button
        size="sm"
        variant="outline"
        onClick={exportCsv}
        disabled={!entries || entries.length === 0}
      >
        <Download className="h-3.5 w-3.5" />
        Export CSV
      </Button>
    </div>
  );

  if (q.error) {
    return (
      <div className="space-y-3">
        {toolbar}
        <ErrorBanner
          action={
            <Button size="sm" variant="secondary" onClick={() => q.refetch()}>
              Retry
            </Button>
          }
        >
          {q.error instanceof ApiError ? q.error.message : 'Failed to load.'}
        </ErrorBanner>
      </div>
    );
  }
  if (!entries) {
    return (
      <div className="space-y-3">
        {toolbar}
        <SkeletonRows count={4} rowHeight="h-14" />
      </div>
    );
  }
  if (entries.length === 0) {
    return (
      <div className="space-y-3">
        {toolbar}
        <EmptyState
          icon={Clock}
          title={isQueue ? 'Nothing to review' : `No ${status.toLowerCase()} entries`}
          description={
            isQueue
              ? 'When your direct reports clock out, their entries appear here for review.'
              : 'Decisions you make on the pending queue will show up here.'
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {toolbar}
      {isQueue && selected.size > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-gold/40 bg-gold/10 px-3 py-2">
          <div className="text-sm text-gold tabular-nums">
            <span className="font-medium">{selected.size}</span> selected ·{' '}
            {selHours.toFixed(1)}h
            {selCost > 0 ? ` · ${fmtMoney(selCost)}` : ''}
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setSelected(new Set())}
              disabled={bulkM.isPending || bulkRejectM.isPending}
            >
              Clear
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={bulkReject}
              loading={bulkRejectM.isPending}
              disabled={bulkM.isPending}
            >
              Reject {selected.size}
            </Button>
            <Button
              size="sm"
              onClick={() => bulkM.mutate(Array.from(selected))}
              loading={bulkM.isPending}
              disabled={bulkRejectM.isPending}
            >
              Approve {selected.size}
            </Button>
          </div>
        </div>
      )}
      <DataGrid<(typeof entries)[number]>
        id="team-timesheets"
        caption={isQueue ? 'Time entries to review' : `${status.toLowerCase()} time entries`}
        rows={entries}
        rowKey={(e) => e.id}
        search={{ placeholder: 'Associate, client…' }}
        urlState={false}
        exportCsv={false}
        selectable={isQueue ? { selection: { selected, onChange: setSelected } } : undefined}
        columns={[
          {
            key: 'associate',
            header: 'Associate',
            accessor: (e) => e.associateName,
            sortable: true,
            primary: true,
            className: 'font-medium',
            cell: (e) => (
              <div className="flex items-center gap-2.5">
                <Avatar name={e.associateName} size="sm" />
                <div className="truncate">{e.associateName}</div>
              </div>
            ),
          },
          { key: 'client', header: 'Client', accessor: (e) => e.clientName, sortable: true, cardMeta: true, className: 'text-silver', cell: (e) => e.clientName ?? '—' },
          { key: 'in', header: 'Clock in', accessor: (e) => e.clockInAt, sortable: true, searchable: false, cardMeta: true, className: 'text-silver tabular-nums', cell: (e) => fmtDateTime(e.clockInAt) },
          { key: 'out', header: 'Clock out', accessor: (e) => e.clockOutAt, sortable: true, searchable: false, className: 'text-silver tabular-nums', cell: (e) => (e.clockOutAt ? fmtDateTime(e.clockOutAt) : '—') },
          {
            key: 'hours',
            header: 'Hours',
            accessor: (e) => (e.clockOutAt ? entryHours(e) : null),
            csv: (e) => (e.clockOutAt ? entryHours(e).toFixed(2) : ''),
            sortable: true,
            searchable: false,
            align: 'right',
            className: 'tabular-nums',
            cell: (e) => (e.clockOutAt ? entryHours(e).toFixed(2) : '—'),
          },
          {
            key: 'cost',
            header: 'Est. cost',
            accessor: (e) => (e.payRate && e.clockOutAt ? entryHours(e) * Number(e.payRate) : null),
            csv: (e) => (e.payRate && e.clockOutAt ? fmtMoney(entryHours(e) * Number(e.payRate)) : ''),
            sortable: true,
            searchable: false,
            align: 'right',
            className: 'text-silver tabular-nums',
            cell: (e) => (e.payRate && e.clockOutAt ? fmtMoney(entryHours(e) * Number(e.payRate)) : '—'),
          },
          {
            key: 'notes',
            header: 'Notes',
            accessor: (e) => e.notes ?? (e.status === 'REJECTED' && e.rejectionReason ? `Rejected: ${e.rejectionReason}` : null),
            defaultHidden: true,
            className: 'text-silver',
            cell: (e) =>
              e.notes ? (
                <span className="block max-w-[16rem] truncate" title={e.notes}>
                  {e.notes}
                </span>
              ) : e.status === 'REJECTED' && e.rejectionReason ? (
                <span className="block max-w-[16rem] truncate text-alert/80" title={`Rejected: ${e.rejectionReason}`}>
                  Rejected: {e.rejectionReason}
                </span>
              ) : (
                '—'
              ),
          },
          isQueue
            ? {
                key: 'actions',
                header: 'Actions',
                accessor: () => null,
                searchable: false,
                csv: () => '',
                align: 'right',
                stopRowClick: true,
                cell: (e) => (
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="outline" onClick={() => reject(e.id)} disabled={pendingId === e.id}>
                      Reject
                    </Button>
                    <Button size="sm" onClick={() => approveM.mutate(e.id)} loading={pendingId === e.id}>
                      Approve
                    </Button>
                  </div>
                ),
              }
            : {
                key: 'status',
                header: 'Status',
                accessor: (e) => TS_STATUS_LABELS[e.status] ?? e.status,
                sortable: true,
                align: 'right',
                cell: (e) => <Badge variant={statusTone(e.status, { overrides: TIME_ENTRY_STATUS_TONES })}>{TS_STATUS_LABELS[e.status] ?? e.status}</Badge>,
              },
        ]}
      />
    </div>
  );
}

function TimeOffTab() {
  const prompt = usePrompt();
  const q = useQuery({
    queryKey: teamKeys.timeoff('PENDING'),
    queryFn: async () => (await listTeamTimeOff('PENDING')).requests,
  });


  const approveM = useOptimisticMutation({
    mutationFn: (id: string) => approveTeamTimeOff(id),
    keys: [teamKeys.all],
    apply: (id: string, c) => removeFromLists(c, [teamKeys.all], [id]),
    errorMessage: 'Approve failed.',
    onSuccess: () => toast.success('Approved.'),
  });

  const denyM = useOptimisticMutation({
    mutationFn: ({ id, note }: { id: string; note: string }) =>
      denyTeamTimeOff(id, note),
    keys: [teamKeys.all],
    apply: ({ id }, c) => removeFromLists(c, [teamKeys.all], [id]),
    errorMessage: 'Deny failed.',
    onSuccess: () => toast.success('Denied.'),
  });

  const deny = async (id: string) => {
    const note = (
      await prompt({
        title: 'Deny time-off request',
        reasonLabel: 'Reason for denial',
        confirmLabel: 'Deny',
        destructive: true,
      })
    )?.trim();
    if (!note) return;
    denyM.mutate({ id, note });
  };

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const bulkM = useOptimisticMutation({
    mutationFn: (ids: string[]) => bulkApproveTeamTimeOff(ids),
    keys: [teamKeys.all],
    apply: (ids: string[], c) => removeFromLists(c, [teamKeys.all], ids),
    errorMessage: 'Bulk approve failed.',
    onSuccess: (r) => {
      toast.success(
        `Approved ${r.approved}${r.skipped.length ? ` · ${r.skipped.length} skipped` : ''}.`,
      );
      setSelected(new Set());
    },
  });
  // No bulk-deny endpoint — loop the single deny with one shared note,
  // allSettled so one already-decided row doesn't sink the batch.
  const bulkDenyM = useOptimisticMutation({
    mutationFn: async ({ ids, note }: { ids: string[]; note: string }) => {
      const results = await Promise.allSettled(
        ids.map((id) => denyTeamTimeOff(id, note)),
      );
      return {
        denied: results.filter((r) => r.status === 'fulfilled').length,
        failed: results.filter((r) => r.status === 'rejected').length,
      };
    },
    keys: [teamKeys.all],
    apply: ({ ids }, c) => removeFromLists(c, [teamKeys.all], ids),
    errorMessage: 'Bulk deny failed.',
    onSuccess: (r) => {
      if (r.failed > 0) {
        toast.error(`Denied ${r.denied} · ${r.failed} failed.`);
      } else {
        toast.success(`Denied ${r.denied}.`);
      }
      setSelected(new Set());
    },
  });
  const bulkDeny = async () => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    const note = (
      await prompt({
        title: `Deny ${ids.length} time-off ${ids.length === 1 ? 'request' : 'requests'}`,
        reasonLabel: 'Shared reason for denial',
        confirmLabel: 'Deny all',
        destructive: true,
      })
    )?.trim();
    if (!note) return;
    bulkDenyM.mutate({ ids, note });
  };

  const pendingId =
    approveM.isPending && typeof approveM.variables === 'string'
      ? approveM.variables
      : denyM.isPending
      ? denyM.variables?.id ?? null
      : null;

  if (q.error) {
    return (
      <ErrorBanner
        action={
          <Button size="sm" variant="secondary" onClick={() => q.refetch()}>
            Retry
          </Button>
        }
      >
        {q.error instanceof ApiError ? q.error.message : 'Failed to load.'}
      </ErrorBanner>
    );
  }
  if (!q.data) return <SkeletonRows count={4} rowHeight="h-14" />;
  if (q.data.length === 0) {
    return (
      <EmptyState
        icon={CalendarOff}
        title="No pending time-off requests"
        description="When your team requests PTO, you'll see it here."
      />
    );
  }

  return (
    <div className="space-y-3">
      {selected.size > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-gold/40 bg-gold/10 px-3 py-2">
          <div className="text-sm text-gold">
            <span className="font-medium tabular-nums">{selected.size}</span>{' '}
            selected
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setSelected(new Set())}
              disabled={bulkM.isPending || bulkDenyM.isPending}
            >
              Clear
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={bulkDeny}
              loading={bulkDenyM.isPending}
              disabled={bulkM.isPending}
            >
              Deny {selected.size}
            </Button>
            <Button
              size="sm"
              onClick={() => bulkM.mutate(Array.from(selected))}
              loading={bulkM.isPending}
              disabled={bulkDenyM.isPending}
            >
              Approve {selected.size}
            </Button>
          </div>
        </div>
      )}
      <DataGrid<(typeof q.data)[number]>
        id="team-time-off"
        caption="Time-off requests to review"
        rows={q.data}
        rowKey={(r) => r.id}
        search={{ placeholder: 'Associate, category…' }}
        urlState={false}
        exportCsv={false}
        selectable={{ selection: { selected, onChange: setSelected } }}
        columns={[
          {
            key: 'associate',
            header: 'Associate',
            accessor: (r) => r.associateName,
            sortable: true,
            primary: true,
            className: 'font-medium',
            cell: (r) => (
              <div className="flex items-center gap-2.5">
                <Avatar name={r.associateName} size="sm" />
                <div className="truncate">{r.associateName}</div>
              </div>
            ),
          },
          { key: 'category', header: 'Category', accessor: (r) => r.category, sortable: true, cardMeta: true, className: 'text-silver' },
          {
            key: 'dates',
            header: 'Dates',
            accessor: (r) => r.startDate,
            csv: (r) => `${r.startDate} → ${r.endDate}`,
            sortable: true,
            searchable: false,
            className: 'text-silver tabular-nums',
            cell: (r) => (
              <>
                {fmtDate(parseYmd(r.startDate))} → {fmtDate(parseYmd(r.endDate))}
              </>
            ),
          },
          {
            key: 'hours',
            header: 'Hours',
            accessor: (r) => r.requestedMinutes / 60,
            csv: (r) => (r.requestedMinutes / 60).toFixed(1),
            sortable: true,
            searchable: false,
            cardMeta: true,
            className: 'tabular-nums',
            cell: (r) => `${(r.requestedMinutes / 60).toFixed(1)}h`,
          },
          {
            key: 'actions',
            header: 'Actions',
            accessor: () => null,
            searchable: false,
            csv: () => '',
            align: 'right',
            stopRowClick: true,
            cell: (r) => (
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="outline" onClick={() => deny(r.id)} disabled={pendingId === r.id}>
                  Deny
                </Button>
                <Button size="sm" onClick={() => approveM.mutate(r.id)} loading={pendingId === r.id}>
                  Approve
                </Button>
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}

/**
 * Whose inbox this is today: cover received (their reports are in the
 * queues below) and cover given (someone else is reading along).
 */
function DelegationBanner() {
  const { can } = useAuth();
  const mine = useQuery({ queryKey: ['delegations', 'mine'], queryFn: getMyDelegations, enabled: can('view:my-team') });
  const received = mine.data?.received.filter((d) => d.startsOn <= (mine.data?.today ?? '')) ?? [];
  const given = mine.data?.given.filter((d) => d.startsOn <= (mine.data?.today ?? '')) ?? [];
  if (received.length === 0 && given.length === 0) return null;
  return (
    <div className="rounded-md border border-gold/40 bg-gold/5 px-3 py-2 text-sm text-silver">
      {received.map((d) => (
        <div key={d.id}>
          Covering for <span className="text-white">{d.from.name}</span> until {fmtDate(parseYmd(d.endsOn))} — their reports are in these queues.
        </div>
      ))}
      {given.map((d) => (
        <div key={d.id}>
          <span className="text-white">{d.to.name}</span> is covering your inbox until {fmtDate(parseYmd(d.endsOn))}.
        </div>
      ))}
    </div>
  );
}
