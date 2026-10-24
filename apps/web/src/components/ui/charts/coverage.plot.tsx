import type { ComponentProps } from 'react';
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  LabelList,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ChartTooltipContent as PortalTooltip } from './ChartTooltip';
import { CONCEPT, PALETTE, TICK as BASE_TICK } from './palette';
import type { CoverageCurve, HourPoint, HoursChart, ReliabilityChart, StoreBarChart, WeekFillChart } from './coverage';

/**
 * The staffing charts' drawings (coverage.tsx) — fetched with the first
 * chart (lazyPlot), the only part that needs recharts. The y-domains come
 * in as props (coverageDomain stays in coverage.tsx).
 */

const SERIES = { primary: PALETTE.primary } as const;
const STATUS = { good: PALETTE.good, bad: PALETTE.bad } as const;
const SURFACE = PALETTE.surface;
const GRID = PALETTE.grid;
const TICK = { ...BASE_TICK, fontSize: 10 } as const;
const REF = PALETTE.ref;

/*
 * Axes. These charts used a -18px left margin with a 36px y-axis, which cut
 * every tick wider than two characters ("100%" read "%", "24h" read "4h").
 * The plot now starts at the card's edge and the y-axis sizes itself to its
 * widest tick.
 */
const MARGIN = { top: 12, right: 12, bottom: 0, left: 0 } as const;
const Y_WIDTH = 'auto' as const;

/* ---- Coverage curve ----------------------------------------------------- */

type CurveProps = ComponentProps<typeof CoverageCurve>;

export function CoverageCurvePlot({
  points,
  target,
  nowLabel,
  labels,
  bands,
  domain,
}: {
  points: HourPoint[];
  target: number | null;
  nowLabel: string | undefined;
  labels: CurveProps['labels'];
  bands: NonNullable<CurveProps['bands']>;
  domain: [number, number];
}) {
  // A wrapping window (10p–6a) is two spans on a midnight-to-midnight axis.
  // The name rides the wider half, so a 10p start doesn't clip it.
  const spans = bands.flatMap((b) => {
    const from = Math.floor(b.startMinute / 60);
    const to = Math.ceil(b.endMinute / 60);
    if (to > from) return [{ from, to, label: b.label }];
    const lateWider = 24 - from >= to;
    return [
      { from, to: 24, label: lateWider ? b.label : '' },
      { from: 0, to, label: lateWider ? '' : b.label },
    ];
  });
  const at = (h: number) => points[Math.min(Math.max(h, 0), points.length - 1)]?.label;
  const series = {
    scheduled: { name: labels.scheduled, color: CONCEPT.scheduled },
    open: { name: labels.open, color: CONCEPT.unfilled },
  };
  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart accessibilityLayer={false} data={points} margin={MARGIN}>
        <CartesianGrid stroke={GRID} strokeWidth={1} vertical={false} />
        <XAxis
          dataKey="label"
          tick={TICK}
          axisLine={{ stroke: GRID }}
          tickLine={false}
          interval={2}
        />
        <YAxis
          tick={TICK}
          axisLine={false}
          tickLine={false}
          allowDecimals={false}
          domain={domain}
          allowDataOverflow
          width={Y_WIDTH}
        />
        <ChartTooltip
          cursor={{ stroke: REF, strokeWidth: 1 }}
          content={<PortalTooltip series={series} heading={(l) => labels.at(l)} />}
        />
        <Area
          type="stepAfter"
          dataKey="scheduled"
          stackId="a"
          stroke={CONCEPT.scheduled}
          strokeWidth={2}
          fill={CONCEPT.scheduled}
          fillOpacity={0.12}
          isAnimationActive={false}
          dot={false}
          activeDot={{ r: 4, stroke: SURFACE, strokeWidth: 2 }}
        />
        {/* Unfilled slots sit on top of the scheduled stack as a fill with no
            stroke: an outline at zero height painted a red line over the gold one
            and made a fully covered day read as unfilled (walk 2026-10-15). */}
        <Area
          type="stepAfter"
          dataKey="open"
          stackId="a"
          stroke={CONCEPT.unfilled}
          strokeWidth={0}
          fill={CONCEPT.unfilled}
          fillOpacity={0.35}
          isAnimationActive={false}
          dot={false}
          activeDot={{ r: 4, stroke: SURFACE, strokeWidth: 2 }}
        />
        {spans.map((sp, i) =>
          sp.to > sp.from && at(sp.from) ? (
            <ReferenceArea
              key={i}
              x1={at(sp.from)}
              x2={at(sp.to === 24 ? 23 : sp.to)}
              fill="rgb(var(--color-gold) / 0.10)"
              stroke="rgb(var(--color-gold) / 0.35)"
              strokeDasharray="2 3"
              ifOverflow="extendDomain"
              label={
                sp.label
                  ? { value: sp.label, position: 'insideTopLeft', fill: 'rgb(var(--color-gold) / 0.9)', fontSize: 10 }
                  : undefined
              }
            />
          ) : null,
        )}
        {target !== null && (
          <ReferenceLine
            y={target}
            stroke={CONCEPT.target}
            strokeDasharray="4 3"
            ifOverflow="extendDomain"
            label={{
              value: `${labels.contracted} ${target}`,
              position: 'insideTopRight',
              fill: 'rgb(var(--color-silver) / 0.8)',
              fontSize: 10,
            }}
          />
        )}
        {nowLabel && (
          <ReferenceLine
            x={nowLabel}
            stroke="rgb(var(--color-fg) / 0.6)"
            strokeWidth={1}
            ifOverflow="extendDomain"
            label={{
              value: labels.now,
              position: 'top',
              fill: 'rgb(var(--color-fg) / 0.8)',
              fontSize: 10,
            }}
          />
        )}
      </ComposedChart>
    </ResponsiveContainer>
  );
}

