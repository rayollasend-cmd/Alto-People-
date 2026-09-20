import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Activity, AlertTriangle, TrendingUp, Users } from 'lucide-react';
import {
  getActiveUsers,
  getAdoption,
  getRouteUsage,
  getTraffic,
} from '@/lib/productAnalyticsApi';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { MetricCard } from '@/components/ui/MetricCard';
import { QueryError } from '@/components/ui/QueryError';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Skeleton } from '@/components/ui/Skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/Table';

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
const shortDay = (day: string) => day.slice(5);

const pct = (v: number) => `${(v * 100).toFixed(v < 0.01 ? 2 : 1)}%`;

export function ProductAnalytics() {
  const [window, setWindow] = useState('30');
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
  const adoption = useQuery({
    queryKey: ['product-analytics', 'adoption', days],
    queryFn: () => getAdoption(days),
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

  const totalRequests = useMemo(
    () => (traffic.data?.series ?? []).reduce((s, p) => s + p.requests, 0),
    [traffic.data],
  );
  const totalServerErrors = useMemo(
    () => (traffic.data?.series ?? []).reduce((s, p) => s + p.serverError, 0),
    [traffic.data],
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-silver">
          Who signs in, what they open, and what breaks.
        </p>
        <SegmentedControl
          options={WINDOWS}
          value={window}
          onChange={setWindow}
          aria-label="Reporting window"
        />
      </div>

      {/* ---- Active users ------------------------------------------- */}
      {active.isError ? (
        <QueryError what="active users" query={active} />
      ) : (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <MetricCard
            label="Daily active"
            value={active.isLoading ? '—' : String(active.data?.dau ?? 0)}
            hint="Signed in today"
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
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="h-4 w-4 text-gold" aria-hidden="true" />
            Active users a day
          </CardTitle>
        </CardHeader>
        <CardContent>
          {active.isLoading ? (
            <Skeleton className="h-56" />
          ) : activeSeries.every((p) => p.activeUsers === 0) ? (
            <EmptyState
              icon={Users}
              title="Nothing recorded yet"
              description="Activity is counted from the first authenticated request after this shipped."
            />
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={activeSeries}>
                <CartesianGrid strokeDasharray="3 3" stroke="#2a3550" />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#8b97b3' }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#8b97b3' }} />
                <Tooltip
                  contentStyle={{ background: '#0f1729', border: '1px solid #2a3550' }}
                  labelStyle={{ color: '#fff' }}
                />
                <Area
                  type="monotone"
                  dataKey="activeUsers"
                  name="Active users"
                  stroke="#c8a24a"
                  fill="#c8a24a33"
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* ---- Adoption ------------------------------------------------ */}
      {adoption.isError ? (
        <QueryError what="adoption" query={adoption} />
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          <MetricCard
            label="Never signed in"
            value={adoption.isLoading ? '—' : String(adoption.data?.neverSignedIn ?? 0)}
            hint="Invited, never once used"
            accent={Boolean(adoption.data && adoption.data.neverSignedIn > 0)}
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
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-gold" aria-hidden="true" />
              New accounts
            </CardTitle>
          </CardHeader>
          <CardContent>
            {adoption.isLoading ? (
              <Skeleton className="h-48" />
            ) : (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={signupSeries}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#2a3550" />
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#8b97b3' }} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#8b97b3' }} />
                  <Tooltip
                    contentStyle={{ background: '#0f1729', border: '1px solid #2a3550' }}
                    labelStyle={{ color: '#fff' }}
                  />
                  <Bar dataKey="accounts" name="Accounts" fill="#c8a24a" />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

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
                      <span className="w-44 shrink-0 truncate text-silver">
                        {r.role.replace(/_/g, ' ').toLowerCase()}
                      </span>
                      <span
                        className="h-2 rounded-full bg-gold/70"
                        style={{ width: `${Math.max(4, (r.users / top) * 60)}%` }}
                        aria-hidden="true"
                      />
                      <span className="tabular-nums text-white">{r.users}</span>
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
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-gold" aria-hidden="true" />
              Requests a day
              <span className="ml-auto text-xs font-normal text-silver">
                {totalRequests.toLocaleString()} total ·{' '}
                <span className={totalServerErrors > 0 ? 'text-alert' : ''}>
                  {totalServerErrors.toLocaleString()} server errors
                </span>
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {traffic.isLoading ? (
              <Skeleton className="h-56" />
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={trafficSeries}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#2a3550" />
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#8b97b3' }} />
                  <YAxis tick={{ fontSize: 11, fill: '#8b97b3' }} />
                  <Tooltip
                    contentStyle={{ background: '#0f1729', border: '1px solid #2a3550' }}
                    labelStyle={{ color: '#fff' }}
                  />
                  <Line type="monotone" dataKey="requests" name="Requests" stroke="#c8a24a" dot={false} />
                  <Line type="monotone" dataKey="serverError" name="Server errors" stroke="#e05260" dot={false} />
                </LineChart>
              </ResponsiveContainer>
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
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Endpoint</TableHead>
                      <TableHead>Calls</TableHead>
                      <TableHead>Avg</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(routes.data?.busiest ?? []).map((r) => (
                      <TableRow key={`${r.method} ${r.route}`}>
                        <TableCell className="font-mono text-xs">
                          <span className="text-silver">{r.method}</span> {r.route}
                        </TableCell>
                        <TableCell className="tabular-nums">
                          {r.requests.toLocaleString()}
                        </TableCell>
                        <TableCell className="tabular-nums text-silver">{r.avgMs}ms</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
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
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Endpoint</TableHead>
                      <TableHead>Errors</TableHead>
                      <TableHead>Rate</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(routes.data?.failing ?? []).map((r) => (
                      <TableRow key={`${r.method} ${r.route}`}>
                        <TableCell className="font-mono text-xs">
                          <span className="text-silver">{r.method}</span> {r.route}
                        </TableCell>
                        <TableCell className="tabular-nums">{r.serverError}</TableCell>
                        <TableCell className="tabular-nums text-alert">
                          {pct(r.errorRate)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
