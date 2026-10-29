import { cn } from '@/lib/cn';
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
 *
 * The sparse rule (2026-10-27): with fewer than TREND_MIN_POINTS readings a
 * line is not a trend — three dots on a 220px axis read as a story nobody
 * measured. The chart then shows the latest value as a number and one
 * sentence ("7 days in October — the first month on record") instead of a
 * near-empty axis. `SparseReading` is the same face for a figure that
 * isn't a line (a bar chart with three columns).
 */

/** Fewer readings than this and the chart is a number and a sentence, not an axis. */
export const TREND_MIN_POINTS = 4;

const isReading = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** How many rows carry a reading in any of the series. */
export function trendReadings(data: ReadonlyArray<Record<string, unknown>>, series: ReadonlyArray<Pick<TrendSeries, 'key'>>): number {
  return data.filter((r) => series.some((s) => isReading(r[s.key]))).length;
}

/** Whether a figure has too few readings to draw as a trend (the sparse rule) — size its frame down. */
export function isSparseTrend(data: ReadonlyArray<Record<string, unknown>>, series: ReadonlyArray<Pick<TrendSeries, 'key'>>): boolean {
  return trendReadings(data, series) < TREND_MIN_POINTS;
}

/** The kit's default sentence for a short series: how many readings, and the latest one's date. */
export function sparseSentence(count: number, when: string | null): string {
  const at = when ? ` (${when})` : '';
  if (count === 0) return 'No readings yet.';
  if (count === 1) return `One reading so far${at} — a trend needs ${TREND_MIN_POINTS}.`;
  return `${count} readings so far, the latest${at} — a trend needs ${TREND_MIN_POINTS}.`;
}

export interface SparseFigure {
  /** Shown above the value when there is more than one figure. */
  label?: string;
  value: string;
  /** The exact figure, for a title attribute. */
  title?: string;
}

/**
 * The latest value(s) as numbers and one line of why there is no chart —
 * the face of the sparse rule. Fills a ChartFrame's plot box (centred) or
 * sizes to its content outside one.
 */
export function SparseReading({ figures, note, className }: { figures: SparseFigure[]; note: string; className?: string }) {
  const many = figures.length > 1;
  return (
    <div className={cn('flex h-full w-full flex-col justify-center gap-2 py-2', className)} data-testid="trend-sparse">
      <div className="flex flex-wrap items-end gap-x-8 gap-y-2">
        {figures.map((f, i) => (
          <div key={f.label ?? i} className="min-w-0">
            {many && f.label && <div className="text-2xs uppercase tracking-[0.18em] text-ink-muted">{f.label}</div>}
            <div className="text-2xl font-medium tabular-nums leading-tight text-ink" title={f.title}>
              {f.value}
            </div>
          </div>
        ))}
      </div>
      <p className="max-w-prose text-xs2 text-ink-muted">{note}</p>
    </div>
  );
}

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
  /**
   * The one line under the latest value when there are too few readings for
   * a trend (the sparse rule): "7 days in October — the first month on
   * record". Left out, it says how many readings there are.
   */
  sparseNote?: string;
  /** One point of the first series ringed and labelled — a forecast's low point. */
  mark?: { x: string; label: string };
}

export function TrendLineChart({ data, x, series, format = (v) => v.toLocaleString(), yLabel, xLabel, heading, target, zeroBased = true, xDates, height, sparseNote, mark }: TrendLineChartProps) {
  const h = useChartHeight(height, 220);
  const colored = series.map((s, i) => ({ ...s, color: s.color ?? seriesColor(i) }));
  const lookup = Object.fromEntries(colored.map((s) => [s.key, { name: s.name, color: s.color }]));
  const lastIdx = data.length - 1;
  const xTick = xDates ? dateTicks(xDates, data.map((r) => r[x])) : undefined;
  const head = heading ?? (xDates ? (v: string) => dateHeading(v, xDates) : undefined);
  const readings = data.filter((r) => series.some((s) => isReading(r[s.key])));
  if (readings.length < TREND_MIN_POINTS) {
    const latest = readings[readings.length - 1];
    const when = latest ? (head ? head(String(latest[x])) : String(latest[x])) : null;
    // Each series' newest reading, in the series' own order.
    const figures = colored.flatMap((s) => {
      const row = [...readings].reverse().find((r) => isReading(r[s.key]));
      return row ? [{ label: s.name, value: format(row[s.key] as number) }] : [];
    });
    return (
      <div className="w-full" style={{ height: h === '100%' ? '100%' : undefined, minHeight: typeof h === 'number' ? Math.min(h, 120) : undefined }}>
        <SparseReading figures={figures} note={sparseNote ?? sparseSentence(readings.length, when)} />
      </div>
    );
  }
  return (
    <div className="flex w-full flex-col" style={{ height: h }}>
      <div className="min-h-0 flex-1">
        <TrendLinePlot data={data} x={x} colored={colored} lookup={lookup} lastIdx={lastIdx} format={format} yLabel={yLabel} xLabel={xLabel} target={target} zeroBased={zeroBased} xTick={xTick} head={head} mark={mark} />
      </div>
      {colored.length > 1 && (
        <div className="mt-1">
          <LegendKey items={[...colored.map((s) => ({ name: s.name, color: s.color, line: true })), ...(target ? [{ name: target.label, color: PALETTE.ref, line: true }] : [])]} />
        </div>
      )}
    </div>
  );
}
