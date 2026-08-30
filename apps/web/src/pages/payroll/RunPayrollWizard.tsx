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

import { useEffect, useMemo, useRef, useState } from 'react';
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
  ExternalLink,
  FileText,
  HelpCircle,
  Info,
  Loader2,
  ShieldAlert,
} from 'lucide-react';
import type {
  PayrollException,
  PayrollExceptionsResponse,
  PayrollRunDetail,
  PayrollRunPreviewItem,
  PayrollRunPreviewResponse,
  PayrollSchedule,
} from '@alto-people/shared';
import {
  createPayrollRun,
  listPayrollExceptions,
  listPayrollSchedules,
  previewPayrollRun,
} from '@/lib/payrollApi';
import { ApiError } from '@/lib/api';
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
import { Select } from '@/components/ui/Select';
import { Stepper } from '@/components/ui/Stepper';
import { toast } from '@/components/ui/Toaster';
import { cn } from '@/lib/cn';
import { fmtDate, fmtMoney, parseYmd, ymdLocal } from '@/lib/format';

/** "May 13, 2026 → May 26, 2026" — a YMD period, parsed as local days. */
const fmtPeriod = (startYmd: string, endYmd: string) =>
  `${fmtDate(parseYmd(startYmd))} → ${fmtDate(parseYmd(endYmd))}`;

/** Prefill handed in by the hero card so step 1 doesn't re-ask. */
export interface RunPayrollSeed {
  scheduleId: string;
  periodStart: string;
  periodEnd: string;
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
  const [schedules, setSchedules] = useState<PayrollSchedule[] | null>(null);
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
  const [overrideBlocking, setOverrideBlocking] = useState(false);
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
    ? `${seed.scheduleId}|${seed.periodStart}|${seed.periodEnd}`
    : '';
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
    setSchedules(null);
    setPreview(null);
    setPreviewError(null);
    setExceptions(null);
    setOverrideBlocking(false);
    setScheduleId(seed?.scheduleId ?? '');
    setPeriodStart(seed?.periodStart ?? '');
    setPeriodEnd(seed?.periodEnd ?? '');
    seededPeriodRef.current = !!seed;
    setQuickReview(!!seed);
    setQuickPending(!!seed);
    listPayrollSchedules()
      .then((res) => setSchedules(res.schedules))
      .catch((err) =>
        toast.error(err instanceof ApiError ? err.message : 'Failed to load schedules.')
      );
    // seedKey is the value-compare proxy for `seed`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, seedKey]);

  const activeSchedule = useMemo(
    () => schedules?.find((s) => s.id === scheduleId) ?? null,
    [schedules, scheduleId]
  );

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

  const blockingCount = exceptions?.counts.blocking ?? 0;
  const canSubmit = blockingCount === 0 || overrideBlocking;

  const canAdvance: Record<Step, boolean> = {
    1: !!periodStart && !!periodEnd && periodEnd >= periodStart && !previewLoading,
    2: true,
    3: true,
    4: canSubmit,
  };

