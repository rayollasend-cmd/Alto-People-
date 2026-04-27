import { useEffect, useState } from 'react';
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
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';

const fmtMoney = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

const STATUS_VARIANT: Record<
  string,
  'success' | 'pending' | 'destructive' | 'default' | 'accent'
> = {
  APPROVED: 'success',
  SUBMITTED: 'pending',
  IN_REVIEW: 'pending',
  DRAFT: 'default',
  REJECTED: 'destructive',
};

/**
 * Phase 38 — dedicated reports view. Same data as the dashboard's KPI
 * tiles, presented denser and with a CSV export of the raw numbers.
 * Future iterations: date range, per-client breakdowns, time-series.
 */
export function AnalyticsHome() {
  const [kpis, setKpis] = useState<DashboardKPIs | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getDashboardKPIs()
      .then((res) => !cancelled && setKpis(res))
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : 'Could not load KPIs.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const downloadCsv = () => {
    if (!kpis) return;
    const lines: string[] = [];
    lines.push('Metric,Value');
    lines.push(`Active associates,${kpis.activeAssociates}`);
    lines.push(`Associates clocked in,${kpis.associatesClockedIn}`);
    lines.push(`Open shifts (next 30d),${kpis.openShiftsNext30d}`);
    lines.push(`Pending onboarding applications,${kpis.pendingOnboardingApplications}`);
    lines.push(`Pending I-9 Section 2,${kpis.pendingI9Section2}`);
    lines.push(`Pending document reviews,${kpis.pendingDocumentReviews}`);
    lines.push(`Net paid (last 30d) USD,${kpis.netPaidLast30d.toFixed(2)}`);
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
      <header className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-4xl md:text-5xl text-white mb-2 leading-tight">
            Analytics
          </h1>
          <p className="text-silver">
            Live operational and financial KPIs across all clients.
          </p>
        </div>
        <Button onClick={downloadCsv} variant="secondary" disabled={!kpis}>
          <Download className="h-4 w-4" />
          Export CSV
        </Button>
      </header>

      {error && (
        <div
          className="mb-4 p-3 rounded-md border border-alert/40 bg-alert/10 text-alert text-sm"
          role="alert"
        >
          {error}
        </div>
      )}

      <Section
        title="Workforce"
        icon={Building2}
        description="Headcount and live presence."
      >
        {kpis ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Stat label="Active associates" value={kpis.activeAssociates.toString()} />
            <Stat
              label="Clocked in right now"
              value={kpis.associatesClockedIn.toString()}
              hint={
                kpis.activeAssociates > 0
                  ? `${Math.round((kpis.associatesClockedIn / kpis.activeAssociates) * 100)}% of active`
                  : undefined
              }
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
              label="Open shifts (next 30d)"
              value={kpis.openShiftsNext30d.toString()}
              hint="Shifts without an assigned associate"
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
              label="Net paid (last 30d)"
              value={fmtMoney(kpis.netPaidLast30d)}
              hint="Sum of NET on every DISBURSED paystub"
            />
            <Stat
              label="Net pending disbursement"
              value={fmtMoney(kpis.netPendingDisbursement)}
              hint="On DRAFT + FINALIZED runs"
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
              />
              <Stat
                label="I-9 Section 2 backlog"
                value={kpis.pendingI9Section2.toString()}
                accent={kpis.pendingI9Section2 > 0}
              />
              <Stat
                label="Documents to review"
                value={kpis.pendingDocumentReviews.toString()}
                accent={kpis.pendingDocumentReviews > 0}
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
                  <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                    {Object.entries(kpis.applicationStatusCounts).map(([status, count]) => (
                      <Card key={status}>
                        <CardContent className="pt-3 pb-3">
                          <Badge
                            variant={STATUS_VARIANT[status] ?? 'default'}
                            className="mb-1"
                          >
                            {status.replace(/_/g, ' ')}
                          </Badge>
                          <div className="font-display text-xl text-gold tabular-nums">
                            {count}
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
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
}

function Stat({ label, value, hint, accent }: StatProps) {
  return (
    <Card>
      <CardContent className="pt-5">
        <div className="text-[10px] uppercase tracking-widest text-silver">
          {label}
        </div>
        <div
          className={`font-display text-3xl mt-2 leading-none tabular-nums ${
            accent ? 'text-warning' : 'text-gold'
          }`}
        >
          {value}
        </div>
        {hint && <div className="text-xs text-silver/70 mt-2">{hint}</div>}
      </CardContent>
    </Card>
  );
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
