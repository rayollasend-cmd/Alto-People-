import {
  Bar,
  BarChart,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { PALETTE, TICK, TOOLTIP_STYLE, TOOLTIP_LABEL_STYLE, TOOLTIP_ITEM_STYLE } from '@/components/ui/charts';

const SERIES = PALETTE.primary;
const MUTED = 'rgb(var(--color-chart-1) / 0.35)';

/** One metric's weekly bars — fetched with the first panel (lazyPlot), the only part that needs recharts. */
export function OpsProductionPlot({
  data,
  mean,
  lastKey,
  unit,
  name,
}: {
  data: Array<{ weekKey: string; total: number; label: string }>;
  mean: number;
  lastKey: string | undefined;
  unit: string | null | undefined;
  name: string;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 6, right: 4, bottom: 0, left: 0 }}>
        <XAxis
          dataKey="label"
          tick={{ fill: TICK.fill, fontSize: 9 }}
          axisLine={false}
          tickLine={false}
          interval="preserveStartEnd"
        />
        <YAxis
          tick={{ fill: TICK.fill, fontSize: 9 }}
          axisLine={false}
          tickLine={false}
          width="auto"
          allowDecimals={false}
        />
        {/* The window's mean, so an unusual week looks unusual. */}
        <ReferenceLine
          y={mean}
          stroke="rgb(var(--color-silver) / 0.5)"
          strokeDasharray="3 3"
        />
        <ChartTooltip
          cursor={{ fill: PALETTE.cursor }}
          contentStyle={TOOLTIP_STYLE}
          labelStyle={TOOLTIP_LABEL_STYLE}
          itemStyle={TOOLTIP_ITEM_STYLE}
          labelFormatter={(v) => `Week of ${String(v)}`}
          formatter={(value) => [
            `${Number(value).toLocaleString('en-US')} ${unit ?? ''}`,
            name,
          ]}
        />
        <Bar dataKey="total" radius={[4, 4, 0, 0]} maxBarSize={26}>
          {data.map((d) => (
            // The current week carries the full step; the weeks behind
            // it recede, so the eye lands on the number that is live.
            <Cell key={d.weekKey} fill={d.weekKey === lastKey ? SERIES : MUTED} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
