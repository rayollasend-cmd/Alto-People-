// Wave 1.3 — Multi-step payroll run wizard.
// Wave 6.3 — Live preview wired into steps 2 & 3.
// Wave 8 — QBO-parity polish:
//   • Pre-flight exception strip (blocks Next when severity = BLOCKING).
//   • Per-paycheck cards with line-level drill-down (regular/OT/garnishments,
//     FIT/FICA/Medicare/SIT) replacing the old read-only tables.
//
// Replaces the single-screen "New payroll run" dialog with a four-step flow
// modeled on QuickBooks Online Payroll:
//   1. Pick schedule + period (defaults to the schedule's next un-run period)
//   2. Hours review (per-associate REGULAR vs OVERTIME from the OT split)
//   3. Wages + deductions review (gross / tax / net rollup)
//   4. Approve & submit (preview the JE summary, confirm, fire create)
//
// The wizard runs `createPayrollRun` only at step 4 — the prior steps are
// pure UI projections so the user can back out without polluting the DB.

import { ChangesVsLastRun } from './ChangesVsLastRun';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Calendar,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileText,
  HelpCircle,
  Info,
  Loader2,
  ShieldAlert,
  UserPlus,
  Users,
} from 'lucide-react';
import type {
  PayrollException,
  PayrollExceptionsInput,
  PayrollExceptionsResponse,
  SchedulePeriod,
  PayrollRunDetail,
  PayrollRunPreviewItem,
  PayrollRunPreviewResponse,
  PayrollSchedule,
} from '@alto-people/shared';
import {
  createPayrollRun,
  finalizePayrollRun,
  listPayrollExceptions,
  listPayrollSchedules,
  previewPayrollRun,
} from '@/lib/payrollApi';
import { getPayScheduleCalendarForFlow, listPaySchedulesForFlow, PAY_SCHEDULES_FLOW_KEY, type FlowSchedule } from '@/lib/payScheduleFlowApi';
import { ApiError } from '@/lib/api';
import { EXCEPTION_COPY, ExceptionStrip, SeverityDot } from './PayrollExceptionStrip';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { Input, Textarea } from '@/components/ui/Input';
import { Stepper } from '@/components/ui/Stepper';
import { toast } from '@/components/ui/Toaster';
import { cn } from '@/lib/cn';
import { useTerm } from '@/lib/auth';
import { fmtDate, fmtDayShort, fmtMoney, parseYmd, ymdLocal } from '@/lib/format';

/** "May 13, 2026 → May 26, 2026" — a YMD period, parsed as local days. */
const fmtPeriod = (startYmd: string, endYmd: string) =>
  `${fmtDate(parseYmd(startYmd))} → ${fmtDate(parseYmd(endYmd))}`;

/** Prefill handed in by the hero card so step 1 doesn't re-ask. */
export interface RunPayrollSeed {
  scheduleId: string;
  periodStart: string;
  periodEnd: string;
  /**
   * A payday that passed with no run (the period ledger, finance walk 1):
   * the run is OFF_CYCLE and pays only the period's approved hours that
   * are on no paystub yet.
   */
  missedPayday?: boolean;
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: (detail: PayrollRunDetail) => void;
  /**
   * When set, the wizard opens with schedule + period already applied and,
   * if the preview comes back with zero blocking exceptions, collapses the
   * four steps into a single review-and-create screen. Omit (or null) for
   * the generic "New run" entry points, which keep the full flow.
   */
  seed?: RunPayrollSeed | null;
}

type Step = 1 | 2 | 3 | 4;

const STEP_TITLES: Record<Step, string> = {
  1: 'Pick schedule + period',
  2: 'Review hours',
  3: 'Review wages & deductions',
  4: 'Approve & submit',
};

type RunKind = 'REGULAR' | 'OFF_CYCLE';

