import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { CHART } from '@/components/ui/ChartFrame';

/** The Timeline's "Lapsing each week" drawing — fetched with the chart (lazyPlot), the only part that needs recharts. */
export function LapsingPlot({ perWeek }: { perWeek: Array<{ week: string; lapsing: number }> }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={perWeek} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={CHART.grid} vertical={false} />
        <XAxis dataKey="week" tick={{ fill: CHART.axis, fontSize: 11 }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
        <YAxis allowDecimals={false} tick={{ fill: CHART.axis, fontSize: 11 }} tickLine={false} axisLine={false} width="auto" />
        <Tooltip contentStyle={CHART.tooltip} cursor={{ fill: CHART.grid }} />
        <Bar dataKey="lapsing" name="Lapsing" fill={CHART.warn} radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
