import { Area, CartesianGrid, ComposedChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { CalendarCheck } from 'lucide-react';
import { ChartFrame } from '@/components/ui/ChartFrame';
import { ChartTooltipContent, PALETTE, TICK } from '@/components/ui/charts';
import { EmptyState } from '@/components/ui/EmptyState';
import { QueryError } from '@/components/ui/QueryError';
import { Skeleton } from '@/components/ui/Skeleton';
import { useAttendanceTrends } from './AttendanceTrendTiles';
import { weekLabel, weekOf } from './weekLabel';

/**
 * Fill rate, week by week for eight workweeks, against the 95% line the
 * store is graded on — the last point is the week in progress. A week
 * with nothing scheduled is a gap, and only real weeks carry a dot.
 */
export function FillRateTrendCard({ siteId, className }: { siteId?: string; className?: string }) {
  const q = useAttendanceTrends({ siteId });
  if (q.isPending) return <Skeleton className={className ?? 'h-72'} />;
  if (q.isError) return <QueryError what="the fill-rate trend" query={q} />;
  const { weeks, fillTargetPct } = q.data;
  // Every week stays on the axis: a week with nothing scheduled is a gap
  // in the line, never a slope drawn across it.
  const all = weeks.map((w) => ({ week: weekLabel(w.weekStart), weekStart: w.weekStart, fill: w.fillRatePct, filled: w.filledShifts, scheduled: w.scheduledShifts, inProgress: w.inProgress ? 'yes' : '' }));
  const rows = all.filter((r) => r.fill !== null);
  const lowest = rows.reduce((m, r) => Math.min(m, r.fill ?? 100), 100);
  const floor = Math.max(0, Math.min(80, Math.floor((lowest - 5) / 10) * 10));
  const met = rows.filter((r) => (r.fill ?? 0) >= fillTargetPct).length;
  const latest = rows[rows.length - 1];
  const gaps = all.length - rows.length;
  const summary =
    rows.length === 0
      ? 'Nothing scheduled in the last eight weeks.'
      : `Fill rate met the ${fillTargetPct}% target in ${met} of ${rows.length} weeks with shifts; ${latest!.inProgress ? 'this week so far' : 'the latest week'} is ${latest!.fill}%.${gaps > 0 ? ` ${gaps} ${gaps === 1 ? 'week had' : 'weeks had'} nothing scheduled.` : ''}`;

  // Nothing in eight weeks: one line, not an empty chart.
  if (rows.length === 0) {
    return (
      <div className={className}>
        <p className="rounded-lg border border-line px-4 py-3 text-sm text-ink-muted">Fill rate · 8 weeks — nothing scheduled yet; the line starts with the first published week.</p>
      </div>
    );
  }
  return (
    <div className={className}>
      <ChartFrame
        title="Fill rate · 8 weeks"
        description={`Shifts filled of shifts scheduled, each workweek — this week, the shifts that have started. The dashed line is the ${fillTargetPct}% target.`}
        summary={summary}
        columns={[
          { key: 'week', label: 'Week of' },
          { key: 'fill', label: 'Fill rate', numeric: true, format: (v) => (v === null || v === undefined ? 'Nothing scheduled' : `${String(v)}%`) },
          { key: 'filled', label: 'Filled', numeric: true },
          { key: 'scheduled', label: 'Scheduled', numeric: true },
          { key: 'inProgress', label: 'In progress' },
        ]}
        rows={rows.length === 0 ? rows : all}
        csvName="fill-rate-8-weeks"
        height={220}
        empty={<EmptyState size="sm" icon={CalendarCheck} title="Nothing scheduled yet" description="The line starts with the first published week." />}
      >
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={all} margin={{ top: 12, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={PALETTE.grid} vertical={false} />
            <XAxis dataKey="week" tick={TICK} tickLine={false} axisLine={{ stroke: PALETTE.grid }} minTickGap={12} />
            {/* The target is always on the scale, however the weeks went. */}
            <YAxis domain={[floor, 100]} tick={TICK} tickLine={false} axisLine={false} width={44} tickFormatter={(v: number) => `${v}%`} />
            <Tooltip
              cursor={{ stroke: PALETTE.ref, strokeWidth: 1 }}
              content={
                <ChartTooltipContent
                  series={{ fill: { name: 'Fill rate', color: PALETTE.primary } }}
                  format={(v) => `${v}%`}
                  heading={(label) => {
                    const row = all.find((r) => r.week === label);
                    return row ? `${weekOf(row.weekStart)}${row.inProgress ? ' (so far)' : ''}` : label;
                  }}
                />
              }
            />
            <ReferenceLine y={fillTargetPct} ifOverflow="extendDomain" stroke={PALETTE.ref} strokeDasharray="4 3" label={{ value: `${fillTargetPct}% target`, position: 'insideBottomRight', fill: TICK.fill, fontSize: 10 }} />
            <Area type="linear" dataKey="fill" name="Fill rate" connectNulls={false} stroke={PALETTE.primary} strokeWidth={2} fill={PALETTE.primary} fillOpacity={0.12} isAnimationActive={false} dot={{ r: 3, fill: PALETTE.primary, strokeWidth: 0 }} activeDot={{ r: 4, stroke: PALETTE.surface, strokeWidth: 2 }} />
          </ComposedChart>
        </ResponsiveContainer>
      </ChartFrame>
    </div>
  );
}
