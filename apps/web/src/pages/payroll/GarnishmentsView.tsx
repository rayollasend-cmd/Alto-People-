// Wave 5.1 — Garnishments management UI.
//
// HR adds garnishments for an associate; Wave 4.1 then auto-applies them
// during run creation respecting per-CCPA caps and priority order. This
// page is the only place a garnishment can be created without hitting
// the API directly.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pause, Play, Plus, Square } from 'lucide-react';
import {
  createGarnishment,
  type Garnishment,
  type GarnishmentKind,
  type GarnishmentStatus,
  listGarnishments,
  setGarnishmentStatus,
} from '@/lib/payrollTax91Api';
import { listOrgAssociates } from '@/lib/orgApi';
import { ApiError } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input, Textarea } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { Skeleton } from '@/components/ui/Skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/Table';
import { Badge } from '@/components/ui/Badge';
import { toast } from '@/components/ui/Toaster';
import { cn } from '@/lib/cn';

const fmtMoney = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const KIND_LABEL: Record<GarnishmentKind, string> = {
  CHILD_SUPPORT: 'Child support',
  TAX_LEVY: 'Tax levy',
  STUDENT_LOAN: 'Student loan',
  BANKRUPTCY: 'Bankruptcy',
  CREDITOR: 'Creditor',
  OTHER: 'Other',
};

const KIND_HINT: Record<GarnishmentKind, string> = {
  CHILD_SUPPORT: 'CCPA cap: 60% of disposable',
  TAX_LEVY: 'IRS Pub 1494 — agency-provided cap',
  STUDENT_LOAN: 'CCPA cap: 15% of disposable',
  BANKRUPTCY: 'Court-ordered amount, no statutory cap',
  CREDITOR: 'CCPA cap: 25% of disposable',
  OTHER: 'CCPA cap: 25% of disposable',
};

const STATUS_VARIANT: Record<
  GarnishmentStatus,
  'success' | 'pending' | 'destructive' | 'default'
> = {
  ACTIVE: 'success',
  SUSPENDED: 'pending',
  COMPLETED: 'default',
  TERMINATED: 'destructive',
};

const STATUS_FILTERS: Array<{ value: GarnishmentStatus | 'ALL'; label: string }> = [
  { value: 'ACTIVE', label: 'Active' },
  { value: 'SUSPENDED', label: 'Suspended' },
  { value: 'COMPLETED', label: 'Completed' },
  { value: 'TERMINATED', label: 'Terminated' },
  { value: 'ALL', label: 'All' },
];

interface Props {
  canProcess: boolean;
}

