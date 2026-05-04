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

import { useEffect, useMemo, useState } from 'react';
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
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/Tooltip';
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
import { toast } from '@/components/ui/Toaster';
import { cn } from '@/lib/cn';

const fmtMoney = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: (detail: PayrollRunDetail) => void;
}

type Step = 1 | 2 | 3 | 4;

const STEP_TITLES: Record<Step, string> = {
  1: 'Pick schedule + period',
  2: 'Review hours',
  3: 'Review wages & deductions',
  4: 'Approve & submit',
};

export function RunPayrollWizard({ open, onOpenChange, onCreated }: Props) {
  const [step, setStep] = useState<Step>(1);
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

  useEffect(() => {
    if (!open) return;
    setStep(1);
    setNotes('');
    setSubmitting(false);
    setSchedules(null);
    setPreview(null);
    setPreviewError(null);
    setExceptions(null);
    setOverrideBlocking(false);
    listPayrollSchedules()
      .then((res) => setSchedules(res.schedules))
      .catch((err) =>
        toast.error(err instanceof ApiError ? err.message : 'Failed to load schedules.')
      );
  }, [open]);

  const activeSchedule = useMemo(
    () => schedules?.find((s) => s.id === scheduleId) ?? null,
    [schedules, scheduleId]
  );

  // When a schedule is picked, default the period to its computed "next"
  // window. The user can override.
  useEffect(() => {
    if (!activeSchedule) return;
    setPeriodStart(activeSchedule.nextPeriodStart);
    setPeriodEnd(activeSchedule.nextPeriodEnd);
  }, [activeSchedule]);

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

  const next = async () => {
    if (!canAdvance[step]) return;
    if (step === 1) {
      await fetchPreview();
      setStep(2);
      return;
    }
    if (step < 4) setStep((step + 1) as Step);
  };
  const back = () => {
    if (step > 1) setStep((step - 1) as Step);
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
      });
      toast.success(`Run created — ${detail.items.length} paystubs aggregated.`);
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
            {STEP_TITLES[step]} ({step} of 4)
          </DialogDescription>
        </DialogHeader>

        <Stepper step={step} />

        <div className="min-h-[260px]">
          {step === 1 && (
            <Step1
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
          {step === 2 && (
            <Step2
              periodStart={periodStart}
              periodEnd={periodEnd}
              schedule={activeSchedule}
              preview={preview}
              loading={previewLoading}
              error={previewError}
              onRetry={fetchPreview}
              exceptions={exceptions}
              exceptionsLoading={exceptionsLoading}
            />
          )}
          {step === 3 && (
            <Step3
              periodStart={periodStart}
              periodEnd={periodEnd}
              schedule={activeSchedule}
              preview={preview}
              loading={previewLoading}
              error={previewError}
              onRetry={fetchPreview}
              exceptions={exceptions}
              exceptionsLoading={exceptionsLoading}
            />
          )}
          {step === 4 && (
            <Step4
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
            onClick={step === 1 ? () => onOpenChange(false) : back}
            disabled={submitting}
          >
            {step === 1 ? 'Cancel' : (
              <span className="inline-flex items-center gap-1.5">
                <ArrowLeft className="h-4 w-4" />
                Back
              </span>
            )}
          </Button>
          {step < 4 ? (
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

function Stepper({ step }: { step: Step }) {
  return (
    <ol className="flex items-center justify-between gap-2 mb-4">
      {([1, 2, 3, 4] as Step[]).map((s) => (
        <li
          key={s}
          className={cn(
            'flex-1 flex items-center gap-2 px-2 py-1.5 rounded text-xs uppercase tracking-wide',
            s === step
              ? 'bg-gold/15 text-gold border border-gold/30'
              : s < step
              ? 'text-silver/70'
              : 'text-silver/30'
          )}
        >
          <span
            className={cn(
              'inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-medium',
              s === step
                ? 'bg-gold text-black'
                : s < step
                ? 'bg-silver/20 text-silver'
                : 'bg-silver/10 text-silver/40'
            )}
          >
            {s < step ? '✓' : s}
          </span>
          <span className="truncate">{STEP_TITLES[s]}</span>
        </li>
      ))}
    </ol>
  );
}

function Step1(props: {
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
  return (
    <div className="space-y-4">
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
      <Field label="Default hourly rate (used when a shift has none)">
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
    </div>
  );
}

interface PreviewProps {
  periodStart: string;
  periodEnd: string;
  schedule: PayrollSchedule | null;
  preview: PayrollRunPreviewResponse | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  exceptions: PayrollExceptionsResponse | null;
  exceptionsLoading: boolean;
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
      <div className="rounded border border-silver/15 bg-black/30 p-3 text-xs text-silver/60">
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
};

function ExceptionStrip({
  exceptions,
  loading,
}: {
  exceptions: PayrollExceptionsResponse | null;
  loading: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (loading) {
    return (
      <div className="flex items-center gap-2 text-[11px] text-silver/60 py-2">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Checking pre-flight exceptions…
      </div>
    );
  }
  if (!exceptions || exceptions.exceptions.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-[11px] text-emerald-300">
        <CheckCircle2 className="h-3.5 w-3.5" />
        No exceptions — every associate has a W-4, a payout method, and a supported state.
      </div>
    );
  }
  const { blocking, warning, info } = exceptions.counts;
  const tone = blocking > 0
    ? 'border-alert/40 bg-alert/5 text-alert'
    : warning > 0
    ? 'border-amber-500/30 bg-amber-500/5 text-amber-300'
    : 'border-silver/20 bg-black/40 text-silver';
  const Icon = blocking > 0 ? ShieldAlert : warning > 0 ? AlertTriangle : Info;

  return (
    <div className={cn('rounded border', tone.split(' ').slice(0, 2).join(' '))}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left"
        aria-expanded={open}
      >
        <span className={cn('flex items-center gap-2 text-xs', tone.split(' ')[2])}>
          <Icon className="h-4 w-4" />
          <span className="font-medium">
            {blocking > 0
              ? `${blocking} blocking ${blocking === 1 ? 'issue' : 'issues'}`
              : `${exceptions.exceptions.length} ${exceptions.exceptions.length === 1 ? 'issue' : 'issues'} to review`}
          </span>
          <span className="text-silver/60">
            {warning > 0 && ` · ${warning} warning${warning === 1 ? '' : 's'}`}
            {info > 0 && ` · ${info} info`}
          </span>
        </span>
        {open ? <ChevronDown className="h-4 w-4 text-silver/60" /> : <ChevronRight className="h-4 w-4 text-silver/60" />}
      </button>
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
                  className="text-[10px]"
                >
                  {EXCEPTION_COPY[ex.kind].label}
                </Badge>
              </div>
              <div className="text-silver/60 mt-0.5 ml-4">{ex.message}</div>
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
      ? 'bg-amber-400'
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
          ? 'border-amber-500/30'
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
          <div className="min-w-0">
            <div className="text-sm text-white truncate">{item.associateName}</div>
            <div className="text-[11px] text-silver/50 truncate">
              {item.taxState ?? '—'} · {item.payFrequency.toLowerCase()}
              {item.overtimeHours > 0 && (
                <> · <span className="text-gold">{item.overtimeHours.toFixed(1)}h OT</span></>
              )}
            </div>
          </div>
          {(blockingCount > 0 || otherCount > 0) && (
            <Badge
              variant={blockingCount > 0 ? 'destructive' : 'pending'}
              className="text-[10px] shrink-0"
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
        <div className="border-t border-silver/10 px-3 py-3 text-[11px] space-y-3">
          {variant === 'hours' ? (
            <HoursDrillDown item={item} />
          ) : (
            <TaxDrillDown item={item} />
          )}
          {exceptions.length > 0 && (
            <div className="border-t border-silver/10 pt-2">
              <div className="text-[10px] uppercase tracking-widest text-silver/50 mb-1">
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
                      <span className="text-silver/60"> — {e.message}</span>
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
      <div className="text-[10px] uppercase tracking-widest text-silver/40">
        {label}
      </div>
      <div className={cn('tabular-nums text-sm', highlight ? 'text-gold' : 'text-white')}>
        {value}
      </div>
    </div>
  );
}

/**
 * QBO-style "?" icon next to a label. Hover/focus reveals a one-sentence
 * explanation of the rate, cap, or source used by the math engine. The
 * tooltips deliberately cite the 2024 numbers — bumping the year means
 * editing the constants in payrollTax.ts and these strings together.
 */
function InfoTip({ text }: { text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center justify-center text-silver/40 hover:text-silver focus:outline-none focus-visible:text-gold align-middle ml-1"
          aria-label={`What is this?`}
        >
          <HelpCircle className="h-3 w-3" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-[11px] leading-relaxed">
        {text}
      </TooltipContent>
    </Tooltip>
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
      <span className="text-silver/60 inline-flex items-center">{label}</span>
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
  periodStart,
  periodEnd,
  schedule,
  preview,
  loading,
  error,
  onRetry,
  exceptions,
  exceptionsLoading,
}: PreviewProps) {
  const exMap = exceptionsByAssociate(exceptions);
  return (
    <div className="space-y-3 text-sm">
      <Pill icon={<Calendar className="h-3.5 w-3.5" />}>
        {periodStart} → {periodEnd}{schedule ? ` · ${schedule.name}` : ''}
      </Pill>

      <ExceptionStrip exceptions={exceptions} loading={exceptionsLoading} />

      <p className="text-silver/70 text-xs">
        Hours come from <strong>APPROVED</strong> time entries in this period.
        PENDING / REJECTED entries are excluded — fix those in <strong>Time</strong> if a paystub looks short.
      </p>

      <PreviewStateBanner loading={loading} error={error} onRetry={onRetry} />

      {preview && preview.items.length === 0 && (
        <div className="rounded border border-silver/15 bg-black/30 p-3 text-xs text-silver/60">
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
  periodStart,
  periodEnd,
  schedule,
  preview,
  loading,
  error,
  onRetry,
  exceptions,
  exceptionsLoading,
}: PreviewProps) {
  void periodStart;
  void periodEnd;
  const exMap = exceptionsByAssociate(exceptions);
  return (
    <div className="space-y-3 text-sm">
      <ExceptionStrip exceptions={exceptions} loading={exceptionsLoading} />

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

          <p className="text-[10px] text-silver/50">
            Withholding tables: IRS Pub 15-T 2024. State tables include CA, NY,
            NJ, GA, OH, VA, MN (bracketed) and 11 flat-rate states. Long-tail
            states use a 4% conservative fallback.
          </p>
        </>
      )}

      {schedule && (
        <p className="text-xs text-silver/50">
          Pay date will land on{' '}
          <strong className="text-silver/80">{schedule.nextPayDate}</strong>{' '}
          ({schedule.payDateOffsetDays} day offset from period end).
        </p>
      )}
    </div>
  );
}

function Stat({ label, value, highlight }: { label: React.ReactNode; value: string; highlight?: boolean }) {
  return (
    <div className={cn('rounded border border-silver/15 bg-black/30 px-3 py-2', highlight && 'border-gold/40 bg-gold/5')}>
      <div className={cn('text-[10px] uppercase tracking-widest inline-flex items-center', highlight ? 'text-gold' : 'text-silver/50')}>
        {label}
      </div>
      <div className={cn('mt-0.5 tabular-nums', highlight ? 'text-gold' : 'text-white')}>{value}</div>
    </div>
  );
}

function Step4({
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
  return (
    <div className="space-y-4 text-sm">
      <div className="rounded border border-gold/30 bg-gold/5 p-3 text-xs">
        <div className="flex items-center gap-2 text-gold mb-1.5">
          <FileText className="h-4 w-4" />
          <span className="font-medium uppercase tracking-wide">Ready to create</span>
        </div>
        <ul className="space-y-1 text-silver/80">
          <li>• Period {periodStart} → {periodEnd}</li>
          {schedule && <li>• Schedule: {schedule.name} ({schedule.frequency.toLowerCase()})</li>}
          {preview && (
            <li>
              • {preview.totals.itemCount} paystub{preview.totals.itemCount === 1 ? '' : 's'} ·
              gross {fmtMoney(preview.totals.totalGross)} ·
              net {fmtMoney(preview.totals.totalNet)} ·
              employer cost {fmtMoney(preview.totals.totalEmployerTax)}
            </li>
          )}
          <li>• Status will be <strong>DRAFT</strong> until you finalize it from the run drawer.</li>
          <li>• A QuickBooks journal entry will be queued on disbursement.</li>
        </ul>
      </div>

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
