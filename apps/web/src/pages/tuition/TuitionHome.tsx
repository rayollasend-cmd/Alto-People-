import { useEffect, useState } from 'react';
import { safeHref } from '@alto-people/shared';
import { GraduationCap, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { downloadCsv } from '@/lib/csv';
import { fmtDate, fmtMoney, parseYmd, ymdLocal } from '@/lib/format';
import { useConfirm } from '@/lib/confirm';
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
import { StatusBadge, statusLabel } from '@/lib/status';
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
  ErrorBanner,
  Input,
  MetricCard,
  PageHeader,
  SearchInput,
  SegmentedControl,
  type SegmentedControlOption,
  Select,
  SkeletonRows,
  Textarea,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui';
import { Label } from '@/components/ui/Label';

const GRADE_OPTIONS = [
  'A',
  'A-',
  'B+',
  'B',
  'B-',
  'C+',
  'C',
  'C-',
  'D',
  'F',
  'P',
  'NP',
  'Incomplete',
] as const;

/** Shared load-failure block: message + Retry. Never fake an empty state. */
function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="p-6">
      <ErrorBanner
        action={
          <Button size="sm" variant="secondary" onClick={onRetry}>
            Retry
          </Button>
        }
      >
        {message}
      </ErrorBanner>
    </div>
  );
}

