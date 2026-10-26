import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { PALETTE, TICK, TOOLTIP_STYLE, TOOLTIP_LABEL_STYLE, TOOLTIP_ITEM_STYLE } from '@/components/ui/charts';

/** The week-by-week standards drawing — fetched with the chart (lazyPlot), the only part that needs recharts. */
export function WeeklyStandardsPlot({
  data,
}: {
  data: Array<{ weekKey: string; label: string; exceptions: number; sopPct: number | null }>;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid
          stroke={PALETTE.grid}
          vertical={false}
          strokeDasharray="0"
        />
        <XAxis
          dataKey="label"
          tick={{ fill: TICK.fill, fontSize: 10 }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          yAxisId="pct"
          domain={[0, 100]}
          ticks={[0, 50, 100]}
          tick={{ fill: TICK.fill, fontSize: 10 }}
          axisLine={false}
          tickLine={false}
          width="auto"
          unit="%"
        />
        {/* Exceptions ride the same axis as a count scaled to it, so
            this stays one scale and not a dual-axis chart. */}
        <ReferenceLine
          yAxisId="pct"
          y={95}
          stroke="rgb(var(--color-silver) / 0.5)"
          strokeDasharray="4 4"
        />
        <ChartTooltip
          cursor={{ fill: PALETTE.cursor }}
          contentStyle={TOOLTIP_STYLE}
          labelStyle={TOOLTIP_LABEL_STYLE}
          itemStyle={TOOLTIP_ITEM_STYLE}
          labelFormatter={(v) => `Week of ${String(v)}`}
          formatter={(value, name) =>
            name === 'sopPct'
              ? [`${String(value)}%`, 'Checklist completion']
              : [String(value), 'Exceptions (incomplete + temp alerts)']
          }
        />
        <Bar yAxisId="pct" dataKey="exceptions" maxBarSize={22} radius={[4, 4, 0, 0]}>
          {data.map((d) => (
            <Cell
              key={d.weekKey}
              fill={
                d.exceptions > 0
                  ? 'rgb(var(--color-alert) / 0.55)'
                  : 'rgb(var(--color-navy-secondary))'
              }
            />
          ))}
        </Bar>
        <Line
          yAxisId="pct"
          type="monotone"
          dataKey="sopPct"
          stroke={PALETTE.primary}
          strokeWidth={2}
          dot={{ r: 3, strokeWidth: 0, fill: PALETTE.primary }}
          connectNulls
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