/* ---- Week fill ---------------------------------------------------------- */

type WeekFillProps = ComponentProps<typeof WeekFillChart>;

export function WeekFillPlot({ days, todayKey, labels, domain }: WeekFillProps & { domain: [number, number] }) {
  const series = {
    filled: { name: labels.filled, color: CONCEPT.scheduled },
    open: { name: labels.open, color: CONCEPT.unfilled },
  };
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart accessibilityLayer={false} data={days} margin={{ ...MARGIN, top: 8, right: 4 }} barCategoryGap="30%">
        <CartesianGrid stroke={GRID} strokeWidth={1} vertical={false} />
        <XAxis
          dataKey="day"
          tick={TICK}
          axisLine={{ stroke: GRID }}
          tickLine={false}
        />
        <YAxis tick={TICK} axisLine={false} tickLine={false} allowDecimals={false} domain={domain} allowDataOverflow width={Y_WIDTH} />
        <ChartTooltip
          cursor={{ fill: 'rgb(var(--color-navy-secondary) / 0.35)' }}
          content={<PortalTooltip series={series} heading={(l) => labels.heading(l)} />}
        />
        <Bar
          dataKey="filled"
          stackId="a"
          fill={CONCEPT.scheduled}
          stroke={SURFACE}
          strokeWidth={2}
          maxBarSize={24}
          isAnimationActive={false}
        >
          {days.map((d) => (
            <Cell key={d.date} fillOpacity={d.date === todayKey ? 1 : 0.75} />
          ))}
        </Bar>
        <Bar
          dataKey="open"
          stackId="a"
          fill={CONCEPT.unfilled}
          stroke={SURFACE}
          strokeWidth={0}
          maxBarSize={24}
          radius={[4, 4, 0, 0]}
          isAnimationActive={false}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}

/* ---- Reliability -------------------------------------------------------- */

