import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  CreditCard,
  Download,
  FileText,
  Link as LinkIcon,
  Play,
  Plus,
  RotateCw,
  Send,
  Users,
} from 'lucide-react';
import type {
  PayrollRunDetail,
  PayrollRunStatus,
  PayrollRunSummary,
  PayrollUpcomingSummary,
} from '@alto-people/shared';
import {
  disbursePayrollRun,
  finalizePayrollRun,
  getPayrollRun,
  getPayrollUpcoming,
  listPayrollRuns,
  retryRunFailures,
} from '@/lib/payrollApi';
import { syncRun as syncRunToQbo } from '@/lib/quickbooksApi';
import { BranchEnrollmentDialog } from './BranchEnrollmentDialog';
import { RunPayrollWizard } from './RunPayrollWizard';
import { PaySchedulesView } from './PaySchedulesView';
import { GarnishmentsView } from './GarnishmentsView';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs';
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
  const [tab, setTab] = useState<'runs' | 'schedules' | 'garnishments'>('runs');
  const [filter, setFilter] = useState<PayrollRunStatus | 'ALL'>('DRAFT');
  const [runs, setRuns] = useState<PayrollRunSummary[] | null>(null);
  const [selected, setSelected] = useState<PayrollRunDetail | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [confirmDisburse, setConfirmDisburse] = useState(false);
  const [busy, setBusy] = useState(false);
  const [enrollFor, setEnrollFor] = useState<{ id: string; name: string | null } | null>(null);
  // Wave 8 — hero summary card. One fetch, hydrates from /payroll/upcoming.
  const [upcoming, setUpcoming] = useState<PayrollUpcomingSummary | null>(null);
  const [upcomingLoading, setUpcomingLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await listPayrollRuns(filter === 'ALL' ? {} : { status: filter });
      setRuns(res.runs);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to load runs.');
    }
  }, [filter]);

  const refreshUpcoming = useCallback(async () => {
    setUpcomingLoading(true);
    try {
      const res = await getPayrollUpcoming();
      setUpcoming(res);
    } catch (err) {
      // Non-fatal — the hero just won't render. Don't toast on the landing
      // page; the runs list is still useful even when /upcoming 500s.
      console.warn('payroll upcoming fetch failed:', err);
      setUpcoming({ nextRun: null, lastRun: null });
    } finally {
      setUpcomingLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    refreshUpcoming();
  }, [refreshUpcoming]);

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
        <RunPayrollWizard
          open={showCreate}
          onOpenChange={setShowCreate}
          onCreated={(detail) => {
            setShowCreate(false);
            setSelected(detail);
            refresh();
            refreshUpcoming();
          }}
        />
      )}

      {/* Wave 8 — QBO-parity hero. Shows next pay date · employee count ·
          projected gross/net · exception count, with a one-click resume
          CTA. Hidden when there is neither a schedule nor a prior run. */}
      <PayrollHero
        upcoming={upcoming}
        loading={upcomingLoading}
        canProcess={canProcess}
        onStartRun={() => setShowCreate(true)}
        onOpenLastRun={(id) => {
          setSelected(null);
          getPayrollRun(id).then(setSelected).catch(() => {});
        }}
      />

      <Tabs value={tab} onValueChange={(v) => setTab(v as 'runs' | 'schedules' | 'garnishments')} className="mb-5">
        <TabsList>
          <TabsTrigger value="runs">Runs</TabsTrigger>
          <TabsTrigger value="schedules">Pay schedules</TabsTrigger>
          <TabsTrigger value="garnishments">Garnishments</TabsTrigger>
        </TabsList>
        <TabsContent value="schedules" className="mt-5">
          <PaySchedulesView canProcess={canProcess} />
        </TabsContent>
        <TabsContent value="garnishments" className="mt-5">
          <GarnishmentsView canProcess={canProcess} />
        </TabsContent>
        <TabsContent value="runs" className="mt-5">

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
        </TabsContent>
      </Tabs>

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

/* -------------------------------------------------------------------------- *
 *  Wave 8 — Payroll landing hero.
 *
 *  Mirrors QuickBooks Online Payroll's "Run payroll" landing card. Shows
 *  the next pay date, expected employee count, projected gross/net, and
 *  any pre-flight exceptions before HR enters the wizard. The CTA is the
 *  primary entry point for the wizard so users no longer have to hunt for
 *  the "New run" button in the page header.
 * -------------------------------------------------------------------------- */

