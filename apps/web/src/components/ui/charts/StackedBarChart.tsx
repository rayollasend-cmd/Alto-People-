import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ChartTooltipContent, LegendKey } from './ChartTooltip';
import { AXIS, Y_AXIS_WIDTH, dateHeading, dateTicks, xAxisLabel, yAxisLabel, type DateGrain } from './axes';
import { useChartHeight } from './frame';
import { PALETTE, seriesColor, TICK } from './palette';

/**
 * Parts of a whole per period (stacked) or side by side (grouped). A 2px
 * surface gap separates touching segments, the top of each column has
 * 4px rounded ends, one y-axis, and a legend for two or more series.
 * `highlight` dims every column but one (the current run, this week).
 */

export interface BarSeries {
  key: string;
  name: string;
  color?: string;
}

export interface StackedBarChartProps {
  data: Array<Record<string, unknown>>;
  x: string;
  series: BarSeries[];
  /** false = grouped columns side by side. */
  stacked?: boolean;
  /** 'horizontal' bars run left to right with categories down the side. */
  layout?: 'vertical' | 'horizontal';
  format?: (v: number) => string;
  yLabel?: string;
  xLabel?: string;
  heading?: (x: string) => string;
  target?: { value: number; label: string };
  /** The x value to keep at full strength; others dim. */
  highlight?: string;
  onBarClick?: (row: Record<string, unknown>) => void;
  /** The x values are dates of this grain: ticks read "Oct 3" / "Oct" / "Q3 2026", never ISO. */
  xDates?: DateGrain;
  height?: number;
}

export function StackedBarChart({
  data,
  x,
  series,
  stacked = true,
  layout = 'vertical',
  format = (v) => v.toLocaleString(),
  yLabel,
  xLabel,
  heading,
  target,
  highlight,
  onBarClick,
  xDates,
  height,
}: StackedBarChartProps) {
  const horizontal = layout === 'horizontal';
  const h = useChartHeight(height, horizontal ? Math.max(140, data.length * 30 + 32) : 220);
  const colored = series.map((s, i) => ({ ...s, color: s.color ?? seriesColor(i) }));
  const lookup = Object.fromEntries(colored.map((s) => [s.key, { name: s.name, color: s.color }]));
  const lastKey = colored[colored.length - 1]?.key;
  const radius = (key: string): [number, number, number, number] =>
    stacked && key !== lastKey ? [0, 0, 0, 0] : horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0];
  const valueAxis = { tick: TICK, tickLine: false, axisLine: false, tickFormatter: (v: number) => format(v) } as const;
  const xTick = xDates ? dateTicks(xDates, data.map((r) => r[x])) : undefined;
  const head = heading ?? (xDates ? (v: string) => dateHeading(v, xDates) : undefined);
  return (
    <div className="flex w-full flex-col" style={{ height: h }}>
      <div className="min-h-0 flex-1">
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
      </div>
      {colored.length > 1 && (
        <div className="mt-1">
          <LegendKey items={colored.map((s) => ({ name: s.name, color: s.color }))} />
        </div>
      )}
    </div>
  );
}
