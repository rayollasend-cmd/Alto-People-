import { useEffect, useState } from 'react';
import { CalendarOff, Clock, Users } from 'lucide-react';
import { ApiError } from '@/lib/api';
import {
  approveTeamTimeOff,
  approveTeamTimesheet,
  denyTeamTimeOff,
  getTeamDashboard,
  listReports,
  listTeamTimeOff,
  listTeamTimesheets,
  rejectTeamTimesheet,
  type DirectReport,
  type TeamDashboard,
  type TeamTimeEntry,
  type TeamTimeOffRequest,
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

export function TeamHome() {
  const [tab, setTab] = useState<'overview' | 'timesheets' | 'timeoff'>('overview');
  const [dashboard, setDashboard] = useState<TeamDashboard | null>(null);
  const [reports, setReports] = useState<DirectReport[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshDashboard = async () => {
    try {
      setError(null);
      const [d, r] = await Promise.all([getTeamDashboard(), listReports()]);
      setDashboard(d);
      setReports(r.reports);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load team.');
    }
  };

  useEffect(() => {
    refreshDashboard();
  }, []);

  return (
    <div className="space-y-5">
      <PageHeader
        title="My team"
        subtitle="Direct reports, pending timesheet reviews, and time-off decisions awaiting your sign-off."
        breadcrumbs={[{ label: 'Workforce' }, { label: 'My team' }]}
      />

      {dashboard && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiTile
            label="Direct reports"
            value={dashboard.directReports.toString()}
            icon={Users}
          />
          <KpiTile
            label="Timesheets to review"
            value={dashboard.pendingTimesheets.toString()}
            icon={Clock}
            highlight={dashboard.pendingTimesheets > 0}
          />
          <KpiTile
            label="Time-off pending"
            value={dashboard.pendingTimeOff.toString()}
            icon={CalendarOff}
            highlight={dashboard.pendingTimeOff > 0}
          />
          <KpiTile
            label="Onboarding"
            value={dashboard.onboardingInProgress.toString()}
            icon={Users}
          />
        </div>
      )}

      {error && <p role="alert" className="text-sm text-alert">{error}</p>}

      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
        <TabsList>
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
        <TabsContent value="overview">
          <ReportsList reports={reports} />
        </TabsContent>
        <TabsContent value="timesheets">
          <TimesheetsTab onChange={refreshDashboard} />
        </TabsContent>
        <TabsContent value="timeoff">
          <TimeOffTab onChange={refreshDashboard} />
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

function TimesheetsTab({ onChange }: { onChange: () => void }) {
  const prompt = usePrompt();
  const [entries, setEntries] = useState<TeamTimeEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const refresh = async () => {
    try {
      setError(null);
      const res = await listTeamTimesheets('COMPLETED');
      setEntries(res.entries);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load.');
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const approve = async (id: string) => {
    setPendingId(id);
    try {
      await approveTeamTimesheet(id);
      toast.success('Approved');
      await refresh();
      onChange();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Approve failed');
    } finally {
      setPendingId(null);
    }
  };

  const reject = async (id: string) => {
    const reason = (await prompt({
      title: 'Reject timesheet',
      reasonLabel: 'Reason for rejection',
      confirmLabel: 'Reject',
      destructive: true,
    }))?.trim();
    if (!reason) return;
    setPendingId(id);
    try {
      await rejectTeamTimesheet(id, reason);
      toast.success('Rejected');
      await refresh();
      onChange();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Reject failed');
    } finally {
      setPendingId(null);
    }
  };

  if (error) return <p role="alert" className="text-sm text-alert">{error}</p>;
  if (!entries) return <SkeletonRows count={4} rowHeight="h-14" />;
  if (entries.length === 0) {
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
        {entries.map((e) => (
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
                  onClick={() => approve(e.id)}
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

function TimeOffTab({ onChange }: { onChange: () => void }) {
  const prompt = usePrompt();
  const [requests, setRequests] = useState<TeamTimeOffRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const refresh = async () => {
    try {
      setError(null);
      const res = await listTeamTimeOff('PENDING');
      setRequests(res.requests);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load.');
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const approve = async (id: string) => {
    setPendingId(id);
    try {
      await approveTeamTimeOff(id);
      toast.success('Approved');
      await refresh();
      onChange();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Approve failed');
    } finally {
      setPendingId(null);
    }
  };

  const deny = async (id: string) => {
    const note = (await prompt({
      title: 'Deny time-off request',
      reasonLabel: 'Reason for denial',
      confirmLabel: 'Deny',
      destructive: true,
    }))?.trim();
    if (!note) return;
    setPendingId(id);
    try {
      await denyTeamTimeOff(id, note);
      toast.success('Denied');
      await refresh();
      onChange();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Deny failed');
    } finally {
      setPendingId(null);
    }
  };

  if (error) return <p role="alert" className="text-sm text-alert">{error}</p>;
  if (!requests) return <SkeletonRows count={4} rowHeight="h-14" />;
  if (requests.length === 0) {
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
        {requests.map((r) => (
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
                  onClick={() => approve(r.id)}
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
