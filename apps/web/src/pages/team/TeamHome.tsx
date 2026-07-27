import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui';
import { toast } from 'sonner';
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
  const qc = useQueryClient();
  const prompt = usePrompt();
  const q = useQuery({
    queryKey: teamKeys.inbox(),
    queryFn: getTeamInbox,
  });

  const invalidateTeam = () => qc.invalidateQueries({ queryKey: teamKeys.all });

  // Same API mutations as the Timesheets/Time off queue tabs, so a
  // decision made from the inbox behaves identically (invalidates the
  // whole team namespace → counts, queues, and this list all refresh).
  const approveTsM = useMutation({
    mutationFn: approveTeamTimesheet,
    onSuccess: () => {
      toast.success('Timesheet approved.');
      invalidateTeam();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'Approve failed.'),
  });
  const rejectTsM = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      rejectTeamTimesheet(id, reason),
    onSuccess: () => {
      toast.success('Timesheet rejected.');
      invalidateTeam();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'Reject failed.'),
  });
  const approvePtoM = useMutation({
    mutationFn: (id: string) => approveTeamTimeOff(id),
    onSuccess: () => {
      toast.success('Time off approved.');
      invalidateTeam();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'Approve failed.'),
  });
  const denyPtoM = useMutation({
    mutationFn: ({ id, note }: { id: string; note: string }) =>
      denyTeamTimeOff(id, note),
    onSuccess: () => {
      toast.success('Time off denied.');
      invalidateTeam();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'Deny failed.'),
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
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="hidden md:table-cell">Type</TableHead>
          <TableHead>Associate</TableHead>
          <TableHead className="hidden md:table-cell">Details</TableHead>
          <TableHead className="tabular-nums">Age</TableHead>
          <TableHead className="text-right">Action</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {q.data.items.map((item) => {
          const meta = KIND_META[item.kind];
          const Icon = meta.icon;
          const stale = item.ageDays >= 3;
          return (
            <TableRow key={`${item.kind}-${item.id}`}>
              <TableCell className="hidden md:table-cell">
                <div className="flex items-center gap-1.5 text-xs">
                  <Icon className={`h-3.5 w-3.5 ${meta.tone}`} />
                  <span className="text-silver">{meta.label}</span>
                </div>
              </TableCell>
              <TableCell className="font-medium">
                <div className="flex items-center gap-2.5">
                  <Avatar name={item.associateName} size="sm" />
                  <div className="min-w-0">
                    <div className="truncate">{item.associateName}</div>
                    <div className="md:hidden text-xs2 text-silver/70 truncate">
                      {meta.label}{item.summary ? ` · ${item.summary}` : ''}
                    </div>
                  </div>
                </div>
              </TableCell>
              <TableCell className="hidden md:table-cell text-silver">{item.summary}</TableCell>
              <TableCell className={`tabular-nums ${stale ? 'text-alert' : 'text-silver'}`}>
                {item.ageDays === 0 ? 'today' : `${item.ageDays}d`}
              </TableCell>
              <TableCell className="text-right">
                <div className="flex justify-end gap-2">
                  <Button size="sm" variant="ghost" asChild>
                    <Link to={item.link}>Open</Link>
                  </Button>
                  {item.kind === 'TIMESHEET' && (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => rejectTs(item.id)}
                        disabled={pendingId === item.id}
                      >
                        Reject
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => approveTsM.mutate(item.id)}
                        loading={pendingId === item.id}
                      >
                        Approve
                      </Button>
                    </>
                  )}
                  {item.kind === 'TIME_OFF' && (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => denyPto(item.id)}
                        disabled={pendingId === item.id}
                      >
                        Deny
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => approvePtoM.mutate(item.id)}
                        loading={pendingId === item.id}
                      >
                        Approve
                      </Button>
                    </>
                  )}
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
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
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Associate</TableHead>
              <TableHead className="hidden md:table-cell">Email</TableHead>
              <TableHead>Title</TableHead>
              <TableHead className="hidden md:table-cell">Department</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-medium">
                  <Link
                    to={`/people?associateId=${r.id}`}
                    className="flex items-center gap-2.5 group focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 rounded"
                  >
                    <Avatar
                      name={`${r.firstName} ${r.lastName}`}
                      email={r.email}
                      size="sm"
                    />
                    <div className="min-w-0">
                      <div className="truncate group-hover:text-gold-bright transition-colors">
                        {r.firstName} {r.lastName}
                      </div>
                      <div className="md:hidden text-xs2 text-silver/70 truncate">
                        {r.email}{r.departmentName ? ` · ${r.departmentName}` : ''}
                      </div>
                    </div>
                  </Link>
                </TableCell>
                <TableCell className="hidden md:table-cell text-silver">{r.email}</TableCell>
                <TableCell className="text-silver">{r.jobTitle ?? '—'}</TableCell>
                <TableCell className="hidden md:table-cell text-silver">{r.departmentName ?? '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
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

const TS_STATUS_BADGE: Record<
  TeamTimeEntry['status'],
  'default' | 'success' | 'destructive'
> = {
  ACTIVE: 'default',
  COMPLETED: 'default',
  APPROVED: 'success',
  REJECTED: 'destructive',
};

// Human-readable labels — raw enum values never reach the user's eyes.
const TS_STATUS_LABELS: Record<TeamTimeEntry['status'], string> = {
  ACTIVE: 'Active',
  COMPLETED: 'Completed',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
};

function TimesheetsTab() {
  const qc = useQueryClient();
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
  const invalidateTeam = () => qc.invalidateQueries({ queryKey: teamKeys.all });

  const approveM = useMutation({
    mutationFn: approveTeamTimesheet,
    onSuccess: () => {
      toast.success('Approved.');
      invalidateTeam();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'Approve failed.'),
  });

  const rejectM = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      rejectTeamTimesheet(id, reason),
    onSuccess: () => {
      toast.success('Rejected.');
      invalidateTeam();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'Reject failed.'),
  });

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const bulkM = useMutation({
    mutationFn: (ids: string[]) => bulkApproveTeamTimesheets(ids),
    onSuccess: (r) => {
      toast.success(
        `Approved ${r.approved}${r.skipped.length ? ` · ${r.skipped.length} skipped` : ''}.`,
      );
      setSelected(new Set());
      invalidateTeam();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'Bulk approve failed.'),
  });
  // No bulk-reject endpoint exists, so mirror the bulk approve by looping
  // the single reject with one shared reason. allSettled: one bad row
  // (e.g. raced to APPROVED elsewhere) shouldn't sink the batch.
  const bulkRejectM = useMutation({
    mutationFn: async ({ ids, reason }: { ids: string[]; reason: string }) => {
      const results = await Promise.allSettled(
        ids.map((id) => rejectTeamTimesheet(id, reason)),
      );
      return {
        rejected: results.filter((r) => r.status === 'fulfilled').length,
        failed: results.filter((r) => r.status === 'rejected').length,
      };
    },
    onSuccess: (r) => {
      if (r.failed > 0) {
        toast.error(`Rejected ${r.rejected} · ${r.failed} failed.`);
      } else {
        toast.success(`Rejected ${r.rejected}.`);
      }
      setSelected(new Set());
      invalidateTeam();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'Bulk reject failed.'),
  });
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
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

  const allIds = (entries ?? []).map((e) => e.id);
  const allSelected =
    allIds.length > 0 && allIds.every((id) => selected.has(id));

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
      <Table>
        <TableHeader>
          <TableRow>
            {isQueue && (
              <TableHead className="w-8">
                <input
                  type="checkbox"
                  className="accent-gold"
                  checked={allSelected}
                  aria-label="Select all"
                  onChange={(ev) =>
                    setSelected(ev.target.checked ? new Set(allIds) : new Set())
                  }
                />
              </TableHead>
            )}
            <TableHead>Associate</TableHead>
            <TableHead className="hidden lg:table-cell">Client</TableHead>
            <TableHead className="hidden md:table-cell">Clock in</TableHead>
            <TableHead>Clock out</TableHead>
            <TableHead className="text-right tabular-nums">Hours</TableHead>
            <TableHead className="hidden lg:table-cell text-right tabular-nums">
              Est. cost
            </TableHead>
            <TableHead className="hidden xl:table-cell">Notes</TableHead>
            <TableHead className="text-right">
              {isQueue ? 'Actions' : 'Status'}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.map((e) => {
            const hours = entryHours(e);
            return (
              <TableRow
                key={e.id}
                data-state={selected.has(e.id) ? 'selected' : undefined}
              >
                {isQueue && (
                  <TableCell>
                    <input
                      type="checkbox"
                      className="accent-gold"
                      checked={selected.has(e.id)}
                      aria-label={`Select ${e.associateName}`}
                      onChange={() => toggle(e.id)}
                    />
                  </TableCell>
                )}
                <TableCell className="font-medium">
                  <div className="flex items-center gap-2.5">
                    <Avatar name={e.associateName} size="sm" />
                    <div className="min-w-0">
                      <div className="truncate">{e.associateName}</div>
                      <div className="md:hidden text-xs2 text-silver/70 truncate">
                        <span className="tabular-nums">
                          In {fmtDateTime(e.clockInAt)}
                        </span>
                        {e.clientName ? ` · ${e.clientName}` : ''}
                      </div>
                    </div>
                  </div>
                </TableCell>
                <TableCell className="hidden lg:table-cell text-silver">{e.clientName ?? '—'}</TableCell>
                <TableCell className="hidden md:table-cell text-silver tabular-nums">
                  {fmtDateTime(e.clockInAt)}
                </TableCell>
                <TableCell className="text-silver tabular-nums">
                  {e.clockOutAt ? fmtDateTime(e.clockOutAt) : '—'}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {e.clockOutAt ? hours.toFixed(2) : '—'}
                </TableCell>
                <TableCell className="hidden lg:table-cell text-right text-silver tabular-nums">
                  {e.payRate && e.clockOutAt
                    ? fmtMoney(hours * Number(e.payRate))
                    : '—'}
                </TableCell>
                <TableCell className="hidden xl:table-cell text-silver">
                  {e.notes ? (
                    <span
                      className="block max-w-[16rem] truncate"
                      title={e.notes}
                    >
                      {e.notes}
                    </span>
                  ) : e.status === 'REJECTED' && e.rejectionReason ? (
                    <span
                      className="block max-w-[16rem] truncate text-alert/80"
                      title={`Rejected: ${e.rejectionReason}`}
                    >
                      Rejected: {e.rejectionReason}
                    </span>
                  ) : (
                    '—'
                  )}
                </TableCell>
                <TableCell className="text-right">
                  {isQueue ? (
                    <div className="flex justify-end gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => reject(e.id)}
                        disabled={pendingId === e.id}
                      >
                        Reject
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => approveM.mutate(e.id)}
                        loading={pendingId === e.id}
                      >
                        Approve
                      </Button>
                    </div>
                  ) : (
                    <Badge variant={TS_STATUS_BADGE[e.status]}>
                      {TS_STATUS_LABELS[e.status] ?? e.status}
                    </Badge>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function TimeOffTab() {
  const qc = useQueryClient();
  const prompt = usePrompt();
  const q = useQuery({
    queryKey: teamKeys.timeoff('PENDING'),
    queryFn: async () => (await listTeamTimeOff('PENDING')).requests,
  });

  const invalidateTeam = () => qc.invalidateQueries({ queryKey: teamKeys.all });

  const approveM = useMutation({
    mutationFn: (id: string) => approveTeamTimeOff(id),
    onSuccess: () => {
      toast.success('Approved.');
      invalidateTeam();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'Approve failed.'),
  });

  const denyM = useMutation({
    mutationFn: ({ id, note }: { id: string; note: string }) =>
      denyTeamTimeOff(id, note),
    onSuccess: () => {
      toast.success('Denied.');
      invalidateTeam();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'Deny failed.'),
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
  const bulkM = useMutation({
    mutationFn: (ids: string[]) => bulkApproveTeamTimeOff(ids),
    onSuccess: (r) => {
      toast.success(
        `Approved ${r.approved}${r.skipped.length ? ` · ${r.skipped.length} skipped` : ''}.`,
      );
      setSelected(new Set());
      invalidateTeam();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'Bulk approve failed.'),
  });
  // No bulk-deny endpoint — loop the single deny with one shared note,
  // allSettled so one already-decided row doesn't sink the batch.
  const bulkDenyM = useMutation({
    mutationFn: async ({ ids, note }: { ids: string[]; note: string }) => {
      const results = await Promise.allSettled(
        ids.map((id) => denyTeamTimeOff(id, note)),
      );
      return {
        denied: results.filter((r) => r.status === 'fulfilled').length,
        failed: results.filter((r) => r.status === 'rejected').length,
      };
    },
    onSuccess: (r) => {
      if (r.failed > 0) {
        toast.error(`Denied ${r.denied} · ${r.failed} failed.`);
      } else {
        toast.success(`Denied ${r.denied}.`);
      }
      setSelected(new Set());
      invalidateTeam();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'Bulk deny failed.'),
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
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

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

  const allIds = q.data.map((r) => r.id);
  const allSelected = allIds.length > 0 && allIds.every((id) => selected.has(id));

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
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-8">
              <input
                type="checkbox"
                className="accent-gold"
                checked={allSelected}
                aria-label="Select all"
                onChange={(ev) =>
                  setSelected(ev.target.checked ? new Set(allIds) : new Set())
                }
              />
            </TableHead>
            <TableHead>Associate</TableHead>
            <TableHead className="hidden md:table-cell">Category</TableHead>
            <TableHead>Dates</TableHead>
            <TableHead className="hidden sm:table-cell">Hours</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {q.data.map((r) => (
            <TableRow
              key={r.id}
              data-state={selected.has(r.id) ? 'selected' : undefined}
            >
              <TableCell>
                <input
                  type="checkbox"
                  className="accent-gold"
                  checked={selected.has(r.id)}
                  aria-label={`Select ${r.associateName}`}
                  onChange={() => toggle(r.id)}
                />
              </TableCell>
              <TableCell className="font-medium">
                <div className="flex items-center gap-2.5">
                  <Avatar name={r.associateName} size="sm" />
                  <div className="min-w-0">
                    <div className="truncate">{r.associateName}</div>
                    <div className="md:hidden text-xs2 text-silver/70 truncate">
                      {r.category}
                      <span className="sm:hidden tabular-nums">
                        {' · '}
                        {(r.requestedMinutes / 60).toFixed(1)}h
                      </span>
                    </div>
                  </div>
                </div>
              </TableCell>
              <TableCell className="hidden md:table-cell text-silver">{r.category}</TableCell>
              <TableCell className="text-silver tabular-nums">
                {fmtDate(parseYmd(r.startDate))} → {fmtDate(parseYmd(r.endDate))}
              </TableCell>
              <TableCell className="hidden sm:table-cell tabular-nums">
                {(r.requestedMinutes / 60).toFixed(1)}h
              </TableCell>
              <TableCell className="text-right">
                <div className="flex justify-end gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => deny(r.id)}
                    disabled={pendingId === r.id}
                  >
                    Deny
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => approveM.mutate(r.id)}
                    loading={pendingId === r.id}
                  >
                    Approve
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
