import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { DashboardKPIs } from '@alto-people/shared';
import { useAuth } from '@/lib/auth';
import { ROLE_LABELS } from '@/lib/roles';
import { MODULES } from '@/lib/modules';
import { getDashboardKPIs } from '@/lib/analyticsApi';
import { ApiError } from '@/lib/api';

const fmtMoney = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

interface KpiCard {
  label: string;
  value: string;
  hint?: string;
}

function buildKpis(k: DashboardKPIs | null): KpiCard[] {
  if (!k) {
    return [
      { label: 'Active associates', value: '—' },
      { label: 'Open shifts (30d)', value: '—' },
      { label: 'Pending onboarding', value: '—' },
      { label: 'Net paid (30d)', value: '—' },
    ];
  }
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

export function Dashboard() {
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

  const cards = buildKpis(kpis);

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
        <p role="alert" className="text-sm text-alert mb-4">
          {error}
        </p>
      )}

      <section
        aria-label="Key performance indicators"
        className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4 mb-10"
      >
        {cards.map((kpi) => (
          <div
            key={kpi.label}
            className="bg-navy border border-navy-secondary rounded-lg p-4 md:p-5"
          >
            <div className="text-[10px] md:text-xs uppercase tracking-widest text-silver">
              {kpi.label}
            </div>
            <div className="font-display text-3xl md:text-4xl text-gold mt-2 leading-none tabular-nums">
              {kpi.value}
            </div>
            {kpi.hint && (
              <div className="text-xs text-silver/70 mt-2">{kpi.hint}</div>
            )}
          </div>
        ))}
      </section>

      {kpis && Object.keys(kpis.applicationStatusCounts).length > 0 && (
        <section className="mb-10">
          <h2 className="font-display text-2xl text-white mb-3">
            Onboarding pipeline
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
            {Object.entries(kpis.applicationStatusCounts).map(([status, count]) => (
              <div
                key={status}
                className="bg-navy border border-navy-secondary rounded-lg p-3"
              >
                <div className="text-[10px] uppercase tracking-widest text-silver">
                  {status.replace(/_/g, ' ')}
                </div>
                <div className="font-display text-2xl text-gold mt-1 tabular-nums">
                  {count}
                </div>
              </div>
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
              <Link
                key={m.key}
                to={m.path}
                className="block bg-navy border border-navy-secondary rounded-lg p-5 hover:border-gold/40 transition group"
              >
                <div className="font-display text-xl text-gold mb-1 group-hover:text-gold-bright transition">
                  {m.label}
                </div>
                <div className="text-sm text-silver leading-relaxed">
                  {m.description}
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
