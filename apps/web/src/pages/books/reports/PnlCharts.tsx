import { Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { BooksPnlTotals, BooksProfitAndLoss } from '@alto-people/shared';
import { fmtMoney, fmtMoneyCompact } from '@/lib/format';
import { ChartFrame } from '@/components/ui/ChartFrame';
import { LegendKey, PALETTE, StackedBarChart, TICK, TOOLTIP_LABEL_STYLE, TOOLTIP_STYLE } from '@/components/ui/charts';

/**
 * The profit and loss as pictures: how income becomes net income (a
 * waterfall with the gross-profit and operating-income subtotals standing
 * on the floor), and — by month — income, costs and what was kept.
 */

type Kind = 'total' | 'up' | 'down';
interface Step {
  label: string;
  amount: number;
  range: [number, number];
  kind: Kind;
}

/** Income → cost of services → gross profit → expenses → operating income → other → net income. */
export function pnlSteps(t: BooksPnlTotals): Step[] {
  const total = (label: string, v: number): Step => ({ label, amount: v, range: [Math.min(0, v), Math.max(0, v)], kind: 'total' });
  const move = (label: string, from: number, by: number): Step => ({ label, amount: by, range: [Math.min(from, from + by), Math.max(from, from + by)], kind: by >= 0 ? 'up' : 'down' });
  const steps: Step[] = [total('Income', t.income), move('Cost of services', t.income, -t.costOfServices), total('Gross profit', t.grossProfit), move('Operating expenses', t.grossProfit, -t.expenses), total('Operating income', t.operatingIncome)];
  let run = t.operatingIncome;
  if (t.otherIncome) {
    steps.push(move('Other income', run, t.otherIncome));
    run += t.otherIncome;
  }
  if (t.otherExpenses) steps.push(move('Other expenses', run, -t.otherExpenses));
  steps.push(total('Net income', t.netIncome));
  return steps;
}

const COLOR: Record<Kind, string> = { total: PALETTE.primary, up: PALETTE.tertiary, down: PALETTE.series[4] };
const signed = (s: Step) => (s.kind === 'total' ? fmtMoney(s.amount) : `${s.amount >= 0 ? '+' : '−'}${fmtMoney(Math.abs(s.amount))}`);

export function PnlWaterfall({ totals }: { totals: BooksPnlTotals }) {
  const steps = pnlSteps(totals);
  const margin = totals.income ? Math.round((totals.netIncome / totals.income) * 1000) / 10 : null;
  const summary = `Of ${fmtMoney(totals.income)} income, cost of services took ${fmtMoney(totals.costOfServices)} and operating expenses ${fmtMoney(totals.expenses)}, leaving ${fmtMoney(totals.netIncome)} net income${margin === null ? '' : ` (${margin}% of income)`}.`;
  return (
    <ChartFrame
      title="Where the money went"
      description={margin === null ? 'Income to net income, step by step.' : `Income to net income, step by step — ${margin}% kept.`}
      summary={summary}
      columns={[
        { key: 'label', label: 'Step' },
        { key: 'amount', label: 'Amount', numeric: true, format: (v) => fmtMoney(Number(v)) },
      ]}
      rows={totals.income || totals.netIncome ? steps.map((s) => ({ label: s.label, amount: s.amount })) : []}
      csvName="profit-and-loss-waterfall"
      height={260}
    >
      <div className="flex h-full w-full flex-col">
        <div className="min-h-0 flex-1">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={steps} margin={{ top: 20, right: 12, bottom: 0, left: 0 }} barCategoryGap="22%">
              <CartesianGrid stroke={PALETTE.grid} vertical={false} />
              <XAxis dataKey="label" interval={0} tick={{ ...TICK, fontSize: 10 }} tickLine={false} axisLine={{ stroke: PALETTE.grid }} />
              <YAxis tick={TICK} tickLine={false} axisLine={false} width={56} tickFormatter={(v: number) => fmtMoneyCompact(v)} />
              <Tooltip
                cursor={{ fill: PALETTE.cursor }}
                contentStyle={TOOLTIP_STYLE}
                labelStyle={TOOLTIP_LABEL_STYLE}
                formatter={(_v, _n, item) => {
                  const s = (item as { payload?: Step }).payload;
                  return [s ? signed(s) : '', s?.kind === 'total' ? 'Subtotal' : s && s.amount >= 0 ? 'Adds' : 'Takes away'];
                }}
              />
              <Bar dataKey="range" isAnimationActive={false} radius={[4, 4, 4, 4]} maxBarSize={48}>
                {steps.map((s, i) => (
                  <Cell key={i} fill={COLOR[s.kind]} fillOpacity={s.kind === 'total' && s.amount < 0 ? 0.6 : 1} />
                ))}
                <LabelList dataKey="amount" position="top" formatter={(v: unknown) => (typeof v === 'number' ? fmtMoneyCompact(Math.abs(v)) : '')} style={{ fill: TICK.fill, fontSize: 10 }} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="mt-1">
          <LegendKey
            items={[
              { name: 'Subtotal', color: COLOR.total },
              ...(totals.otherIncome ? [{ name: 'Adds', color: COLOR.up }] : []),
              { name: 'Takes away', color: COLOR.down },
            ]}
          />
        </div>
      </div>
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
