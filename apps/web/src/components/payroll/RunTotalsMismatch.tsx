import { AlertTriangle } from '@/components/ui/icons';
import { fmtMoney } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/cn';
import '@/lib/i18n/en/runTotals';

/**
 * A run whose stored totals and paychecks disagree (F500 SH-4).
 *
 * Every page shows a run's STORED totals (apps/api/src/lib/payrollRunTotals.ts);
 * the API checks them against the run's non-voided paychecks and says
 * `totalsAgree`. When it is false this alert sits beside the money — on the
 * payroll home's Last run card, in the run drawer, on the close page and at
 * the top of the review — so nobody reads one number on one card and a
 * different one on the next, and nobody signs off a run that records money
 * its paychecks don't add up to.
 *
 * Renders nothing unless `totalsAgree` is exactly false.
 */
export interface RunTotalsCheckProps {
  totalGross?: number | null;
  totalNet?: number | null;
  itemsGross?: number | null;
  itemsNet?: number | null;
  /** Non-voided paychecks. */
  paychecks?: number | null;
  totalsAgree?: boolean | null;
  /** The run's status: a paid run is told what not to file, not what not to pay. */
  status?: string | null;
}

/**
 * The run is on hold because its totals and paychecks disagree: no next step
 * that moves money or files taxes is offered from it (the run record once led
 * with "Create the tax deposit" under this very alert — F500 audit 2026-10-26).
 */
export function totalsOnHold(run: { status?: string | null; totalsAgree?: boolean | null } | null | undefined): boolean {
  return !!run && run.status !== 'CANCELLED' && run.totalsAgree === false;
}

/** The run's next step, or null while its totals are on hold (or it has none left). */
export function liveNextStep<N extends { key: string }>(run: { status?: string | null; totalsAgree?: boolean | null; nextStep?: N | null } | null | undefined): N | null {
  if (!run || totalsOnHold(run)) return null;
  const n = run.nextStep ?? null;
  return n && n.key !== 'done' && n.key !== 'cancelled' ? n : null;
}

export function RunTotalsMismatch({ check, compact = false, className }: { check: RunTotalsCheckProps | null | undefined; compact?: boolean; className?: string }) {
  const { t } = useI18n();
  if (!check || check.totalsAgree !== false) return null;
  const gross = fmtMoney(check.totalGross ?? 0);
  const net = fmtMoney(check.totalNet ?? 0);
  const paychecks = check.paychecks ?? 0;
  const body =
    paychecks === 0
      ? t('runTotals.noPaychecks', { gross })
      : t('runTotals.disagree', { gross, net, count: paychecks, itemsGross: fmtMoney(check.itemsGross ?? 0), itemsNet: fmtMoney(check.itemsNet ?? 0) });
  return (
    <div role="alert" data-testid="run-totals-mismatch" className={cn('flex items-start gap-2 rounded-md border border-alert/40 bg-alert/10 text-alert', compact ? 'p-2 text-xs' : 'p-3 text-sm', className)}>
      <AlertTriangle className={cn('shrink-0', compact ? 'mt-px h-3.5 w-3.5' : 'mt-0.5 h-4 w-4')} aria-hidden="true" />
      <p className="min-w-0">
        <span className="font-medium">{t('runTotals.title')}</span> {body} {!compact && t(check.status === 'DISBURSED' ? 'runTotals.nextPaid' : 'runTotals.next')}
      </p>
    </div>
  );
}
