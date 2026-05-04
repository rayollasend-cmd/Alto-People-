import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, ChevronDown, ChevronUp, Clock, TrendingUp, Users } from 'lucide-react';
import type { OnboardingAnalyticsResponse } from '@alto-people/shared';
import { getOnboardingAnalytics } from '@/lib/analyticsApi';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { PageHeader } from '@/components/ui/PageHeader';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/lib/cn';

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
};

// Status order in the funnel — left-to-right matches the associate's
// journey, which is what HR expects to read.
const STATUS_ORDER = ['DRAFT', 'SUBMITTED', 'IN_REVIEW', 'APPROVED', 'REJECTED'];

const fmtDays = (n: number | null): string => {
  if (n === null) return '—';
  if (n < 1) return `${(n * 24).toFixed(1)}h`;
  return `${n.toFixed(1)}d`;
};

const fmtMonth = (yyyymm: string): string => {
  const [y, m] = yyyymm.split('-');
  if (!y || !m) return yyyymm;
  const d = new Date(Date.UTC(Number(y), Number(m) - 1, 1));
  return d.toLocaleDateString(undefined, { month: 'short', year: '2-digit', timeZone: 'UTC' });
};

const TOP_CLIENTS_PREVIEW = 5;

export function OnboardingAnalytics() {
  const { can } = useAuth();
  const canView = can('view:dashboard');

  const [data, setData] = useState<OnboardingAnalyticsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clientsExpanded, setClientsExpanded] = useState(false);

  useEffect(() => {
    if (!canView) return;
    let cancelled = false;
    getOnboardingAnalytics()
      .then((r) => !cancelled && setData(r))
      .catch(
        (err) =>
          !cancelled &&
          setError(err instanceof ApiError ? err.message : 'Failed to load.')
      );
    return () => {
      cancelled = true;
    };
  }, [canView]);

  if (!canView) {
    return (
      <div className="max-w-3xl mx-auto">
        <ErrorBanner>
          You don't have permission to view onboarding analytics.
        </ErrorBanner>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto">
      <div className="mb-4">
        <Link
          to="/onboarding"
          className="text-sm text-silver hover:text-gold inline-block"
        >
          ← Applications
        </Link>
      </div>

      <PageHeader
        title="Onboarding analytics"
        subtitle={
          data
            ? `How long associates take to finish onboarding. Last ${data.windowDays} days unless noted.`
            : 'Loading time-to-completion stats…'
        }
      />

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
                      <div className="text-[10px] uppercase tracking-wider text-silver">
                        {STATUS_LABEL[s] ?? s}
                      </div>
                      <div
                        className={cn(
                          'text-2xl font-display tabular-nums mt-1',
                          s === 'APPROVED'
                            ? 'text-success'
                            : s === 'REJECTED'
                              ? 'text-alert'
                              : 'text-white'
                        )}
                      >
                        {count}
                      </div>
                      <div className="text-[10px] text-silver/60 tabular-nums mt-0.5">
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
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Activity className="h-4 w-4 text-silver" />
                Last 6 months — invited vs completed
              </CardTitle>
            </CardHeader>
            <CardContent>
              <MonthlyChart points={data.monthly} />
            </CardContent>
          </Card>
        </>
      )}
    </div>
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
        <div className="text-[10px] uppercase tracking-wider text-silver">
          {label}
        </div>
        <Icon className="h-3.5 w-3.5 text-silver/60" />
      </div>
      <div className={cn('text-3xl font-display tabular-nums', TONE_TEXT[tone])}>
        {value}
      </div>
      {hint && <div className="text-[11px] text-silver/70 mt-1">{hint}</div>}
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
          <span className="text-[11px] text-silver tabular-nums shrink-0">
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
  const max = Math.max(
    1, // avoid division-by-zero on a fully empty window
    ...points.flatMap((p) => [p.invited, p.completed])
  );
  return (
    <div className="flex items-end gap-3 h-40">
      {points.map((p) => (
        <div key={p.month} className="flex-1 flex flex-col items-center gap-1.5">
          {/* Two side-by-side bars per month: invited (silver) + completed (gold). */}
          <div className="flex items-end gap-1 h-32 w-full justify-center">
            <BarColumn
              value={p.invited}
              max={max}
              tone="silver"
              tip={`${p.invited} invited`}
            />
            <BarColumn
              value={p.completed}
              max={max}
              tone="gold"
              tip={`${p.completed} completed`}
            />
          </div>
          <div className="text-[10px] text-silver tabular-nums">
            {fmtMonth(p.month)}
          </div>
        </div>
      ))}
      <div className="ml-3 text-[10px] text-silver flex flex-col gap-1.5">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-sm bg-silver/50" />
          Invited
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-sm bg-gold" />
          Completed
        </span>
      </div>
    </div>
  );
}

function BarColumn({
  value,
  max,
  tone,
  tip,
}: {
  value: number;
  max: number;
  tone: 'silver' | 'gold';
  tip: string;
}) {
  const h = max > 0 ? (value / max) * 100 : 0;
  return (
    <div
      className="w-3 rounded-t flex items-end"
      style={{ height: '100%' }}
      title={tip}
    >
      <div
        className={cn(
          'w-full rounded-t transition-all',
          tone === 'gold' ? 'bg-gold' : 'bg-silver/40'
        )}
        style={{ height: `${h}%` }}
      />
    </div>
  );
}

