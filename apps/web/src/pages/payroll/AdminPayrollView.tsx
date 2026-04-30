import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowDownUp,
  ArrowUpDown,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
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

type SortKey = 'periodEnd' | 'totalGross' | 'totalNet' | 'itemCount' | 'status';
type SortDir = 'asc' | 'desc';

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
  // Wave 9 — sortable runs table.
  const [sortKey, setSortKey] = useState<SortKey>('periodEnd');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const refresh = useCallback(async () => {
    try {
      const res = await listPayrollRuns(filter === 'ALL' ? {} : { status: filter });
      setRuns(res.runs);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to load runs.');
    }
  }, [filter]);

  const sortedRuns = useMemo(() => {
    if (!runs) return null;
    const arr = [...runs];
    arr.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case 'periodEnd':
          cmp = a.periodEnd.localeCompare(b.periodEnd);
          break;
        case 'totalGross':
          cmp = a.totalGross - b.totalGross;
          break;
        case 'totalNet':
          cmp = a.totalNet - b.totalNet;
          break;
        case 'itemCount':
          cmp = a.itemCount - b.itemCount;
          break;
        case 'status':
          cmp = a.status.localeCompare(b.status);
          break;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return arr;
  }, [runs, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'periodEnd' || key === 'totalGross' || key === 'totalNet' || key === 'itemCount' ? 'desc' : 'asc');
    }
  };

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
          CTA. Hidden when there is neither a schedule nor a prior run.
          Wave 9 — when a DRAFT already exists for the upcoming period,
          the CTA flips to "Resume" and deep-links to the drawer instead
          of opening the wizard. */}
      <PayrollHero
        upcoming={upcoming}
        loading={upcomingLoading}
        canProcess={canProcess}
        onStartRun={() => setShowCreate(true)}
        onResumeRun={(id) => openRun(id)}
        onOpenLastRun={(id) => openRun(id)}
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

      {/* Wave 9 — runs presented as a sortable table. Clicking a row
          opens the detail drawer; columns mirror QBO's Run history list. */}
      <Card>
        <CardHeader>
          <CardTitle>Runs</CardTitle>
        </CardHeader>
        <CardContent>
          {!sortedRuns && (
            <div className="space-y-2">
              <Skeleton className="h-9" />
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-12" />
              ))}
            </div>
          )}
          {sortedRuns && sortedRuns.length === 0 && (
            <EmptyState
              icon={FileText}
              title={
                filter === 'ALL'
                  ? 'No payroll runs yet'
                  : `No ${filter.toLowerCase()} runs`
              }
              description={
                filter === 'ALL'
                  ? 'Run payroll to create your first paystub batch.'
                  : 'Switch to a different status, or create a new run.'
              }
              action={
                canProcess ? (
                  <Button onClick={() => setShowCreate(true)}>
                    <Plus className="h-4 w-4" />
                    Run payroll
                  </Button>
                ) : undefined
              }
            />
          )}
          {sortedRuns && sortedRuns.length > 0 && (
            <>
              {/* md+ : columnar table with sortable headers. */}
              <div className="hidden md:block">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <SortableTh
                        label="Period"
                        sortKey="periodEnd"
                        activeKey={sortKey}
                        activeDir={sortDir}
                        onClick={toggleSort}
                      />
                      <SortableTh
                        label="Status"
                        sortKey="status"
                        activeKey={sortKey}
                        activeDir={sortDir}
                        onClick={toggleSort}
                      />
                      <SortableTh
                        label="Paystubs"
                        sortKey="itemCount"
                        activeKey={sortKey}
                        activeDir={sortDir}
                        onClick={toggleSort}
                        align="right"
                      />
                      <SortableTh
                        label="Gross"
                        sortKey="totalGross"
                        activeKey={sortKey}
                        activeDir={sortDir}
                        onClick={toggleSort}
                        align="right"
                      />
                      <SortableTh
                        label="Net"
                        sortKey="totalNet"
                        activeKey={sortKey}
                        activeDir={sortDir}
                        onClick={toggleSort}
                        align="right"
                      />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sortedRuns.map((r) => (
                      <TableRow
                        key={r.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => openRun(r.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            openRun(r.id);
                          }
                        }}
                        className={cn(
                          'cursor-pointer focus:outline-none focus-visible:bg-navy-secondary/50',
                          selected?.id === r.id && 'bg-gold/5'
                        )}
                      >
                        <TableCell>
                          <div className="text-white tabular-nums">
                            {r.periodStart} → {r.periodEnd}
                          </div>
                          {r.clientName && (
                            <div className="text-[11px] text-silver/60 mt-0.5">
                              {r.clientName}
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant={RUN_STATUS_VARIANT[r.status]}>{r.status}</Badge>
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-silver">
                          {r.itemCount}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-silver">
                          {fmtMoney(r.totalGross)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-gold">
                          {fmtMoney(r.totalNet)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Phone: card stack. Same default sort (periodEnd desc); the
                  sortable headers are desktop-only — on mobile we rely on
                  the status filter buttons above for the common "show me
                  drafts" / "show me disbursed" cuts. */}
              <ul className="md:hidden space-y-2">
                {sortedRuns.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => openRun(r.id)}
                      className={cn(
                        'w-full text-left rounded-md border bg-navy/40 p-3 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright',
                        selected?.id === r.id
                          ? 'border-gold/40 bg-gold/5'
                          : 'border-navy-secondary hover:border-silver/40'
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="text-sm text-white tabular-nums">
                            {r.periodStart} → {r.periodEnd}
                          </div>
                          {r.clientName && (
                            <div className="text-[11px] text-silver/60 mt-0.5 truncate">
                              {r.clientName}
                            </div>
                          )}
                        </div>
                        <Badge variant={RUN_STATUS_VARIANT[r.status]} className="shrink-0">
                          {r.status}
                        </Badge>
                      </div>
                      <div className="mt-2 flex items-end justify-between gap-3">
                        <div className="text-[11px] text-silver/70">
                          {r.itemCount} paystub{r.itemCount === 1 ? '' : 's'} · gross{' '}
                          <span className="tabular-nums text-silver">
                            {fmtMoney(r.totalGross)}
                          </span>
                        </div>
                        <div className="text-right">
                          <div className="text-[10px] uppercase tracking-widest text-silver/50">
                            Net
                          </div>
                          <div className="tabular-nums text-gold text-base">
                            {fmtMoney(r.totalNet)}
                          </div>
                        </div>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            </>
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
              {/* Wave 9 — QBO-style status progress bar shown across the top
                  of the drawer. Tracks the run state through the four
                  human-meaningful checkpoints. */}
              <RunStatusStepper
                status={selected.status}
                qboSynced={!!selected.qboJournalEntryId}
              />

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-5 mb-5 text-sm">
                <DrawerStat label="Gross" value={fmtMoney(selected.totalGross)} />
                <DrawerStat label="Tax" value={`−${fmtMoney(selected.totalTax)}`} />
                <DrawerStat
                  label="Net"
                  value={fmtMoney(selected.totalNet)}
                  highlight
                />
                <DrawerStat
                  label="Employer cost"
                  value={fmtMoney(selected.totalEmployerTax)}
                  hint="FICA + Medicare match + FUTA + SUTA"
                />
              </div>

              {selected.items.length === 0 && (
                <EmptyState
                  icon={FileText}
                  title="No paystubs in this run"
                  description="No approved time entries fell inside this period."
                />
              )}
              {selected.items.length > 0 && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-[10px] uppercase tracking-widest text-silver/50">
                      Paystubs ({selected.items.length})
                    </div>
                    {selected.items.some((it) => it.status === 'HELD') && (
                      <Badge variant="destructive" className="text-[10px]">
                        {selected.items.filter((it) => it.status === 'HELD').length} held
                      </Badge>
                    )}
                  </div>
                  <ul className="space-y-1.5">
                    {selected.items.map((it) => (
                      <PaystubAdminCard
                        key={it.id}
                        item={it}
                        canProcess={canProcess}
                        onEnrollBranch={() =>
                          setEnrollFor({
                            id: it.associateId,
                            name: it.associateName,
                          })
                        }
                      />
                    ))}
                  </ul>
                </div>
              )}

              {(selected.qboJournalEntryId || selected.qboSyncError) && (
                <div className="mt-5 rounded border border-silver/15 bg-black/30 p-3 text-xs">
                  <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-silver/50 mb-1.5">
                    <LinkIcon className="h-3 w-3" />
                    QuickBooks sync
                  </div>
                  {selected.qboJournalEntryId && (
                    <div className="text-silver">
                      JournalEntry{' '}
                      <span className="font-mono text-white">
                        {selected.qboJournalEntryId}
                      </span>
                      {selected.qboSyncedAt && (
                        <> — synced {new Date(selected.qboSyncedAt).toLocaleString()}</>
                      )}
                    </div>
                  )}
                  {selected.qboSyncError && (
                    <div className="text-alert mt-1">
                      Last sync error: {selected.qboSyncError}
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
  onResumeRun,
  onOpenLastRun,
}: {
  upcoming: PayrollUpcomingSummary | null;
  loading: boolean;
  canProcess: boolean;
  onStartRun: () => void;
  onResumeRun: (id: string) => void;
  onOpenLastRun: (id: string) => void;
}) {
  if (loading) {
    return <PayrollHeroSkeleton />;
  }
  if (!upcoming) return null;
  const nr = upcoming.nextRun;
  const lr = upcoming.lastRun;
  // Hide the hero outright when there is nothing to show — keeps the page
  // clean for fresh installs that haven't created a schedule yet.
  if (!nr && !lr) return null;

  const isResume = !!nr?.draftRunId;

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
                {isResume ? 'Resume in-progress run' : 'Next pay date'}
              </div>
              <div className="text-2xl text-white font-medium tabular-nums">
                {fmtPayDate(nr.payDate)}
              </div>
              <div className="text-xs text-silver/70 mt-1">
                {nr.scheduleName} · {nr.frequency.toLowerCase()} ·{' '}
                {nr.periodStart} → {nr.periodEnd}
                {nr.clientName ? ` · ${nr.clientName}` : ''}
              </div>
              <div className="mt-4 grid grid-cols-3 gap-2 sm:gap-3 text-xs">
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
              <Button
                onClick={() => (isResume ? onResumeRun(nr.draftRunId!) : onStartRun())}
                className="shrink-0"
              >
                <Play className="h-4 w-4" />
                {isResume ? 'Resume run' : 'Run payroll'}
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

/**
 * Wave 9 — Skeleton shaped like the actual hero so layout doesn't reflow
 * when data arrives. Two-column on lg, identical heights.
 */
function PayrollHeroSkeleton() {
  return (
    <div className="mb-5 grid grid-cols-1 lg:grid-cols-3 gap-3">
      <div className="lg:col-span-2 rounded-lg border border-silver/15 bg-black/30 p-5 space-y-3">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-7 w-44" />
        <Skeleton className="h-3 w-72" />
        <div className="grid grid-cols-3 gap-3 pt-3">
          <Skeleton className="h-9" />
          <Skeleton className="h-9" />
          <Skeleton className="h-9" />
        </div>
      </div>
      <div className="rounded-lg border border-silver/15 bg-black/30 p-5 space-y-3">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-5 w-20" />
        <Skeleton className="h-7 w-24" />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 *  Wave 9 — Sortable table header.
 *
 *  Click toggles direction on the active column, switches to the new key
 *  with a sensible default direction otherwise.
 * -------------------------------------------------------------------------- */

function SortableTh({
  label,
  sortKey,
  activeKey,
  activeDir,
  onClick,
  align = 'left',
}: {
  label: string;
  sortKey: SortKey;
  activeKey: SortKey;
  activeDir: SortDir;
  onClick: (key: SortKey) => void;
  align?: 'left' | 'right';
}) {
  const isActive = activeKey === sortKey;
  return (
    <TableHead className={align === 'right' ? 'text-right' : ''}>
      <button
        type="button"
        onClick={() => onClick(sortKey)}
        className={cn(
          'inline-flex items-center gap-1 text-[10px] uppercase tracking-widest transition-colors',
          'focus:outline-none focus-visible:text-gold',
          isActive ? 'text-gold' : 'text-silver/60 hover:text-silver'
        )}
      >
        {label}
        {isActive ? (
          <ArrowDownUp
            className={cn(
              'h-3 w-3 transition-transform',
              activeDir === 'asc' && 'rotate-180'
            )}
          />
        ) : (
          <ArrowUpDown className="h-3 w-3 opacity-40" />
        )}
      </button>
    </TableHead>
  );
}

/* -------------------------------------------------------------------------- *
 *  Wave 9 — Run status stepper.
 *
 *  4 checkpoints rendered as connected dots: Draft → Finalized → Disbursed
 *  → Synced. Reflects what's actually visible in the run row, not the
 *  internal database statuses.
 * -------------------------------------------------------------------------- */

const STEPPER_STAGES = ['DRAFT', 'FINALIZED', 'DISBURSED'] as const;
type StepperStage = (typeof STEPPER_STAGES)[number] | 'SYNCED';

function RunStatusStepper({
  status,
  qboSynced,
}: {
  status: PayrollRunStatus;
  qboSynced: boolean;
}) {
  if (status === 'CANCELLED') {
    return (
      <div className="rounded border border-alert/30 bg-alert/5 p-3 text-xs text-alert flex items-center gap-2">
        <Circle className="h-3.5 w-3.5 fill-alert text-alert" />
        Run cancelled. No paystubs will disburse.
      </div>
    );
  }
  const stages: { key: StepperStage; label: string }[] = [
    { key: 'DRAFT', label: 'Draft' },
    { key: 'FINALIZED', label: 'Finalized' },
    { key: 'DISBURSED', label: 'Disbursed' },
    { key: 'SYNCED', label: 'Synced to QBO' },
  ];
  const reachedIdx = (() => {
    if (qboSynced) return 3;
    if (status === 'DISBURSED') return 2;
    if (status === 'FINALIZED') return 1;
    return 0;
  })();
  return (
    <ol className="flex items-center gap-1 sm:gap-2">
      {stages.map((s, i) => {
        const reached = i <= reachedIdx;
        const current = i === reachedIdx;
        return (
          <li key={s.key} className="flex items-center gap-1 sm:gap-2 flex-1">
            <div className="flex flex-col items-center min-w-0">
              <span
                className={cn(
                  'inline-flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-medium transition-colors',
                  reached ? 'bg-gold text-black' : 'bg-silver/10 text-silver/50',
                  current && 'ring-2 ring-gold/30 ring-offset-2 ring-offset-navy'
                )}
              >
                {reached && i < reachedIdx ? '✓' : i + 1}
              </span>
              <span
                className={cn(
                  'mt-1 text-[10px] uppercase tracking-widest text-center truncate max-w-[80px]',
                  reached ? 'text-silver' : 'text-silver/40'
                )}
              >
                {s.label}
              </span>
            </div>
            {i < stages.length - 1 && (
              <span
                className={cn(
                  'flex-1 h-px transition-colors mb-4',
                  i < reachedIdx ? 'bg-gold/50' : 'bg-silver/15'
                )}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

/* -------------------------------------------------------------------------- *
 *  Wave 9 — Drawer stat with optional hint.
 * -------------------------------------------------------------------------- */

function DrawerStat({
  label,
  value,
  highlight,
  hint,
}: {
  label: string;
  value: string;
  highlight?: boolean;
  hint?: string;
}) {
  return (
    <div className={cn('rounded border px-3 py-2', highlight ? 'border-gold/40 bg-gold/5' : 'border-silver/15 bg-black/30')}>
      <div
        className={cn(
          'text-[10px] uppercase tracking-widest',
          highlight ? 'text-gold' : 'text-silver/60'
        )}
        title={hint}
      >
        {label}
      </div>
      <div className={cn('mt-0.5 tabular-nums text-base', highlight ? 'text-gold' : 'text-white')}>
        {value}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 *  Wave 9 — Per-paystub admin card.
 *
 *  Replaces the dense table inside the drawer. Collapsed shows associate +
 *  hours/rate/net + status pill. Expanded drills into earnings, taxes,
 *  garnishments, plus the Branch enrollment quick-action when canProcess.
 * -------------------------------------------------------------------------- */

const PAYSTUB_STATUS_VARIANT: Record<
  string,
  'default' | 'success' | 'pending' | 'destructive'
> = {
  PENDING: 'default',
  DISBURSED: 'success',
  FAILED: 'destructive',
  HELD: 'pending',
};

function PaystubAdminCard({
  item,
  canProcess,
  onEnrollBranch,
}: {
  item: import('@alto-people/shared').PayrollItem;
  canProcess: boolean;
  onEnrollBranch: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const totalTax =
    item.federalWithholding + item.fica + item.medicare + item.stateWithholding;
  return (
    <li
      className={cn(
        'rounded border bg-black/30 transition-colors',
        item.status === 'HELD' || item.status === 'FAILED'
          ? 'border-alert/30'
          : 'border-silver/15 hover:border-silver/30'
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full text-left px-3 py-2.5 flex items-center justify-between gap-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright rounded"
        aria-expanded={expanded}
      >
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-silver/50 shrink-0" />
          ) : (
            <ChevronRight className="h-4 w-4 text-silver/50 shrink-0" />
          )}
          <Avatar name={item.associateName ?? '—'} size="sm" />
          <div className="min-w-0">
            <div className="text-sm text-white truncate">
              {item.associateName ?? '—'}
            </div>
            <div className="text-[11px] text-silver/50 truncate">
              {item.hoursWorked.toFixed(2)} hrs · {fmtMoney(item.hourlyRate)}/hr
              {item.taxState ? ` · ${item.taxState}` : ''}
            </div>
          </div>
          <Badge
            variant={PAYSTUB_STATUS_VARIANT[item.status] ?? 'default'}
            className="text-[10px] shrink-0"
          >
            {item.status}
          </Badge>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[10px] uppercase tracking-widest text-silver/40">Net</div>
          <div className="tabular-nums text-gold">{fmtMoney(item.netPay)}</div>
        </div>
      </button>
      {expanded && (
        <div className="border-t border-silver/10 px-3 py-3 text-[11px] space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <DrillRow label="Gross pay" value={fmtMoney(item.grossPay)} />
              <DrillRow
                label="Federal income tax"
                value={`−${fmtMoney(item.federalWithholding)}`}
              />
              <DrillRow
                label="Social Security (FICA)"
                value={`−${fmtMoney(item.fica)}`}
              />
              <DrillRow label="Medicare" value={`−${fmtMoney(item.medicare)}`} />
              <DrillRow
                label={`State income tax${item.taxState ? ` (${item.taxState})` : ''}`}
                value={`−${fmtMoney(item.stateWithholding)}`}
              />
              {item.postTaxDeductions > 0 && (
                <DrillRow
                  label="Garnishments"
                  value={`−${fmtMoney(item.postTaxDeductions)}`}
                  accent
                />
              )}
              <DrillRow
                label="Total tax"
                value={`−${fmtMoney(totalTax)}`}
                muted
              />
              <DrillRow label="Net pay" value={fmtMoney(item.netPay)} bold accent />
            </div>
            <div className="space-y-1">
              <div className="text-[10px] uppercase tracking-widest text-silver/50 mb-1">
                Employer cost
              </div>
              <DrillRow
                label="FICA match"
                value={fmtMoney(item.employerFica)}
                muted
              />
              <DrillRow
                label="Medicare match"
                value={fmtMoney(item.employerMedicare)}
                muted
              />
              <DrillRow
                label="FUTA"
                value={fmtMoney(item.employerFuta)}
                muted
              />
              <DrillRow
                label="SUTA"
                value={fmtMoney(item.employerSuta)}
                muted
              />
              <DrillRow
                label="Total"
                value={fmtMoney(
                  item.employerFica +
                    item.employerMedicare +
                    item.employerFuta +
                    item.employerSuta
                )}
                bold
              />
              <div className="text-[10px] uppercase tracking-widest text-silver/50 mt-3 mb-1">
                YTD (before this run)
              </div>
              <DrillRow
                label="YTD wages"
                value={fmtMoney(item.ytdWages)}
                muted
              />
              <DrillRow
                label="YTD Medicare wages"
                value={fmtMoney(item.ytdMedicareWages)}
                muted
              />
            </div>
          </div>

          {item.failureReason && (
            <div className="rounded border border-alert/30 bg-alert/5 px-2 py-1.5 text-alert">
              {item.failureReason}
            </div>
          )}
          {item.disbursementRef && (
            <div className="text-silver/60">
              Disbursement ref:{' '}
              <span className="font-mono text-silver">{item.disbursementRef}</span>
            </div>
          )}

          {canProcess && (
            <div className="pt-1 border-t border-silver/10">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onEnrollBranch();
                }}
                className="inline-flex items-center gap-1.5 text-xs text-silver/70 hover:text-gold focus:outline-none focus-visible:text-gold"
              >
                <CreditCard className="h-3.5 w-3.5" />
                Manage Branch enrollment
              </button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function DrillRow({
  label,
  value,
  accent,
  bold,
  muted,
}: {
  label: string;
  value: string;
  accent?: boolean;
  bold?: boolean;
  muted?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className={cn(muted ? 'text-silver/50' : 'text-silver/70')}>{label}</span>
      <span
        className={cn(
          'tabular-nums',
          bold && 'font-medium',
          accent ? 'text-gold' : muted ? 'text-silver/70' : 'text-white'
        )}
      >
        {value}
      </span>
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

