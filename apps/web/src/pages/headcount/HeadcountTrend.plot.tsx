import { Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { fmtSignedAxis } from '@/components/ui/charts/axes';
import { PALETTE, TICK, TOOLTIP_LABEL_STYLE, TOOLTIP_STYLE } from '@/components/ui/charts/palette';

type Row = { month: string; headcount: number; hires: number; separations: number };

/** The smallest 1-2-5 step at least `x` (never below one person). */
function niceStep(x: number): number {
  if (!(x > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(x));
  for (const m of [1, 2, 5, 10]) if (m * p >= x) return Math.max(1, m * p);
  return Math.max(1, 10 * p);
}

/**
 * The two axes on one grid with their zeros on the same line (F500 audit
 * 2026-10-26: the employed line's 0 sat a row below the bars' 0, and the
 * separations axis read "4" under zero). Both axes take the same number of
 * steps below and above zero; the employed axis just never labels a step
 * below it — there is no negative headcount.
 */
export function alignedAxes(rows: Row[]): { flow: number[]; count: number[] } {
  const up = Math.max(0, ...rows.map((r) => r.hires));
  const down = Math.max(0, ...rows.map((r) => -r.separations));
  const employed = Math.max(0, ...rows.map((r) => r.headcount));
  const step = niceStep(Math.max(up, down, 1) / 3);
  const nUp = Math.max(1, Math.ceil(up / step));
  const nDown = Math.ceil(down / step);
  const cStep = niceStep(Math.max(employed, 1) / nUp);
  const ticks = (s: number) => Array.from({ length: nDown + nUp + 1 }, (_, i) => (i - nDown) * s);
  return { flow: ticks(step), count: ticks(cStep) };
}

/** Headcount's month-by-month drawing — fetched with the chart (lazyPlot), the only part that needs recharts. */
export function HeadcountTrendPlot({ rows }: { rows: Row[] }) {
  const { flow, count } = alignedAxes(rows);
  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} stackOffset="sign">
        <CartesianGrid stroke={PALETTE.grid} vertical={false} />
        <XAxis dataKey="month" tick={TICK} tickLine={false} axisLine={false} />
        <YAxis
          yAxisId="flow"
          tick={TICK}
          tickLine={false}
          axisLine={false}
          width={48}
          allowDecimals={false}
          ticks={flow}
          domain={[flow[0]!, flow[flow.length - 1]!]}
          interval={0}
          tickFormatter={(v: number) => fmtSignedAxis(v)}
          label={{ value: 'Hires · separations', angle: -90, position: 'insideLeft', style: { ...TICK, textAnchor: 'middle' } }}
        />
        <YAxis
          yAxisId="count"
          orientation="right"
          tick={TICK}
          tickLine={false}
          axisLine={false}
          width={56}
          allowDecimals={false}
          ticks={count}
          domain={[count[0]!, count[count.length - 1]!]}
          interval={0}
          tickFormatter={(v: number) => (v < 0 ? '' : v.toLocaleString('en-US'))}
          label={{ value: 'Employed', angle: 90, position: 'insideRight', style: { ...TICK, textAnchor: 'middle' } }}
        />
        <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL_STYLE} cursor={{ fill: PALETTE.cursor }} formatter={(v) => Math.abs(Number(v)).toLocaleString('en-US')} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar yAxisId="flow" dataKey="hires" name="Hires" stackId="flow" fill={PALETTE.good} radius={[3, 3, 0, 0]} maxBarSize={24} />
        <Bar yAxisId="flow" dataKey="separations" name="Separations" stackId="flow" fill={PALETTE.bad} radius={[0, 0, 3, 3]} maxBarSize={24} />
        <Line yAxisId="count" dataKey="headcount" name="Employed" stroke={PALETTE.series[0]} strokeWidth={2} dot={false} type="stepAfter" />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
