import { Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { LegendKey } from './ChartTooltip';
import { AXIS, Y_AXIS_WIDTH, yAxisLabel } from './axes';
import { useChartHeight } from './frame';
import { PALETTE, TICK, TOOLTIP_ITEM_STYLE, TOOLTIP_LABEL_STYLE, TOOLTIP_STYLE } from './palette';

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

interface Row {
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

const COLOR = { total: PALETTE.primary, up: PALETTE.tertiary, down: PALETTE.series[4], flat: PALETTE.other } as const;

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
        <ResponsiveContainer width="100%" height="100%">
          <BarChart accessibilityLayer={false} data={rows} margin={{ top: 20, right: 12, bottom: 0, left: yLabel ? 8 : 0 }} barCategoryGap="22%">
            <CartesianGrid stroke={PALETTE.grid} vertical={false} />
            <XAxis dataKey="label" {...AXIS} interval={0} tick={{ ...TICK, fontSize: 10 }} />
            <YAxis tick={TICK} tickLine={false} axisLine={false} width={Y_AXIS_WIDTH} tickFormatter={(v: number) => format(v)} label={yAxisLabel(yLabel)} />
            <Tooltip
              cursor={{ fill: PALETTE.cursor }}
              contentStyle={TOOLTIP_STYLE}
              labelStyle={TOOLTIP_LABEL_STYLE}
              itemStyle={TOOLTIP_ITEM_STYLE}
              formatter={(_v, _n, item) => {
                const r = (item as { payload?: Row }).payload;
                return [r ? signed(r) : '', r ? kindWord(r) : ''];
              }}
            />
            <Bar dataKey="range" isAnimationActive={false} radius={[4, 4, 4, 4]} maxBarSize={44}>
              {rows.map((r, i) => (
                <Cell key={i} fill={COLOR[r.kind]} />
              ))}
              <LabelList dataKey="text" position="top" style={{ fill: TICK.fill, fontSize: 10 }} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
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
