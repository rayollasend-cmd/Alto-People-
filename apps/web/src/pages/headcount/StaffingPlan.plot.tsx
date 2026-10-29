import { Bar, CartesianGrid, ComposedChart, Legend, Line, Tooltip, XAxis, YAxis } from 'recharts';
import { ResponsiveContainer } from '@/components/ui/charts/container.plot';
import { STOCK_LEGEND } from '@/components/ui/charts/ChartTooltip';
import { CHART } from '@/components/ui/ChartFrame';

/** The staffing plan's "Required against in place" drawing — fetched with the chart (lazyPlot), the only part that needs recharts. */
export function StaffingPlanPlot({ chartRows }: { chartRows: Array<{ week: string; inPlace: number; short: number; required: number; scheduled: number }> }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart data={chartRows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={CHART.grid} vertical={false} />
        <XAxis dataKey="week" tick={{ fill: CHART.axis, fontSize: 11 }} tickLine={false} axisLine={false} />
        <YAxis allowDecimals={false} tick={{ fill: CHART.axis, fontSize: 11 }} tickLine={false} axisLine={false} width="auto" />
        <Tooltip contentStyle={CHART.tooltip} labelStyle={CHART.tooltipLabel} itemStyle={CHART.tooltipItem} />
        <Legend {...STOCK_LEGEND} />
        <Bar dataKey="inPlace" name="Covered by placed staff" stackId="heads" fill={CHART.series[1]} />
        <Bar dataKey="short" name="Short" stackId="heads" fill={CHART.bad} radius={[3, 3, 0, 0]} />
        <Line dataKey="scheduled" name="Scheduled" stroke={CHART.series[0]} strokeWidth={2} dot={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
