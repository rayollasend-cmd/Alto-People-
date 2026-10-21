import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Clock } from 'lucide-react';
import { getTeamHours } from '@/lib/attendanceInsightsApi';
import { fmtDate } from '@/lib/format';
import { ChartFrame } from '@/components/ui/ChartFrame';
import { ChartTooltipContent, LegendKey, PALETTE, TICK } from '@/components/ui/charts';
import { EmptyState } from '@/components/ui/EmptyState';
import { QueryError } from '@/components/ui/QueryError';
import { Skeleton } from '@/components/ui/Skeleton';

const SERIES = {
  worked: { name: 'Worked', color: PALETTE.primary },
  scheduled: { name: 'Still scheduled', color: PALETTE.other },
};

/**
 * Hours per person this workweek — punched so far, and still scheduled —
 * against the 40-hour line, so whoever is heading into overtime shows
 * before the week is out.
 */
export function TeamHoursCard({ className }: { className?: string }) {
  const q = useQuery({ queryKey: ['attendance', 'team-hours'], queryFn: getTeamHours, staleTime: 2 * 60_000 });
  if (q.isPending) return <Skeleton className={className ?? 'h-64'} />;
  if (q.isError) return <QueryError what="your team’s hours" query={q} />;
  const d = q.data;
  if (d.people.length === 0) return null;

  const fmtH = (v: number) => `${v.toLocaleString('en-US', { maximumFractionDigits: 1 })}h`;
  const over = d.people.filter((p) => p.projectedHours > d.thresholdHours);
  const rows = d.people.map((p) => ({
    name: p.name,
    worked: p.workedHours,
    scheduled: p.scheduledHours,
    projected: p.projectedHours,
    status: p.projectedHours > d.thresholdHours ? 'Heading into overtime' : p.onClock ? 'On the clock' : '',
  }));
  // Each person keeps a readable bar; a big team scrolls inside the frame.
  const natural = Math.max(160, rows.length * 30 + 48);
  const summary =
    over.length === 0
      ? `Nobody on your team is on course to pass ${d.thresholdHours} hours this week.`
      : `${over.length} of ${d.people.length} on course to pass ${d.thresholdHours} hours this week: ${over
          .slice(0, 3)
          .map((p) => `${p.name} (${fmtH(p.projectedHours)})`)
          .join(', ')}${over.length > 3 ? ', and more' : ''}.`;

  return (
    <div className={className}>
      <ChartFrame
        title="Hours this week"
        description={
          <>
            Week of {fmtDate(d.weekStart)}. Punched so far, then still scheduled; the line is {d.thresholdHours} hours.
            {over.length > 0 && <span className="text-warning"> {over.length === 1 ? '1 person is' : `${over.length} people are`} heading into overtime.</span>}
          </>
        }
        summary={summary}
        columns={[
          { key: 'name', label: 'Name' },
          { key: 'worked', label: 'Worked', numeric: true, format: (v) => fmtH(Number(v)) },
          { key: 'scheduled', label: 'Still scheduled', numeric: true, format: (v) => fmtH(Number(v)) },
          { key: 'projected', label: 'Projected', numeric: true, format: (v) => fmtH(Number(v)) },
          { key: 'status', label: 'Note' },
        ]}
        rows={rows}
        csvName="team-hours-this-week"
        height={Math.min(480, natural)}
        empty={<EmptyState size="sm" icon={Clock} title="No hours yet this week" description="Punches and scheduled shifts show here as the week fills in." />}
      >
        <div className="flex h-full w-full flex-col">
          <div className={natural > 480 ? 'min-h-0 flex-1 overflow-y-auto' : 'min-h-0 flex-1'}>
            <ResponsiveContainer width="100%" height={natural > 480 ? natural - 24 : '100%'}>
              <BarChart data={rows} layout="vertical" margin={{ top: 12, right: 16, bottom: 0, left: 0 }} barCategoryGap="28%">
                <CartesianGrid stroke={PALETTE.grid} horizontal={false} />
                {/* Forty is always on the scale, however short the week. */}
                <XAxis type="number" domain={[0, (max: number) => Math.max(Math.ceil(max), d.thresholdHours + 4)]} tick={TICK} tickLine={false} axisLine={{ stroke: PALETTE.grid }} tickFormatter={fmtH} />
                <YAxis type="category" dataKey="name" tick={TICK} tickLine={false} axisLine={false} width={120} />
                <Tooltip cursor={{ fill: PALETTE.cursor }} content={<ChartTooltipContent series={SERIES} format={(v) => fmtH(v)} />} />
                <ReferenceLine x={d.thresholdHours} ifOverflow="extendDomain" stroke={PALETTE.bad} strokeDasharray="4 3" label={{ value: `${d.thresholdHours}h`, position: 'insideTopRight', fill: TICK.fill, fontSize: 10 }} />
                <Bar dataKey="worked" name="Worked" stackId="h" fill={SERIES.worked.color} isAnimationActive={false} />
                <Bar dataKey="scheduled" name="Still scheduled" stackId="h" fill={SERIES.scheduled.color} radius={[0, 4, 4, 0]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <LegendKey items={[{ name: 'Worked', color: SERIES.worked.color }, { name: 'Still scheduled', color: SERIES.scheduled.color }, { name: `${d.thresholdHours} hours`, color: PALETTE.bad, line: true }]} />
        </div>
      </ChartFrame>
    </div>
  );
}
