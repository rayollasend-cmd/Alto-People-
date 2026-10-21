import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Grid3x3 } from 'lucide-react';
import { getAttendanceHeatmap, type AttendanceHeatmapMetric, type AttendanceHeatmapResponse } from '@/lib/attendanceInsightsApi';
import { fmtDate } from '@/lib/format';
import { ChartFrame, type ChartColumn } from '@/components/ui/ChartFrame';
import { Heatmap } from '@/components/ui/charts';
import { EmptyState } from '@/components/ui/EmptyState';
import { QueryError } from '@/components/ui/QueryError';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * Where in the week it happens: lateness, overtime or call-outs over the
 * last eight weeks, by day of the week down each location — or, with one
 * location chosen (the picker, or a tap on a location's row), by hour of the
 * day. One switch changes the measure.
 */

const METRICS: Array<{ value: AttendanceHeatmapMetric; label: string; noun: string }> = [
  { value: 'late', label: 'Lateness', noun: 'late arrivals' },
  { value: 'overtime', label: 'Overtime', noun: 'overtime hours' },
  { value: 'callouts', label: 'Call-outs', noun: 'call-outs' },
];

export function AttendanceHeatmapCard({ siteId: fixedSite, className }: { siteId?: string; className?: string }) {
  const [metric, setMetric] = useState<AttendanceHeatmapMetric>('late');
  const [picked, setPicked] = useState('');
  const siteId = fixedSite ?? (picked || undefined);
  const q = useQuery({
    queryKey: ['attendance', 'heatmap', metric, siteId ?? 'all'],
    queryFn: () => getAttendanceHeatmap({ metric, siteId }),
    staleTime: 5 * 60_000,
    placeholderData: (prev) => prev,
  });
  // The locations to pick from: the by-location view's rows, remembered so
  // they stay offered once a location is chosen.
  const [sites, setSites] = useState<Array<{ id: string; name: string }>>([]);
  useEffect(() => {
    const d = q.data;
    if (!d || d.by !== 'site') return;
    const found = d.rows.filter((r) => r.key !== 'none' && r.key !== 'other').map((r) => ({ id: r.key, name: r.label }));
    setSites((prev) => {
      const all = new Map(prev.map((x) => [x.id, x.name]));
      for (const x of found) all.set(x.id, x.name);
      return [...all].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
    });
  }, [q.data]);

  // While the next measure loads, the old one's numbers stay — under their own name, dimmed.
  const shown = q.data;
  const m = METRICS.find((x) => x.value === (shown?.metric ?? metric))!;
  const switching = q.isFetching && q.isPlaceholderData;

  const controls = (
    <div className="mb-2 flex flex-wrap items-center justify-end gap-2">
      {!fixedSite && sites.length > 0 && (
        <Select aria-label="Location" value={picked} onChange={(e) => setPicked(e.target.value)} className="w-auto min-w-[12rem]">
          <option value="">Every location · by location</option>
          {sites.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name} · by hour
            </option>
          ))}
        </Select>
      )}
      <SegmentedControl ariaLabel="Measure" options={METRICS.map((x) => ({ value: x.value, label: x.label }))} value={metric} onChange={setMetric} />
    </div>
  );

  if (q.isPending) return <Skeleton className={className ?? 'h-72'} />;
  if (q.isError) return <QueryError what="the attendance heatmap" query={q} />;
  const d = shown!;

  return (
    <div className={className} aria-busy={switching || undefined}>
      {controls}
      <div className={switching ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
        <ChartFrame
          title={`${m.label} by day${d.by === 'hour' ? ' and hour' : ' and location'}${d.by === 'hour' ? ` · ${sites.find((x) => x.id === d.siteId)?.name ?? 'one location'}` : ''}`}
          description={`${fmtDate(d.from)} – ${fmtDate(d.to)}. Darker is more.${d.by === 'site' && !fixedSite ? ' Tap a location to see it by hour.' : ''}`}
          summary={heatmapSummary(d, m.noun)}
          columns={columnsFor(d)}
          rows={tableRows(d)}
          csvName={`attendance-${d.metric}-heatmap`}
          height={Math.min(420, Math.max(140, d.rows.length * 30 + 56))}
          empty={<EmptyState size="sm" icon={Grid3x3} title={`No ${m.noun} in the last eight weeks`} description="When there are, this shows which days and places they gather on." />}
        >
          <Heatmap
            caption={`${m.label} by day of the week`}
            rows={d.rows.map((r) => ({ key: r.key, label: r.label }))}
            columns={d.days.map((day) => ({ key: day, label: day }))}
            values={d.rows.map((r) => r.values)}
            tone={d.metric === 'overtime' ? 'warn' : 'bad'}
            max={d.max}
            showValues
            format={(v) => (d.unit === 'hours' ? `${v.toLocaleString('en-US', { maximumFractionDigits: 1 })}h` : v.toLocaleString('en-US'))}
            legend={{ low: 'Fewer', high: 'More' }}
            onCellClick={d.by === 'site' && !fixedSite ? (row) => row.key !== 'none' && row.key !== 'other' && setPicked(row.key) : undefined}
            className="h-full overflow-y-auto"
          />
        </ChartFrame>
      </div>
    </div>
  );
}

function columnsFor(d: AttendanceHeatmapResponse): ChartColumn[] {
  return [
    { key: 'label', label: d.by === 'hour' ? 'Hour' : 'Location' },
    // A cell with no data stays blank — never a made-up zero.
    ...d.days.map((day) => ({ key: day, label: day, numeric: true, format: (v: unknown) => (v === null || v === undefined ? '—' : String(v)) })),
    { key: 'total', label: 'Total', numeric: true },
  ];
}

function tableRows(d: AttendanceHeatmapResponse): Array<Record<string, unknown>> {
  return d.rows.map((r) => ({ label: r.label, ...Object.fromEntries(d.days.map((day, i) => [day, r.values[i] ?? null])), total: r.total }));
}

/** "21 late arrivals in all. The most fall on Mon at Harbor Inn (6)." */
export function heatmapSummary(d: AttendanceHeatmapResponse, noun: string): string {
  if (d.rows.length === 0 || d.total === 0) return `No ${noun} in this range.`;
  let best = { row: d.rows[0]!.label, day: d.days[0]!, v: -1 };
  for (const r of d.rows) r.values.forEach((v, i) => { if (v > best.v) best = { row: r.label, day: d.days[i]!, v }; });
  const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 1 });
  return `${fmt(d.total)} ${noun} in all. The most fall on ${best.day} at ${best.row} (${fmt(best.v)}).`;
}
