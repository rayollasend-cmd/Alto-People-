import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Banknote, ChevronDown, ChevronUp } from '@/components/ui/icons';
import {
  FUNDING_LABEL,
  centsToMoney,
  etDeadline,
  fundingSentence,
  getBankingSummary,
  getRunFunding,
  pullFunding,
  shortDay,
  type Funding,
  type FundingStatus,
} from '@/lib/bankingApi';
import { Badge, type BadgeProps } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardTitle } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/lib/cn';

/** The badge tone each funding state wears. */
export function fundingTone(s: FundingStatus): NonNullable<BadgeProps['variant']> {
  if (s === 'SETTLED' || s === 'WIRE_RECEIVED') return 'success';
  if (s === 'RETURNED' || s === 'CANCELLED') return 'destructive';
  if (s === 'SUBMITTED' || s === 'WIRE_PENDING') return 'info';
  return 'pending';
}

export function FundingBadge({ status }: { status: FundingStatus }) {
  return <Badge variant={fundingTone(status)}>{FUNDING_LABEL[status]}</Badge>;
}

/** Net pay, taxes, garnishments and fees: where the amount comes from. */
export function FundingBreakdownList({ f }: { f: Funding }) {
  const b = f.breakdown;
  const rows: Array<[string, number]> = [
    [`Net pay to ${b.achPeople} bank account${b.achPeople === 1 ? '' : 's'}`, b.netPayCents],
    ['Payroll taxes we pay for you', b.taxesCents],
    ['Garnishments we send for you', b.garnishmentsCents],
    ['Fees', b.feesCents],
  ];
  return (
    <dl className="mt-3 space-y-1 text-sm">
      {rows.map(([label, cents]) => (
        <div key={label} className="flex justify-between gap-3">
          <dt className="text-ink-muted">{label}</dt>
          <dd className="tabular-nums text-ink">{centsToMoney(cents)}</dd>
        </div>
      ))}
      <div className="flex justify-between gap-3 border-t border-navy-secondary pt-1 font-medium">
        <dt className="text-ink">Pulled from your account</dt>
        <dd className="tabular-nums text-ink">{centsToMoney(f.amountCents)}</dd>
      </div>
      {b.otherRailNetCents > 0 && (
        <p className="pt-1 text-xs text-ink-muted">{`${centsToMoney(b.otherRailNetCents)} more goes to pay cards and checks, funded through those rails.`}</p>
      )}
    </dl>
  );
}

const canPull = (s: FundingStatus) => s === 'NOT_STARTED' || s === 'DRAFT' || s === 'RETURNED';

/**
 * The run's funding on the guided close: the amount, the deadline, where
 * it stands, and the one button that pulls it. Renders nothing when the
 * tenant doesn't pay through its own ACH.
 */
export function RunFundingCard({ runId, runFinalized }: { runId: string; runFinalized: boolean }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const q = useQuery({ queryKey: ['payroll-banking', 'run', runId], queryFn: () => getRunFunding(runId), retry: false });
  const pull = useMutation({
    mutationFn: () => pullFunding(runId),
    onSuccess: (r) => {
      toast.success(r.pending ? 'Over a funding limit — sent to a second person to approve.' : `${centsToMoney(r.funding.amountCents)} is on its way from your account.`);
      void qc.invalidateQueries({ queryKey: ['payroll-banking'] });
      void qc.invalidateQueries({ queryKey: ['payroll', 'close', runId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  if (q.isLoading) return <Skeleton className="h-24" />;
  if (q.isError || !q.data?.applies || !q.data.funding) return null;
  const f = q.data.funding;
  const late = canPull(f.status) && new Date(f.fundingDeadline) < new Date();
  return (
    <Card className={cn(f.status === 'RETURNED' || late ? 'border-alert/40' : canPull(f.status) ? 'border-accent/50' : undefined)} aria-labelledby={`funding-${runId}`}>
      <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <Banknote className="mt-0.5 h-5 w-5 shrink-0 text-gold" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 id={`funding-${runId}`} className="text-sm font-medium text-ink">
              Payroll funding
            </h3>
            <FundingBadge status={f.status} />
          </div>
          <p className="mt-1 text-sm text-ink">{fundingSentence(f)}</p>
          <p className="mt-0.5 text-xs text-ink-muted">{`Debit settles ${shortDay(f.debitEffectiveDate)} · pay lands ${shortDay(f.payDate)} · deadline ${etDeadline(f.fundingDeadline)}`}</p>
          <button type="button" className="mt-2 inline-flex items-center gap-1 text-xs text-accent underline underline-offset-2" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            {open ? 'Hide what’s in it' : 'What’s in it'}
            {open ? <ChevronUp className="h-3 w-3" aria-hidden /> : <ChevronDown className="h-3 w-3" aria-hidden />}
          </button>
          {open && <FundingBreakdownList f={f} />}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {canPull(f.status) && runFinalized && (
            <Button size="sm" onClick={() => pull.mutate()} loading={pull.isPending}>
              {`Pull ${centsToMoney(f.amountCents)}`}
            </Button>
          )}
          <Button asChild size="sm" variant="outline">
            <Link to={`/payroll/banking?run=${runId}`}>Payroll banking</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** Finance home: the next run that needs money, or nothing when every run is funded. */
export function NextFundingCard() {
  const q = useQuery({ queryKey: ['payroll-banking', 'summary'], queryFn: getBankingSummary, retry: false });
  if (q.isLoading) return <Skeleton className="h-24" />;
  if (q.isError || !q.data || q.data.profile?.bankRail !== 'ACH') return null;
  const next = q.data.runs.find((r) => !['SETTLED', 'WIRE_RECEIVED'].includes(r.funding.status));
  const trouble = q.data.runs.filter((r) => r.funding.status === 'RETURNED').length;
  return (
    <Card className={cn(trouble > 0 && 'border-alert/40')}>
      <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Banknote className="h-5 w-5 shrink-0 text-gold" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="text-sm font-medium">Payroll funding</CardTitle>
            {next && <FundingBadge status={next.funding.status} />}
          </div>
          <p className="mt-1 text-sm text-ink">
            {next ? fundingSentence(next.funding) : q.data.runs.length ? 'Every approved run is funded.' : 'No approved runs are waiting for money.'}
          </p>
          {q.data.openReturns > 0 && <p className="mt-0.5 text-xs text-alert">{`${q.data.openReturns} entr${q.data.openReturns === 1 ? 'y' : 'ies'} came back from banks in the last 30 days.`}</p>}
        </div>
        <Button asChild size="sm" variant={next && canPull(next.funding.status) ? 'primary' : 'outline'} className="shrink-0">
          <Link to="/payroll/banking">{next && canPull(next.funding.status) ? 'Fund payroll' : 'Open payroll banking'}</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
