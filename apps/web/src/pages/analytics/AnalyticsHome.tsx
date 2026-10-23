import { lazy, Suspense } from 'react';
import { useTenant, useTerm } from '@/lib/auth';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  Building2,
  Calendar,
  ClipboardList,
  DollarSign,
  Download,
  ShieldCheck,
} from 'lucide-react';
import type { DashboardKPIs, KpiTrend } from '@alto-people/shared';
import { PALETTE } from '@/components/ui/charts/palette';
import { getDashboardKPIs } from '@/lib/analyticsApi';
import { downloadCsv } from '@/lib/csv';
import { fmtMoney, ymdLocal } from '@/lib/format';
import { urlNumber, useUrlState, type UrlCodec } from '@/lib/useUrlState';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/Card';
import type { DonutDatum } from '@/components/ui/DonutChart';
import { MetricCard, type MetricDelta, type TrendGood } from '@/components/ui/MetricCard';
import { MetricStrip } from '@/components/ui/MetricStrip';
import { QueryError } from '@/components/ui/QueryError';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { ListTemplate } from '@/components/templates';
import { Skeleton } from '@/components/ui/Skeleton';

// Recharts is ~290 KB. Defer it so the page paints first and the chart
// streams in after — most users see the metric cards above the chart
// before the donut is even on screen.
const DonutChart = lazy(() =>
  import('@/components/ui/DonutChart').then((m) => ({ default: m.DonutChart })),
);

/**
 * Brand-aligned color per application status. Drives the donut chart and
 * any legend/tooltip downstream. Order also defines display order in the
 * donut/legend (largest-impact-on-pipeline first).
 */