export function ReliabilityPlot({ weeks, labels }: ComponentProps<typeof ReliabilityChart>) {
  const series = { pct: { name: labels.fill, color: SERIES.primary } };
  // A 0% week drew nothing at all; the value label makes four zero weeks visibly zero.
  const data = weeks.map((w) => ({ ...w, pct: w.reliabilityPct, text: w.reliabilityPct === null ? '' : `${w.reliabilityPct}%` }));
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart accessibilityLayer={false} data={data} margin={{ ...MARGIN, top: 16, right: 4 }} barCategoryGap="35%">
        <CartesianGrid stroke={GRID} strokeWidth={1} vertical={false} />
        <XAxis dataKey="label" tick={TICK} axisLine={{ stroke: GRID }} tickLine={false} />
        <YAxis
          tick={TICK}
          axisLine={false}
          tickLine={false}
          domain={[0, 100]}
          ticks={[0, 50, 100]}
          width={Y_WIDTH}
          tickFormatter={(v: number) => `${v}%`}
        />
        <ChartTooltip
          cursor={{ fill: 'rgb(var(--color-navy-secondary) / 0.35)' }}
          content={
            <PortalTooltip
              series={series}
              heading={(l) => labels.heading(l)}
              format={(v) => `${v}%`}
            />
          }
        />
        <ReferenceLine
          y={88}
          stroke={REF}
          strokeDasharray="4 3"
          label={{
            value: labels.target,
            position: 'insideTopRight',
            fill: 'rgb(var(--color-silver) / 0.8)',
            fontSize: 10,
          }}
        />
        <Bar
          dataKey="pct"
          fill={SERIES.primary}
          // A 0% week draws a hairline (and its label) instead of nothing; a week with no data stays empty.
          minPointSize={(v) => (v == null ? 0 : 2)}
          maxBarSize={24}
          radius={[4, 4, 0, 0]}
          isAnimationActive={false}
        >
          {data.map((w) => (
            <Cell key={w.start} fillOpacity={w.current ? 0.45 : 1} />
          ))}
          <LabelList dataKey="text" position="top" style={{ fill: TICK.fill, fontSize: 10 }} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/* ---- Hours -------------------------------------------------------------- */

export function HoursPlot({ days, labels, domain }: ComponentProps<typeof HoursChart> & { domain: [number, number] }) {
  // Scheduled is the primary series in every staffing chart; delivered the second.
  const series = {
    scheduledHours: { name: labels.scheduled, color: CONCEPT.scheduled },
    workedHours: { name: labels.worked, color: CONCEPT.delivered },
  };
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart accessibilityLayer={false} data={days} margin={{ ...MARGIN, top: 8, right: 4 }} barCategoryGap="25%" barGap={2}>
        <CartesianGrid stroke={GRID} strokeWidth={1} vertical={false} />
        <XAxis dataKey="day" tick={TICK} axisLine={{ stroke: GRID }} tickLine={false} />
        <YAxis tick={TICK} axisLine={false} tickLine={false} width={Y_WIDTH} domain={domain} allowDataOverflow tickFormatter={(v: number) => `${v}h`} />
        <ChartTooltip
          cursor={{ fill: 'rgb(var(--color-navy-secondary) / 0.35)' }}
          content={
            <PortalTooltip
              series={series}
              heading={(l) => labels.heading(l)}
              format={(v) => `${Math.round(v * 10) / 10}h`}
            />
          }
        />
        <Bar dataKey="scheduledHours" fill={CONCEPT.scheduled} maxBarSize={16} radius={[4, 4, 0, 0]} isAnimationActive={false} />
        <Bar dataKey="workedHours" fill={CONCEPT.delivered} maxBarSize={16} radius={[4, 4, 0, 0]} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}

/* ---- Stores side by side ------------------------------------------------ */

export function StoreBarPlot({ rows, labels }: ComponentProps<typeof StoreBarChart>) {
  const series = { value: { name: labels.value, color: SERIES.primary } };
  // At 0% a store drew no bar at all; the printed value says "0%" (and "—" for no data).
  const data = rows.map((r) => ({ ...r, value: r.value ?? 0, text: r.value === null ? '—' : `${r.value}%` }));
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart accessibilityLayer={false} data={data} layout="vertical" margin={{ top: 4, right: 36, bottom: 0, left: 4 }} barCategoryGap="30%">
        <CartesianGrid stroke={GRID} strokeWidth={1} horizontal={false} />
        <XAxis
          type="number"
          domain={[0, 100]}
          ticks={[0, 50, 100]}
          tick={TICK}
          axisLine={{ stroke: GRID }}
          tickLine={false}
          tickFormatter={(v: number) => `${v}%`}
        />
        <YAxis type="category" dataKey="name" tick={{ ...TICK, fontSize: 11 }} axisLine={false} tickLine={false} width={120} />
        <ChartTooltip
          cursor={{ fill: 'rgb(var(--color-navy-secondary) / 0.35)' }}
          content={<PortalTooltip series={series} heading={(l) => labels.heading(l)} format={(v) => `${v}%`} />}
        />
        <ReferenceLine
          x={88}
          stroke={REF}
          strokeDasharray="4 3"
          label={{ value: labels.target, position: 'insideTopRight', fill: 'rgb(var(--color-silver) / 0.8)', fontSize: 10 }}
        />
        <Bar dataKey="value" fill={SERIES.primary} maxBarSize={18} radius={[0, 4, 4, 0]} minPointSize={2} isAnimationActive={false}>
          {data.map((r) => (
            <Cell
              key={r.id}
              fill={r.value >= 88 ? STATUS.good : r.value >= 70 ? SERIES.primary : STATUS.bad}
              fillOpacity={rows.find((x) => x.id === r.id)?.value === null ? 0.25 : 1}
            />
          ))}
          <LabelList dataKey="text" position="right" style={{ fill: TICK.fill, fontSize: 10 }} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
