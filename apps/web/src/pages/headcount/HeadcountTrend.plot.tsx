import { Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { PALETTE, TICK, TOOLTIP_LABEL_STYLE, TOOLTIP_STYLE } from '@/components/ui/charts/palette';

/** Headcount's month-by-month drawing — fetched with the chart (lazyPlot), the only part that needs recharts. */
export function HeadcountTrendPlot({ rows }: { rows: Array<{ month: string; headcount: number; hires: number; separations: number }> }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} stackOffset="sign">
        <CartesianGrid stroke={PALETTE.grid} vertical={false} />
        <XAxis dataKey="month" tick={TICK} tickLine={false} axisLine={false} />
        <YAxis yAxisId="flow" tick={TICK} tickLine={false} axisLine={false} width={48} allowDecimals={false} tickFormatter={(v: number) => String(Math.abs(v))} label={{ value: 'Hires · separations', angle: -90, position: 'insideLeft', style: { ...TICK, textAnchor: 'middle' } }} />
        <YAxis yAxisId="count" orientation="right" tick={TICK} tickLine={false} axisLine={false} width={56} allowDecimals={false} label={{ value: 'Employed', angle: 90, position: 'insideRight', style: { ...TICK, textAnchor: 'middle' } }} />
        <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL_STYLE} cursor={{ fill: PALETTE.cursor }} formatter={(v) => Math.abs(Number(v)).toLocaleString('en-US')} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar yAxisId="flow" dataKey="hires" name="Hires" stackId="flow" fill={PALETTE.good} radius={[3, 3, 0, 0]} maxBarSize={24} />
        <Bar yAxisId="flow" dataKey="separations" name="Separations" stackId="flow" fill={PALETTE.bad} radius={[0, 0, 3, 3]} maxBarSize={24} />
        <Line yAxisId="count" dataKey="headcount" name="Employed" stroke={PALETTE.series[0]} strokeWidth={2} dot={false} type="stepAfter" />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
