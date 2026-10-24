import { Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { fmtMoney, fmtMoneyCompact } from '@/lib/format';
import { PALETTE, TICK, TOOLTIP_LABEL_STYLE, TOOLTIP_STYLE } from '@/components/ui/charts/palette';

/** The weekly earned-against-cost drawing — fetched with the chart (lazyPlot), the only part that needs recharts. */
export function TransportTrendsPlot({ rows }: { rows: Array<{ week: string; revenue: number; cost: number; net: number }> }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={PALETTE.grid} vertical={false} />
        <XAxis dataKey="week" tick={TICK} tickLine={false} axisLine={false} />
        <YAxis tick={TICK} tickLine={false} axisLine={false} width={56} tickFormatter={(v: number) => fmtMoneyCompact(v)} />
        <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL_STYLE} cursor={{ fill: PALETTE.cursor }} formatter={(v) => fmtMoney(Number(v))} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey="revenue" name="Earned" fill={PALETTE.series[0]} radius={[3, 3, 0, 0]} maxBarSize={28} />
        <Bar dataKey="cost" name="Cost" fill={PALETTE.other} radius={[3, 3, 0, 0]} maxBarSize={28} />
        {/* Straight segments with a dot per week: a smoothed curve drew a
            valley between weeks that never happened (F500 G2). */}
        <Line dataKey="net" name="Net" stroke={PALETTE.series[1]} strokeWidth={2} dot={{ r: 3, fill: PALETTE.series[1], strokeWidth: 0 }} type="linear" />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
