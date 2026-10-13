import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Bus, Gauge, HeartPulse, RefreshCw, ScanFace } from 'lucide-react';
import type { ReliabilityIssueRow, ReliabilityRouteRow, ReliabilityWeekRow } from '@alto-people/shared';
import { getReliability } from '@/lib/reliabilityApi';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { Badge } from '@/components/ui/Badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { DataGrid } from '@/components/ui/DataGrid';
import { EmptyState } from '@/components/ui/EmptyState';
import { MetricCard } from '@/components/ui/MetricCard';
import { QueryError } from '@/components/ui/QueryError';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * IS THE PLATFORM STAYING UP?
 *
 * Product usage next door says what people open. This page says whether
 * it worked: errors this week against the ten-a-week budget, how slow the
 * busiest routes are at the 95th percentile, whether the kiosk accepted
 * the punch, whether the van showed up, and how often the API restarted.
 *
 * One hero — the error budget — and everything else behind it. Errors
 * come from Sentry when a read token is configured on the API; without
 * one the hero says so instead of pretending zero.
 */

const WINDOWS = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
];

/** "97%", "97.5%" — a decimal only when there is one to show. */
const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 1000) / 10}%`);
const ms = (v: number | null) => (v === null ? '—' : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${v} ms`);
const endpoint = (r: ReliabilityRouteRow) => `${r.method} ${r.route}`;

/** "Jul 4 – Jul 10": the org week as people say it. */
function weekLabel(w: ReliabilityWeekRow): string {
  const end = new Date(new Date(w.weekEnd).getTime() - 12 * 60 * 60 * 1000);
  return `${fmtDate(w.weekStart)} – ${fmtDate(end)}`;
}

const ROUTE_COLUMNS = [
  {
    key: 'endpoint',
    header: 'Endpoint',
    accessor: (r: ReliabilityRouteRow) => endpoint(r),
    sortable: true,
    primary: true,
    className: 'font-mono text-xs',
    cell: (r: ReliabilityRouteRow) => (
      <>
        <span className="text-silver">{r.method}</span> {r.route}
      </>
    ),
  },
  {
    key: 'p95',
    header: 'p95',
    accessor: (r: ReliabilityRouteRow) => r.p95Ms ?? -1,
    csv: (r: ReliabilityRouteRow) => (r.p95Ms === null ? '' : `${r.p95Ms}ms`),
    sortable: true,
    searchable: false,
    align: 'right' as const,
    cardMeta: true,
    className: 'tabular-nums',
    cell: (r: ReliabilityRouteRow) => ms(r.p95Ms),
  },
  {
    key: 'avg',
    header: 'Avg',
    accessor: (r: ReliabilityRouteRow) => r.avgMs,
    csv: (r: ReliabilityRouteRow) => `${r.avgMs}ms`,
    sortable: true,
    searchable: false,
    align: 'right' as const,
    className: 'tabular-nums text-silver',
    cell: (r: ReliabilityRouteRow) => ms(r.avgMs),
  },
  {
    key: 'calls',
    header: 'Calls',
    accessor: (r: ReliabilityRouteRow) => r.requests,
    sortable: true,
    searchable: false,
    align: 'right' as const,
    cardMeta: true,
    className: 'tabular-nums',
    cell: (r: ReliabilityRouteRow) => r.requests.toLocaleString(),
  },
  {
    key: 'errors',
    header: '5xx',
    accessor: (r: ReliabilityRouteRow) => r.serverError,
    sortable: true,
    searchable: false,
    align: 'right' as const,
    className: 'tabular-nums',
    cell: (r: ReliabilityRouteRow) =>
      r.serverError > 0 ? <span className="text-alert">{r.serverError}</span> : <span className="text-silver">0</span>,
  },
];

