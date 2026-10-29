import { Link } from 'react-router-dom';
import { AlertTriangle, Check, Circle } from '@/components/ui/icons';
import type { PayrollRunStatus, PayrollRunSummary } from '@alto-people/shared';
import { cn } from '@/lib/cn';
import { useI18n } from '@/lib/i18n';
import { runStatusLabel } from '@/lib/payrollRunStatus';
import { liveNextStep, totalsOnHold } from './RunTotalsMismatch';
import '@/lib/i18n/en/runTotals';

/**
 * A run's lifecycle as connected steps: Draft → Finalized → Signed off →
 * Paid → Tax deposit — the same lifecycle the guided close shows (GET
 * /payroll/runs `nextStep`, finance walk 10). Shared by the payroll home's
 * run drawer and the run record (/payroll/runs/:id).
 *
 * "Signed off" is only ticked when a sign-off is on record: a run that was
 * paid without one (paid before the review existed, or with the review not
 * required) shows a warning dot and "No sign-off" there — the close page
 * says "Paid out with no sign-off on record" for the same run, and the two
 * must not disagree (F500 G3). When the tenant doesn't require a sign-off
 * the step reads "Not required" in the quiet colour, not a warning.
 *
 * A run whose totals and paychecks disagree is ON HOLD: the step it stands
 * on carries the alert mark and the line under the steps says so, instead
 * of a next step that would move money or file taxes from numbers nobody
 * can trust (F500 audit 2026-10-26: "Paid", 0 paychecks, "Next: Create the
 * tax deposit").
 */
type StepperStage = 'DRAFT' | 'FINALIZED' | 'SIGNED' | 'DISBURSED' | 'DEPOSIT';

export interface RunStatusStepperProps {
  status: PayrollRunStatus;
  /** The run as the runs list reports it (nextStep, reviewSignedAt); null while it loads. */
  lifecycle: (Pick<PayrollRunSummary, 'nextStep' | 'reviewSignedAt'> & { totalsAgree?: boolean | null }) | null;
  /** A sign-off on the run's current numbers is on record (the review status read). */
  signedOff: boolean;
  /** Whether a sign-off is required for this run (the review status read); unknown → treated as required. */
  signoffRequired?: boolean | null;
  /** Show the "Next: …" line under the steps (default true). */
  showNext?: boolean;
  className?: string;
}

