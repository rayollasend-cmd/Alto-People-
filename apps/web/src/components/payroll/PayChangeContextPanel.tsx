import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fmtDate, fmtMoney } from '@/lib/format';
import { getPayChangeContext } from '@/lib/payrollDeskApi';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/lib/cn';

/**
 * What a new rate means, beside the "Set new rate" form (finance walk 13):
 * the current rate, where the new one sits in the band, the bill rate from
 * the rate card and the margin per hour before → after, the pay period it
 * lands in, and the back pay a date in an already-paid period owes.
 */
export function PayChangeContextPanel({ associateId, payType, amount, effectiveFrom }: { associateId: string; payType: 'HOURLY' | 'SALARY'; amount: number; effectiveFrom: string }) {
  // Wait for the typing to settle before asking.
  const [settled, setSettled] = useState({ amount, effectiveFrom, payType });
  useEffect(() => {
    const t = setTimeout(() => setSettled({ amount, effectiveFrom, payType }), 350);
    return () => clearTimeout(t);
  }, [amount, effectiveFrom, payType]);
  const ready = Number.isFinite(settled.amount) && settled.amount > 0 && /^\d{4}-\d{2}-\d{2}$/.test(settled.effectiveFrom);
  const q = useQuery({
    queryKey: ['comp', 'pay-change-context', associateId, settled],
    queryFn: () => getPayChangeContext(associateId, settled),
    enabled: ready,
    retry: false,
    staleTime: 30_000,
  });
  if (!ready) return null;
  if (q.isLoading) return <Skeleton className="h-24" />;
  if (!q.data) return null;
  const c = q.data;
  const per = c.proposed.payType === 'HOURLY' ? '/hr' : '/yr';
  return (
    <div className="space-y-2 rounded-md border border-line bg-surface-sunken p-3 text-xs" aria-label="What this change means">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-3">
        <div>
          <dt className="text-ink-muted">Current</dt>
          <dd className="tabular-nums text-ink">{c.current ? `${fmtMoney(c.current.amount)}${c.current.payType === 'HOURLY' ? '/hr' : '/yr'}` : 'None on file'}</dd>
        </div>
        <div>
          <dt className="text-ink-muted">Place in band</dt>
          <dd className="tabular-nums text-ink">
            {c.band ? `${c.band.currentPct != null ? `${c.band.currentPct}% → ` : ''}${c.band.proposedPct}% of ${fmtMoney(c.band.min)}–${fmtMoney(c.band.max)}` : 'No band set'}
          </dd>
        </div>
        <div>
          <dt className="text-ink-muted">Bill rate</dt>
          <dd className="tabular-nums text-ink">{c.billRate != null ? `${fmtMoney(c.billRate)}/hr${c.position ? ` · ${c.position}` : ''}` : 'No rate card'}</dd>
        </div>
        {c.marginAfter != null && (
          <div className="col-span-2 sm:col-span-3">
            <dt className="text-ink-muted">Margin per hour (after {c.burdenPct}% burden)</dt>
            <dd className={cn('tabular-nums', c.marginAfter < 0 ? 'text-alert' : 'text-ink')}>
              {c.marginBefore != null ? `${fmtMoney(c.marginBefore)} → ` : ''}
              {fmtMoney(c.marginAfter)}
              {c.marginAfter < 0 && ' — below what the client pays for the hour'}
            </dd>
          </div>
        )}
      </dl>
      {c.landsIn && (
        <p className="text-ink">
          Lands in {fmtDate(c.landsIn.periodStart)} – {fmtDate(c.landsIn.periodEnd)}, paid {fmtDate(c.landsIn.payDate)}
          {c.backPay && c.backPay.amount !== 0
            ? `; ${fmtDate(c.backPay.from)} means ${fmtMoney(Math.abs(c.backPay.amount))} ${c.backPay.amount > 0 ? 'back pay' : 'overpaid'} for ${c.backPay.hours}h already paid at the old rate, added to that check.`
            : '.'}
        </p>
      )}
      {c.deltaPct != null && <p className="text-ink-muted">{c.deltaPct >= 0 ? '+' : ''}{c.deltaPct}% on the current {per === '/hr' ? 'hourly rate' : 'salary'}.</p>}
    </div>
  );
}