function PayrollHero({
  upcoming,
  loading,
  canProcess,
  onStartRun,
  onOpenLastRun,
}: {
  upcoming: PayrollUpcomingSummary | null;
  loading: boolean;
  canProcess: boolean;
  onStartRun: () => void;
  onOpenLastRun: (id: string) => void;
}) {
  if (loading) {
    return <Skeleton className="h-40 mb-5" />;
  }
  if (!upcoming) return null;
  const nr = upcoming.nextRun;
  const lr = upcoming.lastRun;
  // Hide the hero outright when there is nothing to show — keeps the page
  // clean for fresh installs that haven't created a schedule yet.
  if (!nr && !lr) return null;

  return (
    <div className="mb-5 grid grid-cols-1 lg:grid-cols-3 gap-3">
      {/* Next run — spans two columns to give the projected $ room to breathe. */}
      <div
        className={cn(
          'lg:col-span-2 rounded-lg border p-5',
          nr ? 'border-gold/30 bg-gradient-to-br from-gold/8 to-transparent' : 'border-silver/15 bg-black/30'
        )}
      >
        {nr ? (
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 text-[11px] uppercase tracking-widest text-gold mb-1.5">
                <CalendarDays className="h-3.5 w-3.5" />
                Next pay date
              </div>
              <div className="text-2xl text-white font-medium tabular-nums">
                {fmtPayDate(nr.payDate)}
              </div>
              <div className="text-xs text-silver/70 mt-1">
                {nr.scheduleName} · {nr.frequency.toLowerCase()} ·{' '}
                {nr.periodStart} → {nr.periodEnd}
                {nr.clientName ? ` · ${nr.clientName}` : ''}
              </div>
              <div className="mt-4 grid grid-cols-3 gap-3 text-xs">
                <HeroStat
                  icon={<Users className="h-3.5 w-3.5" />}
                  label="Paystubs"
                  value={String(nr.employeeCount)}
                />
                <HeroStat
                  label="Projected gross"
                  value={fmtMoney(nr.projectedGross)}
                />
                <HeroStat
                  label="Projected net"
                  value={fmtMoney(nr.projectedNet)}
                  highlight
                />
              </div>
              {nr.totalExceptions > 0 && (
                <div
                  className={cn(
                    'mt-3 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px]',
                    nr.blockingExceptions > 0
                      ? 'border-alert/40 bg-alert/5 text-alert'
                      : 'border-amber-500/30 bg-amber-500/5 text-amber-300'
                  )}
                >
                  <AlertTriangle className="h-3 w-3" />
                  {nr.blockingExceptions > 0
                    ? `${nr.blockingExceptions} blocking · ${nr.totalExceptions} total`
                    : `${nr.totalExceptions} ${nr.totalExceptions === 1 ? 'issue' : 'issues'} to review`}
                </div>
              )}
            </div>
            {canProcess && (
              <Button onClick={onStartRun} className="shrink-0">
                <Play className="h-4 w-4" />
                Run payroll
              </Button>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-3 text-silver/60 text-sm">
            <CalendarDays className="h-5 w-5 text-silver/40" />
            No active pay schedule. Create one in the <strong>Pay schedules</strong> tab to project the next run.
          </div>
        )}
      </div>

      {/* Last run snapshot. */}
      <div className="rounded-lg border border-silver/15 bg-black/30 p-5">
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-widest text-silver/60 mb-1.5">
          <FileText className="h-3.5 w-3.5" />
          Last run
        </div>
        {lr ? (
          <button
            type="button"
            onClick={() => onOpenLastRun(lr.id)}
            className="block text-left w-full focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright rounded"
          >
            <div className="text-base text-white tabular-nums">
              {lr.periodStart} → {lr.periodEnd}
            </div>
            <div className="mt-1.5 flex items-center gap-2">
              <Badge variant={RUN_STATUS_VARIANT[lr.status]}>{lr.status}</Badge>
              <span className="text-xs text-silver/70">
                {lr.itemCount} paystub{lr.itemCount === 1 ? '' : 's'}
              </span>
            </div>
            <div className="mt-3">
              <div className="text-[11px] uppercase tracking-widest text-silver/60">Net paid</div>
              <div className="tabular-nums text-gold mt-0.5">{fmtMoney(lr.totalNet)}</div>
            </div>
          </button>
        ) : (
          <div className="text-sm text-silver/60">
            No prior runs. Your first run will appear here once created.
          </div>
        )}
      </div>
    </div>
  );
}

function HeroStat({
  icon,
  label,
  value,
  highlight,
}: {
  icon?: React.ReactNode;
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div>
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-widest text-silver/50">
        {icon}
        {label}
      </div>
      <div className={cn('mt-0.5 tabular-nums', highlight ? 'text-gold' : 'text-white')}>
        {value}
      </div>
    </div>
  );
}

/** "2026-04-30" → "Thu, Apr 30". UTC parsing avoids tz drift. */
function fmtPayDate(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

