import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock } from '@/components/ui/icons';
import { toast } from '@/components/ui/Toaster';
import { Button } from '@/components/ui/Button';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { useMoneyConfirm } from '@/components/payroll/MoneyConfirm';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { fmtDateOnly, fmtDateOnlyRange, fmtHours, fmtMoney } from '@/lib/format';
import { addBackPay, getBackPay, type BackPayPerson } from '@/lib/payrollDeskApi';

/**
 * Back pay: the evening hours the old pay-period cut missed (the owner's
 * answer to the deep audit). Runs made before the fix sliced time by UTC
 * midnights, so a shift that started on a period's last evening at a US
 * store (Friday 7 PM in Chicago) was paid by no run. This card lists who is
 * owed what — the days, hours, rate, the overtime those hours would have
 * earned, and the amount — and one action puts it on the next regular run
 * as a "Back pay" line, once. Renders nothing when nothing is owed.
 */
export function BackPayCard({ canProcess, focus }: { canProcess: boolean; focus?: boolean }) {
  const qc = useQueryClient();
  const ref = useRef<HTMLDivElement>(null);
  const confirmMoney = useMoneyConfirm();
  const q = useQuery({ queryKey: ['payroll', 'back-pay'], queryFn: () => getBackPay(), enabled: canProcess, staleTime: 60_000, retry: false });
  const add = useMutation({
    mutationFn: () => addBackPay(),
    onSuccess: (r) => {
      if (r.pending) toast.success(`Sent for approval: ${fmtMoney(r.total)} back pay. It goes on the run once a second person approves.`);
      else toast.success(`Added ${fmtMoney(r.total)} back pay to the next regular run.`);
      void qc.invalidateQueries({ queryKey: ['payroll'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'The back pay could not be added. Nothing changed.'),
  });
  const people = q.data?.people ?? [];
  useEffect(() => {
    if (focus && people.length > 0) ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focus, people.length]);
  if (!q.data || people.length === 0) return null;

  const ready = people.filter((p) => p.target);
  const readyTotal = Math.round(ready.reduce((s, p) => s + p.amount, 0) * 100) / 100;
  const runs = [...new Map(ready.map((p) => [p.target!.runId, p.target!])).values()];
  const runWords = runs.length === 1 ? `the ${fmtDateOnlyRange(runs[0]!.periodStart, runs[0]!.periodEnd)} run` : `${runs.length} open runs`;

  const onAdd = async () => {
    const ok = await confirmMoney({
      title: 'Add this back pay to the next regular run?',
      amount: readyTotal,
      to: `${ready.length} ${ready.length === 1 ? 'person' : 'people'}, as a “Back pay” line on ${runWords}`,
      when: 'Paid with that run',
      note: q.data!.waitingForRun > 0 ? `${q.data!.waitingForRun} more ${q.data!.waitingForRun === 1 ? 'person is' : 'people are'} on no open run yet — they stay listed here.` : undefined,
      confirmLabel: `Add ${fmtMoney(readyTotal)}`,
    });
    if (ok) add.mutate();
  };

  return (
    <div
      ref={ref}
      role="region"
      aria-label="Back pay: evening hours the old cut missed"
      data-testid="back-pay-card"
      className={cn('mb-5 rounded-lg border border-warning/40 bg-warning/5 p-4', focus && 'ring-2 ring-warning/40')}
    >
      <SectionTitle
        title="Back pay: evening hours the old cut missed"
        icon={Clock}
        size="sm"
        wrap
        className="mb-0"
        description={
          <>
            Before the fix, a run counted time by UTC midnight, so a shift that started on a period’s last evening was paid by no check.{' '}
            <span className="font-medium text-ink tabular-nums">{fmtMoney(q.data.total)}</span> owed to {people.length} {people.length === 1 ? 'person' : 'people'}.
          </>
        }
        trailing={
          canProcess ? (
            <div className="flex flex-col items-end gap-1">
              <Button size="sm" onClick={() => void onAdd()} disabled={ready.length === 0 || add.isPending} loading={add.isPending}>
                Add to the next regular run
              </Button>
              {ready.length === 0 && <span className="text-xs text-ink-muted">No regular run is open. Start the next run and add it there.</span>}
            </div>
          ) : undefined
        }
      />
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[34rem] text-sm">
          <thead>
            <tr className="text-left text-xs text-ink-muted">
              <th scope="col" className="py-1 pr-3 font-medium">Person</th>
              <th scope="col" className="py-1 pr-3 font-medium">Days</th>
              <th scope="col" className="py-1 pr-3 text-right font-medium">Hours</th>
              <th scope="col" className="py-1 pr-3 text-right font-medium">Rate</th>
              <th scope="col" className="py-1 pr-3 text-right font-medium">Overtime</th>
              <th scope="col" className="py-1 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {people.map((p) => (
              <BackPayRow key={p.associateId} p={p} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BackPayRow({ p }: { p: BackPayPerson }) {
  const days = [...new Set(p.punches.map((x) => x.workDay))];
  const rate = p.rates.length === 1 ? fmtMoney(p.rates[0]!) : `${fmtMoney(p.rates[0]!)}–${fmtMoney(p.rates[p.rates.length - 1]!)}`;
  return (
    <tr data-testid="back-pay-row">
      <td className="py-2 pr-3 align-top">
        <Link to={`/people/${p.associateId}?tab=pay`} className="text-ink underline-offset-2 hover:underline">
          {p.name}
        </Link>
        <div className="text-xs text-ink-muted">
          {p.target ? `On the ${fmtDateOnlyRange(p.target.periodStart, p.target.periodEnd)} run` : 'No open run yet'}
        </div>
      </td>
      <td className="py-2 pr-3 align-top text-ink">
        {days.map((d) => fmtDateOnly(d, { weekday: true, year: 'auto' })).join(', ')}
        <div className="text-xs text-ink-muted">Paid period {p.periods.map((x) => fmtDateOnlyRange(x.periodStart, x.periodEnd)).join('; ')}</div>
      </td>
      <td className="py-2 pr-3 text-right align-top tabular-nums">{fmtHours(p.hours)}</td>
      <td className="py-2 pr-3 text-right align-top tabular-nums">{rate}</td>
      <td className="py-2 pr-3 text-right align-top tabular-nums">
        {p.overtimePremium > 0 ? (
          <>
            {fmtMoney(p.overtimePremium)}
            <div className="text-xs text-ink-muted">{fmtHours(p.overtimeHours)} past 40</div>
          </>
        ) : (
          <span className="text-ink-muted">None</span>
        )}
      </td>
      <td className="py-2 text-right align-top font-medium tabular-nums">{fmtMoney(p.amount)}</td>
    </tr>
  );
}