export function TuitionHome() {
  const { user } = useAuth();
  const canProcessPayroll = user
    ? hasCapability(user.role, 'process:payroll')
    : false;
  const confirm = useConfirm();
  const [tab, setTab] = useState<'mine' | 'queue'>('mine');
  const [mine, setMine] = useState<MyTuitionRequest[] | null>(null);
  const [mineError, setMineError] = useState<string | null>(null);
  const [queue, setQueue] = useState<QueueTuitionRequest[] | null>(null);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [summary, setSummary] = useState<TuitionSummary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<TuitionStatus | 'ALL'>(
    'SUBMITTED',
  );
  const [queueSearch, setQueueSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [openMine, setOpenMine] = useState<MyTuitionRequest | null>(null);

  const refresh = () => {
    if (tab === 'mine') {
      setMine(null);
      setMineError(null);
      listMyTuition()
        .then((r) => setMine(r.requests))
        .catch((err) =>
          setMineError(
            err instanceof ApiError ? err.message : 'Could not load your requests.',
          ),
        );
    } else {
      setQueue(null);
      setQueueError(null);
      setSelected(new Set());
      listTuitionQueue(statusFilter === 'ALL' ? undefined : statusFilter)
        .then((r) => setQueue(r.requests))
        .catch((err) =>
          setQueueError(
            err instanceof ApiError ? err.message : 'Could not load the queue.',
          ),
        );
    }
  };
  // Filter-independent KPI summary — fetched once on mount and re-fetched
  // explicitly after mutations, never on tab/filter clicks.
  const refreshSummary = () => {
    setSummaryError(null);
    getTuitionSummary()
      .then(setSummary)
      .catch((err) => {
        setSummary(null);
        setSummaryError(
          err instanceof ApiError ? err.message : 'Could not load the summary.',
        );
      });
  };
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, statusFilter]);
  useEffect(() => {
    if (canProcessPayroll) refreshSummary();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canProcessPayroll]);

  // If the open queue row vanished after a refetch (decided elsewhere,
  // filter changed), close the drawer instead of crashing on a missing row.
  useEffect(() => {
    if (openId && queue && !queue.some((q) => q.id === openId)) {
      setOpenId(null);
    }
  }, [openId, queue]);

  const qSearch = queueSearch.trim().toLowerCase();
  const filteredQueue = (queue ?? []).filter(
    (r) =>
      !qSearch ||
      r.associateName.toLowerCase().includes(qSearch) ||
      r.schoolName.toLowerCase().includes(qSearch),
  );
  const openRow = openId ? (queue?.find((q) => q.id === openId) ?? null) : null;

  // Bulk approve targets only SUBMITTED rows — the only decidable state.
  const selectableIds = filteredQueue
    .filter((r) => r.status === 'SUBMITTED')
    .map((r) => r.id);
  const allSelected =
    selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));

  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // The queue segment only exists for payroll processors; building the
  // option list up front keeps the conditional out of the JSX and the
  // generic parameter explicit (inference would otherwise narrow to 'mine').
  const tabOptions: SegmentedControlOption<'mine' | 'queue'>[] = [
    { value: 'mine', label: 'My requests' },
  ];
  if (canProcessPayroll) {
    tabOptions.push({
      value: 'queue',
      label: (
        <>
          Queue
          {summary && summary.pendingCount > 0 && (
            <Badge variant="destructive" className="ml-2">
              {summary.pendingCount}
            </Badge>
          )}
        </>
      ),
    });
  }

  const exportQueueCsv = () => {
    downloadCsv(`tuition-queue-${ymdLocal()}.csv`, [
      [
        'Associate',
        'Email',
        'School',
        'Program',
        'Course',
        'Term start',
        'Term end',
        'Amount',
        'Currency',
        'Status',
        'Grade',
        'Reviewer notes',
      ],
      ...filteredQueue.map((r) => [
        r.associateName,
        r.associateEmail,
        r.schoolName,
        r.programName ?? '',
        r.courseName,
        r.termStartDate,
        r.termEndDate,
        r.amount,
        r.currency,
        statusLabel(r.status),
        r.gradeReceived ?? '',
        r.reviewerNotes ?? '',
      ]),
    ]);
  };

  const bulkApprove = async () => {
    const ids = selectableIds.filter((id) => selected.has(id));
    if (ids.length === 0) return;
    if (
      !(await confirm({
        title: `Approve ${ids.length} request${ids.length === 1 ? '' : 's'}?`,
        description:
          'Each selected request will be approved and the associate notified.',
        confirmLabel: 'Approve all',
      }))
    )
      return;
    setBulkBusy(true);
    try {
      const results = await Promise.allSettled(
        ids.map((id) => decideTuition(id, 'APPROVED')),
      );
      const failed = results.filter((r) => r.status === 'rejected').length;
      const ok = results.length - failed;
      if (failed === 0) {
        toast.success(`Approved ${ok} request${ok === 1 ? '' : 's'}.`);
      } else if (ok === 0) {
        toast.error(
          `Could not approve ${failed} request${failed === 1 ? '' : 's'}.`,
        );
      } else {
        toast.error(`Approved ${ok}; ${failed} failed.`);
      }
      refresh();
      if (canProcessPayroll) refreshSummary();
    } finally {
      setBulkBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Tuition reimbursement"
        subtitle="Submit course expenses for reimbursement. After grades land, attach them to your request."
        breadcrumbs={[{ label: 'Time & Pay' }, { label: 'Tuition' }]}
      />

      <div className="flex items-center justify-between">
        <SegmentedControl<'mine' | 'queue'>
          ariaLabel="Tuition view"
          value={tab}
          onChange={setTab}
          options={tabOptions}
        />
        <div className="flex gap-2">
          {canProcessPayroll && tab === 'queue' && (
            <Select
              size="sm"
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
            </Select>
          )}
          {tab === 'mine' && (
            <Button onClick={() => setShowNew(true)}>
              <Plus className="mr-2 h-4 w-4" /> New request
            </Button>
          )}
        </div>
      </div>

      {tab === 'queue' && summaryError && (
        <ErrorBanner
          action={
            <Button size="sm" variant="secondary" onClick={refreshSummary}>
              Retry
            </Button>
          }
        >
          {summaryError}
        </ErrorBanner>
      )}
      {tab === 'queue' && summary && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <MetricCard label="Pending" value={summary.pendingCount} accent />
          <MetricCard
            label="Approved (awaiting pay)"
            value={summary.approvedAwaitingPayment}
          />
          <MetricCard label="Paid YTD" value={fmtMoney(summary.paidYtdAmount)} />
        </div>
      )}

      {tab === 'mine' ? (
        <Card>
          <CardContent className="p-0">
            {mineError ? (
              <LoadError message={mineError} onRetry={refresh} />
            ) : mine === null ? (
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
                    <TableHead className="hidden md:table-cell">School</TableHead>
                    <TableHead className="hidden lg:table-cell">Term</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="hidden md:table-cell">Grade</TableHead>
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
                        <div className="md:hidden text-xs2 text-silver/70 truncate font-normal">
                          {r.schoolName}{r.gradeReceived ? ` · ${r.gradeReceived}` : ''}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm hidden md:table-cell">
                        {r.schoolName}
                        {r.programName && (
                          <div className="text-xs text-silver">
                            {r.programName}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-silver hidden lg:table-cell">
                        {fmtDate(parseYmd(r.termStartDate))} → {fmtDate(parseYmd(r.termEndDate))}
                      </TableCell>
                      <TableCell className="text-sm text-right tabular-nums">
                        {fmtMoney(r.amount, { currency: r.currency })}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={r.status} />
                      </TableCell>
                      <TableCell className="text-sm hidden md:table-cell">
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
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput
              className="h-8"
              wrapperClassName="w-64 max-w-full"
              placeholder="Search associate or school…"
              value={queueSearch}
              onChange={(e) => setQueueSearch(e.target.value)}
              aria-label="Search queue by associate or school"
            />
            <Button
              size="sm"
              variant="secondary"
              className="ml-auto"
              onClick={exportQueueCsv}
              disabled={filteredQueue.length === 0}
            >
              Export CSV
            </Button>
            <Button
              size="sm"
              onClick={() => void bulkApprove()}
              disabled={bulkBusy || selected.size === 0}
              loading={bulkBusy}
            >
              Approve selected ({selected.size})
            </Button>
          </div>
          <Card>
            <CardContent className="p-0">
              {queueError ? (
                <LoadError message={queueError} onRetry={refresh} />
              ) : queue === null ? (
                <div className="p-6">
                  <SkeletonRows count={4} />
                </div>
              ) : queue.length === 0 ? (
                <EmptyState
                  icon={GraduationCap}
                  title="Queue is empty"
                  description="Nothing pending."
                />
              ) : filteredQueue.length === 0 ? (
                <EmptyState
                  icon={GraduationCap}
                  title="No matching requests"
                  description="Adjust the search or status filter."
                />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-8">
                        <input
                          type="checkbox"
                          aria-label="Select all pending requests"
                          checked={allSelected}
                          disabled={selectableIds.length === 0}
                          onChange={() =>
                            setSelected(
                              allSelected ? new Set() : new Set(selectableIds),
                            )
                          }
                        />
                      </TableHead>
                      <TableHead>Associate</TableHead>
                      <TableHead className="hidden md:table-cell">Course</TableHead>
                      <TableHead className="hidden lg:table-cell">School</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="hidden lg:table-cell">Grade</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredQueue.map((r) => (
                      <TableRow
                        key={r.id}
                        className="cursor-pointer"
                        onClick={() => setOpenId(r.id)}
                      >
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          {r.status === 'SUBMITTED' && (
                            <input
                              type="checkbox"
                              aria-label={`Select request from ${r.associateName}`}
                              checked={selected.has(r.id)}
                              onChange={() => toggleSelected(r.id)}
                            />
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="font-medium text-white">
                            {r.associateName}
                          </div>
                          <div className="text-xs text-silver">
                            {r.associateEmail}
                          </div>
                          <div className="md:hidden text-xs2 text-silver/70 truncate">
                            {r.courseName} · {r.schoolName}
                          </div>
                        </TableCell>
                        <TableCell className="text-sm hidden md:table-cell">{r.courseName}</TableCell>
                        <TableCell className="text-sm hidden lg:table-cell">{r.schoolName}</TableCell>
                        <TableCell className="text-sm text-right tabular-nums">
                          {fmtMoney(r.amount, { currency: r.currency })}
                        </TableCell>
                        <TableCell>
                          <StatusBadge status={r.status} />
                        </TableCell>
                        <TableCell className="text-sm hidden lg:table-cell">
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
        </div>
      )}

      {showNew && (
        <NewRequestDrawer
          onClose={() => setShowNew(false)}
          onSaved={() => {
            setShowNew(false);
            refresh();
            if (canProcessPayroll) refreshSummary();
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
            if (canProcessPayroll) refreshSummary();
          }}
        />
      )}
      {openRow && (
        <QueueDetailDrawer
          row={openRow}
          onClose={() => setOpenId(null)}
          onSaved={() => {
            setOpenId(null);
            refresh();
            if (canProcessPayroll) refreshSummary();
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
  const ymd = (d: Date) => {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  const plusMonths = (fromYmd: string, months: number) => {
    const [y, m, d] = fromYmd.split('-').map(Number);
    return ymd(new Date(y, (m ?? 1) - 1 + months, d ?? 1));
  };
  const today = ymd(new Date());
  const [termStartDate, setTermStartDate] = useState(today);
  // A term isn't one day long — default the end ~4 months out and keep it
  // tracking the start until the associate edits it themselves.
  const [termEndDate, setTermEndDate] = useState(plusMonths(today, 4));
  const [endTouched, setEndTouched] = useState(false);
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
      toast.success('Request submitted.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not submit the request.');
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
              onChange={(e) => {
                setTermStartDate(e.target.value);
                if (!endTouched && e.target.value) {
                  setTermEndDate(plusMonths(e.target.value, 4));
                }
              }}
            />
          </div>
          <div>
            <Label>Term end</Label>
            <Input
              type="date"
              className="mt-1"
              value={termEndDate}
              min={termStartDate || undefined}
              onChange={(e) => {
                setTermEndDate(e.target.value);
                setEndTouched(true);
              }}
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
          <StatusBadge status={row.status} />
          <span className="text-sm text-silver tabular-nums">
            {fmtMoney(row.amount, { currency: row.currency })}
          </span>
        </div>
        <div className="text-sm text-white">
          {row.schoolName}
          {row.programName && ` · ${row.programName}`}
        </div>
        <div className="text-xs text-silver">
          Term {fmtDate(parseYmd(row.termStartDate))} → {fmtDate(parseYmd(row.termEndDate))}
        </div>
        {row.receiptUrl && (
          <a
            href={safeHref(row.receiptUrl)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-steel hover:underline"
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
            <Label htmlFor="tuition-grade">Grade received</Label>
            <Select
              id="tuition-grade"
              size="sm"
              className="max-w-[160px]"
              value={grade}
              onChange={(e) => setGrade(e.target.value)}
            >
              <option value="">Select grade…</option>
              {/* Keep a legacy free-text value selectable so an existing
                  grade doesn't silently disappear from the picker. */}
              {row.gradeReceived &&
                !(GRADE_OPTIONS as readonly string[]).includes(row.gradeReceived) && (
                  <option value={row.gradeReceived}>{row.gradeReceived}</option>
                )}
              {GRADE_OPTIONS.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </Select>
            <Button
              size="sm"
              onClick={async () => {
                if (!grade) return;
                setBusy(true);
                try {
                  await setTuitionGrade(row.id, grade);
                  toast.success('Grade saved.');
                  onSaved();
                } catch (err) {
                  toast.error(
                    err instanceof ApiError ? err.message : 'Could not save the grade.',
                  );
                } finally {
                  setBusy(false);
                }
              }}
              disabled={busy || !grade}
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
          <StatusBadge status={row.status} />
          <span className="text-sm text-silver tabular-nums">
            {fmtMoney(row.amount, { currency: row.currency })}
          </span>
        </div>
        <div className="text-sm text-white">
          {row.schoolName}
          {row.programName && ` · ${row.programName}`}
        </div>
        <div className="text-xs text-silver">
          Term {fmtDate(parseYmd(row.termStartDate))} → {fmtDate(parseYmd(row.termEndDate))}
        </div>
        {row.receiptUrl && (
          <a
            href={safeHref(row.receiptUrl)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-steel hover:underline"
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
            <Textarea
              className="h-24"
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
                    toast.success('Request approved.');
                    onSaved();
                  } catch (err) {
                    toast.error(
                      err instanceof ApiError ? err.message : 'Could not approve the request.',
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
                    toast.success('Request rejected.');
                    onSaved();
                  } catch (err) {
                    toast.error(
                      err instanceof ApiError ? err.message : 'Could not reject the request.',
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
                  toast.error(
                    err instanceof ApiError ? err.message : 'Could not mark it paid.',
                  );
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
