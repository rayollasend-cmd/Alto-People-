import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Bus, Gauge, HeartPulse, RefreshCw, ScanFace } from 'lucide-react';
import type { ReliabilityIssueRow, ReliabilityRouteRow, ReliabilityWeekRow } from '@alto-people/shared';
import { getReliability } from '@/lib/reliabilityApi';
import { fmtDateOnly, fmtDateTime } from '@/lib/format';
import { Badge } from '@/components/ui/Badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { DataGrid } from '@/components/ui/DataGrid';
import { EmptyState } from '@/components/ui/EmptyState';
import { MetricCard } from '@/components/ui/MetricCard';
import { MetricStrip } from '@/components/ui/MetricStrip';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryError } from '@/components/ui/QueryError';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Skeleton } from '@/components/ui/Skeleton';
import { StatusIncidentsPanel } from '@/components/status/StatusIncidentsPanel';
import { ScheduledJobsCard } from '@/components/reliability/ScheduledJobsCard';
import { useAuth, useTenant } from '@/lib/auth';
import { useUrlParam } from '@/lib/useUrlState';
import { PLATFORM_OPERATOR_TENANT_ID } from '@alto-people/shared';

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
 * one the hero says so instead of pretending zero. Written for the HR
 * admin who opens it, not for the engineer who wired it: no env-var
 * names, no "p95" without words.
 */

const WINDOWS = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
] as const;
const WINDOW_VALUES = WINDOWS.map((w) => w.value);
type WindowValue = (typeof WINDOW_VALUES)[number];

/** "97%", "97.5%" — a decimal only when there is one to show. */
const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 1000) / 10}%`);
const ms = (v: number | null) => (v === null ? '—' : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${v} ms`);
const endpoint = (r: ReliabilityRouteRow) => `${r.method} ${r.route}`;

/**
 * "Oct 17 – 23" (or "Oct 31 – Nov 6"; the year only when it isn't this
 * one). The org week is a Sat→Fri run of calendar days: read from the
 * week's YYYY-MM-DD keys, never as instants in the viewer's zone (which
 * started every week on the Friday before).
 */
export function weekLabel(w: Pick<ReliabilityWeekRow, 'weekStart' | 'weekEnd'>, now: Date = new Date()): string {
  const first = w.weekStart.slice(0, 10);
  const last = new Date(new Date(w.weekEnd).getTime() - 86_400_000).toISOString().slice(0, 10);
  const y1 = Number(first.slice(0, 4));
  const y2 = Number(last.slice(0, 4));
  const short = (ymd: string) => fmtDateOnly(ymd, { year: false });
  const yearTail = y2 !== now.getFullYear() ? `, ${y2}` : '';
  if (y1 !== y2) return `${fmtDateOnly(first)} – ${fmtDateOnly(last)}`;
  if (first.slice(5, 7) === last.slice(5, 7)) return `${short(first)} – ${Number(last.slice(8, 10))}${yearTail}`;
  return `${short(first)} – ${short(last)}${yearTail}`;
}

