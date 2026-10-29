import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, Tooltip, XAxis, YAxis } from 'recharts';
import { ResponsiveContainer } from './container.plot';
import { ChartTooltipContent } from './ChartTooltip';
import { AXIS, Y_AXIS_WIDTH, xAxisLabel, yAxisLabel } from './axes';
import { PALETTE, TICK } from './palette';
import type { BarSeries, StackedBarChartProps } from './StackedBarChart';

/** StackedBarChart's drawing — fetched with the first chart (lazyPlot), the only part that needs recharts. */
export function StackedBarPlot({
  data,
  x,
  colored,
  lookup,
  stacked,
  horizontal,
  format,
  yLabel,
  xLabel,
  target,
  highlight,
  onBarClick,
  xTick,
  head,
}: Pick<StackedBarChartProps, 'data' | 'x' | 'yLabel' | 'xLabel' | 'target' | 'highlight' | 'onBarClick'> & {
  colored: Array<BarSeries & { color: string }>;
  lookup: Record<string, { name: string; color: string }>;
  stacked: boolean;
  horizontal: boolean;
  format: (v: number) => string;
  xTick: ((v: string) => string) | undefined;
  head: ((v: string) => string) | undefined;
}) {
  const lastKey = colored[colored.length - 1]?.key;
  const radius = (key: string): [number, number, number, number] =>
    stacked && key !== lastKey ? [0, 0, 0, 0] : horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0];
  const valueAxis = { tick: TICK, tickLine: false, axisLine: false, tickFormatter: (v: number) => format(v) } as const;
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart accessibilityLayer={false}
        data={data}
        layout={horizontal ? 'vertical' : 'horizontal'}
        margin={{ top: 12, right: 12, bottom: xLabel ? 14 : 0, left: yLabel ? 8 : 0 }}
        barCategoryGap="28%"
        barGap={2}
      >
        <CartesianGrid stroke={PALETTE.grid} vertical={horizontal} horizontal={!horizontal} />
        {horizontal ? (
          <>
            <XAxis type="number" {...valueAxis} label={xAxisLabel(xLabel)} />
            <YAxis type="category" dataKey={x} {...AXIS} axisLine={false} width={120} tickFormatter={xTick} />
          </>
        ) : (
          <>
            <XAxis dataKey={x} {...AXIS} label={xAxisLabel(xLabel)} tickFormatter={xTick} />
            <YAxis {...valueAxis} width={Y_AXIS_WIDTH} label={yAxisLabel(yLabel)} />
          </>
        )}
        <Tooltip cursor={{ fill: PALETTE.cursor }} content={<ChartTooltipContent series={lookup} heading={head} format={(v) => format(v)} />} />
        {target && (
          <ReferenceLine
            {...(horizontal ? { x: target.value } : { y: target.value })}
            ifOverflow="extendDomain"
            stroke={PALETTE.ref}
            strokeDasharray="4 3"
            label={{ value: target.label, position: 'insideTopRight', fill: TICK.fill, fontSize: 10 }}
          />
        )}
        {colored.map((s) => (
          <Bar
            key={s.key}
            dataKey={s.key}
            name={s.name}
            stackId={stacked ? 'a' : undefined}
            fill={s.color}
            stroke={stacked ? PALETTE.surface : undefined}
            strokeWidth={stacked ? 1 : 0}
            radius={radius(s.key)}
            maxBarSize={horizontal ? 18 : 32}
            isAnimationActive={false}
            cursor={onBarClick ? 'pointer' : undefined}
            onClick={onBarClick ? (d: { payload?: Record<string, unknown> }) => d.payload && onBarClick(d.payload) : undefined}
          >
            {highlight !== undefined && data.map((row, i) => <Cell key={i} fillOpacity={String(row[x]) === highlight ? 1 : 0.55} />)}
          </Bar>
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}
