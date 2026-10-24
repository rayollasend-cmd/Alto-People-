import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CalendarDays, Landmark } from '@/components/ui/icons';
import { ApiError } from '@/lib/api';
import { fmtDate, fmtHours, fmtMoney } from '@/lib/format';
import { getPaySummary, type PaySummary } from '@/lib/payrollDeskApi';
import { Badge } from '@/components/ui/Badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { MetricCard } from '@/components/ui/MetricCard';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * The person record's Pay tab for in-house payroll (finance walk 19): the
 * pay schedule they are on, where their pay goes, their last six paystubs
 * and the year to date. Payments made before in-house payroll stay below,
 * under their own heading.
 */

const RAIL_LABEL: Record<PaySummary['payAccount']['rail'], string> = {
  BANK_ACCOUNT: 'Direct deposit',
  PAY_CARD: 'Pay card',
  NONE: 'No pay account',
};

const period = (a: string, b: string) => `${fmtDate(a)} – ${fmtDate(b)}`;

export function PaySummaryCard({ associateId }: { associateId: string }) {
  const q = useQuery({ queryKey: ['payroll', 'pay-summary', associateId], queryFn: () => getPaySummary(associateId) });
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.isError || !q.data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Pay</CardTitle>
          <CardDescription>{q.error instanceof ApiError ? q.error.message : 'Could not load this person’s pay.'}</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  const d = q.data;
  const sched = d.schedule?.current ?? null;
  const pending = d.schedule?.pending ?? null;
  const taxes = d.ytd.federalWithholding + d.ytd.socialSecurity + d.ytd.medicare + d.ytd.stateWithholding + d.ytd.localWithholding;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Pay</CardTitle>
        <CardDescription>In-house payroll: the schedule, the pay account, recent paystubs and this year so far.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-md border border-line p-3" data-testid="pay-schedule">
            <div className="flex items-center gap-1.5 text-2xs uppercase tracking-wider text-ink-muted">
              <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />
              Pay schedule
            </div>
            {sched ? (
              <>
                <p className="mt-1 text-sm font-medium text-ink">{sched.name}</p>
                <p className="text-xs text-ink-muted">{sched.pattern} · since {fmtDate(sched.since)}</p>
                {d.schedule?.nextPayDate && <p className="text-xs text-ink-muted">Next payday {fmtDate(d.schedule.nextPayDate)}</p>}
              </>
            ) : (
              <p className="mt-1 text-sm text-warning">
                On no pay schedule — no run will pay them.{' '}
                <Link className="text-accent underline underline-offset-2" to="/payroll/schedules?view=unassigned">
                  Add them to one
                </Link>
              </p>
            )}
            {pending && (
              <p className="mt-1 text-xs text-ink-muted">
                Moves to {pending.name ?? 'no schedule'} from {fmtDate(pending.effectiveFrom)}
              </p>
            )}
          </div>
          <div className="rounded-md border border-line p-3" data-testid="pay-account">
            <div className="flex items-center gap-1.5 text-2xs uppercase tracking-wider text-ink-muted">
              <Landmark className="h-3.5 w-3.5" aria-hidden="true" />
              Pay account
            </div>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
              {RAIL_LABEL[d.payAccount.rail]}
              {d.payAccount.last4 && <span className="tabular-nums text-ink-muted">•••• {d.payAccount.last4}</span>}
              {d.payAccount.rail !== 'NONE' && (d.payAccount.verified ? <Badge variant="success" size="sm">Verified</Badge> : <Badge variant="pending" size="sm">Not verified</Badge>)}
            </p>
            {d.payAccount.rail === 'NONE' && <p className="text-xs text-warning">Paid by paper check until they add one.</p>}
            {d.payAccount.prenoteStatus && <p className="text-xs text-ink-muted">Prenote: {d.payAccount.prenoteStatus.toLowerCase()}</p>}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <MetricCard label={`Gross ${d.ytd.year} to date`} value={fmtMoney(d.ytd.gross)} />
          <MetricCard label="Taxes withheld" value={fmtMoney(taxes)} />
          <MetricCard label="Net paid" value={fmtMoney(d.ytd.net)} />
          <MetricCard label="Paystubs" value={String(d.ytd.paystubs)} />
        </div>

        <div>
          <h3 className="mb-2 text-sm font-medium text-ink">Last paystubs</h3>
          {d.paystubs.length === 0 ? (
            <EmptyState size="sm" title="No in-house paystubs" description="Their first paystub appears here once a run that pays them is finalized." />
          ) : (
            <ul className="divide-y divide-line rounded-md border border-line" aria-label="Last paystubs">
              {d.paystubs.map((p) => (
                <li key={p.itemId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                  <div className="min-w-0">
                    <Link to={`/payroll?run=${p.runId}`} className="text-ink underline-offset-2 hover:underline">
                      {period(p.periodStart, p.periodEnd)}
                    </Link>
                    <span className="ml-2 text-xs text-ink-muted">
                      {fmtHours(p.hours)}
                      {p.runKind !== 'REGULAR' && ` · ${p.runKind === 'OFF_CYCLE' ? 'off-cycle' : p.runKind.toLowerCase()}`}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 tabular-nums">
                    <span className="text-xs text-ink-muted">gross {fmtMoney(p.gross)}</span>
                    <span className="text-ink">{fmtMoney(p.net)}</span>
                    {p.status === 'DISBURSED' ? <Badge variant="success" size="sm">Paid</Badge> : <Badge variant="pending" size="sm">{p.status === 'HELD' ? 'Held' : 'Pending'}</Badge>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
