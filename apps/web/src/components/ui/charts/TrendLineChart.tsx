import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ChartTooltipContent, LegendKey } from './ChartTooltip';
import { AXIS, xAxisLabel, yAxisLabel } from './axes';
import { useChartHeight } from './frame';
import { PALETTE, seriesColor, TICK } from './palette';

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
  height?: number;
}

export function TrendLineChart({ data, x, series, format = (v) => v.toLocaleString(), yLabel, xLabel, heading, target, zeroBased = true, height }: TrendLineChartProps) {
  const h = useChartHeight(height, 220);
  const colored = series.map((s, i) => ({ ...s, color: s.color ?? seriesColor(i) }));
  const lookup = Object.fromEntries(colored.map((s) => [s.key, { name: s.name, color: s.color }]));
  const lastIdx = data.length - 1;
  return (
    <div className="flex w-full flex-col" style={{ height: h }}>
      <div className="min-h-0 flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 12, right: 12, bottom: xLabel ? 14 : 0, left: yLabel ? 8 : 0 }}>
            <CartesianGrid stroke={PALETTE.grid} vertical={false} />
            <XAxis dataKey={x} {...AXIS} minTickGap={16} label={xAxisLabel(xLabel)} />
            <YAxis tick={TICK} tickLine={false} axisLine={false} width={yLabel ? 64 : 48} tickFormatter={(v: number) => format(v)} domain={zeroBased ? [0, 'auto'] : ['auto', 'auto']} label={yAxisLabel(yLabel)} />
            <Tooltip cursor={{ stroke: PALETTE.ref, strokeWidth: 1 }} content={<ChartTooltipContent series={lookup} heading={heading} format={(v) => format(v)} />} />
            {target && (
              <ReferenceLine y={target.value} ifOverflow="extendDomain" stroke={PALETTE.ref} strokeDasharray="4 3" label={{ value: target.label, position: 'insideTopRight', fill: TICK.fill, fontSize: 10 }} />
            )}
            {colored.map((s) =>
              s.area ? (
                <Area key={s.key} type="monotone" dataKey={s.key} name={s.name} stroke={s.color} strokeWidth={2} fill={s.color} fillOpacity={0.12} isAnimationActive={false} connectNulls={false} dot={false} activeDot={{ r: 4, stroke: PALETTE.surface, strokeWidth: 2 }} />
              ) : (
                <Line
                  key={s.key}
                  type="monotone"
                  dataKey={s.key}
                  name={s.name}
                  stroke={s.color}
                  strokeWidth={2}
                  strokeDasharray={s.dashed ? '5 3' : undefined}
                  isAnimationActive={false}
                  connectNulls={false}
                  dot={(p: { index?: number; cx?: number; cy?: number }) =>
                    p.index === lastIdx && p.cx != null && p.cy != null ? (
                      <circle key={`${s.key}-${p.index}`} cx={p.cx} cy={p.cy} r={3.5} fill={s.color} stroke={PALETTE.surface} strokeWidth={2} />
                    ) : (
                      <g key={`${s.key}-${p.index}`} />
                    )
                  }
                  activeDot={{ r: 4, stroke: PALETTE.surface, strokeWidth: 2 }}
                />
              ),
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      {colored.length > 1 && (
        <div className="mt-1">
          <LegendKey items={[...colored.map((s) => ({ name: s.name, color: s.color, line: true })), ...(target ? [{ name: target.label, color: PALETTE.ref, line: true }] : [])]} />
        </div>
      )}
    </div>
  );
}
