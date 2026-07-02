import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Clock, ShieldQuestion } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import {
  getHotlineSummary,
  getReportDetail,
  listReportQueue,
  postHrMessage,
  triageReport,
  type ReportCategory,
  type ReportStatus,
  type SlaInfo,
} from '@/lib/anonReport128Api';
import {
  Badge,
  Button,
  Card,
  CardContent,
  Drawer,
  DrawerBody,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  EmptyState,
  PageHeader,
  Select,
  SkeletonRows,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from '@/components/ui';
import { Label } from '@/components/ui/Label';
import { fmtDate } from '@/lib/format';

const CATEGORY_LABELS: Record<ReportCategory, string> = {
  HARASSMENT: 'Harassment',
  DISCRIMINATION: 'Discrimination',
  ETHICS_VIOLATION: 'Ethics',
  FRAUD: 'Fraud',
  SAFETY: 'Safety',
  RETALIATION: 'Retaliation',
  OTHER: 'Other',
};

const STATUS_VARIANT: Record<
  ReportStatus,
  'pending' | 'accent' | 'success' | 'destructive' | 'outline'
> = {
  RECEIVED: 'destructive',
  TRIAGING: 'pending',
  INVESTIGATING: 'accent',
  RESOLVED: 'success',
  CLOSED: 'outline',
};

// Same namespace pattern as TeamHome: one wildcard for `['hotline']` so
// every mutation can invalidate the queue + summary + open detail in
// one go without enumerating sub-keys.
export const hotlineKeys = {
  all: ['hotline'] as const,
  queue: (status: ReportStatus | 'ALL') =>
    [...hotlineKeys.all, 'queue', status] as const,
  summary: () => [...hotlineKeys.all, 'summary'] as const,
  detail: (id: string) => [...hotlineKeys.all, 'detail', id] as const,
};

export function HotlineAdmin() {
  const [statusFilter, setStatusFilter] = useState<ReportStatus | 'ALL'>(
    'RECEIVED',
  );
  const [openId, setOpenId] = useState<string | null>(null);

  const queueQ = useQuery({
    queryKey: hotlineKeys.queue(statusFilter),
    queryFn: async () => {
      const res = await listReportQueue(
        statusFilter === 'ALL' ? undefined : statusFilter,
      );
      return res.reports;
    },
  });
  const summaryQ = useQuery({
    queryKey: hotlineKeys.summary(),
    queryFn: getHotlineSummary,
  });

  const rows = queueQ.data ?? null;
  const summary = summaryQ.data ?? null;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Hotline queue"
        subtitle="Anonymous reports filed via the public reporting page. Reporters see only your visible replies — internal notes stay HR-only."
        breadcrumbs={[{ label: 'Compliance' }, { label: 'Hotline' }]}
      />

      {summary && (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          <SummaryCard
            label="Overdue"
            value={summary.overdueCount}
            tone="destructive"
            icon={AlertTriangle}
          />
          <SummaryCard label="New" value={summary.newCount} tone="destructive" />
          <SummaryCard
            label="Triaging"
            value={summary.triagingCount}
            tone="pending"
          />
          <SummaryCard
            label="Investigating"
            value={summary.investigatingCount}
            tone="accent"
          />
          <SummaryCard
            label="Resolved"
            value={summary.resolvedCount}
            tone="success"
          />
        </div>
      )}

      <div className="flex justify-end">
        <Select
          size="sm"
          value={statusFilter}
          onChange={(e) =>
            setStatusFilter(e.target.value as ReportStatus | 'ALL')
          }
        >
          <option value="ALL">All statuses</option>
          <option value="RECEIVED">New</option>
          <option value="TRIAGING">Triaging</option>
          <option value="INVESTIGATING">Investigating</option>
          <option value="RESOLVED">Resolved</option>
          <option value="CLOSED">Closed</option>
        </Select>
      </div>

      <Card>
        <CardContent className="p-0">
          {rows === null ? (
            <div className="p-6">
              <SkeletonRows count={4} />
            </div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={ShieldQuestion}
              title="No reports"
              description="Nothing matches this filter."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tracking code</TableHead>
                  <TableHead className="hidden md:table-cell">Category</TableHead>
                  <TableHead>Subject</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>SLA</TableHead>
                  <TableHead className="hidden lg:table-cell">Filed</TableHead>
                  <TableHead className="hidden lg:table-cell">Replies</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow
                    key={r.id}
                    className={`cursor-pointer ${r.sla.isOverdue ? 'bg-alert/20' : ''}`}
                    onClick={() => setOpenId(r.id)}
                  >
                    <TableCell className="font-mono text-xs">
                      {r.trackingCode}
                    </TableCell>
                    <TableCell className="text-sm hidden md:table-cell">
                      {CATEGORY_LABELS[r.category]}
                    </TableCell>
                    <TableCell className="text-sm font-medium text-white">
                      {r.subject}
                      <div className="text-[11px] text-silver/70 md:hidden">
                        {CATEGORY_LABELS[r.category]}
                      </div>
                      <div className="text-[11px] text-silver/70 lg:hidden">
                        {fmtDate(r.createdAt)}
                        {r.updateCount > 0 ? ` · ${r.updateCount} repl.` : ''}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[r.status]}>
                        {r.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <SlaChip sla={r.sla} />
                    </TableCell>
                    <TableCell className="text-xs text-silver hidden lg:table-cell">
                      {fmtDate(r.createdAt)}
                    </TableCell>
                    <TableCell className="text-sm hidden lg:table-cell">{r.updateCount}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {openId && (
        <ReportDrawer
          id={openId}
          onClose={() => setOpenId(null)}
        />
      )}
    </div>
  );
}

function SummaryCard({
  label,
  value,
  tone,
  icon: Icon,
}: {
  label: string;
  value: number;
  tone: 'destructive' | 'pending' | 'accent' | 'success';
  icon?: typeof AlertTriangle;
}) {
  const color = {
    destructive: 'text-alert',
    pending: 'text-warning',
    accent: 'text-steel',
    success: 'text-success',
  }[tone];
  return (
    <Card>
      <CardContent className="p-3">
        <div className="flex items-center justify-between">
          <div className="text-xs uppercase tracking-wider text-silver">
            {label}
          </div>
          {Icon && <Icon className={`h-3.5 w-3.5 ${color}`} />}
        </div>
        <div className={`text-xl font-semibold mt-1 ${color}`}>{value}</div>
      </CardContent>
    </Card>
  );
}

function SlaChip({ sla }: { sla: SlaInfo }) {
  if (sla.isOverdue) {
    return (
      <Badge variant="destructive" className="gap-1">
        <AlertTriangle className="h-3 w-3" />
        Overdue · {sla.reason === 'unacked' ? 'no ack' : 'awaiting reply'}
      </Badge>
    );
  }
  const hoursLeft =
    sla.ackHoursLeft !== null
      ? sla.ackHoursLeft
      : sla.responseHoursLeft;
  if (hoursLeft === null) return null;
  const tone =
    hoursLeft < 24
      ? 'pending'
      : 'outline';
  const label =
    hoursLeft <= 0
      ? 'due now'
      : hoursLeft < 24
      ? `${hoursLeft}h left`
      : `${Math.round(hoursLeft / 24)}d left`;
  return (
    <Badge variant={tone} className="gap-1">
      <Clock className="h-3 w-3" />
      {label}
    </Badge>
  );
}

function ReportDrawer({
  id,
  onClose,
}: {
  id: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const detailQ = useQuery({
    queryKey: hotlineKeys.detail(id),
    queryFn: async () => (await getReportDetail(id)).report,
  });
  const report = detailQ.data ?? null;

  const [reply, setReply] = useState('');
  const [internalOnly, setInternalOnly] = useState(false);
  // Local-only resolution draft. We seed it from the loaded report on
  // first render but keep it as local state so the textarea isn't
  // overwritten while the user is typing during a background refetch.
  const [resolution, setResolution] = useState<string | null>(null);
  useEffect(() => {
    if (report && resolution === null) {
      setResolution(report.resolution ?? '');
    }
  }, [report, resolution]);

  // Invalidate detail + queue + summary together: every mutation
  // potentially shifts SLA, counts, and the row that's visible behind
  // the drawer.
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: hotlineKeys.all });
  };

  const triageM = useMutation({
    mutationFn: ({ status, resolutionText }: { status: ReportStatus; resolutionText?: string | null }) =>
      triageReport(id, {
        status,
        resolution: status === 'RESOLVED' ? resolutionText ?? null : undefined,
      }),
    onSuccess: (_data, vars) => {
      toast.success(`Status: ${vars.status}`);
      invalidate();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'Failed.'),
  });

  const messageM = useMutation({
    mutationFn: ({ body, internalOnly: io }: { body: string; internalOnly: boolean }) =>
      postHrMessage(id, body, io),
    onSuccess: (_data, vars) => {
      setReply('');
      toast.success(vars.internalOnly ? 'Internal note saved.' : 'Reply sent.');
      invalidate();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'Failed.'),
  });

  const busy = triageM.isPending || messageM.isPending;

  const setStatus = (status: ReportStatus) => {
    triageM.mutate({ status, resolutionText: (resolution ?? '').trim() || null });
  };

  const send = () => {
    if (!reply.trim()) return;
    messageM.mutate({ body: reply.trim(), internalOnly });
  };

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>{report?.subject ?? 'Loading…'}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        {!report ? (
          <SkeletonRows count={3} />
        ) : (
          <>
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant={STATUS_VARIANT[report.status]}>
                {report.status}
              </Badge>
              <SlaChip sla={report.sla} />
              <span className="text-xs text-silver">
                {CATEGORY_LABELS[report.category]} · Filed{' '}
                {new Date(report.createdAt).toLocaleString()}
              </span>
            </div>
            {report.sla.isOverdue && (
              <div className="rounded border border-alert/40 bg-alert/15 p-3 text-sm text-alert">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                  <div>
                    <div className="font-medium">
                      {report.sla.reason === 'unacked'
                        ? 'No HR acknowledgement within 3 days.'
                        : 'Reporter is waiting for a response.'}
                    </div>
                    <div className="text-xs mt-0.5 text-alert/80">
                      {report.sla.lastReporterAt &&
                        `Last reporter message: ${new Date(report.sla.lastReporterAt).toLocaleString()}`}
                    </div>
                  </div>
                </div>
              </div>
            )}
            <div className="text-xs text-silver">
              Tracking code:{' '}
              <span className="font-mono text-white">
                {report.trackingCode}
              </span>
            </div>
            {report.contactEmail && (
              <div className="text-sm">
                <span className="text-silver">Reporter contact: </span>
                <span className="text-white">{report.contactEmail}</span>
              </div>
            )}
            <div className="rounded border border-navy-secondary p-3">
              <div className="text-xs text-silver mb-1">Original report</div>
              <div className="text-sm text-white whitespace-pre-wrap">
                {report.description}
              </div>
            </div>

            <div>
              <Label>Status</Label>
              <div className="flex flex-wrap gap-2 mt-1">
                {(
                  [
                    'RECEIVED',
                    'TRIAGING',
                    'INVESTIGATING',
                    'RESOLVED',
                    'CLOSED',
                  ] as ReportStatus[]
                ).map((s) => (
                  <Button
                    key={s}
                    size="sm"
                    variant={report.status === s ? 'primary' : 'ghost'}
                    onClick={() => setStatus(s)}
                    disabled={busy || report.status === s}
                  >
                    {s}
                  </Button>
                ))}
              </div>
            </div>

            <div>
              <Label>Resolution summary</Label>
              <Textarea
                className="mt-1 h-20"
                value={resolution ?? ''}
                onChange={(e) => setResolution(e.target.value)}
                placeholder="Saved when status moves to RESOLVED. Visible to the reporter."
              />
            </div>

            <div>
              <div className="text-sm font-medium mb-2">Conversation</div>
              <div className="space-y-2">
                {report.updates.length === 0 ? (
                  <div className="text-xs text-silver italic">
                    No messages yet.
                  </div>
                ) : (
                  report.updates.map((u) => (
                    <div
                      key={u.id}
                      className={`rounded p-3 text-sm ${
                        u.internalOnly
                          ? 'bg-warning/10 border border-warning/30'
                          : u.isFromReporter
                          ? 'bg-steel/15 border border-steel/30'
                          : 'bg-navy-secondary'
                      }`}
                    >
                      <div className="text-xs text-silver mb-1 flex items-center gap-2">
                        <span>
                          {u.isFromReporter
                            ? 'Reporter'
                            : u.authorEmail ?? 'HR'}
                        </span>
                        {u.internalOnly && (
                          <Badge variant="outline" className="text-[10px]">
                            INTERNAL
                          </Badge>
                        )}
                        <span>· {new Date(u.createdAt).toLocaleString()}</span>
                      </div>
                      <div className="text-white whitespace-pre-wrap">
                        {u.body}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="space-y-2 pt-3 border-t border-navy-secondary">
              <Label>Add message</Label>
              <Textarea
                className="h-24"
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                placeholder={
                  internalOnly
                    ? "HR-only note. Reporter never sees this."
                    : "Reply to the reporter. They will see this when they look up the code."
                }
              />
              <label className="flex items-center gap-2 text-xs text-silver">
                <input
                  type="checkbox"
                  checked={internalOnly}
                  onChange={(e) => setInternalOnly(e.target.checked)}
                />
                Internal note (HR-only — reporter cannot see)
              </label>
              <Button onClick={send} disabled={busy || !reply.trim()} size="sm">
                {internalOnly ? 'Save internal note' : 'Send to reporter'}
              </Button>
            </div>
          </>
        )}
      </DrawerBody>
      <DrawerFooter>
        <Button onClick={onClose}>Close</Button>
      </DrawerFooter>
    </Drawer>
  );
}
