import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DisburseFacts, useDisbursePreview } from './DisburseFacts';
import { MissedPaydaysStrip } from './MissedPaydaysStrip';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { quoteGrossUp } from '@/lib/payExpApi';
import { Link, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  Ban,
  Banknote,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  CreditCard,
  Download,
  FileText,
  Pencil,
  Play,
  Plus,
  RotateCw,
  Scale,
  Send,
  Landmark,
  MoreHorizontal,
  ShieldAlert,
  ShieldCheck,
  Users,
  X,
  PlaneTakeoff,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';
import { getFinancialChangesSummary } from '@/lib/financialChangesApi';
import type {
  PayrollRunDetail,
  PayrollRunStatus,
  PayrollRunSummary,
  PayrollUpcomingSummary,
} from '@alto-people/shared';
import {
  addRunAddOn,
  deletePayrollRun,
  deleteRunAddOn,
  disbursePayrollRun,
  downloadCheckRegister,
  finalizePayrollRun,
  getPayrollConfig,
  getPayrollRun,
  getPayrollUpcoming,
  getWcPremium,
  listPayrollExceptions,
  listPayrollRuns,
  listPayrollSchedules,
  listRunAddOns,
  retryRunFailures,
  voidPayrollRun,
  type RunAddOn,
  type RunAddOnKind,
  type WcPremiumReport,
} from '@/lib/payrollApi';
import { getPayrollReviewStatus } from '@/lib/payrollReviewApi';
import { clearPayByCheck, getRunChecks, setPayByCheck } from '@/lib/paperChecksApi';
import { AssociatePicker, type PickedAssociate } from '@/components/ui/AssociatePicker';
import { useConfirm, usePrompt } from '@/lib/confirm';
import { Select } from '@/components/ui/Select';
import { AmendPayrollWizard } from './AmendPayrollWizard';
import { BranchEnrollmentDialog } from './BranchEnrollmentDialog';
import { RunPayrollWizard, type RunPayrollSeed } from './RunPayrollWizard';
import { ExceptionStrip } from './PayrollExceptionStrip';
import { fundingSentence, getRunFunding } from '@/lib/bankingApi';
import { PayrollCostChart } from './PayrollCostChart';
import { listPaySchedulesForFlow, PAY_SCHEDULES_FLOW_KEY, type PayrollUpcomingWithSchedules, type UpcomingBySchedule } from '@/lib/payScheduleFlowApi';
import { WebhookHealthTile } from './WebhookHealthTile';
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
import { RunTaxBreakdown } from '@/components/payroll/RunTaxBreakdown';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { Input, Textarea } from '@/components/ui/Input';
import { ListTemplate } from '@/components/templates';
import { Skeleton } from '@/components/ui/Skeleton';
import { DataGrid } from '@/components/ui/DataGrid';
import { toast } from '@/components/ui/Toaster';
import { cn } from '@/lib/cn';
import { associatePhotoUrl } from '@/lib/photoUrl';
import { fmtDate, fmtDateTime, fmtMoney, parseYmd } from '@/lib/format';
import { StatusBadge } from '@/lib/status';
import { useTerm } from '@/lib/auth';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { performWithUndo } from '@/lib/undoToast';
import { pickOne } from '@/lib/validationCopy';
import { FilterChip } from '@/components/ui/FilterBar';
import { RunTotalsMismatch } from '@/components/payroll/RunTotalsMismatch';
import { RunStatusBadge, paycheckStatusLabel, paycheckStatusTone, runStatusLabel } from '@/lib/payrollRunStatus';

/** "May 13, 2026 → May 26, 2026" — the run period, parsed as local days. */
const fmtPeriod = (startYmd: string, endYmd: string) =>
  `${fmtDate(parseYmd(startYmd))} → ${fmtDate(parseYmd(endYmd))}`;

const STATUS_FILTERS: Array<{ value: PayrollRunStatus | 'ALL' | 'OPEN'; label: MessageKey }> = [
  // Draft and finalized: the runs still moving — the default view (finance walk 10).
  { value: 'OPEN', label: 'payrollHome.statusOpen' },
  { value: 'DRAFT', label: 'payrollHome.statusDraft' },
  { value: 'FINALIZED', label: 'payrollHome.statusFinalized' },
  { value: 'DISBURSED', label: 'payrollHome.statusDisbursed' },
  { value: 'CANCELLED', label: 'payrollHome.statusCancelled' },
  { value: 'ALL', label: 'payrollHome.statusAll' },
];

// FINALIZED is domain-only (not in the shared vocabulary): the run is
// computed but money hasn't moved, so it reads amber like other wait states.
// DRAFT / DISBURSED / CANCELLED come from the shared status vocabulary.


interface AdminPayrollViewProps {
  canProcess: boolean;
  /** Gap 3 — void:payroll. HR Admin only; gates void + amend buttons. */
  canVoid: boolean;
}


// Gap 3 — voids are only allowed within this window post-disbursement.
// Mirrors the server-side guard in POST /payroll/runs/:id/void; UI hides
// the affordance instead of letting the user click and 409.
const VOID_WINDOW_DAYS = 30;

// Run-detail drawer renders this many paystub cards up front; a "Show
// all N" button opts into the rest. A 1,000-item run otherwise mounts
// 1,000 expandable cards the moment the drawer opens.
const PAYSTUB_PAGE = 100;

/**
 * Run `task` over `items` with at most `limit` requests in flight,
 * Promise.allSettled-style: never throws, every item gets a settled
 * result in input order. Used by the bulk run actions so a 30-run
 * finalize isn't 30 sequential round-trips (each run is independent —
 * per-run server work doesn't race across different run ids).
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const i = nextIndex++;
        try {
          results[i] = { status: 'fulfilled', value: await task(items[i]!) };
        } catch (reason) {
          results[i] = { status: 'rejected', reason };
        }
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/**
 * The typed-confirmation string the HR Admin must enter to void a run —
 * "MM/DD/YYYY - MM/DD/YYYY" (start - end). Required by product spec for
 * destructive financial operations: a yes/no confirmation isn't enough.
 */
function expectedVoidConfirmation(periodStartYmd: string, periodEndYmd: string): string {
  // periodStartYmd / periodEndYmd are 'YYYY-MM-DD' strings from the API.
  const fmt = (s: string) => {
    const [y, m, d] = s.split('-');
    return `${m}/${d}/${y}`;
  };
  return `${fmt(periodStartYmd)} - ${fmt(periodEndYmd)}`;
}

export function AdminPayrollView({ canProcess, canVoid }: AdminPayrollViewProps) {
  const { t } = useI18n();
  const term = useTerm();
  // The Finance queue's open count rides on the header link.
  const financialChanges = useQuery({
    queryKey: ['AdminPayrollView', 'financialChangesSummary'],
    queryFn: () => getFinancialChangesSummary(),
    enabled: canProcess,
    refetchInterval: 120_000,
  });
  const openChanges = financialChanges.data?.open ?? 0;
  const [tab, setTab] = useState<'runs'>('runs');
  const [filter, setFilter] = useState<PayrollRunStatus | 'ALL' | 'OPEN'>('OPEN');
  // The default "Open" view falls back to All, once, when nothing is open.
  const openFellBack = useRef(false);
  const [selected, setSelected] = useState<PayrollRunDetail | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  // Hero-CTA prefill for the wizard; null = generic "New run" (full flow).
  const [wizardSeed, setWizardSeed] = useState<RunPayrollSeed | null>(null);
  const [confirmDisburse, setConfirmDisburse] = useState(false);
  // Gap 3 — void confirmation modal. The user has to type the run's pay
  // period in MM/DD/YYYY - MM/DD/YYYY format AND supply a free-text
  // reason before the Void button enables. A yes/no confirmation isn't
  // enough for a destructive financial operation.
  const [voidOpen, setVoidOpen] = useState(false);
  const [voidPeriodInput, setVoidPeriodInput] = useState('');
  const [voidReasonInput, setVoidReasonInput] = useState('');
  const [amendOpen, setAmendOpen] = useState(false);
  const [confirmFinalize, setConfirmFinalize] = useState(false);
  const [busy, setBusy] = useState(false);
  const [enrollFor, setEnrollFor] = useState<{ id: string; name: string | null } | null>(null);
  // Stable identity so the memoized PaystubAdminCards don't all re-render
  // whenever the drawer's parent state changes.
  const openEnrollBranch = useCallback(
    (associateId: string, associateName: string | null) =>
      setEnrollFor({ id: associateId, name: associateName }),
    [],
  );
  // Paystub list pagination — show the first PAYSTUB_PAGE cards, with an
  // explicit opt-in to mount the rest. Reset per run.
  const [showAllPaystubs, setShowAllPaystubs] = useState(false);
  // Four-eyes config flag — when true, Disburse is gated on approvedAt.
  // Read once; a failed read just leaves the gate off (server still
  // enforces it with a 409).
  const configQuery = useQuery({ queryKey: ['payroll', 'config'], queryFn: () => getPayrollConfig() });
  // Now: a signed review report before payout (the pre-payroll review).
  const requireSecondApproval = Boolean(configQuery.data?.requireSecondApproval);
  // Where the open run's sign-off stands: none, current, or stale (numbers changed since).
  const reviewStatus = useQuery({
    queryKey: ['payroll', 'review-status', selected?.id],
    queryFn: () => getPayrollReviewStatus(selected!.id),
    enabled: !!selected && (selected.status === 'DRAFT' || selected.status === 'FINALIZED'),
  });
  const signoff = reviewStatus.data?.signoff ?? null;
  const reviewBlocksPayout = !!signoff && signoff.required && !signoff.current;
  // The disburse dialog's facts: provider status, split by method, arrival, funding (finance walk 12).
  const disbursePreview = useDisbursePreview(selected?.id ?? null, confirmDisburse && canProcess);
  // On the company's own ACH the money has to arrive before pay goes out
  // (the server refuses otherwise) — said before the ceremony, not after.
  const runFunding = useQuery({
    queryKey: ['payroll-banking', 'run', selected?.id],
    queryFn: () => getRunFunding(selected!.id),
    enabled: !!selected && selected.status === 'FINALIZED' && canProcess,
    retry: false,
  });
  const fundingNote =
    runFunding.data?.applies && runFunding.data.funding && !['SETTLED', 'WIRE_RECEIVED'].includes(runFunding.data.funding.status)
      ? fundingSentence(runFunding.data.funding)
      : null;
  // Bulk actions over the runs table.
  const [bulkSelected, setBulkSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const confirm = useConfirm();
  const prompt = usePrompt();
  const queryClient = useQueryClient();
  // Who is paid by paper check this time (lib/paperChecks), keyed by paycheck.
  const runChecks = useQuery({
    queryKey: ['payroll', 'checks', selected?.id],
    queryFn: () => getRunChecks(selected!.id),
    enabled: !!selected && canProcess,
  });
  const paperCheckByItem = useMemo(() => new Map((runChecks.data?.overrides ?? []).map((o) => [o.itemId, o])), [runChecks.data]);
  const onPayByCheck = useCallback(
    async (itemId: string, name: string | null, on: boolean) => {
      if (on) {
        const reason = await prompt({
          title: `Pay ${name ?? 'this person'} by paper check this time?`,
          description: 'Only this paycheck. Their direct deposit stays on file and resumes next payday. The check is numbered at payout and never goes into the bank file.',
          confirmLabel: 'Pay by check',
          reasonLabel: 'Why a check this time?',
          reasonPlaceholder: 'Asked for a check this payday',
        });
        if (!reason) return;
        try {
          await setPayByCheck(itemId, reason);
          toast.success(`${name ?? 'This paycheck'} will be paid by paper check.`);
        } catch (err) {
          toast.error(err instanceof ApiError ? err.message : 'Could not switch to a check.');
        }
      } else {
        try {
          await clearPayByCheck(itemId);
          toast.success(`${name ?? 'This paycheck'} is back to the usual deposit.`);
        } catch (err) {
          toast.error(err instanceof ApiError ? err.message : 'Could not undo.');
        }
      }
      void queryClient.invalidateQueries({ queryKey: ['payroll', 'checks'] });
    },
    [prompt, queryClient],
  );

  const runsQuery = useQuery({
    queryKey: ['payroll', 'runs', filter],
    queryFn: () => listPayrollRuns(filter === 'ALL' ? {} : { status: filter }),
    placeholderData: keepPreviousData,
  });
  const runs: PayrollRunSummary[] | null = runsQuery.data?.runs ?? null;
  useEffect(() => {
    if (filter !== 'OPEN' || openFellBack.current || !runsQuery.isSuccess || runsQuery.isPlaceholderData) return;
    if ((runsQuery.data?.runs.length ?? 0) === 0) {
      openFellBack.current = true;
      setFilter('ALL');
    }
  }, [filter, runsQuery.isSuccess, runsQuery.isPlaceholderData, runsQuery.data]);
  const { refetch: refetchRuns } = runsQuery;
  const refresh = useCallback(async () => {
    await refetchRuns();
  }, [refetchRuns]);
  useEffect(() => {
    if (!runsQuery.error) return;
    toast.error(runsQuery.error instanceof ApiError ? runsQuery.error.message : 'Failed to load runs.');
  }, [runsQuery.error]);

  // Bulk selection — clear when the status filter changes so the action
  // bar never advertises runs that are no longer visible.
  useEffect(() => {
    setBulkSelected(new Set());
  }, [filter]);

  // Eligibility mirrors the drawer's footer buttons: Finalize on DRAFT,
  // Disburse on FINALIZED. Signing off is never a bulk action: each run's
  // review report is read on its own. Runs with no sign-off are skipped at
  // execution time so the toast can count them honestly.
  const bulkEligible = useMemo(() => {
    const sel = (runs ?? []).filter((r) => bulkSelected.has(r.id));
    return {
      finalize: sel.filter((r) => r.status === 'DRAFT'),
      disburse: sel.filter((r) => r.status === 'FINALIZED'),
    };
  }, [runs, bulkSelected]);

  const runBulk = async (action: 'finalize' | 'disburse') => {
    if (bulkBusy) return;
    const label = action === 'finalize' ? 'Finalize' : 'Disburse';
    let targets = bulkEligible[action];
    let skippedApproval = 0;
    if (action === 'disburse' && requireSecondApproval) {
      skippedApproval = targets.filter((r) => !r.approvedAt).length;
      targets = targets.filter((r) => !!r.approvedAt);
    }
    if (targets.length === 0) {
      toast.error(
        skippedApproval > 0
          ? `All ${skippedApproval} eligible run${skippedApproval === 1 ? '' : 's'} need a signed review before disbursing.`
          : `No selected runs are eligible to ${action}.`,
      );
      return;
    }
    const ok = await confirm({
      title: `${label} ${targets.length} run${targets.length === 1 ? '' : 's'}?`,
      description:
        `${targets.length} of ${bulkSelected.size} selected run${bulkSelected.size === 1 ? ' is' : 's are'} eligible and will be processed a few at a time.` +
        (skippedApproval > 0
          ? ` ${skippedApproval} will be skipped: ${skippedApproval === 1 ? 'it needs' : 'they need'} a signed review first.`
          : ''),
      confirmLabel: `${label} (${targets.length})`,
      destructive: action === 'disburse',
    });
    if (!ok) return;
    setBulkBusy(true);
    // Bounded concurrency (4 in flight) — each target is a distinct run,
    // so the requests are independent; allSettled semantics keep the
    // succeeded/failed tallies identical to the old sequential loop.
    const results = await mapWithConcurrency(targets, 4, (r) => {
      if (action === 'finalize') return finalizePayrollRun(r.id);
      return disbursePayrollRun(r.id);
    });
    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.length - succeeded;
    setBulkBusy(false);
    setBulkSelected(new Set());
    refresh();
    const parts = [`${succeeded} succeeded`];
    if (failed > 0) parts.push(`${failed} failed`);
    if (skippedApproval > 0)
      parts.push(`${skippedApproval} skipped (needs second approval)`);
    (failed > 0 ? toast.error : toast.success)(`${label}: ${parts.join(' · ')}.`);
  };

  // Wave 8 — hero summary card, from /payroll/upcoming. Non-fatal: a
  // failed read renders the hero empty rather than toasting on the landing
  // page — the runs list is still useful when /upcoming 500s.
  const upcomingQuery = useQuery({ queryKey: ['payroll', 'upcoming'], queryFn: () => getPayrollUpcoming() });
  const upcoming: PayrollUpcomingWithSchedules | null = upcomingQuery.isError
    ? { nextRun: null, lastRun: null }
    : (upcomingQuery.data ?? null);
  const upcomingLoading = upcomingQuery.isPending;
  const { refetch: refetchUpcoming } = upcomingQuery;
  const refreshUpcoming = useCallback(async () => {
    await refetchUpcoming();
  }, [refetchUpcoming]);
  useEffect(() => {
    if (upcomingQuery.error) console.warn('payroll upcoming fetch failed:', upcomingQuery.error);
  }, [upcomingQuery.error]);

  // The WC premium report rides along with a DISBURSED run in the drawer.
  const wcQuery = useQuery({
    queryKey: ['payroll', 'wc-premium', selected?.id ?? ''],
    queryFn: () => getWcPremium(selected!.id),
    enabled: selected?.status === 'DISBURSED',
  });
  const wcReport: WcPremiumReport | null =
    selected?.status === 'DISBURSED' && !wcQuery.isError ? (wcQuery.data ?? null) : null;

  // Deeplink + recoverability — ?run={id} lands HR on the run drawer
  // (e.g. payroll failure → /payroll?run=xxx) and STAYS in the URL while
  // the drawer is open. Leaving to fix a failed payment (on /people) and
  // pressing Back — or refreshing — reopens the same run instead of a
  // reset /payroll. The param is removed (replace) only when the drawer
  // actually closes.
  const [searchParams, setSearchParams] = useSearchParams();
  const runParam = searchParams.get('run');
  // True once the drawer has actually been open — distinguishes "user
  // closed it" (strip ?run) from "initial deep-link read still in
  // flight" (keep ?run).
  const drawerWasOpenRef = useRef(false);
  // One read per param value, through the cache; a failing id is stripped
  // from the URL rather than retried forever.
  const runJump = useQuery({
    queryKey: ['payroll', 'run', runParam ?? ''],
    queryFn: () => getPayrollRun(runParam!),
    enabled: Boolean(runParam) && runParam !== selected?.id,
    retry: false,
  });
  useEffect(() => {
    if (!runParam || runParam === selected?.id) return;
    if (runJump.data && runJump.data.id === runParam) setSelected(runJump.data);
  }, [runParam, selected?.id, runJump.data]);
  useEffect(() => {
    if (!runParam || !runJump.isError) return;
    toast.error(runJump.error instanceof ApiError ? runJump.error.message : 'Failed to open run.');
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('run');
      return next;
    }, { replace: true });
  }, [runParam, runJump.isError, runJump.error, setSearchParams]);

  // URL ↔ drawer sync: reflect the open run in ?run=, drop it on close.
  // Both writes replace — history keeps one /payroll entry, with the param
  // mirroring whatever the drawer shows right now.
  useEffect(() => {
    if (selected) {
      drawerWasOpenRef.current = true;
      if (runParam !== selected.id) {
        setSearchParams((prev) => {
          const next = new URLSearchParams(prev);
          next.set('run', selected.id);
          return next;
        }, { replace: true });
      }
    } else if (drawerWasOpenRef.current) {
      drawerWasOpenRef.current = false;
      if (runParam) {
        setSearchParams((prev) => {
          const next = new URLSearchParams(prev);
          next.delete('run');
          return next;
        }, { replace: true });
      }
    }
  }, [selected, runParam, setSearchParams]);

  // ?next=pay (the review page's "Disburse $X →" after sign-off): once the
  // run is open, go straight to the next step — finalize a draft, then the
  // disburse ceremony; a finalized run opens the ceremony directly.
  const nextParam = searchParams.get('next');
  const payNextRef = useRef<string | null>(null);
  const reviewSettled = !reviewStatus.isPending;
  const fundingSettled = selected?.status !== 'FINALIZED' || !runFunding.isPending;
  useEffect(() => {
    if (nextParam !== 'pay' || !selected || selected.id !== runParam) return;
    // Wait for the sign-off (and, for a finalized run, the funding) to load:
    // the ceremony opens only when the server would let it through.
    if (!reviewSettled || !fundingSettled) return;
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('next');
      return next;
    }, { replace: true });
    if (!canProcess) return;
    if (selected.status === 'DRAFT') {
      payNextRef.current = selected.id;
      setConfirmFinalize(true);
    } else if (selected.status === 'FINALIZED') {
      if (reviewBlocksPayout) toast.error('The sign-off no longer matches this run — the numbers changed. Sign the review again before paying.');
      else if (fundingNote) toast.error(fundingNote);
      else setConfirmDisburse(true);
    }
  }, [nextParam, selected, runParam, canProcess, setSearchParams, reviewSettled, fundingSettled, reviewBlocksPayout, fundingNote]);

  // Closing the finalize dialog without finalizing drops "pay next" — a
  // later ordinary Finalize never opens the ceremony by surprise.
  const closeFinalize = () => {
    payNextRef.current = null;
    setConfirmFinalize(false);
  };

  // ?new=run (⌘K "Run payroll"): open the next payday's run — resume its
  // draft if one exists, else the wizard seeded like the hero's button.
  const newParam = searchParams.get('new');
  // ?new=run&schedule=&from=&to= — the wizard's own links carry this as their
  // way back, so fixing a blocker (add people, approve time, assign a
  // schedule) returns to the same run instead of losing the wizard.
  const seedSchedule = searchParams.get('schedule');
  const seedFrom = searchParams.get('from');
  const seedTo = searchParams.get('to');
  useEffect(() => {
    if (newParam !== 'run') return;
    const explicit = seedSchedule && seedFrom && seedTo ? { scheduleId: seedSchedule, periodStart: seedFrom, periodEnd: seedTo } : null;
    if (!explicit && !upcoming) return;
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const k of ['new', 'schedule', 'from', 'to']) next.delete(k);
      return next;
    }, { replace: true });
    if (!canProcess) return;
    if (explicit) {
      setWizardSeed(explicit);
      setShowCreate(true);
      return;
    }
    const nr = upcoming!.nextRun;
    if (nr?.draftRunId) {
      void openRun(nr.draftRunId);
      return;
    }
    setWizardSeed(nr ? { scheduleId: nr.scheduleId, periodStart: nr.periodStart, periodEnd: nr.periodEnd } : null);
    setShowCreate(true);
    // openRun is a plain function re-created each render; the param drives this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newParam, seedSchedule, seedFrom, seedTo, upcomingQuery.data, upcomingQuery.isError, canProcess, setSearchParams]);

  const openRun = async (id: string) => {
    try {
      const detail = await getPayrollRun(id);
      setSelected(detail);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to load run.');
    }
  };

  const onFinalize = async (acknowledgeBlocking = false) => {
    if (!selected || busy) return;
    setBusy(true);
    try {
      const updated = await finalizePayrollRun(selected.id, { acknowledgeBlocking });
      setSelected(updated);
      toast.success('Run finalized.');
      setConfirmFinalize(false);
      refresh();
      // Came from "Finalize & disburse": the ceremony is next, when signed off.
      if (payNextRef.current === updated.id) {
        payNextRef.current = null;
        if (!reviewBlocksPayout) setConfirmDisburse(true);
      }
    } catch (err) {
      // A blocker that appeared since the run was built: say what it is and
      // let the person go ahead on the record (the server audits it).
      if (err instanceof ApiError && err.code === 'blocking_exceptions' && !acknowledgeBlocking) {
        setBusy(false);
        const goAhead = await confirm({
          title: 'Blocking issues in this run',
          description: `${err.message}`,
          confirmLabel: 'Finalize anyway',
          destructive: true,
        });
        if (goAhead) await onFinalize(true);
        return;
      }
      toast.error(err instanceof ApiError ? err.message : 'Finalize failed.');
    } finally {
      setBusy(false);
    }
  };

  const onDeleteRun = async () => {
    if (!selected || busy) return;
    const reason = await prompt({
      title: `Delete this ${selected.status.toLowerCase()} run?`,
      description:
        `${fmtPeriod(selected.periodStart, selected.periodEnd)} — its ${selected.itemCount} ` +
        `paystub${selected.itemCount === 1 ? '' : 's'} will be removed. This can't be undone — but nothing ` +
        `has been paid out, so you can re-run payroll for the correct period.`,
      confirmLabel: 'Delete run',
      destructive: true,
      reasonLabel: 'Reason (optional)',
      reasonPlaceholder: 'e.g. Created against the wrong pay period.',
      required: false,
    });
    if (reason === null) return;
    setBusy(true);
    try {
      await deletePayrollRun(selected.id, reason.trim() || undefined);
      toast.success('Run deleted.');
      setSelected(null);
      refresh();
      refreshUpcoming();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Delete failed.');
    } finally {
      setBusy(false);
    }
  };

  const onDisburse = async () => {
    if (!selected || busy) return;
    setBusy(true);
    // Keep the modal open until the request returns. Closing it on
    // click loses the only visible signal that something is happening
    // (the button's spinner is now hidden behind a closed dialog); on
    // slow networks the user has clicked Disburse and seen nothing for
    // 5–15 s. We replace the body with an explicit "Processing payouts"
    // copy below.
    try {
      const updated = await disbursePayrollRun(selected.id);
      setSelected(updated);
      // A disbursed run leaves the default Open view: keep a way to it.
      toast.success('Run disbursed.', { action: { label: 'View in All', onClick: () => setFilter('ALL') } });
      refresh();
      setConfirmDisburse(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Disburse failed.');
      // Leave the dialog open on failure so the user can retry without
      // re-traversing the action menu.
    } finally {
      setBusy(false);
    }
  };

  // Retries all failed/held items when itemIds is omitted, or just the
  // given items (single-item and per-reason-group retries in the failed
  // payments card).
  const onRetryFailures = async (itemIds?: string[]) => {
    if (!selected || busy) return;
    setBusy(true);
    try {
      const result = await retryRunFailures(selected.id, itemIds);
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

  const expectedVoidString = selected
    ? expectedVoidConfirmation(selected.periodStart, selected.periodEnd)
    : '';
  const voidPeriodMatches = voidPeriodInput.trim() === expectedVoidString;
  const voidReasonValid = voidReasonInput.trim().length > 0;
  const voidEnabled = voidPeriodMatches && voidReasonValid && !busy;

  const openVoidModal = () => {
    setVoidPeriodInput('');
    setVoidReasonInput('');
    setVoidOpen(true);
  };

  const onVoid = async () => {
    if (!selected || !voidEnabled) return;
    setBusy(true);
    try {
      const updated = await voidPayrollRun(selected.id, voidReasonInput.trim());
      setSelected(updated);
      setVoidOpen(false);
      toast.success('Run voided.');
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Void failed.');
    } finally {
      setBusy(false);
    }
  };

  // Mirrors the server-side 30-day post-disbursement guard. We hide the
  // affordance instead of letting the user click and 409 back.
  const canShowVoidButton =
    !!selected &&
    canVoid &&
    selected.status === 'DISBURSED' &&
    selected.disbursedAt !== null &&
    Date.now() - new Date(selected.disbursedAt).getTime() <
      VOID_WINDOW_DAYS * 24 * 60 * 60 * 1000;

  useEffect(() => {
    setShowAllPaystubs(false);
  }, [selected?.id]);

  // One pass over the run's items for everything the drawer needs from
  // them (held count + the visible page) — previously three inline
  // filter/some passes per render over a possibly 1,000+ item array.
  const paystubView = useMemo(() => {
    const items = selected?.items ?? [];
    let heldCount = 0;
    for (const it of items) if (it.status === 'HELD') heldCount += 1;
    const visible =
      showAllPaystubs || items.length <= PAYSTUB_PAGE
        ? items
        : items.slice(0, PAYSTUB_PAGE);
    return { heldCount, visible };
  }, [selected?.items, showAllPaystubs]);

  // Amendments are allowed against any non-CANCELLED run that has items.
  // Server enforces the same; UI gates on canVoid because amend lives on
  // the same destructive-ops capability.
  const canShowAmendButton =
    !!selected &&
    canVoid &&
    selected.status !== 'CANCELLED' &&
    selected.items.length > 0;

  // Gap 3 follow-up — the void banner's recovery action. Amending a
  // CANCELLED run is server-rejected (POST /runs/:id/amend 409s with
  // 'run_cancelled'; amendments are only allowed against DISBURSED runs),
  // so the documented recovery for a voided run is a FRESH run for the
  // same period. This opens the RunPayrollWizard seeded with the voided
  // run's period, resolving the matching schedule (same client) so step 1
  // is prefilled; with no matching schedule the full flow opens instead.
  const openCorrectedRun = async () => {
    if (!selected || busy) return;
    setBusy(true);
    let scheduleId: string | null = null;
    try {
      const res = await listPayrollSchedules();
      const forClient = res.schedules.filter(
        (s) => (s.clientId ?? null) === (selected.clientId ?? null),
      );
      scheduleId = (forClient.find((s) => s.isActive) ?? forClient[0])?.id ?? null;
    } catch {
      // Non-fatal — the wizard opens unseeded and asks for the schedule.
    }
    setWizardSeed(
      scheduleId
        ? {
            scheduleId,
            periodStart: selected.periodStart,
            periodEnd: selected.periodEnd,
          }
        : null,
    );
    setBusy(false);
    setShowCreate(true);
  };

  return (
    // Design system §4.2 (UX upgrade step 6, the sweep): the List template.
    // The pay-cycle hero is the summary; the tabs are the page's lists.
    <ListTemplate
        title={t('payrollHome.title')}
        subtitle={canProcess ? t('payrollHome.subProcess') : t('payrollHome.subReadOnly')}
        primaryAction={
          canProcess ? (
            // One primary, one desk item while it carries work, and the
            // seven payroll rooms behind one menu: the header used to spend
            // a full row on eight buttons before the first number.
            <div className="flex flex-wrap items-center gap-2">
              {openChanges > 0 && (
                <Button asChild variant="outline" size="sm">
                  <Link to="/payroll/financial-changes">
                    <Landmark className="mr-1 h-4 w-4" />
                    {t('payrollHome.financialChanges')}
                    <span className="ml-1.5 rounded-full bg-alert/20 px-1.5 text-xs font-semibold text-alert">{openChanges}</span>
                  </Link>
                </Button>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" aria-label={t('payrollHome.morePages')}>
                    <MoreHorizontal className="mr-1 h-4 w-4" />
                    {t('payrollHome.more')}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  {openChanges === 0 && (
                    <DropdownMenuItem asChild>
                      <Link to="/payroll/financial-changes">
                        <Landmark className="mr-2 h-4 w-4" />
                        {t('payrollHome.financialChanges')}
                      </Link>
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem asChild>
                    <Link to="/payroll/readiness">
                      <Users className="mr-2 h-4 w-4" />
                      {t('payrollHome.readiness')}
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link to="/payroll/go-live">
                      <PlaneTakeoff className="mr-2 h-4 w-4" />
                      {t('payrollHome.goLive')}
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link to="/payroll/ytd">
                      <FileText className="mr-2 h-4 w-4" />
                      {t('payrollHome.ytd')}
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link to="/payroll/taxes?tab=returns">
                      <FileText className="mr-2 h-4 w-4" />
                      {t('payrollHome.taxForms')}
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link to="/payroll/compliance">
                      <AlertTriangle className="mr-2 h-4 w-4" />
                      {t('payrollHome.compliance')}
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link to="/payroll/labor-rules">
                      <Scale className="mr-2 h-4 w-4" />
                      {t('payrollHome.laborRules')}
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link to="/payroll/year-end-close">
                      <CheckCircle2 className="mr-2 h-4 w-4" />
                      {t('payrollHome.yearEndClose')}
                    </Link>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                onClick={() => {
                  setWizardSeed(null);
                  setShowCreate(true);
                }}
              >
                <Plus className="h-4 w-4" />
                {t('payrollHome.newRun')}
              </Button>
            </div>
          ) : undefined
        }
        summary={
              <>

          {canProcess && (
            <RunPayrollWizard
              open={showCreate}
              onOpenChange={setShowCreate}
              seed={wizardSeed}
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
            onStartRun={(seed) => {
              // Seed the wizard with what the hero already knows — schedule and
              // period — so step 1 never re-asks; a clean preview then collapses
              // the whole flow to one review screen.
              const nr = upcoming?.nextRun;
              setWizardSeed(
                seed ??
                  (nr
                    ? {
                        scheduleId: nr.scheduleId,
                        periodStart: nr.periodStart,
                        periodEnd: nr.periodEnd,
                      }
                    : null),
              );
              setShowCreate(true);
            }}
            onResumeRun={(id) => openRun(id)}
            onOpenLastRun={(id) => openRun(id)}
            onExceptionsChanged={() => void refreshUpcoming()}
          />

          {/* Paydays that passed with no run, and the hours they left unpaid (finance walk 1). */}
          <MissedPaydaysStrip
            canProcess={canProcess}
            focus={searchParams.get('ledger') === 'missed'}
            onPay={(seed) => {
              setWizardSeed(seed);
              setShowCreate(true);
            }}
          />

          <PayrollCostChart onOpenRun={(id) => void openRun(id)} />

          {canProcess && (
            <div className="mb-4">
              <WebhookHealthTile surface="payroll" />
            </div>
          )}

              </>
        }
        drawer={

          <Drawer
            open={selected !== null}
            onOpenChange={(o) => !o && setSelected(null)}
            width="max-w-3xl"
          >
            {selected && (
              <>
                <DrawerHeader>
                  <DrawerTitle>
                    {fmtPeriod(selected.periodStart, selected.periodEnd)}
                  </DrawerTitle>
                  <DrawerDescription>
                    <RunStatusBadge status={selected.status} />
                    <span className="ml-2 text-xs">
                      {selected.items.length} paystub{selected.items.length === 1 ? '' : 's'}
                    </span>
                    {selected.payrollScheduleName && (
                      <span className="ml-2 text-xs">
                        · Pay schedule:{' '}
                        {selected.payrollScheduleId ? (
                          <Link to={`/payroll/schedules/${selected.payrollScheduleId}`} className="text-gold hover:underline">
                            {selected.payrollScheduleName}
                          </Link>
                        ) : (
                          selected.payrollScheduleName
                        )}
                      </span>
                    )}
                  </DrawerDescription>
                </DrawerHeader>
                <DrawerBody>
                  {/* Gap 3 — CANCELLED banner. When the run was voided, surface
                      who/when/why above everything else. */}
                  {selected.status === 'CANCELLED' && (
                    <div className="mb-4 rounded border border-alert/40 bg-alert/5 p-3 text-xs">
                      <div className="flex items-center gap-2 text-alert font-medium mb-1">
                        <Ban className="h-4 w-4" />
                        Run voided
                        {selected.cancelledAt && (
                          <span className="text-silver/70 font-normal">
                            — {fmtDateTime(selected.cancelledAt)}
                          </span>
                        )}
                      </div>
                      {selected.cancelReason && (
                        <div className="text-silver mt-1">
                          <span className="text-silver/70">Reason: </span>
                          {selected.cancelReason}
                        </div>
                      )}
                      <div className="text-silver/70 mt-1.5">
                        Alto did not pull funds back from associates. Recover
                        disbursed amounts out-of-band or via a deduction on the
                        corrected run. A voided run can&apos;t be amended — create
                        a corrected run for the same period instead.
                      </div>
                      {canProcess && (
                        <div className="mt-2">
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={openCorrectedRun}
                            disabled={busy}
                          >
                            <Plus className="h-3.5 w-3.5" />
                            Create corrected run
                          </Button>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Gap 3 — AMENDMENT banner. Shows the link back to the source
                      run + the mandatory reason captured at amend time. */}
                  {selected.kind === 'AMENDMENT' && (
                    <div className="mb-4 rounded border border-warning/30 bg-warning/5 p-3 text-xs">
                      <div className="flex items-center gap-2 text-warning font-medium mb-1">
                        <Pencil className="h-4 w-4" />
                        Amendment run
                      </div>
                      {selected.amendmentReason && (
                        <div className="text-silver mt-1">
                          <span className="text-silver/70">Reason: </span>
                          {selected.amendmentReason}
                        </div>
                      )}
                      {selected.amendsRunId && (
                        <Button
                          variant="link"
                          onClick={() => openRun(selected.amendsRunId!)}
                          className="mt-1 text-xs font-normal text-silver/70 hover:text-gold"
                        >
                          View source run
                        </Button>
                      )}
                    </div>
                  )}

                  {/* The pre-payroll review: where the sign-off stands, so
                      the person paying knows someone read these numbers. */}
                  {signoff?.current ? (
                    <div className="mb-4 flex items-center gap-2 rounded border border-success/30 bg-success/5 p-2.5 text-xs text-success">
                      <ShieldCheck className="h-4 w-4 shrink-0" aria-hidden="true" />
                      Review signed off by {signoff.current.signedByName ?? 'a reviewer'} {fmtDateTime(signoff.current.signedAt)}
                    </div>
                  ) : signoff?.stale ? (
                    <div className="mb-4 flex flex-wrap items-center gap-2 rounded border border-alert/40 bg-alert/5 p-2.5 text-xs text-alert">
                      <ShieldCheck className="h-4 w-4 shrink-0" aria-hidden="true" />
                      The numbers changed after {signoff.stale.signedByName ?? 'the reviewer'} signed off.
                      <Link className="underline underline-offset-2" to={`/payroll/runs/${selected.id}/review`}>
                        Review again
                      </Link>
                    </div>
                  ) : signoff?.required ? (
                    <div className="mb-4 flex flex-wrap items-center gap-2 rounded border border-line bg-surface-raised p-2.5 text-xs text-ink-muted">
                      <ShieldCheck className="h-4 w-4 shrink-0" aria-hidden="true" />
                      Not signed off yet. Someone reads the review report and signs before this run pays.
                      <Link className="text-accent underline underline-offset-2" to={`/payroll/runs/${selected.id}/review`}>
                        Open the report
                      </Link>
                    </div>
                  ) : selected.approvedAt ? (
                    <div className="mb-4 flex items-center gap-2 rounded border border-success/30 bg-success/5 p-2.5 text-xs text-success">
                      <ShieldCheck className="h-4 w-4 shrink-0" aria-hidden="true" />
                      Approved {fmtDateTime(selected.approvedAt)}
                      {selected.approverEmail ? ` by ${selected.approverEmail}` : ''}
                    </div>
                  ) : null}

                  {/* Wave 9 — QBO-style status progress bar shown across the top
                      of the drawer. Tracks the run state through the three
                      human-meaningful checkpoints. */}
                  <RunStatusStepper status={selected.status} lifecycle={runs?.find((r) => r.id === selected.id) ?? null} signedOff={!!signoff?.current} />

                  {/* Draft add-on lines (bonus / commission / tips / PTO). */}
                  {selected.status === 'DRAFT' && canProcess && (
                    <DraftAddOnsSection
                      runId={selected.id}
                      runItems={selected.items}
                      onChanged={async () => {
                        const updated = await getPayrollRun(selected.id);
                        setSelected(updated);
                        refresh();
                      }}
                    />
                  )}

                  {/* Workers-comp premium accrual (disbursed runs). */}
                  {selected.status === 'DISBURSED' && wcReport && wcReport.totalPremium > 0 && (
                    <div className="mt-5 rounded-md border border-navy-secondary bg-navy-secondary/20 p-3">
                      <div className="mb-2 flex items-center justify-between">
                        <div className="text-xs uppercase tracking-wide text-silver">
                          Workers-comp premium (accrual)
                        </div>
                        <div className="text-lg tabular-nums text-white">
                          {fmtMoney(wcReport.totalPremium)}
                        </div>
                      </div>
                      <div className="space-y-1 text-xs">
                        {wcReport.classes.map((c) => (
                          <div key={c.code} className="flex justify-between text-silver">
                            <span>
                              {c.code} · {c.description}{' '}
                              <span className="text-silver/60">@ {c.ratePer100}/100</span>
                            </span>
                            <span className="tabular-nums text-white">{fmtMoney(c.premium)}</span>
                          </div>
                        ))}
                        {wcReport.unclassifiedWages > 0 && (
                          <div className="flex justify-between text-warning">
                            <span>Unclassified wages (no WC class code)</span>
                            <span className="tabular-nums">{fmtMoney(wcReport.unclassifiedWages)}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

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

                  {/* State and local taxes by jurisdiction (lib/taxEngine). */}
                  <RunTaxBreakdown runId={selected.id} />

                  {/* Stored totals that the paychecks don't add up to are said plainly —
                      never explained away as "no approved time" (apps/api/src/lib/payrollRunTotals.ts). */}
                  <RunTotalsMismatch check={selected} />
                  {selected.items.length === 0 && selected.totalsAgree !== false && (
                    <EmptyState
                      icon={FileText}
                      title="No paystubs in this run"
                      description="No approved time entries fell inside this period."
                    />
                  )}
                  <FailedPaymentsSummary
                    items={selected.items}
                    canProcess={canProcess}
                    onRetry={onRetryFailures}
                    onEnrollBranch={openEnrollBranch}
                    busy={busy}
                  />
                  {selected.items.length > 0 && (
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <div className="text-2xs uppercase tracking-widest text-silver/70">
                          Paystubs ({selected.items.length})
                        </div>
                        {paystubView.heldCount > 0 && (
                          <Badge variant="destructive" className="text-2xs">
                            {paystubView.heldCount} held
                          </Badge>
                        )}
                      </div>
                      <ul className="space-y-1.5">
                        {paystubView.visible.map((it) => (
                          <PaystubAdminCard
                            key={it.id}
                            item={it}
                            canProcess={canProcess}
                            onEnrollBranch={openEnrollBranch}
                            paperCheckReason={paperCheckByItem.get(it.id)?.reason ?? null}
                            canSwitchToCheck={canProcess && (selected.status === 'DRAFT' || selected.status === 'FINALIZED') && it.status === 'PENDING'}
                            onPayByCheck={onPayByCheck}
                          />
                        ))}
                      </ul>
                      {paystubView.visible.length < selected.items.length && (
                        <div className="mt-2 flex justify-center">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setShowAllPaystubs(true)}
                          >
                            Show all {selected.items.length}
                          </Button>
                        </div>
                      )}
                    </div>
                  )}

                </DrawerBody>
                {canProcess && (
                  <DrawerFooter className="flex-wrap justify-start">
                    {selected.status !== 'CANCELLED' && (
                      <Button asChild variant="secondary">
                        <Link to={`/payroll/runs/${selected.id}/close`}>Guided close</Link>
                      </Button>
                    )}
                    {selected.status === 'DRAFT' && (
                      <Button onClick={() => setConfirmFinalize(true)} disabled={busy}>
                        <CheckCircle2 className="h-4 w-4" />
                        Finalize
                      </Button>
                    )}
                    {(selected.status === 'FINALIZED' || selected.status === 'DRAFT') && (
                      <Button asChild variant={selected.status === 'FINALIZED' && reviewBlocksPayout ? 'primary' : 'secondary'}>
                        <Link to={`/payroll/runs/${selected.id}/review`}>
                          <ShieldCheck className="h-4 w-4" />
                          {signoff?.current ? 'Review report' : 'Review and sign off'}
                        </Link>
                      </Button>
                    )}
                    {selected.status === 'FINALIZED' &&
                      (reviewBlocksPayout ? (
                        // Honesty gate — the server would 409 the disbursement
                        // anyway; don't let the admin walk the whole ceremony
                        // into it. The Approve button renders right beside this.
                        <Button
                          variant="primary"
                          disabled
                          title="Someone signs off on the review report first"
                        >
                          <Send className="h-4 w-4" />
                          Needs a signed review
                        </Button>
                      ) : (
                        <Button
                          variant="primary"
                          onClick={() => setConfirmDisburse(true)}
                          disabled={busy || !!fundingNote}
                          title={fundingNote ?? undefined}
                        >
                          <Send className="h-4 w-4" />
                          {fundingNote ? 'Waiting on funding' : 'Disburse'}
                        </Button>
                      ))}
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
                    {selected.status === 'DISBURSED' && (
                      <Button
                        variant="secondary"
                        onClick={() =>
                          downloadCheckRegister(selected.id).catch((err) =>
                            toast.error(err instanceof Error ? err.message : 'No checks in this run.'),
                          )
                        }
                        title="Printable register of paper checks issued for this run (if any)"
                      >
                        <FileText className="h-4 w-4" />
                        Check register
                      </Button>
                    )}
                    {(selected.status === 'FINALIZED' || selected.status === 'DISBURSED') &&
                      paystubView.heldCount > 0 && (
                        <Button variant="secondary" onClick={() => onRetryFailures()} loading={busy}>
                          <RotateCw className="h-4 w-4" />
                          Retry failed disbursements
                        </Button>
                      )}
                    {canShowAmendButton && (
                      <Button variant="secondary" onClick={() => setAmendOpen(true)} disabled={busy}>
                        <Pencil className="h-4 w-4" />
                        Amend
                      </Button>
                    )}
                    {canVoid &&
                      (selected.status === 'DRAFT' || selected.status === 'FINALIZED') && (
                        <Button variant="destructive" onClick={onDeleteRun} disabled={busy}>
                          <Ban className="h-4 w-4" />
                          Delete run
                        </Button>
                      )}
                    {canShowVoidButton && (
                      <Button variant="destructive" onClick={openVoidModal} disabled={busy}>
                        <Ban className="h-4 w-4" />
                        Void run
                      </Button>
                    )}
                    {canVoid &&
                      selected.status === 'DISBURSED' &&
                      !canShowVoidButton && (
                        <Button
                          variant="destructive"
                          disabled
                          title={`Runs can only be voided within ${VOID_WINDOW_DAYS} days of disbursement. This one is past that window — issue an amendment instead.`}
                        >
                          <Ban className="h-4 w-4" />
                          Void window closed
                        </Button>
                      )}
                  </DrawerFooter>
                )}
              </>
            )}
          </Drawer>

        }
      >
      <Tabs value={tab} onValueChange={(v) => setTab(v as 'runs')} className="mb-5">
        <div className="flex flex-wrap items-center gap-3">
          <TabsList>
            <TabsTrigger value="runs">{t('payrollHome.tabRuns')}</TabsTrigger>
          </TabsList>
          {/* Garnishments live on their own desk (finance walk 5: one place, not four). */}
          <Link to="/payroll/garnishments" className="text-sm text-accent hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-accent">
            {t('payrollHome.tabGarnishments')} →
          </Link>
          {/* Pay schedules grew into their own page — who is paid when, by client and by face. */}
          <Link to="/payroll/schedules" className="text-sm text-accent hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-accent">
            {t('payrollHome.tabSchedules')} →
          </Link>
        </div>
        <TabsContent value="runs" className="mt-5">

      {/* snap-x snap-mandatory locks each chip to a scroll-stop on
          mobile so a flick doesn't leave a chip half-clipped at the
          edge — feels like a deliberate rail instead of a free scroller. */}
      <div className="-mx-2 mb-5 flex gap-2 overflow-x-auto snap-x snap-mandatory px-2 pb-1 sm:mx-0 sm:flex-wrap sm:px-0 sm:pb-0 sm:snap-none">
        {STATUS_FILTERS.map((f) => (
          <FilterChip
            key={f.value}
            active={filter === f.value}
            onClick={() => setFilter(f.value)}
            className="shrink-0 snap-start sm:px-3 sm:text-sm"
          >
            {t(f.label)}
          </FilterChip>
        ))}
      </div>

      {/* Bulk action bar — appears once any run is checked. Counts on the
          buttons are the ELIGIBLE subset of the selection, mirroring the
          drawer's per-run affordances. */}
      {canProcess && bulkSelected.size > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-gold/30 bg-gold/5 px-3 py-2">
          <span className="text-xs text-silver">
            {bulkSelected.size} selected
          </span>
          <Button
            size="xs"
            variant="secondary"
            onClick={() => runBulk('finalize')}
            disabled={bulkBusy || bulkEligible.finalize.length === 0}
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            Finalize ({bulkEligible.finalize.length})
          </Button>
          <Button
            size="xs"
            variant="secondary"
            onClick={() => runBulk('disburse')}
            disabled={bulkBusy || bulkEligible.disburse.length === 0}
          >
            <Send className="h-3.5 w-3.5" />
            Disburse ({bulkEligible.disburse.length})
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => setBulkSelected(new Set())}
            disabled={bulkBusy}
          >
            Clear
          </Button>
        </div>
      )}

      {/* Wave 9 — runs presented as a sortable table. Clicking a row
          opens the detail drawer; columns mirror QBO's Run history list. */}
      <Card>
        <CardHeader>
          <CardTitle>{t('payrollHome.tabRuns')}</CardTitle>
        </CardHeader>
        <CardContent>
          {!runs && (
            <div className="space-y-2">
              <Skeleton className="h-9" />
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-12" />
              ))}
            </div>
          )}
          {runs && runs.length === 0 && (
            <EmptyState
              icon={FileText}
              title={
                filter === 'ALL'
                  ? t('payrollHome.noRuns')
                  : t('payrollHome.noRunsFiltered', { status: t(STATUS_FILTERS.find((f) => f.value === filter)!.label).toLowerCase() })
              }
              description={filter === 'ALL' ? t('payrollHome.noRunsBody') : t('payrollHome.noRunsFilteredBody')}
              action={
                canProcess ? (
                  <div className="flex flex-wrap items-center justify-center gap-2">
                    <Button onClick={() => setShowCreate(true)}>
                      <Plus className="h-4 w-4" />
                      {t('payrollHome.runPayroll')}
                    </Button>
                    {filter === 'ALL' && (
                      <Button variant="outline" asChild>
                        <Link to="/payroll/readiness">{t('payrollHome.checkReadiness')}</Link>
                      </Button>
                    )}
                  </div>
                ) : undefined
              }
            />
          )}
          {runs && runs.length > 0 && (
            // Newest period first; the headers re-sort. The page's bulk
            // selection drives the checkboxes so the action bar above keeps
            // reading it.
            <DataGrid<NonNullable<typeof runs>[number]>
              id="payroll-runs"
              caption="Payroll runs"
              rows={runs}
              rowKey={(r) => r.id}
              search={false}
              urlState={false}
              exportCsv={{ filename: 'payroll-runs' }}
              defaultSort={{ key: 'period', direction: 'desc' }}
              onRowClick={(r) => void openRun(r.id)}
              rowActionLabel={(r) => `Open run ${fmtPeriod(r.periodStart, r.periodEnd)}`}
              rowClassName={(r) => (selected?.id === r.id ? 'bg-gold/5' : undefined)}
              selectable={canProcess ? { selectAllLabel: 'Select all runs', selection: { selected: bulkSelected, onChange: setBulkSelected } } : undefined}
              columns={[
                {
                  key: 'period',
                  header: 'Period',
                  accessor: (r) => r.periodEnd,
                  csv: (r) => fmtPeriod(r.periodStart, r.periodEnd),
                  sortable: true,
                  searchable: false,
                  primary: true,
                  cell: (r) => (
                    <>
                      <div className="text-white tabular-nums">{fmtPeriod(r.periodStart, r.periodEnd)}</div>
                      {(r.payrollScheduleName || r.clientName) && (
                        <div className="text-xs2 text-silver/70 mt-0.5">
                          {[r.payrollScheduleName, r.clientName].filter(Boolean).join(' · ')}
                        </div>
                      )}
                    </>
                  ),
                },
                { key: 'schedule', header: 'Pay schedule', accessor: (r) => r.payrollScheduleName ?? '', sortable: true, defaultHidden: true, cell: (r) => r.payrollScheduleName ?? '—' },
                { key: 'payday', header: 'Payday', accessor: (r) => r.payDate ?? '', csv: (r) => (r.payDate ? fmtDate(parseYmd(r.payDate)) : ''), sortable: true, searchable: false, cardMeta: true, className: 'tabular-nums text-silver whitespace-nowrap', cell: (r) => (r.payDate ? fmtDate(parseYmd(r.payDate)) : '—') },
                { key: 'kind', header: 'Kind', accessor: (r) => r.kind, sortable: true, cell: (r) => (r.kind === 'REGULAR' ? <span className="text-silver">Regular</span> : <RunKindBadge kind={r.kind} />) },
                {
                  key: 'nextStep',
                  header: 'Next step',
                  accessor: (r) => r.nextStep?.label ?? '',
                  sortable: true,
                  cardMeta: true,
                  cell: (r) =>
                    r.nextStep ? (
                      <span className={cn('text-xs', r.nextStep.key === 'done' || r.nextStep.key === 'cancelled' ? 'text-silver' : 'text-ink')}>
                        {r.nextStep.label}
                        {r.nextStep.waitingOn && <span className="block text-2xs text-silver">waiting on {r.nextStep.waitingOn}</span>}
                      </span>
                    ) : (
                      '—'
                    ),
                },
                {
                  key: 'status',
                  header: 'Status',
                  accessor: (r) => runStatusLabel(r.status),
                  sortable: true,
                  cardMeta: true,
                  cell: (r) => (
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <RunStatusBadge status={r.status} />
                      {r.kind !== 'REGULAR' && <RunKindBadge kind={r.kind} />}
                    </div>
                  ),
                },
                { key: 'paystubs', header: 'Paystubs', accessor: (r) => r.itemCount, sortable: true, searchable: false, align: 'right', cardMeta: true, className: 'tabular-nums text-silver' },
                { key: 'gross', header: 'Gross', accessor: (r) => r.totalGross, csv: (r) => fmtMoney(r.totalGross), sortable: true, searchable: false, align: 'right', className: 'tabular-nums text-silver', cell: (r) => fmtMoney(r.totalGross) },
                { key: 'net', header: 'Net', accessor: (r) => r.totalNet, csv: (r) => fmtMoney(r.totalNet), sortable: true, searchable: false, align: 'right', cardMeta: true, className: 'tabular-nums text-gold', cell: (r) => fmtMoney(r.totalNet) },
              ]}
            />
          )}
        </CardContent>
      </Card>
        </TabsContent>
      </Tabs>


      {/* Disburse ceremony — the most consequential moment in payroll
          deserves a layout that reads as a ceremony, not a generic
          confirmation. Split-pane: the run summary on the left in
          hero scale (net amount in gold-bright, associate count + the
          gross/tax breakdown beneath it); the action panel on the
          right with the recap + buttons. Wide modal (max-w-3xl) so
          both panes breathe. Locked while busy. */}
      <Dialog
        open={confirmDisburse}
        onOpenChange={(v) => {
          if (!busy) setConfirmDisburse(v);
        }}
      >
        <DialogContent className="max-w-3xl p-0 overflow-hidden">
          {selected && (
            <div className="grid grid-cols-1 md:grid-cols-[1.4fr_1fr] min-h-[20rem]">
              {/* Left — the moment. Tinted bg + gold accent rail so the
                  numbers anchor the ceremony. */}
              <div className="bg-navy-secondary/30 border-r border-navy-secondary border-l-2 border-l-gold/60 p-6 md:p-8 flex flex-col gap-6">
                <div>
                  <div className="text-2xs uppercase tracking-widest text-gold inline-flex items-center gap-1.5">
                    <Send className="h-3 w-3" aria-hidden="true" />
                    {busy ? 'Processing payouts' : 'Ready to disburse'}
                  </div>
                  <div className="text-xs2 text-silver tabular-nums mt-2">
                    {fmtPeriod(selected.periodStart, selected.periodEnd)}
                  </div>
                </div>

                <div>
                  <div className="text-2xs uppercase tracking-widest text-silver">
                    Net to {term('workers').toLowerCase()}
                  </div>
                  <div className="font-display text-4xl md:text-5xl text-gold-bright leading-none tabular-nums mt-2">
                    {fmtMoney(selected.totalNet)}
                  </div>
                  <div className="text-sm text-silver mt-2 tabular-nums">
                    across{' '}
                    <span className="text-white">
                      {selected.itemCount.toLocaleString()}
                    </span>{' '}
                    {selected.itemCount === 1 ? 'paystub' : 'paystubs'}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 text-sm pt-2 mt-auto border-t border-navy-secondary">
                  <div className="pt-3">
                    <div className="text-2xs uppercase tracking-widest text-silver">
                      Gross
                    </div>
                    <div className="text-xl text-white tabular-nums mt-1">
                      {fmtMoney(selected.totalGross)}
                    </div>
                  </div>
                  <div className="pt-3">
                    <div className="text-2xs uppercase tracking-widest text-silver">
                      Tax withheld
                    </div>
                    <div className="text-xl text-white tabular-nums mt-1">
                      −{fmtMoney(selected.totalTax)}
                    </div>
                  </div>
                </div>
              </div>

              {/* Right — the action. Plain navy bg, copy + buttons. */}
              <div className="p-6 md:p-8 flex flex-col gap-4">
                <DialogHeader className="space-y-2">
                  <DialogTitle className="text-2xl">
                    {busy ? 'Working…' : 'Disburse this run?'}
                  </DialogTitle>
                  <DialogDescription className="leading-relaxed">
                    {busy
                      ? 'Sending every payment. This can take 10–30 seconds — keep this tab open and don’t refresh.'
                      : `Pays ${selected.itemCount.toLocaleString()} ${selected.itemCount === 1 ? term('worker').toLowerCase() : term('workers').toLowerCase()} ${fmtMoney(selected.totalNet)}. Funds arrive within the payment provider’s settlement window, and each person sees their ${term('label.paystub').toLowerCase()} as soon as it posts.`}
                  </DialogDescription>
                </DialogHeader>

                {!busy && <DisburseFacts runId={selected.id} data={disbursePreview.data} loading={disbursePreview.isLoading} />}

                {busy && (
                  <div className="rounded-md border border-gold/30 bg-gold/5 p-3 text-xs text-silver inline-flex items-center gap-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-gold animate-pulse" />
                    Results will appear on the run timeline when complete.
                  </div>
                )}

                <div className="mt-auto pt-4 flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
                  <Button
                    variant="secondary"
                    onClick={() => setConfirmDisburse(false)}
                    disabled={busy}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="lg"
                    onClick={onDisburse}
                    loading={busy}
                    disabled={busy || !!disbursePreview.data?.provider.blocked}
                  >
                    {busy ? 'Disbursing…' : `Disburse ${fmtMoney(selected.totalNet)}`}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Finalize confirmation — advancing a run to FINALIZED locks the
          projection and is the gate before money moves, so it earns a
          confirm step (Disburse already has its ceremony). */}
      <Dialog open={confirmFinalize} onOpenChange={(v) => !busy && (v ? setConfirmFinalize(true) : closeFinalize())}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('payrollHome.finalizeRun')}</DialogTitle>
          </DialogHeader>
          {selected && (
            <div className="space-y-3 text-sm text-silver">
              <p>
                Finalizing locks the projection for{' '}
                <span className="text-white">
                  {fmtPeriod(selected.periodStart, selected.periodEnd)}
                </span>{' '}
                — {selected.itemCount} paystub{selected.itemCount === 1 ? '' : 's'},{' '}
                {fmtMoney(selected.totalNet)} net. You can still disburse, approve, or
                void afterward, but you can no longer add earning lines.
              </p>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={closeFinalize} disabled={busy}>
                  Cancel
                </Button>
                <Button onClick={() => void onFinalize()} loading={busy} disabled={busy}>
                  Finalize
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Gap 3 — Void confirmation modal. Typed pay-period confirmation +
          mandatory free-text reason. Yes/no isn't enough for a destructive
          financial op, so the HR Admin has to actually transcribe the run's
          pay period as MM/DD/YYYY - MM/DD/YYYY. The reason is stored on the
          PayrollRun and surfaces on the cancelled banner + associate email. */}
      <Dialog open={voidOpen} onOpenChange={(v) => !busy && setVoidOpen(v)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlert className="h-5 w-5 text-alert" />
              Void this payroll run?
            </DialogTitle>
            <DialogDescription>
              Voiding files a reversing journal entry in QuickBooks and notifies
              every {term('worker').toLowerCase()} that their {term('label.paystub').toLowerCase()} was reversed. <strong>Funds are
              not pulled back automatically.</strong> Disbursed money
              must be recovered out-of-band (e.g. next paycheck deduction or
              direct repayment).
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2 text-sm">
            <div className="rounded border border-alert/30 bg-alert/5 px-3 py-2 text-alert text-xs">
              This can't be undone. The run is marked cancelled and every
              {term('label.paystub').toLowerCase()} in it is voided.
            </div>
            <Field
              label={
                <>
                  Type the pay period to confirm:{' '}
                  <span className="font-mono text-white">{expectedVoidString}</span>
                </>
              }
              hint="Format MM/DD/YYYY - MM/DD/YYYY (the spaces around the dash matter)."
              required
            >
              {(p) => (
                <Input
                  {...p}
                  value={voidPeriodInput}
                  onChange={(e) => setVoidPeriodInput(e.target.value)}
                  placeholder={expectedVoidString}
                  autoComplete="off"
                  disabled={busy}
                />
              )}
            </Field>
            <Field
              label="Reason for voiding"
              hint={`Stored on the run and shown to affected ${term('workers').toLowerCase()}.`}
              required
            >
              {(p) => (
                <Textarea
                  {...p}
                  value={voidReasonInput}
                  onChange={(e) => setVoidReasonInput(e.target.value)}
                  placeholder="e.g. Wrong pay period — corrected rate sheet not applied. Re-running with correct figures."
                  rows={3}
                  disabled={busy}
                />
              )}
            </Field>
          </div>
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => setVoidOpen(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={onVoid}
              loading={busy}
              disabled={!voidEnabled}
            >
              <Ban className="h-4 w-4" />
              Void run
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Gap 3 — Amend wizard. Loads the source run, lets HR edit per-item
          values, captures a mandatory reason, and POSTs to /amend. Wraps in
          its own component so this file stays scannable. */}
      {selected && canShowAmendButton && (
        <AmendPayrollWizard
          open={amendOpen}
          onOpenChange={setAmendOpen}
          sourceRun={selected}
          onAmended={(detail) => {
            setAmendOpen(false);
            setSelected(detail);
            refresh();
          }}
        />
      )}

      <BranchEnrollmentDialog
        associateId={enrollFor?.id ?? null}
        associateName={enrollFor?.name ?? null}
        onOpenChange={(v) => {
          if (!v) setEnrollFor(null);
        }}
        onSaved={() => {
          if (selected) {
            getPayrollRun(selected.id)
              .then(setSelected)
              .catch((err) => {
                toast.error(
                  err instanceof ApiError
                    ? err.message
                    : 'Could not refresh the payroll run.',
                );
              });
          }
        }}
      />
    </ListTemplate>
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
  onExceptionsChanged,
}: {
  upcoming: PayrollUpcomingWithSchedules | null;
  loading: boolean;
  canProcess: boolean;
  onStartRun: (seed: RunPayrollSeed | null) => void;
  onResumeRun: (id: string) => void;
  onOpenLastRun: (id: string) => void;
  /** Time approved from the hero — the projection is stale. */
  onExceptionsChanged: () => void;
}) {
  // The schedules' plain-words patterns ("Every other Friday") — the
  // upcoming summary carries only the frequency.
  const hasSchedules = (upcoming?.bySchedule?.length ?? 0) > 0;
  const schedulesQuery = useQuery({
    queryKey: PAY_SCHEDULES_FLOW_KEY,
    queryFn: listPaySchedulesForFlow,
    enabled: hasSchedules,
    retry: false,
    staleTime: 60_000,
  });
  const patternOf = (id: string): string | null =>
    schedulesQuery.data?.schedules.find((s) => s.id === id)?.pattern ?? null;
  if (loading) {
    return <PayrollHeroSkeleton />;
  }
  if (!upcoming) return null;
  const nr = upcoming.nextRun;
  const lr = upcoming.lastRun;
  const bySchedule = upcoming.bySchedule ?? [];
  // Hide the hero outright when there is nothing to show — keeps the page
  // clean for fresh installs that haven't created a schedule yet.
  if (!nr && !lr && bySchedule.length === 0) return null;
  // Several schedules: every one's next payday, soonest first, each runnable.
  if (bySchedule.length > 1) {
    return <SchedulesHero rows={bySchedule} patternOf={patternOf} lastRun={lr} canProcess={canProcess} onStartRun={onStartRun} onResumeRun={onResumeRun} onOpenLastRun={onOpenLastRun} />;
  }
  const only = bySchedule[0] ?? null;

  const isResume = !!nr?.draftRunId;
  const emptySchedule = !!only && only.people === 0;

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
              <div className="flex items-center gap-2 text-xs2 uppercase tracking-widest text-gold mb-1.5">
                <CalendarDays className="h-3.5 w-3.5" />
                {isResume ? 'Resume in-progress run' : 'Next pay date'}
              </div>
              <div className="text-2xl text-white font-medium tabular-nums">
                {fmtDate(parseYmd(nr.payDate))}
              </div>
              <div className="text-xs text-silver/70 mt-1">
                {nr.scheduleName}
                {` · ${patternOf(nr.scheduleId) ?? FREQ_WORDS[nr.frequency] ?? nr.frequency.toLowerCase()}`} ·{' '}
                {fmtPeriod(nr.periodStart, nr.periodEnd)}
                {nr.clientName ? ` · ${nr.clientName}` : ''}
              </div>
              <div className="mt-4 grid grid-cols-1 min-[420px]:grid-cols-3 gap-2 sm:gap-3 text-xs">
                <HeroStat
                  icon={<Users className="h-3.5 w-3.5" />}
                  label={only ? 'People' : 'Paystubs'}
                  value={only ? `${only.people} on schedule` : String(nr.employeeCount)}
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
                <HeroExceptions
                  nextRun={nr}
                  canProcess={canProcess}
                  onChanged={onExceptionsChanged}
                />
              )}
              {/* The blocker, inline — not only inside the dialog (finance walk 10). */}
              {emptySchedule && (
                <p className="mt-3 text-xs text-alert" role="status">
                  No one is on {only!.scheduleName} — this run would pay no one.{' '}
                  <Link to={`/payroll/schedules/${only!.scheduleId}`} className="underline underline-offset-2">
                    Add people to it
                  </Link>
                </p>
              )}
              {(upcoming.peopleOnNoSchedule ?? 0) > 0 && (
                <p className="mt-2 text-xs text-warning" role="status">
                  {upcoming.peopleOnNoSchedule} {upcoming.peopleOnNoSchedule === 1 ? 'person is' : 'people are'} on no pay schedule — no run pays them.{' '}
                  <Link to="/payroll/schedules?view=unassigned" className="underline underline-offset-2">
                    Add them
                  </Link>
                </p>
              )}
            </div>
            {canProcess && (
              <Button
                onClick={() => (isResume ? onResumeRun(nr.draftRunId!) : onStartRun(null))}
                className="shrink-0"
                disabled={emptySchedule && !isResume}
                title={emptySchedule && !isResume ? 'Add people to the schedule first' : undefined}
              >
                <Play className="h-4 w-4" />
                {isResume ? 'Resume run' : 'Run payroll'}
              </Button>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-3 text-silver/70 text-sm">
            <CalendarDays className="h-5 w-5 text-silver/70" />
            No active pay schedule yet.{' '}
            <Link to="/payroll/schedules" className="text-gold underline underline-offset-2">
              Set one up
            </Link>{' '}
            to project the next run.
          </div>
        )}
      </div>

      {/* Last run snapshot. */}
      <div className="rounded-lg border border-silver/15 bg-black/30 p-5">
        <div className="flex items-center gap-2 text-xs2 uppercase tracking-widest text-silver/70 mb-1.5">
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
              {fmtPeriod(lr.periodStart, lr.periodEnd)}
            </div>
            <div className="mt-1.5 flex items-center gap-2">
              <RunStatusBadge status={lr.status} />
              <span className="text-xs text-silver/70">
                {lr.itemCount} paystub{lr.itemCount === 1 ? '' : 's'}
              </span>
            </div>
            <div className="mt-3">
              <div className="text-xs2 uppercase tracking-widest text-silver/70">Net paid</div>
              <div className="tabular-nums text-gold mt-0.5">{fmtMoney(lr.totalNet)}</div>
            </div>
            {/* The stored totals above, checked against the paychecks (apps/api/src/lib/payrollRunTotals.ts). */}
            <RunTotalsMismatch compact className="mt-3" check={{ ...lr, paychecks: lr.itemCount }} />
          </button>
        ) : (
          <div className="text-sm text-silver/70">
            No prior runs. Your first run will appear here once created.
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The hero's issue pill opens the next run's pre-flight list in place —
 * open on its own when anything blocks — with Fix links that carry the
 * period and unapproved time approved right here. Re-checked when the
 * window regains focus (fixes happen in other tabs).
 */
function HeroExceptions({
  nextRun,
  canProcess,
  onChanged,
}: {
  nextRun: NonNullable<PayrollUpcomingWithSchedules['nextRun']>;
  canProcess: boolean;
  onChanged: () => void;
}) {
  const blocking = nextRun.blockingExceptions;
  const [open, setOpen] = useState(blocking > 0);
  const input = {
    clientId: nextRun.clientId,
    periodStart: nextRun.periodStart,
    periodEnd: nextRun.periodEnd,
    payrollScheduleId: nextRun.scheduleId,
  };
  const q = useQuery({
    queryKey: ['payroll', 'exceptions', input],
    queryFn: () => listPayrollExceptions(input),
    enabled: open && canProcess,
    refetchOnWindowFocus: true,
    staleTime: 10_000,
  });
  const listId = `hero-exceptions-${nextRun.scheduleId}`;
  return (
    <div className="mt-3 space-y-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={listId}
        disabled={!canProcess}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs2 transition-colors',
          canProcess && 'hover:brightness-125',
          blocking > 0 ? 'border-alert/40 bg-alert/5 text-alert' : 'border-warning/30 bg-warning/5 text-warning',
        )}
      >
        <AlertTriangle className="h-3 w-3" aria-hidden="true" />
        {blocking > 0
          ? `${blocking} blocking · ${nextRun.totalExceptions} total`
          : `${nextRun.totalExceptions} ${nextRun.totalExceptions === 1 ? 'issue' : 'issues'} to review`}
        {canProcess && (open ? <ChevronDown className="h-3 w-3" aria-hidden="true" /> : <ChevronRight className="h-3 w-3" aria-hidden="true" />)}
      </button>
      {open && canProcess && (
        <div id={listId}>
          {q.isError ? (
            <p className="text-xs text-alert">Could not load the issues. <button type="button" className="underline" onClick={() => void q.refetch()}>Try again</button></p>
          ) : (
            <ExceptionStrip
              exceptions={q.data ?? null}
              loading={q.isPending}
              onRecheck={() => void q.refetch()}
              paychecks={nextRun.employeeCount}
              period={{ start: nextRun.periodStart, end: nextRun.periodEnd, clientId: nextRun.clientId, payrollScheduleId: nextRun.scheduleId }}
              onTimeApproved={() => {
                void q.refetch();
                onChanged();
              }}
              defaultOpen
            />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Payroll home with several pay schedules: each schedule's next run in one
 * compact row — the schedule, the period, the payday, who is on it — and
 * its own Run / Resume, soonest payday first.
 */
const FREQ_WORDS: Record<string, string> = {
  WEEKLY: 'Weekly',
  BIWEEKLY: 'Every two weeks',
  SEMIMONTHLY: 'Twice a month',
  MONTHLY: 'Monthly',
  DAILY: 'Daily',
};

function SchedulesHero({
  rows,
  patternOf,
  lastRun,
  canProcess,
  onStartRun,
  onResumeRun,
  onOpenLastRun,
}: {
  rows: UpcomingBySchedule[];
  patternOf: (scheduleId: string) => string | null;
  lastRun: PayrollUpcomingSummary['lastRun'];
  canProcess: boolean;
  onStartRun: (seed: RunPayrollSeed | null) => void;
  onResumeRun: (id: string) => void;
  onOpenLastRun: (id: string) => void;
}) {
  const sorted = [...rows].sort((a, b) => a.payDate.localeCompare(b.payDate));
  return (
    <div className="mb-5 space-y-3">
      <section aria-label="Next paydays" className="rounded-lg border border-gold/30 bg-gradient-to-br from-gold/8 to-transparent">
        <div className="flex items-center justify-between gap-2 px-5 pt-4">
          <div className="flex items-center gap-2 text-xs2 uppercase tracking-widest text-gold">
            <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />
            Next paydays
          </div>
          <Link to="/payroll/schedules" className="text-xs text-gold hover:underline">
            Pay schedules
          </Link>
        </div>
        <ul className="mt-2 divide-y divide-navy-secondary">
          {sorted.map((r) => (
            <li key={r.scheduleId} className="flex flex-col gap-3 px-5 py-3.5 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-lg font-medium tabular-nums text-ink">{fmtDate(parseYmd(r.payDate))}</span>
                  <span className="truncate text-sm text-ink">{r.scheduleName}</span>
                </div>
                <div className="mt-0.5 text-xs text-silver/80">
                  {`${patternOf(r.scheduleId) ?? FREQ_WORDS[r.frequency] ?? r.frequency.toLowerCase()} · `}
                  {fmtPeriod(r.periodStart, r.periodEnd)}
                </div>
              </div>
              <div className="flex items-center gap-5 text-xs sm:w-56 sm:justify-end">
                <span className="tabular-nums">
                  <span className="block text-2xs uppercase tracking-widest text-silver/70">People</span>
                  <span className={cn('text-sm', r.people === 0 ? 'text-warning' : 'text-ink')}>{r.people}</span>
                </span>
                {canProcess && (
                  <Button
                    size="sm"
                    variant={r.draftRunId ? 'secondary' : 'primary'}
                    className="ml-auto sm:ml-0"
                    onClick={() =>
                      r.draftRunId
                        ? onResumeRun(r.draftRunId)
                        : onStartRun({ scheduleId: r.scheduleId, periodStart: r.periodStart, periodEnd: r.periodEnd })
                    }
                    aria-label={`${r.draftRunId ? 'Resume draft' : 'Run payroll'} for ${r.scheduleName}`}
                  >
                    {r.draftRunId ? 'Resume draft' : (
                      <>
                        <Play className="h-3.5 w-3.5" aria-hidden="true" />
                        Run
                      </>
                    )}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>
      {lastRun && (
        <button
          type="button"
          onClick={() => onOpenLastRun(lastRun.id)}
          className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-silver/15 bg-black/30 px-4 py-2.5 text-left text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
        >
          <FileText className="h-4 w-4 text-silver/70" aria-hidden="true" />
          <span className="text-silver/80">Last run</span>
          <span className="tabular-nums text-ink">{fmtPeriod(lastRun.periodStart, lastRun.periodEnd)}</span>
          <RunStatusBadge status={lastRun.status} />
          <span className="ml-auto tabular-nums text-gold">{fmtMoney(lastRun.totalNet)} net</span>
        </button>
      )}
      {lastRun && <RunTotalsMismatch compact check={{ ...lastRun, paychecks: lastRun.itemCount }} />}
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
 *  Wave 9 — Run status stepper.
 *
 *  4 checkpoints rendered as connected dots: Draft → Finalized → Disbursed
 *  → Synced. Reflects what's actually visible in the run row, not the
 *  internal database statuses.
 * -------------------------------------------------------------------------- */

type StepperStage = 'DRAFT' | 'FINALIZED' | 'SIGNED' | 'DISBURSED' | 'DEPOSIT';

function RunStatusStepper({ status, lifecycle, signedOff }: { status: PayrollRunStatus; lifecycle: PayrollRunSummary | null; signedOff: boolean }) {
  if (status === 'CANCELLED') {
    return (
      <div className="rounded border border-alert/30 bg-alert/5 p-3 text-xs text-alert flex items-center gap-2">
        <Circle className="h-3.5 w-3.5 fill-alert text-alert" />
        Run cancelled. No paystubs will disburse.
      </div>
    );
  }
  // The same lifecycle the guided close shows (GET /payroll/runs nextStep, finance walk 10).
  const stages: { key: StepperStage; label: string }[] = [
    // The one word per status (lib/payrollRunStatus): "Paid", as on every payroll page.
    { key: 'DRAFT', label: runStatusLabel('DRAFT') },
    { key: 'FINALIZED', label: runStatusLabel('FINALIZED') },
    { key: 'SIGNED', label: 'Signed off' },
    { key: 'DISBURSED', label: runStatusLabel('DISBURSED') },
    { key: 'DEPOSIT', label: 'Tax deposit' },
  ];
  const next = lifecycle?.nextStep ?? null;
  const reachedIdx = (() => {
    if (status === 'DISBURSED') return next && (next.key === 'done' || next.key === 'remit') ? 4 : 3;
    if (status === 'FINALIZED') return signedOff || !!lifecycle?.reviewSignedAt || (next && next.key !== 'review') ? 2 : 1;
    return 0;
  })();
  return (
    <div className="space-y-2">
    <ol className="flex items-center gap-1 sm:gap-2">
      {stages.map((s, i) => {
        const reached = i <= reachedIdx;
        const current = i === reachedIdx;
        return (
          <li key={s.key} className="flex items-center gap-1 sm:gap-2 flex-1">
            <div className="flex flex-col items-center min-w-0">
              <span
                className={cn(
                  'inline-flex h-6 w-6 items-center justify-center rounded-full text-2xs font-medium transition-colors',
                  reached ? 'bg-gold text-navy' : 'bg-silver/10 text-silver/70',
                  current && 'ring-2 ring-gold/30 ring-offset-2 ring-offset-navy'
                )}
              >
                {reached && i < reachedIdx ? '✓' : i + 1}
              </span>
              <span
                className={cn(
                  'mt-1 text-2xs uppercase tracking-widest text-center truncate max-w-[80px]',
                  reached ? 'text-silver' : 'text-silver/70'
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
      {next && next.key !== 'done' && (
        <p className="text-xs text-silver">
          Next: <Link to={next.to} className="text-gold underline underline-offset-2">{next.label}</Link>
          {next.waitingOn && ` — waiting on ${next.waitingOn}`}
        </p>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 *  Gap 3 — Run-kind badge.
 *
 *  Surfaces non-REGULAR runs in the runs list so HR can tell at a glance
 *  whether a row is a one-off OFF_CYCLE bonus run or an AMENDMENT to a
 *  prior run. REGULAR is the default and gets no chrome.
 * -------------------------------------------------------------------------- */

function RunKindBadge({ kind }: { kind: 'OFF_CYCLE' | 'AMENDMENT' | 'DAILY' | 'MANUAL' }) {
  if (kind === 'DAILY' || kind === 'MANUAL') {
    return (
      <Badge variant="default" className="border-steel/40 bg-steel/10 text-steel">
        {kind === 'DAILY' ? 'Daily pay' : 'Manual check'}
      </Badge>
    );
  }
  if (kind === 'AMENDMENT') {
    return (
      <Badge variant="default" className="border-warning/40 bg-warning/10 text-warning">
        <Pencil className="h-3 w-3" />
        Amendment
      </Badge>
    );
  }
  return (
    <Badge variant="default" className="border-steel/40 bg-steel/10 text-steel">
      Off-cycle
    </Badge>
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
          'text-2xs uppercase tracking-widest',
          highlight ? 'text-gold' : 'text-silver/70'
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
 *  Draft add-on lines — bonus / commission / tips / holiday / PTO payout
 *  attached to a DRAFT run. Adding or removing one re-aggregates the run
 *  server-side; the parent refetches so totals stay live. Supplemental
 *  kinds (bonus/commission) withhold FIT at the flat 22% rate — noted in
 *  the helper text so HR isn't surprised.
 * -------------------------------------------------------------------------- */

const ADD_ON_KINDS: { value: RunAddOnKind; label: string }[] = [
  { value: 'BONUS', label: 'Bonus' },
  { value: 'COMMISSION', label: 'Commission' },
  { value: 'TIPS', label: 'Tips' },
  { value: 'HOLIDAY', label: 'Holiday pay' },
  { value: 'SICK', label: 'Sick payout' },
  { value: 'VACATION', label: 'PTO / vacation payout' },
];

function DraftAddOnsSection({
  runId,
  runItems,
  onChanged,
}: {
  runId: string;
  runItems: import('@alto-people/shared').PayrollItem[];
  onChanged: () => Promise<void> | void;
}) {
  const term = useTerm();
  const [addOns, setAddOns] = useState<RunAddOn[] | null>(null);
  const [open, setOpen] = useState(false);
  // Multi-associate: chips accumulate via repeated pick-and-add; the
  // "everyone" toggle instead targets every associate in the run.
  const [assocs, setAssocs] = useState<PickedAssociate[]>([]);
  const [everyone, setEveryone] = useState(false);
  const [kind, setKind] = useState<RunAddOnKind>('BONUS');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  // Gross-up: type the take-home; the gross is solved per person on the server.
  const [takeHome, setTakeHome] = useState(false);
  const [includePreTax, setIncludePreTax] = useState(false);
  const quoteFor = !everyone && assocs.length === 1 && takeHome && Number(amount) > 0 ? assocs[0]!.id : null;
  const quote = useQuery({
    queryKey: ['payroll', 'grossUpQuote', runId, quoteFor, amount, includePreTax],
    queryFn: () => quoteGrossUp({ associateId: quoteFor!, targetNet: Number(amount), includePreTax, runId }),
    enabled: !!quoteFor,
    staleTime: 30_000,
  });

  // Unique associates in this run (a run has one item per associate, but
  // dedupe defensively for amendment edge cases).
  const runAssociates = useMemo(() => {
    const seen = new Map<string, PickedAssociate>();
    for (const it of runItems) {
      if (!seen.has(it.associateId)) {
        seen.set(it.associateId, {
          id: it.associateId,
          name: it.associateName ?? `Unnamed ${term('worker').toLowerCase()}`,
        });
      }
    }
    return [...seen.values()];
  }, [runItems, term]);

  const load = useCallback(() => {
    listRunAddOns(runId)
      .then((r) => setAddOns(r.addOns))
      .catch(() => setAddOns([]));
  }, [runId]);
  useEffect(load, [load]);

  const submit = async () => {
    const amt = Number(amount);
    const targets = everyone ? runAssociates : assocs;
    if (targets.length === 0 || !Number.isFinite(amt) || amt <= 0) {
      toast.error(targets.length === 0 ? pickOne(term) : 'Enter a positive amount.');
      return;
    }
    setBusy(true);
    // Sequential on purpose — each add re-aggregates the run server-side;
    // parallel writes would race. One refresh at the end, not per line.
    let added = 0;
    const failures: string[] = [];
    for (const a of targets) {
      try {
        await addRunAddOn(runId, {
          associateId: a.id,
          kind,
          ...(takeHome ? { targetNet: amt, includePreTax } : { amount: amt }),
          note: note.trim() || null,
        });
        added += 1;
      } catch {
        failures.push(a.name);
      }
    }
    load();
    await onChanged();
    setBusy(false);
    const kindLabel =
      ADD_ON_KINDS.find((k) => k.value === kind)?.label.toLowerCase() ?? kind.toLowerCase();
    if (failures.length === 0) {
      toast.success(
        `Added ${kindLabel} for ${added} ${(added === 1 ? term('worker') : term('workers')).toLowerCase()}.`,
      );
      setAssocs([]);
      setEveryone(false);
      setAmount('');
      setNote('');
      setOpen(false);
    } else {
      // Keep the form open so HR can retry the stragglers.
      toast.error(
        `Added for ${added} of ${targets.length} — failed: ${failures.slice(0, 3).join(', ')}` +
          (failures.length > 3 ? ` +${failures.length - 3} more` : '') +
          '.',
      );
    }
  };

  // Gmail-style: the line leaves the list at once and the delete commits
  // when the undo window closes; Undo puts the line back without a request.
  const remove = (addOnId: string) => {
    const before = addOns;
    const line = addOns?.find((a) => a.id === addOnId);
    setAddOns((prev) => (prev ? prev.filter((a) => a.id !== addOnId) : prev));
    performWithUndo({
      message: line ? `Removed ${fmtMoney(line.amount)} for ${line.associateName}.` : 'Earning line removed.',
      onCommit: async () => {
        try {
          await deleteRunAddOn(runId, addOnId);
        } finally {
          load();
          await onChanged();
        }
      },
      onUndo: () => setAddOns(before),
      commitFailedMessage: "Couldn't remove the earning line.",
    });
  };

  return (
    <div className="mt-5 rounded-md border border-navy-secondary bg-navy-secondary/20 p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-xs uppercase tracking-wide text-silver">
          Extra earnings (bonus, commission, tips, PTO)
        </div>
        {!open && (
          <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
            <Plus className="h-4 w-4" />
            Add line
          </Button>
        )}
      </div>

      {addOns && addOns.length > 0 && (
        <div className="mb-2 space-y-1">
          {addOns.map((a) => (
            <div key={a.id} className="flex items-center justify-between text-sm">
              <span className="text-silver">
                {a.associateName} ·{' '}
                {ADD_ON_KINDS.find((k) => k.value === a.kind)?.label ?? a.kind}
                {a.note ? ` — ${a.note}` : ''}
                {a.grossUp && (
                  <span className="block text-xs text-silver/70 tabular-nums">
                    Take-home {fmtMoney(a.grossUp.net)} · federal {fmtMoney(a.grossUp.federal)} · Social Security {fmtMoney(a.grossUp.socialSecurity)} · Medicare {fmtMoney(a.grossUp.medicare)}
                    {a.grossUp.state ? ` · state ${fmtMoney(a.grossUp.state)}` : ''}
                    {a.grossUp.preTax ? ` · 401(k) ${fmtMoney(a.grossUp.preTax)}` : ''}
                  </span>
                )}
              </span>
              <span className="flex items-center gap-2">
                <span className="tabular-nums text-white">{fmtMoney(a.amount)}</span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => remove(a.id)}
                  disabled={busy}
                  className="text-silver/60 hover:text-alert"
                  aria-label="Remove earning line"
                >
                  <X className="h-4 w-4" />
                </Button>
              </span>
            </div>
          ))}
        </div>
      )}

      {open && (
        <div className="space-y-2 border-t border-navy-secondary pt-2">
          <label className="flex items-center gap-2 text-sm text-silver cursor-pointer">
            <input
              type="checkbox"
              className="h-4 w-4 cursor-pointer accent-gold"
              checked={everyone}
              onChange={(e) => setEveryone(e.target.checked)}
              disabled={busy}
            />
            Everyone in this run ({runAssociates.length})
          </label>
          {!everyone && (
            <>
              {assocs.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {assocs.map((a) => (
                    <span
                      key={a.id}
                      className="inline-flex items-center gap-1 rounded-full border border-gold/30 bg-gold/10 px-2 py-0.5 text-xs text-white"
                    >
                      {a.name}
                      <button
                        type="button"
                        onClick={() =>
                          setAssocs((prev) => prev.filter((x) => x.id !== a.id))
                        }
                        disabled={busy}
                        className="text-silver/60 hover:text-alert"
                        aria-label={`Remove ${a.name}`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              {/* key remounts the picker after each add so its search term
                  clears and the next pick starts fresh. */}
              <AssociatePicker
                key={assocs.length}
                value={null}
                onChange={(v) => {
                  if (v) {
                    setAssocs((prev) =>
                      prev.some((x) => x.id === v.id) ? prev : [...prev, v],
                    );
                  }
                }}
                placeholder={
                  assocs.length === 0
                    ? `Search ${term('worker').toLowerCase()}…`
                    : `Add another ${term('worker').toLowerCase()}…`
                }
              />
            </>
          )}
          <div className="flex gap-2">
            <Select
              className="flex-1"
              value={kind}
              onChange={(e) => setKind(e.target.value as RunAddOnKind)}
            >
              {ADD_ON_KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </Select>
            <Input
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
              placeholder={takeHome ? 'Take-home' : 'Amount'}
              aria-label={takeHome ? 'Take-home amount' : 'Amount'}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-32"
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-silver cursor-pointer">
            <input type="checkbox" className="h-4 w-4 cursor-pointer accent-gold" checked={takeHome} onChange={(e) => setTakeHome(e.target.checked)} disabled={busy} />
            Enter the take-home instead (gross it up)
          </label>
          {takeHome && (
            <label className="flex items-center gap-2 text-sm text-silver cursor-pointer">
              <input type="checkbox" className="h-4 w-4 cursor-pointer accent-gold" checked={includePreTax} onChange={(e) => setIncludePreTax(e.target.checked)} disabled={busy} />
              Gross up the 401(k) deferral too
            </label>
          )}
          {quoteFor && quote.data && (
            <div className="rounded-md border border-navy-secondary p-2 text-xs text-silver tabular-nums" aria-live="polite">
              Gross {fmtMoney(quote.data.breakdown.gross)} · federal {fmtMoney(quote.data.breakdown.federal)}
              {quote.data.breakdown.federalMethod === 'SUPPLEMENTAL_22' ? ' (22%)' : ' (37% over $1M)'} · Social Security {fmtMoney(quote.data.breakdown.socialSecurity)} · Medicare{' '}
              {fmtMoney(quote.data.breakdown.medicare)}
              {quote.data.breakdown.state ? ` · state ${fmtMoney(quote.data.breakdown.state)}` : ''}
              {quote.data.breakdown.preTax ? ` · 401(k) ${fmtMoney(quote.data.breakdown.preTax)}` : ''} → take-home {fmtMoney(quote.data.breakdown.net)}
            </div>
          )}
          <p className="text-xs text-silver/70">
            Bonuses and commissions are supplemental wages — federal income tax
            withholds at the flat 22% supplemental rate (37% past $1M in the year).
            {takeHome ? ' The line is checked against the real paycheck so the take-home lands to the cent.' : ''}
          </p>
          <Input
            placeholder="Note (optional) — e.g. Q3 performance bonus"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={200}
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button size="sm" onClick={submit} loading={busy} disabled={busy}>
              {everyone
                ? `Add for all (${runAssociates.length})`
                : assocs.length > 1
                  ? `Add (${assocs.length})`
                  : 'Add'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 *  Failed-payments summary card. Renders only when the run has any HELD
 *  items (Branch reported FAILED / CANCELLED / RETURNED, or HR put the
 *  item on hold). Sits at the top of the paystubs section so HR sees
 *  failures before scrolling. The "Retry failed disbursements" button is
 *  the same action as the drawer footer button — exposed here so HR
 *  doesn't have to scroll past the paystubs list to find it.
 * -------------------------------------------------------------------------- */

function FailedPaymentsSummary({
  items,
  canProcess,
  onRetry,
  onEnrollBranch,
  busy,
}: {
  items: import('@alto-people/shared').PayrollItem[];
  canProcess: boolean;
  /** Omit itemIds to retry everything failed/held in the run. */
  onRetry: (itemIds?: string[]) => void | Promise<void>;
  /** Opens the Branch enrollment dialog IN PLACE — the payout-rail fix no
   *  longer forces a /people round-trip that resets the page. */
  onEnrollBranch: (associateId: string, associateName: string | null) => void;
  busy: boolean;
}) {
  // One memoized pass — on a 1,000+ item run these ran in the render
  // body on every parent re-render (each keystroke/toggle in the drawer).
  const { failed, groups } = useMemo(() => {
    const failed = items.filter(
      (it) => it.status === 'HELD' || it.status === 'FAILED',
    );
    // Group by failure reason so five identical "no_payout_rail" rows read
    // as one problem, not five. Map preserves first-seen order.
    const groups = new Map<string, typeof failed>();
    for (const it of failed) {
      const key = it.failureReason ?? 'Held by HR';
      const bucket = groups.get(key);
      if (bucket) bucket.push(it);
      else groups.set(key, [it]);
    }
    return { failed, groups };
  }, [items]);
  if (failed.length === 0) return null;

  return (
    <Card className="mb-4 border-alert/40 bg-alert/5">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base text-alert">
          <AlertTriangle className="h-4 w-4" />
          {failed.length} payment{failed.length === 1 ? '' : 's'} need attention
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {[...groups.entries()].map(([reason, group]) => (
          <div key={reason}>
            <div className="flex items-center justify-between gap-2 mb-1">
              <div className="min-w-0 flex items-center gap-1.5 text-xs2 text-silver">
                <span className="truncate" title={reason}>
                  {reason}
                </span>
                <Badge variant="destructive" className="text-2xs shrink-0">
                  {group.length}
                </Badge>
              </div>
              {canProcess && (
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => onRetry(group.map((it) => it.id))}
                  disabled={busy}
                  className="shrink-0"
                >
                  <RotateCw className="h-3 w-3" />
                  Retry these ({group.length})
                </Button>
              )}
            </div>
            {reason.startsWith('no_payout_rail') && (
              <p className="mb-1 text-xs2 text-warning">
                Retrying will fail again until a payout method exists — fix
                enrollment/bank first.
              </p>
            )}
            <ul className="space-y-1">
              {group.map((it) => {
                // A payout-rail failure is fixed by enrolling a payout
                // method, not by retrying — offer that fix inline (the
                // enrollment dialog opens over the drawer) so the run
                // page is never abandoned mid-triage.
                const isRailProblem = (it.failureReason ?? '').startsWith('no_payout_rail');
                return (
                <li
                  key={it.id}
                  className="flex items-start justify-between gap-3 text-sm rounded border border-alert/20 bg-black/30 px-2.5 py-1.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-white truncate">
                      {it.associateName ? (
                        // Secondary path — a NEW TAB keeps this run drawer
                        // (and its ?run= URL) alive behind the profile.
                        <Link
                          to={`/people?associateId=${it.associateId}`}
                          target="_blank"
                          rel="noreferrer"
                          className="hover:text-gold-bright"
                          title="Open this person's record in a new tab"
                        >
                          {it.associateName}
                        </Link>
                      ) : (
                        '—'
                      )}
                    </div>
                    <div className="text-2xs uppercase tracking-widest text-alert/80">
                      {paycheckStatusLabel(it.status)}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <div className="tabular-nums text-gold">{fmtMoney(it.netPay)}</div>
                    {canProcess && isRailProblem && (
                      <Button
                        variant="secondary"
                        size="xs"
                        onClick={() => onEnrollBranch(it.associateId, it.associateName ?? null)}
                        disabled={busy}
                        title="Set up the payout method right here — no trip to the People directory"
                      >
                        <CreditCard className="h-3 w-3" />
                        Fix payout method
                      </Button>
                    )}
                    {canProcess && (
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => onRetry([it.id])}
                        disabled={busy}
                      >
                        <RotateCw className="h-3 w-3" />
                        Retry
                      </Button>
                    )}
                  </div>
                </li>
                );
              })}
            </ul>
          </div>
        ))}
        {canProcess && (
          <div className="pt-1">
            <Button variant="secondary" size="sm" onClick={() => onRetry()} loading={busy}>
              <RotateCw className="h-3.5 w-3.5" />
              Retry failed disbursements
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------------------------- *
 *  Wave 9 — Per-paystub admin card.
 *
 *  Replaces the dense table inside the drawer. Collapsed shows associate +
 *  hours/rate/net + status pill. Expanded drills into earnings, taxes,
 *  garnishments, plus the Branch enrollment quick-action when canProcess.
 * -------------------------------------------------------------------------- */

const PaystubAdminCard = memo(function PaystubAdminCard({
  item,
  canProcess,
  onEnrollBranch,
  paperCheckReason = null,
  canSwitchToCheck = false,
  onPayByCheck,
}: {
  item: import('@alto-people/shared').PayrollItem;
  canProcess: boolean;
  /** Stable callback (item identity passed as args) so memo() holds. */
  onEnrollBranch: (associateId: string, associateName: string | null) => void;
  /** Set when payroll switched this paycheck to a paper check for this payday. */
  paperCheckReason?: string | null;
  canSwitchToCheck?: boolean;
  onPayByCheck?: (itemId: string, name: string | null, on: boolean) => void;
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
            <ChevronDown className="h-4 w-4 text-silver/70 shrink-0" />
          ) : (
            <ChevronRight className="h-4 w-4 text-silver/70 shrink-0" />
          )}
          <Avatar src={associatePhotoUrl(item.associateId)} name={item.associateName ?? '—'} size="sm" />
          <div className="min-w-0">
            <div className="text-sm text-white truncate">
              {item.associateName ?? '—'}
            </div>
            <div className="text-xs2 text-silver/70 truncate">
              {item.hoursWorked.toFixed(2)} hrs · {fmtMoney(item.hourlyRate)}/hr
              {item.taxState ? ` · ${item.taxState}` : ''}
            </div>
          </div>
          <StatusBadge status={item.status} label={paycheckStatusLabel(item.status)} overrides={{ [item.status]: paycheckStatusTone(item.status) }} className="text-2xs shrink-0" />
          {(paperCheckReason || /^CHECK-/.test(item.disbursementRef ?? '')) && (
            <Badge variant="info" className="text-2xs shrink-0" title={paperCheckReason ?? undefined}>
              Check
            </Badge>
          )}
        </div>
        <div className="text-right shrink-0">
          <div className="text-2xs uppercase tracking-widest text-silver/70">Net</div>
          <div className="tabular-nums text-gold">{fmtMoney(item.netPay)}</div>
        </div>
      </button>
      {expanded && (
        <div className="border-t border-silver/10 px-3 py-3 text-xs2 space-y-3">
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
              {item.deductions && item.deductions.some((d) => d.category !== 'EMPLOYER') ? (
                // Every deduction on the check, itemized: pre-tax first, then after tax.
                [...item.deductions]
                  .filter((d) => d.category !== 'EMPLOYER' && d.employeeAmount !== 0)
                  .sort((a, b) => (a.category === b.category ? 0 : a.category === 'PRE_TAX' ? -1 : 1))
                  .map((d) => (
                    <DrillRow
                      key={`${d.key}-${d.category}`}
                      label={d.category === 'PRE_TAX' ? `${d.label} (pre-tax)` : d.label}
                      value={`−${fmtMoney(d.employeeAmount)}`}
                      accent={d.code === 'GARNISHMENT'}
                    />
                  ))
              ) : (
                <>
                  {(item.preTaxDeductions ?? 0) > 0 && (
                    <DrillRow label="Pre-tax deductions" value={`−${fmtMoney(item.preTaxDeductions ?? 0)}`} />
                  )}
                  {item.postTaxDeductions > 0 && (
                    <DrillRow
                      label="Post-tax deductions"
                      value={`−${fmtMoney(item.postTaxDeductions)}`}
                      accent
                    />
                  )}
                </>
              )}
              <DrillRow
                label="Total tax"
                value={`−${fmtMoney(totalTax)}`}
                muted
              />
              <DrillRow label="Net pay" value={fmtMoney(item.netPay)} bold accent />
            </div>
            <div className="space-y-1">
              <div className="text-2xs uppercase tracking-widest text-silver/70 mb-1">
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
              {(item.deductions ?? [])
                .filter((d) => d.category === 'EMPLOYER' && d.employerAmount !== 0)
                .map((d) => (
                  <DrillRow key={`${d.key}-er`} label={d.label} value={fmtMoney(d.employerAmount)} muted />
                ))}
              <DrillRow
                label="Total"
                value={fmtMoney(
                  item.employerFica +
                    item.employerMedicare +
                    item.employerFuta +
                    item.employerSuta +
                    (item.deductions ?? []).reduce((sum, d) => (d.category === 'EMPLOYER' ? sum + d.employerAmount : sum), 0)
                )}
                bold
              />
              <div className="text-2xs uppercase tracking-widest text-silver/70 mt-3 mb-1">
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
            <div className="text-silver/70">
              Disbursement ref:{' '}
              <span className="font-mono text-silver">{item.disbursementRef}</span>
            </div>
          )}

          {paperCheckReason && (
            <div className="rounded border border-steel/40 bg-steel/10 px-2 py-1.5 text-silver">
              Paid by paper check this time: {paperCheckReason}
            </div>
          )}
          {canProcess && (
            <div className="pt-1 border-t border-silver/10 flex flex-wrap gap-x-4">
              {canSwitchToCheck && onPayByCheck && (
                <Button
                  variant="link"
                  onClick={(e) => {
                    e.stopPropagation();
                    onPayByCheck(item.id, item.associateName ?? null, !paperCheckReason);
                  }}
                  className="gap-1.5 text-xs font-normal text-silver/70 hover:text-gold"
                >
                  <Banknote className="h-3.5 w-3.5" />
                  {paperCheckReason ? 'Undo paper check' : 'Pay by check this time'}
                </Button>
              )}
              <Button
                variant="link"
                onClick={(e) => {
                  e.stopPropagation();
                  onEnrollBranch(item.associateId, item.associateName ?? null);
                }}
                className="gap-1.5 text-xs font-normal text-silver/70 hover:text-gold"
              >
                <CreditCard className="h-3.5 w-3.5" />
                Manage Branch enrollment
              </Button>
            </div>
          )}
        </div>
      )}
    </li>
  );
});

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
      <span className={cn(muted ? 'text-silver/70' : 'text-silver/70')}>{label}</span>
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
      <div className="flex items-center gap-1 text-2xs uppercase tracking-widest text-silver/70">
        {icon}
        {label}
      </div>
      <div className={cn('mt-0.5 tabular-nums', highlight ? 'text-gold' : 'text-white')}>
        {value}
      </div>
    </div>
  );
}