  const fetchPreview = async () => {
    setPreviewLoading(true);
    setExceptionsLoading(true);
    setPreviewError(null);
    setPreview(null);
    setExceptions(null);
    setOverrideBlocking(false);
    const clientId = activeSchedule?.clientId ?? null;
    try {
      // Run preview + exceptions in parallel — exceptions don't need
      // defaultHourlyRate; they reuse the same set of associates.
      const [previewRes, exceptionsRes] = await Promise.all([
        previewPayrollRun({
          clientId,
          periodStart,
          periodEnd,
          defaultHourlyRate: defaultRate ? Number(defaultRate) : undefined,
        }),
        listPayrollExceptions({ clientId, periodStart, periodEnd }).catch(() => ({
          exceptions: [],
          counts: { blocking: 0, warning: 0, info: 0 },
        })),
      ]);
      setPreview(previewRes);
      setExceptions(exceptionsRes);
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

  // Re-run just the pre-flight exception scan in place, so "Fix in a new
  // tab → Re-check" never costs the wizard its state.
  const recheckExceptions = async () => {
    if (exceptionsLoading) return;
    setExceptionsLoading(true);
    const clientId = activeSchedule?.clientId ?? null;
    try {
      const res = await listPayrollExceptions({ clientId, periodStart, periodEnd });
      setExceptions(res);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Exception re-check failed.');
    } finally {
      setExceptionsLoading(false);
    }
  };

  const next = async () => {
    if (!canAdvance[step]) return;
    if (step === 1) {
      if (runKind === 'OFF_CYCLE') {
        // Off-cycle runs skip time aggregation entirely — a preview computed
        // from approved time would describe paychecks that won't exist.
        setPreview(null);
        setPreviewError(null);
        setExceptions(null);
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

  const submit = async () => {
    if (submitting || !canSubmit) return;
    setSubmitting(true);
    try {
      const detail = await createPayrollRun({
        clientId: activeSchedule?.clientId ?? null,
        periodStart,
        periodEnd,
        defaultHourlyRate: defaultRate ? Number(defaultRate) : undefined,
        notes: notes || undefined,
        ...(runKind === 'OFF_CYCLE' ? { kind: 'OFF_CYCLE' as const } : {}),
      });
      toast.success(
        runKind === 'OFF_CYCLE'
          ? 'Off-cycle run created — add earning lines on the run page to build the paychecks.'
          : `Run created — ${detail.items.length} paystubs aggregated.`
      );
      sessionKeyRef.current = null; // done — the next open starts fresh
      onCreated(detail);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Create failed.');
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Run payroll</DialogTitle>
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

        <div className="min-h-[260px]">
          {quickReview && (
            <QuickReview
              periodStart={periodStart}
              periodEnd={periodEnd}
              schedule={activeSchedule}
              preview={preview}
              loading={previewLoading || quickPending}
              error={previewError}
              onRetry={fetchPreview}
              exceptions={exceptions}
              exceptionsLoading={exceptionsLoading}
              onRecheck={recheckExceptions}
              notes={notes}
              setNotes={setNotes}
            />
          )}
          {!quickReview && step === 1 && (
            <Step1
              runKind={runKind}
              onRunKindChange={chooseRunKind}
              schedules={schedules}
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
              schedule={activeSchedule}
              preview={preview}
              loading={previewLoading}
              error={previewError}
              onRetry={fetchPreview}
              exceptions={exceptions}
              exceptionsLoading={exceptionsLoading}
              onRecheck={recheckExceptions}
            />
          )}
          {!quickReview && step === 3 && (
            <Step3
              offCycle={runKind === 'OFF_CYCLE'}
              periodStart={periodStart}
              periodEnd={periodEnd}
              schedule={activeSchedule}
              preview={preview}
              loading={previewLoading}
              error={previewError}
              onRetry={fetchPreview}
              exceptions={exceptions}
              exceptionsLoading={exceptionsLoading}
              onRecheck={recheckExceptions}
            />
          )}
          {!quickReview && step === 4 && (
            <Step4
              offCycle={runKind === 'OFF_CYCLE'}
              periodStart={periodStart}
              periodEnd={periodEnd}
              schedule={activeSchedule}
              notes={notes}
              setNotes={setNotes}
              preview={preview}
              exceptions={exceptions}
              overrideBlocking={overrideBlocking}
              setOverrideBlocking={setOverrideBlocking}
            />
          )}
        </div>

        <DialogFooter className="justify-between gap-2">
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
            <div className="flex items-center gap-3">
              <button
                type="button"
                className="text-xs text-gold hover:underline"
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
                onClick={submit}
                loading={submitting}
                disabled={
                  previewLoading || quickPending || !!previewError || !canSubmit
                }
              >
                <CheckCircle2 className="mr-1.5 h-4 w-4" />
                Create run
              </Button>
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
            <Button
              type="button"
              onClick={submit}
              loading={submitting}
              disabled={!canSubmit}
              title={!canSubmit ? 'Resolve or acknowledge blocking exceptions first.' : undefined}
            >
              <CheckCircle2 className="mr-1.5 h-4 w-4" />
              Approve &amp; create run
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Step1(props: {
  runKind: 'REGULAR' | 'OFF_CYCLE';
  onRunKindChange: (k: 'REGULAR' | 'OFF_CYCLE') => void;
  schedules: PayrollSchedule[] | null;
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
  return (
    <div className="space-y-4">
      <fieldset>
        <legend className="mb-1.5 text-sm font-medium text-silver">Run type</legend>
        <div className="space-y-1.5">
          <label className="flex cursor-pointer items-start gap-2 text-xs text-silver/80">
            <input
              type="radio"
              name="run-kind"
              className="mt-0.5"
              checked={!offCycle}
              onChange={() => props.onRunKindChange('REGULAR')}
            />
            <span>
              <span className="text-white">Regular</span> — from approved time in the period
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-2 text-xs text-silver/80">
            <input
              type="radio"
              name="run-kind"
              className="mt-0.5"
              checked={offCycle}
              onChange={() => props.onRunKindChange('OFF_CYCLE')}
            />
            <span>
              <span className="text-white">Off-cycle</span> — bonus / terminal pay; starts empty,
              add earnings after creating
            </span>
          </label>
        </div>
      </fieldset>
      {offCycle && (
        <div className="rounded border border-gold/30 bg-gold/5 p-3 text-xs text-silver/80">
          Off-cycle runs skip time aggregation and are created with no paychecks. After creating,
          open the run page and add add-on earning lines (bonus, severance, retro pay) — those
          lines become the paychecks. Period dates are up to you and default to today.
        </div>
      )}
      <Field
        label="Pay schedule"
        hint={
          props.schedules && props.schedules.length === 0
            ? 'No pay schedules defined yet. Create one in the Schedules tab to auto-derive the next period.'
            : undefined
        }
      >
        {(p) => (
          <Select
            value={props.scheduleId}
            onChange={(e) => props.setScheduleId(e.target.value)}
            {...p}
          >
            <option value="">— No schedule (custom dates) —</option>
            {props.schedules?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} · {s.frequency.toLowerCase()}
                {s.clientName ? ` · ${s.clientName}` : ' · all clients'}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Period start" required>
          {(p) => (
            <Input
              type="date"
              value={props.periodStart}
              onChange={(e) => props.setPeriodStart(e.target.value)}
              {...p}
            />
          )}
        </Field>
        <Field label="Period end" required>
          {(p) => (
            <Input
              type="date"
              value={props.periodEnd}
              onChange={(e) => props.setPeriodEnd(e.target.value)}
              {...p}
            />
          )}
        </Field>
      </div>
      {!offCycle && (
        <Field
          label="Default hourly rate"
          hint="Falls back to this only for associates without an hourly rate set on their Compensation record. Everyone with a rate on file is paid that rate."
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

interface PreviewProps {
  offCycle: boolean;
  periodStart: string;
  periodEnd: string;
  schedule: PayrollSchedule | null;
  preview: PayrollRunPreviewResponse | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  exceptions: PayrollExceptionsResponse | null;
  exceptionsLoading: boolean;
  onRecheck: () => void;
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
 *  Wave 8 — Exception strip
 *
 *  Renders blocking → warning → info severities as a compact, expandable
 *  banner above the per-paycheck cards. Mirrors the QBO behavior of
 *  preventing run submission until blockers are dismissed/resolved.
 * -------------------------------------------------------------------------- */

const EXCEPTION_COPY: Record<PayrollException['kind'], { label: string }> = {
  MISSING_W4: { label: 'Missing W-4' },
  MISSING_BANK_ACCOUNT: { label: 'No payout method' },
  TERMINATED_IN_RUN: { label: 'Terminated in period' },
  OT_SPIKE: { label: 'OT spike' },
  UNSUPPORTED_STATE: { label: 'Unsupported SIT state' },
  UNAPPROVED_TIME: { label: 'Unapproved time' },
  MISSING_COMP_RECORD: { label: 'No comp record' },
};

/**
 * Best fix surface per exception kind: unapproved time is resolved on the
 * Time page (approve the entries there), everything else on the associate
 * profile. Opened in a new tab so the in-progress wizard survives.
 */
const fixHref = (ex: PayrollException) =>
  ex.kind === 'UNAPPROVED_TIME'
    ? `/time-attendance?associate=${ex.associateId}`
    : `/people?associateId=${ex.associateId}`;

function ExceptionStrip({
  exceptions,
  loading,
  onRecheck,
}: {
  exceptions: PayrollExceptionsResponse | null;
  loading: boolean;
  onRecheck?: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs2 text-silver/70 py-2">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Checking pre-flight exceptions…
      </div>
    );
  }
  if (!exceptions || exceptions.exceptions.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded border border-success/20 bg-success/5 px-3 py-2 text-xs2 text-success">
        <CheckCircle2 className="h-3.5 w-3.5" />
        <span className="flex-1">
          No exceptions — every associate has a W-4, a payout method, and a supported state.
        </span>
        {onRecheck && exceptions && (
          <button
            type="button"
            onClick={onRecheck}
            className="shrink-0 text-2xs text-gold hover:underline"
            title="Re-run the pre-flight scan"
          >
            Re-check
          </button>
        )}
      </div>
    );
  }
  const { blocking, warning, info } = exceptions.counts;
  const tone = blocking > 0
    ? 'border-alert/40 bg-alert/5 text-alert'
    : warning > 0
    ? 'border-warning/30 bg-warning/5 text-warning'
    : 'border-silver/20 bg-black/40 text-silver';
  const Icon = blocking > 0 ? ShieldAlert : warning > 0 ? AlertTriangle : Info;

  return (
    <div className={cn('rounded border', tone.split(' ').slice(0, 2).join(' '))}>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex-1 flex items-center justify-between gap-2 px-3 py-2 text-left"
          aria-expanded={open}
        >
          <span className={cn('flex items-center gap-2 text-xs', tone.split(' ')[2])}>
            <Icon className="h-4 w-4" />
            <span className="font-medium">
              {blocking > 0
                ? `${blocking} blocking ${blocking === 1 ? 'issue' : 'issues'}`
                : `${exceptions.exceptions.length} ${exceptions.exceptions.length === 1 ? 'issue' : 'issues'} to review`}
            </span>
            <span className="text-silver/70">
              {warning > 0 && ` · ${warning} warning${warning === 1 ? '' : 's'}`}
              {info > 0 && ` · ${info} info`}
            </span>
          </span>
          {open ? <ChevronDown className="h-4 w-4 text-silver/70" /> : <ChevronRight className="h-4 w-4 text-silver/70" />}
        </button>
        {onRecheck && (
          <button
            type="button"
            onClick={onRecheck}
            className="shrink-0 px-2 py-2 text-2xs text-gold hover:underline"
            title="Re-run the pre-flight scan after fixing issues in another tab"
          >
            Re-check
          </button>
        )}
      </div>
      {open && (
        <ul className="border-t border-silver/10 divide-y divide-silver/5 max-h-56 overflow-y-auto">
          {exceptions.exceptions.map((ex, i) => (
            <li
              key={`${ex.associateId}-${ex.kind}-${i}`}
              className="px-3 py-2 text-xs"
            >
              <div className="flex items-center gap-2">
                <SeverityDot severity={ex.severity} />
                <span className="text-white">{ex.associateName}</span>
                <Badge
                  variant={
                    ex.severity === 'BLOCKING'
                      ? 'destructive'
                      : ex.severity === 'WARNING'
                      ? 'pending'
                      : 'default'
                  }
                  className="text-2xs"
                >
                  {EXCEPTION_COPY[ex.kind].label}
                </Badge>
                <Link
                  to={fixHref(ex)}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-auto inline-flex items-center gap-1 text-2xs text-gold hover:underline"
                  title="Fix in a new tab — the wizard stays where it is"
                >
                  Fix <ExternalLink className="h-2.5 w-2.5" />
                </Link>
              </div>
              <div className="text-silver/70 mt-0.5 ml-4">{ex.message}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SeverityDot({ severity }: { severity: PayrollException['severity'] }) {
  const cls =
    severity === 'BLOCKING'
      ? 'bg-alert'
      : severity === 'WARNING'
      ? 'bg-warning'
      : 'bg-silver/50';
  return <span className={cn('h-2 w-2 rounded-full inline-block', cls)} />;
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
                      <span className="text-silver">{EXCEPTION_COPY[e.kind].label}</span>
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
  schedule,
  preview,
  loading,
  error,
  onRetry,
  exceptions,
  exceptionsLoading,
  onRecheck,
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
      <Pill icon={<Calendar className="h-3.5 w-3.5" />}>
        {fmtPeriod(periodStart, periodEnd)}{schedule ? ` · ${schedule.name}` : ''}
      </Pill>

      <ExceptionStrip exceptions={exceptions} loading={exceptionsLoading} onRecheck={onRecheck} />

      <p className="text-silver/70 text-xs">
        Hours come from <strong>APPROVED</strong> time entries in this period.
        PENDING / REJECTED entries are excluded — fix those in <strong>Time</strong> if a paystub looks short.
      </p>

      <PreviewStateBanner loading={loading} error={error} onRetry={onRetry} />

      {preview && preview.items.length === 0 && (
        <div className="rounded border border-silver/15 bg-black/30 p-3 text-xs text-silver/70">
          No approved time entries fell inside this period. Either the period
          is wrong or no one's time is approved yet.
        </div>
      )}

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
  schedule,
  preview,
  loading,
  error,
  onRetry,
  exceptions,
  exceptionsLoading,
  onRecheck,
}: PreviewProps) {
  void periodStart;
  void periodEnd;
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
      <ExceptionStrip exceptions={exceptions} loading={exceptionsLoading} onRecheck={onRecheck} />

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
            Withholding tables: IRS Pub 15-T 2024. State tables include CA, NY,
            NJ, GA, OH, VA, MN (bracketed) and 11 flat-rate states. Long-tail
            states use a 4% conservative fallback.
          </p>
        </>
      )}

      {schedule && (
        <p className="text-xs text-silver/70">
          Pay date will land on{' '}
          <strong className="text-silver/80">{fmtDate(parseYmd(schedule.nextPayDate))}</strong>{' '}
          ({schedule.payDateOffsetDays} day offset from period end).
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
  schedule,
  preview,
  loading,
  error,
  onRetry,
  exceptions,
  exceptionsLoading,
  onRecheck,
  notes,
  setNotes,
}: {
  periodStart: string;
  periodEnd: string;
  schedule: PayrollSchedule | null;
  preview: PayrollRunPreviewResponse | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  exceptions: PayrollExceptionsResponse | null;
  exceptionsLoading: boolean;
  onRecheck: () => void;
  notes: string;
  setNotes: (v: string) => void;
}) {
  const exMap = exceptionsByAssociate(exceptions);
  return (
    <div className="space-y-3 text-sm">
      <Pill icon={<Calendar className="h-3.5 w-3.5" />}>
        {fmtPeriod(periodStart, periodEnd)}{schedule ? ` · ${schedule.name}` : ''}
      </Pill>

      <ExceptionStrip
        exceptions={exceptions}
        loading={exceptionsLoading}
        onRecheck={onRecheck}
      />

      <PreviewStateBanner loading={loading} error={error} onRetry={onRetry} />

      {preview && preview.items.length === 0 && (
        <div className="rounded border border-silver/15 bg-black/30 p-3 text-xs text-silver/70">
          No approved time entries fell inside this period. Either the period
          is wrong or no one's time is approved yet.
        </div>
      )}

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

          {schedule && (
            <p className="text-xs text-silver/70">
              Pay date will land on{' '}
              <strong className="text-silver/80">{fmtDate(parseYmd(schedule.nextPayDate))}</strong>{' '}
              ({schedule.payDateOffsetDays} day offset from period end).
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
  schedule,
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
  schedule: PayrollSchedule | null;
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
          {schedule && <li>• Schedule: {schedule.name} ({schedule.frequency.toLowerCase()})</li>}
          {preview && (
            <li>
              • {preview.totals.itemCount} paystub{preview.totals.itemCount === 1 ? '' : 's'} ·
              gross {fmtMoney(preview.totals.totalGross)} ·
              net {fmtMoney(preview.totals.totalNet)} ·
              employer cost {fmtMoney(preview.totals.totalEmployerTax)}
            </li>
          )}
          <li>• Status will be <strong>Draft</strong> until you finalize it from the run drawer.</li>
          <li>• A QuickBooks journal entry will be queued on disbursement.</li>
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
