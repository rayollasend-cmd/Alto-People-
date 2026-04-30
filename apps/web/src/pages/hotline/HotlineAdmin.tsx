import { useEffect, useState } from 'react';
import { ShieldQuestion } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import {
  getHotlineSummary,
  getReportDetail,
  listReportQueue,
  postHrMessage,
  triageReport,
  type HotlineSummary,
  type HrReportDetail,
  type QueueReport,
  type ReportCategory,
  type ReportStatus,
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
  SkeletonRows,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui';
import { Label } from '@/components/ui/Label';

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

export function HotlineAdmin() {
  const [statusFilter, setStatusFilter] = useState<ReportStatus | 'ALL'>(
    'RECEIVED',
  );
  const [rows, setRows] = useState<QueueReport[] | null>(null);
  const [summary, setSummary] = useState<HotlineSummary | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const refresh = () => {
    setRows(null);
    listReportQueue(statusFilter === 'ALL' ? undefined : statusFilter)
      .then((r) => setRows(r.reports))
      .catch(() => setRows([]));
    getHotlineSummary()
      .then(setSummary)
      .catch(() => setSummary(null));
  };
  useEffect(() => {
    refresh();
  }, [statusFilter]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Hotline queue"
        subtitle="Anonymous reports filed via the public reporting page. Reporters see only your visible replies — internal notes stay HR-only."
        breadcrumbs={[{ label: 'Compliance' }, { label: 'Hotline' }]}
      />

      {summary && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
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
        <select
          className="text-xs bg-midnight border border-navy-secondary rounded p-1.5 text-white"
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
        </select>
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
                  <TableHead>Category</TableHead>
                  <TableHead>Subject</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Filed</TableHead>
                  <TableHead>Replies</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow
                    key={r.id}
                    className="cursor-pointer"
                    onClick={() => setOpenId(r.id)}
                  >
                    <TableCell className="font-mono text-xs">
                      {r.trackingCode}
                    </TableCell>
                    <TableCell className="text-sm">
                      {CATEGORY_LABELS[r.category]}
                    </TableCell>
                    <TableCell className="text-sm font-medium text-white">
                      {r.subject}
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[r.status]}>
                        {r.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-silver">
                      {new Date(r.createdAt).toLocaleDateString()}
                    </TableCell>
                    <TableCell className="text-sm">{r.updateCount}</TableCell>
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
          onSaved={() => {
            refresh();
          }}
        />
      )}
    </div>
  );
}

function SummaryCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'destructive' | 'pending' | 'accent' | 'success';
}) {
  const color = {
    destructive: 'text-red-300',
    pending: 'text-yellow-300',
    accent: 'text-blue-300',
    success: 'text-green-300',
  }[tone];
  return (
    <Card>
      <CardContent className="p-3">
        <div className="text-xs uppercase tracking-wider text-silver">
          {label}
        </div>
        <div className={`text-xl font-semibold mt-1 ${color}`}>{value}</div>
      </CardContent>
    </Card>
  );
}

function ReportDrawer({
  id,
  onClose,
  onSaved,
}: {
  id: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [report, setReport] = useState<HrReportDetail | null>(null);
  const [reply, setReply] = useState('');
  const [internalOnly, setInternalOnly] = useState(false);
  const [resolution, setResolution] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getReportDetail(id)
      .then((r) => {
        setReport(r.report);
        setResolution(r.report.resolution ?? '');
      })
      .catch(() => setReport(null));
  }, [id]);

  const setStatus = async (status: ReportStatus) => {
    setBusy(true);
    try {
      await triageReport(id, {
        status,
        resolution: status === 'RESOLVED' ? resolution.trim() || null : undefined,
      });
      const r = await getReportDetail(id);
      setReport(r.report);
      onSaved();
      toast.success(`Status: ${status}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    if (!reply.trim()) return;
    setBusy(true);
    try {
      await postHrMessage(id, reply.trim(), internalOnly);
      setReply('');
      const r = await getReportDetail(id);
      setReport(r.report);
      onSaved();
      toast.success(internalOnly ? 'Internal note saved.' : 'Reply sent.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setBusy(false);
    }
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
            <div className="flex items-center gap-2">
              <Badge variant={STATUS_VARIANT[report.status]}>
                {report.status}
              </Badge>
              <span className="text-xs text-silver">
                {CATEGORY_LABELS[report.category]} · Filed{' '}
                {new Date(report.createdAt).toLocaleString()}
              </span>
            </div>
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
              <textarea
                className="w-full mt-1 h-20 rounded-md border border-navy-secondary bg-midnight p-2 text-white text-sm"
                value={resolution}
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
                          ? 'bg-yellow-900/20 border border-yellow-700/30'
                          : u.isFromReporter
                          ? 'bg-blue-900/30 border border-blue-700/30'
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
              <textarea
                className="w-full h-24 rounded-md border border-navy-secondary bg-midnight p-2 text-white text-sm"
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
