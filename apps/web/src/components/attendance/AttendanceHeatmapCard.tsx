import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Grid3x3 } from 'lucide-react';
import { getAttendanceHeatmap, type AttendanceHeatmapMetric, type AttendanceHeatmapResponse } from '@/lib/attendanceInsightsApi';
import { fmtDate } from '@/lib/format';
import { ChartFrame, type ChartColumn } from '@/components/ui/ChartFrame';
import { Heatmap } from '@/components/ui/charts';
import { EmptyState } from '@/components/ui/EmptyState';
import { QueryError } from '@/components/ui/QueryError';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * Where in the week it happens: lateness, overtime or call-outs over the
 * last eight weeks, by day of the week down each location — or, with one
 * location chosen, by hour of the day. One switch changes the measure.
 */

const METRICS: Array<{ value: AttendanceHeatmapMetric; label: string; noun: string }> = [
  { value: 'late', label: 'Lateness', noun: 'late arrivals' },
  { value: 'overtime', label: 'Overtime', noun: 'overtime hours' },
  { value: 'callouts', label: 'Call-outs', noun: 'call-outs' },
];

export function AttendanceHeatmapCard({ siteId, className }: { siteId?: string; className?: string }) {
  const [metric, setMetric] = useState<AttendanceHeatmapMetric>('late');
  const q = useQuery({
    queryKey: ['attendance', 'heatmap', metric, siteId ?? 'all'],
    queryFn: () => getAttendanceHeatmap({ metric, siteId }),
    staleTime: 5 * 60_000,
    placeholderData: (prev) => prev,
  });
  const m = METRICS.find((x) => x.value === metric)!;

  const toggle = (
    <SegmentedControl
      ariaLabel="Measure"
      options={METRICS.map((x) => ({ value: x.value, label: x.label }))}
      value={metric}
      onChange={setMetric}
    />
  );

  if (q.isPending) return <Skeleton className={className ?? 'h-72'} />;
  if (q.isError) return <QueryError what="the attendance heatmap" query={q} />;
  const d = q.data;

  return (
    <div className={className}>
      <div className="mb-2 flex justify-end">{toggle}</div>
      <ChartFrame
        title={`${m.label} by day${d.by === 'hour' ? ' and hour' : ' and location'}`}
        description={`${fmtDate(d.from)} – ${fmtDate(d.to)}. Darker is more.`}
        summary={heatmapSummary(d, m.noun)}
        columns={columnsFor(d)}
        rows={tableRows(d)}
        csvName={`attendance-${metric}-heatmap`}
        height={Math.min(420, Math.max(140, d.rows.length * 30 + 56))}
        empty={<EmptyState size="sm" icon={Grid3x3} title={`No ${m.noun} in the last eight weeks`} description="When there are, this shows which days and places they gather on." />}
      >
        <Heatmap
          caption={`${m.label} by day of the week`}
          rows={d.rows.map((r) => ({ key: r.key, label: r.label }))}
          columns={d.days.map((day) => ({ key: day, label: day }))}
          values={d.rows.map((r) => r.values)}
          tone={metric === 'overtime' ? 'warn' : 'bad'}
          max={d.max}
          showValues
          format={(v) => (d.unit === 'hours' ? `${v.toLocaleString('en-US', { maximumFractionDigits: 1 })}h` : v.toLocaleString('en-US'))}
          legend={{ low: 'Fewer', high: 'More' }}
          className="h-full overflow-y-auto"
        />
      </ChartFrame>
    </div>
  );
}

function columnsFor(d: AttendanceHeatmapResponse): ChartColumn[] {
  return [
    { key: 'label', label: d.by === 'hour' ? 'Hour' : 'Location' },
    ...d.days.map((day) => ({ key: day, label: day, numeric: true })),
    { key: 'total', label: 'Total', numeric: true },
  ];
}

function tableRows(d: AttendanceHeatmapResponse): Array<Record<string, unknown>> {
  return d.rows.map((r) => ({ label: r.label, ...Object.fromEntries(d.days.map((day, i) => [day, r.values[i] ?? 0])), total: r.total }));
}

/** "21 late arrivals in all. The most fall on Mon at Harbor Inn (6)." */
export function heatmapSummary(d: AttendanceHeatmapResponse, noun: string): string {
  if (d.rows.length === 0 || d.total === 0) return `No ${noun} in this range.`;
  let best = { row: d.rows[0]!.label, day: d.days[0]!, v: -1 };
  for (const r of d.rows) r.values.forEach((v, i) => { if (v > best.v) best = { row: r.label, day: d.days[i]!, v }; });
  const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 1 });
  return `${fmt(d.total)} ${noun} in all. The most fall on ${best.day} at ${best.row} (${fmt(best.v)}).`;
}