export function RunStatusStepper({ status, lifecycle, signedOff, signoffRequired, showNext = true, className }: RunStatusStepperProps) {
  const { t } = useI18n();
  if (status === 'CANCELLED') {
    return (
      <div className={cn('flex items-center gap-2 rounded border border-alert/30 bg-alert/5 p-3 text-xs text-alert', className)}>
        <Circle className="h-3.5 w-3.5 fill-alert text-alert" aria-hidden="true" />
        Run cancelled. No paystubs will be paid.
      </div>
    );
  }
  const hasSignoff = signedOff || !!lifecycle?.reviewSignedAt;
  const stages: { key: StepperStage; label: string }[] = [
    // The one word per status (lib/payrollRunStatus): "Paid", as on every payroll page.
    { key: 'DRAFT', label: runStatusLabel('DRAFT') },
    { key: 'FINALIZED', label: runStatusLabel('FINALIZED') },
    { key: 'SIGNED', label: 'Signed off' },
    { key: 'DISBURSED', label: runStatusLabel('DISBURSED') },
    { key: 'DEPOSIT', label: 'Tax deposit' },
  ];
  const held = totalsOnHold(lifecycle ? { status, totalsAgree: lifecycle.totalsAgree } : null);
  const next = lifecycle?.nextStep ?? null;
  const shownNext = liveNextStep(lifecycle ? { status, totalsAgree: lifecycle.totalsAgree, nextStep: next } : null);
  const reachedIdx = (() => {
    // A closed run (deposit made, nothing left): every step is done, none is "current" (MONEY-13 —
    // a fully closed run sat on step 5 with a "5" in a ring, never a tick).
    if (status === 'DISBURSED' && next?.key === 'done') return stages.length;
    if (status === 'DISBURSED') return next && next.key === 'remit' ? 4 : 3;
    if (status === 'FINALIZED') return hasSignoff || (next && next.key !== 'review') ? 2 : 1;
    return 0;
  })();
  // Past the sign-off step with no sign-off on record: the step was skipped, not done
  // (a warning only where a sign-off was required).
  const notRequired = signoffRequired === false && !hasSignoff;
  const skippedSignoff = reachedIdx > 2 && !hasSignoff && !notRequired;
  return (
    <div className={cn('space-y-2', className)} data-testid="run-status-stepper">
      <ol className="flex items-center gap-1 sm:gap-2">
        {stages.map((s, i) => {
          const reached = i <= reachedIdx;
          const current = i === reachedIdx;
          const skipped = s.key === 'SIGNED' && skippedSignoff;
          const waived = s.key === 'SIGNED' && notRequired;
          const stuck = held && current;
          const label = skipped ? 'No sign-off' : waived ? t('runTotals.signoffNotRequired') : s.label;
          return (
            <li key={s.key} className="flex flex-1 items-center gap-1 sm:gap-2" aria-current={current ? 'step' : undefined}>
              <div className="flex min-w-0 flex-col items-center">
                <span
                  className={cn(
                    'inline-flex h-6 w-6 items-center justify-center rounded-full text-2xs font-medium transition-colors',
                    stuck
                      ? 'border border-alert/60 bg-alert/15 text-alert'
                      : skipped
                        ? 'border border-warning/60 bg-warning/15 text-warning'
                        : waived && reached
                          ? 'border border-line bg-surface-raised text-ink-muted'
                          : reached
                            ? 'bg-gold text-navy'
                            : 'bg-surface-raised text-ink-muted',
                    current && !stuck && 'ring-2 ring-gold/30 ring-offset-2 ring-offset-surface',
                    stuck && 'ring-2 ring-alert/30 ring-offset-2 ring-offset-surface',
                  )}
                  title={skipped ? 'Paid out with no sign-off on record' : waived ? t('runTotals.signoffNotRequiredHint') : stuck ? t('runTotals.held') : undefined}
                >
                  {stuck ? (
                    <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                  ) : skipped ? (
                    '!'
                  ) : waived && reached ? (
                    '–'
                  ) : reached && i < reachedIdx ? (
                    <Check className="h-3.5 w-3.5" aria-hidden="true" />
                  ) : (
                    i + 1
                  )}
                  {skipped && <span className="sr-only"> Paid out with no sign-off on record</span>}
                  {waived && <span className="sr-only"> {t('runTotals.signoffNotRequiredHint')}</span>}
                  {stuck && <span className="sr-only"> {t('runTotals.held')}</span>}
                </span>
                <span
                  className={cn(
                    'mt-1 max-w-[84px] text-center text-2xs uppercase tracking-widest',
                    stuck ? 'text-alert' : skipped ? 'text-warning' : waived ? 'text-ink-muted' : reached ? 'text-ink' : 'text-ink-muted',
                  )}
                >
                  {label}
                </span>
              </div>
              {i < stages.length - 1 && <span aria-hidden="true" className={cn('mb-4 h-px flex-1 transition-colors', i < reachedIdx ? 'bg-gold/50' : 'bg-line')} />}
            </li>
          );
        })}
      </ol>
      {held ? (
        <p className="text-xs text-alert" data-testid="run-on-hold">
          {t('runTotals.onHold')}
        </p>
      ) : (
        showNext &&
        shownNext && (
          <p className="text-xs text-ink-muted">
            Next:{' '}
            <Link to={shownNext.to} className="text-accent underline underline-offset-2">
              {shownNext.label}
            </Link>
            {shownNext.waitingOn && ` (waiting on ${shownNext.waitingOn})`}
          </p>
        )
      )}
    </div>
  );
}
