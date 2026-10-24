import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, ChevronDown, ChevronUp } from '@/components/ui/icons';
import type { OnboardingAnalyticsResponse } from '@alto-people/shared';
import { getOnboardingAnalytics } from '@/lib/analyticsApi';
import { useAuth } from '@/lib/auth';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { MetricCard } from '@/components/ui/MetricCard';
import { MetricStrip } from '@/components/ui/MetricStrip';
import { QueryError } from '@/components/ui/QueryError';
import { OnboardingSections } from './OnboardingSections';
import { ListTemplate } from '@/components/templates';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { ChartFrame } from '@/components/ui/ChartFrame';
import { lazyPlot } from '@/components/ui/charts/lazyPlot';

/** The drawing (recharts) loads with the chart, not the page (lazyPlot). */
const OnboardingMonthlyPlot = lazyPlot(() => import('./OnboardingAnalytics.plot').then((m) => ({ default: m.OnboardingMonthlyPlot })));

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

/**
 * One unit per size, said in words (F500 G1): under a day reads in hours
 * ("3 h"), a day or more in days ("4.2 days"). The tiles used to say
 * "Median days 0.0h" — a label in days over a value in hours.
 */
export const fmtDuration = (days: number | null): string => {
  if (days === null) return '—';
  if (days < 1) {
    const h = Math.round(days * 24);
    return h < 1 ? 'Under 1 h' : `${h} h`;
  }
  const d = Math.round(days * 10) / 10;
  return `${d.toFixed(1)} day${d === 1 ? '' : 's'}`;
};

/** A median of fewer than three is one person's story, not a typical time. */
const MIN_MEDIAN_SAMPLE = 3;

/** Where each funnel status opens on the applications list. */
const STATUS_LINK: Record<string, string> = {
  DRAFT: '/onboarding?status=DRAFT',
  SUBMITTED: '/onboarding?status=SUBMITTED',
  IN_REVIEW: '/onboarding?status=IN_REVIEW',
  APPROVED: '/onboarding?status=APPROVED',
  REJECTED: '/onboarding?status=REJECTED',
  CANCELLED: '/onboarding?status=CANCELLED',
};

const pctOf = (n: number, of: number): string => (of > 0 ? `${Math.round((n / of) * 100)}%` : '—');

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

      <OnboardingSections />

      {dataQuery.isError && <QueryError what="onboarding analytics" query={dataQuery} />}

      {!data && !dataQuery.isError && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
      )}

      {data && (() => {
        const n = (s: string) => data.byStatus[s] ?? 0;
        const inFlight = n('DRAFT') + n('SUBMITTED') + n('IN_REVIEW');
        const invited = STATUS_ORDER.reduce((acc, k) => acc + n(k), 0);
        // Reached HR = submitted at some point: still waiting, or decided.
        const reached = n('SUBMITTED') + n('IN_REVIEW') + n('APPROVED') + n('REJECTED');
        const approved = n('APPROVED');
        const sample = data.completion.sample;
        const noneFinished = sample === 0 ? `No one finished in the last ${data.windowDays} days` : null;
        return (
        <>
          {/* Hero numbers: one unit each, said in words; an empty window says so. */}
          <MetricStrip label="Time to complete" className="mb-6">
            <MetricCard
              label="Time to complete (median)"
              value={fmtDuration(data.completion.medianDays)}
              hint={`From invite to submitted · ${sample} finished in the window`}
              nothing={noneFinished}
            />
            <MetricCard
              label="Time to complete (slowest 10%)"
              value={fmtDuration(data.completion.p90Days)}
              hint="9 in 10 finish faster than this"
              nothing={noneFinished}
            />
            <MetricCard
              label="In flight right now"
              value={inFlight}
              hint={`${approved} approved · ${n('REJECTED')} rejected`}
              href="/onboarding"
            />
          </MetricStrip>

          {/* Funnel: where everyone invited is now, each count a link to the
              list behind it, and the step-to-step conversion in one line. */}
          <Card className="mb-6">
            <CardHeader>
              <CardTitle>Funnel — where everyone invited is now</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <MetricStrip label="Applications by status">
                {STATUS_ORDER.map((st) => (
                  <MetricCard
                    key={st}
                    label={STATUS_LABEL[st] ?? st}
                    value={n(st)}
                    hint={`${pctOf(n(st), invited)} of everyone invited`}
                    // Approved is the outcome; nothing here is an alarm, so a
                    // zero rejected never reads in red.
                    tone={st === 'APPROVED' && n(st) > 0 ? 'good' : 'neutral'}
                    href={STATUS_LINK[st]}
                  />
                ))}
              </MetricStrip>
              {invited > 0 && (
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-silver" data-testid="onboarding-conversion">
                  <span>
                    <span className="tabular-nums text-ink">{invited}</span> invited
                  </span>
                  <ArrowRight className="h-3.5 w-3.5 text-silver/70" aria-hidden="true" />
                  <span>
                    <span className="tabular-nums text-ink">{reached}</span> reached HR{' '}
                    <span className="tabular-nums">({pctOf(reached, invited)})</span>
                  </span>
                  <ArrowRight className="h-3.5 w-3.5 text-silver/70" aria-hidden="true" />
                  <span>
                    <span className="tabular-nums text-ink">{approved}</span> approved{' '}
                    <span className="tabular-nums">({pctOf(approved, reached)} of those)</span>
                  </span>
                </p>
              )}
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
                        completed={t.completed}
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
                          completed={c.completed}
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
        );
      })()}
    </ListTemplate>
  );
}

function EmptyHint() {
  return (
    <EmptyState size="sm" title="No completed applications in this window yet." />
  );
}

interface BreakdownRowProps {
  label: string;
  count: number;
  medianDays: number | null;
  /** How many finished — the median's sample (older API: unknown). */
  completed?: number;
  max: number;
}

/** "median 4.2 days", or why there is none: nobody finished, or too few to tell. */
export function medianPhrase(medianDays: number | null, completed: number | undefined): string {
  if (completed === 0 || (completed === undefined && medianDays === null)) return 'none finished yet';
  if (completed !== undefined && completed < MIN_MEDIAN_SAMPLE) return `${completed} finished · too few to tell`;
  const d = fmtDuration(medianDays);
  return `median ${d.charAt(0).toLowerCase()}${d.slice(1)}`;
}

function BreakdownRow({ label, count, medianDays, completed, max }: BreakdownRowProps) {
  const pct = max > 0 ? (count / max) * 100 : 0;
  return (
    <li className="flex items-center gap-3 text-sm">
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline justify-between gap-2 mb-1">
          <span className="text-white truncate">{label}</span>
          <span className="text-xs2 text-silver tabular-nums shrink-0">
            {count} invited · {medianPhrase(medianDays, completed)}
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
      <OnboardingMonthlyPlot rows={rows} />
    </ChartFrame>
  );
}
