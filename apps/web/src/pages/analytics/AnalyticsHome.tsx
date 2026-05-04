import { lazy, Suspense, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  Building2,
  Calendar,
  ClipboardList,
  DollarSign,
  Download,
  ShieldCheck,
} from 'lucide-react';
import type { DashboardKPIs } from '@alto-people/shared';
import { getDashboardKPIs } from '@/lib/analyticsApi';
import { ApiError } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/Card';
import type { DonutDatum } from '@/components/ui/DonutChart';

// Recharts is ~290 KB. Defer it so the page paints first and the chart
// streams in after — most users see the metric cards above the chart
// before the donut is even on screen.
const DonutChart = lazy(() =>
  import('@/components/ui/DonutChart').then((m) => ({ default: m.DonutChart })),
);
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { MetricCard } from '@/components/ui/MetricCard';
import { PageHeader } from '@/components/ui/PageHeader';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Skeleton } from '@/components/ui/Skeleton';

const fmtMoney = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

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
] as const;
const STATUS_LABELS: Record<string, string> = {
  APPROVED: 'Approved',
  IN_REVIEW: 'In review',
  SUBMITTED: 'Submitted',
  DRAFT: 'Draft',
  REJECTED: 'Rejected',
};
const STATUS_COLORS: Record<string, string> = {
  APPROVED: '#34A874', // success green
  IN_REVIEW: '#EDB23C', // warning amber
  SUBMITTED: '#D9B967', // brand gold
  DRAFT: '#A8B8C8', // silver
  REJECTED: '#E96255', // alert red
};

const WINDOW_PRESETS = [7, 30, 60, 90] as const;
type WindowDays = (typeof WINDOW_PRESETS)[number];

/**
 * Phase 38 — dedicated reports view. Same data as the dashboard's KPI
 * tiles, presented denser, with CSV export, a window selector for the
 * time-bounded metrics, and drill-in links from each KPI to its source
 * page.
 */
