import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { fmtDate, fmtMoney, fmtMoneyCompact, fmtMonthShortYear } from '@/lib/format';
import { getExecutiveMoney, type ExecutiveMoney } from '@/lib/payrollDeskApi';
import { ChartFrame } from '@/components/ui/ChartFrame';
import { MetricCard } from '@/components/ui/MetricCard';
import { Skeleton } from '@/components/ui/Skeleton';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { TrendLineChart } from '@/components/ui/charts';

/**
 * The executive view's money band (finance walk 17): real figures from the
 * company's records — cash in the books today, the 13-week low point of
 * the cash forecast, month-to-date profit beside the budget, days to
 * collect by month, and what each payroll run cost. Each tile links to the
 * desk that keeps the number; a source not set up says so instead of $0.
 */
const monthLabel = (ym: string) => fmtMonthShortYear(`${ym}-15`);

export function MoneyBand() {
  const q = useQuery({ queryKey: ['executive', 'money'], queryFn: getExecutiveMoney, staleTime: 5 * 60_000 });
  if (q.isLoading) return <Skeleton className="h-40" />;
  if (q.isError || !q.data) return null;
  const m: ExecutiveMoney = q.data;
  const lastRun = m.payrollRuns[m.payrollRuns.length - 1] ?? null;
  const dsoRows = m.dso.map((d) => ({ month: monthLabel(d.month), days: d.days }));
  const dsoKnown = m.dso.filter((d) => d.days != null);
  const ytd = m.profit?.ytd ?? null;
  return (
    <section aria-labelledby="exec-money" className="space-y-3">
      <SectionTitle as="h2" title="Money" description="From the books, the cash forecast and payroll — not estimates." className="scroll-mt-20" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" id="exec-money">
        <Link to="/books" className="block">
          <MetricCard label="Cash today" value={m.cash ? fmtMoney(m.cash.total) : '—'} hint={m.cash ? `${m.cash.accounts} bank account${m.cash.accounts === 1 ? '' : 's'} in the books` : 'No bank accounts in the books yet'} />
        </Link>
        <Link to="/finance/cash-forecast" className="block">
          <MetricCard
            label="13-week low point"
            value={m.lowPoint ? <span className={m.lowPoint.belowMinimum ? 'text-alert' : undefined}>{fmtMoney(m.lowPoint.balance)}</span> : '—'}
            hint={m.lowPoint ? `week of ${fmtDate(m.lowPoint.weekStart)}${m.lowPoint.belowMinimum ? ' — below the minimum' : ''}` : 'Forecast needs a cash balance'}
          />
        </Link>
        <Link to="/books/budgets" className="block">
          <MetricCard
            label="Profit this month"
            value={m.profit ? fmtMoney(m.profit.mtdNetIncome) : '—'}
            hint={ytd ? `year to date ${fmtMoneyCompact(ytd.actual)} vs ${fmtMoneyCompact(ytd.budget)} budget (${ytd.variance >= 0 ? '+' : '−'}${fmtMoneyCompact(Math.abs(ytd.variance))})` : 'No budget for this year'}
          />
        </Link>
        <Link to="/payroll" className="block">
          <MetricCard label="Last payroll run" value={lastRun ? fmtMoney(lastRun.cost) : '—'} hint={lastRun ? `${lastRun.people} people · ${fmtMoney(lastRun.costPerPerson)} each, with employer taxes` : 'No payroll run yet'} />
        </Link>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <ChartFrame
          title="Days to collect"
          description="Average days from a statement going final to its payment, by the month it was paid."
          summary={dsoKnown.length ? `Latest ${dsoKnown[dsoKnown.length - 1]!.days} days to collect.` : 'No statements paid in the last six months.'}
          columns={[
            { key: 'month', label: 'Month' },
            { key: 'days', label: 'Days', numeric: true },
          ]}
          rows={dsoKnown.length ? dsoRows : []}
          csvName="days-to-collect"
          height={180}
        >
          <TrendLineChart data={dsoRows} x="month" series={[{ key: 'days', name: 'Days to collect' }]} format={(v) => `${Math.round(v)}d`} height={180} />
        </ChartFrame>
        <ChartFrame
          title="Cost per payroll run"
          description="Gross pay plus employer taxes, the last eight regular runs."
          summary={lastRun ? `Last run ${fmtMoney(lastRun.cost)} for ${lastRun.people} people.` : 'No payroll runs yet.'}
          columns={[
            { key: 'period', label: 'Period end' },
            { key: 'cost', label: 'Cost', numeric: true },
            { key: 'people', label: 'People', numeric: true },
          ]}
          rows={m.payrollRuns.map((r) => ({ period: fmtDate(r.periodEnd), cost: r.cost, people: r.people }))}
          csvName="payroll-run-cost"
          height={180}
        >
          <TrendLineChart data={m.payrollRuns.map((r) => ({ period: fmtDate(r.periodEnd), cost: r.cost }))} x="period" series={[{ key: 'cost', name: 'Run cost' }]} format={(v) => fmtMoneyCompact(v)} height={180} />
        </ChartFrame>
      </div>
    </section>
  );
}