const STATUS_ORDER: readonly string[] = [
  'APPROVED',
  'IN_REVIEW',
  'SUBMITTED',
  'DRAFT',
  'REJECTED',
  'CANCELLED',
] as const;
/** "IN_REVIEW" → "In review": the fallback for a status the label map has not met yet. */
function sentenceCase(code: string): string {
  const words = code.toLowerCase().replace(/_/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
const STATUS_LABELS: Record<string, string> = {
  APPROVED: 'Approved',
  IN_REVIEW: 'In review',
  SUBMITTED: 'Submitted',
  DRAFT: 'Draft',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
};
// The kit's tokens (CSS variables), so the donut follows the theme. The
// statuses are states, so the reserved state colors carry them.
const STATUS_COLORS: Record<string, string> = {
  APPROVED: PALETTE.good,
  IN_REVIEW: PALETTE.warn,
  SUBMITTED: PALETTE.primary,
  DRAFT: PALETTE.other,
  REJECTED: PALETTE.bad,
  // Called off, not a verdict — muted, never red.
  CANCELLED: PALETTE.info,
};

const WINDOW_PRESETS = [7, 30, 60, 90] as const;
/** ?days= is one of the presets; anything else reads as the default 30. */
const WINDOW_CODEC: UrlCodec<number> = {
  parse: (raw) => {
    const n = urlNumber({ integer: true }).parse(raw);
    return n !== undefined && (WINDOW_PRESETS as readonly number[]).includes(n) ? n : undefined;
  },
  serialize: (n) => String(n),
};

/**
 * Phase 38 — dedicated reports view. Same data as the dashboard's KPI
 * tiles, presented denser, with CSV export, a window selector for the
 * time-bounded metrics, and drill-in links from each KPI to its source
 * page. Retention, hiring cohorts and turnover by store live on People
 * analytics (one home, one definition — F500 G4); this page links there.
 */
export function AnalyticsHome() {
  const term = useTerm();
  const hasClients = useTenant().moduleOn('clientPortal');
  const workers = term('workers');
  // The window lives in the URL (?days=7): Back, a reload and a shared link keep it.
  const [days, setDays] = useUrlState<number>('days', 30, WINDOW_CODEC);

  const kpisQuery = useQuery({
    queryKey: ['AnalyticsHome', 'kpis', days],
    queryFn: () => getDashboardKPIs(days),
  });
  const kpis: DashboardKPIs | null = kpisQuery.data ?? null;
  const activeDays = kpis?.activeWindowDays ?? 14;

  const exportCsv = () => {
    if (!kpis) return;
    // Shared RFC-4180 helper + local calendar date in the filename
    // (toISOString is UTC and rolls to tomorrow for evening users).
    downloadCsv(`alto-analytics-${ymdLocal()}.csv`, [
      ['Metric', 'Value'],
      ['Window (days)', kpis.windowDays],
      ...(kpis.onTheBooks !== undefined ? [['On the books', kpis.onTheBooks] as [string, number]] : []),
      [`Working (${activeDays} days)`, kpis.activeAssociates],
      [`${workers} clocked in`, kpis.associatesClockedIn],
      [`Open shifts (next ${kpis.windowDays}d)`, kpis.openShiftsNext30d],
      ['Pending onboarding applications', kpis.pendingOnboardingApplications],
      ['Pending I-9 Section 2', kpis.pendingI9Section2],
      ['Pending document reviews', kpis.pendingDocumentReviews],
      [`Net paid (last ${kpis.windowDays}d) USD`, kpis.netPaidLast30d.toFixed(2)],
      ['Net pending disbursement USD', kpis.netPendingDisbursement.toFixed(2)],
      ...Object.entries(kpis.applicationStatusCounts).map(
        ([status, count]) => [`Applications: ${STATUS_LABELS[status] ?? status}`, count],
      ),
    ]);
  };

  return (
    // Design system §4.2 (UX upgrade step 6, the sweep): the List template.
    <ListTemplate
      title="Analytics"
      subtitle={hasClients ? 'Live operational and financial KPIs across all clients.' : 'Live operational and financial KPIs across the organization.'}
      actions={[{ label: 'Export CSV', icon: Download, onSelect: exportCsv, disabled: !kpis }]}
      related={[{ label: 'People analytics: retention, cohorts and turnover', to: '/reports/people' }]}
      filters={
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
          <span className="text-silver">Window</span>
          <SegmentedControl
            ariaLabel="Reporting window"
            value={days}
            onChange={(d) => setDays(d)}
            options={WINDOW_PRESETS.map((d) => ({ value: d, label: `${d}d` }))}
          />
          <span className="basis-full text-xs text-silver/80 sm:basis-auto">
            Applies to shifts and pay. Headcount and backlogs are as of now.
          </span>
        </div>
      }
    >
      {kpisQuery.isError && !kpis ? (
        <QueryError what="analytics" query={kpisQuery} />
      ) : (
        <>
          <Section title="Workforce" icon={Building2} description="Headcount and live presence.">
            {kpis ? (
              <MetricStrip label="Workforce">
                {/* The two named numbers every page shows (apps/api/src/lib/peopleStatus.ts):
                    "On the books" and "Working", each with its definition. */}
                {kpis.onTheBooks !== undefined && (
                  <MetricCard label="On the books" value={kpis.onTheBooks.toString()} hint="Hired and not separated" href="/people" />
                )}
                <MetricCard
                  label={`Working (${activeDays} days)`}
                  value={kpis.activeAssociates.toString()}
                  hint={`Placed, and worked in the last ${activeDays} days or has a shift ahead`}
                  href="/people?workStatus=ACTIVE"
                />
                <MetricCard
                  label="Clocked in right now"
                  value={kpis.associatesClockedIn.toString()}
                  hint={
                    kpis.activeAssociates > 0
                      ? `${Math.round((kpis.associatesClockedIn / kpis.activeAssociates) * 100)}% of those working`
                      : undefined
                  }
                  href="/time-attendance"
                />
                {kpis.trends?.hoursWorked && (
                  <MetricCard
                    label="Hours worked · last week"
                    value={fmtHours(lastComplete(kpis.trends.hoursWorked))}
                    hint={`${fmtHours(kpis.trends.hoursWorked.series.at(-1) ?? 0)} so far this week`}
                    href="/time-attendance"
                    delta={weekly(kpis.trends.hoursWorked, 'vs the week before', 'neutral', fmtHours)}
                  />
                )}
              </MetricStrip>
            ) : (
              <SkeletonGrid count={4} />
            )}
          </Section>

          <Section title="Scheduling" icon={Calendar} description="Shifts ahead.">
            {kpis ? (
              <MetricStrip label="Scheduling">
                <MetricCard
                  label={`Open shifts (next ${kpis.windowDays}d)`}
                  value={kpis.openShiftsNext30d.toString()}
                  hint={`Shifts without an assigned ${term('worker').toLowerCase()}`}
                  href="/scheduling"
                />
                {kpis.trends?.shiftsScheduled && (
                  <MetricCard
                    label="Shifts scheduled · last week"
                    value={lastComplete(kpis.trends.shiftsScheduled).toLocaleString()}
                    hint={`${(kpis.trends.shiftsScheduled.series.at(-1) ?? 0).toLocaleString()} on this week's schedule`}
                    href="/scheduling"
                    delta={weekly(kpis.trends.shiftsScheduled, 'vs the week before', 'neutral')}
                  />
                )}
              </MetricStrip>
            ) : (
              <SkeletonGrid count={2} />
            )}
          </Section>

          <Section title="Payroll" icon={DollarSign} description="Money in, money out.">
            {kpis ? (
              <MetricStrip label="Payroll">
                <MetricCard
                  label={`Net paid (last ${kpis.windowDays}d)`}
                  value={fmtMoney(kpis.netPaidLast30d)}
                  hint="Net pay on every disbursed paystub"
                  href="/payroll"
                />
                <MetricCard
                  label="Net pending disbursement"
                  value={fmtMoney(kpis.netPendingDisbursement)}
                  hint="On draft and finalized runs"
                  href="/payroll"
                />
              </MetricStrip>
            ) : (
              <SkeletonGrid count={2} />
            )}
          </Section>

          <Section title="Onboarding & compliance" icon={ShieldCheck} description="What needs HR's attention.">
            {kpis ? (
              <>
                <MetricStrip label="Onboarding and compliance" className="mb-4">
                  <MetricCard
                    label="Pending applications"
                    value={kpis.pendingOnboardingApplications.toString()}
                    tone={kpis.pendingOnboardingApplications > 0 ? 'warning' : 'default'}
                    href="/onboarding"
                    delta={weekly(kpis.trends?.applications, 'new vs the week before', 'neutral')}
                  />
                  <MetricCard
                    label="I-9 Section 2 backlog"
                    value={kpis.pendingI9Section2.toString()}
                    tone={kpis.pendingI9Section2 > 0 ? 'warning' : 'default'}
                    href="/compliance"
                  />
                  <MetricCard
                    label="Documents to review"
                    value={kpis.pendingDocumentReviews.toString()}
                    tone={kpis.pendingDocumentReviews > 0 ? 'warning' : 'default'}
                    href="/documents"
                  />
                </MetricStrip>
                {Object.keys(kpis.applicationStatusCounts).length > 0 && (
                  <Card>
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2 text-base">
                        <ClipboardList className="h-4 w-4 text-silver/80" />
                        Application status breakdown
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <Suspense fallback={<Skeleton className="h-64" />}>
                        <DonutChart centerSublabel="Applications" data={buildStatusBreakdown(kpis.applicationStatusCounts)} />
                      </Suspense>
                    </CardContent>
                  </Card>
                )}
              </>
            ) : (
              // Three KPI tiles + the donut placeholder — without the
              // chart skeleton the page height jumps ~280px when data
              // lands and the donut renders.
              <>
                <SkeletonGrid count={3} />
                <Skeleton className="h-64 mt-4 rounded-lg" />
              </>
            )}
          </Section>
        </>
      )}

      <p className="text-xs text-silver/70 mt-8">
        <Activity className="h-3 w-3 inline mr-1 -mt-0.5" />
        Numbers are live — refresh to recompute.
      </p>
    </ListTemplate>
  );
}

interface SectionProps {
  title: string;
  icon: typeof Activity;
  description?: string;
  children: React.ReactNode;
}

function Section({ title, icon: Icon, description, children }: SectionProps) {
  return (
    <section className="mb-6">
      <div className="flex items-center gap-2 mb-3">
        <Icon className="h-4 w-4 text-silver/80" aria-hidden="true" />
        <h2 className="text-xl text-white">{title}</h2>
      </div>
      {description && <p className="text-xs text-silver mb-3">{description}</p>}
      {children}
    </section>
  );
}

const fmtHours = (n: number) => `${Math.round(n).toLocaleString()}h`;

/** The last complete week (the final bucket is the week in progress). */
function lastComplete(t: KpiTrend): number {
  return t.series[t.series.length - 2] ?? 0;
}

/**
 * The API's weekly series as a change in words ("↑ 3 vs the week before"):
 * the last complete week against the one before. No sparkline: eight
 * undated points told no one which weeks they were (F500 G4).
 */
function weekly(
  t: KpiTrend | undefined,
  label: string,
  good: TrendGood,
  format?: (n: number) => string,
): MetricDelta | undefined {
  return t && t.series.length >= 3 ? { value: t.delta, label, good, format } : undefined;
}

/**
 * Map the API's status→count map into a donut-chart input. Statuses
 * listed in STATUS_ORDER come first in their declared order; any
 * unrecognized statuses get appended after with a fallback color/label
 * so a future enum addition still renders.
 */
function buildStatusBreakdown(counts: Record<string, number>): DonutDatum[] {
  const out: DonutDatum[] = [];
  const seen = new Set<string>();
  for (const status of STATUS_ORDER) {
    const value = counts[status] ?? 0;
    if (value > 0) {
      out.push({ name: STATUS_LABELS[status] ?? status, value, color: STATUS_COLORS[status] });
      seen.add(status);
    }
  }
  for (const [status, value] of Object.entries(counts)) {
    if (seen.has(status) || value <= 0) continue;
    out.push({ name: STATUS_LABELS[status] ?? sentenceCase(status), value });
  }
  return out;
}

function SkeletonGrid({ count = 2 }: { count?: number }) {
  // The same columns MetricStrip lays tiles in: two a row on a phone, up to four from lg.
  const cols = count >= 4 ? 'lg:grid-cols-4' : count === 3 ? 'lg:grid-cols-3' : '';
  return (
    <div className={`grid grid-cols-2 ${cols} gap-2 sm:gap-3`}>
      {Array.from({ length: count }).map((_, i) => (
        <Card key={i}>
          <CardContent>
            <Skeleton className="h-3 w-2/3 mb-3" />
            <Skeleton className="h-8 w-1/2 mb-2" />
            <Skeleton className="h-3 w-1/3" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
