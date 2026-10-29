import { Bar, BarChart, CartesianGrid, Cell, LabelList, Tooltip, XAxis, YAxis } from 'recharts';
import { ResponsiveContainer } from './container.plot';
import { AXIS, Y_AXIS_WIDTH, yAxisLabel } from './axes';
import { PALETTE, TICK, TOOLTIP_ITEM_STYLE, TOOLTIP_LABEL_STYLE, TOOLTIP_STYLE } from './palette';
import type { Row } from './Waterfall';

/** Waterfall's drawing — fetched with the first chart (lazyPlot), the only part that needs recharts. */
export function WaterfallPlot({
  rows,
  colors,
  format,
  yLabel,
  signed,
  kindWord,
}: {
  rows: Array<Row & { text: string }>;
  colors: Record<Row['kind'], string>;
  format: (v: number) => string;
  yLabel: string | undefined;
  signed: (r: Row) => string;
  kindWord: (r: Row) => string;
}) {
  return (
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
            <Cell key={i} fill={colors[r.kind]} />
          ))}
          <LabelList dataKey="text" position="top" style={{ fill: TICK.fill, fontSize: 10 }} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
