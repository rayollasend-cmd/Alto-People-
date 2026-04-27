import { useEffect, useState } from 'react';
import { Plus, Receipt, Trash2 } from 'lucide-react';
import { ApiError } from '@/lib/api';
import {
  addExpenseLine,
  createReimbursement,
  decideReimbursement,
  deleteExpenseLine,
  getReimbursement,
  listReimbursements,
  markPaidReimbursement,
  submitReimbursement,
  type ExpenseLineKind,
  type ReimbursementFull,
  type ReimbursementStatus,
  type ReimbursementSummary,
} from '@/lib/reimbursements97Api';
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
  Textarea,
} from '@/components/ui';
import { Label } from '@/components/ui/Label';
import { toast } from 'sonner';

const STATUS_BADGE: Record<ReimbursementStatus, 'pending' | 'accent' | 'success' | 'destructive' | 'default'> = {
  DRAFT: 'default',
  SUBMITTED: 'pending',
  APPROVED: 'accent',
  REJECTED: 'destructive',
  PAID: 'success',
};

const KIND_LABEL: Record<ExpenseLineKind, string> = {
  RECEIPT: 'Receipt',
  MILEAGE: 'Mileage',
  PER_DIEM: 'Per diem',
  OTHER: 'Other',
};

export function ReimbursementsHome() {
  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'process:payroll') : false;
  const [rows, setRows] = useState<ReimbursementSummary[] | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [active, setActive] = useState<ReimbursementSummary | null>(null);

  const refresh = () => {
    setRows(null);
    listReimbursements()
      .then((r) => setRows(r.reimbursements))
      .catch(() => setRows([]));
  };
  useEffect(() => {
    refresh();
  }, []);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Reimbursements"
        subtitle="Submit, approve, and pay employee expense reports."
        breadcrumbs={[{ label: 'Payroll' }, { label: 'Spend' }]}
      />
      <div className="flex justify-end">
        <Button onClick={() => setShowNew(true)}>
          <Plus className="mr-2 h-4 w-4" /> New report
        </Button>
      </div>
      <Card>
        <CardContent className="p-0">
          {rows === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={Receipt}
              title="No reimbursements"
              description="Submit your first expense report to get started."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead>Submitter</TableHead>
                  <TableHead>Lines</TableHead>
                  <TableHead>Total</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Submitted</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow
                    key={r.id}
                    className="cursor-pointer"
                    onClick={() => setActive(r)}
                  >
                    <TableCell className="font-medium text-white">{r.title}</TableCell>
                    <TableCell>{r.associateName}</TableCell>
                    <TableCell>{r.lineCount}</TableCell>
                    <TableCell>
                      {r.currency} {Number(r.totalAmount).toFixed(2)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_BADGE[r.status]}>{r.status}</Badge>
                    </TableCell>
                    <TableCell>
                      {r.submittedAt
                        ? new Date(r.submittedAt).toLocaleDateString()
                        : '—'}
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
          canManage={canManage}
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
  canManage,
  onClose,
  onChanged,
}: {
  summary: ReimbursementSummary;
  canManage: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [data, setData] = useState<ReimbursementFull | null>(null);
  const [showAddLine, setShowAddLine] = useState(false);

  const refresh = () => {
    getReimbursement(summary.id)
      .then(setData)
      .catch(() => setData(null));
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

  const onDecide = async (decision: 'APPROVED' | 'REJECTED') => {
    let reason: string | undefined;
    if (decision === 'REJECTED') {
      const r = window.prompt('Rejection reason (required)?');
      if (!r) return;
      reason = r;
    }
    try {
      await decideReimbursement(summary.id, decision, reason);
      toast.success(`${decision.toLowerCase()}.`);
      refresh();
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    }
  };

  const onMarkPaid = async () => {
    if (!window.confirm('Mark as paid?')) return;
    try {
      await markPaidReimbursement(summary.id);
      toast.success('Marked paid.');
      refresh();
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    }
  };

  const onDeleteLine = async (lineId: string) => {
    try {
      await deleteExpenseLine(lineId);
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
        {!data ? (
          <SkeletonRows count={3} />
        ) : (
          <>
            <div className="flex items-center gap-3">
              <Badge variant={STATUS_BADGE[data.status]}>{data.status}</Badge>
              <div className="text-sm text-silver">
                Total: {data.currency} {Number(data.totalAmount).toFixed(2)}
              </div>
            </div>
            {data.rejectionReason && (
              <div className="bg-destructive/20 border border-destructive/40 rounded-md p-3 text-sm text-white">
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
                        <TableHead>Kind</TableHead>
                        <TableHead>Description</TableHead>
                        <TableHead>Amount</TableHead>
                        {editable && <TableHead className="w-12"></TableHead>}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.lines.map((l) => (
                        <TableRow key={l.id}>
                          <TableCell>{l.incurredOn}</TableCell>
                          <TableCell>{KIND_LABEL[l.kind]}</TableCell>
                          <TableCell>{l.description}</TableCell>
                          <TableCell>${Number(l.amount).toFixed(2)}</TableCell>
                          {editable && (
                            <TableCell>
                              <button
                                onClick={() => onDeleteLine(l.id)}
                                className="text-silver hover:text-destructive"
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
              {canManage && data.status === 'SUBMITTED' && (
                <>
                  <Button onClick={() => onDecide('APPROVED')}>Approve</Button>
                  <Button variant="ghost" onClick={() => onDecide('REJECTED')}>
                    Reject
                  </Button>
                </>
              )}
              {canManage && data.status === 'APPROVED' && (
                <Button onClick={onMarkPaid}>Mark paid</Button>
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
          onClose={() => setShowAddLine(false)}
          onSaved={() => {
            setShowAddLine(false);
            refresh();
            onChanged();
          }}
        />
      )}
    </Drawer>
  );
}

function AddLineDrawer({
  reimbursementId,
  onClose,
  onSaved,
}: {
  reimbursementId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [kind, setKind] = useState<ExpenseLineKind>('RECEIPT');
  const [description, setDescription] = useState('');
  const [incurredOn, setIncurredOn] = useState('');
  const [amount, setAmount] = useState('');
  const [miles, setMiles] = useState('');
  const [ratePerMile, setRatePerMile] = useState('0.67');
  const [merchant, setMerchant] = useState('');
  const [category, setCategory] = useState('');
  const [receiptUrl, setReceiptUrl] = useState('');
  const [saving, setSaving] = useState(false);

  const onSubmit = async () => {
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
        <DrawerTitle>Add expense line</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>Kind</Label>
          <select
            className="mt-1 flex h-10 w-full rounded-md border border-navy-secondary bg-navy-secondary/40 px-3 text-sm text-white"
            value={kind}
            onChange={(e) => setKind(e.target.value as ExpenseLineKind)}
          >
            {(Object.keys(KIND_LABEL) as ExpenseLineKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
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
            />
          </div>
        </div>
        <div>
          <Label>Receipt URL (optional)</Label>
          <Input
            className="mt-1"
            value={receiptUrl}
            onChange={(e) => setReceiptUrl(e.target.value)}
          />
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={onSubmit} disabled={saving}>
          {saving ? 'Saving…' : 'Add'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}