export function GarnishmentsView({ canProcess }: Props) {
  const [filter, setFilter] = useState<GarnishmentStatus | 'ALL'>('ACTIVE');
  const [rows, setRows] = useState<Garnishment[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [statusChange, setStatusChange] = useState<
    | { row: Garnishment; nextStatus: GarnishmentStatus }
    | null
  >(null);

  const refresh = useCallback(async () => {
    try {
      const res = await listGarnishments(filter === 'ALL' ? {} : { status: filter });
      setRows(res.garnishments);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to load garnishments.');
    }
  }, [filter]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const onChangeStatus = async () => {
    if (!statusChange) return;
    try {
      await setGarnishmentStatus(statusChange.row.id, statusChange.nextStatus);
      toast.success(`Garnishment ${statusChange.nextStatus.toLowerCase()}.`);
      setStatusChange(null);
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Status change failed.');
    }
  };

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <div className="flex flex-wrap gap-2">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => setFilter(f.value)}
              className={cn(
                'px-3 py-1.5 rounded-md text-sm border transition-colors',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright',
                filter === f.value
                  ? 'border-gold text-gold bg-gold/10'
                  : 'border-navy-secondary text-silver hover:text-white hover:border-silver/40'
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        {canProcess && (
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" />
            New garnishment
          </Button>
        )}
      </div>

      {!rows && (
        <Card>
          <CardContent className="p-4 space-y-3">
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </CardContent>
        </Card>
      )}

      {rows && rows.length === 0 && (
        <EmptyState
          icon={Square}
          title={filter === 'ACTIVE' ? 'No active garnishments' : 'No garnishments match this filter'}
          description={
            canProcess && filter === 'ACTIVE'
              ? 'Add a garnishment to start auto-applying it on every payroll run for this associate.'
              : undefined
          }
          action={
            canProcess && filter === 'ACTIVE' ? (
              <Button onClick={() => setCreating(true)}>
                <Plus className="h-4 w-4" />
                New garnishment
              </Button>
            ) : undefined
          }
        />
      )}

      {rows && rows.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{rows.length} garnishment{rows.length === 1 ? '' : 's'}</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Associate</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Per period</TableHead>
                  <TableHead className="text-right">Withheld</TableHead>
                  <TableHead className="text-right">Cap</TableHead>
                  <TableHead className="text-center">Priority</TableHead>
                  <TableHead>Status</TableHead>
                  {canProcess && <TableHead />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((g) => (
                  <GarnishmentRow
                    key={g.id}
                    g={g}
                    canProcess={canProcess}
                    onSuspend={() => setStatusChange({ row: g, nextStatus: 'SUSPENDED' })}
                    onResume={() => setStatusChange({ row: g, nextStatus: 'ACTIVE' })}
                    onTerminate={() => setStatusChange({ row: g, nextStatus: 'TERMINATED' })}
                  />
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <CreateGarnishmentDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={() => {
          setCreating(false);
          refresh();
        }}
      />

      <ConfirmDialog
        open={!!statusChange}
        onOpenChange={(v) => !v && setStatusChange(null)}
        title={statusChangeTitle(statusChange?.nextStatus)}
        description={statusChangeDescription(statusChange?.nextStatus)}
        confirmLabel={statusChangeConfirmLabel(statusChange?.nextStatus)}
        destructive={statusChange?.nextStatus === 'TERMINATED'}
        onConfirm={onChangeStatus}
      />
    </div>
  );
}

function statusChangeTitle(s: GarnishmentStatus | undefined): string {
  if (s === 'SUSPENDED') return 'Suspend this garnishment?';
  if (s === 'ACTIVE') return 'Resume this garnishment?';
  if (s === 'TERMINATED') return 'Terminate this garnishment?';
  return '';
}

function statusChangeDescription(s: GarnishmentStatus | undefined): string {
  if (s === 'SUSPENDED') {
    return 'No deductions will be taken on future payroll runs until you resume it. The cumulative withheld amount stays.';
  }
  if (s === 'ACTIVE') {
    return 'Future payroll runs will resume taking deductions per the configured amount or percentage.';
  }
  if (s === 'TERMINATED') {
    return 'This is permanent. No further deductions will be taken. Use Suspended instead if there is any chance the garnishment will resume.';
  }
  return '';
}

function statusChangeConfirmLabel(s: GarnishmentStatus | undefined): string {
  if (s === 'SUSPENDED') return 'Suspend';
  if (s === 'ACTIVE') return 'Resume';
  if (s === 'TERMINATED') return 'Terminate';
  return 'Confirm';
}

function GarnishmentRow({
  g,
  canProcess,
  onSuspend,
  onResume,
  onTerminate,
}: {
  g: Garnishment;
  canProcess: boolean;
  onSuspend: () => void;
  onResume: () => void;
  onTerminate: () => void;
}) {
  const perPeriod =
    g.amountPerRun !== null
      ? fmtMoney(Number(g.amountPerRun))
      : g.percentOfDisp !== null
      ? `${(Number(g.percentOfDisp) * 100).toFixed(1)}% of disposable`
      : '—';
  const withheld = Number(g.amountWithheld);
  const cap = g.totalCap !== null ? Number(g.totalCap) : null;

  return (
    <TableRow>
      <TableCell>
        <div className="text-silver">{g.associateName}</div>
        {g.caseNumber && (
          <div className="text-xs text-silver/50">Case #{g.caseNumber}</div>
        )}
      </TableCell>
      <TableCell>
        <div className="text-silver">{KIND_LABEL[g.kind]}</div>
        {g.agencyName && (
          <div className="text-xs text-silver/50">{g.agencyName}</div>
        )}
      </TableCell>
      <TableCell className="text-silver">{perPeriod}</TableCell>
      <TableCell className="text-right tabular-nums text-white">
        {fmtMoney(withheld)}
        <div className="text-[10px] text-silver/50">{g.deductionCount} run{g.deductionCount === 1 ? '' : 's'}</div>
      </TableCell>
      <TableCell className="text-right tabular-nums text-silver">
        {cap !== null ? fmtMoney(cap) : '—'}
        {cap !== null && (
          <div className="text-[10px] text-silver/50">
            {Math.min(100, Math.round((withheld / cap) * 100))}% complete
          </div>
        )}
      </TableCell>
      <TableCell className="text-center text-silver">{g.priority}</TableCell>
      <TableCell>
        <Badge variant={STATUS_VARIANT[g.status]}>{g.status}</Badge>
      </TableCell>
      {canProcess && (
        <TableCell className="text-right">
          <div className="flex items-center justify-end gap-1">
            {g.status === 'ACTIVE' && (
              <Button variant="ghost" size="icon-sm" onClick={onSuspend} aria-label="Suspend garnishment">
                <Pause className="h-3.5 w-3.5" />
              </Button>
            )}
            {g.status === 'SUSPENDED' && (
              <Button variant="ghost" size="icon-sm" onClick={onResume} aria-label="Resume garnishment">
                <Play className="h-3.5 w-3.5" />
              </Button>
            )}
            {(g.status === 'ACTIVE' || g.status === 'SUSPENDED') && (
              <Button variant="ghost" size="icon-sm" onClick={onTerminate} aria-label="Terminate garnishment">
                <Square className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </TableCell>
      )}
    </TableRow>
  );
}

function CreateGarnishmentDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: () => void;
}) {
  const [associates, setAssociates] = useState<Array<{ id: string; firstName: string; lastName: string }> | null>(null);
  const [associateId, setAssociateId] = useState('');
  const [kind, setKind] = useState<GarnishmentKind>('CREDITOR');
  const [amountMode, setAmountMode] = useState<'flat' | 'percent'>('flat');
  const [amountPerRun, setAmountPerRun] = useState('');
  const [percentOfDisp, setPercentOfDisp] = useState('');
  const [caseNumber, setCaseNumber] = useState('');
  const [agencyName, setAgencyName] = useState('');
  const [totalCap, setTotalCap] = useState('');
  const [remitTo, setRemitTo] = useState('');
  const [remitAddress, setRemitAddress] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [priority, setPriority] = useState('100');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setAssociateId('');
    setKind('CREDITOR');
    setAmountMode('flat');
    setAmountPerRun('');
    setPercentOfDisp('');
    setCaseNumber('');
    setAgencyName('');
    setTotalCap('');
    setRemitTo('');
    setRemitAddress('');
    setStartDate(new Date().toISOString().slice(0, 10));
    setEndDate('');
    setPriority('100');
    setNotes('');
    setSubmitting(false);
    listOrgAssociates()
      .then((res) =>
        setAssociates(
          res.associates.map((a) => ({ id: a.id, firstName: a.firstName, lastName: a.lastName }))
        )
      )
      .catch(() => setAssociates([]));
  }, [open]);

  const sortedAssociates = useMemo(
    () =>
      [...(associates ?? [])].sort((a, b) =>
        `${a.lastName} ${a.firstName}`.localeCompare(`${b.lastName} ${b.firstName}`)
      ),
    [associates]
  );

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      await createGarnishment({
        associateId,
        kind,
        caseNumber: caseNumber || null,
        agencyName: agencyName || null,
        amountPerRun: amountMode === 'flat' && amountPerRun ? Number(amountPerRun) : null,
        percentOfDisp: amountMode === 'percent' && percentOfDisp ? Number(percentOfDisp) / 100 : null,
        totalCap: totalCap ? Number(totalCap) : null,
        remitTo: remitTo || null,
        remitAddress: remitAddress || null,
        startDate,
        endDate: endDate || null,
        priority: Number(priority) || 100,
        notes: notes || null,
      });
      toast.success('Garnishment added.');
      onCreated();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Create failed.');
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>New garnishment</DialogTitle>
          <DialogDescription>
            Auto-applies on every payroll run for this associate, respecting
            the federal CCPA cap for the chosen kind and the priority order.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label htmlFor="g-assoc" required>Associate</Label>
              <select
                id="g-assoc"
                required
                className="mt-1 w-full rounded border border-silver/20 bg-black/40 px-2 py-1.5 text-sm text-silver"
                value={associateId}
                onChange={(e) => setAssociateId(e.target.value)}
              >
                <option value="">— Select —</option>
                {sortedAssociates.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.lastName}, {a.firstName}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="g-kind" required>Kind</Label>
              <select
                id="g-kind"
                required
                className="mt-1 w-full rounded border border-silver/20 bg-black/40 px-2 py-1.5 text-sm text-silver"
                value={kind}
                onChange={(e) => setKind(e.target.value as GarnishmentKind)}
              >
                {(Object.keys(KIND_LABEL) as GarnishmentKind[]).map((k) => (
                  <option key={k} value={k}>{KIND_LABEL[k]}</option>
                ))}
              </select>
              <div className="text-[10px] text-silver/50 mt-1">{KIND_HINT[kind]}</div>
            </div>
          </div>

          <div>
            <Label>Deduction amount</Label>
            <div className="flex flex-wrap gap-2 mt-1">
              <button
                type="button"
                onClick={() => setAmountMode('flat')}
                className={cn(
                  'px-3 py-1 text-xs rounded border',
                  amountMode === 'flat'
                    ? 'border-gold text-gold bg-gold/10'
                    : 'border-silver/30 text-silver/70'
                )}
              >
                Flat amount
              </button>
              <button
                type="button"
                onClick={() => setAmountMode('percent')}
                className={cn(
                  'px-3 py-1 text-xs rounded border',
                  amountMode === 'percent'
                    ? 'border-gold text-gold bg-gold/10'
                    : 'border-silver/30 text-silver/70'
                )}
              >
                % of disposable
              </button>
            </div>
            <div className="mt-2">
              {amountMode === 'flat' ? (
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  required
                  placeholder="e.g. 150.00"
                  value={amountPerRun}
                  onChange={(e) => setAmountPerRun(e.target.value)}
                />
              ) : (
                <Input
                  type="number"
                  min={0}
                  max={100}
                  step="0.1"
                  required
                  placeholder="e.g. 15"
                  value={percentOfDisp}
                  onChange={(e) => setPercentOfDisp(e.target.value)}
                />
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="g-case">Case number</Label>
              <Input
                id="g-case"
                value={caseNumber}
                onChange={(e) => setCaseNumber(e.target.value)}
                placeholder="Court / agency reference"
              />
            </div>
            <div>
              <Label htmlFor="g-agency">Agency / creditor</Label>
              <Input
                id="g-agency"
                value={agencyName}
                onChange={(e) => setAgencyName(e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <Label htmlFor="g-cap">Total cap</Label>
              <Input
                id="g-cap"
                type="number"
                min={0}
                step="0.01"
                value={totalCap}
                onChange={(e) => setTotalCap(e.target.value)}
                placeholder="optional"
              />
            </div>
            <div>
              <Label htmlFor="g-start" required>Start date</Label>
              <Input
                id="g-start"
                type="date"
                required
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="g-end">End date</Label>
              <Input
                id="g-end"
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <Label htmlFor="g-priority">Priority</Label>
              <Input
                id="g-priority"
                type="number"
                min={1}
                max={999}
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
              />
              <div className="text-[10px] text-silver/50 mt-1">
                Lower runs first when multiple compete for disposable.
              </div>
            </div>
            <div className="col-span-2">
              <Label htmlFor="g-remitto">Remit payee</Label>
              <Input
                id="g-remitto"
                value={remitTo}
                onChange={(e) => setRemitTo(e.target.value)}
              />
            </div>
          </div>

          <div>
            <Label htmlFor="g-address">Remit address</Label>
            <Input
              id="g-address"
              value={remitAddress}
              onChange={(e) => setRemitAddress(e.target.value)}
            />
          </div>

          <div>
            <Label htmlFor="g-notes">Notes</Label>
            <Textarea
              id="g-notes"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={submitting}>Create garnishment</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
