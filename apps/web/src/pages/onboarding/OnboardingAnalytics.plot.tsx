import { Bar, BarChart, CartesianGrid, Legend, Tooltip, XAxis, YAxis } from 'recharts';
import { ResponsiveContainer } from '@/components/ui/charts/container.plot';
import { PALETTE, TICK, TOOLTIP_LABEL_STYLE, TOOLTIP_STYLE } from '@/components/ui/charts/palette';

/** The monthly invited-vs-completed bars — fetched with the chart (lazyPlot), the only part that needs recharts. */
export function OnboardingMonthlyPlot({ rows }: { rows: Array<{ month: string; invited: number; completed: number; rate: number | null }> }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={PALETTE.grid} vertical={false} />
        <XAxis dataKey="month" tick={TICK} tickLine={false} axisLine={false} />
        <YAxis allowDecimals={false} tick={TICK} tickLine={false} axisLine={false} width="auto" />
        <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL_STYLE} cursor={{ fill: PALETTE.cursor }} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey="invited" name="Invited" fill={PALETTE.other} radius={[3, 3, 0, 0]} maxBarSize={22} />
        <Bar dataKey="completed" name="Completed" fill={PALETTE.series[0]} radius={[3, 3, 0, 0]} maxBarSize={22} />
      </BarChart>
    </ResponsiveContainer>
  );
}
