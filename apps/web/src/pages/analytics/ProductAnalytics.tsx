import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity, AlertTriangle, Gauge, TrendingUp, Users } from '@/components/ui/icons';
import { ROLE_LABELS, type Role, type WebVitalMetric, type WebVitalRating, type WebVitalRouteRow } from '@alto-people/shared';
import {
  getActiveUsers,
  getAdoption,
  getProductEvents,
  getRouteUsage,
  getTraffic,
  getWebVitals,
} from '@/lib/productAnalyticsApi';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { MetricCard, type MetricTrend } from '@/components/ui/MetricCard';
import { MetricStrip } from '@/components/ui/MetricStrip';
import { EndpointCell, endpointLabel, fmtMs, PageCell, pageLabel } from './usageLabels';
import { ChartFrame } from '@/components/ui/ChartFrame';
import { PALETTE, StackedBarChart, TrendLineChart } from '@/components/ui/charts';
import { QueryError } from '@/components/ui/QueryError';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Skeleton } from '@/components/ui/Skeleton';
import { DataGrid } from '@/components/ui/DataGrid';
import { fmtDateTz } from '@/lib/format';
import { useUrlParam } from '@/lib/useUrlState';
import { ListTemplate } from '@/components/templates';

/**
 * IS ANYONE ACTUALLY USING THIS?
 *
 * The analytics section next door answers questions about the workforce.
 * This one answers questions about the software — who signs in, what they
 * open, what breaks — which until now had no answer but anecdote.
 *
 * Every panel reads a bounded window from a daily rollup. Nothing here
 * aggregates raw history, so the page costs the same on day 800 as it does
 * today.
 */

const WINDOWS = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
];

/** Charts want a short axis label, not a full ISO date. */
/** "Oct 21" — the API's days are UTC calendar days. */
const shortDay = (day: string) => fmtDateTz(`${day}T00:00:00Z`, 'UTC');

/** Whole percentages: "100%", "0%" — a rate on a few dozen people has no meaningful decimal. */
const pct = (v: number) => `${Math.round(v * 100)}%`;

// Web vitals read as plain words; the acronyms stay in the tooltip.
const VITAL_LABEL: Record<WebVitalMetric, string> = {
  LCP: 'Largest paint',
  INP: 'Tap response',
  CLS: 'Layout shift',
  TTFB: 'Server time',
};
const VITAL_HINT: Record<WebVitalMetric, string> = {
  LCP: 'LCP — time until the biggest thing on the page has painted',
  INP: 'INP — how long a tap or key takes to get a visible response',
  CLS: 'CLS — how much the page jumped while it loaded',
  TTFB: 'TTFB — how long the server took to start answering',
};
const RATING_TONE: Record<WebVitalRating, string> = {
  good: 'text-success',
  'needs-improvement': 'text-warning',
  poor: 'text-alert',
};
const ratingWord = (r: WebVitalRating | null) =>
  r === 'good' ? 'Good' : r === 'poor' ? 'Poor' : r === 'needs-improvement' ? 'Needs work' : '—';
/**
 * The p75 is read off a histogram (the API's daily rollup), so it is the
 * upper edge of the bucket the 75th percentile falls in — "≤400 ms", not
 * an exact "400 ms" every route happens to share.
 */
