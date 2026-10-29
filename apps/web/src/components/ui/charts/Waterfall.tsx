import { LegendKey } from './ChartTooltip';
import { useChartHeight } from './frame';
import { lazyPlot } from './lazyPlot';
import { PALETTE } from './palette';

/** The drawing (recharts) loads with the first chart, not the page (lazyPlot). */
const WaterfallPlot = lazyPlot(() => import('./Waterfall.plot').then((m) => ({ default: m.WaterfallPlot })));

/**
 * Start → steps → end: how a figure becomes another (gross pay → taxes →
 * deductions → net; revenue → costs → profit). Totals are solid in the
 * primary hue; each step floats from the running total, colored by
 * direction, with its signed amount printed on it — a waterfall's steps
 * are the point, so every bar is labelled, and a sign (not only a color)
 * says which way it went. A negative total (a net loss) prints "−".
 */

export interface WaterfallStep {
  label: string;
  /** Signed: positive adds, negative takes away. Ignored on a subtotal. */
  value: number;
  /** A running total mid-chart ("Gross profit", "Operating income"): drawn
   *  solid from zero at the running value, like the start and end bars. */
  subtotal?: boolean;
}

export interface WaterfallProps {
  start: { label: string; value: number };
  steps: WaterfallStep[];
  /** The closing bar's label; its value is start + steps. */
  end: { label: string };
  format?: (v: number) => string;
  yLabel?: string;
  /** Legend words for the two directions. */
  words?: { total?: string; up?: string; down?: string };
  height?: number;
}

export interface Row {
  label: string;
  range: [number, number];
  amount: number;
  kind: 'total' | 'up' | 'down' | 'flat';
}

export function waterfallRows(start: WaterfallProps['start'], steps: WaterfallStep[], end: WaterfallProps['end']): Row[] {
  const rows: Row[] = [{ label: start.label, range: [Math.min(0, start.value), Math.max(0, start.value)], amount: start.value, kind: 'total' }];
  let run = start.value;
  for (const s of steps) {
    if (s.subtotal) {
      rows.push({ label: s.label, range: [Math.min(0, run), Math.max(0, run)], amount: run, kind: 'total' });
      continue;
    }
    const next = run + s.value;
    rows.push({ label: s.label, range: [Math.min(run, next), Math.max(run, next)], amount: s.value, kind: s.value > 0 ? 'up' : s.value < 0 ? 'down' : 'flat' });
    run = next;
  }
  rows.push({ label: end.label, range: [Math.min(0, run), Math.max(0, run)], amount: run, kind: 'total' });
  return rows;
}

// A bridge reads the board's way (IBCS): the totals solid in the navy-family
// blue, what adds in the positive hue, what takes away in the negative one.
// Gold was the totals (punctuation as a block) and magenta the costs — a
// series colour, not a meaning (2026-10-28).
const COLOR = { total: PALETTE.secondary, up: PALETTE.good, down: PALETTE.bad, flat: PALETTE.other } as const;

export function Waterfall({ start, steps, end, format = (v) => v.toLocaleString(), yLabel, words, height }: WaterfallProps) {
  const h = useChartHeight(height, 240);
  const hasUp = steps.some((s) => !s.subtotal && s.value > 0);
  const hasDown = steps.some((s) => !s.subtotal && s.value < 0);
  const signed = (r: Row) =>
    r.kind === 'total'
      ? `${r.amount < 0 ? '−' : ''}${format(Math.abs(r.amount))}`
      : r.kind === 'flat'
        ? format(0)
        : `${r.amount > 0 ? '+' : '−'}${format(Math.abs(r.amount))}`;
  const rows = waterfallRows(start, steps, end).map((r) => ({ ...r, text: signed(r) }));
  const kindWord = (r: Row) =>
    r.kind === 'total' ? (words?.total ?? 'Total') : r.kind === 'up' ? (words?.up ?? 'Adds') : r.kind === 'down' ? (words?.down ?? 'Takes away') : 'No change';
  return (
    <div className="flex w-full flex-col" style={{ height: h }}>
      <div className="min-h-0 flex-1">
        <WaterfallPlot rows={rows} colors={COLOR} format={format} yLabel={yLabel} signed={signed} kindWord={kindWord} />
      </div>
      <div className="mt-1">
        <LegendKey
          items={[
            { name: words?.total ?? 'Total', color: COLOR.total },
            ...(hasUp ? [{ name: words?.up ?? 'Adds', color: COLOR.up }] : []),
            ...(hasDown ? [{ name: words?.down ?? 'Takes away', color: COLOR.down }] : []),
          ]}
        />
      </div>
    </div>
  );
}
