import { LegendKey } from './ChartTooltip';
import { dateHeading, dateTicks, type DateGrain } from './axes';
import { useChartHeight } from './frame';
import { lazyPlot } from './lazyPlot';
import { seriesColor } from './palette';

/** The drawing (recharts) loads with the first chart, not the page (lazyPlot). */
const StackedBarPlot = lazyPlot(() => import('./StackedBar.plot').then((m) => ({ default: m.StackedBarPlot })));

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
  const xTick = xDates ? dateTicks(xDates, data.map((r) => r[x])) : undefined;
  const head = heading ?? (xDates ? (v: string) => dateHeading(v, xDates) : undefined);
  return (
    <div className="flex w-full flex-col" style={{ height: h }}>
      <div className="min-h-0 flex-1">
        <StackedBarPlot data={data} x={x} colored={colored} lookup={lookup} stacked={stacked} horizontal={horizontal} format={format} yLabel={yLabel} xLabel={xLabel} target={target} highlight={highlight} onBarClick={onBarClick} xTick={xTick} head={head} />
      </div>
      {colored.length > 1 && (
        <div className="mt-1">
          <LegendKey items={colored.map((s) => ({ name: s.name, color: s.color }))} />
        </div>
      )}
    </div>
  );
}