const fmtVital = (metric: WebVitalMetric, v: number | null) =>
  v === null ? '—' : `≤${metric === 'CLS' ? v.toFixed(2) : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`}`;

/** "1m 20s" for a duration in milliseconds. */
function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
}

/** The role's own name ("HR Administrator", "Client Portal"); a role the labels don't know, in sentence case. */
function roleLabel(role: string): string {
  const known = (ROLE_LABELS as Record<string, string>)[role as Role];
  if (known) return known;
  const words = role.toLowerCase().split('_');
  return words.map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(' ');
}

export function ProductAnalytics() {
  // The window lives in the URL (?days=7), so a link or Back keeps it.
  const [window, setWindow] = useUrlParam('days', '30', ['7', '30', '90']);
  const days = Number(window);

  const active = useQuery({
    queryKey: ['product-analytics', 'active-users', days],
    queryFn: () => getActiveUsers(days),
  });
  const traffic = useQuery({
    queryKey: ['product-analytics', 'traffic', days],
    queryFn: () => getTraffic(days),
  });
  const routes = useQuery({
    queryKey: ['product-analytics', 'routes', days],
    queryFn: () => getRouteUsage(days),
  });
  const vitals = useQuery({
    queryKey: ['product-analytics', 'web-vitals', days],
    queryFn: () => getWebVitals(days),
  });
  const adoption = useQuery({
    queryKey: ['product-analytics', 'adoption', days],
    queryFn: () => getAdoption(days),
  });
  const behaviour = useQuery({
    queryKey: ['product-analytics', 'product-events', days],
    queryFn: () => getProductEvents(days),
  });

  const activeSeries = useMemo(
    () => (active.data?.series ?? []).map((p) => ({ ...p, label: shortDay(p.day) })),
    [active.data],
  );
  const trafficSeries = useMemo(
    () => (traffic.data?.series ?? []).map((p) => ({ ...p, label: shortDay(p.day) })),
    [traffic.data],
  );
  const signupSeries = useMemo(
    () => (adoption.data?.signups ?? []).map((p) => ({ ...p, label: shortDay(p.day) })),
    [adoption.data],
  );

  // The day-by-day line behind the daily-active figure. Today is still
  // filling up (a UTC day), so the change compares the last two whole
  // days — yesterday against the day before — and today draws hollow.
  const dailyTrend = useMemo<MetricTrend | undefined>(() => {
    const series = activeSeries.map((p) => p.activeUsers);
    if (series.length < 3) return undefined;
    return {
      series,
      delta: series[series.length - 2]! - series[series.length - 3]!,
      deltaLabel: 'yesterday vs the day before',
      unit: 'day',
      lastIsPartial: true,
    };
  }, [activeSeries]);

  const totalRequests = useMemo(
    () => (traffic.data?.series ?? []).reduce((s, p) => s + p.requests, 0),
    [traffic.data],
  );
  const totalServerErrors = useMemo(
    () => (traffic.data?.series ?? []).reduce((s, p) => s + p.serverError, 0),
    [traffic.data],
  );

  return (
    <ListTemplate
      title="Product usage"
      subtitle="Who signs in, what they open, and what breaks."
      filters={<SegmentedControl options={WINDOWS} value={window} onChange={(v) => setWindow(v as '7' | '30' | '90')} ariaLabel="Reporting window" />}
    >
    <div className="space-y-5">

      {/* ---- Active users ------------------------------------------- */}
      {active.isError ? (
        <QueryError what="active users" query={active} />
      ) : (
        <MetricStrip label="Active users">
          <MetricCard
            label="Daily active"
            value={active.isLoading ? '—' : String(active.data?.dau ?? 0)}
            hint="Signed in today so far"
            trend={dailyTrend}
          />
          <MetricCard
            label="Weekly active"
            value={active.isLoading ? '—' : String(active.data?.wau ?? 0)}
            hint="Last 7 days"
          />
          <MetricCard
            label="Monthly active"
            value={active.isLoading ? '—' : String(active.data?.mau ?? 0)}
            hint="Last 30 days"
          />
          <MetricCard
            label="Stickiness"
            value={active.isLoading ? '—' : pct(active.data?.stickiness ?? 0)}
            hint="Weekly ÷ monthly"
          />
        </MetricStrip>
      )}

      {active.isLoading ? (
        <Skeleton className="h-72" />
      ) : (
        <ChartFrame
          title="Active users a day"
          summary={`Active users a day over ${activeSeries.length} days: ${activeSeries[0]?.activeUsers ?? 0} at the start, ${activeSeries.at(-1)?.activeUsers ?? 0} on the latest day.`}
          columns={[
            { key: 'day', label: 'Day' },
            { key: 'activeUsers', label: 'Active users', numeric: true },
          ]}
          rows={activeSeries.every((p) => p.activeUsers === 0) ? [] : activeSeries}
          csvName="active-users"
          height={220}
          empty={<EmptyState icon={Users} title="Nothing recorded yet" description="Activity is counted from the first authenticated request after this shipped." />}
        >
          <TrendLineChart data={activeSeries} x="label" yLabel="People" heading={(l) => String(l)} series={[{ key: 'activeUsers', name: 'Active users', area: true }]} />
        </ChartFrame>
      )}

      {/* ---- Adoption ------------------------------------------------ */}
      {adoption.isError ? (
        <QueryError what="adoption" query={adoption} />
      ) : (
        <MetricStrip label="Adoption">
          <MetricCard
            label="Never signed in"
            value={adoption.isLoading ? '—' : String(adoption.data?.neverSignedIn ?? 0)}
            hint="Invited, never once used"
          />
          <MetricCard
            label="Quiet 30 days"
            value={adoption.isLoading ? '—' : String(adoption.data?.dormant30d ?? 0)}
            hint="Active accounts, no sign-in"
          />
          <MetricCard
            label="Activation"
            value={
              adoption.isLoading ? '—' : pct(adoption.data?.funnel.activationRate ?? 0)
            }
            hint={
              adoption.data
                ? `${adoption.data.funnel.activated} of ${adoption.data.funnel.created} new accounts`
                : 'New accounts that signed in'
            }
          />
        </MetricStrip>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {adoption.isLoading ? (
          <Skeleton className="h-64" />
        ) : (
          <ChartFrame
            title="New accounts"
            summary={`${signupSeries.reduce((n, p) => n + p.accounts, 0)} new accounts over ${signupSeries.length} days.`}
            columns={[
              { key: 'day', label: 'Day' },
              { key: 'accounts', label: 'Accounts', numeric: true },
            ]}
            rows={signupSeries.every((p) => p.accounts === 0) ? [] : signupSeries}
            csvName="new-accounts"
            height={200}
            empty={<EmptyState icon={TrendingUp} title="No new accounts in this window" size="sm" />}
          >
            <StackedBarChart data={signupSeries} x="label" yLabel="Accounts" heading={(l) => String(l)} series={[{ key: 'accounts', name: 'Accounts' }]} />
          </ChartFrame>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-gold" aria-hidden="true" />
              Who is using it
            </CardTitle>
          </CardHeader>
          <CardContent>
            {adoption.isLoading ? (
              <Skeleton className="h-48" />
            ) : (adoption.data?.activeByRole ?? []).length === 0 ? (
              <EmptyState icon={Users} title="No activity yet" description="" />
            ) : (
              <ul className="space-y-1.5">
                {(adoption.data?.activeByRole ?? []).slice(0, 8).map((r) => {
                  const top = adoption.data?.activeByRole[0]?.users ?? 1;
                  return (
                    <li key={r.role} className="flex items-center gap-2 text-sm">
                      <span className="w-44 shrink-0 truncate text-silver" title={roleLabel(r.role)}>
                        {roleLabel(r.role)}
                      </span>
                      <span
                        className="h-2 rounded-full bg-gold/70"
                        style={{ width: `${Math.max(4, (r.users / top) * 60)}%` }}
                        aria-hidden="true"
                      />
                      <span className="tabular-nums text-ink">{r.users}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ---- Traffic and health -------------------------------------- */}
      {traffic.isError ? (
        <QueryError what="traffic" query={traffic} />
      ) : (
        traffic.isLoading ? (
          <Skeleton className="h-72" />
        ) : (
          <ChartFrame
            title="Requests a day"
            description={
              <>
                {totalRequests.toLocaleString()} total ·{' '}
                <span className={totalServerErrors > 0 ? 'text-alert' : ''}>{totalServerErrors.toLocaleString()} server errors</span>
              </>
            }
            summary={`${totalRequests.toLocaleString()} requests and ${totalServerErrors.toLocaleString()} server errors over ${trafficSeries.length} days.`}
            columns={[
              { key: 'day', label: 'Day' },
              { key: 'requests', label: 'Requests', numeric: true },
              { key: 'serverError', label: 'Server errors', numeric: true },
            ]}
            rows={trafficSeries}
            csvName="requests"
            height={240}
            empty={<EmptyState icon={Activity} title="No requests recorded in this window" size="sm" />}
          >
            <TrendLineChart
              data={trafficSeries}
              x="label"
              yLabel="Requests"
              heading={(l) => String(l)}
              series={[
                { key: 'requests', name: 'Requests' },
                { key: 'serverError', name: 'Server errors', color: PALETTE.bad },
              ]}
            />
          </ChartFrame>
        )
      )}

      {/* ---- Web vitals ---------------------------------------------- */}
      {vitals.isError ? (
        <QueryError what="web vitals" query={vitals} />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Gauge className="h-4 w-4 text-gold" aria-hidden="true" />
              How it feels on real devices
              <span className="ml-auto text-xs font-normal text-silver">
                75th percentile · Core Web Vitals
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {vitals.isLoading ? (
              <Skeleton className="h-24" />
            ) : (
              <MetricStrip label="Core Web Vitals">
                {(vitals.data?.metrics ?? []).map((m) => (
                  <div key={m.metric} title={VITAL_HINT[m.metric]} className="h-full [&>*]:h-full">
                    <MetricCard
                      label={VITAL_LABEL[m.metric]}
                      value={fmtVital(m.metric, m.p75)}
                      hint={
                        m.samples === 0 ? (
                          'No samples yet'
                        ) : (
                          <>
                            <span className={m.rating ? RATING_TONE[m.rating] : ''}>{ratingWord(m.rating)}</span>
                            {' · '}
                            {m.samples.toLocaleString()} samples
                          </>
                        )
                      }
                    />
                  </div>
                ))}
              </MetricStrip>
            )}
            {(vitals.data?.routes ?? []).length > 0 && (
              <DataGrid<WebVitalRouteRow>
                id="analytics-vitals-routes"
                caption="Web vitals by route"
                rows={vitals.data?.routes ?? []}
                rowKey={(r) => r.route}
                search={false}
                urlState={false}
                exportCsv={{ filename: 'web-vitals-by-route' }}
                columnChooser={false}
                columns={[
                  // The page in the sidebar's words; the path stays as the quiet second line and in the CSV.
                  { key: 'route', header: 'Page', accessor: (r) => `${pageLabel(r.route)} ${r.route}`, csv: (r) => r.route, sortable: true, primary: true, cell: (r) => <PageCell path={r.route} /> },
                  { key: 'samples', header: 'Views', accessor: (r) => r.samples, sortable: true, searchable: false, align: 'right', cardMeta: true, className: 'tabular-nums' },
                  { key: 'lcp', header: 'Largest paint', accessor: (r) => r.lcpP75, csv: (r) => fmtVital('LCP', r.lcpP75), sortable: true, searchable: false, align: 'right', cardMeta: true, className: 'tabular-nums', cell: (r) => fmtVital('LCP', r.lcpP75) },
                  { key: 'inp', header: 'Tap response', accessor: (r) => r.inpP75, csv: (r) => fmtVital('INP', r.inpP75), sortable: true, searchable: false, align: 'right', cardMeta: true, className: 'tabular-nums', cell: (r) => fmtVital('INP', r.inpP75) },
                  { key: 'cls', header: 'Layout shift', accessor: (r) => r.clsP75, csv: (r) => fmtVital('CLS', r.clsP75), sortable: true, searchable: false, align: 'right', className: 'tabular-nums', cell: (r) => fmtVital('CLS', r.clsP75) },
                  { key: 'ttfb', header: 'Server time', accessor: (r) => r.ttfbP75, csv: (r) => fmtVital('TTFB', r.ttfbP75), sortable: true, searchable: false, align: 'right', className: 'tabular-nums', cell: (r) => fmtVital('TTFB', r.ttfbP75) },
                ]}
              />
            )}
          </CardContent>
        </Card>
      )}

      {/* ---- Decisions (ux-upgrade §6) --------------------------------- */}
      {behaviour.isError ? (
        <QueryError what="decision measures" query={behaviour} />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Do people find what they came for?</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-silver">How fast a session reaches its first decision, how many decisions a session takes by role, and how often a search ends on a settings page — the sign that something could not be found.</p>
            {behaviour.data && !behaviourHasData(behaviour.data) ? (
              <EmptyState icon={Activity} size="sm" title="No decisions or settings searches recorded in this window yet." />
            ) : (
            <>
            <MetricStrip label="Finding things">
              <MetricCard
                label="Time to first decision"
                value={behaviour.isLoading || behaviour.data?.firstDecision.avgMs == null ? '—' : fmtDuration(behaviour.data.firstDecision.avgMs)}
                nothing={!behaviour.isLoading && behaviour.data?.firstDecision.avgMs == null ? 'No decisions yet' : undefined}
                hint={behaviour.data ? `Average over ${behaviour.data.firstDecision.sessions} session${behaviour.data.firstDecision.sessions === 1 ? '' : 's'} that took one` : 'From sign-in to the first approve, assign or acknowledge'}
              />
              <MetricCard
                label="Decisions a session"
                value={behaviour.isLoading ? '—' : behaviour.data && behaviour.data.decisionsPerSession.length > 0 ? String(Math.round((behaviour.data.decisionsPerSession.reduce((s, r) => s + r.decisions, 0) / Math.max(1, behaviour.data.decisionsPerSession.reduce((s, r) => s + r.sessions, 0))) * 100) / 100) : '0'}
                hint="All roles; the table splits it"
              />
              <MetricCard
                label="Searches ending in settings"
                value={behaviour.isLoading ? '—' : behaviour.data?.settingsSearches.perHundredSessions == null ? String(behaviour.data?.settingsSearches.count ?? 0) : `${behaviour.data.settingsSearches.perHundredSessions} per 100`}
                hint={behaviour.data ? `${behaviour.data.settingsSearches.count} searches, ${behaviour.data.settingsSearches.sessions} sessions` : 'A ⌘K search whose result opened a settings page'}
              />
            </MetricStrip>
            {behaviour.isLoading ? (
              <Skeleton className="h-32" />
            ) : (behaviour.data?.decisionsPerSession ?? []).length === 0 ? (
              <EmptyState icon={Activity} title="No sessions recorded yet" description="Sessions and decisions are counted from the first signed-in page after this shipped." />
            ) : (
              <DataGrid<NonNullable<typeof behaviour.data>['decisionsPerSession'][number]>
                id="analytics-decisions"
                caption="Decisions a session by role"
                rows={behaviour.data?.decisionsPerSession ?? []}
                rowKey={(r) => r.role}
                search={false}
                urlState={false}
                exportCsv={{ filename: 'decisions-by-role' }}
                columnChooser={false}
                columns={[
                  { key: 'role', header: 'Role', accessor: (r) => r.role, sortable: true, primary: true, cell: (r) => roleLabel(r.role) },
                  { key: 'sessions', header: 'Sessions', accessor: (r) => r.sessions, sortable: true, searchable: false, align: 'right', cardMeta: true, className: 'tabular-nums' },
                  { key: 'decisions', header: 'Decisions', accessor: (r) => r.decisions, sortable: true, searchable: false, align: 'right', cardMeta: true, className: 'tabular-nums' },
                  { key: 'perSession', header: 'A session', accessor: (r) => r.perSession ?? 0, sortable: true, searchable: false, align: 'right', cardMeta: true, className: 'tabular-nums', cell: (r) => (r.perSession == null ? '—' : String(r.perSession)) },
                ]}
              />
            )}
            </>
            )}
          </CardContent>
        </Card>
      )}

      {/* ---- Routes --------------------------------------------------- */}
      {routes.isError ? (
        <QueryError what="route usage" query={routes} />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Most used</CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              {routes.isLoading ? (
                <Skeleton className="h-64" />
              ) : (routes.data?.busiest ?? []).length === 0 ? (
                <EmptyState icon={Activity} title="Nothing recorded yet" description="" />
              ) : (
                <DataGrid<NonNullable<typeof routes.data>['busiest'][number]>
                  id="analytics-busiest"
                  caption="Most used endpoints"
                  rows={routes.data?.busiest ?? []}
                  rowKey={(r) => `${r.method} ${r.route}`}
                  search={false}
                  urlState={false}
                  exportCsv={{ filename: 'busiest-endpoints' }}
                  columnChooser={false}
                  columns={[
                    { key: 'endpoint', header: 'Endpoint', accessor: (r) => `${endpointLabel(r.route)} ${r.method} ${r.route}`, csv: (r) => `${r.method} ${r.route}`, sortable: true, primary: true, cell: (r) => <EndpointCell method={r.method} route={r.route} /> },
                    { key: 'calls', header: 'Calls', accessor: (r) => r.requests, sortable: true, searchable: false, align: 'right', cardMeta: true, className: 'tabular-nums', cell: (r) => r.requests.toLocaleString() },
                    { key: 'avg', header: 'Avg', accessor: (r) => r.avgMs, csv: (r) => fmtMs(r.avgMs), sortable: true, searchable: false, align: 'right', cardMeta: true, className: 'tabular-nums text-ink-muted', cell: (r) => fmtMs(r.avgMs) },
                  ]}
                />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-alert" aria-hidden="true" />
                Failing most
              </CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              {routes.isLoading ? (
                <Skeleton className="h-64" />
              ) : (routes.data?.failing ?? []).length === 0 ? (
                <EmptyState
                  icon={AlertTriangle}
                  title="No endpoint is failing"
                  description="Only endpoints with enough traffic for a rate to mean anything are listed."
                />
              ) : (
                <DataGrid<NonNullable<typeof routes.data>['failing'][number]>
                  id="analytics-failing"
                  caption="Failing endpoints"
                  rows={routes.data?.failing ?? []}
                  rowKey={(r) => `${r.method} ${r.route}`}
                  search={false}
                  urlState={false}
                  exportCsv={{ filename: 'failing-endpoints' }}
                  columnChooser={false}
                  columns={[
                    { key: 'endpoint', header: 'Endpoint', accessor: (r) => `${endpointLabel(r.route)} ${r.method} ${r.route}`, csv: (r) => `${r.method} ${r.route}`, sortable: true, primary: true, cell: (r) => <EndpointCell method={r.method} route={r.route} /> },
                    { key: 'errors', header: 'Errors', accessor: (r) => r.serverError, sortable: true, searchable: false, align: 'right', cardMeta: true, className: 'tabular-nums' },
                    { key: 'rate', header: 'Rate', accessor: (r) => r.errorRate, csv: (r) => pct(r.errorRate), sortable: true, searchable: false, align: 'right', cardMeta: true, className: 'tabular-nums text-alert', cell: (r) => pct(r.errorRate) },
                  ]}
                />
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
    </ListTemplate>
  );
}

/** Any decision, session decision or settings search recorded in the window. */
function behaviourHasData(d: { firstDecision: { avgMs: number | null }; decisionsPerSession: Array<{ decisions: number; sessions: number }>; settingsSearches: { count: number } }): boolean {
  return d.firstDecision.avgMs != null || d.settingsSearches.count > 0 || d.decisionsPerSession.some((r) => r.decisions > 0);
}