export function ReliabilityHome() {
  const [window, setWindow] = useState('7');
  const days = Number(window);

  const q = useQuery({
    queryKey: ['reliability', 'overview', days],
    queryFn: () => getReliability(days),
  });
  const data = q.data;

  const closedWeeks = useMemo(() => (data?.errors.weeks ?? []).filter((w) => !w.current), [data]);
  const errorTrend = useMemo(() => {
    if (!data || !data.sentry.configured) return undefined;
    const series = data.errors.weeks.map((w) => w.sentryErrors ?? 0);
    const last = closedWeeks[closedWeeks.length - 1]?.sentryErrors ?? 0;
    const prev = closedWeeks[closedWeeks.length - 2]?.sentryErrors ?? 0;
    return { series, delta: last - prev, deltaLabel: 'vs prior week' };
  }, [data, closedWeeks]);

  const slowestBusy = data?.routes.slowest[0] ?? null;
  const streak = data?.errors.consecutiveWeeksUnderBudget ?? null;
  const thisWeek = data?.errors.thisWeek ?? null;
  const overBudget = data ? thisWeek !== null && thisWeek > data.budget : false;

  if (q.isError) return <QueryError what="reliability" query={q} />;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-silver">
          Errors against the budget, where the API is slow, and whether punches and rides went through.
        </p>
        <SegmentedControl options={WINDOWS} value={window} onChange={setWindow} ariaLabel="Reporting window" />
      </div>

      {/* ---- The hero: this week's errors against the budget ---------- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <HeartPulse className="h-4 w-4 text-gold" aria-hidden="true" />
            Errors this week
          </CardTitle>
          <CardDescription>
            Org week, Saturday to Friday. The budget is {data?.budget ?? 10} a week; the Phase 1 exit asks for eight
            weeks in a row under it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {q.isLoading || !data ? (
            <Skeleton className="h-28" />
          ) : data.sentry.configured ? (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <div className="md:col-span-2">
                <MetricCard
                  label="In Sentry so far"
                  value={thisWeek === null ? '—' : String(thisWeek)}
                  hint={
                    <span className="inline-flex items-center gap-2">
                      <Badge variant={overBudget ? 'destructive' : 'success'}>
                        {overBudget ? 'Over budget' : 'Within budget'}
                      </Badge>
                      <span>of {data.budget}</span>
                    </span>
                  }
                  accent={overBudget}
                  trend={errorTrend}
                  deltaPositiveIsGood={false}
                />
              </div>
              <MetricCard
                label="Weeks under budget"
                value={streak === null ? '—' : String(streak)}
                hint={streak === null ? 'No closed week counted yet' : streak >= 8 ? 'Exit criterion met' : `${8 - streak} more to the exit`}
              />
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <div className="md:col-span-2">
                <EmptyState
                  icon={AlertTriangle}
                  title="Sentry is not connected"
                  description={
                    <>
                      The error budget is a Sentry number. Set <code>SENTRY_AUTH_TOKEN</code>, <code>SENTRY_ORG</code>{' '}
                      and <code>SENTRY_PROJECTS</code> on the API to count errors here and in the Saturday summary.
                    </>
                  }
                />
              </div>
              <MetricCard
                label="Server errors this week"
                value={String(data.errors.serverErrorsThisWeek)}
                hint="5xx responses, from the API's own count"
                accent={data.errors.serverErrorsThisWeek > 0}
              />
            </div>
          )}
        </CardContent>
      </Card>

      {/* ---- The other three measures, plus restarts ------------------ */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard
          label="Slowest busy route"
          value={q.isLoading || !data ? '—' : ms(slowestBusy?.p95Ms ?? null)}
          hint={slowestBusy ? `p95 · ${endpoint(slowestBusy)}` : 'p95 needs a day of traffic'}
          accent={Boolean(slowestBusy && (slowestBusy.p95Ms ?? 0) >= 2000)}
        />
        <MetricCard
          label="Kiosk punches accepted"
          value={q.isLoading || !data ? '—' : pct(data.kiosk.rate)}
          hint={data ? `${data.kiosk.accepted.toLocaleString()} of ${data.kiosk.total.toLocaleString()}` : 'Clock-ins the kiosk took'}
          accent={Boolean(data && data.kiosk.rate !== null && data.kiosk.rate < 0.95)}
        />
        <MetricCard
          label="Rides completed"
          value={q.isLoading || !data ? '—' : pct(data.rides.rate)}
          hint={
            data
              ? `${data.rides.completed} of ${data.rides.total}${data.rides.noShow > 0 ? ` · ${data.rides.noShow} no-show` : ''}${data.rides.unresolved > 0 ? ` · ${data.rides.unresolved} never closed` : ''}`
              : 'Seats past their pickup time'
          }
          accent={Boolean(data && data.rides.rate !== null && data.rides.rate < 0.9)}
        />
        <MetricCard
          label="API restarts"
          value={q.isLoading || !data ? '—' : String(data.restarts.count)}
          hint={data?.restarts.lastBootAt ? `Last start ${fmtDateTime(data.restarts.lastBootAt)}` : 'In the window'}
          accent={Boolean(data && data.restarts.count > 3)}
        />
      </div>

      {/* ---- Details -------------------------------------------------- */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Gauge className="h-4 w-4 text-gold" aria-hidden="true" />
              Busiest routes
            </CardTitle>
            <CardDescription>The ten most-called endpoints and their 95th-percentile response time.</CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            {q.isLoading || !data ? (
              <Skeleton className="h-64" />
            ) : data.routes.busiest.length === 0 ? (
              <EmptyState icon={Gauge} title="Nothing recorded yet" description="Traffic is counted from the first request after this shipped." />
            ) : (
              <DataGrid<ReliabilityRouteRow>
                id="reliability-busiest"
                caption="Busiest endpoints with p95"
                rows={data.routes.busiest}
                rowKey={endpoint}
                search={false}
                urlState={false}
                exportCsv={{ filename: 'busiest-routes-p95' }}
                columnChooser={false}
                columns={ROUTE_COLUMNS}
              />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <RefreshCw className="h-4 w-4 text-warning" aria-hidden="true" />
              Slowest routes
            </CardTitle>
            <CardDescription>The five slowest at p95 among endpoints with at least twenty calls.</CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            {q.isLoading || !data ? (
              <Skeleton className="h-64" />
            ) : data.routes.slowest.length === 0 ? (
              <EmptyState
                icon={RefreshCw}
                title="No p95 yet"
                description="Response-time histograms accumulate from the first request after this shipped; a day of traffic fills this in."
              />
            ) : (
              <DataGrid<ReliabilityRouteRow>
                id="reliability-slowest"
                caption="Slowest endpoints by p95"
                rows={data.routes.slowest}
                rowKey={endpoint}
                search={false}
                urlState={false}
                exportCsv={{ filename: 'slowest-routes-p95' }}
                columnChooser={false}
                columns={ROUTE_COLUMNS}
              />
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-alert" aria-hidden="true" />
              Open issues in Sentry
            </CardTitle>
            <CardDescription>Unresolved, most frequent first, in the window.</CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            {q.isLoading || !data ? (
              <Skeleton className="h-48" />
            ) : !data.sentry.configured ? (
              <EmptyState icon={AlertTriangle} title="Sentry is not connected" description="" />
            ) : data.sentry.issues.length === 0 ? (
              <EmptyState icon={AlertTriangle} title="Nothing open" description="No unresolved issue was seen in the window." />
            ) : (
              <DataGrid<ReliabilityIssueRow>
                id="reliability-issues"
                caption="Open Sentry issues"
                rows={data.sentry.issues}
                rowKey={(r) => r.shortId}
                search={false}
                urlState={false}
                exportCsv={{ filename: 'sentry-open-issues' }}
                columnChooser={false}
                columns={[
                  {
                    key: 'issue',
                    header: 'Issue',
                    accessor: (r) => r.title,
                    sortable: true,
                    primary: true,
                    cell: (r) => (
                      <a href={r.permalink} target="_blank" rel="noreferrer" className="text-white underline-offset-2 hover:underline">
                        <span className="font-mono text-xs text-silver">{r.shortId}</span> {r.title}
                      </a>
                    ),
                  },
                  { key: 'where', header: 'Where', accessor: (r) => r.culprit, sortable: true, className: 'font-mono text-xs text-silver' },
                  { key: 'events', header: 'Events', accessor: (r) => r.count, sortable: true, searchable: false, align: 'right', cardMeta: true, className: 'tabular-nums' },
                  { key: 'users', header: 'People', accessor: (r) => r.userCount, sortable: true, searchable: false, align: 'right', className: 'tabular-nums' },
                  { key: 'last', header: 'Last seen', accessor: (r) => r.lastSeen, sortable: true, searchable: false, cell: (r) => fmtDateTime(r.lastSeen), className: 'text-silver' },
                ]}
              />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <HeartPulse className="h-4 w-4 text-gold" aria-hidden="true" />
              Week by week
            </CardTitle>
            <CardDescription>Eight org weeks; the last is in progress and not yet judged.</CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            {q.isLoading || !data ? (
              <Skeleton className="h-48" />
            ) : (
              <DataGrid<ReliabilityWeekRow>
                id="reliability-weeks"
                caption="Weekly errors against the budget"
                rows={[...data.errors.weeks].reverse()}
                rowKey={(w) => w.weekStart}
                search={false}
                urlState={false}
                exportCsv={{ filename: 'reliability-weeks' }}
                columnChooser={false}
                columns={[
                  { key: 'week', header: 'Week', accessor: (w) => w.weekStart, sortable: true, primary: true, cell: (w) => weekLabel(w) },
                  {
                    key: 'errors',
                    header: 'Errors',
                    accessor: (w) => w.sentryErrors ?? -1,
                    csv: (w) => (w.sentryErrors === null ? '' : String(w.sentryErrors)),
                    sortable: true,
                    searchable: false,
                    align: 'right',
                    cardMeta: true,
                    className: 'tabular-nums',
                    cell: (w) => (w.sentryErrors === null ? <span className="text-silver">—</span> : w.sentryErrors),
                  },
                  { key: '5xx', header: '5xx', accessor: (w) => w.serverErrors, sortable: true, searchable: false, align: 'right', className: 'tabular-nums text-silver' },
                  { key: 'calls', header: 'Calls', accessor: (w) => w.requests, sortable: true, searchable: false, align: 'right', className: 'tabular-nums text-silver', cell: (w) => w.requests.toLocaleString() },
                  {
                    key: 'verdict',
                    header: 'Budget',
                    accessor: (w) => (w.current ? 'In progress' : w.underBudget === null ? 'Unknown' : w.underBudget ? 'Under' : 'Over'),
                    sortable: true,
                    searchable: false,
                    cell: (w) =>
                      w.current ? (
                        <Badge variant="info">In progress</Badge>
                      ) : w.underBudget === null ? (
                        <Badge variant="outline">Unknown</Badge>
                      ) : w.underBudget ? (
                        <Badge variant="success">Under</Badge>
                      ) : (
                        <Badge variant="destructive">Over</Badge>
                      ),
                  },
                ]}
              />
            )}
          </CardContent>
        </Card>
      </div>

      <p className="flex items-center gap-2 text-xs text-silver">
        <ScanFace className="h-3.5 w-3.5" aria-hidden="true" />
        A rejected kiosk punch is one the kiosk refused (wrong PIN, inactive associate, stale clock).
        <Bus className="ml-2 h-3.5 w-3.5" aria-hidden="true" />
        Ride completion counts seats past their pickup time; cancellations are left out.
      </p>
    </div>
  );
}
