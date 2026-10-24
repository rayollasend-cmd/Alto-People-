import { LegendKey } from './ChartTooltip';
import { dateHeading, dateTicks, type DateGrain } from './axes';
import { useChartHeight } from './frame';
import { lazyPlot } from './lazyPlot';
import { PALETTE, seriesColor } from './palette';

/** The drawing (recharts) loads with the first chart, not the page (lazyPlot). */
const TrendLinePlot = lazyPlot(() => import('./TrendLine.plot').then((m) => ({ default: m.TrendLinePlot })));

/**
 * Change over time: one line per series on ONE y-axis (two measures of
 * different scale belong in two charts). Lines are 2px, the newest point
 * carries a dot, a target draws as a dashed reference, and two or more
 * series get a legend. Colors follow the fixed categorical order unless a
 * series names its own.
 */

export interface TrendSeries {
  key: string;
  name: string;
  color?: string;
  /** Forecast / comparison: dashed. */
  dashed?: boolean;
  /** Soft fill under the line (use for one series at most). */
  area?: boolean;
}

export interface TrendLineChartProps {
  data: Array<Record<string, unknown>>;
  /** The x key (a label like "Oct 6"). */
  x: string;
  series: TrendSeries[];
  /** Tick and tooltip format for values ("$1.2k", "94%"). */
  format?: (v: number) => string;
  /** Unit label on the y-axis ("Hours", "Dollars"). */
  yLabel?: string;
  xLabel?: string;
  /** Tooltip heading from the x value ("Week of Oct 6"). */
  heading?: (x: string) => string;
  target?: { value: number; label: string };
  /** Force a zero baseline (counts, money). Default true. */
  zeroBased?: boolean;
  /** The x values are dates of this grain: ticks read "Oct 3" / "Oct" / "Q3 2026", never ISO. */
  xDates?: DateGrain;
  height?: number;
}

export function TrendLineChart({ data, x, series, format = (v) => v.toLocaleString(), yLabel, xLabel, heading, target, zeroBased = true, xDates, height }: TrendLineChartProps) {
  const h = useChartHeight(height, 220);
  const colored = series.map((s, i) => ({ ...s, color: s.color ?? seriesColor(i) }));
  const lookup = Object.fromEntries(colored.map((s) => [s.key, { name: s.name, color: s.color }]));
  const lastIdx = data.length - 1;
  const xTick = xDates ? dateTicks(xDates, data.map((r) => r[x])) : undefined;
  const head = heading ?? (xDates ? (v: string) => dateHeading(v, xDates) : undefined);
  return (
    <div className="flex w-full flex-col" style={{ height: h }}>
      <div className="min-h-0 flex-1">
        <TrendLinePlot data={data} x={x} colored={colored} lookup={lookup} lastIdx={lastIdx} format={format} yLabel={yLabel} xLabel={xLabel} target={target} zeroBased={zeroBased} xTick={xTick} head={head} />
      </div>
      {colored.length > 1 && (
        <div className="mt-1">
          <LegendKey items={[...colored.map((s) => ({ name: s.name, color: s.color, line: true })), ...(target ? [{ name: target.label, color: PALETTE.ref, line: true }] : [])]} />
        </div>
      )}
    </div>
  );
}