export function AnalyticsHome() {
  const [kpis, setKpis] = useState<DashboardKPIs | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState<WindowDays>(30);

  useEffect(() => {
    let cancelled = false;
    setKpis(null);
    setError(null);
    getDashboardKPIs(days)
      .then((res) => !cancelled && setKpis(res))
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : 'Could not load KPIs.');
      });
    return () => {
      cancelled = true;
    };
  }, [days]);

  const downloadCsv = () => {
    if (!kpis) return;
    const lines: string[] = [];
    lines.push('Metric,Value');
    lines.push(`Window (days),${kpis.windowDays}`);
    lines.push(`Active associates,${kpis.activeAssociates}`);
    lines.push(`Associates clocked in,${kpis.associatesClockedIn}`);
    lines.push(`Open shifts (next ${kpis.windowDays}d),${kpis.openShiftsNext30d}`);
    lines.push(`Pending onboarding applications,${kpis.pendingOnboardingApplications}`);
    lines.push(`Pending I-9 Section 2,${kpis.pendingI9Section2}`);
    lines.push(`Pending document reviews,${kpis.pendingDocumentReviews}`);
    lines.push(`Net paid (last ${kpis.windowDays}d) USD,${kpis.netPaidLast30d.toFixed(2)}`);
    lines.push(`Net pending disbursement USD,${kpis.netPendingDisbursement.toFixed(2)}`);
    for (const [status, count] of Object.entries(kpis.applicationStatusCounts)) {
      lines.push(`Applications: ${status},${count}`);
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `alto-analytics-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="max-w-6xl mx-auto">
      <PageHeader
        title="Analytics"
        subtitle="Live operational and financial KPIs across all clients."
        primaryAction={
          <Button onClick={downloadCsv} variant="secondary" disabled={!kpis}>
            <Download className="h-4 w-4" />
            Export CSV
          </Button>
        }
      />

      <div className="flex items-center gap-2 mb-6 text-sm">
        <span className="text-silver">Window:</span>
        <SegmentedControl
          ariaLabel="Reporting window"
          value={days}
          onChange={(d) => setDays(d as WindowDays)}
          options={WINDOW_PRESETS.map((d) => ({ value: d, label: `${d}d` }))}
        />
        <span className="text-xs text-silver/60 ml-2">
          (Affects scheduling & payroll metrics. Headcount, backlogs, and
          status counts are point-in-time.)
        </span>
      </div>

      {error && <ErrorBanner className="mb-4">{error}</ErrorBanner>}

      <Section
        title="Workforce"
        icon={Building2}
        description="Headcount and live presence."
      >
        {kpis ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Stat
              label="Active associates"
              value={kpis.activeAssociates.toString()}
              link="/clients"
            />
            <Stat
              label="Clocked in right now"
              value={kpis.associatesClockedIn.toString()}
              hint={
                kpis.activeAssociates > 0
                  ? `${Math.round((kpis.associatesClockedIn / kpis.activeAssociates) * 100)}% of active`
                  : undefined
              }
              link="/time-attendance"
            />
          </div>
        ) : (
          <SkeletonGrid />
        )}
      </Section>

      <Section title="Scheduling" icon={Calendar} description="Shifts ahead.">
        {kpis ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Stat
              label={`Open shifts (next ${kpis.windowDays}d)`}
              value={kpis.openShiftsNext30d.toString()}
              hint="Shifts without an assigned associate"
              link="/scheduling"
            />
          </div>
        ) : (
          <SkeletonGrid />
        )}
      </Section>

      <Section
        title="Payroll"
        icon={DollarSign}
        description="Money in, money out."
      >
        {kpis ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Stat
              label={`Net paid (last ${kpis.windowDays}d)`}
              value={fmtMoney(kpis.netPaidLast30d)}
              hint="Sum of NET on every DISBURSED paystub"
              link="/payroll"
            />
            <Stat
              label="Net pending disbursement"
              value={fmtMoney(kpis.netPendingDisbursement)}
              hint="On DRAFT + FINALIZED runs"
              link="/payroll"
            />
          </div>
        ) : (
          <SkeletonGrid />
        )}
      </Section>

      <Section
        title="Onboarding & compliance"
        icon={ShieldCheck}
        description="What needs HR's attention."
      >
        {kpis ? (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
              <Stat
                label="Pending applications"
                value={kpis.pendingOnboardingApplications.toString()}
                accent={kpis.pendingOnboardingApplications > 0}
                link="/onboarding"
              />
              <Stat
                label="I-9 Section 2 backlog"
                value={kpis.pendingI9Section2.toString()}
                accent={kpis.pendingI9Section2 > 0}
                link="/compliance"
              />
              <Stat
                label="Documents to review"
                value={kpis.pendingDocumentReviews.toString()}
                accent={kpis.pendingDocumentReviews > 0}
                link="/documents"
              />
            </div>
            {Object.keys(kpis.applicationStatusCounts).length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <ClipboardList className="h-4 w-4 text-gold" />
                    Application status breakdown
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <Suspense fallback={<Skeleton className="h-64" />}>
                    <DonutChart
                      centerSublabel="Applications"
                      data={buildStatusBreakdown(kpis.applicationStatusCounts)}
                    />
                  </Suspense>
                </CardContent>
              </Card>
            )}
          </>
        ) : (
          <SkeletonGrid count={3} />
        )}
      </Section>

      <p className="text-xs text-silver/60 mt-8">
        <Activity className="h-3 w-3 inline mr-1 -mt-0.5" />
        Numbers are live — refresh to recompute.
      </p>
    </div>
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
        <Icon className="h-4 w-4 text-gold" aria-hidden="true" />
        <h2 className="font-display text-xl text-white">{title}</h2>
      </div>
      {description && <p className="text-xs text-silver mb-3">{description}</p>}
      {children}
    </section>
  );
}

interface StatProps {
  label: string;
  value: string;
  hint?: string;
  accent?: boolean;
  link?: string;
}

function Stat({ label, value, hint, accent, link }: StatProps) {
  return (
    <MetricCard
      label={label}
      value={value}
      hint={hint}
      accent={accent}
      wrap={link ? (card) => <Link to={link}>{card}</Link> : undefined}
    />
  );
}

/**
 * Map the API's status→count map into a donut-chart input. Statuses
 * listed in STATUS_ORDER come first in their declared order; any
 * unrecognized statuses get appended after with a fallback color/label
 * so a future enum addition still renders.
 */
function buildStatusBreakdown(
  counts: Record<string, number>,
): DonutDatum[] {
  const out: DonutDatum[] = [];
  const seen = new Set<string>();
  for (const status of STATUS_ORDER) {
    const value = counts[status] ?? 0;
    if (value > 0) {
      out.push({
        name: STATUS_LABELS[status] ?? status,
        value,
        color: STATUS_COLORS[status],
      });
      seen.add(status);
    }
  }
  for (const [status, value] of Object.entries(counts)) {
    if (seen.has(status) || value <= 0) continue;
    out.push({
      name: status.replace(/_/g, ' '),
      value,
    });
  }
  return out;
}

function SkeletonGrid({ count = 2 }: { count?: number }) {
  return (
    <div className={`grid grid-cols-1 sm:grid-cols-${Math.min(count, 3)} gap-3`}>
      {Array.from({ length: count }).map((_, i) => (
        <Card key={i}>
          <CardContent className="pt-5">
            <Skeleton className="h-3 w-2/3 mb-3" />
            <Skeleton className="h-8 w-1/2 mb-2" />
            <Skeleton className="h-3 w-1/3" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
