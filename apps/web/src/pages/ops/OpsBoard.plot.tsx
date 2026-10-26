import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceArea,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { PALETTE, TICK, TOOLTIP_STYLE, TOOLTIP_LABEL_STYLE, TOOLTIP_ITEM_STYLE, dateTicks } from '@/components/ui/charts';
import type { getOpsInsights } from '@/lib/opsApi';

/* The ops board's drawn picture — fetched with the first chart (lazyPlot), the only part that needs recharts. */

type Insights = Awaited<ReturnType<typeof getOpsInsights>>;

/** Temperature watch: every reading in 24h against the safe bands. */
export function TempWatchPlot({ tempSeries }: { tempSeries: Insights['tempSeries'] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <ScatterChart margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={PALETTE.grid} />
        <XAxis
          dataKey="ts"
          type="number"
          domain={['dataMin', 'dataMax']}
          tick={false}
          axisLine={{ stroke: PALETTE.grid }}
        />
        <YAxis
          dataKey="value"
          type="number"
          tick={{ fill: TICK.fill, fontSize: 10 }}
          axisLine={false}
          tickLine={false}
          width="auto"
          unit="°"
        />
        {/* Freezer + cooler safe bands, painted behind. */}
        <ReferenceArea
          y1={-10}
          y2={10}
          fill="rgb(var(--color-teal) / 0.08)"
          stroke="none"
        />
        <ReferenceArea
          y1={33}
          y2={41}
          fill="rgb(var(--color-teal) / 0.08)"
          stroke="none"
        />
        <Tooltip
          cursor={{ stroke: PALETTE.ref }}
          contentStyle={TOOLTIP_STYLE}
          labelStyle={TOOLTIP_LABEL_STYLE}
          itemStyle={TOOLTIP_ITEM_STYLE}
          formatter={(value) => [`${String(value)}°F`, 'reading']}
          labelFormatter={() => ''}
        />
        <Scatter
          data={tempSeries.map((t) => ({
            ...t,
            ts: new Date(t.at).getTime(),
          }))}
        >
          {tempSeries.map((t, i) => (
            <Cell
              key={i}
              fill={
                t.out
                  ? PALETTE.bad
                  : PALETTE.tertiary
              }
            />
          ))}
        </Scatter>
      </ScatterChart>
    </ResponsiveContainer>
  );
}

/** The day's rhythm: checklist completions per hour. */
export function FloorRhythmPlot({ hourly }: { hourly: Insights['hourly'] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart
        data={hourly}
        margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
      >
        <CartesianGrid
          stroke={PALETTE.grid}
          vertical={false}
        />
        <XAxis
          dataKey="hour"
          tick={{ fill: TICK.fill, fontSize: 9 }}
          interval={3}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          tick={{ fill: TICK.fill, fontSize: 10 }}
          axisLine={false}
          tickLine={false}
          allowDecimals={false}
          width="auto"
        />
        <Tooltip
          cursor={{ fill: PALETTE.cursor }}
          contentStyle={TOOLTIP_STYLE}
          labelStyle={TOOLTIP_LABEL_STYLE}
          itemStyle={TOOLTIP_ITEM_STYLE}
          formatter={(value) => [`${String(value)} tasks`, 'completed']}
        />
        <Bar
          dataKey="count"
          radius={[3, 3, 0, 0]}
          fill={PALETTE.primary}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}

/** SOP compliance over the board's last 7 store days. */
export function SopWeekPlot({ sopWeek }: { sopWeek: Array<{ dateKey: string; pct: number | null }> }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart
        data={sopWeek}
        margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
      >
        <defs>
          <linearGradient id="sopFill" x1="0" y1="0" x2="0" y2="1">
            <stop
              offset="0%"
              stopColor={PALETTE.good}
              stopOpacity={0.35}
            />
            <stop
              offset="100%"
              stopColor={PALETTE.good}
              stopOpacity={0}
            />
          </linearGradient>
        </defs>
        <CartesianGrid
          stroke={PALETTE.grid}
          vertical={false}
        />
        <XAxis
          dataKey="dateKey"
          tickFormatter={dateTicks('day')}
          tick={{ fill: TICK.fill, fontSize: 9 }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          domain={[0, 100]}
          ticks={[0, 50, 100]}
          tick={{ fill: TICK.fill, fontSize: 10 }}
          axisLine={false}
          tickLine={false}
          width="auto"
          unit="%"
        />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          labelStyle={TOOLTIP_LABEL_STYLE}
          itemStyle={TOOLTIP_ITEM_STYLE}
          formatter={(value) => [`${String(value)}%`, 'Checklist completion']}
        />
        <Area
          type="linear"
          dot={{ r: 3, fill: PALETTE.good, strokeWidth: 0 }}
          dataKey="pct"
          stroke={PALETTE.good}
          strokeWidth={2}
          fill="url(#sopFill)"
          connectNulls
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
