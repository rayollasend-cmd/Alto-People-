import { useEffect, useState } from 'react';
import { Download, Plus, Receipt, Trash2 } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { downloadCsv } from '@/lib/csv';
import { fmtDate, fmtMoney, parseYmd, ymdLocal } from '@/lib/format';
import {
  addExpenseLine,
  createReimbursement,
  deleteExpenseLine,
  getReimbursement,
  listReimbursements,
  managerApproveReimbursement,
  RECOMMENDED_CATEGORIES,
  rejectReimbursement,
  settleReimbursement,
  submitReimbursement,
  type ExpenseLineKind,
  type ReimbursementFull,
  type ReimbursementStatus,
  type ReimbursementSummary,
} from '@/lib/reimbursements97Api';
import { useAuth } from '@/lib/auth';
import { useConfirm, usePrompt } from '@/lib/confirm';
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
import { FormHint, Label } from '@/components/ui/Label';
import { toast } from 'sonner';

const STATUS_BADGE: Record<ReimbursementStatus, 'pending' | 'accent' | 'success' | 'destructive' | 'default'> = {
  DRAFT: 'default',
  SUBMITTED: 'pending',
  MANAGER_APPROVED: 'pending',
  SETTLED: 'accent',
  REJECTED: 'destructive',
  PAID: 'success',
};

const STATUS_LABEL: Record<ReimbursementStatus, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted',
  MANAGER_APPROVED: 'Manager approved',
  SETTLED: 'Settled — queued',
  REJECTED: 'Rejected',
  PAID: 'Paid',
};

const KIND_LABEL: Record<ExpenseLineKind, string> = {
  RECEIPT: 'Receipt',
  MILEAGE: 'Mileage',
  PER_DIEM: 'Per diem',
  OTHER: 'Other',
};

