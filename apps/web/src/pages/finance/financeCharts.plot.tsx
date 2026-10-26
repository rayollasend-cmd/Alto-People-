import { Bar, BarChart, CartesianGrid, Cell, ComposedChart, LabelList, Line, ReferenceArea, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { fmtMoney } from '@/lib/format';
import { fmtMoneyAxis } from '@/components/ui/charts/axes';
import { ChartTooltipContent } from '@/components/ui/charts/ChartTooltip';
import { PALETTE, TICK } from '@/components/ui/charts/palette';
import type { AgingBucket, CashRow, MarginRow } from './financeCharts';

/* The finance pictures' drawings — fetched with the first one (lazyPlot), the only part that needs recharts. */

type SeriesMap = Record<string, { name: string; color: string }>;

/** CashFlowChart's drawing. */
export function CashFlowPlot({
  rows,
  compact,
  lineKey,
  low,
  series,
  colors,
  minimumCash,
}: {
  rows: CashRow[];
  compact: boolean;
  /** Null: bars only (no balance on file). */
  lineKey: 'balance' | 'cumulative' | null;
  low: CashRow | null;
  series: SeriesMap;
  colors: { in: string; out: string; run: string };
  minimumCash: number | null;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart data={rows} stackOffset="sign" margin={{ top: 8, right: 8, bottom: 0, left: compact ? 0 : 8 }}>
        <CartesianGrid stroke={PALETTE.grid} vertical={false} />
        <XAxis dataKey="week" tick={TICK} tickLine={false} axisLine={{ stroke: PALETTE.grid }} minTickGap={12} />
        <YAxis
          tick={TICK}
          tickLine={false}
          axisLine={false}
          width={compact ? 44 : 64}
          tickFormatter={fmtMoneyAxis}
          label={compact ? undefined : { value: 'Dollars', angle: -90, position: 'insideLeft', offset: 12, style: { fill: TICK.fill, fontSize: 11, textAnchor: 'middle' } }}
        />
        <Tooltip
          cursor={{ fill: PALETTE.cursor }}
          content={<ChartTooltipContent series={series} heading={(x) => `Week of ${x}`} format={(v, key) => fmtMoney(key === 'outflowNeg' ? Math.abs(v) : v)} />}
        />
        {minimumCash !== null && minimumCash > 0 && <ReferenceArea y1={0} y2={minimumCash} fill={PALETTE.warn} fillOpacity={0.08} ifOverflow="extendDomain" />}
        {minimumCash !== null && minimumCash > 0 && <ReferenceLine y={minimumCash} stroke={PALETTE.warn} strokeDasharray="4 3" ifOverflow="extendDomain" />}
        <ReferenceLine y={0} stroke={PALETTE.ref} />
        <Bar dataKey="inflow" stackId="flow" fill={colors.in} radius={[4, 4, 0, 0]} maxBarSize={compact ? 20 : 32} isAnimationActive={false} />
        <Bar dataKey="outflowNeg" stackId="flow" fill={colors.out} radius={[0, 0, 4, 4]} maxBarSize={compact ? 20 : 32} isAnimationActive={false} />
        {lineKey && <Line dataKey={lineKey} type="monotone" stroke={colors.run} strokeWidth={2} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />}
        {lineKey && low && !compact && <ReferenceDot x={low.week} y={low[lineKey]} r={5} fill={PALETTE.bad} stroke={PALETTE.surface} strokeWidth={2} ifOverflow="extendDomain" />}
      </ComposedChart>
    </ResponsiveContainer>
  );
}

/** MarginChart's drawing. */
export function MarginPlot({ rows, series }: { rows: MarginRow[]; series: { revenue: { name: string; color: string }; wages: { name: string; color: string } } }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={rows} margin={{ top: 18, right: 4, bottom: 0, left: 0 }} barCategoryGap="24%" barGap={2}>
        <CartesianGrid stroke={PALETTE.grid} vertical={false} />
        <XAxis dataKey="week" tick={{ ...TICK, fontSize: 10 }} tickLine={false} axisLine={{ stroke: PALETTE.grid }} interval={0} />
        <YAxis tick={TICK} tickLine={false} axisLine={false} width={44} tickFormatter={fmtMoneyAxis} />
        <Tooltip cursor={{ fill: PALETTE.cursor }} content={<ChartTooltipContent series={series} format={(v) => fmtMoney(v)} />} />
        <Bar dataKey="revenue" fill={series.revenue.color} radius={[4, 4, 0, 0]} maxBarSize={18} isAnimationActive={false}>
          {rows.map((r, i) => (
            <Cell key={i} fillOpacity={r.inProgress ? 0.55 : 1} />
          ))}
          <LabelList
            dataKey="pct"
            position="top"
            content={(p: { x?: number | string; y?: number | string; width?: number | string; index?: number; value?: unknown }) => {
              const r = rows[p.index ?? 0];
              if (!r) return null;
              // Under 10% margin reads as a warning, as it always has.
              const fill = r.marginPct === null ? TICK.fill : r.marginPct < 0.1 ? PALETTE.warn : PALETTE.good;
              return (
                <text x={Number(p.x) + Number(p.width) / 2} y={Number(p.y) - 4} textAnchor="middle" fill={fill} fontSize={10} fontWeight={600}>
                  {String(p.value ?? '')}
                </text>
              );
            }}
          />
        </Bar>
        <Bar dataKey="wages" fill={series.wages.color} radius={[4, 4, 0, 0]} maxBarSize={18} isAnimationActive={false}>
          {rows.map((r, i) => (
            <Cell key={i} fillOpacity={r.inProgress ? 0.55 : 1} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/** AgingBar's drawing. */
export function AgingPlot({ row, buckets, shown, colors }: { row: Record<string, number>; buckets: AgingBucket[]; shown: AgingBucket[]; colors: Record<AgingBucket['key'], string> }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart accessibilityLayer={false} data={[row]} layout="vertical" margin={{ top: 0, right: 0, bottom: 0, left: 0 }} barCategoryGap={0}>
        <XAxis type="number" hide domain={[0, 'dataMax']} />
        <YAxis type="category" hide />
        <Tooltip cursor={false} content={<ChartTooltipContent series={Object.fromEntries(buckets.map((b) => [b.key, { name: b.label, color: colors[b.key] }]))} format={(v) => fmtMoney(v)} />} />
        {shown.map((b, i) => (
          <Bar
            key={b.key}
            dataKey={b.key}
            stackId="age"
            fill={colors[b.key]}
            stroke={PALETTE.surface}
            strokeWidth={1}
            radius={shown.length === 1 ? [6, 6, 6, 6] : i === 0 ? [6, 0, 0, 6] : i === shown.length - 1 ? [0, 6, 6, 0] : [0, 0, 0, 0]}
            isAnimationActive={false}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}
