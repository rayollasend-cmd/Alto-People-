import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { fmtMoney, fmtMoneyCompact } from '@/lib/format';
import { ChartTooltipContent } from '@/components/ui/charts/ChartTooltip';
import { PALETTE, TICK } from '@/components/ui/charts/palette';

const PROFIT_SERIES = { income: { name: 'Income', color: PALETTE.primary }, netIncome: { name: 'Net income', color: PALETTE.tertiary } };

/** The Books overview's Profit drawing — fetched with the chart (lazyPlot), the only part that needs recharts. */
export function ProfitPlot({ rows }: { rows: Array<{ month: string; income: number; netIncome: number }> }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barGap={2}>
        <CartesianGrid stroke={PALETTE.grid} vertical={false} />
        <XAxis dataKey="month" tick={TICK} tickLine={false} axisLine={{ stroke: PALETTE.grid }} />
        <YAxis tick={TICK} tickLine={false} axisLine={false} width={56} tickFormatter={(v: number) => fmtMoneyCompact(v)} />
        <ReferenceLine y={0} stroke={PALETTE.ref} />
        <Tooltip cursor={{ fill: PALETTE.cursor }} content={<ChartTooltipContent series={PROFIT_SERIES} format={(v) => fmtMoney(v)} />} />
        <Bar dataKey="income" name="Income" fill={PALETTE.primary} radius={[4, 4, 0, 0]} maxBarSize={28} isAnimationActive={false}>
          {rows.map((_r, i) => (
            <Cell key={i} fillOpacity={i === rows.length - 1 ? 1 : 0.7} />
          ))}
        </Bar>
        {/* A month at a loss is red — the chart says it before the table does. */}
        <Bar dataKey="netIncome" name="Net income" radius={[4, 4, 0, 0]} maxBarSize={28} isAnimationActive={false}>
          {rows.map((r, i) => (
            <Cell key={i} fill={r.netIncome < 0 ? PALETTE.bad : PALETTE.tertiary} fillOpacity={i === rows.length - 1 ? 1 : 0.7} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
