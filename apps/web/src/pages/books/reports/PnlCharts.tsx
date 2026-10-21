import type { BooksPnlTotals, BooksProfitAndLoss } from '@alto-people/shared';
import { fmtMoney, fmtMoneyCompact } from '@/lib/format';
import { ChartFrame } from '@/components/ui/ChartFrame';
import { PALETTE, StackedBarChart, Waterfall, type WaterfallStep } from '@/components/ui/charts';

/**
 * The profit and loss as pictures: how income becomes net income (a
 * waterfall with the gross-profit and operating-income subtotals standing
 * on the floor), and — by month — income, costs and what was kept.
 */

/** Income → cost of services → gross profit → expenses → operating income → other → net income, as the kit's waterfall steps. */
export function pnlSteps(t: BooksPnlTotals): WaterfallStep[] {
  const steps: WaterfallStep[] = [
    { label: 'Cost of services', value: -t.costOfServices },
    { label: 'Gross profit', value: 0, subtotal: true },
    { label: 'Operating expenses', value: -t.expenses },
    { label: 'Operating income', value: 0, subtotal: true },
  ];
  if (t.otherIncome) steps.push({ label: 'Other income', value: t.otherIncome });
  if (t.otherExpenses) steps.push({ label: 'Other expenses', value: -t.otherExpenses });
  return steps;
}

export function PnlWaterfall({ totals }: { totals: BooksPnlTotals }) {
  const steps = pnlSteps(totals);
  const margin = totals.income ? Math.round((totals.netIncome / totals.income) * 1000) / 10 : null;
  const signed = (v: number) => `${v < 0 ? '−' : ''}${fmtMoney(Math.abs(v))}`;
  const summary = `Of ${fmtMoney(totals.income)} income, cost of services took ${fmtMoney(totals.costOfServices)} and operating expenses ${fmtMoney(totals.expenses)}, leaving ${signed(totals.netIncome)} net income${margin === null ? '' : ` (${margin}% of income)`}.`;
  // The table twin, each row signed as the bars are.
  const table = [
    { label: 'Income', amount: totals.income },
    { label: 'Cost of services', amount: -totals.costOfServices },
    { label: 'Gross profit', amount: totals.grossProfit },
    { label: 'Operating expenses', amount: -totals.expenses },
    { label: 'Operating income', amount: totals.operatingIncome },
    ...(totals.otherIncome ? [{ label: 'Other income', amount: totals.otherIncome }] : []),
    ...(totals.otherExpenses ? [{ label: 'Other expenses', amount: -totals.otherExpenses }] : []),
    { label: 'Net income', amount: totals.netIncome },
  ];
  return (
    <ChartFrame
      title="Where the money went"
      description={margin === null ? 'Income to net income, step by step.' : `Income to net income, step by step — ${margin}% kept.`}
      summary={summary}
      columns={[
        { key: 'label', label: 'Step' },
        { key: 'amount', label: 'Amount', numeric: true, format: (v) => signed(Number(v)) },
      ]}
      rows={totals.income || totals.netIncome ? table : []}
      csvName="profit-and-loss-waterfall"
      height={260}
    >
      <Waterfall start={{ label: 'Income', value: totals.income }} steps={steps} end={{ label: 'Net income' }} format={(v) => fmtMoneyCompact(v)} words={{ total: 'Subtotal' }} />
    </ChartFrame>
  );
}

/** By month: income, everything it cost, and what was kept. */
export function PnlMonthBars({ r }: { r: BooksProfitAndLoss }) {
  const rows = r.columns.map((c) => ({ month: c.label, income: c.totals.income, costs: c.totals.income - c.totals.netIncome, net: c.totals.netIncome }));
  const best = [...rows].sort((a, b) => b.net - a.net)[0];
  const worst = [...rows].sort((a, b) => a.net - b.net)[0];
  const summary = rows.length
    ? `Income, costs and net income for ${rows.length} months. Best month ${best!.month} (${fmtMoney(best!.net)} kept); weakest ${worst!.month} (${fmtMoney(worst!.net)}).`
    : 'No months in this range.';
  return (
    <ChartFrame
      title="By month"
      description="Income against everything it cost — the gap is what was kept."
      summary={summary}
      columns={[
        { key: 'month', label: 'Month' },
        { key: 'income', label: 'Income', numeric: true, format: (v) => fmtMoney(Number(v)) },
        { key: 'costs', label: 'Costs', numeric: true, format: (v) => fmtMoney(Number(v)) },
        { key: 'net', label: 'Net income', numeric: true, format: (v) => fmtMoney(Number(v)) },
      ]}
      rows={rows}
      csvName="profit-and-loss-by-month"
      height={260}
    >
      <StackedBarChart
        data={rows}
        x="month"
        stacked={false}
        series={[
          { key: 'income', name: 'Income' },
          { key: 'costs', name: 'Costs', color: PALETTE.other },
          { key: 'net', name: 'Net income', color: PALETTE.tertiary },
        ]}
        format={(v) => fmtMoneyCompact(v)}
      />
    </ChartFrame>
  );
}
