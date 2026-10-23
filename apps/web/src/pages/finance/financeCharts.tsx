import { Bar, BarChart, CartesianGrid, Cell, ComposedChart, LabelList, Line, ReferenceArea, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { fmtDateTz, fmtMoney, fmtMoneyCompact, parseYmd } from '@/lib/format';
import { ChartTooltipContent, LegendKey, PALETTE, TICK } from '@/components/ui/charts';
import type { CashWeek, MarginWeek } from './financeTypes';

/**
 * The finance pictures, on the shared chart kit's palette and tooltip:
 * cash in and out with the running total (the forecast page and the
 * cockpit card), revenue against wages with the margin on top, and the
 * receivables split by age. Each fills the box it's given.
 */

const shortDay = (ymd: string) => fmtDateTz(parseYmd(ymd) ?? ymd);

/* ---- Cash: in above the line, out below, running total over both ------- */

export const CASH_COLORS = { in: PALETTE.tertiary, out: PALETTE.series[4], run: PALETTE.primary } as const;

const CASH_SERIES = {
  inflow: { name: 'Money in', color: CASH_COLORS.in },
  outflowNeg: { name: 'Money out', color: CASH_COLORS.out },
  cumulative: { name: 'Running total', color: CASH_COLORS.run },
};

export function cashRows(weeks: CashWeek[]) {
  return weeks.map((w) => ({ week: shortDay(w.weekStart), weekStart: w.weekStart, inflow: w.inflow, outflowNeg: -w.outflow, outflow: w.outflow, net: w.net, cumulative: w.cumulative, balance: w.balance ?? w.cumulative }));
}

/**
 * Money in above the line, out below, and one line over both: the cash
 * BALANCE when the books hold one (opening + movement), else the running
 * total of movement. With a floor set, the band under it is shaded; the
 * lowest week is marked.
 */
export function CashFlowChart({ weeks, compact = false, withBalance = false, minimumCash = null }: { weeks: CashWeek[]; compact?: boolean; withBalance?: boolean; minimumCash?: number | null }) {
  const rows = cashRows(weeks);
  const lineKey = withBalance ? 'balance' : 'cumulative';
  const lineName = withBalance ? 'Cash balance' : 'Running total';
  const low = rows.length ? rows.reduce((m, r) => (r[lineKey] < m[lineKey] ? r : m), rows[0]!) : null;
  const series = { ...CASH_SERIES, [lineKey]: { name: lineName, color: CASH_COLORS.run } };
  return (
    <div className="flex h-full w-full flex-col">
      <div className="min-h-0 flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} stackOffset="sign" margin={{ top: 8, right: 8, bottom: 0, left: compact ? 0 : 8 }}>
            <CartesianGrid stroke={PALETTE.grid} vertical={false} />
            <XAxis dataKey="week" tick={TICK} tickLine={false} axisLine={{ stroke: PALETTE.grid }} minTickGap={12} />
            <YAxis
              tick={TICK}
              tickLine={false}
              axisLine={false}
              width={compact ? 44 : 64}
              tickFormatter={(v: number) => fmtMoneyCompact(v)}
              label={compact ? undefined : { value: 'Dollars', angle: -90, position: 'insideLeft', offset: 12, style: { fill: TICK.fill, fontSize: 11, textAnchor: 'middle' } }}
            />
            <Tooltip
              cursor={{ fill: PALETTE.cursor }}
              content={<ChartTooltipContent series={series} heading={(x) => `Week of ${x}`} format={(v, key) => fmtMoney(key === 'outflowNeg' ? Math.abs(v) : v)} />}
            />
            {minimumCash !== null && minimumCash > 0 && <ReferenceArea y1={0} y2={minimumCash} fill={PALETTE.warn} fillOpacity={0.08} ifOverflow="extendDomain" />}
            {minimumCash !== null && minimumCash > 0 && <ReferenceLine y={minimumCash} stroke={PALETTE.warn} strokeDasharray="4 3" ifOverflow="extendDomain" />}
            <ReferenceLine y={0} stroke={PALETTE.ref} />
            <Bar dataKey="inflow" stackId="flow" fill={CASH_COLORS.in} radius={[4, 4, 0, 0]} maxBarSize={compact ? 20 : 32} isAnimationActive={false} />
            <Bar dataKey="outflowNeg" stackId="flow" fill={CASH_COLORS.out} radius={[0, 0, 4, 4]} maxBarSize={compact ? 20 : 32} isAnimationActive={false} />
            <Line dataKey={lineKey} type="monotone" stroke={CASH_COLORS.run} strokeWidth={2} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
            {low && !compact && <ReferenceDot x={low.week} y={low[lineKey]} r={5} fill={PALETTE.bad} stroke={PALETTE.surface} strokeWidth={2} ifOverflow="extendDomain" />}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-1">
        <LegendKey
          items={[
            { name: 'Money in', color: CASH_COLORS.in },
            { name: 'Money out', color: CASH_COLORS.out },
            { name: lineName, color: CASH_COLORS.run, line: true },
            ...(low && !compact ? [{ name: 'Low point', color: PALETTE.bad }] : []),
            ...(minimumCash !== null && minimumCash > 0 ? [{ name: 'Under the cash floor', color: PALETTE.warn }] : []),
          ]}
        />
      </div>
    </div>
  );
}

/* ---- Revenue and wages, week by week, the margin printed on top -------- */

const MARGIN_SERIES = {
  revenue: { name: 'Revenue', color: PALETTE.primary },
  wages: { name: 'Wages', color: PALETTE.other },
};

export function MarginChart({ weeks, words }: { weeks: MarginWeek[]; words: { revenue: string; wages: string; soFar: string } }) {
  const rows = weeks.map((w) => ({
    week: w.inProgress ? words.soFar : shortDay(w.weekEnd),
    revenue: w.revenue,
    wages: w.wages,
    pct: w.marginPct === null ? '—' : `${Math.round(w.marginPct * 100)}%`,
    marginPct: w.marginPct,
    inProgress: w.inProgress,
  }));
  const series = { revenue: { ...MARGIN_SERIES.revenue, name: words.revenue }, wages: { ...MARGIN_SERIES.wages, name: words.wages } };
  return (
    <div className="flex h-full w-full flex-col">
      <div className="min-h-0 flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ top: 18, right: 4, bottom: 0, left: 0 }} barCategoryGap="24%" barGap={2}>
            <CartesianGrid stroke={PALETTE.grid} vertical={false} />
            <XAxis dataKey="week" tick={{ ...TICK, fontSize: 10 }} tickLine={false} axisLine={{ stroke: PALETTE.grid }} interval={0} />
            <YAxis tick={TICK} tickLine={false} axisLine={false} width={44} tickFormatter={(v: number) => fmtMoneyCompact(v)} />
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
      </div>
      <div className="mt-1">
        <LegendKey items={[{ name: words.revenue, color: series.revenue.color }, { name: words.wages, color: series.wages.color }]} />
      </div>
    </div>
  );
}

/* ---- Receivables by age: one bar, not yet due to 90+ ------------------- */

/** The one aging definition's buckets (days past due), one color each. */
export const AGING_COLORS = { current: PALETTE.good, days1to30: 'rgb(var(--color-warning) / 0.6)', days31to60: PALETTE.warn, days61to90: 'rgb(var(--color-alert) / 0.6)', over90: PALETTE.bad } as const;

export function AgingBar({ buckets }: { buckets: Array<{ key: keyof typeof AGING_COLORS; label: string; amount: number }> }) {
  const row = Object.fromEntries(buckets.map((b) => [b.key, b.amount]));
  const shown = buckets.filter((b) => b.amount > 0);
  // A picture of the numbers printed beside it — its callers hide it
  // (aria-hidden) or label it (role="img"), so recharts' keyboard layer
  // (a tab stop on the svg) is off: a focusable inside aria-hidden is a
  // serious axe finding (finance home, 2026-10-23).
  return (
    <div className="h-3 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart accessibilityLayer={false} data={[row]} layout="vertical" margin={{ top: 0, right: 0, bottom: 0, left: 0 }} barCategoryGap={0}>
          <XAxis type="number" hide domain={[0, 'dataMax']} />
          <YAxis type="category" hide />
          <Tooltip cursor={false} content={<ChartTooltipContent series={Object.fromEntries(buckets.map((b) => [b.key, { name: b.label, color: AGING_COLORS[b.key] }]))} format={(v) => fmtMoney(v)} />} />
          {shown.map((b, i) => (
            <Bar
              key={b.key}
              dataKey={b.key}
              stackId="age"
              fill={AGING_COLORS[b.key]}
              stroke={PALETTE.surface}
              strokeWidth={1}
              radius={shown.length === 1 ? [6, 6, 6, 6] : i === 0 ? [6, 0, 0, 6] : i === shown.length - 1 ? [0, 6, 6, 0] : [0, 0, 0, 0]}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
