import { Bar, BarChart, CartesianGrid, ReferenceLine, Tooltip, XAxis, YAxis } from 'recharts';
import { ResponsiveContainer } from '@/components/ui/charts/container.plot';
import { ChartTooltipContent, PALETTE, TICK } from '@/components/ui/charts';

/** TeamHoursCard's drawing — fetched with the first chart (lazyPlot), the only part that needs recharts. */
export function TeamHoursPlot({
  rows,
  thresholdHours,
  fmtH,
  series,
}: {
  rows: Array<{ name: string; worked: number; scheduled: number }>;
  thresholdHours: number;
  fmtH: (v: number) => string;
  series: { worked: { name: string; color: string }; scheduled: { name: string; color: string } };
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={rows} layout="vertical" margin={{ top: 12, right: 16, bottom: 0, left: 0 }} barCategoryGap="28%">
        <CartesianGrid stroke={PALETTE.grid} horizontal={false} />
        {/* Forty is always on the scale, however short the week. */}
        <XAxis type="number" domain={[0, (max: number) => Math.max(Math.ceil(max), thresholdHours + 4)]} tick={TICK} tickLine={false} axisLine={{ stroke: PALETTE.grid }} tickFormatter={fmtH} />
        <YAxis type="category" dataKey="name" tick={TICK} tickLine={false} axisLine={false} width={120} />
        <Tooltip cursor={{ fill: PALETTE.cursor }} content={<ChartTooltipContent series={series} format={(v) => fmtH(v)} />} />
        <ReferenceLine x={thresholdHours} ifOverflow="extendDomain" stroke={PALETTE.bad} strokeDasharray="4 3" label={{ value: `${thresholdHours}h`, position: 'insideTopRight', fill: TICK.fill, fontSize: 10 }} />
        <Bar dataKey="worked" name="Worked" stackId="h" fill={series.worked.color} isAnimationActive={false} />
        <Bar dataKey="scheduled" name="Still scheduled" stackId="h" fill={series.scheduled.color} radius={[0, 4, 4, 0]} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}
