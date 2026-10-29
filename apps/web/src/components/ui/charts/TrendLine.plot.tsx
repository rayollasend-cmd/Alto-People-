import { Area, CartesianGrid, ComposedChart, Line, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ChartTooltipContent } from './ChartTooltip';
import { AXIS, Y_AXIS_WIDTH, xAxisLabel, yAxisLabel } from './axes';
import { PALETTE, TICK } from './palette';
import type { TrendLineChartProps, TrendSeries } from './TrendLineChart';

/**
 * Below this many points a series is a handful of readings, not a trend:
 * straight segments between dots, never a smoothed curve. Three daily
 * totals drawn as a monotone spline read as an arc nobody measured (labor
 * costs, F500 audit 2026-10-26).
 */
export const FEW_POINTS = 10;

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
  mark,
}: Pick<TrendLineChartProps, 'data' | 'x' | 'yLabel' | 'xLabel' | 'target' | 'mark'> & {
  colored: Array<TrendSeries & { color: string }>;
  lookup: Record<string, { name: string; color: string }>;
  lastIdx: number;
  format: (v: number) => string;
  zeroBased: boolean;
  xTick: ((v: string) => string) | undefined;
  head: ((v: string) => string) | undefined;
}) {
  const few = data.length < FEW_POINTS;
  const curve = few ? 'linear' : 'monotone';
  // The marked point sits on the first series, at its own value.
  const first = colored[0];
  const markRow = mark && first ? data.find((r) => String(r[x]) === mark.x) : undefined;
  const markY = markRow && first && typeof markRow[first.key] === 'number' ? (markRow[first.key] as number) : null;
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
            <Area
              key={s.key}
              type={curve}
              dataKey={s.key}
              name={s.name}
              stroke={s.color}
              strokeWidth={2}
              fill={s.color}
              fillOpacity={0.12}
              isAnimationActive={false}
              connectNulls={false}
              dot={few ? { r: 3, fill: s.color, stroke: PALETTE.surface, strokeWidth: 1.5 } : false}
              activeDot={{ r: 4, stroke: PALETTE.surface, strokeWidth: 2 }}
            />
          ) : (
            <Line
              key={s.key}
              type={curve}
              dataKey={s.key}
              name={s.name}
              stroke={s.color}
              strokeWidth={2}
              strokeDasharray={s.dashed ? '5 3' : undefined}
              isAnimationActive={false}
              connectNulls={false}
              // Few points: every reading gets its dot. Many: only the newest.
              dot={(p: { index?: number; cx?: number; cy?: number }) =>
                (few || p.index === lastIdx) && p.cx != null && p.cy != null ? (
                  <circle key={`${s.key}-${p.index}`} cx={p.cx} cy={p.cy} r={p.index === lastIdx ? 3.5 : 3} fill={s.color} stroke={PALETTE.surface} strokeWidth={2} />
                ) : (
                  <g key={`${s.key}-${p.index}`} />
                )
              }
              activeDot={{ r: 4, stroke: PALETTE.surface, strokeWidth: 2 }}
            />
          ),
        )}
        {mark && first && markY !== null && (
          <ReferenceDot
            x={mark.x}
            y={markY}
            r={5}
            fill={PALETTE.surface}
            stroke={first.color}
            strokeWidth={2}
            ifOverflow="extendDomain"
            label={{ value: mark.label, position: 'bottom', offset: 10, fill: TICK.fill, fontSize: 11 }}
          />
        )}
      </ComposedChart>
    </ResponsiveContainer>
  );
}
