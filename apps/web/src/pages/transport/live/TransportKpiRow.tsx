import type { TransportKpi, TransportKpiId } from '@alto-people/shared';
import { cn } from '@/lib/cn';
import { useTransportOps } from '@/lib/transportOpsApi';
import { Skeleton } from '@/components/ui/Skeleton';
import { QueryError } from '@/components/ui/QueryError';
import '@/lib/i18n/en/fleetOps';
import { useFleetT } from './fleetT';
import { TransportKpiCard } from './TransportKpiCard';

/** On-time, seat use, cost per ride and no-show rate — the last 7 days against the 7 before (GET /transport/ops kpis). */
const ORDER: TransportKpiId[] = ['onTime', 'utilization', 'costPerRide', 'noShowRate'];

export function orderKpis(kpis: TransportKpi[]): TransportKpi[] {
  return [...kpis].sort((a, b) => {
    const ia = ORDER.indexOf(a.id);
    const ib = ORDER.indexOf(b.id);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
}

export function TransportKpiRow({ date, className }: { date: string | null; className?: string }) {
  const t = useFleetT();
  const ops = useTransportOps(date);
  const grid = cn('grid grid-cols-2 gap-3 lg:grid-cols-4', className);
  if (ops.isLoading)
    return (
      <div className={grid} aria-busy="true" aria-label={t('fleetOps.kpi.region')}>
        {ORDER.map((id) => (
          <Skeleton key={id} className="h-36" />
        ))}
      </div>
    );
  if (ops.isError) return <QueryError what={t('fleetOps.kpi.what')} query={ops} className={className} />;
  const kpis = orderKpis(ops.data?.kpis ?? []);
  if (kpis.length === 0) return null;
  return (
    <section aria-label={t('fleetOps.kpi.region')} className={grid} data-testid="transport-kpi-row">
      {kpis.map((k) => (
        <TransportKpiCard key={k.id} kpi={k} />
      ))}
    </section>
  );
}
