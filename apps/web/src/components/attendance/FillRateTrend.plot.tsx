import { CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ChartTooltipContent, PALETTE, TICK } from '@/components/ui/charts';

/** FillRateTrendCard's drawing — fetched with the first chart (lazyPlot), the only part that needs recharts. */
export function FillRateTrendPlot({
  data,
  floor,
  fillTargetPct,
  fillName,
  heading,
  targetLabel,
  noShiftsText,
}: {
  data: Array<{ week: string; fill: number | null; partial: boolean; noShifts: number | null }>;
  floor: number;
  fillTargetPct: number;
  fillName: string;
  heading: (label: string) => string;
  targetLabel: string;
  noShiftsText: string;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart data={data} margin={{ top: 12, right: 12, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={PALETTE.grid} vertical={false} />
        <XAxis dataKey="week" tick={TICK} tickLine={false} axisLine={{ stroke: PALETTE.grid }} minTickGap={12} />
        {/* The target is always on the scale, however the weeks went. */}
        <YAxis domain={[floor, 100]} tick={TICK} tickLine={false} axisLine={false} width={44} tickFormatter={(v: number) => `${v}%`} />
        <Tooltip
          cursor={{ stroke: PALETTE.ref, strokeWidth: 1 }}
          content={
            <ChartTooltipContent
              series={{ fill: { name: fillName, color: PALETTE.primary } }}
              format={(v) => `${v}%`}
              heading={heading}
            />
          }
        />
        <ReferenceLine y={fillTargetPct} ifOverflow="extendDomain" stroke={PALETTE.ref} strokeDasharray="4 3" label={{ value: targetLabel, position: 'insideBottomRight', fill: TICK.fill, fontSize: 10 }} />
        {/* A line, not a filled area (two points with a fill read as a bar).
            Every week with data carries a dot; the week in progress is a
            hollow dot at full contrast, so its "so far" value is findable;
            a week with nothing scheduled says so at the foot of the axis. */}
        <Line
          type="linear"
          dataKey="fill"
          name={fillName}
          connectNulls={false}
          stroke={PALETTE.primary}
          strokeWidth={2}
          isAnimationActive={false}
          activeDot={{ r: 5, stroke: PALETTE.surface, strokeWidth: 2 }}
          dot={(props: { cx?: number; cy?: number; index?: number; payload?: { partial?: boolean; fill: number | null } }) => {
            const { cx, cy, index, payload } = props;
            const key = `dot-${index ?? 0}`;
            // No shifts that week: no dot (the "no shifts" mark below says so).
            if (cx === undefined || cy === undefined || payload?.fill === null || payload?.fill === undefined) return <g key={key} />;
            return payload.partial ? (
              <circle key={key} data-testid="fill-dot-partial" cx={cx} cy={cy} r={4.5} fill={PALETTE.surface} stroke={PALETTE.primary} strokeWidth={2} />
            ) : (
              <circle key={key} data-testid="fill-dot" cx={cx} cy={cy} r={3.5} fill={PALETTE.primary} />
            );
          }}
        />
        <Line
          type="linear"
          dataKey="noShifts"
          stroke="none"
          isAnimationActive={false}
          legendType="none"
          activeDot={false}
          dot={(props: { cx?: number; cy?: number; index?: number; payload?: { noShifts?: number | null } }) => {
            const { cx, cy, index, payload } = props;
            if (cx === undefined || cy === undefined || payload?.noShifts == null) return <g key={`ns-${index ?? 0}`} />;
            // The first and last weeks sit on the plot's edges: anchor their
            // mark inward so it is never cut ("no shif").
            const anchor = index === 0 ? 'start' : index === data.length - 1 ? 'end' : 'middle';
            return (
              <text key={`ns-${index ?? 0}`} data-testid="fill-no-shifts" x={cx} y={cy - 6} textAnchor={anchor} fontSize={10} fill={TICK.fill}>
                {noShiftsText}
              </text>
            );
          }}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
