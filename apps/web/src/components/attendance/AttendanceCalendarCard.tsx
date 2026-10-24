import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CalendarDays } from '@/components/ui/icons';
import { getAttendanceCalendar, type AttendanceCalendarMetric, type AttendanceCalendarResponse } from '@/lib/attendanceInsightsApi';
import { fmtCount, fmtDateOnly, fmtDateOnlyRange } from '@/lib/format';
import { ChartFrame, type ChartColumn } from '@/components/ui/ChartFrame';
import { CalendarHeatmap, type Tone } from '@/components/ui/charts';
import { EmptyState } from '@/components/ui/EmptyState';
import { QueryError } from '@/components/ui/QueryError';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * The year in attendance: every day of the last twelve months, darker for
 * more — call-outs, no-shows or late arrivals, each on its store's own day.
 * Where the heatmap says which weekday, this says which weeks and seasons:
 * a holiday stretch, the days after payday, a bad month at one store. One
 * switch changes the measure; a host with a site filter passes its site.
 */

const METRICS: Array<{ value: AttendanceCalendarMetric; label: string; one: string; noun: string; tone: Tone }> = [
  { value: 'callouts', label: 'Call-outs', one: 'call-out', noun: 'call-outs', tone: 'bad' },
  { value: 'noshows', label: 'No-shows', one: 'no-show', noun: 'no-shows', tone: 'bad' },
  { value: 'late', label: 'Late', one: 'late arrival', noun: 'late arrivals', tone: 'warn' },
];

const WEEKDAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];

const COLUMNS: ChartColumn[] = [
  { key: 'date', label: 'Date', format: (v) => fmtDateOnly(String(v), { weekday: true }) },
  { key: 'value', label: 'Count', numeric: true },
];

export function AttendanceCalendarCard({ siteId, className }: { siteId?: string; className?: string }) {
  const [metric, setMetric] = useState<AttendanceCalendarMetric>('callouts');
  const q = useQuery({
    queryKey: ['attendance', 'calendar', metric, siteId ?? 'all'],
    queryFn: () => getAttendanceCalendar({ metric, siteId }),
    staleTime: 5 * 60_000,
    placeholderData: (prev) => prev,
  });

  // While the next measure loads, the old one's year stays — under its own name, dimmed.
  const shown = q.data;
  // The measure the shown year is for — or, from an answer that names none, the one asked for.
  const m = METRICS.find((x) => x.value === shown?.metric) ?? METRICS.find((x) => x.value === metric)!;
  const switching = q.isFetching && q.isPlaceholderData;

  if (q.isPending) return <Skeleton className={className ?? 'h-72'} />;
  if (q.isError) return <QueryError what="the attendance calendar" query={q} />;
  // An answer without its days (an older server, a stub) reads as an empty year, never a crash.
  if (!shown || !Array.isArray(shown.days)) {
    return (
      <div className={className}>
        <EmptyState size="sm" icon={CalendarDays} title={`No ${m.noun} in the last 12 months`} description="When there are, this shows which weeks and seasons they gather in." />
      </div>
    );
  }
  const d = shown;

  return (
    <div className={className} aria-busy={switching || undefined}>
      <div className="mb-2 flex flex-wrap items-center justify-end gap-2">
        <SegmentedControl ariaLabel="Count by day" options={METRICS.map((x) => ({ value: x.value, label: x.label }))} value={metric} onChange={setMetric} />
      </div>
      <div className={switching ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
        <ChartFrame
          title={`The year in ${m.noun}`}
          description={`${fmtDateOnlyRange(d.from, d.to)}, each day on its store’s own calendar. Darker is more — the stretches that need extra cover stand out.`}
          summary={calendarSummary(d, m)}
          columns={COLUMNS}
          rows={tableRows(d)}
          csvName={`attendance-${d.metric}-by-day`}
          height={200}
          empty={<EmptyState size="sm" icon={CalendarDays} title={`No ${m.noun} in the last 12 months`} description="When there are, this shows which weeks and seasons they gather in." />}
        >
          <CalendarHeatmap days={d.days} from={d.from} to={d.to} unit={m.noun} unitOne={m.one} tone={m.tone} firstDay={d.firstDay} />
        </ChartFrame>
      </div>
    </div>
  );
}

/** Days with any, newest first — the CSV carries every one. */
function tableRows(d: AttendanceCalendarResponse): Array<Record<string, unknown>> {
  return [...d.days].reverse().map((x) => ({ date: x.date, value: x.value }));
}

/**
 * "312 call-outs in the last 12 months; the busiest day was Sat, Jul 4 (14),
 * and Saturdays carry the most (58)." The weekday clause only when one
 * weekday clearly leads.
 */
export function calendarSummary(d: AttendanceCalendarResponse, m: { one: string; noun: string }): string {
  if (d.total === 0 || !d.busiest) return `No ${m.noun} in the last 12 months.`;
  const head = `${fmtCount(d.total, m.one, m.noun)} in the last 12 months; the busiest day was ${fmtDateOnly(d.busiest.date, { weekday: true, year: 'auto' })} (${d.busiest.value.toLocaleString('en-US')})`;
  const top = Math.max(...d.weekdayTotals);
  const leaders = d.weekdayTotals.filter((v) => v === top).length;
  if (d.total < 7 || leaders > 1) return `${head}.`;
  return `${head}, and ${WEEKDAYS[d.weekdayTotals.indexOf(top)]} carry the most (${top.toLocaleString('en-US')}).`;
}
