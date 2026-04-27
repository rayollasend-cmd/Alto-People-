import { useEffect, useState } from 'react';
import { GraduationCap, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import {
  decideTuition,
  getTuitionSummary,
  listMyTuition,
  listTuitionQueue,
  payTuition,
  setTuitionGrade,
  submitTuitionRequest,
  type MyTuitionRequest,
  type QueueTuitionRequest,
  type TuitionStatus,
  type TuitionSummary,
} from '@/lib/tuition127Api';
import { useAuth } from '@/lib/auth';
import { hasCapability } from '@/lib/roles';
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
  Input,
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

const STATUS_VARIANT: Record<
  TuitionStatus,
  'pending' | 'success' | 'destructive' | 'accent'
> = {
  SUBMITTED: 'pending',
  APPROVED: 'accent',
  REJECTED: 'destructive',
  PAID: 'success',
};

export function TuitionHome() {
  const { user } = useAuth();
  const canProcessPayroll = user
    ? hasCapability(user.role, 'process:payroll')
    : false;
  const [tab, setTab] = useState<'mine' | 'queue'>('mine');
  const [mine, setMine] = useState<MyTuitionRequest[] | null>(null);
  const [queue, setQueue] = useState<QueueTuitionRequest[] | null>(null);
  const [summary, setSummary] = useState<TuitionSummary | null>(null);
  const [statusFilter, setStatusFilter] = useState<TuitionStatus | 'ALL'>(
    'SUBMITTED',
  );
  const [showNew, setShowNew] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [openMine, setOpenMine] = useState<MyTuitionRequest | null>(null);

  const refresh = () => {
    if (tab === 'mine') {
      setMine(null);
      listMyTuition()
        .then((r) => setMine(r.requests))
        .catch(() => setMine([]));
    } else {
      setQueue(null);
      listTuitionQueue(statusFilter === 'ALL' ? undefined : statusFilter)
        .then((r) => setQueue(r.requests))
        .catch(() => setQueue([]));
      getTuitionSummary()
        .then(setSummary)
        .catch(() => setSummary(null));
    }
  };
  useEffect(() => {
    refresh();
  }, [tab, statusFilter]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Tuition reimbursement"
        subtitle="Submit course expenses for reimbursement. After grades land, attach them to your request."
        breadcrumbs={[{ label: 'Time & Pay' }, { label: 'Tuition' }]}
      />

      <div className="flex items-center justify-between">
        <div className="flex gap-1">
          <Button
            size="sm"
            variant={tab === 'mine' ? 'primary' : 'ghost'}
            onClick={() => setTab('mine')}
          >
            My requests
          </Button>
          {canProcessPayroll && (
            <Button
              size="sm"
              variant={tab === 'queue' ? 'primary' : 'ghost'}
              onClick={() => setTab('queue')}
            >
              Queue
              {summary && summary.pendingCount > 0 && (
                <Badge variant="destructive" className="ml-2">
                  {summary.pendingCount}
                </Badge>
              )}
            </Button>
          )}
        </div>
        <div className="flex gap-2">
          {canProcessPayroll && tab === 'queue' && (
            <select
              className="text-xs bg-midnight border border-navy-secondary rounded p-1.5 text-white"
              value={statusFilter}
              onChange={(e) =>
                setStatusFilter(e.target.value as TuitionStatus | 'ALL')
              }
            >
              <option value="ALL">All statuses</option>
              <option value="SUBMITTED">Submitted</option>
              <option value="APPROVED">Approved</option>
              <option value="REJECTED">Rejected</option>
              <option value="PAID">Paid</option>
            </select>
          )}
          {tab === 'mine' && (
            <Button onClick={() => setShowNew(true)}>
              <Plus className="mr-2 h-4 w-4" /> New request
            </Button>
          )}
        </div>
      </div>

      {tab === 'queue' && summary && (
        <div className="grid grid-cols-3 gap-3">
          <Card>
            <CardContent className="p-3">
              <div className="text-xs uppercase tracking-wider text-silver">
                Pending
              </div>
              <div className="text-xl font-semibold text-white mt-1">
                {summary.pendingCount}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3">
              <div className="text-xs uppercase tracking-wider text-silver">
                Approved (awaiting pay)
              </div>
              <div className="text-xl font-semibold text-white mt-1">
                {summary.approvedAwaitingPayment}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3">
              <div className="text-xs uppercase tracking-wider text-silver">
                Paid YTD
              </div>
              <div className="text-xl font-semibold text-white mt-1">
                ${summary.paidYtdAmount}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {tab === 'mine' ? (
        <Card>
          <CardContent className="p-0">
            {mine === null ? (
              <div className="p-6">
                <SkeletonRows count={3} />
              </div>
            ) : mine.length === 0 ? (
              <EmptyState
                icon={GraduationCap}
                title="No requests yet"
                description="Submit your first request once you have a receipt."
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Course</TableHead>
                    <TableHead>School</TableHead>
                    <TableHead>Term</TableHead>
                    <TableHead>Amount</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Grade</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {mine.map((r) => (
                    <TableRow
                      key={r.id}
                      className="cursor-pointer"
                      onClick={() => setOpenMine(r)}
                    >
                      <TableCell className="font-medium text-white">
                        {r.courseName}
                      </TableCell>
                      <TableCell className="text-sm">
                        {r.schoolName}
                        {r.programName && (
                          <div className="text-xs text-silver">
                            {r.programName}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-silver">
                        {r.termStartDate} → {r.termEndDate}
                      </TableCell>
                      <TableCell className="text-sm">
                        {r.currency} {r.amount}
                      </TableCell>
                      <TableCell>
                        <Badge variant={STATUS_VARIANT[r.status]}>
                          {r.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm">
                        {r.gradeReceived ?? (
                          <span className="text-silver">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            {queue === null ? (
              <div className="p-6">
                <SkeletonRows count={4} />
              </div>
            ) : queue.length === 0 ? (
              <EmptyState
                icon={GraduationCap}
                title="Queue is empty"
                description="Nothing pending."
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Associate</TableHead>
                    <TableHead>Course</TableHead>
                    <TableHead>School</TableHead>
                    <TableHead>Amount</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Grade</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {queue.map((r) => (
                    <TableRow
                      key={r.id}
                      className="cursor-pointer"
                      onClick={() => setOpenId(r.id)}
                    >
                      <TableCell>
                        <div className="font-medium text-white">
                          {r.associateName}
                        </div>
                        <div className="text-xs text-silver">
                          {r.associateEmail}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm">{r.courseName}</TableCell>
                      <TableCell className="text-sm">{r.schoolName}</TableCell>
                      <TableCell className="text-sm">
                        {r.currency} {r.amount}
                      </TableCell>
                      <TableCell>
                        <Badge variant={STATUS_VARIANT[r.status]}>
                          {r.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm">
                        {r.gradeReceived ?? (
                          <span className="text-silver">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}

      {showNew && (
        <NewRequestDrawer
          onClose={() => setShowNew(false)}
          onSaved={() => {
            setShowNew(false);
            refresh();
          }}
        />
      )}
      {openMine && (
        <MyDetailDrawer
          row={openMine}
          onClose={() => setOpenMine(null)}
          onSaved={() => {
            setOpenMine(null);
            refresh();
          }}
        />
      )}
      {openId && queue && (
        <QueueDetailDrawer
          row={queue.find((q) => q.id === openId)!}
          onClose={() => setOpenId(null)}
          onSaved={() => {
            setOpenId(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function NewRequestDrawer({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [schoolName, setSchoolName] = useState('');
  const [programName, setProgramName] = useState('');
  const [courseName, setCourseName] = useState('');
  const today = new Date().toISOString().slice(0, 10);
  const [termStartDate, setTermStartDate] = useState(today);
  const [termEndDate, setTermEndDate] = useState(today);
  const [amount, setAmount] = useState('');
  const [receiptUrl, setReceiptUrl] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!schoolName.trim() || !courseName.trim() || !amount) {
      toast.error('School, course, and amount required.');
      return;
    }
    setSaving(true);
    try {
      await submitTuitionRequest({
        schoolName: schoolName.trim(),
        programName: programName.trim() || null,
        courseName: courseName.trim(),
        termStartDate,
        termEndDate,
        amount: parseFloat(amount),
        receiptUrl: receiptUrl.trim() || null,
      });
      toast.success('Submitted.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>New tuition request</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>School</Label>
          <Input
            className="mt-1"
            value={schoolName}
            onChange={(e) => setSchoolName(e.target.value)}
          />
        </div>
        <div>
          <Label>Program (optional)</Label>
          <Input
            className="mt-1"
            value={programName}
            onChange={(e) => setProgramName(e.target.value)}
            placeholder="e.g. MS Computer Science"
          />
        </div>
        <div>
          <Label>Course</Label>
          <Input
            className="mt-1"
            value={courseName}
            onChange={(e) => setCourseName(e.target.value)}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Term start</Label>
            <Input
              type="date"
              className="mt-1"
              value={termStartDate}
              onChange={(e) => setTermStartDate(e.target.value)}
            />
          </div>
          <div>
            <Label>Term end</Label>
            <Input
              type="date"
              className="mt-1"
              value={termEndDate}
              onChange={(e) => setTermEndDate(e.target.value)}
            />
          </div>
        </div>
        <div>
          <Label>Amount (USD)</Label>
          <Input
            type="number"
            min="0"
            step="0.01"
            className="mt-1"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
        <div>
          <Label>Receipt URL</Label>
          <Input
            type="url"
            className="mt-1"
            value={receiptUrl}
            onChange={(e) => setReceiptUrl(e.target.value)}
            placeholder="https://…"
          />
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={saving}>
          {saving ? 'Submitting…' : 'Submit'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

function MyDetailDrawer({
  row,
  onClose,
  onSaved,
}: {
  row: MyTuitionRequest;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [grade, setGrade] = useState(row.gradeReceived ?? '');
  const [busy, setBusy] = useState(false);

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>{row.courseName}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div className="flex items-center gap-2">
          <Badge variant={STATUS_VARIANT[row.status]}>{row.status}</Badge>
          <span className="text-sm text-silver">
            {row.currency} {row.amount}
          </span>
        </div>
        <div className="text-sm text-white">
          {row.schoolName}
          {row.programName && ` · ${row.programName}`}
        </div>
        <div className="text-xs text-silver">
          Term {row.termStartDate} → {row.termEndDate}
        </div>
        {row.receiptUrl && (
          <a
            href={row.receiptUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-blue-300 hover:underline"
          >
            Receipt ↗
          </a>
        )}
        {row.reviewerNotes && (
          <div className="text-sm text-silver italic p-3 rounded border border-navy-secondary">
            HR: {row.reviewerNotes}
          </div>
        )}
        {row.status !== 'REJECTED' && (
          <div className="space-y-2 pt-2 border-t border-navy-secondary">
            <Label>Grade received</Label>
            <Input
              className="max-w-[120px]"
              value={grade}
              onChange={(e) => setGrade(e.target.value)}
              placeholder="A, B+, P/F…"
            />
            <Button
              size="sm"
              onClick={async () => {
                if (!grade.trim()) return;
                setBusy(true);
                try {
                  await setTuitionGrade(row.id, grade.trim());
                  toast.success('Grade saved.');
                  onSaved();
                } catch (err) {
                  toast.error(
                    err instanceof ApiError ? err.message : 'Failed.',
                  );
                } finally {
                  setBusy(false);
                }
              }}
              disabled={busy || !grade.trim()}
            >
              Save grade
            </Button>
          </div>
        )}
      </DrawerBody>
      <DrawerFooter>
        <Button onClick={onClose}>Close</Button>
      </DrawerFooter>
    </Drawer>
  );
}

function QueueDetailDrawer({
  row,
  onClose,
  onSaved,
}: {
  row: QueueTuitionRequest;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [notes, setNotes] = useState(row.reviewerNotes ?? '');
  const [busy, setBusy] = useState(false);

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>
          {row.associateName} — {row.courseName}
        </DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div className="flex items-center gap-2">
          <Badge variant={STATUS_VARIANT[row.status]}>{row.status}</Badge>
          <span className="text-sm text-silver">
            {row.currency} {row.amount}
          </span>
        </div>
        <div className="text-sm text-white">
          {row.schoolName}
          {row.programName && ` · ${row.programName}`}
        </div>
        <div className="text-xs text-silver">
          Term {row.termStartDate} → {row.termEndDate}
        </div>
        {row.receiptUrl && (
          <a
            href={row.receiptUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-blue-300 hover:underline"
          >
            Receipt ↗
          </a>
        )}
        {row.gradeReceived && (
          <div className="text-sm">
            <span className="text-silver">Grade: </span>
            <span className="text-white font-semibold">{row.gradeReceived}</span>
          </div>
        )}

        {row.status === 'SUBMITTED' && (
          <div className="space-y-2 pt-2 border-t border-navy-secondary">
            <Label>Reviewer notes</Label>
            <textarea
              className="w-full h-24 rounded-md border border-navy-secondary bg-midnight p-2 text-white text-sm"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={async () => {
                  setBusy(true);
                  try {
                    await decideTuition(row.id, 'APPROVED', notes.trim());
                    toast.success('Approved.');
                    onSaved();
                  } catch (err) {
                    toast.error(
                      err instanceof ApiError ? err.message : 'Failed.',
                    );
                  } finally {
                    setBusy(false);
                  }
                }}
                disabled={busy}
              >
                Approve
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onClick={async () => {
                  setBusy(true);
                  try {
                    await decideTuition(row.id, 'REJECTED', notes.trim());
                    toast.success('Rejected.');
                    onSaved();
                  } catch (err) {
                    toast.error(
                      err instanceof ApiError ? err.message : 'Failed.',
                    );
                  } finally {
                    setBusy(false);
                  }
                }}
                disabled={busy}
              >
                Reject
              </Button>
            </div>
          </div>
        )}
        {row.status === 'APPROVED' && (
          <div className="pt-2 border-t border-navy-secondary">
            <Button
              onClick={async () => {
                setBusy(true);
                try {
                  await payTuition(row.id);
                  toast.success('Marked paid.');
                  onSaved();
                } catch (err) {
                  toast.error(err instanceof ApiError ? err.message : 'Failed.');
                } finally {
                  setBusy(false);
                }
              }}
              disabled={busy}
            >
              Mark paid
            </Button>
          </div>
        )}
        {row.reviewerNotes && row.status !== 'SUBMITTED' && (
          <div className="text-sm text-silver italic">
            Reviewer: {row.reviewerNotes}
          </div>
        )}
      </DrawerBody>
      <DrawerFooter>
        <Button onClick={onClose}>Close</Button>
      </DrawerFooter>
    </Drawer>
  );
}
