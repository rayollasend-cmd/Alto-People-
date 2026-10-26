import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from 'recharts';
import { ChartTooltipContent as PortalTooltip } from '@/components/ui/charts/ChartTooltip';
import { PALETTE, TICK as KIT_TICK } from '@/components/ui/charts/palette';

// The kit's grid, ticks and reference color — one look across every chart.
const GRID = PALETTE.grid;
const TICK = { ...KIT_TICK, fontSize: 10 } as const;
const REF = PALETTE.ref;

/** The forecast's hours-by-week drawing — fetched with the chart (lazyPlot), the only part that needs recharts. */
export function ForecastPlot({
  data,
  series,
  bandColor,
  bandEdge,
  nowLabel,
}: {
  data: Array<{ week: string; label: string; actual: number | null; p50: number | null; band: number[] | null }>;
  series: Record<string, { name: string; color: string }>;
  bandColor: string;
  /** The band's top and bottom edge — a hairline, so the range reads on navy and on white. */
  bandEdge?: string;
  /** The x label of the first forecast week, where "Now" is drawn. */
  nowLabel: string | undefined;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={GRID} strokeWidth={1} vertical={false} />
        <XAxis dataKey="label" tick={TICK} axisLine={{ stroke: GRID }} tickLine={false} interval="preserveStartEnd" minTickGap={28} />
        <YAxis tick={TICK} axisLine={false} tickLine={false} width="auto" tickFormatter={(v: number) => `${Math.round(v).toLocaleString()} h`} />
        <ChartTooltip cursor={{ stroke: REF, strokeWidth: 1 }} content={<PortalTooltip series={series} format={(v) => `${Math.round(v).toLocaleString()} h`} />} />
        <Area type="linear" dataKey="band" stroke={bandEdge ?? 'none'} strokeWidth={1} fill={bandColor} fillOpacity={1} isAnimationActive={false} connectNulls={false} legendType="none" activeDot={false} />
        <Line type="monotone" dataKey="actual" stroke={PALETTE.secondary} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls={false} />
        <Line type="linear" dataKey="p50" stroke={PALETTE.primary} strokeWidth={2} strokeDasharray="5 3" dot={false} isAnimationActive={false} connectNulls={false} />
        {nowLabel !== undefined && (
          <ReferenceLine x={nowLabel} stroke={REF} strokeDasharray="4 3" label={{ value: 'Now', position: 'insideTopLeft', fill: KIT_TICK.fill, fontSize: 10 }} />
        )}
      </ComposedChart>
    </ResponsiveContainer>
  );
}
