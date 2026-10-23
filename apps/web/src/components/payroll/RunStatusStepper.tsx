import { Link } from 'react-router-dom';
import { Circle } from 'lucide-react';
import type { PayrollRunStatus, PayrollRunSummary } from '@alto-people/shared';
import { cn } from '@/lib/cn';
import { runStatusLabel } from '@/lib/payrollRunStatus';

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
 * must not disagree (F500 G3).
 */
type StepperStage = 'DRAFT' | 'FINALIZED' | 'SIGNED' | 'DISBURSED' | 'DEPOSIT';

export interface RunStatusStepperProps {
  status: PayrollRunStatus;
  /** The run as the runs list reports it (nextStep, reviewSignedAt); null while it loads. */
  lifecycle: Pick<PayrollRunSummary, 'nextStep' | 'reviewSignedAt'> | null;
  /** A sign-off on the run's current numbers is on record (the review status read). */
  signedOff: boolean;
  /** Show the "Next: …" line under the steps (default true). */
  showNext?: boolean;
  className?: string;
}

export function RunStatusStepper({ status, lifecycle, signedOff, showNext = true, className }: RunStatusStepperProps) {
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
  const next = lifecycle?.nextStep ?? null;
  const reachedIdx = (() => {
    if (status === 'DISBURSED') return next && (next.key === 'done' || next.key === 'remit') ? 4 : 3;
    if (status === 'FINALIZED') return hasSignoff || (next && next.key !== 'review') ? 2 : 1;
    return 0;
  })();
  // Past the sign-off step with no sign-off on record: the step was skipped, not done.
  const skippedSignoff = reachedIdx > 2 && !hasSignoff;
  return (
    <div className={cn('space-y-2', className)} data-testid="run-status-stepper">
      <ol className="flex items-center gap-1 sm:gap-2">
        {stages.map((s, i) => {
          const reached = i <= reachedIdx;
          const current = i === reachedIdx;
          const skipped = s.key === 'SIGNED' && skippedSignoff;
          const label = skipped ? 'No sign-off' : s.label;
          return (
            <li key={s.key} className="flex flex-1 items-center gap-1 sm:gap-2" aria-current={current ? 'step' : undefined}>
              <div className="flex min-w-0 flex-col items-center">
                <span
                  className={cn(
                    'inline-flex h-6 w-6 items-center justify-center rounded-full text-2xs font-medium transition-colors',
                    skipped ? 'border border-warning/60 bg-warning/15 text-warning' : reached ? 'bg-gold text-navy' : 'bg-surface-raised text-ink-muted',
                    current && 'ring-2 ring-gold/30 ring-offset-2 ring-offset-surface',
                  )}
                  title={skipped ? 'Paid out with no sign-off on record' : undefined}
                >
                  {skipped ? '!' : reached && i < reachedIdx ? '✓' : i + 1}
                  {skipped && <span className="sr-only"> Paid out with no sign-off on record</span>}
                </span>
                <span
                  className={cn(
                    'mt-1 max-w-[84px] text-center text-2xs uppercase tracking-widest',
                    skipped ? 'text-warning' : reached ? 'text-ink' : 'text-ink-muted',
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
      {showNext && next && next.key !== 'done' && next.key !== 'cancelled' && (
        <p className="text-xs text-ink-muted">
          Next:{' '}
          <Link to={next.to} className="text-accent underline underline-offset-2">
            {next.label}
          </Link>
          {next.waitingOn && ` (waiting on ${next.waitingOn})`}
        </p>
      )}
    </div>
  );
}
