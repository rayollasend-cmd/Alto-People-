import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ChartTooltipContent } from './ChartTooltip';
import { AXIS, Y_AXIS_WIDTH, xAxisLabel, yAxisLabel } from './axes';
import { PALETTE, TICK } from './palette';
import type { TrendLineChartProps, TrendSeries } from './TrendLineChart';

/** TrendLineChart's drawing — fetched with the first chart (lazyPlot), the only part that needs recharts. */
export function TrendLinePlot({
  data,
  x,
  colored,
  lookup,
  lastIdx,
  format,
  yLabel,
  xLabel,
  target,
  zeroBased,
  xTick,
  head,
}: Pick<TrendLineChartProps, 'data' | 'x' | 'yLabel' | 'xLabel' | 'target'> & {
  colored: Array<TrendSeries & { color: string }>;
  lookup: Record<string, { name: string; color: string }>;
  lastIdx: number;
  format: (v: number) => string;
  zeroBased: boolean;
  xTick: ((v: string) => string) | undefined;
  head: ((v: string) => string) | undefined;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart accessibilityLayer={false} data={data} margin={{ top: 12, right: 12, bottom: xLabel ? 14 : 0, left: yLabel ? 8 : 0 }}>
        <CartesianGrid stroke={PALETTE.grid} vertical={false} />
        <XAxis dataKey={x} {...AXIS} minTickGap={16} label={xAxisLabel(xLabel)} tickFormatter={xTick} />
        <YAxis tick={TICK} tickLine={false} axisLine={false} width={Y_AXIS_WIDTH} tickFormatter={(v: number) => format(v)} domain={zeroBased ? [0, 'auto'] : ['auto', 'auto']} label={yAxisLabel(yLabel)} />
        <Tooltip cursor={{ stroke: PALETTE.ref, strokeWidth: 1 }} content={<ChartTooltipContent series={lookup} heading={head} format={(v) => format(v)} />} />
        {target && (
          <ReferenceLine y={target.value} ifOverflow="extendDomain" stroke={PALETTE.ref} strokeDasharray="4 3" label={{ value: target.label, position: 'insideTopRight', fill: TICK.fill, fontSize: 10 }} />
        )}
        {colored.map((s) =>
          s.area ? (
            <Area key={s.key} type="monotone" dataKey={s.key} name={s.name} stroke={s.color} strokeWidth={2} fill={s.color} fillOpacity={0.12} isAnimationActive={false} connectNulls={false} dot={false} activeDot={{ r: 4, stroke: PALETTE.surface, strokeWidth: 2 }} />
          ) : (
            <Line
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.name}
              stroke={s.color}
              strokeWidth={2}
              strokeDasharray={s.dashed ? '5 3' : undefined}
              isAnimationActive={false}
              connectNulls={false}
              dot={(p: { index?: number; cx?: number; cy?: number }) =>
                p.index === lastIdx && p.cx != null && p.cy != null ? (
                  <circle key={`${s.key}-${p.index}`} cx={p.cx} cy={p.cy} r={3.5} fill={s.color} stroke={PALETTE.surface} strokeWidth={2} />
                ) : (
                  <g key={`${s.key}-${p.index}`} />
                )
              }
              activeDot={{ r: 4, stroke: PALETTE.surface, strokeWidth: 2 }}
            />
          ),
        )}
      </ComposedChart>
    </ResponsiveContainer>
  );
}
