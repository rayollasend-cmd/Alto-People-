import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { getAttendanceTrends, type AttendanceTrendsResponse, type AttendanceWeek } from '@/lib/attendanceInsightsApi';
import { Card, CardContent } from '@/components/ui/Card';
import { MetricCard } from '@/components/ui/MetricCard';
import { QueryError } from '@/components/ui/QueryError';
import { Skeleton } from '@/components/ui/Skeleton';
import { weekLabel } from './weekLabel';

/**
 * The four numbers a floor is run by, each with its last eight workweeks
 * drawn under it: fill rate, no-call no-shows, call-outs, late arrivals.
 * The headline is the last complete week; the chip is its change from the
 * week before; the line ends on the week in progress.
 */

export const attendanceTrendsKey = (siteId?: string, weeks = 8) => ['attendance', 'trends', siteId ?? 'all', weeks] as const;

export function useAttendanceTrends(opts: { siteId?: string; weeks?: number; enabled?: boolean } = {}) {
  return useQuery({
    queryKey: attendanceTrendsKey(opts.siteId, opts.weeks),
    queryFn: () => getAttendanceTrends({ siteId: opts.siteId, weeks: opts.weeks }),
    enabled: opts.enabled ?? true,
    staleTime: 5 * 60_000,
  });
}

type CountKey = 'noCallNoShows' | 'callOuts' | 'lates';

/** Last complete week and the one before it. */
export function lastTwo(data: AttendanceTrendsResponse): { last: AttendanceWeek | null; prior: AttendanceWeek | null } {
  const done = data.weeks.filter((w) => !w.inProgress);
  return { last: done[done.length - 1] ?? null, prior: done[done.length - 2] ?? null };
}

export function AttendanceTrendTiles({ siteId, className }: { siteId?: string; className?: string }) {
  const q = useAttendanceTrends({ siteId });
  if (q.isPending) {
    return (
      <div className={className}>
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Card key={i}>
              <CardContent>
                <Skeleton className="mb-3 h-3 w-24" />
                <Skeleton className="mb-2 h-8 w-16" />
                <Skeleton className="h-5 w-28" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }
  if (q.isError) return <QueryError what="the attendance trends" query={q} />;

  const data = q.data;
  const { last, prior } = lastTwo(data);
  const current = data.weeks[data.weeks.length - 1] ?? null;
  const since = last ? `Week of ${weekLabel(last.weekStart)}` : undefined;

  const fillSeries = data.weeks.map((w) => w.fillRatePct).filter((v): v is number => v !== null);
  const fillDelta = last?.fillRatePct != null && prior?.fillRatePct != null ? last.fillRatePct - prior.fillRatePct : 0;
  const count = (key: CountKey) => ({
    series: data.weeks.map((w) => w[key]),
    delta: last && prior ? last[key] - prior[key] : 0,
    deltaLabel: 'vs wk before',
  });
  const wrap = (to: string) => (card: React.ReactElement) => (
    <Link to={to} className="block h-full rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright [&>div]:h-full">
      {card}
    </Link>
  );

  return (
    <div className={className}>
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <MetricCard
          label="Fill rate · last week"
          value={last?.fillRatePct != null ? `${last.fillRatePct}%` : '—'}
          accent={last?.fillRatePct != null && last.fillRatePct < data.fillTargetPct}
          trend={fillSeries.length >= 2 ? { series: fillSeries, delta: fillDelta, deltaLabel: 'pts' } : undefined}
          hint={current?.fillRatePct != null ? `This week so far: ${current.fillRatePct}% · target ${data.fillTargetPct}%` : `Target ${data.fillTargetPct}%`}
          wrap={wrap('/scheduling')}
        />
        <MetricCard
          label="No-call no-shows"
          value={last ? last.noCallNoShows : '—'}
          accent={(last?.noCallNoShows ?? 0) > 0}
          trend={count('noCallNoShows')}
          deltaPositiveIsGood={false}
          hint={since}
          wrap={wrap('/call-outs')}
        />
        <MetricCard
          label="Call-outs"
          value={last ? last.callOuts : '—'}
          trend={count('callOuts')}
          deltaPositiveIsGood={false}
          hint={since}
          wrap={wrap('/call-outs')}
        />
        <MetricCard
          label="Late arrivals"
          value={last ? last.lates : '—'}
          trend={count('lates')}
          deltaPositiveIsGood={false}
          hint={current ? `${current.lates} so far this week` : since}
          wrap={wrap('/time-attendance')}
        />
      </div>
    </div>
  );
}