/** More API starts than this in a week is a problem (an OOM loop, a crash on boot), not a deploy. */
export const RESTARTS_PER_WEEK_OK = 3;

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
    header: 'Slowest 5%',
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
    header: 'Server errors',
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
  // In the URL, so a link to the 30-day view stays the 30-day view.
  const [window, setWindow] = useUrlParam<WindowValue>('window', '7', WINDOW_VALUES);
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

  // The status page is about the platform, so only its operator posts to it.
  const { can } = useAuth();
  const tenant = useTenant();
  const operator = can('manage:org') && tenant.id === PLATFORM_OPERATOR_TENANT_ID;

  const slowestBusy = data?.routes.slowest[0] ?? null;
  const streak = data?.errors.consecutiveWeeksUnderBudget ?? null;
  const thisWeek = data?.errors.thisWeek ?? null;
  const overBudget = data ? thisWeek !== null && thisWeek > data.budget : false;

  const header = (
    <PageHeader
      title="Reliability"
      subtitle="Errors against the weekly budget, where the app is slow, and whether punches and rides went through."
      secondaryActions={
        <SegmentedControl<WindowValue>
          options={WINDOWS.map((w) => ({ ...w }))}
          value={window}
          onChange={setWindow}
          ariaLabel="Reporting window"
        />
      }
    />
  );

  if (q.isError) {
    return (
      <div className="space-y-5">
        {header}
        <QueryError what="reliability" query={q} />
      </div>
    );
  }

  // Restarts are deploys and crashes alike; more than a few a week is the problem.
  const restartLimit = RESTARTS_PER_WEEK_OK * Math.max(1, Math.round(days / 7));

  return (
    <div className="space-y-5">
      {header}

      {/* ---- The hero: this week's errors against the budget ---------- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <HeartPulse className="h-4 w-4 text-gold" aria-hidden="true" />
            Errors this week
          </CardTitle>
          <CardDescription>
            Org week, Saturday to Friday. The budget is {data?.budget ?? 10} errors a week; the goal is eight weeks in a
            row under it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {q.isLoading || !data ? (
            <Skeleton className="h-28" />
          ) : data.sentry.configured ? (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <div className="md:col-span-2">
                <MetricCard
                  label="Errors so far"
                  value={thisWeek === null ? '—' : String(thisWeek)}
                  hint={
                    <span className="inline-flex items-center gap-2">
                      <Badge variant={overBudget ? 'destructive' : 'success'}>
                        {overBudget ? 'Over budget' : 'Within budget'}
                      </Badge>
                      <span>of {data.budget}</span>
                    </span>
                  }
                  tone={overBudget ? 'alert' : 'default'}
                  trend={errorTrend}
                  deltaPositiveIsGood={false}
                />
              </div>
              <MetricCard
                label="Weeks under budget"
                value={streak === null ? '—' : String(streak)}
                nothing={streak === null ? 'No full week counted yet' : undefined}
                hint={streak !== null && streak >= 8 ? 'Eight in a row: the goal is met' : `${8 - (streak ?? 0)} more for eight in a row`}
              />
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <div className="md:col-span-2">
                <EmptyState
                  icon={AlertTriangle}
                  title="Error tracking isn't connected"
                  description={
                    <>
                      Errors can&apos;t be counted against the budget until it is. Ask your Alto admin to connect error
                      tracking.
                      {operator && (
                        <span className="mt-1 block text-xs">
                          For the platform team: set SENTRY_AUTH_TOKEN, SENTRY_ORG and SENTRY_PROJECTS on the API.
                        </span>
                      )}
                    </>
                  }
                />
              </div>
              <MetricCard
                label="Server errors this week"
                value={String(data.errors.serverErrorsThisWeek)}
                hint="Requests that failed on our side, from the app's own count"
                tone={data.errors.serverErrorsThisWeek > 0 ? 'alert' : 'default'}
              />
            </div>
          )}
        </CardContent>
      </Card>

      {/* ---- The other three measures, plus restarts when there were any. A
          measure with nothing in the window says so in words: "— 0 of 0"
          read as a fake zero. */}
      {q.isLoading || !data ? (
        <Skeleton className="h-24" />
      ) : (
        <MetricStrip label="Reliability measures">
          <MetricCard
            label="Slowest busy route"
            value={ms(slowestBusy?.p95Ms ?? null)}
            nothing={slowestBusy ? undefined : 'Needs a day of traffic'}
            hint={slowestBusy ? `Slowest 5% of requests · ${endpoint(slowestBusy)}` : undefined}
            tone={slowestBusy && (slowestBusy.p95Ms ?? 0) >= 2000 ? 'warning' : 'default'}
          />
          <MetricCard
            label="Kiosk punches accepted"
            value={pct(data.kiosk.rate)}
            nothing={data.kiosk.total === 0 ? 'No kiosk punches in this window' : undefined}
            hint={`${data.kiosk.accepted.toLocaleString()} of ${data.kiosk.total.toLocaleString()}`}
            tone={data.kiosk.rate !== null && data.kiosk.rate < 0.95 ? 'warning' : 'default'}
          />
          <MetricCard
            label="Rides completed"
            value={pct(data.rides.rate)}
            nothing={data.rides.total === 0 ? 'No rides in this window' : undefined}
            hint={`${data.rides.completed} of ${data.rides.total}${data.rides.noShow > 0 ? ` · ${data.rides.noShow} no-show` : ''}${data.rides.unresolved > 0 ? ` · ${data.rides.unresolved} never closed` : ''}`}
            tone={data.rides.rate !== null && data.rides.rate < 0.9 ? 'warning' : 'default'}
          />
          {data.restarts.count > 0 && (
            <MetricCard
              label="API restarts"
              value={data.restarts.count.toLocaleString()}
              tone={data.restarts.count > restartLimit ? 'warning' : 'default'}
              hint={`${data.restarts.count > restartLimit ? `More than ${restartLimit} in ${days} days` : `Up to ${restartLimit} in ${days} days is normal`}${data.restarts.lastBootAt ? ` · last ${fmtDateTime(data.restarts.lastBootAt)}` : ''}`}
            />
          )}
        </MetricStrip>
      )}

      {/* ---- Details. Side by side only on a wide screen: beside the Settings
          rail, two half-width tables clipped their last column. ---------- */}
      <div className="grid grid-cols-1 gap-4 2xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Gauge className="h-4 w-4 text-gold" aria-hidden="true" />
              Busiest routes
            </CardTitle>
            <CardDescription>The ten most-called endpoints, and how long their slowest 5% of requests took.</CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            {q.isLoading || !data ? (
              <Skeleton className="h-64" />
            ) : data.routes.busiest.length === 0 ? (
              <EmptyState icon={Gauge} title="Nothing recorded yet" description="Traffic is counted from the first request after this shipped." />
            ) : (
              <DataGrid<ReliabilityRouteRow>
                id="reliability-busiest"
                caption="Busiest endpoints and their slowest 5% of requests"
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
            <CardDescription>The five slowest, judged by their slowest 5% of requests, among endpoints with at least twenty calls.</CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            {q.isLoading || !data ? (
              <Skeleton className="h-64" />
            ) : data.routes.slowest.length === 0 ? (
              <EmptyState
                icon={RefreshCw}
                title="No timings yet"
                description="Response-time histograms accumulate from the first request after this shipped; a day of traffic fills this in."
              />
            ) : (
              <DataGrid<ReliabilityRouteRow>
                id="reliability-slowest"
                caption="Slowest endpoints by their slowest 5% of requests"
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

      <div className="grid grid-cols-1 gap-4 2xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-alert" aria-hidden="true" />
              Open errors
            </CardTitle>
            <CardDescription>Unresolved errors from error tracking, most frequent first, in the window.</CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            {q.isLoading || !data ? (
              <Skeleton className="h-48" />
            ) : !data.sentry.configured ? (
              <EmptyState icon={AlertTriangle} title="Error tracking isn't connected" description="Open errors list here once it is." />
            ) : data.sentry.issues.length === 0 ? (
              <EmptyState icon={AlertTriangle} title="Nothing open" description="No unresolved issue was seen in the window." />
            ) : (
              <DataGrid<ReliabilityIssueRow>
                id="reliability-issues"
                caption="Open errors"
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
                  { key: '5xx', header: 'Server errors', accessor: (w) => w.serverErrors, sortable: true, searchable: false, align: 'right', className: 'tabular-nums text-silver' },
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
        A rejected kiosk punch is one the kiosk refused (wrong PIN, inactive person, stale clock).
        <Bus className="ml-2 h-3.5 w-3.5" aria-hidden="true" />
        Ride completion counts seats past their pickup time; cancellations are left out.
      </p>

      {/* ---- The timers: what each scheduled job did last and does next -- */}
      <ScheduledJobsCard canRun={can('manage:org')} />

      {/* ---- The public status page: the operator posts incidents here --- */}
      {operator && <StatusIncidentsPanel />}
    </div>
  );
}
