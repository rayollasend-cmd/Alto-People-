import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, CreditCard, Download, FileText, Link as LinkIcon, Plus, RotateCw, Send } from 'lucide-react';
import type {
  PayrollRunDetail,
  PayrollRunStatus,
  PayrollRunSummary,
} from '@alto-people/shared';
import {
  createPayrollRun,
  disbursePayrollRun,
  finalizePayrollRun,
  getPayrollRun,
  listPayrollRuns,
  retryRunFailures,
} from '@/lib/payrollApi';
import { syncRun as syncRunToQbo } from '@/lib/quickbooksApi';
import { BranchEnrollmentDialog } from './BranchEnrollmentDialog';
import { ApiError } from '@/lib/api';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
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
import {
  Drawer,
  DrawerBody,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/Drawer';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input, Textarea } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { PageHeader } from '@/components/ui/PageHeader';
import { Skeleton } from '@/components/ui/Skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/Table';
import { toast } from '@/components/ui/Toaster';
import { cn } from '@/lib/cn';

const fmtMoney = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const STATUS_FILTERS: Array<{ value: PayrollRunStatus | 'ALL'; label: string }> = [
  { value: 'DRAFT', label: 'Draft' },
  { value: 'FINALIZED', label: 'Finalized' },
  { value: 'DISBURSED', label: 'Disbursed' },
  { value: 'CANCELLED', label: 'Cancelled' },
  { value: 'ALL', label: 'All' },
];

const RUN_STATUS_VARIANT: Record<
  PayrollRunStatus,
  'success' | 'pending' | 'destructive' | 'default' | 'accent'
> = {
  DRAFT: 'default',
  FINALIZED: 'pending',
  DISBURSED: 'success',
  CANCELLED: 'destructive',
};

interface AdminPayrollViewProps {
  canProcess: boolean;
}

export function AdminPayrollView({ canProcess }: AdminPayrollViewProps) {
  const [filter, setFilter] = useState<PayrollRunStatus | 'ALL'>('DRAFT');
  const [runs, setRuns] = useState<PayrollRunSummary[] | null>(null);
  const [selected, setSelected] = useState<PayrollRunDetail | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [confirmDisburse, setConfirmDisburse] = useState(false);
  const [busy, setBusy] = useState(false);
  const [enrollFor, setEnrollFor] = useState<{ id: string; name: string | null } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await listPayrollRuns(filter === 'ALL' ? {} : { status: filter });
      setRuns(res.runs);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to load runs.');
    }
  }, [filter]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const openRun = async (id: string) => {
    try {
      const detail = await getPayrollRun(id);
      setSelected(detail);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to load run.');
    }
  };

  const onFinalize = async () => {
    if (!selected || busy) return;
    setBusy(true);
    try {
      const updated = await finalizePayrollRun(selected.id);
      setSelected(updated);
      toast.success('Run finalized.');
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Finalize failed.');
    } finally {
      setBusy(false);
    }
  };

  const onDisburse = async () => {
    if (!selected || busy) return;
    setBusy(true);
    setConfirmDisburse(false);
    try {
      const updated = await disbursePayrollRun(selected.id);
      setSelected(updated);
      toast.success('Run disbursed.');
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Disburse failed.');
    } finally {
      setBusy(false);
    }
  };

  const onRetryFailures = async () => {
    if (!selected || busy) return;
    setBusy(true);
    try {
      const result = await retryRunFailures(selected.id);
      const updated = await getPayrollRun(selected.id);
      setSelected(updated);
      refresh();
      if (result.retried === 0) {
        toast.success('No failed items to retry.');
      } else {
        toast.success(`Retried ${result.retried} — ${result.succeeded} succeeded.`);
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Retry failed.');
    } finally {
      setBusy(false);
    }
  };

  const onSyncQbo = async () => {
    if (!selected || busy) return;
    setBusy(true);
    try {
      await syncRunToQbo(selected.id);
      // Re-fetch the run so qboJournalEntryId / qboSyncedAt land on the UI.
      const updated = await getPayrollRun(selected.id);
      setSelected(updated);
      toast.success('Posted to QuickBooks.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'QuickBooks sync failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-6xl mx-auto">
      <PageHeader
        title="Payroll"
        subtitle={
          canProcess
            ? 'Aggregate approved time, review paystubs, and disburse.'
            : 'Read-only view of payroll runs.'
        }
        primaryAction={
          canProcess ? (
            <Button onClick={() => setShowCreate(true)}>
              <Plus className="h-4 w-4" />
              New run
            </Button>
          ) : undefined
        }
      />

      {canProcess && (
        <CreateRunDialog
          open={showCreate}
          onOpenChange={setShowCreate}
          onCreated={(detail) => {
            setShowCreate(false);
            setSelected(detail);
            toast.success('Run created and aggregated.');
            refresh();
          }}
        />
      )}

      <div className="flex flex-wrap gap-2 mb-5">
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

      {/* Phase 75 — runs list is full-width; clicking a row opens a Drawer
          with the run detail (replaces the older 2-col layout). */}
      <Card>
        <CardHeader>
          <CardTitle>Runs</CardTitle>
        </CardHeader>
        <CardContent>
          {!runs && (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-16" />
              ))}
            </div>
          )}
          {runs && runs.length === 0 && (
            <EmptyState
              icon={FileText}
              title="No runs match this filter"
              description="Switch to a different status, or create a new run."
            />
          )}
          {runs && runs.length > 0 && (
            <ul className="space-y-2">
              {runs.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => openRun(r.id)}
                    className={cn(
                      'w-full text-left p-3 rounded-md border transition-colors',
                      'focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright',
                      selected?.id === r.id
                        ? 'border-gold/60 bg-gold/5'
                        : 'border-navy-secondary hover:border-silver/40 hover:bg-navy-secondary/30'
                    )}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-white font-medium">
                        {r.periodStart} → {r.periodEnd}
                      </div>
                      <Badge variant={RUN_STATUS_VARIANT[r.status]}>{r.status}</Badge>
                    </div>
                    <div className="text-xs text-silver mt-1 tabular-nums">
                      {r.itemCount} paystubs · gross {fmtMoney(r.totalGross)} · net{' '}
                      {fmtMoney(r.totalNet)}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Drawer
        open={selected !== null}
        onOpenChange={(o) => !o && setSelected(null)}
        width="max-w-3xl"
      >
        {selected && (
          <>
            <DrawerHeader>
              <DrawerTitle>
                {selected.periodStart} → {selected.periodEnd}
              </DrawerTitle>
              <DrawerDescription>
                <Badge variant={RUN_STATUS_VARIANT[selected.status]}>
                  {selected.status}
                </Badge>
                <span className="ml-2 text-xs">
                  {selected.items.length} paystub{selected.items.length === 1 ? '' : 's'}
                </span>
              </DrawerDescription>
            </DrawerHeader>
            <DrawerBody>
              <div className="grid grid-cols-3 gap-3 mb-5 text-sm">
                <Stat label="Gross" value={fmtMoney(selected.totalGross)} />
                <Stat label="Tax" value={fmtMoney(selected.totalTax)} />
                <Stat label="Net" value={fmtMoney(selected.totalNet)} highlight />
              </div>

              {selected.items.length === 0 && (
                <p className="text-sm text-silver">
                  No approved time entries in this period — no paystubs created.
                </p>
              )}
              {selected.items.length > 0 && (
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead>Associate</TableHead>
                        <TableHead className="text-right">Hrs</TableHead>
                        <TableHead className="text-right">Rate</TableHead>
                        <TableHead className="text-right">Net</TableHead>
                        <TableHead className="text-right">Status</TableHead>
                        {canProcess && <TableHead />}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {selected.items.map((it) => (
                        <TableRow key={it.id} className="group">
                          <TableCell>
                            <div className="flex items-center gap-2.5">
                              <Avatar name={it.associateName ?? '—'} size="sm" />
                              <span>{it.associateName ?? '—'}</span>
                            </div>
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {it.hoursWorked.toFixed(2)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {fmtMoney(it.hourlyRate)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-gold">
                            {fmtMoney(it.netPay)}
                          </TableCell>
                          <TableCell className="text-right">
                            <span className={cn(
                              'text-xs uppercase tracking-widest',
                              it.status === 'HELD' ? 'text-alert' : 'text-silver'
                            )}>
                              {it.status}
                            </span>
                            {it.failureReason && (
                              <div className="text-[11px] text-alert mt-0.5">
                                {it.failureReason}
                              </div>
                            )}
                          </TableCell>
                          {canProcess && (
                            <TableCell className="text-right">
                              <div className="opacity-60 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity inline-flex">
                                <Button
                                  variant="ghost"
                                  onClick={() =>
                                    setEnrollFor({
                                      id: it.associateId,
                                      name: it.associateName,
                                    })
                                  }
                                >
                                  <CreditCard className="h-4 w-4" />
                                  Branch
                                </Button>
                              </div>
                            </TableCell>
                          )}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}

              {(selected.qboJournalEntryId || selected.qboSyncError) && (
                <div className="mt-4 text-xs text-silver">
                  {selected.qboJournalEntryId && (
                    <div>
                      QBO JournalEntry{' '}
                      <span className="font-mono text-white">
                        {selected.qboJournalEntryId}
                      </span>
                      {selected.qboSyncedAt && (
                        <> — synced {new Date(selected.qboSyncedAt).toLocaleString()}</>
                      )}
                    </div>
                  )}
                  {selected.qboSyncError && (
                    <div className="text-alert">
                      Last QBO sync error: {selected.qboSyncError}
                    </div>
                  )}
                </div>
              )}
            </DrawerBody>
            {canProcess && (
              <DrawerFooter className="flex-wrap justify-start">
                {selected.status === 'DRAFT' && (
                  <Button onClick={onFinalize} loading={busy} disabled={busy}>
                    <CheckCircle2 className="h-4 w-4" />
                    Finalize
                  </Button>
                )}
                {selected.status === 'FINALIZED' && (
                  <Button
                    variant="primary"
                    onClick={() => setConfirmDisburse(true)}
                    disabled={busy}
                  >
                    <Send className="h-4 w-4" />
                    Disburse
                  </Button>
                )}
                {(selected.status === 'FINALIZED' || selected.status === 'DISBURSED') &&
                  selected.items.length > 0 && (
                    <Button asChild variant="secondary">
                      <a
                        href={`/api/payroll/runs/${selected.id}/paystubs.zip`}
                        download
                      >
                        <Download className="h-4 w-4" />
                        Download all paystubs
                      </a>
                    </Button>
                  )}
                {(selected.status === 'FINALIZED' || selected.status === 'DISBURSED') &&
                  selected.items.some((it) => it.status === 'HELD') && (
                    <Button variant="secondary" onClick={onRetryFailures} loading={busy}>
                      <RotateCw className="h-4 w-4" />
                      Retry failed disbursements
                    </Button>
                  )}
                {(selected.status === 'FINALIZED' || selected.status === 'DISBURSED') &&
                  selected.clientId && (
                    <Button variant="secondary" onClick={onSyncQbo} loading={busy}>
                      <LinkIcon className="h-4 w-4" />
                      {selected.qboJournalEntryId ? 'Re-sync to QuickBooks' : 'Sync to QuickBooks'}
                    </Button>
                  )}
              </DrawerFooter>
            )}
          </>
        )}
      </Drawer>

      <Dialog open={confirmDisburse} onOpenChange={setConfirmDisburse}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disburse this run?</DialogTitle>
            <DialogDescription>
              Stubbed in dev — no real funds move. In production, this triggers
              the configured payout adapter (Wise / Branch) for every paystub.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setConfirmDisburse(false)}>
              Cancel
            </Button>
            <Button onClick={onDisburse} loading={busy}>
              Disburse
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <BranchEnrollmentDialog
        associateId={enrollFor?.id ?? null}
        associateName={enrollFor?.name ?? null}
        onOpenChange={(v) => {
          if (!v) setEnrollFor(null);
        }}
        onSaved={() => {
          if (selected) {
            getPayrollRun(selected.id).then(setSelected).catch(() => {});
          }
        }}
      />
    </div>
  );
}

function Stat({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div>
      <div
        className={cn(
          'text-xs uppercase tracking-widest',
          highlight ? 'text-gold' : 'text-silver/60'
        )}
      >
        {label}
      </div>
      <div className={cn('tabular-nums mt-0.5', highlight ? 'text-gold' : 'text-white')}>
        {value}
      </div>
    </div>
  );
}

interface CreateRunDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (detail: PayrollRunDetail) => void;
}

function CreateRunDialog({ open, onOpenChange, onCreated }: CreateRunDialogProps) {
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [defaultRate, setDefaultRate] = useState('15');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setPeriodStart('');
      setPeriodEnd('');
      setDefaultRate('15');
      setNotes('');
      setSubmitting(false);
    }
  }, [open]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      const detail = await createPayrollRun({
        periodStart,
        periodEnd,
        defaultHourlyRate: defaultRate ? Number(defaultRate) : undefined,
        notes: notes || undefined,
      });
      onCreated(detail);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Create failed.');
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New payroll run</DialogTitle>
          <DialogDescription>
            Aggregates every APPROVED time entry in the period into paystubs.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <Label htmlFor="cr-start" required>
                Period start
              </Label>
              <Input
                id="cr-start"
                type="date"
                required
                value={periodStart}
                onChange={(e) => setPeriodStart(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="cr-end" required>
                Period end
              </Label>
              <Input
                id="cr-end"
                type="date"
                required
                value={periodEnd}
                onChange={(e) => setPeriodEnd(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="cr-rate">Default rate ($/hr)</Label>
              <Input
                id="cr-rate"
                type="number"
                min={0}
                step="0.01"
                value={defaultRate}
                onChange={(e) => setDefaultRate(e.target.value)}
              />
            </div>
          </div>
          <div>
            <Label htmlFor="cr-notes">Notes</Label>
            <Textarea
              id="cr-notes"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={submitting}>
              Create + aggregate
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
