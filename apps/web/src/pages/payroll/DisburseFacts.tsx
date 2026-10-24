import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle } from '@/components/ui/icons';
import { fmtDate, fmtMoney } from '@/lib/format';
import { getDisbursePreview, type DisbursePreview } from '@/lib/payrollDeskApi';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/lib/cn';

/**
 * What matters at the moment of paying (finance walk 12): the payout
 * provider's state (an erroring provider blocks, with the two ways out),
 * the split by payment method, when the money lands against the ACH
 * cutoff, and the account it leaves.
 */
export function useDisbursePreview(runId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ['payroll', 'disburse-preview', runId],
    queryFn: () => getDisbursePreview(runId!),
    enabled: enabled && !!runId,
    retry: false,
    staleTime: 15_000,
  });
}

const METHOD: Record<DisbursePreview['split'][number]['method'], string> = {
  DIRECT_DEPOSIT: 'Direct deposit',
  PAY_CARD: 'Pay card',
  CHECK: 'Paper check',
  NONE: 'No pay account — held',
};

export function DisburseFacts({ runId, data, loading }: { runId: string; data: DisbursePreview | undefined; loading: boolean }) {
  if (loading) return <Skeleton className="h-28" />;
  if (!data) return null;
  const p = data.provider;
  return (
    <div className="space-y-3 text-xs" aria-label="Before you pay">
      {p.blocked ? (
        <div role="alert" className="rounded-md border border-alert/40 bg-alert/10 p-3 text-alert">
          <p className="flex items-center gap-1.5 font-medium">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
            {p.name} is failing — paying now would leave people unpaid.
          </p>
          <p className="mt-1 text-ink-muted">{p.detail}</p>
          <div className="mt-2 flex flex-wrap gap-3">
            <Link to="/payroll/banking" className="text-accent underline underline-offset-2">
              Fix in Payroll banking
            </Link>
            <Link to={`/payroll/runs/${runId}/checks`} className="text-accent underline underline-offset-2">
              Pay by paper check
            </Link>
          </div>
        </div>
      ) : (
        <p className={cn('rounded-md border p-2', p.health === 'stub' ? 'border-warning/40 bg-warning/10 text-warning' : 'border-line text-ink-muted')}>
          {p.detail}
        </p>
      )}
      {data.split.length > 0 && (
        <dl className="grid grid-cols-1 gap-1">
          {data.split.map((s) => (
            <div key={s.method} className={cn('flex justify-between gap-2 tabular-nums', s.method === 'NONE' && 'text-warning')}>
              <dt>
                {METHOD[s.method]} · {s.count}
              </dt>
              <dd>{fmtMoney(s.amount)}</dd>
            </div>
          ))}
        </dl>
      )}
      {data.arrival && (
        <p className={cn(data.arrival.late ? 'text-alert' : 'text-ink-muted')}>
          Lands {fmtDate(data.arrival.arrivesOn)}
          {data.arrival.payDate && ` (payday ${fmtDate(data.arrival.payDate)})`}
          {data.arrival.late ? ' — after payday: the ACH cutoff has passed for an on-time deposit.' : data.arrival.submitBy ? ` · the file must reach the bank by ${data.arrival.cutoffEt ?? '4:00 PM'} ET on ${fmtDate(data.arrival.submitBy)}.` : '.'}
        </p>
      )}
      {data.funding && (
        <p className="text-ink-muted">
          From {data.funding.accountLabel ?? 'the funding account'}
          {data.funding.last4 ? ` •••• ${data.funding.last4}` : ''}
          {data.funding.status === 'OWN_ACCOUNT' ? ' (drawn when the file is uploaded)' : data.funding.status ? ` · funding ${data.funding.status.toLowerCase().replace(/_/g, ' ')}` : ' · not funded yet'}
          {data.funding.amount != null && ` · ${fmtMoney(data.funding.amount)}`}
        </p>
      )}
    </div>
  );
}
