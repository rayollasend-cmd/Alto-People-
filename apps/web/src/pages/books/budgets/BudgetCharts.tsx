import type { BudgetVsActual } from '@alto-people/shared';
import { fmtMoney, fmtMoneyCompact } from '@/lib/format';
import { ChartFrame } from '@/components/ui/ChartFrame';
import { PALETTE, StackedBarChart } from '@/components/ui/charts';

/**
 * Budget against actual as pictures: each section's year to date side by
 * side, and net income month by month for the months that have actuals.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const money = (v: unknown) => fmtMoney(Number(v));
const isIncome = (key: string) => key === 'income' || key === 'otherIncome';

export function BudgetCharts({ report: r }: { report: BudgetVsActual }) {
  const sections = r.sections.map((s) => ({ section: s.label, budget: s.ytd.budget, actual: s.ytd.actual, variance: s.ytd.variance }));
  const months = Array.from({ length: Math.min(r.monthsElapsed, 12) }, (_, i) => {
    let budget = 0;
    let actual = 0;
    for (const s of r.sections) {
      const sign = isIncome(s.key) ? 1 : -1;
      for (const row of s.rows) {
        budget += sign * (row.months[i]?.budget ?? 0);
        actual += sign * (row.months[i]?.actual ?? 0);
      }
    }
    return { month: MONTHS[i] ?? r.periods[i] ?? String(i + 1), budget: Math.round(budget * 100) / 100, actual: Math.round(actual * 100) / 100 };
  });
  const off = [...r.sections].sort((a, b) => Math.abs(b.ytd.variance) - Math.abs(a.ytd.variance))[0];
  const beat = months.filter((m) => m.actual >= m.budget).length;
  const cols = (first: string, key: string) => [
    { key, label: first },
    { key: 'budget', label: 'Budget', numeric: true, format: money },
    { key: 'actual', label: 'Actual', numeric: true, format: money },
  ];
  return (
    <div className="grid gap-[var(--d-stack)] xl:grid-cols-2">
      <ChartFrame
        title="Year to date, by section"
        description="Budget beside actual."
        summary={off ? `Year to date, ${off.label.toLowerCase()} is furthest from budget: ${fmtMoney(off.ytd.actual)} against ${fmtMoney(off.ytd.budget)}.` : 'No sections.'}
        columns={[...cols('Section', 'section'), { key: 'variance', label: 'Variance', numeric: true, format: money }]}
        rows={sections}
        csvName="budget-vs-actual-sections"
        height={Math.max(180, sections.length * 46 + 40)}
      >
        <StackedBarChart
          data={sections}
          x="section"
          layout="horizontal"
          stacked={false}
          series={[
            { key: 'budget', name: 'Budget', color: PALETTE.other },
            { key: 'actual', name: 'Actual' },
          ]}
          format={(v) => fmtMoneyCompact(v)}
        />
      </ChartFrame>
      <ChartFrame
        title="Net income, month by month"
        description="Budget beside actual, for the months closed so far."
        summary={months.length ? `Net income beat its budget in ${beat} of ${months.length} months.` : 'No months with actuals yet.'}
        columns={cols('Month', 'month')}
        rows={months}
        csvName="budget-vs-actual-net-income"
        height={240}
      >
        <StackedBarChart
          data={months}
          x="month"
          stacked={false}
          series={[
            { key: 'budget', name: 'Budget', color: PALETTE.other },
            { key: 'actual', name: 'Actual' },
          ]}
          format={(v) => fmtMoneyCompact(v)}
        />
      </ChartFrame>
    </div>
  );
}
