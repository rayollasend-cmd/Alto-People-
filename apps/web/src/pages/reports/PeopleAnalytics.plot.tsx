import { Bar, BarChart, CartesianGrid, ComposedChart, Legend, Line, LineChart, Tooltip, XAxis, YAxis } from 'recharts';
import { ResponsiveContainer } from '@/components/ui/charts/container.plot';
import { STOCK_LEGEND, seriesColor } from '@/components/ui/charts';
import { CHART } from '@/components/ui/ChartFrame';
import type { PeopleAnalytics as PeopleAnalyticsData } from '@/lib/peopleAnalyticsApi';

/* People analytics' drawings — fetched with the first chart (lazyPlot), the only part that needs recharts. */

const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v}%`);
const axis = { fill: CHART.axis, fontSize: 11 };

/** On the books month by month: hires and leavers under the headcount line, or one line per store. */
export function HeadcountTrendPlot({
  trendBy,
  trend,
  storeTrend,
  stores,
}: {
  trendBy: 'company' | 'store';
  trend: Array<{ month: string; headcount: number; hires: number; left: number }>;
  storeTrend: Array<Record<string, string | number>>;
  stores: Array<{ storeId: string; storeName: string }>;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      {trendBy === 'company' ? (
        <ComposedChart data={trend} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={CHART.grid} vertical={false} />
          <XAxis dataKey="month" tick={axis} tickLine={false} axisLine={false} />
          <YAxis allowDecimals={false} tick={axis} tickLine={false} axisLine={false} width="auto" />
          <Tooltip contentStyle={CHART.tooltip} labelStyle={CHART.tooltipLabel} itemStyle={CHART.tooltipItem} />
          <Legend {...STOCK_LEGEND} />
          <Bar dataKey="hires" name="Hires" fill={CHART.good} radius={[3, 3, 0, 0]} />
          <Bar dataKey="left" name="Left" fill={CHART.bad} radius={[3, 3, 0, 0]} />
          <Line dataKey="headcount" name="On the books" stroke={CHART.series[0]} strokeWidth={2} dot={false} />
        </ComposedChart>
      ) : (
        <LineChart data={storeTrend} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={CHART.grid} vertical={false} />
          <XAxis dataKey="month" tick={axis} tickLine={false} axisLine={false} />
          <YAxis allowDecimals={false} tick={axis} tickLine={false} axisLine={false} width="auto" />
          <Tooltip contentStyle={CHART.tooltip} labelStyle={CHART.tooltipLabel} itemStyle={CHART.tooltipItem} />
          <Legend {...STOCK_LEGEND} />
          {/* Five hues, never a sixth: the rest draw thin in "Other" gray, off the legend (the table names them). */}
          {stores.map((s, i) => (
            <Line key={s.storeId} dataKey={s.storeName} stroke={i < 5 ? seriesColor(i) : CHART.other} strokeWidth={i < 5 ? 2 : 1} dot={false} legendType={i < 5 ? undefined : 'none'} />
          ))}
        </LineChart>
      )}
    </ResponsiveContainer>
  );
}

/**
 * Legend order for the survival chart: the cohorts' own order (oldest
 * first), never recharts 3's default alphabetical sort ("Apr, Aug, Jun,
 * Oct, Sep" — LEAD-31). Exported for the test.
 */
export function cohortLegendSorter(cohorts: ReadonlyArray<{ dataKey: string }>): (item: { dataKey?: unknown; value?: unknown }) => number {
  const order = new Map(cohorts.map((c, i) => [c.dataKey, i]));
  return (item) => order.get(String(item.dataKey ?? item.value ?? '')) ?? cohorts.length;
}

/** The first 90 days: one line per hiring month (`dataKey` is the month's label, oldest first). */
export function SurvivalPlot({ rows, cohorts }: { rows: Array<Record<string, string | number | null>>; cohorts: Array<{ month: string; dataKey: string }> }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={CHART.grid} vertical={false} />
        <XAxis dataKey="day" tick={axis} tickLine={false} axisLine={false} interval={2} />
        <YAxis domain={[0, 100]} tickFormatter={(v: number) => `${v}%`} tick={axis} tickLine={false} axisLine={false} width="auto" />
        <Tooltip contentStyle={CHART.tooltip} labelStyle={CHART.tooltipLabel} itemStyle={CHART.tooltipItem} formatter={(v) => pct(v as number | null)} />
        {/* Every month the chart draws is named, in calendar order (the table twin lists the same months). */}
        <Legend {...STOCK_LEGEND} itemSorter={cohortLegendSorter(cohorts)} />
        {/* The five most recent hiring months in color; an older one thin, gray and dashed — still in the legend. */}
        {cohorts.map((c, i, all) => {
          const rank = all.length - 1 - i;
          return (
            <Line
              key={c.month}
              dataKey={c.dataKey}
              stroke={rank < 5 ? seriesColor(rank) : CHART.other}
              strokeWidth={rank < 5 ? 2 : 1}
              strokeDasharray={rank < 5 ? undefined : '4 3'}
              dot={false}
              connectNulls={false}
            />
          );
        })}
      </LineChart>
    </ResponsiveContainer>
  );
}

/** Annualized turnover, one bar per tenure band. */
export function TenureTurnoverPlot({ data }: { data: PeopleAnalyticsData['turnover']['byTenure'] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={CHART.grid} vertical={false} />
        <XAxis dataKey="label" tick={axis} tickLine={false} axisLine={false} />
        <YAxis tickFormatter={(v: number) => `${v}%`} tick={axis} tickLine={false} axisLine={false} width="auto" />
        <Tooltip contentStyle={CHART.tooltip} labelStyle={CHART.tooltipLabel} itemStyle={CHART.tooltipItem} formatter={(v) => pct(v as number | null)} />
        <Bar dataKey="annualizedTurnoverPct" name="Annualized turnover" fill={CHART.series[0]} radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Median days to fill, one bar per client (or department). */
export function TimeToFillPlot({ data }: { data: Array<{ label: string; medianDays: number | null }> }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart layout="vertical" data={data} margin={{ top: 4, right: 16, bottom: 0, left: 8 }}>
        <CartesianGrid stroke={CHART.grid} horizontal={false} />
        <XAxis type="number" tick={axis} tickLine={false} axisLine={false} />
        <YAxis type="category" dataKey="label" width={120} tick={axis} tickLine={false} axisLine={false} />
        <Tooltip contentStyle={CHART.tooltip} labelStyle={CHART.tooltipLabel} itemStyle={CHART.tooltipItem} />
        <Bar dataKey="medianDays" name="Median days" fill={CHART.series[1]} radius={[0, 3, 3, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

/** The absence rate, month by month. */
export function AbsencePlot({ data }: { data: Array<{ month: string; rate: number | null }> }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={CHART.grid} vertical={false} />
        <XAxis dataKey="month" tick={axis} tickLine={false} axisLine={false} />
        <YAxis tickFormatter={(v: number) => `${v}%`} tick={axis} tickLine={false} axisLine={false} width="auto" />
        <Tooltip contentStyle={CHART.tooltip} labelStyle={CHART.tooltipLabel} itemStyle={CHART.tooltipItem} formatter={(v) => pct(v as number | null)} />
        <Line dataKey="rate" name="Absence rate" stroke={CHART.warn} strokeWidth={2} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

/** Median days to fill, one bar per position, slowest first. */
export function SlowestPositionsPlot({ data }: { data: Array<{ label: string; medianDays: number | null }> }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart layout="vertical" data={data} margin={{ top: 4, right: 16, bottom: 0, left: 8 }}>
        <CartesianGrid stroke={CHART.grid} horizontal={false} />
        <XAxis type="number" tick={axis} tickLine={false} axisLine={false} />
        <YAxis type="category" dataKey="label" width={160} tick={axis} tickLine={false} axisLine={false} />
        <Tooltip contentStyle={CHART.tooltip} labelStyle={CHART.tooltipLabel} itemStyle={CHART.tooltipItem} />
        <Bar dataKey="medianDays" name="Median days" fill={CHART.series[2]} radius={[0, 3, 3, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
