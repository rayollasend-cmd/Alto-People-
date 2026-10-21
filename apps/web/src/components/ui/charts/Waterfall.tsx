import { Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { LegendKey } from './ChartTooltip';
import { AXIS, yAxisLabel } from './axes';
import { useChartHeight } from './frame';
import { PALETTE, TICK, TOOLTIP_LABEL_STYLE, TOOLTIP_STYLE } from './palette';

/**
 * Start → steps → end: how a figure becomes another (gross pay → taxes →
 * deductions → net; revenue → costs → profit). Totals are solid in the
 * primary hue; each step floats from the running total, colored by
 * direction, with its amount printed on it — a waterfall's steps are the
 * point, so every bar is labelled.
 */

export interface WaterfallStep {
  label: string;
  /** Signed: positive adds, negative takes away. */
  value: number;
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
  kind: 'total' | 'up' | 'down';
}

export function waterfallRows(start: WaterfallProps['start'], steps: WaterfallStep[], end: WaterfallProps['end']): Row[] {
  const rows: Row[] = [{ label: start.label, range: [Math.min(0, start.value), Math.max(0, start.value)], amount: start.value, kind: 'total' }];
  let run = start.value;
  for (const s of steps) {
    const next = run + s.value;
    rows.push({ label: s.label, range: [Math.min(run, next), Math.max(run, next)], amount: s.value, kind: s.value >= 0 ? 'up' : 'down' });
    run = next;
  }
  rows.push({ label: end.label, range: [Math.min(0, run), Math.max(0, run)], amount: run, kind: 'total' });
  return rows;
}

const COLOR = { total: PALETTE.primary, up: PALETTE.tertiary, down: PALETTE.series[4] } as const;

export function Waterfall({ start, steps, end, format = (v) => v.toLocaleString(), yLabel, words, height }: WaterfallProps) {
  const h = useChartHeight(height, 240);
  const rows = waterfallRows(start, steps, end);
  const hasUp = steps.some((s) => s.value >= 0);
  const hasDown = steps.some((s) => s.value < 0);
  const signed = (r: Row) => (r.kind === 'total' ? format(r.amount) : `${r.amount >= 0 ? '+' : '−'}${format(Math.abs(r.amount))}`);
  return (
    <div className="flex w-full flex-col" style={{ height: h }}>
      <div className="min-h-0 flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ top: 20, right: 12, bottom: 0, left: yLabel ? 8 : 0 }} barCategoryGap="22%">
            <CartesianGrid stroke={PALETTE.grid} vertical={false} />
            <XAxis dataKey="label" {...AXIS} interval={0} tick={{ ...TICK, fontSize: 10 }} />
            <YAxis tick={TICK} tickLine={false} axisLine={false} width={yLabel ? 64 : 52} tickFormatter={(v: number) => format(v)} label={yAxisLabel(yLabel)} />
            <Tooltip
              cursor={{ fill: PALETTE.cursor }}
              contentStyle={TOOLTIP_STYLE}
              labelStyle={TOOLTIP_LABEL_STYLE}
              formatter={(_v, _n, item) => {
                const r = (item as { payload?: Row }).payload;
                return [r ? signed(r) : '', r?.kind === 'total' ? (words?.total ?? 'Total') : r && r.amount >= 0 ? (words?.up ?? 'Adds') : (words?.down ?? 'Takes away')];
              }}
            />
            <Bar dataKey="range" isAnimationActive={false} radius={[4, 4, 4, 4]} maxBarSize={44}>
              {rows.map((r, i) => (
                <Cell key={i} fill={COLOR[r.kind]} />
              ))}
              <LabelList dataKey="amount" position="top" formatter={(v: unknown) => (typeof v === 'number' ? format(Math.abs(v)) : '')} style={{ fill: TICK.fill, fontSize: 10 }} />
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