export function ReimbursementsHome() {
  const { user } = useAuth();
  const canApprove = user ? hasCapability(user.role, 'approve:reimbursement') : false;
  const canSettle = user ? hasCapability(user.role, 'settle:reimbursement') : false;
  const [rows, setRows] = useState<ReimbursementSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [active, setActive] = useState<ReimbursementSummary | null>(null);
  const [statusFilter, setStatusFilter] = useState<ReimbursementStatus | 'ALL'>('ALL');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  const refresh = () => {
    setRows(null);
    setLoadError(null);
    setSelected(new Set());
    listReimbursements()
      .then((r) => setRows(r.reimbursements))
      .catch(() => setLoadError('Failed to load reimbursements.'));
  };
  useEffect(() => {
    refresh();
  }, []);

  const q = search.trim().toLowerCase();
  const visible = (rows ?? []).filter(
    (r) =>
      (statusFilter === 'ALL' || r.status === statusFilter) &&
      (!q ||
        r.associateName.toLowerCase().includes(q) ||
        r.title.toLowerCase().includes(q)),
  );
  const pending = (rows ?? []).filter(
    (r) => r.status === 'SUBMITTED' || r.status === 'MANAGER_APPROVED',
  );
  const pendingTotal = pending.reduce((s, r) => s + Number(r.totalAmount), 0);

  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const onBulkApprove = async () => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    setBulkBusy(true);
    const results = await Promise.allSettled(
      ids.map((id) => managerApproveReimbursement(id)),
    );
    setBulkBusy(false);
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.length - ok;
    if (ok > 0) toast.success(`Approved ${ok} report${ok === 1 ? '' : 's'}.`);
    if (failed > 0) toast.error(`${failed} approval${failed === 1 ? '' : 's'} failed.`);
    refresh();
  };

  const onExportCsv = () => {
    downloadCsv(`reimbursements-${ymdLocal()}.csv`, [
      ['Title', 'Submitter', 'Status', 'Lines', 'Total', 'Currency', 'Submitted'],
      ...visible.map((r) => [
        r.title,
        r.associateName,
        STATUS_LABEL[r.status],
        r.lineCount,
        Number(r.totalAmount).toFixed(2),
        r.currency,
        r.submittedAt ? fmtDate(r.submittedAt) : '',
      ]),
    ]);
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Reimbursements"
        subtitle="Submit, approve, and pay associate expense reports."
        breadcrumbs={[{ label: 'Payroll' }, { label: 'Spend' }]}
      />
      <div className="flex flex-wrap items-center gap-3">
        <div className="text-sm text-silver">
          Total pending:{' '}
          <span className="font-medium text-white">{fmtMoney(pendingTotal)}</span>{' '}
          across {pending.length} report{pending.length === 1 ? '' : 's'}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {canApprove && (
            <Button
              size="sm"
              variant="secondary"
              onClick={onBulkApprove}
              disabled={bulkBusy || selected.size === 0}
            >
              {bulkBusy
                ? 'Approving…'
                : `Approve selected (${selected.size})`}
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={onExportCsv} disabled={visible.length === 0}>
            <Download className="mr-2 h-4 w-4" /> Export CSV
          </Button>
          <Button onClick={() => setShowNew(true)}>
            <Plus className="mr-2 h-4 w-4" /> New report
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {(
          ['ALL', ...(Object.keys(STATUS_LABEL) as ReimbursementStatus[])] as (
            | 'ALL'
            | ReimbursementStatus
          )[]
        ).map(
          (s) => (
            <Button
              key={s}
              type="button"
              size="xs"
              variant={statusFilter === s ? 'primary' : 'secondary'}
              className="rounded-full"
              aria-pressed={statusFilter === s}
              onClick={() => setStatusFilter(s)}
            >
              {s === 'ALL' ? 'All' : STATUS_LABEL[s]}
            </Button>
          ),
        )}
        <Input
          className="ml-auto w-56"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search associate or title…"
          aria-label="Search reimbursements"
        />
      </div>
      <Card>
        <CardContent className="p-0">
          {loadError ? (
            <div className="p-6 space-y-3">
              <p role="alert" className="text-sm text-alert">
                {loadError}
              </p>
              <Button size="sm" variant="secondary" onClick={refresh}>
                Retry
              </Button>
            </div>
          ) : rows === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={Receipt}
              title="No reimbursements"
              description="Submit your first expense report to get started."
            />
          ) : visible.length === 0 ? (
            <div className="p-6 text-sm text-silver">
              No reports match the current filters.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  {canApprove && <TableHead className="w-8"></TableHead>}
                  <TableHead>Title</TableHead>
                  <TableHead className="hidden md:table-cell">Submitter</TableHead>
                  <TableHead className="hidden lg:table-cell">Lines</TableHead>
                  <TableHead>Total</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden md:table-cell">Submitted</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((r) => (
                  <TableRow
                    key={r.id}
                    className="cursor-pointer"
                    onClick={() => setActive(r)}
                  >
                    {canApprove && (
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        {r.status === 'SUBMITTED' && (
                          <input
                            type="checkbox"
                            aria-label={`Select ${r.title} for bulk approval`}
                            checked={selected.has(r.id)}
                            onChange={() => toggleSelected(r.id)}
                          />
                        )}
                      </TableCell>
                    )}
                    <TableCell className="font-medium text-white">
                      {r.title}
                      <div className="text-[11px] text-silver/70 md:hidden">
                        {r.associateName}
                        {r.submittedAt && ` · ${fmtDate(r.submittedAt)}`}
                      </div>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">{r.associateName}</TableCell>
                    <TableCell className="hidden lg:table-cell">{r.lineCount}</TableCell>
                    <TableCell>
                      {fmtMoney(r.totalAmount, { currency: r.currency })}
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_BADGE[r.status]}>{STATUS_LABEL[r.status]}</Badge>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      {fmtDate(r.submittedAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {showNew && (
        <NewReportDrawer
          onClose={() => setShowNew(false)}
          onSaved={() => {
            setShowNew(false);
            refresh();
          }}
        />
      )}
      {active && (
        <ReimbursementDrawer
          summary={active}
          canApprove={canApprove}
          canSettle={canSettle}
          onClose={() => setActive(null)}
          onChanged={refresh}
        />
      )}
    </div>
  );
}

function NewReportDrawer({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);

  const onSubmit = async () => {
    if (!title.trim()) {
      toast.error('Title required.');
      return;
    }
    setSaving(true);
    try {
      await createReimbursement({
        title: title.trim(),
        description: description.trim() || null,
      });
      toast.success('Draft created.');
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
        <DrawerTitle>New expense report</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>Title</Label>
          <Input
            className="mt-1"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="2026-04 client travel"
          />
        </div>
        <div>
          <Label>Description</Label>
          <Textarea
            className="mt-1"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={onSubmit} disabled={saving}>
          {saving ? 'Saving…' : 'Create draft'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

function ReimbursementDrawer({
  summary,
  canApprove,
  canSettle,
  onClose,
  onChanged,
}: {
  summary: ReimbursementSummary;
  canApprove: boolean;
  canSettle: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const prompt = usePrompt();
  const confirm = useConfirm();
  const [data, setData] = useState<ReimbursementFull | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showAddLine, setShowAddLine] = useState(false);
  const [showSettle, setShowSettle] = useState(false);

  const refresh = () => {
    setLoadError(null);
    getReimbursement(summary.id)
      .then(setData)
      .catch(() => setLoadError('Failed to load this reimbursement.'));
  };
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summary.id]);

  const onSubmit = async () => {
    try {
      await submitReimbursement(summary.id);
      toast.success('Submitted for approval.');
      refresh();
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    }
  };

  const onManagerApprove = async () => {
    const note = await prompt({
      title: 'Manager approval',
      reasonLabel: 'Note (optional)',
      confirmLabel: 'Approve',
      required: false,
    });
    if (note === null) return;
    try {
      await managerApproveReimbursement(summary.id, note || undefined);
      toast.success('Manager approved — sent to HR/Finance to settle.');
      refresh();
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    }
  };

  const onReject = async () => {
    const reason = await prompt({
      title: 'Reject reimbursement',
      reasonLabel: 'Rejection reason',
      confirmLabel: 'Reject',
      destructive: true,
    });
    if (!reason) return;
    try {
      await rejectReimbursement(summary.id, reason);
      toast.success('Rejected.');
      refresh();
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    }
  };

  const onDeleteLine = async (line: { id: string; description: string; amount: string }) => {
    const ok = await confirm({
      title: 'Remove this expense line?',
      description: `"${line.description}" (${fmtMoney(line.amount, {
        currency: data?.currency,
      })}) will be removed from the report.`,
      confirmLabel: 'Remove line',
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteExpenseLine(line.id);
      toast.success('Line removed.');
      refresh();
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    }
  };

  const editable = data?.status === 'DRAFT' || data?.status === 'REJECTED';

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()} width="max-w-3xl">
      <DrawerHeader>
        <DrawerTitle>{summary.title}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        {loadError ? (
          <div className="space-y-3">
            <p role="alert" className="text-sm text-alert">
              {loadError}
            </p>
            <Button size="sm" variant="secondary" onClick={refresh}>
              Retry
            </Button>
          </div>
        ) : !data ? (
          <SkeletonRows count={3} />
        ) : (
          <>
            <div className="flex items-center gap-3">
              <Badge variant={STATUS_BADGE[data.status]}>{STATUS_LABEL[data.status]}</Badge>
              <div className="text-sm text-silver">
                Total: {fmtMoney(data.totalAmount, { currency: data.currency })}
              </div>
            </div>
            {data.managerNote && (
              <div className="bg-navy-secondary/40 border border-navy-secondary rounded-md p-3 text-sm">
                <div className="font-medium text-white">Manager note:</div>
                <div className="text-silver">{data.managerNote}</div>
              </div>
            )}
            {data.settleNote && (
              <div className="bg-navy-secondary/40 border border-navy-secondary rounded-md p-3 text-sm">
                <div className="font-medium text-white">Settlement note:</div>
                <div className="text-silver">{data.settleNote}</div>
              </div>
            )}
            {data.status === 'SETTLED' && (
              <div className="bg-accent/10 border border-accent/40 rounded-md p-3 text-sm text-white">
                Queued for the next regular payroll run. Will be added to net pay
                (after taxes) when that run is created.
              </div>
            )}
            {data.status === 'PAID' && (
              <div className="bg-success/10 border border-success/40 rounded-md p-3 text-sm text-white">
                Paid out on payroll item {data.payrollItemId ?? '—'}.
              </div>
            )}
            {data.rejectionReason && (
              <div className="bg-alert/20 border border-alert/40 rounded-md p-3 text-sm text-white">
                <div className="font-medium">Rejection reason:</div>
                <div>{data.rejectionReason}</div>
              </div>
            )}
            <Card>
              <CardContent className="p-4 space-y-3">
                <div className="flex justify-between items-center">
                  <div className="text-sm font-medium text-white">Line items</div>
                  {editable && (
                    <Button size="sm" onClick={() => setShowAddLine(true)}>
                      <Plus className="mr-1 h-3 w-3" /> Add line
                    </Button>
                  )}
                </div>
                {data.lines.length === 0 ? (
                  <div className="text-sm text-silver">No lines yet.</div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Date</TableHead>
                        <TableHead className="hidden md:table-cell">Kind</TableHead>
                        <TableHead>Description</TableHead>
                        <TableHead>Amount</TableHead>
                        {editable && <TableHead className="w-12"></TableHead>}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.lines.map((l) => (
                        <TableRow key={l.id}>
                          <TableCell>{fmtDate(parseYmd(l.incurredOn))}</TableCell>
                          <TableCell className="hidden md:table-cell">{KIND_LABEL[l.kind]}</TableCell>
                          <TableCell>
                            {l.description}
                            <div className="text-[11px] text-silver/70 md:hidden">{KIND_LABEL[l.kind]}</div>
                          </TableCell>
                          <TableCell>{fmtMoney(l.amount, { currency: data.currency })}</TableCell>
                          {editable && (
                            <TableCell>
                              <button
                                onClick={() => onDeleteLine(l)}
                                aria-label={`Remove line ${l.description}`}
                                className="text-silver hover:text-alert"
                              >
                                <Trash2 className="h-3 w-3" />
                              </button>
                            </TableCell>
                          )}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
            <div className="flex flex-wrap gap-2 justify-end">
              {editable && data.lines.length > 0 && (
                <Button onClick={onSubmit}>Submit for approval</Button>
              )}
              {canApprove && data.status === 'SUBMITTED' && (
                <>
                  <Button onClick={onManagerApprove}>Approve as manager</Button>
                  <Button variant="ghost" onClick={onReject}>
                    Reject
                  </Button>
                </>
              )}
              {canSettle && data.status === 'MANAGER_APPROVED' && (
                <>
                  <Button onClick={() => setShowSettle(true)}>
                    Settle (queue for payroll)
                  </Button>
                  <Button variant="ghost" onClick={onReject}>
                    Reject
                  </Button>
                </>
              )}
            </div>
          </>
        )}
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      </DrawerFooter>
      {showAddLine && data && (
        <AddLineDrawer
          reimbursementId={data.id}
          currency={data.currency}
          existingTotal={Number(data.totalAmount)}
          existingLineCount={data.lines.length}
          onClose={() => setShowAddLine(false)}
          onSaved={(keepOpen) => {
            if (!keepOpen) setShowAddLine(false);
            refresh();
            onChanged();
          }}
        />
      )}
      {showSettle && data && (
        <SettleDialog
          data={data}
          onClose={() => setShowSettle(false)}
          onDone={() => {
            setShowSettle(false);
            refresh();
            onChanged();
          }}
        />
      )}
    </Drawer>
  );
}

function SettleDialog({
  data,
  onClose,
  onDone,
}: {
  data: ReimbursementFull;
  onClose: () => void;
  onDone: () => void;
}) {
  const missingReceipts = data.lines.filter(
    (l) => l.kind === 'RECEIPT' && !l.receiptUrl,
  );
  const needsWaiver = missingReceipts.length > 0;
  const [note, setNote] = useState('');
  const [waiverNote, setWaiverNote] = useState('');
  const [saving, setSaving] = useState(false);

  const onConfirm = async () => {
    if (needsWaiver && !waiverNote.trim()) {
      toast.error('Waiver note required.');
      return;
    }
    setSaving(true);
    try {
      await settleReimbursement(data.id, {
        note: note.trim() || undefined,
        waiveMissingReceipts: needsWaiver,
        waiverNote: needsWaiver ? waiverNote.trim() : undefined,
      });
      toast.success('Settled — queued for next payroll.');
      onDone();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>Settle reimbursement</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div className="text-sm text-silver">
          This will queue {fmtMoney(data.totalAmount, { currency: data.currency })} to
          be added to {data.associateName}'s next regular payroll, after taxes.
        </div>
        {needsWaiver && (
          <div className="bg-alert/15 border border-alert/40 rounded-md p-3 text-sm text-white space-y-2">
            <div className="font-medium">
              {missingReceipts.length} receipt line(s) are missing a receipt.
            </div>
            <div className="text-silver">
              You can override the receipt-required guard by providing a waiver
              note below. The note is permanently stored on the audit log.
            </div>
          </div>
        )}
        <div>
          <Label>Settlement note (optional)</Label>
          <Textarea
            className="mt-1"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Internal note shown to the associate."
          />
        </div>
        {needsWaiver && (
          <div>
            <Label>Waiver justification (required)</Label>
            <Textarea
              className="mt-1"
              value={waiverNote}
              onChange={(e) => setWaiverNote(e.target.value)}
              placeholder="Why is this being settled without all receipts?"
            />
          </div>
        )}
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={onConfirm} disabled={saving}>
          {saving ? 'Settling…' : needsWaiver ? 'Settle (with waiver)' : 'Settle'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

function AddLineDrawer({
  reimbursementId,
  currency,
  existingTotal,
  existingLineCount,
  onClose,
  onSaved,
}: {
  reimbursementId: string;
  currency: string;
  existingTotal: number;
  existingLineCount: number;
  onClose: () => void;
  onSaved: (keepOpen?: boolean) => void;
}) {
  const [kind, setKind] = useState<ExpenseLineKind>('RECEIPT');
  const [description, setDescription] = useState('');
  const [incurredOn, setIncurredOn] = useState(ymdLocal());
  const [amount, setAmount] = useState('');
  const [miles, setMiles] = useState('');
  const [ratePerMile, setRatePerMile] = useState('0.67');
  const [merchant, setMerchant] = useState('');
  const [category, setCategory] = useState('');
  const [receiptUrl, setReceiptUrl] = useState('');
  const [saving, setSaving] = useState(false);

  // Live amount of the in-progress line: miles × rate for mileage,
  // otherwise the amount field. NaN / non-positive means "not yet valid".
  const milesNum = Number(miles);
  const rateNum = Number(ratePerMile);
  const mileageValid =
    miles !== '' &&
    ratePerMile !== '' &&
    Number.isFinite(milesNum) &&
    milesNum > 0 &&
    Number.isFinite(rateNum) &&
    rateNum > 0;
  const lineAmount =
    kind === 'MILEAGE'
      ? mileageValid
        ? milesNum * rateNum
        : NaN
      : amount !== '' && Number.isFinite(Number(amount)) && Number(amount) > 0
      ? Number(amount)
      : NaN;

  const onSubmit = async (addAnother: boolean) => {
    if (!description.trim() || !incurredOn) {
      toast.error('Description and date required.');
      return;
    }
    if (kind === 'MILEAGE' && (!miles || !ratePerMile)) {
      toast.error('Miles and rate required for mileage.');
      return;
    }
    if (kind !== 'MILEAGE' && !amount) {
      toast.error('Amount required.');
      return;
    }
    setSaving(true);
    try {
      await addExpenseLine(reimbursementId, {
        kind,
        description: description.trim(),
        incurredOn,
        amount: kind === 'MILEAGE' ? 0 : Number(amount),
        miles: kind === 'MILEAGE' ? Number(miles) : null,
        ratePerMile: kind === 'MILEAGE' ? Number(ratePerMile) : null,
        merchant: merchant.trim() || null,
        category: category.trim() || null,
        receiptUrl: receiptUrl.trim() || null,
      });
      toast.success('Line added.');
      if (addAnother) {
        // Reset the form but keep the drawer open and the date (and the
        // kind + mileage rate, which usually repeat across lines).
        setDescription('');
        setAmount('');
        setMiles('');
        setMerchant('');
        setCategory('');
        setReceiptUrl('');
      }
      onSaved(addAnother);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>Add expense line</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>Kind</Label>
          <Select
            className="mt-1"
            value={kind}
            onChange={(e) => setKind(e.target.value as ExpenseLineKind)}
          >
            {(Object.keys(KIND_LABEL) as ExpenseLineKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label>Description</Label>
          <Input
            className="mt-1"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div>
          <Label>Incurred on</Label>
          <Input
            type="date"
            className="mt-1"
            value={incurredOn}
            onChange={(e) => setIncurredOn(e.target.value)}
          />
        </div>
        {kind === 'MILEAGE' ? (
          <div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Miles</Label>
                <Input
                  type="number"
                  step="0.01"
                  className="mt-1"
                  value={miles}
                  onChange={(e) => setMiles(e.target.value)}
                />
              </div>
              <div>
                <Label>Rate / mile ($)</Label>
                <Input
                  type="number"
                  step="0.0001"
                  className="mt-1"
                  value={ratePerMile}
                  onChange={(e) => setRatePerMile(e.target.value)}
                />
              </div>
            </div>
            {mileageValid && (
              <div className="mt-1 text-xs text-silver/70">
                {milesNum} mi × {fmtMoney(rateNum, { currency, precise: true })}/mi ={' '}
                {fmtMoney(milesNum * rateNum, { currency })}
              </div>
            )}
          </div>
        ) : (
          <div>
            <Label>Amount ($)</Label>
            <Input
              type="number"
              step="0.01"
              className="mt-1"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Merchant</Label>
            <Input
              className="mt-1"
              value={merchant}
              onChange={(e) => setMerchant(e.target.value)}
            />
          </div>
          <div>
            <Label>Category</Label>
            <Input
              className="mt-1"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="Travel"
              list="reimbursement-categories"
            />
            <datalist id="reimbursement-categories">
              {RECOMMENDED_CATEGORIES.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </div>
        </div>
        <div>
          <Label htmlFor="add-line-receipt-url">Receipt link (URL)</Label>
          <Input
            id="add-line-receipt-url"
            className="mt-1"
            value={receiptUrl}
            onChange={(e) => setReceiptUrl(e.target.value)}
            placeholder="https://…"
            aria-describedby="add-line-receipt-url-hint"
          />
          <FormHint id="add-line-receipt-url-hint">
            Paste a link to the receipt — a shared-drive file, scan, or photo URL.
            Receipt lines without a link can only be settled with an HR waiver.
          </FormHint>
        </div>
        <div className="text-xs text-silver border-t border-navy-secondary pt-2">
          Report total: {fmtMoney(existingTotal, { currency })} across {existingLineCount}{' '}
          line{existingLineCount === 1 ? '' : 's'}
          {Number.isFinite(lineAmount) &&
            ` — ${fmtMoney(existingTotal + lineAmount, { currency })} with this line`}
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="secondary"
          onClick={() => onSubmit(true)}
          disabled={saving}
        >
          {saving ? 'Saving…' : 'Save & add another'}
        </Button>
        <Button onClick={() => onSubmit(false)} disabled={saving}>
          {saving ? 'Saving…' : 'Add'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}
