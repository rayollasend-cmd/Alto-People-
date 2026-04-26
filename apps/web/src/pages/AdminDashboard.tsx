import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, type LucideIcon } from 'lucide-react';
import type { DashboardKPIs } from '@alto-people/shared';
import { useAuth } from '@/lib/auth';
import { ROLE_LABELS } from '@/lib/roles';
import { MODULES } from '@/lib/modules';
import { getDashboardKPIs } from '@/lib/analyticsApi';
import { ApiError } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { Badge } from '@/components/ui/Badge';
import { cn } from '@/lib/cn';

const fmtMoney = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

interface KpiCard {
  label: string;
  value: string;
  hint?: string;
}

function buildKpis(k: DashboardKPIs): KpiCard[] {
  return [
    {
      label: 'Active associates',
      value: k.activeAssociates.toString(),
      hint: `${k.associatesClockedIn} clocked in now`,
    },
    {
      label: 'Open shifts (30d)',
      value: k.openShiftsNext30d.toString(),
    },
    {
      label: 'Pending onboarding',
      value: k.pendingOnboardingApplications.toString(),
      hint: `${k.pendingI9Section2} I-9 awaiting Section 2`,
    },
    {
      label: 'Net paid (30d)',
      value: fmtMoney(k.netPaidLast30d),
      hint:
        k.netPendingDisbursement > 0
          ? `${fmtMoney(k.netPendingDisbursement)} pending`
          : undefined,
    },
  ];
}

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
 * HR / Ops / Exec / Finance / Recruiter / Portal dashboard. Surfaces
 * org-level KPIs from /analytics/dashboard, the onboarding status
 * histogram, and a module grid for navigation.
 */
export function AdminDashboard() {
  const { role, can } = useAuth();
  const accessible = MODULES.filter((m) => can(m.requires));
  const [kpis, setKpis] = useState<DashboardKPIs | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await getDashboardKPIs();
        if (!cancelled) setKpis(res);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : 'Failed to load KPIs.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="max-w-6xl mx-auto">
      <header className="mb-8">
        <h1 className="font-display text-4xl md:text-5xl text-white mb-2 leading-tight">
          Dashboard
        </h1>
        <p className="text-silver">
          Welcome back. You are signed in as{' '}
          <span className="text-gold">{role ? ROLE_LABELS[role] : ''}</span>.
        </p>
      </header>

      {error && (
        <div className="mb-4 p-3 rounded-md border border-alert/40 bg-alert/10 text-alert text-sm" role="alert">
          {error}
        </div>
      )}

      <section
        aria-label="Key performance indicators"
        className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4 mb-10"
      >
        {kpis ? (
          buildKpis(kpis).map((kpi) => <KpiTile key={kpi.label} kpi={kpi} />)
        ) : (
          Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="pt-5">
                <Skeleton className="h-3 w-2/3 mb-3" />
                <Skeleton className="h-8 w-1/2 mb-2" />
                <Skeleton className="h-3 w-1/3" />
              </CardContent>
            </Card>
          ))
        )}
      </section>

      {kpis && Object.keys(kpis.applicationStatusCounts).length > 0 && (
        <section className="mb-10">
          <h2 className="font-display text-2xl text-white mb-3">
            Onboarding pipeline
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
            {Object.entries(kpis.applicationStatusCounts).map(([status, count]) => (
              <Card key={status}>
                <CardContent className="pt-4">
                  <Badge variant={STATUS_VARIANT[status] ?? 'default'} className="mb-2">
                    {status.replace(/_/g, ' ')}
                  </Badge>
                  <div className="font-display text-2xl text-gold tabular-nums">
                    {count}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="font-display text-2xl md:text-3xl text-white mb-4">
          Your modules
        </h2>
        {accessible.length === 0 ? (
          <p className="text-silver">
            No modules are accessible to your role.
          </p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {accessible.map((m) => (
              <ModuleCard
                key={m.key}
                to={m.path}
                icon={m.icon}
                label={m.label}
                description={m.description}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function KpiTile({ kpi }: { kpi: KpiCard }) {
  return (
    <Card>
      <CardContent className="pt-5">
        <div className="text-[10px] md:text-xs uppercase tracking-widest text-silver">
          {kpi.label}
        </div>
        <div className="font-display text-3xl md:text-4xl text-gold mt-2 leading-none tabular-nums">
          {kpi.value}
        </div>
        {kpi.hint && <div className="text-xs text-silver/70 mt-2">{kpi.hint}</div>}
      </CardContent>
    </Card>
  );
}

function ModuleCard({
  to,
  icon: Icon,
  label,
  description,
}: {
  to: string;
  icon: LucideIcon;
  label: string;
  description: string;
}) {
  return (
    <Link
      to={to}
      className={cn(
        'group block bg-navy border border-navy-secondary rounded-lg p-5 transition-all',
        'hover:border-gold/50 hover:bg-navy/80 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-gold/5',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright focus-visible:ring-offset-2 focus-visible:ring-offset-midnight'
      )}
    >
      <div className="flex items-start justify-between mb-3">
        <div className="h-10 w-10 rounded-lg bg-gold/10 grid place-items-center text-gold group-hover:bg-gold/20 transition-colors">
          <Icon className="h-5 w-5" aria-hidden="true" />
        </div>
        <ArrowRight className="h-4 w-4 text-silver/40 group-hover:text-gold group-hover:translate-x-0.5 transition-all" />
      </div>
      <div className="font-display text-xl text-white mb-1 group-hover:text-gold transition-colors">
        {label}
      </div>
      <div className="text-sm text-silver leading-relaxed">{description}</div>
    </Link>
  );
}