export function RunPayrollWizard({ open, onOpenChange, onCreated, seed }: Props) {
  const [step, setStep] = useState<Step>(1);
  const [runKind, setRunKind] = useState<RunKind>('REGULAR');
  const schedulesQuery = useQuery({
    queryKey: ['RunPayrollWizard', 'schedules'],
    queryFn: () => listPayrollSchedules(),
    enabled: open,
  });
  const schedules: PayrollSchedule[] | null = schedulesQuery.data?.schedules ?? null;
  useEffect(() => {
    const err = schedulesQuery.error;
    if (!err) return;
    toast.error(err instanceof ApiError ? err.message : 'Failed to load schedules.');
  }, [schedulesQuery.error]);
  const [scheduleId, setScheduleId] = useState<string>('');
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [defaultRate, setDefaultRate] = useState('15');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // Wave 6.3 — live preview fetched after step 1, shown in steps 2 & 3.
  const [preview, setPreview] = useState<PayrollRunPreviewResponse | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  // Wave 8 — pre-flight exceptions, fetched in parallel with the preview.
  const [exceptions, setExceptions] = useState<PayrollExceptionsResponse | null>(null);
  const [exceptionsLoading, setExceptionsLoading] = useState(false);
  const [exceptionsError, setExceptionsError] = useState<string | null>(null);
  const [overrideBlocking, setOverrideBlocking] = useState(false);
  // The blockers the person acknowledged — a re-check that finds new ones asks again.
  const ackedBlockersRef = useRef('');
  // When the preview and scan last arrived — the focus re-check is throttled from here.
  const lastCheckedRef = useRef(0);
  // Seeded opens collapse to a single review screen while the preview is
  // clean (zero blocking exceptions). quickPending bridges the gap between
  // open and the schedule list resolving (the auto-preview needs it).
  const [quickReview, setQuickReview] = useState(false);
  const [quickPending, setQuickPending] = useState(false);

  // In-progress state survives an ACCIDENTAL close (outside click / Escape /
  // the X). sessionKey remembers which seed the live session was built from:
  // null = no session, so the next open re-initializes; reopening from the
  // same entry point (same seed) resumes as-is, while a different seed —
  // or the unseeded "New run" button — starts fresh.
  const seedKey = seed
    ? `${seed.scheduleId}|${seed.periodStart}|${seed.periodEnd}|${seed.missedPayday ? 'missed' : ''}`
    : '';
  // Paying a missed payday's hours: an off-cycle run built from the period's approved time.
  const missedPayday = !!seed?.missedPayday;
  const ledgerRun = missedPayday ? ({ kind: 'OFF_CYCLE', includesApprovedTime: true } as const) : {};
  const sessionKeyRef = useRef<string | null>(null);
  // A seeded open must keep the hero's exact period — the schedule-default
  // effect below would otherwise clobber it when the schedule list resolves.
  const seededPeriodRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    if (sessionKeyRef.current === seedKey) return; // accidental close → resume as-is
    sessionKeyRef.current = seedKey;
    setStep(1);
    setRunKind('REGULAR');
    setNotes('');
    setSubmitting(false);
    setPreview(null);
    setPreviewError(null);
    setExceptions(null);
    setOverrideBlocking(false);
    setScheduleId(seed?.scheduleId ?? '');
    setPeriodStart(seed?.periodStart ?? '');
    setPeriodEnd(seed?.periodEnd ?? '');
    seededPeriodRef.current = !!seed;
    periodDefaultedForRef.current = '';
    setQuickReview(!!seed);
    setQuickPending(!!seed);
    // seedKey is the value-compare proxy for `seed`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, seedKey]);

  const activeSchedule = useMemo(
    () => schedules?.find((s) => s.id === scheduleId) ?? null,
    [schedules, scheduleId]
  );

  // The pay-schedule engine's view of each schedule: its plain-words
  // pattern, who is on it, and its pay calendar (paySchedules.ts). An older
  // API without it falls back to the legacy schedule list.
  const flowQuery = useQuery({
    queryKey: PAY_SCHEDULES_FLOW_KEY,
    queryFn: listPaySchedulesForFlow,
    enabled: open,
    retry: false,
  });
  const flowById = useMemo(
    () => new Map((flowQuery.data?.schedules ?? []).map((s) => [s.id, s])),
    [flowQuery.data],
  );
  const activeSchedules = useMemo(() => (schedules ?? []).filter((s) => s.isActive), [schedules]);
  const flow = scheduleId ? (flowById.get(scheduleId) ?? null) : null;
  const peopleOnSchedule: number | null = !scheduleId ? null : flow ? flow.people : (activeSchedule?.associateCount ?? null);
  const calendarQuery = useQuery({
    queryKey: ['RunPayrollWizard', 'calendar', scheduleId, flowById.get(scheduleId)?.anchorDate ?? null],
    // From five weeks back (never before the schedule began), so a period
    // whose payday passed without a run shows up, marked late.
    queryFn: () => {
      const d = new Date();
      d.setDate(d.getDate() - 35);
      const back = ymdLocal(d);
      const anchor = flowById.get(scheduleId)?.anchorDate ?? back;
      return getPayScheduleCalendarForFlow(scheduleId, 3, anchor > back ? anchor : back);
    },
    enabled: open && !!scheduleId && runKind === 'REGULAR',
    retry: false,
  });
  // Periods still to run (none yet, or a draft to resume), soonest first.
  const periodOptions: SchedulePeriod[] = useMemo(
    () => (calendarQuery.data?.periods ?? []).filter((p) => !p.run || p.run.status === 'DRAFT').slice(0, 8),
    [calendarQuery.data],
  );
  // Default to the next period still to run (its payday not yet passed)
  // once the calendar is in; earlier un-run periods stay listed, marked late. Once per schedule
  // pick, and never over a seeded period.
  const periodDefaultedForRef = useRef('');
  useEffect(() => {
    if (runKind !== 'REGULAR' || !scheduleId || periodOptions.length === 0) return;
    if (periodDefaultedForRef.current === scheduleId) return;
    periodDefaultedForRef.current = scheduleId;
    if (seed && seed.scheduleId === scheduleId) return;
    const today = ymdLocal();
    const next = periodOptions.find((p) => p.payDate >= today) ?? periodOptions[0]!;
    setPeriodStart(next.periodStart);
    setPeriodEnd(next.periodEnd);
    // seed is read only to skip a seeded open; seedKey tracks it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runKind, scheduleId, periodOptions]);
  const selectedPeriod =
    periodOptions.find((p) => p.periodStart === periodStart && p.periodEnd === periodEnd) ??
    (flow && flow.nextPeriod.periodStart === periodStart && flow.nextPeriod.periodEnd === periodEnd ? flow.nextPeriod : null);
  const payDate: string | null =
    selectedPeriod?.payDate ??
    (activeSchedule && activeSchedule.nextPeriodStart === periodStart && activeSchedule.nextPeriodEnd === periodEnd ? activeSchedule.nextPayDate : null);
  const truth: RunTruth = {
    scheduleId: scheduleId || null,
    scheduleName: flow?.name ?? activeSchedule?.name ?? null,
    pattern: flow?.pattern ?? null,
    people: peopleOnSchedule,
    payDate,
  };

  // When a schedule is picked, default the period to its computed "next"
  // window. The user can override. Off-cycle runs keep their arbitrary
  // dates — the schedule only scopes the client there.
  useEffect(() => {
    if (!activeSchedule || runKind === 'OFF_CYCLE') return;
    if (seededPeriodRef.current) {
      // First resolve after a seeded open — the seed already carries the
      // exact period the hero projected; don't overwrite it.
      seededPeriodRef.current = false;
      return;
    }
    setPeriodStart(activeSchedule.nextPeriodStart);
    setPeriodEnd(activeSchedule.nextPeriodEnd);
  }, [activeSchedule, runKind]);

  // Switching run type re-defaults the period: off-cycle → today/today
  // (arbitrary, editable); back to regular → the schedule's next window.
  const chooseRunKind = (k: RunKind) => {
    if (k === runKind) return;
    setRunKind(k);
    if (k === 'OFF_CYCLE') {
      const today = ymdLocal();
      setPeriodStart(today);
      setPeriodEnd(today);
    } else if (activeSchedule) {
      setPeriodStart(activeSchedule.nextPeriodStart);
      setPeriodEnd(activeSchedule.nextPeriodEnd);
    }
  };

  // The pre-flight scan describes the people in this run; people who worked
  // but are on no pay schedule are told apart (they won't be paid by it).
  const { runExceptions, unassigned } = useMemo(() => splitUnassigned(exceptions), [exceptions]);
  const blockingCount = runExceptions?.counts.blocking ?? 0;
  const scheduleEmpty = runKind === 'REGULAR' && !!scheduleId && peopleOnSchedule === 0;
  const nothingToPay = runKind === 'REGULAR' && !!preview && preview.items.length === 0;
  const canSubmit = (blockingCount === 0 || overrideBlocking) && !scheduleEmpty && !nothingToPay;
  const blockReason = scheduleEmpty
    ? `${EMPTY_SCHEDULE} — add people to it first.`
    : nothingToPay
      ? 'Nothing to pay: no approved time in this period.'
      : blockingCount > 0 && !overrideBlocking
        ? 'Resolve or acknowledge blocking exceptions first.'
        : undefined;
  // A regular run pays one schedule's people: pick the schedule when any exist.
  const needsSchedule = runKind === 'REGULAR' && activeSchedules.length > 0 && !scheduleId;

  const canAdvance: Record<Step, boolean> = {
    1: !needsSchedule && !!periodStart && !!periodEnd && periodEnd >= periodStart && !previewLoading,
    2: true,
    3: true,
    4: canSubmit,
  };

  const runCut = { clientId: activeSchedule?.clientId ?? null, payrollScheduleId: scheduleId || null };

  const fetchPreview = async () => {
    setPreviewLoading(true);
    setExceptionsLoading(true);
    setPreviewError(null);
    setExceptionsError(null);
    setPreview(null);
    setExceptions(null);
    setOverrideBlocking(false);
    ackedBlockersRef.current = '';
    const clientId = activeSchedule?.clientId ?? null;
    const payrollScheduleId = scheduleId || null;
    const exceptionsInput: PayrollExceptionsInput = { clientId, periodStart, periodEnd, payrollScheduleId };
    try {
      // Run preview + exceptions in parallel — exceptions don't need
      // defaultHourlyRate; they reuse the same set of associates. A failed
      // scan is an error state, never an empty (all-clear) list.
      const [previewRes, exceptionsRes] = await Promise.all([
        previewPayrollRun({
          clientId,
          periodStart,
          periodEnd,
          payrollScheduleId,
          defaultHourlyRate: defaultRate ? Number(defaultRate) : undefined,
          ...ledgerRun,
        }),
        listPayrollExceptions(exceptionsInput).catch((err: unknown) => {
          setExceptionsError(err instanceof ApiError ? err.message : 'the check failed');
          return null;
        }),
      ]);
      setPreview(previewRes);
      setExceptions(exceptionsRes);
      lastCheckedRef.current = Date.now();
    } catch (err) {
      setPreviewError(err instanceof ApiError ? err.message : 'Preview failed.');
    } finally {
      setPreviewLoading(false);
      setExceptionsLoading(false);
    }
  };

  // Seeded opens auto-run the preview once the schedule list resolves —
  // fetchPreview scopes by the seeded schedule's clientId, which isn't
  // known until then.
  useEffect(() => {
    if (!open || !quickPending || !schedules) return;
    setQuickPending(false);
    // eslint-disable-next-line no-restricted-syntax -- fires the user's preview action once the seeded schedule resolves; not a read to cache
    void fetchPreview();
    // fetchPreview reads current state; keyed on the schedule list arriving.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, quickPending, schedules]);

  // The collapsed review only holds while the run is clean — any blocking
  // exception drops back to the full wizard at the hours step.
  useEffect(() => {
    if (!quickReview || !exceptions) return;
    if (exceptions.counts.blocking > 0) {
      setQuickReview(false);
      setStep(2);
    }
  }, [quickReview, exceptions]);

  // Re-run the pre-flight scan — and the paycheck preview, so totals
  // never go stale behind a cleared warning — in place, so "Fix in a new
  // tab → Re-check" never costs the wizard its state.
  const [rechecking, setRechecking] = useState(false);
  const recheckExceptions = async () => {
    if (exceptionsLoading || rechecking) return;
    setExceptionsLoading(true);
    setRechecking(true);
    const clientId = activeSchedule?.clientId ?? null;
    const payrollScheduleId = scheduleId || null;
    const exceptionsInput: PayrollExceptionsInput = { clientId, periodStart, periodEnd, payrollScheduleId };
    try {
      const [res, fresh] = await Promise.all([
        listPayrollExceptions(exceptionsInput),
        runKind === 'REGULAR' && preview
          ? previewPayrollRun({ clientId, periodStart, periodEnd, payrollScheduleId, defaultHourlyRate: defaultRate ? Number(defaultRate) : undefined, ...ledgerRun }).catch(() => null)
          : Promise.resolve(null),
      ]);
      setExceptions(res);
      setExceptionsError(null);
      if (fresh) setPreview(fresh);
      // An acknowledgement covers the blockers it was given for — not new ones.
      const sig = blockerSignature(res);
      if (overrideBlocking && sig !== ackedBlockersRef.current) setOverrideBlocking(false);
      lastCheckedRef.current = Date.now();
    } catch (err) {
      setExceptionsError(err instanceof ApiError ? err.message : 'the check failed');
    } finally {
      setExceptionsLoading(false);
      setRechecking(false);
    }
  };
  const acknowledgeBlocking = (on: boolean) => {
    ackedBlockersRef.current = on ? blockerSignature(exceptions) : '';
    setOverrideBlocking(on);
  };

  // Fixes happen in other tabs (each Fix link opens one): coming back to
  // the wizard re-runs the check, at most every 10 seconds after the last
  // one arrived.
  const recheckRef = useRef(recheckExceptions);
  recheckRef.current = recheckExceptions;
  const hasScan = exceptions !== null || exceptionsError !== null;
  useEffect(() => {
    if (!open || !hasScan) return;
    const onFocus = () => {
      if (document.visibilityState === 'hidden' || Date.now() - lastCheckedRef.current < 10_000) return;
      void recheckRef.current();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [open, hasScan]);

  const next = async () => {
    if (!canAdvance[step]) return;
    if (step === 1) {
      if (runKind === 'OFF_CYCLE') {
        // Off-cycle runs skip time aggregation entirely — a preview computed
        // from approved time would describe paychecks that won't exist.
        setPreview(null);
        setPreviewError(null);
        setExceptions(null);
        setExceptionsError(null);
        setOverrideBlocking(false);
        setStep(2);
        return;
      }
      await fetchPreview();
      setStep(2);
      return;
    }
    if (step < 4) setStep((step + 1) as Step);
  };
  const back = () => {
    if (step > 1) setStep((step - 1) as Step);
  };

  // Explicit cancel wipes the in-progress session; the Dialog's own
  // dismiss paths (outside click / Escape / X) intentionally do not.
  const cancel = () => {
    sessionKeyRef.current = null;
    onOpenChange(false);
  };

  // Nothing blocks and it's a regular run: create and finalize in one step.
  const canCreateAndFinalize =
    runKind === 'REGULAR' && canSubmit && blockingCount === 0 && !!exceptions && !exceptionsError && !exceptionsLoading && !rechecking && !!preview && preview.items.length > 0;

  const submit = async (andFinalize = false) => {
    if (submitting || !canSubmit) return;
    setSubmitting(true);
    try {
      const created = await createPayrollRun({
        clientId: activeSchedule?.clientId ?? null,
        periodStart,
        periodEnd,
        payrollScheduleId: scheduleId || null,
        defaultHourlyRate: defaultRate ? Number(defaultRate) : undefined,
        notes: notes || (missedPayday ? 'Off-cycle: hours from a payday that passed with no run' : undefined),
        ...(runKind === 'OFF_CYCLE' ? { kind: 'OFF_CYCLE' as const } : {}),
        ...ledgerRun,
      });
      let detail = created;
      if (andFinalize) {
        // Finalize only the numbers that were reviewed: the run that was
        // built must be the preview's people and net pay. Anything else (time
        // approved or edited since) leaves a draft to look at first.
        const drift = preview ? previewDrift(preview, created) : 'no preview to compare against';
        if (drift) {
          toast.error(`Run created as a draft, not finalized — ${drift}. Review it, then finalize.`);
        } else {
          try {
            detail = await finalizePayrollRun(created.id);
            toast.success(`Run created and finalized — ${detail.items.length} paystubs, ready to pay.`);
          } catch (err) {
            // The run exists either way: open it as a draft and say why it stopped there.
            toast.error(`Run created, not finalized: ${err instanceof ApiError ? err.message : 'finalize failed'}.`);
          }
        }
      } else {
        toast.success(
          runKind === 'OFF_CYCLE'
            ? 'Off-cycle run created — add earning lines on the run page to build the paychecks.'
            : `Run created — ${detail.items.length} paystubs aggregated.`
        );
      }
      sessionKeyRef.current = null; // done — the next open starts fresh
      onCreated(detail);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Create failed.');
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Phones: a full-screen sheet (the review is too dense for a half sheet). */}
      <DialogContent className="sm:max-w-3xl max-sm:top-0 max-sm:max-h-none max-sm:h-[100dvh] max-sm:rounded-none max-sm:border-t-0">
        <DialogHeader>
          <DialogTitle>{missedPayday ? 'Pay a missed payday' : 'Run payroll'}</DialogTitle>
          <DialogDescription>
            {quickReview
              ? 'Review & create'
              : `${STEP_TITLES[step]} (${step} of 4)`}
          </DialogDescription>
        </DialogHeader>

        {!quickReview && (
          <Stepper
            current={step}
            steps={[
              { label: STEP_TITLES[1] },
              { label: STEP_TITLES[2] },
              { label: STEP_TITLES[3] },
              { label: STEP_TITLES[4] },
            ]}
            className="mb-4"
          />
        )}

        {missedPayday && (
          <p role="note" className="mb-3 rounded-md border border-warning/40 bg-warning/10 p-2 text-xs text-warning">
            Off-cycle run for a payday that passed with no run: it pays only the approved hours in this period that are on no paystub yet.
          </p>
        )}
        <div className="min-h-[260px]">
          {quickReview && (
            <QuickReview
              periodStart={periodStart}
              periodEnd={periodEnd}
              truth={truth}
              unassigned={unassigned}
              preview={preview}
              loading={previewLoading || quickPending}
              error={previewError}
              onRetry={fetchPreview}
              exceptions={runExceptions}
              exceptionsLoading={exceptionsLoading}
              onRecheck={recheckExceptions}
              exceptionsError={exceptionsError}
              runCut={runCut}
              notes={notes}
              setNotes={setNotes}
            />
          )}
          {!quickReview && step === 1 && (
            <Step1
              runKind={runKind}
              onRunKindChange={chooseRunKind}
              schedules={activeSchedules}
              loadingSchedules={!schedules}
              flowById={flowById}
              periodOptions={periodOptions}
              periodsLoading={calendarQuery.isLoading && !!scheduleId}
              scheduleId={scheduleId}
              setScheduleId={setScheduleId}
              periodStart={periodStart}
              setPeriodStart={setPeriodStart}
              periodEnd={periodEnd}
              setPeriodEnd={setPeriodEnd}
              defaultRate={defaultRate}
              setDefaultRate={setDefaultRate}
            />
          )}
          {!quickReview && step === 2 && (
            <Step2
              offCycle={runKind === 'OFF_CYCLE'}
              periodStart={periodStart}
              periodEnd={periodEnd}
              truth={truth}
              unassigned={unassigned}
              preview={preview}
              loading={previewLoading}
              error={previewError}
              onRetry={fetchPreview}
              exceptions={runExceptions}
              exceptionsLoading={exceptionsLoading}
              onRecheck={recheckExceptions}
              exceptionsError={exceptionsError}
              runCut={runCut}
            />
          )}
          {!quickReview && step === 3 && (
            <Step3
              offCycle={runKind === 'OFF_CYCLE'}
              periodStart={periodStart}
              periodEnd={periodEnd}
              truth={truth}
              unassigned={unassigned}
              preview={preview}
              loading={previewLoading}
              error={previewError}
              onRetry={fetchPreview}
              exceptions={runExceptions}
              exceptionsLoading={exceptionsLoading}
              onRecheck={recheckExceptions}
              exceptionsError={exceptionsError}
              runCut={runCut}
            />
          )}
          {!quickReview && step === 4 && (
            <Step4
              offCycle={runKind === 'OFF_CYCLE'}
              periodStart={periodStart}
              periodEnd={periodEnd}
              truth={truth}
              unassigned={unassigned}
              notes={notes}
              setNotes={setNotes}
              preview={preview}
              exceptions={runExceptions}
              overrideBlocking={overrideBlocking}
              setOverrideBlocking={acknowledgeBlocking}
            />
          )}
          {/* Changes vs last run, before the run is created (finance walk 9). */}
          {(quickReview || step === 3 || step === 4) && preview && preview.items.length > 0 && runKind === 'REGULAR' && (
            <div className="mt-3">
              <ChangesVsLastRun preview={preview} />
            </div>
          )}
        </div>

        {(quickReview || step === 4) && blockReason && !previewLoading && (
          <p role="status" className="-mb-1 text-xs text-warning">
            {blockReason}
          </p>
        )}

        <DialogFooter sticky className="justify-between gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={quickReview || step === 1 ? cancel : back}
            disabled={submitting}
          >
            {quickReview || step === 1 ? 'Cancel' : (
              <span className="inline-flex items-center gap-1.5">
                <ArrowLeft className="h-4 w-4" />
                Back
              </span>
            )}
          </Button>
          {quickReview ? (
            <div className="flex w-full flex-col-reverse gap-2 sm:w-auto sm:flex-row sm:items-center sm:gap-3">
              <button
                type="button"
                className="py-1.5 text-xs text-gold hover:underline"
                onClick={() => {
                  // Expand into the full 4-step path with the loaded data.
                  setQuickReview(false);
                  setStep(2);
                }}
              >
                Review in detail
              </button>
              <Button
                type="button"
                variant={canCreateAndFinalize ? 'secondary' : 'primary'}
                onClick={() => void submit()}
                loading={submitting}
                disabled={
                  previewLoading || quickPending || !!previewError || !canSubmit
                }
                title={blockReason}
              >
                <CheckCircle2 className="mr-1.5 h-4 w-4" />
                Create run
              </Button>
              {canCreateAndFinalize && (
                <Button
                  type="button"
                  onClick={() => void submit(true)}
                  loading={submitting}
                  disabled={previewLoading || quickPending || !!previewError}
                  title="Nothing blocks this run: create it and finalize it in one step"
                >
                  <CheckCircle2 className="mr-1.5 h-4 w-4" />
                  Create &amp; finalize
                </Button>
              )}
            </div>
          ) : step < 4 ? (
            <Button
              type="button"
              onClick={next}
              disabled={!canAdvance[step]}
              loading={step === 1 && previewLoading}
            >
              Next
              <ArrowRight className="ml-1.5 h-4 w-4" />
            </Button>
          ) : (
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button
                type="button"
                variant={canCreateAndFinalize ? 'secondary' : 'primary'}
                onClick={() => void submit()}
                loading={submitting}
                disabled={!canSubmit}
                title={blockReason}
              >
                <CheckCircle2 className="mr-1.5 h-4 w-4" />
                Approve &amp; create run
              </Button>
              {canCreateAndFinalize && (
                <Button
                  type="button"
                  onClick={() => void submit(true)}
                  loading={submitting}
                  title="Nothing blocks this run: create it and finalize it in one step"
                >
                  <CheckCircle2 className="mr-1.5 h-4 w-4" />
                  Create &amp; finalize
                </Button>
              )}
            </div>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Step1(props: {
  runKind: 'REGULAR' | 'OFF_CYCLE';
  onRunKindChange: (k: 'REGULAR' | 'OFF_CYCLE') => void;
  schedules: PayrollSchedule[];
  loadingSchedules: boolean;
  flowById: Map<string, FlowSchedule>;
  periodOptions: SchedulePeriod[];
  periodsLoading: boolean;
  scheduleId: string;
  setScheduleId: (v: string) => void;
  periodStart: string;
  setPeriodStart: (v: string) => void;
  periodEnd: string;
  setPeriodEnd: (v: string) => void;
  defaultRate: string;
  setDefaultRate: (v: string) => void;
}) {
  const offCycle = props.runKind === 'OFF_CYCLE';
  const term = useTerm();
  const today = ymdLocal();
  const [customDates, setCustomDates] = useState(false);
  const periodKey = `${props.periodStart}|${props.periodEnd}`;
  const showDateInputs = offCycle || !props.scheduleId || customDates || (!props.periodsLoading && props.periodOptions.length === 0);
  return (
    <div className="space-y-5">
      <fieldset>
        <legend className="mb-1.5 text-sm font-medium text-ink">Run type</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {([
            ['REGULAR', 'Regular', 'Pays one schedule’s people from their approved time.'],
            ['OFF_CYCLE', 'Off-cycle', 'Bonus or final pay: starts empty, you add the earnings.'],
          ] as const).map(([k, label, hint]) => (
            <label
              key={k}
              className={cn(
                'flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 text-sm transition-colors',
                props.runKind === k ? 'border-gold bg-gold/5' : 'border-navy-secondary hover:border-silver/40',
              )}
            >
              <input type="radio" name="run-kind" className="mt-1 accent-gold" checked={props.runKind === k} onChange={() => props.onRunKindChange(k)} />
              <span>
                <span className="block font-medium text-ink">{label}</span>
                <span className="block text-xs text-silver/80">{hint}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-1.5 text-sm font-medium text-ink">Pay schedule</legend>
        {props.loadingSchedules ? (
          <div className="space-y-2">
            <div className="h-16 animate-pulse rounded-lg bg-navy-secondary/40" />
            <div className="h-16 animate-pulse rounded-lg bg-navy-secondary/40" />
          </div>
        ) : props.schedules.length === 0 ? (
          <div className="rounded-lg border border-warning/40 bg-warning/5 p-3 text-xs text-silver">
            No pay schedules yet. A regular run pays the people on a schedule —{' '}
            <Link to="/payroll/schedules" className="text-gold underline underline-offset-2">set one up</Link>.
          </div>
        ) : (
          <div role="radiogroup" aria-label="Pay schedule" className="space-y-2">
            {offCycle && (
              <ScheduleChoice
                selected={!props.scheduleId}
                onSelect={() => props.setScheduleId('')}
                title="No schedule"
                lines={['Pick any dates; the run is for the people you add earnings for.']}
              />
            )}
            {props.schedules.map((s) => {
              const f = props.flowById.get(s.id);
              const people = f ? f.people : s.associateCount;
              const next = f?.nextPeriod ?? { periodStart: s.nextPeriodStart, periodEnd: s.nextPeriodEnd, payDate: s.nextPayDate };
              return (
                <ScheduleChoice
                  key={s.id}
                  selected={props.scheduleId === s.id}
                  onSelect={() => {
                    setCustomDates(false);
                    props.setScheduleId(s.id);
                  }}
                  title={s.name}
                  lines={[
                    f?.pattern ?? `${s.frequency.charAt(0)}${s.frequency.slice(1).toLowerCase()}${s.clientName ? ` · ${s.clientName}` : ''}`,
                    `Next: ${fmtPeriod(next.periodStart, next.periodEnd)} · paid ${fmtPayday(next.payDate)}`,
                  ]}
                  people={people}
                  blocked={f?.blocked ?? 0}
                />
              );
            })}
          </div>
        )}
      </fieldset>

      {(!!props.scheduleId || offCycle) && (
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium text-ink">Pay period</legend>
          {!offCycle && props.scheduleId && props.periodOptions.length > 0 && !customDates && (
            <div role="radiogroup" aria-label="Pay period" className="space-y-1.5">
              {props.periodOptions.map((p) => {
                // Late: its payday has passed and nobody ran it.
                const late = p.payDate < today && !p.run;
                const key = `${p.periodStart}|${p.periodEnd}`;
                return (
                  <label
                    key={key}
                    className={cn(
                      'flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2.5 text-sm transition-colors',
                      key === periodKey ? 'border-gold bg-gold/5' : 'border-navy-secondary hover:border-silver/40',
                    )}
                  >
                    <input
                      type="radio"
                      name="run-period"
                      className="accent-gold"
                      checked={key === periodKey}
                      onChange={() => {
                        props.setPeriodStart(p.periodStart);
                        props.setPeriodEnd(p.periodEnd);
                      }}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block tabular-nums text-ink">{fmtPeriod(p.periodStart, p.periodEnd)}</span>
                      <span className="block text-xs text-silver/80">
                        Paid {fmtPayday(p.payDate)}
                        {p.adjustedFor && ` (moved earlier for ${p.adjustedFor})`}
                      </span>
                    </span>
                    {late && <Badge variant="destructive" className="text-2xs">Late</Badge>}
                    {p.run?.status === 'DRAFT' && <Badge variant="pending" className="text-2xs">Draft started</Badge>}
                  </label>
                );
              })}
              <button type="button" className="text-xs text-gold underline underline-offset-2" onClick={() => setCustomDates(true)}>
                Use other dates
              </button>
            </div>
          )}
          {!offCycle && props.scheduleId && props.periodsLoading && (
            <div className="h-24 animate-pulse rounded-lg bg-navy-secondary/40" />
          )}
          {showDateInputs && !(!offCycle && props.periodsLoading) && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Period start" required>
                {(p) => <Input type="date" value={props.periodStart} onChange={(e) => props.setPeriodStart(e.target.value)} {...p} />}
              </Field>
              <Field label="Period end" required>
                {(p) => <Input type="date" value={props.periodEnd} onChange={(e) => props.setPeriodEnd(e.target.value)} {...p} />}
              </Field>
            </div>
          )}
          {customDates && props.periodOptions.length > 0 && (
            <button type="button" className="mt-1 text-xs text-gold underline underline-offset-2" onClick={() => setCustomDates(false)}>
              Back to the schedule’s periods
            </button>
          )}
        </fieldset>
      )}

      {!offCycle && (
        <Field
          label="Default hourly rate"
          hint={`Falls back to this only for ${term('workers').toLowerCase()} without an hourly rate set on their Compensation record. Everyone with a rate on file is paid that rate.`}
        >
          {(p) => (
            <Input
              type="number"
              min={0}
              step="0.01"
              value={props.defaultRate}
              onChange={(e) => props.setDefaultRate(e.target.value)}
              {...p}
            />
          )}
        </Field>
      )}
    </div>
  );
}

/** "Fri, Oct 30, 2026" — the weekday is the point of a payday. */
function fmtPayday(ymd: string | null | undefined): string {
  const d = ymd ? parseYmd(ymd) : null;
  return d ? fmtDayShort(d, { year: true, anchored: true }) : '—';
}

function ScheduleChoice({
  selected,
  onSelect,
  title,
  lines,
  people,
  blocked = 0,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  lines: string[];
  people?: number;
  blocked?: number;
}) {
  return (
    <label
      className={cn(
        'flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors',
        selected ? 'border-gold bg-gold/5' : 'border-navy-secondary hover:border-silver/40',
      )}
    >
      <input type="radio" name="run-schedule" className="mt-1 accent-gold" checked={selected} onChange={onSelect} aria-label={title} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-ink">{title}</span>
        {lines.map((l) => (
          <span key={l} className="block text-xs text-silver/80">
            {l}
          </span>
        ))}
      </span>
      {people !== undefined && (
        <span className="shrink-0 text-right">
          <span className={cn('inline-flex items-center gap-1 text-sm tabular-nums', people === 0 ? 'text-warning' : 'text-ink')}>
            <Users className="h-3.5 w-3.5" aria-hidden="true" />
            {people}
          </span>
          <span className="block text-2xs text-silver/70">{people === 1 ? 'person' : 'people'}</span>
          {blocked > 0 && <span className="block text-2xs text-alert">{blocked} blocked</span>}
        </span>
      )}
    </label>
  );
}

/** What the run will pay, stated plainly: schedule, period, payday and people. */
interface RunTruth {
  scheduleId: string | null;
  scheduleName: string | null;
  pattern: string | null;
  /** People on the schedule (null: no schedule chosen). */
  people: number | null;
  payDate: string | null;
}

/** People who worked but are on no pay schedule are a separate notice, not a paycheck exception. */
function splitUnassigned(ex: PayrollExceptionsResponse | null): { runExceptions: PayrollExceptionsResponse | null; unassigned: number } {
  if (!ex) return { runExceptions: null, unassigned: 0 };
  const isUnassigned = (e: PayrollException) => (e.kind as string) === 'UNASSIGNED_SCHEDULE';
  const unassigned = new Set(ex.exceptions.filter(isUnassigned).map((e) => e.associateId)).size;
  if (unassigned === 0) return { runExceptions: ex, unassigned: 0 };
  const rest = ex.exceptions.filter((e) => !isUnassigned(e));
  return {
    runExceptions: {
      ...ex,
      exceptions: rest,
      counts: {
        blocking: rest.filter((e) => e.severity === 'BLOCKING').length,
        warning: rest.filter((e) => e.severity === 'WARNING').length,
        info: rest.filter((e) => e.severity === 'INFO').length,
      },
    },
    unassigned,
  };
}

/**
 * The top of every review step: the schedule, the period, the payday, who
 * is on the schedule and how many have approved time — and, when that comes
 * to nothing, exactly why, with the way to fix it.
 */
/** A warning, not an empty list: a regular run of a schedule no one is on pays no one. */
const EMPTY_SCHEDULE = 'No one is on this schedule yet';

function RunTruthPanel({
  truth,
  preview,
  periodStart,
  periodEnd,
  unassigned,
}: {
  truth: RunTruth;
  preview: PayrollRunPreviewResponse | null;
  periodStart: string;
  periodEnd: string;
  unassigned: number;
}) {
  const withTime = preview ? preview.items.length : null;
  return (
    <div className="space-y-2.5">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Fact label="Schedule" value={truth.scheduleName ?? 'No schedule'} hint={truth.pattern ?? undefined} />
        <Fact label="Pay period" value={fmtPeriod(periodStart, periodEnd)} />
        <Fact label="Payday" value={truth.payDate ? fmtPayday(truth.payDate) : '—'} />
        <Fact
          label="People"
          value={truth.people === null ? (withTime === null ? '—' : String(withTime)) : `${truth.people} on this schedule`}
          hint={withTime === null ? undefined : `${withTime} with approved time`}
        />
      </div>
      {truth.people === 0 && truth.scheduleId && (
        <div role="alert" className="flex flex-wrap items-start gap-2 rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="block font-medium text-ink">{EMPTY_SCHEDULE}</span>
            <span className="block text-xs text-silver/80">A run pays only the people on its schedule. Add people to {truth.scheduleName ?? 'it'}, then run payroll.</span>
          </span>
          <Link to={`/payroll/schedules/${truth.scheduleId}`} className="inline-flex items-center gap-1 text-xs text-gold underline underline-offset-2">
            <UserPlus className="h-3.5 w-3.5" aria-hidden="true" />
            Add people
          </Link>
        </div>
      )}
      {!!truth.people && preview && preview.items.length === 0 && (
        <div role="status" className="flex flex-wrap items-start gap-2 rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="block font-medium text-ink">
              {truth.people} {truth.people === 1 ? 'person is' : 'people are'} on this schedule, but none has approved time in this period
            </span>
            <span className="block text-xs text-silver/80">Approve their time for {fmtPeriod(periodStart, periodEnd)}, or check the period.</span>
          </span>
          <Link to={`/time-attendance?tab=queue&from=${periodStart}&to=${periodEnd}`} className="text-xs text-gold underline underline-offset-2">
            Approve time
          </Link>
        </div>
      )}
      {truth.people === null && preview && preview.items.length === 0 && (
        <div className="rounded-lg border border-silver/15 bg-black/30 p-3 text-xs text-silver/80">
          No approved time falls in this period, so there is nothing to pay.
        </div>
      )}
      {unassigned > 0 && (
        <div role="status" className="flex flex-wrap items-start gap-2 rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
          <span className="min-w-0 flex-1 text-ink">
            {unassigned} {unassigned === 1 ? 'person' : 'people'} worked this period but {unassigned === 1 ? 'is' : 'are'} on no pay schedule — they won’t be paid by this run.
          </span>
          <Link to="/payroll/schedules" className="text-xs text-gold underline underline-offset-2">
            Assign them
          </Link>
        </div>
      )}
    </div>
  );
}

function Fact({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-navy-secondary px-3 py-2">
      <div className="text-2xs uppercase tracking-widest text-silver/70">{label}</div>
      <div className="mt-0.5 break-words text-sm text-ink tabular-nums">{value}</div>
      {hint && <div className="break-words text-2xs text-silver/70">{hint}</div>}
    </div>
  );
}

interface PreviewProps {
  offCycle: boolean;
  periodStart: string;
  periodEnd: string;
  truth: RunTruth;
  unassigned: number;
  preview: PayrollRunPreviewResponse | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  exceptions: PayrollExceptionsResponse | null;
  exceptionsLoading: boolean;
  onRecheck: () => void;
  /** The scan failed: shown as an error, never as an all-clear. */
  exceptionsError: string | null;
  /** The run's client and pay schedule — approving clean time uses the scan's cut. */
  runCut: { clientId: string | null; payrollScheduleId: string | null };
}

function PreviewStateBanner({
  loading,
  error,
  onRetry,
  emptyMessage,
}: {
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  emptyMessage?: string;
}) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-silver/70 py-3">
        <Loader2 className="h-4 w-4 animate-spin" />
        Computing projection from approved time entries…
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex items-start gap-2 rounded border border-alert/30 bg-alert/5 p-3 text-xs">
        <AlertCircle className="h-4 w-4 text-alert shrink-0 mt-0.5" />
        <div className="flex-1">
          <div className="text-alert font-medium">Preview failed</div>
          <div className="text-silver/70 mt-0.5">{error}</div>
        </div>
        <button
          type="button"
          className="text-gold hover:text-gold-bright text-xs"
          onClick={onRetry}
        >
          Retry
        </button>
      </div>
    );
  }
  if (emptyMessage) {
    return (
      <div className="rounded border border-silver/15 bg-black/30 p-3 text-xs text-silver/70">
        {emptyMessage}
      </div>
    );
  }
  return null;
}

/* -------------------------------------------------------------------------- *
 *  Wave 8 — Per-paycheck cards
 *
 *  QBO-style expandable card per associate. Step 2 emphasizes hours
 *  (regular vs OT split, line-level earnings). Step 3 emphasizes deductions
 *  (FIT, FICA, Medicare, SIT, garnishments → net). The collapsed form is
 *  scannable; the expanded form drills into individual lines.
 * -------------------------------------------------------------------------- */

function exceptionsByAssociate(
  ex: PayrollExceptionsResponse | null
): Map<string, PayrollException[]> {
  const m = new Map<string, PayrollException[]>();
  if (!ex) return m;
  for (const e of ex.exceptions) {
    const arr = m.get(e.associateId) ?? [];
    arr.push(e);
    m.set(e.associateId, arr);
  }
  return m;
}

function PaycheckCard({
  item,
  exceptions,
  variant,
}: {
  item: PayrollRunPreviewItem;
  exceptions: PayrollException[];
  variant: 'hours' | 'taxes';
}) {
  const [expanded, setExpanded] = useState(false);
  const blockingCount = exceptions.filter((e) => e.severity === 'BLOCKING').length;
  const otherCount = exceptions.length - blockingCount;
  return (
    <div
      className={cn(
        'rounded border bg-black/30 transition-colors',
        blockingCount > 0
          ? 'border-alert/40'
          : exceptions.length > 0
          ? 'border-warning/30'
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
          <div className="min-w-0">
            <div className="text-sm text-white truncate">{item.associateName}</div>
            <div className="text-xs2 text-silver/70 truncate">
              {item.taxState ?? '—'} · {item.payFrequency.toLowerCase()}
              {item.overtimeHours > 0 && (
                <> · <span className="text-gold">{item.overtimeHours.toFixed(1)}h OT</span></>
              )}
              {item.rideCharges && item.rideCharges.amount > 0 && <> · {fmtMoney(item.rideCharges.amount)} van rides</>}
            </div>
          </div>
          {item.rateSource === 'DEFAULT' && (
            <Badge
              variant="pending"
              className="text-2xs shrink-0"
              title="No compensation record; paying the wizard's default rate. Set their rate in People → Compensation."
            >
              default rate — no comp record
            </Badge>
          )}
          {(blockingCount > 0 || otherCount > 0) && (
            <Badge
              variant={blockingCount > 0 ? 'destructive' : 'pending'}
              className="text-2xs shrink-0"
            >
              {blockingCount > 0
                ? `${blockingCount} blocking`
                : `${otherCount} ${otherCount === 1 ? 'issue' : 'issues'}`}
            </Badge>
          )}
        </div>
        <div className="grid grid-cols-2 gap-x-4 text-right shrink-0">
          {variant === 'hours' ? (
            <>
              <CardStat label="Hours" value={item.hoursWorked.toFixed(2)} />
              <CardStat label="Gross" value={fmtMoney(item.grossPay)} />
            </>
          ) : (
            <>
              <CardStat
                label="Tax"
                value={`−${fmtMoney(
                  item.federalIncomeTax + item.fica + item.medicare + item.stateIncomeTax
                )}`}
              />
              <CardStat label="Net" value={fmtMoney(item.netPay)} highlight />
            </>
          )}
        </div>
      </button>
      {expanded && (
        <div className="border-t border-silver/10 px-3 py-3 text-xs2 space-y-3">
          {variant === 'hours' ? (
            <HoursDrillDown item={item} />
          ) : (
            <TaxDrillDown item={item} />
          )}
          {exceptions.length > 0 && (
            <div className="border-t border-silver/10 pt-2">
              <div className="text-2xs uppercase tracking-widest text-silver/70 mb-1">
                Exceptions
              </div>
              <ul className="space-y-1">
                {exceptions.map((e, i) => (
                  <li
                    key={`${e.kind}-${i}`}
                    className="flex items-start gap-2"
                  >
                    <SeverityDot severity={e.severity} />
                    <div>
                      <span className="text-silver">{EXCEPTION_COPY[e.kind]?.label ?? e.kind}</span>
                      <span className="text-silver/70"> — {e.message}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CardStat({
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
      <div className="text-2xs uppercase tracking-widest text-silver/70">
        {label}
      </div>
      <div className={cn('tabular-nums text-sm', highlight ? 'text-gold' : 'text-white')}>
        {value}
      </div>
    </div>
  );
}

/**
 * QBO-style "?" icon next to a label — TAP or click opens a one-sentence
 * explanation of the rate, cap, or source used by the math engine. This
 * was a hover Tooltip, which made all eleven tax-line explanations
 * unreachable on touch devices (Radix suppresses focus-open after a tap);
 * a click-toggled popover works for every pointer. The texts deliberately
 * cite the 2024 numbers — bumping the year means editing the constants in
 * payrollTax.ts and these strings together.
 */
function InfoTip({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <span ref={ref} className="relative inline-block align-middle ml-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="What is this?"
        className="inline-flex items-center justify-center p-1 coarse:p-2 -m-1 coarse:-m-2 text-silver/70 hover:text-silver focus:outline-none focus-visible:text-gold"
      >
        <HelpCircle className="h-3 w-3" />
      </button>
      {open && (
        <span
          role="note"
          className="absolute left-1/2 top-full z-50 mt-1.5 block w-64 max-w-[80vw] -translate-x-1/2 rounded-md border border-navy-secondary bg-navy p-2.5 text-left text-xs2 font-normal leading-relaxed text-silver normal-case tracking-normal elev-3"
        >
          {text}
        </span>
      )}
    </span>
  );
}

const TAX_TOOLTIPS = {
  FIT: 'Federal income tax withholding. Computed via IRS Pub 15-T 2024 percentage method on annualized wages, then divided back by pay frequency. W-4 step 3 (dependents), step 4(a) (other income), step 4(b) (deductions), and step 4(c) (extra) are honored.',
  FICA: 'Social Security tax. 6.2% of gross wages up to the 2024 wage base of $168,600/year. Stops once YTD wages cross the cap.',
  MEDICARE: '1.45% of all wages (no cap). An additional 0.9% Medicare surcharge applies on the portion of YTD wages above $200,000.',
  SIT: 'State income tax. Bracketed tables for CA, NY, NJ, GA, OH, VA, MN. Flat-rate for IL, PA, MI, MA, CO, AZ, KY, IN, NC, UT, ID. Zero for FL/TX/NV/WA/AK/SD/WY/TN/NH. Long-tail states use a conservative 4% fallback.',
  GARN: 'Court- or agency-issued garnishments, applied in priority order. Federal CCPA caps: 60% disposable for child support, 25% for ordinary creditors, 15% for student loans, up to 100% for tax levies and bankruptcy orders.',
  EMPLOYER:
    'Employer-side payroll taxes (FICA match 6.2% + Medicare match 1.45% + FUTA 0.6% on first $7k + per-state SUTA). Not deducted from net pay — the company owes this on top.',
  GROSS: 'Sum of regular pay (rate × regular hours) + overtime pay (rate × OT hours × 1.5) - any pre-tax deductions.',
  EMPLOYEE_TAX: 'Sum of FIT + FICA + Medicare + SIT for every paystub in the run.',
} as const;

function HoursDrillDown({ item }: { item: PayrollRunPreviewItem }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <DrillRow label="Regular hours" amount={item.regularHours.toFixed(2)} />
      <DrillRow
        label="Regular pay"
        amount={fmtMoney(item.regularHours * item.hourlyRate)}
      />
      <DrillRow
        label="Overtime hours"
        amount={item.overtimeHours.toFixed(2)}
        accent={item.overtimeHours > 0}
      />
      <DrillRow
        label="Overtime pay (1.5×)"
        amount={fmtMoney(item.overtimeHours * item.hourlyRate * 1.5)}
        accent={item.overtimeHours > 0}
      />
      <DrillRow label="Hourly rate" amount={fmtMoney(item.hourlyRate)} />
      <DrillRow
        label="Pre-tax deductions"
        amount={
          item.preTaxDeductions > 0
            ? `−${fmtMoney(item.preTaxDeductions)}`
            : '—'
        }
      />
      <DrillRow label="Gross pay" amount={fmtMoney(item.grossPay)} bold />
    </div>
  );
}

function TaxDrillDown({ item }: { item: PayrollRunPreviewItem }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <DrillRow
        label={
          <>
            Gross pay
            <InfoTip text={TAX_TOOLTIPS.GROSS} />
          </>
        }
        amount={fmtMoney(item.grossPay)}
      />
      <DrillRow
        label={
          <>
            Federal income tax
            <InfoTip text={TAX_TOOLTIPS.FIT} />
          </>
        }
        amount={`−${fmtMoney(item.federalIncomeTax)}`}
      />
      <DrillRow
        label={
          <>
            Social Security (FICA)
            <InfoTip text={TAX_TOOLTIPS.FICA} />
          </>
        }
        amount={`−${fmtMoney(item.fica)}`}
      />
      <DrillRow
        label={
          <>
            Medicare
            <InfoTip text={TAX_TOOLTIPS.MEDICARE} />
          </>
        }
        amount={`−${fmtMoney(item.medicare)}`}
      />
      <DrillRow
        label={
          <>
            State income tax{item.taxState ? ` (${item.taxState})` : ''}
            <InfoTip text={TAX_TOOLTIPS.SIT} />
          </>
        }
        amount={`−${fmtMoney(item.stateIncomeTax)}`}
      />
      <DrillRow
        label={
          <>
            Garnishments
            <InfoTip text={TAX_TOOLTIPS.GARN} />
          </>
        }
        amount={
          item.postTaxDeductions > 0
            ? `−${fmtMoney(item.postTaxDeductions)}`
            : '—'
        }
        accent={item.postTaxDeductions > 0}
      />
      {item.rideCharges && (item.rideCharges.amount > 0 || item.rideCharges.deferred > 0 || item.rideCharges.unauthorized > 0) && (
        <DrillRow
          label={
            <span>
              Van rides ({item.rideCharges.rides} rides, {item.rideCharges.noShows} missed)
              {item.rideCharges.deferred > 0 && (
                <span className="ml-2 text-xs text-silver/60">+{fmtMoney(item.rideCharges.deferred)} deferred by the minimum-wage guard</span>
              )}
              {item.rideCharges.unauthorized > 0 && (
                <span className="ml-2 text-xs text-silver/60">{fmtMoney(item.rideCharges.unauthorized)} not authorized — not deducted</span>
              )}
            </span>
          }
          amount={item.rideCharges.amount > 0 ? `−${fmtMoney(item.rideCharges.amount)}` : '—'}
          accent={item.rideCharges.amount > 0}
        />
      )}
      <DrillRow label="Net pay" amount={fmtMoney(item.netPay)} bold accent />
      <DrillRow
        label={
          <>
            Employer cost
            <InfoTip text={TAX_TOOLTIPS.EMPLOYER} />
          </>
        }
        amount={fmtMoney(
          item.employerFica + item.employerMedicare + item.employerFuta + item.employerSuta
        )}
      />
    </div>
  );
}

function DrillRow({
  label,
  amount,
  accent,
  bold,
}: {
  label: React.ReactNode;
  amount: string;
  accent?: boolean;
  bold?: boolean;
}) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-silver/70 inline-flex items-center">{label}</span>
      <span
        className={cn(
          'tabular-nums',
          bold ? 'font-medium' : '',
          accent ? 'text-gold' : 'text-white'
        )}
      >
        {amount}
      </span>
    </div>
  );
}

function Step2({
  offCycle,
  periodStart,
  periodEnd,
  truth,
  unassigned,
  preview,
  loading,
  error,
  onRetry,
  exceptions,
  exceptionsLoading,
  onRecheck,
  exceptionsError,
  runCut,
}: PreviewProps) {
  const exMap = exceptionsByAssociate(exceptions);
  if (offCycle) {
    return (
      <div className="space-y-3 text-sm">
        <Pill icon={<Calendar className="h-3.5 w-3.5" />}>
          {fmtPeriod(periodStart, periodEnd)} · off-cycle
        </Pill>
        <div className="rounded border border-gold/30 bg-gold/5 p-3 text-xs text-silver/80">
          Nothing to review yet — off-cycle runs don't pull hours from time
          entries. The run is created empty; paychecks come from add-on earning
          lines (bonus, severance, retro pay) you add on the run page after
          creating.
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-3 text-sm">
      <RunTruthPanel truth={truth} preview={preview} periodStart={periodStart} periodEnd={periodEnd} unassigned={unassigned} />

      <ExceptionStrip exceptions={exceptions} loading={exceptionsLoading} error={exceptionsError} onRecheck={onRecheck} paychecks={preview?.items.length ?? 0} period={{ start: periodStart, end: periodEnd, ...runCut }} onTimeApproved={onRetry} />

      <p className="text-silver/70 text-xs">
        Hours come from <strong>APPROVED</strong> time entries in this period.
        PENDING / REJECTED entries are excluded — fix those in <strong>Time</strong> if a paystub looks short.
      </p>

      <PreviewStateBanner loading={loading} error={error} onRetry={onRetry} />

      {preview && preview.items.length > 0 && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <Stat label="Paystubs" value={String(preview.totals.itemCount)} />
            <Stat label="Total gross" value={fmtMoney(preview.totals.totalGross)} />
            <Stat label="Total net" value={fmtMoney(preview.totals.totalNet)} />
            <Stat label="Employer cost" value={fmtMoney(preview.totals.totalEmployerTax)} />
          </div>
          <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
            {preview.items.map((it) => (
              <PaycheckCard
                key={it.associateId}
                item={it}
                exceptions={exMap.get(it.associateId) ?? []}
                variant="hours"
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Step3({
  offCycle,
  periodStart,
  periodEnd,
  truth,
  unassigned,
  preview,
  loading,
  error,
  onRetry,
  exceptions,
  exceptionsLoading,
  onRecheck,
  exceptionsError,
  runCut,
}: PreviewProps) {
  void periodStart;
  void periodEnd;
  void unassigned;
  const exMap = exceptionsByAssociate(exceptions);
  if (offCycle) {
    return (
      <div className="space-y-3 text-sm">
        <div className="rounded border border-gold/30 bg-gold/5 p-3 text-xs text-silver/80">
          No wages or deductions to review yet — this off-cycle run starts
          empty. Taxes and deductions are computed when you add earning lines
          on the run page after creating.
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-3 text-sm">
      <ExceptionStrip exceptions={exceptions} loading={exceptionsLoading} error={exceptionsError} onRecheck={onRecheck} paychecks={preview?.items.length ?? 0} period={{ start: periodStart, end: periodEnd, ...runCut }} onTimeApproved={onRetry} />

      <PreviewStateBanner loading={loading} error={error} onRetry={onRetry} />

      {preview && preview.items.length > 0 && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <Stat
              label={<>Gross<InfoTip text={TAX_TOOLTIPS.GROSS} /></>}
              value={fmtMoney(preview.totals.totalGross)}
            />
            <Stat
              label={<>Employee tax<InfoTip text={TAX_TOOLTIPS.EMPLOYEE_TAX} /></>}
              value={`−${fmtMoney(preview.totals.totalEmployeeTax)}`}
            />
            {preview.totals.totalGarnishments > 0 ? (
              <Stat
                label={<>Garnishments<InfoTip text={TAX_TOOLTIPS.GARN} /></>}
                value={`−${fmtMoney(preview.totals.totalGarnishments)}`}
              />
            ) : (
              <Stat
                label={<>Employer cost<InfoTip text={TAX_TOOLTIPS.EMPLOYER} /></>}
                value={fmtMoney(preview.totals.totalEmployerTax)}
              />
            )}
            <Stat label="Net" value={fmtMoney(preview.totals.totalNet)} highlight />
          </div>

          <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
            {preview.items.map((it) => (
              <PaycheckCard
                key={it.associateId}
                item={it}
                exceptions={exMap.get(it.associateId) ?? []}
                variant="taxes"
              />
            ))}
          </div>

          <p className="text-2xs text-silver/70">
            Withholding follows IRS Pub 15-T 2026 and each state’s 2026 method; a state without a reviewed method blocks the run instead of guessing.
          </p>
        </>
      )}

      {truth.payDate && (
        <p className="text-xs text-silver/70">
          Paid on <strong className="text-silver/80">{fmtPayday(truth.payDate)}</strong>.
        </p>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 *  Collapsed clean-run review
 *
 *  Shown instead of the 4-step flow when the wizard opened seeded (hero CTA)
 *  and the preview came back with zero blocking exceptions: exception strip
 *  on top, hours + deductions rollup and per-paycheck cards in one scroll,
 *  Create run as the primary action. "Review in detail" in the footer
 *  expands back into the full step path.
 * -------------------------------------------------------------------------- */

function QuickReview({
  periodStart,
  periodEnd,
  truth,
  unassigned,
  preview,
  loading,
  error,
  onRetry,
  exceptions,
  exceptionsLoading,
  onRecheck,
  exceptionsError,
  runCut,
  notes,
  setNotes,
}: {
  periodStart: string;
  periodEnd: string;
  truth: RunTruth;
  unassigned: number;
  preview: PayrollRunPreviewResponse | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  exceptions: PayrollExceptionsResponse | null;
  exceptionsLoading: boolean;
  onRecheck: () => void;
  exceptionsError: string | null;
  runCut: { clientId: string | null; payrollScheduleId: string | null };
  notes: string;
  setNotes: (v: string) => void;
}) {
  const exMap = exceptionsByAssociate(exceptions);
  return (
    <div className="space-y-3 text-sm">
      <RunTruthPanel truth={truth} preview={preview} periodStart={periodStart} periodEnd={periodEnd} unassigned={unassigned} />

      <ExceptionStrip
        exceptions={exceptions}
        loading={exceptionsLoading}
        error={exceptionsError}
        onRecheck={onRecheck}
        paychecks={preview?.items.length ?? 0}
        period={{ start: periodStart, end: periodEnd, ...runCut }}
        onTimeApproved={onRetry}
      />

      <PreviewStateBanner loading={loading} error={error} onRetry={onRetry} />

      {preview && preview.items.length > 0 && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs">
            <Stat label="Paystubs" value={String(preview.totals.itemCount)} />
            <Stat
              label={<>Gross<InfoTip text={TAX_TOOLTIPS.GROSS} /></>}
              value={fmtMoney(preview.totals.totalGross)}
            />
            <Stat
              label={<>Employee tax<InfoTip text={TAX_TOOLTIPS.EMPLOYEE_TAX} /></>}
              value={`−${fmtMoney(preview.totals.totalEmployeeTax)}`}
            />
            <Stat
              label={<>Employer cost<InfoTip text={TAX_TOOLTIPS.EMPLOYER} /></>}
              value={fmtMoney(preview.totals.totalEmployerTax)}
            />
            <Stat label="Net" value={fmtMoney(preview.totals.totalNet)} highlight />
          </div>

          <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
            {preview.items.map((it) => (
              <PaycheckCard
                key={it.associateId}
                item={it}
                exceptions={exMap.get(it.associateId) ?? []}
                variant="hours"
              />
            ))}
          </div>

          {truth.payDate && (
            <p className="text-xs text-silver/70">
              Paid on <strong className="text-silver/80">{fmtPayday(truth.payDate)}</strong>.
            </p>
          )}
        </>
      )}

      {preview && (
        <Field label="Notes (optional)">
          {(p) => (
            <Textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. Holiday week — pay date moved to Thursday"
              {...p}
            />
          )}
        </Field>
      )}
    </div>
  );
}

function Stat({ label, value, highlight }: { label: React.ReactNode; value: string; highlight?: boolean }) {
  return (
    <div className={cn('rounded border border-silver/15 bg-black/30 px-3 py-2', highlight && 'border-gold/40 bg-gold/5')}>
      <div className={cn('text-2xs uppercase tracking-widest inline-flex items-center', highlight ? 'text-gold' : 'text-silver/70')}>
        {label}
      </div>
      <div className={cn('mt-0.5 tabular-nums', highlight ? 'text-gold' : 'text-white')}>{value}</div>
    </div>
  );
}

function Step4({
  offCycle,
  periodStart,
  periodEnd,
  truth,
  unassigned,
  notes,
  setNotes,
  preview,
  exceptions,
  overrideBlocking,
  setOverrideBlocking,
}: {
  offCycle: boolean;
  periodStart: string;
  periodEnd: string;
  truth: RunTruth;
  unassigned: number;
  notes: string;
  setNotes: (v: string) => void;
  preview: PayrollRunPreviewResponse | null;
  exceptions: PayrollExceptionsResponse | null;
  overrideBlocking: boolean;
  setOverrideBlocking: (v: boolean) => void;
}) {
  const blocking = exceptions?.counts.blocking ?? 0;

  const taxBreakdown = preview
    ? preview.items.reduce(
        (acc, it) => {
          acc.fit += it.federalIncomeTax;
          acc.fica += it.fica;
          acc.medicare += it.medicare;
          acc.sit += it.stateIncomeTax;
          acc.preTax += it.preTaxDeductions;
          acc.postTax += it.postTaxDeductions;
          return acc;
        },
        { fit: 0, fica: 0, medicare: 0, sit: 0, preTax: 0, postTax: 0 },
      )
    : null;

  return (
    <div className="space-y-4 text-sm">
      {!offCycle && <RunTruthPanel truth={truth} preview={preview} periodStart={periodStart} periodEnd={periodEnd} unassigned={unassigned} />}
      <div className="rounded border border-gold/30 bg-gold/5 p-3 text-xs">
        <div className="flex items-center gap-2 text-gold mb-1.5">
          <FileText className="h-4 w-4" />
          <span className="font-medium uppercase tracking-wide">Ready to create</span>
        </div>
        <ul className="space-y-1 text-silver/80">
          <li>• Period {fmtPeriod(periodStart, periodEnd)}</li>
          {offCycle && (
            <li>
              • <strong>Off-cycle</strong> — created empty; paychecks come from add-on earning
              lines you add on the run page after creating.
            </li>
          )}
          {truth.scheduleName && <li>• Schedule: {truth.scheduleName}{truth.pattern ? ` — ${truth.pattern}` : ''}</li>}
          {truth.people !== null && <li>• {truth.people} {truth.people === 1 ? 'person' : 'people'} on this schedule</li>}
          {truth.payDate && <li>• Paid {fmtPayday(truth.payDate)}</li>}
          {preview && (
            <li>
              • {preview.totals.itemCount} paystub{preview.totals.itemCount === 1 ? '' : 's'} ·
              gross {fmtMoney(preview.totals.totalGross)} ·
              net {fmtMoney(preview.totals.totalNet)} ·
              employer cost {fmtMoney(preview.totals.totalEmployerTax)}
            </li>
          )}
          <li>• Status will be <strong>Draft</strong> until you finalize it from the run drawer.</li>
          <li>• The run posts to the company books on finalize and disbursement (and on to QuickBooks when it is connected).</li>
        </ul>
      </div>

      {preview && taxBreakdown && (
        <div className="rounded border border-silver/20 bg-black/30 p-3 text-xs">
          <div className="font-medium uppercase tracking-wide text-silver/80 mb-2">
            Withholding breakdown (employee side)
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
            <div>
              <dt className="text-silver/70">Federal income tax</dt>
              <dd className="text-silver">{fmtMoney(taxBreakdown.fit)}</dd>
            </div>
            <div>
              <dt className="text-silver/70">FICA (6.2%)</dt>
              <dd className="text-silver">{fmtMoney(taxBreakdown.fica)}</dd>
            </div>
            <div>
              <dt className="text-silver/70">Medicare (1.45%)</dt>
              <dd className="text-silver">{fmtMoney(taxBreakdown.medicare)}</dd>
            </div>
            <div>
              <dt className="text-silver/70">State income tax</dt>
              <dd className="text-silver">{fmtMoney(taxBreakdown.sit)}</dd>
            </div>
            <div>
              <dt className="text-silver/70">Pre-tax deductions</dt>
              <dd className="text-silver">{fmtMoney(taxBreakdown.preTax)}</dd>
            </div>
            <div>
              <dt className="text-silver/70">Post-tax deductions</dt>
              <dd className="text-silver">{fmtMoney(taxBreakdown.postTax)}</dd>
            </div>
            <div>
              <dt className="text-silver/70">Garnishments</dt>
              <dd className="text-silver">{fmtMoney(preview.totals.totalGarnishments)}</dd>
            </div>
            <div>
              <dt className="text-silver/70">Total employee tax</dt>
              <dd className="text-silver font-semibold">
                {fmtMoney(preview.totals.totalEmployeeTax)}
              </dd>
            </div>
          </dl>
        </div>
      )}

      {blocking > 0 && (
        <div className="rounded border border-alert/40 bg-alert/5 p-3 text-xs space-y-2">
          <div className="flex items-center gap-2 text-alert">
            <ShieldAlert className="h-4 w-4" />
            <span className="font-medium uppercase tracking-wide">
              {blocking} blocking {blocking === 1 ? 'issue' : 'issues'}
            </span>
          </div>
          <p className="text-silver/70">
            Blocking issues mean a paycheck will be wrong (e.g. no W-4 to
            withhold against). Resolve them in the previous step, OR
            acknowledge below to proceed anyway — those associates will be
            included in the run with degraded math.
          </p>
          <label className="flex items-start gap-2 cursor-pointer text-silver/80">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={overrideBlocking}
              onChange={(e) => setOverrideBlocking(e.target.checked)}
            />
            <span>
              I understand the blocking issues and want to create the run anyway.
            </span>
          </label>
        </div>
      )}

      <Field label="Notes (optional)">
        {(p) => (
          <Textarea
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. Holiday week — pay date moved to Thursday"
            {...p}
          />
        )}
      </Field>
    </div>
  );
}

function Pill({ children, icon }: { children: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-silver/20 bg-black/30 px-2.5 py-1 text-xs text-silver/80">
      {icon}
      {children}
    </span>
  );
}

/** The blocking exceptions, as a stable string — what an acknowledgement covered. */
function blockerSignature(ex: PayrollExceptionsResponse | null): string {
  if (!ex) return '';
  return ex.exceptions
    .filter((e) => e.severity === 'BLOCKING')
    .map((e) => `${e.associateId}:${e.kind}`)
    .sort()
    .join('|');
}

/** Why the created run isn't the previewed one — or null when it is (people and net pay, to the cent). */
export function previewDrift(preview: PayrollRunPreviewResponse, run: { items: unknown[]; totalNet: number }): string | null {
  const people = preview.items.length;
  if (run.items.length !== people) return `${run.items.length} paychecks were built, the preview showed ${people}`;
  if (Math.abs(run.totalNet - preview.totals.totalNet) >= 0.01) {
    return `net pay came to ${fmtMoney(run.totalNet)}, the preview showed ${fmtMoney(preview.totals.totalNet)}`;
  }
  return null;
}
