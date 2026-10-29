import { Bar, BarChart, CartesianGrid, Legend, Tooltip, XAxis, YAxis } from 'recharts';
import { ResponsiveContainer } from '@/components/ui/charts/container.plot';
import { PALETTE, TICK, TOOLTIP_LABEL_STYLE, TOOLTIP_STYLE } from '@/components/ui/charts/palette';

/* The retention desk's drawings — fetched with the first chart (lazyPlot), the only part that needs recharts. */

/** High and some risk, stacked, one bar per location. */
export function RiskByPlacePlot({ shown }: { shown: Array<{ name: string; high: number; medium: number }> }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={shown} layout="vertical" margin={{ top: 0, right: 12, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={PALETTE.grid} horizontal={false} />
        <XAxis type="number" allowDecimals={false} tick={TICK} tickLine={false} axisLine={false} />
        <YAxis type="category" dataKey="name" width={140} tick={TICK} tickLine={false} axisLine={false} />
        <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL_STYLE} cursor={{ fill: PALETTE.cursor }} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey="high" name="High risk" stackId="risk" fill={PALETTE.bad} maxBarSize={18} />
        <Bar dataKey="medium" name="Some risk" stackId="risk" fill={PALETTE.warn} radius={[0, 3, 3, 0]} maxBarSize={18} />
      </BarChart>
    </ResponsiveContainer>
  );
}

/** The share still here 90 days on, one bar per play. */
export function StayRatePlot({ rows }: { rows: Array<{ play: string; stayRate: number | null; measured: number }> }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 12, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={PALETTE.grid} horizontal={false} />
        <XAxis type="number" domain={[0, 100]} tickFormatter={(v: number) => `${v}%`} tick={TICK} tickLine={false} axisLine={false} />
        <YAxis type="category" dataKey="play" width={160} tick={TICK} tickLine={false} axisLine={false} />
        <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL_STYLE} cursor={{ fill: PALETTE.cursor }} formatter={(v) => `${v}%`} />
        <Bar dataKey="stayRate" name="Stayed" fill={PALETTE.good} radius={[0, 3, 3, 0]} maxBarSize={18} />
      </BarChart>
    </ResponsiveContainer>
  );
}
