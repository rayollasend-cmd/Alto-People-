import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronUp, Clock, TrendingUp, Users } from 'lucide-react';
import type { OnboardingAnalyticsResponse } from '@alto-people/shared';
import { getOnboardingAnalytics } from '@/lib/analyticsApi';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { ListTemplate } from '@/components/templates';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/lib/cn';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ChartFrame } from '@/components/ui/ChartFrame';
import { PALETTE, TICK, TOOLTIP_LABEL_STYLE, TOOLTIP_STYLE } from '@/components/ui/charts/palette';

const TRACK_LABEL: Record<string, string> = {
  STANDARD: 'Standard',
  J1: 'J-1',
  CLIENT_SPECIFIC: 'Client-specific',
};

const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted',
  IN_REVIEW: 'In review',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
};

// Status order in the funnel — left-to-right matches the associate's
// journey, which is what HR expects to read.
const STATUS_ORDER = ['DRAFT', 'SUBMITTED', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'CANCELLED'];

const fmtDays = (n: number | null): string => {
  if (n === null) return '—';
  if (n < 1) return `${(n * 24).toFixed(1)}h`;
  return `${n.toFixed(1)}d`;
};

const MONTH_ABBREV = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** "2026-05" → "May '26". Pure string math — no locale/timezone drift. */
const fmtMonth = (yyyymm: string): string => {
  const [y, m] = yyyymm.split('-');
  const idx = Number(m) - 1;
  if (!y || !MONTH_ABBREV[idx]) return yyyymm;
  return `${MONTH_ABBREV[idx]} '${y.slice(-2)}`;
};

const TOP_CLIENTS_PREVIEW = 5;

