import { useEffect, useState } from 'react';
import { TrendingUp, TrendingDown, Users, Activity, ArrowDown, ArrowUp } from 'lucide-react';
import {
  getHeadcountSnapshot,
  getTurnover,
  type HeadcountSnapshot,
  type TurnoverSummary,
} from '@/lib/headcount110Api';
import {
  Card,
  CardContent,
  PageHeader,
  SkeletonRows,
} from '@/components/ui';

/**
 * Phase 110 — Headcount & turnover dashboard.
 *
 * KPI cards on top (total, hires, terminations, turnover %), then
 * three breakdown panels: by department, by client, by employment
 * type. All bars are inline SVG so we don't pull in a chart lib.
 */
export function HeadcountHome() {
  const [snap, setSnap] = useState<HeadcountSnapshot | null>(null);
  const [turn, setTurn] = useState<TurnoverSummary | null>(null);
  const [days, setDays] = useState<30 | 90 | 365>(90);

  useEffect(() => {
    getHeadcountSnapshot().then(setSnap).catch(() => setSnap(null));
  }, []);
  useEffect(() => {
    setTurn(null);
    getTurnover(days).then(setTurn).catch(() => setTurn(null));
  }, [days]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Headcount & turnover"
        subtitle="Active associates, hires and separations across the company."
        breadcrumbs={[{ label: 'Headcount' }]}
      />

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <KpiCard
          label="Active headcount"
          value={snap?.total ?? null}
          icon={Users}
          accent="text-cyan-400"
        />
        <KpiCard
          label="Hires"
          sub={`Last ${days} days`}
          value={turn?.hires ?? null}
          icon={ArrowUp}
          accent="text-emerald-400"
        />
        <KpiCard
          label="Separations"
          sub={`Last ${days} days`}
          value={turn?.terminations ?? null}
          icon={ArrowDown}
          accent="text-rose-400"
        />
        <KpiCard
          label="Annualized turnover"
          sub={`Last ${days} days`}
          value={turn ? `${turn.annualizedTurnoverRate}%` : null}
          icon={turn && turn.annualizedTurnoverRate >= 25 ? TrendingUp : TrendingDown}
          accent={turn && turn.annualizedTurnoverRate >= 25 ? 'text-rose-400' : 'text-emerald-400'}
        />
      </div>

      <div className="flex items-center gap-2 text-sm">
        <span className="text-silver">Window:</span>
        {[30, 90, 365].map((d) => (
          <button
            key={d}
            onClick={() => setDays(d as 30 | 90 | 365)}
            className={`px-3 py-1 rounded-full border transition ${
              days === d
                ? 'bg-cyan-600 border-cyan-500 text-white'
                : 'bg-navy-secondary/40 border-navy-secondary text-silver hover:text-white'
            }`}
          >
            {d}d
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <BreakdownCard
          title="By department"
          rows={snap?.byDepartment.map((r) => ({ label: r.departmentName, count: r.count })) ?? null}
        />
        <BreakdownCard
          title="By client"
          rows={snap?.byClient.map((r) => ({ label: r.clientName, count: r.count })) ?? null}
        />
        <BreakdownCard
          title="By employment type"
          rows={snap?.byEmploymentType.map((r) => ({ label: r.employmentType, count: r.count })) ?? null}
        />
      </div>
    </div>
  );
}

function KpiCard({
  label,
  value,
  sub,
  icon: Icon,
  accent,
}: {
  label: string;
  value: string | number | null;
  sub?: string;
  icon: React.ComponentType<{ className?: string }>;
  accent: string;
}) {
  return (
    <Card>
      <CardContent>
        <div className="flex items-center justify-between">
          <div className="text-xs uppercase tracking-wider text-silver">{label}</div>
          <Icon className={`h-4 w-4 ${accent}`} />
        </div>
        <div className={`text-3xl font-display mt-2 ${accent}`}>
          {value === null ? '—' : value}
        </div>
        {sub && <div className="text-xs text-silver mt-1">{sub}</div>}
      </CardContent>
    </Card>
  );
}

function BreakdownCard({
  title,
  rows,
}: {
  title: string;
  rows: { label: string; count: number }[] | null;
}) {
  return (
    <Card>
      <CardContent>
        <div className="text-sm uppercase tracking-wider text-silver mb-3 flex items-center gap-2">
          <Activity className="h-4 w-4" />
          {title}
        </div>
        {rows === null ? (
          <SkeletonRows count={3} />
        ) : rows.length === 0 ? (
          <div className="text-sm text-silver">No data.</div>
        ) : (
          <div className="space-y-2">
            {rows.slice(0, 12).map((r) => {
              const max = Math.max(1, ...rows.map((x) => x.count));
              return (
                <div key={r.label} className="flex items-center gap-3 text-sm">
                  <div className="w-44 truncate text-silver">{r.label}</div>
                  <div className="flex-1 h-3 rounded bg-navy-secondary/40 overflow-hidden">
                    <div
                      className="h-full bg-cyan-500"
                      style={{ width: `${(r.count / max) * 100}%` }}
                    />
                  </div>
                  <div className="w-10 text-right text-white">{r.count}</div>
                </div>
              );
            })}
            {rows.length > 12 && (
              <div className="text-xs text-silver pt-1">
                +{rows.length - 12} more
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
