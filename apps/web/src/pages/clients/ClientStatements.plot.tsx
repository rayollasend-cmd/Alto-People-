import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { fmtMoney, fmtMoneyCompact } from '@/lib/format';
import { PALETTE, TICK, TOOLTIP_LABEL_STYLE, TOOLTIP_STYLE } from '@/components/ui/charts/palette';
import type { StatementRow } from './ClientPerformance';

/** The Performance tab's "Billed by statement" drawing — fetched with the chart (lazyPlot), the only part that needs recharts. */
export function StatementsPlot({ statements, colorOf, longDay }: { statements: StatementRow[]; colorOf: (s: StatementRow) => string; longDay: (ymd: string) => string }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={statements} margin={{ top: 12, right: 12, bottom: 0, left: 0 }} barCategoryGap="24%">
        <CartesianGrid stroke={PALETTE.grid} vertical={false} />
        <XAxis dataKey="label" tick={TICK} tickLine={false} axisLine={false} minTickGap={8} />
        <YAxis tick={TICK} tickLine={false} axisLine={false} width={56} tickFormatter={(v: number) => fmtMoneyCompact(v)} />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          labelStyle={TOOLTIP_LABEL_STYLE}
          cursor={{ fill: PALETTE.cursor }}
          labelFormatter={(_l, payload) => {
            const row = payload?.[0]?.payload as StatementRow | undefined;
            return row ? `${row.name} · period ending ${longDay(row.periodEnd)}` : '';
          }}
          formatter={(v, _n, item) => [fmtMoney(Number(v)), (item?.payload as StatementRow | undefined)?.status ?? 'Billed']}
        />
        <Bar dataKey="amount" name="Billed" radius={[3, 3, 0, 0]} maxBarSize={32} isAnimationActive={false}>
          {statements.map((s) => (
            <Cell key={s.id} fill={colorOf(s)} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