export function OnboardingAnalytics() {
  const { can } = useAuth();
  const canView = can('view:dashboard');

  const [clientsExpanded, setClientsExpanded] = useState(false);

  const dataQuery = useQuery({
    queryKey: ['OnboardingAnalytics', 'data', canView],
    queryFn: () => getOnboardingAnalytics(),
    enabled: Boolean(canView),
  });
  const data: OnboardingAnalyticsResponse | null = dataQuery.data ?? null;
  const error = dataQuery.error ? dataQuery.error instanceof ApiError ? dataQuery.error.message : 'Failed to load.' : null;

  if (!canView) {
    return (
      <div className="mx-auto">
        <ErrorBanner>
          You don't have permission to view onboarding analytics.
        </ErrorBanner>
      </div>
    );
  }

  return (
    // Design system §4.2 (UX upgrade step 6, the sweep): the List template;
    // the way back to the applications is the breadcrumb.
    <ListTemplate
        breadcrumbs={[{ label: 'Onboarding', to: '/onboarding' }, { label: 'Analytics' }]}
        title="Onboarding analytics"
        subtitle={
          data
            ? `How long associates take to finish onboarding. Last ${data.windowDays} days unless noted.`
            : 'How long associates take to finish onboarding.'
        }
      >

      {error && <ErrorBanner className="mb-4">{error}</ErrorBanner>}

      {!data && !error && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
      )}

      {data && (
        <>
          {/* Hero KPIs */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
            <KpiCard
              icon={Clock}
              label="Median days to complete"
              value={fmtDays(data.completion.medianDays)}
              hint={`${data.completion.sample} completions in window`}
              tone={
                data.completion.medianDays === null
                  ? 'silver'
                  : data.completion.medianDays <= 5
                    ? 'success'
                    : data.completion.medianDays <= 10
                      ? 'warning'
                      : 'alert'
              }
            />
            <KpiCard
              icon={TrendingUp}
              label="P90 days"
              value={fmtDays(data.completion.p90Days)}
              hint="9 in 10 finish faster than this"
              tone={
                data.completion.p90Days === null
                  ? 'silver'
                  : data.completion.p90Days <= 14
                    ? 'success'
                    : data.completion.p90Days <= 30
                      ? 'warning'
                      : 'alert'
              }
            />
            <KpiCard
              icon={Users}
              label="In flight right now"
              value={String(
                (data.byStatus.DRAFT ?? 0) +
                  (data.byStatus.SUBMITTED ?? 0) +
                  (data.byStatus.IN_REVIEW ?? 0)
              )}
              hint={`${data.byStatus.APPROVED ?? 0} approved · ${data.byStatus.REJECTED ?? 0} rejected`}
              tone="default"
            />
          </div>

          {/* Funnel */}
          <Card className="mb-6">
            <CardHeader>
              <CardTitle>Funnel — current snapshot</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-3">
                {STATUS_ORDER.map((s) => {
                  const count = data.byStatus[s] ?? 0;
                  const total = STATUS_ORDER.reduce(
                    (acc, k) => acc + (data.byStatus[k] ?? 0),
                    0
                  );
                  const pct = total > 0 ? (count / total) * 100 : 0;
                  return (
                    <div
                      key={s}
                      className="flex-1 min-w-[120px] rounded-md border border-navy-secondary bg-navy-secondary/30 p-3"
                    >
                      <div className="text-2xs uppercase tracking-wider text-silver">
                        {STATUS_LABEL[s] ?? s}
                      </div>
                      <div
                        className={cn(
                          'text-2xl tabular-nums mt-1',
                          s === 'APPROVED'
                            ? 'text-success'
                            : s === 'REJECTED'
                              ? 'text-alert'
                              : 'text-white'
                        )}
                      >
                        {count}
                      </div>
                      <div className="text-2xs text-silver/70 tabular-nums mt-0.5">
                        {pct.toFixed(0)}%
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
            {/* By track */}
            <Card>
              <CardHeader>
                <CardTitle>By track</CardTitle>
              </CardHeader>
              <CardContent>
                {data.byTrack.length === 0 ? (
                  <EmptyHint />
                ) : (
                  <ul className="space-y-2.5">
                    {data.byTrack.map((t) => (
                      <BreakdownRow
                        key={t.track}
                        label={TRACK_LABEL[t.track] ?? t.track}
                        count={t.count}
                        medianDays={t.medianDays}
                        max={Math.max(...data.byTrack.map((x) => x.count))}
                      />
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            {/* By client */}
            <Card>
              <CardHeader>
                <CardTitle>Top clients</CardTitle>
              </CardHeader>
              <CardContent>
                {data.byClient.length === 0 ? (
                  <EmptyHint />
                ) : (
                  <>
                    <ul className="space-y-2.5">
                      {(clientsExpanded
                        ? data.byClient
                        : data.byClient.slice(0, TOP_CLIENTS_PREVIEW)
                      ).map((c) => (
                        <BreakdownRow
                          key={c.clientId}
                          label={c.clientName}
                          count={c.count}
                          medianDays={c.medianDays}
                          max={Math.max(...data.byClient.map((x) => x.count))}
                        />
                      ))}
                    </ul>
                    {data.byClient.length > TOP_CLIENTS_PREVIEW && (
                      <div className="mt-3 flex justify-center">
                        <button
                          type="button"
                          onClick={() => setClientsExpanded((v) => !v)}
                          className="inline-flex items-center gap-1.5 text-xs text-silver hover:text-gold-bright transition-colors"
                          aria-expanded={clientsExpanded}
                        >
                          {clientsExpanded ? (
                            <>
                              <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
                              Show top {TOP_CLIENTS_PREVIEW}
                            </>
                          ) : (
                            <>
                              <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                              Show all {data.byClient.length}
                            </>
                          )}
                        </button>
                      </div>
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Monthly trend */}
          <MonthlyChart points={data.monthly} />
        </>
      )}
    </ListTemplate>
  );
}

function EmptyHint() {
  return (
    <p className="text-sm text-silver">
      No completed applications in this window yet.
    </p>
  );
}

interface KpiCardProps {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  hint?: string;
  tone: 'success' | 'warning' | 'alert' | 'default' | 'silver';
}

const TONE_TEXT: Record<KpiCardProps['tone'], string> = {
  success: 'text-success',
  warning: 'text-warning',
  alert: 'text-alert',
  default: 'text-gold',
  silver: 'text-silver',
};

function KpiCard({ icon: Icon, label, value, hint, tone }: KpiCardProps) {
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between mb-1">
        <div className="text-xs2 font-medium uppercase tracking-[0.14em] text-silver/70">
          {label}
        </div>
        <Icon className="h-3.5 w-3.5 text-silver/70" />
      </div>
      <div className={cn('text-3xl font-display tabular-nums', TONE_TEXT[tone])}>
        {value}
      </div>
      {hint && <div className="text-xs2 text-silver/70 mt-1">{hint}</div>}
    </Card>
  );
}

interface BreakdownRowProps {
  label: string;
  count: number;
  medianDays: number | null;
  max: number;
}

function BreakdownRow({ label, count, medianDays, max }: BreakdownRowProps) {
  const pct = max > 0 ? (count / max) * 100 : 0;
  return (
    <li className="flex items-center gap-3 text-sm">
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline justify-between gap-2 mb-1">
          <span className="text-white truncate">{label}</span>
          <span className="text-xs2 text-silver tabular-nums shrink-0">
            {count} · median {fmtDays(medianDays)}
          </span>
        </div>
        <div className="h-1.5 rounded-full bg-navy-secondary overflow-hidden">
          <div
            className="h-full bg-gold/70"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    </li>
  );
}

function MonthlyChart({
  points,
}: {
  points: OnboardingAnalyticsResponse['monthly'];
}) {
  const rows = points.map((p) => ({
    month: fmtMonth(p.month),
    invited: p.invited,
    completed: p.completed,
    // The month's invitees who have finished — a cohort rate. (Completions in a
    // month are often last month's invites, so completed ÷ invited isn't one.)
    rate: p.invited > 0 && p.invitedCompleted !== undefined ? Math.round((p.invitedCompleted / p.invited) * 100) : null,
  }));
  const invited = points.reduce((n, p) => n + p.invited, 0);
  const completed = points.reduce((n, p) => n + p.completed, 0);
  return (
    <ChartFrame
      title={`Last ${points.length} months — invited vs completed`}
      summary={`${invited} invited and ${completed} completed over the last ${points.length} months.`}
      csvName="onboarding-monthly"
      height={220}
      columns={[
        { key: 'month', label: 'Month' },
        { key: 'invited', label: 'Invited', numeric: true },
        { key: 'completed', label: 'Completed', numeric: true },
        { key: 'rate', label: 'Of that month’s invites, finished', numeric: true, format: (v) => (v === null || v === undefined ? '—' : `${v}%`) },
      ]}
      rows={invited + completed > 0 ? rows : []}
      empty={<p className="text-sm text-silver">Nobody was invited in the last {points.length} months.</p>}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
          <CartesianGrid stroke={PALETTE.grid} vertical={false} />
          <XAxis dataKey="month" tick={TICK} tickLine={false} axisLine={false} />
          <YAxis allowDecimals={false} tick={TICK} tickLine={false} axisLine={false} width={40} />
          <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL_STYLE} cursor={{ fill: PALETTE.cursor }} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="invited" name="Invited" fill={PALETTE.other} radius={[3, 3, 0, 0]} maxBarSize={22} />
          <Bar dataKey="completed" name="Completed" fill={PALETTE.series[0]} radius={[3, 3, 0, 0]} maxBarSize={22} />
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
