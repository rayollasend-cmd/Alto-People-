import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CalendarOff, Clock, Inbox, Receipt, Target, Users } from 'lucide-react';
import { ApiError } from '@/lib/api';
import {
  approveTeamTimeOff,
  approveTeamTimesheet,
  denyTeamTimeOff,
  getTeamDashboard,
  getTeamInbox,
  listReports,
  listTeamTimeOff,
  listTeamTimesheets,
  rejectTeamTimesheet,
  type DirectReport,
  type InboxItem,
} from '@/lib/teamApi';
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  PageHeader,
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
        <p role="alert" className="text-sm text-alert">
          {error instanceof ApiError ? error.message : 'Failed to load team.'}
        </p>
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
          <div className="text-[10px] uppercase tracking-widest text-silver/80">
            {label}
          </div>
          <Icon className={`h-4 w-4 ${highlight ? 'text-gold' : 'text-silver/60'}`} />
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
  const q = useQuery({
    queryKey: teamKeys.inbox(),
    queryFn: getTeamInbox,
  });

  if (q.error) {
    return (
      <p role="alert" className="text-sm text-alert">
        {q.error instanceof ApiError ? q.error.message : 'Failed to load.'}
      </p>
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
          <TableHead>Type</TableHead>
          <TableHead>Associate</TableHead>
          <TableHead>Details</TableHead>
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
              <TableCell>
                <div className="flex items-center gap-1.5 text-xs">
                  <Icon className={`h-3.5 w-3.5 ${meta.tone}`} />
                  <span className="text-silver">{meta.label}</span>
                </div>
              </TableCell>
              <TableCell className="font-medium">
                <div className="flex items-center gap-2.5">
                  <Avatar name={item.associateName} size="sm" />
                  <span>{item.associateName}</span>
                </div>
              </TableCell>
              <TableCell className="text-silver">{item.summary}</TableCell>
              <TableCell className={`tabular-nums ${stale ? 'text-alert' : 'text-silver'}`}>
                {item.ageDays === 0 ? 'today' : `${item.ageDays}d`}
              </TableCell>
              <TableCell className="text-right">
                <Button size="sm" variant="outline" asChild>
                  <Link to={item.link}>Open</Link>
                </Button>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function ReportsList({ reports }: { reports: DirectReport[] | null }) {
  if (!reports) return <SkeletonRows count={4} rowHeight="h-14" />;
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
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Associate</TableHead>
          <TableHead>Email</TableHead>
          <TableHead>Title</TableHead>
          <TableHead>Department</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {reports.map((r) => (
          <TableRow key={r.id}>
            <TableCell className="font-medium">
              <div className="flex items-center gap-2.5">
                <Avatar
                  name={`${r.firstName} ${r.lastName}`}
                  email={r.email}
                  size="sm"
                />
                <span>{r.firstName} {r.lastName}</span>
              </div>
            </TableCell>
            <TableCell className="text-silver">{r.email}</TableCell>
            <TableCell className="text-silver">{r.jobTitle ?? '—'}</TableCell>
            <TableCell className="text-silver">{r.departmentName ?? '—'}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function TimesheetsTab() {
  const qc = useQueryClient();
  const prompt = usePrompt();
  const q = useQuery({
    queryKey: teamKeys.timesheets('COMPLETED'),
    queryFn: async () => (await listTeamTimesheets('COMPLETED')).entries,
  });

  // Invalidate the entire team namespace on any approve/reject so the
  // dashboard counts, inbox tab, and timesheet list all re-fetch
  // together. Tradeoff: a few redundant calls vs. one inconsistent
  // counter on screen — keeping the UI honest is worth the extra GETs.
  const invalidateTeam = () => qc.invalidateQueries({ queryKey: teamKeys.all });

  const approveM = useMutation({
    mutationFn: approveTeamTimesheet,
    onSuccess: () => {
      toast.success('Approved');
      invalidateTeam();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'Approve failed'),
  });

  const rejectM = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      rejectTeamTimesheet(id, reason),
    onSuccess: () => {
      toast.success('Rejected');
      invalidateTeam();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'Reject failed'),
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

  const pendingId =
    approveM.isPending && typeof approveM.variables === 'string'
      ? approveM.variables
      : rejectM.isPending
      ? rejectM.variables?.id ?? null
      : null;

  if (q.error) {
    return (
      <p role="alert" className="text-sm text-alert">
        {q.error instanceof ApiError ? q.error.message : 'Failed to load.'}
      </p>
    );
  }
  if (!q.data) return <SkeletonRows count={4} rowHeight="h-14" />;
  if (q.data.length === 0) {
    return (
      <EmptyState
        icon={Clock}
        title="Nothing to review"
        description="When your direct reports clock out, their entries appear here for review."
      />
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Associate</TableHead>
          <TableHead>Client</TableHead>
          <TableHead>Clock in</TableHead>
          <TableHead>Clock out</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {q.data.map((e) => (
          <TableRow key={e.id}>
            <TableCell className="font-medium">
              <div className="flex items-center gap-2.5">
                <Avatar name={e.associateName} size="sm" />
                <span>{e.associateName}</span>
              </div>
            </TableCell>
            <TableCell className="text-silver">{e.clientName ?? '—'}</TableCell>
            <TableCell className="text-silver tabular-nums">
              {new Date(e.clockInAt).toLocaleString()}
            </TableCell>
            <TableCell className="text-silver tabular-nums">
              {e.clockOutAt ? new Date(e.clockOutAt).toLocaleString() : '—'}
            </TableCell>
            <TableCell className="text-right">
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
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
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
      toast.success('Approved');
      invalidateTeam();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'Approve failed'),
  });

  const denyM = useMutation({
    mutationFn: ({ id, note }: { id: string; note: string }) =>
      denyTeamTimeOff(id, note),
    onSuccess: () => {
      toast.success('Denied');
      invalidateTeam();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'Deny failed'),
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

  const pendingId =
    approveM.isPending && typeof approveM.variables === 'string'
      ? approveM.variables
      : denyM.isPending
      ? denyM.variables?.id ?? null
      : null;

  if (q.error) {
    return (
      <p role="alert" className="text-sm text-alert">
        {q.error instanceof ApiError ? q.error.message : 'Failed to load.'}
      </p>
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
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Associate</TableHead>
          <TableHead>Category</TableHead>
          <TableHead>Dates</TableHead>
          <TableHead>Hours</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {q.data.map((r) => (
          <TableRow key={r.id}>
            <TableCell className="font-medium">
              <div className="flex items-center gap-2.5">
                <Avatar name={r.associateName} size="sm" />
                <span>{r.associateName}</span>
              </div>
            </TableCell>
            <TableCell className="text-silver">{r.category}</TableCell>
            <TableCell className="text-silver tabular-nums">
              {r.startDate} → {r.endDate}
            </TableCell>
            <TableCell className="tabular-nums">
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
  );
}
