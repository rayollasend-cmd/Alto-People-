import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Play } from '@/components/ui/icons';
import { fmtDate } from '@/lib/format';
import { getPeriodLedger, type LedgerPeriod } from '@/lib/payrollDeskApi';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';
import type { RunPayrollSeed } from './RunPayrollWizard';

/**
 * Paydays that passed with no run (finance walk 1; audit Tier 1 #5), under
 * the payroll hero: "2 paydays had no run · 40.6h unpaid", each missed
 * period with its hours and a "Pay these hours now" that opens the run
 * wizard as an off-cycle run pre-filled with that period's approved time.
 * Renders nothing when every past payday has a run.
 */
export function MissedPaydaysStrip({ canProcess, focus, onPay }: { canProcess: boolean; focus?: boolean; onPay: (seed: RunPayrollSeed) => void }) {
  const q = useQuery({ queryKey: ['payroll', 'period-ledger'], queryFn: () => getPeriodLedger(), enabled: canProcess, staleTime: 60_000, retry: false });
  const ref = useRef<HTMLDivElement>(null);
  const missed: Array<LedgerPeriod & { scheduleId: string; scheduleName: string }> = (q.data?.schedules ?? []).flatMap((s) =>
    s.periods.filter((p) => p.status === 'MISSED' || (p.status !== 'DUE' && p.unpaidHours > 0 && p.payDate < (q.data?.asOf ?? ''))).map((p) => ({ ...p, scheduleId: s.scheduleId, scheduleName: s.name })),
  );
  useEffect(() => {
    if (focus && missed.length > 0) ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focus, missed.length]);
  if (!q.data || missed.length === 0) return null;
  const { periods, hours, people } = q.data.missed;
  return (
    <div ref={ref} role="region" aria-label="Paydays with no run" className={cn('mb-5 rounded-lg border border-alert/40 bg-alert/5 p-4', focus && 'ring-2 ring-alert/40')}>
      <div className="flex flex-wrap items-center gap-2 text-sm font-medium text-alert">
        <AlertTriangle className="h-4 w-4" aria-hidden="true" />
        {periods > 0 ? `${periods} payday${periods === 1 ? '' : 's'} had no run` : 'Hours left unpaid'}
        {hours > 0 && <span className="font-normal text-ink">· {hours}h approved and unpaid for {people} {people === 1 ? 'person' : 'people'}</span>}
      </div>
      <ul className="mt-3 divide-y divide-line">
        {missed.map((p) => (
          <li key={`${p.scheduleId}:${p.periodStart}`} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
            <div className="min-w-0">
              <span className="text-ink">
                {fmtDate(p.periodStart)} – {fmtDate(p.periodEnd)}
              </span>
              <span className="ml-2 text-xs text-ink-muted">
                {p.scheduleName} · payday {fmtDate(p.payDate)} {p.status === 'MISSED' ? 'passed with no run' : 'passed'}
              </span>
              <div className="text-xs text-ink-muted">
                {p.unpaidHours > 0 ? `${p.unpaidHours}h approved for ${p.unpaidPeople} ${p.unpaidPeople === 1 ? 'person' : 'people'}, on no paystub` : 'No approved hours in it — nothing owed, unless time is still waiting for approval.'}
              </div>
            </div>
            {p.runId && p.runStatus === 'DRAFT' ? (
              <Link to={`/payroll?run=${p.runId}`} className="text-xs text-accent underline underline-offset-2">
                Open the run in draft
              </Link>
            ) : canProcess && p.unpaidHours > 0 ? (
              <Button size="sm" onClick={() => onPay({ scheduleId: p.scheduleId, periodStart: p.periodStart, periodEnd: p.periodEnd, missedPayday: true })}>
                <Play className="h-3.5 w-3.5" aria-hidden="true" />
                Pay these hours now
              </Button>
            ) : p.unpaidHours === 0 ? (
              <Link to={`/time-attendance?tab=queue&from=${p.periodStart}&to=${p.periodEnd}`} className="text-xs text-accent underline underline-offset-2">
                Check time in this period
              </Link>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
