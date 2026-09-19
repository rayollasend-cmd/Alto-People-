import { useQuery } from '@tanstack/react-query';
import { Bus } from 'lucide-react';
import { fmtRelativeDayTz, fmtTimeTz } from '@/lib/format';
import { getVanArrivals, type VanArrival } from '@/lib/transportApi';
import { Badge } from '@/components/ui/Badge';
import { Card, CardContent } from '@/components/ui/Card';
import { cn } from '@/lib/cn';

/**
 * The store supervisor's heads-up: who's coming in on an Alto van, and
 * when. Associates book their own rides, independent of the schedule — so
 * this flags anyone arriving without a shift here. Heads-up only; nothing
 * to decide. Hidden when nobody's coming.
 */
export function VanArrivalsCard({ className }: { className?: string }) {
  const q = useQuery({
    queryKey: ['transport', 'arrivals'],
    queryFn: () => getVanArrivals(),
    refetchInterval: 120_000,
    retry: false,
  });
  const now = Date.now();
  const rows = (q.data?.arrivals ?? []).filter(
    (a) => a.status !== 'COMPLETED' || now - new Date(a.arriveBy).getTime() < 3_600_000,
  );
  if (rows.length === 0) return null;
  const stores = new Set(rows.map((a) => a.store.id)).size;
  const noShift = rows.filter((a) => !a.hasShift).length;
  return (
    <Card className={cn('animate-enter', className)}>
      <CardContent className="p-5">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="flex items-center gap-1.5 text-sm font-medium text-white">
            <Bus className="h-4 w-4 text-gold" aria-hidden="true" />
            Arriving by van <span className="tabular-nums text-silver">· {rows.length}</span>
          </h2>
          {noShift > 0 && (
            <span className="text-xs text-warning">
              {noShift} without a shift here
            </span>
          )}
        </div>
        <ul className="mt-3 divide-y divide-navy-secondary/60">
          {rows.map((a) => (
            <ArrivalRow key={a.rideId} a={a} showStore={stores > 1} />
          ))}
        </ul>
        <p className="mt-2 text-xs text-silver/70">Associates book their own rides — this is a heads-up, not a request.</p>
      </CardContent>
    </Card>
  );
}

function ArrivalRow({ a, showStore }: { a: VanArrival; showStore: boolean }) {
  const onVan = a.status === 'BOARDED';
  const arrived = a.status === 'COMPLETED';
  return (
    <li className="flex items-start gap-3 py-2">
      <span className="w-20 shrink-0 text-sm tabular-nums text-white">
        {fmtTimeTz(a.arriveBy)}
        {fmtRelativeDayTz(a.arriveBy) !== fmtRelativeDayTz(new Date()) && (
          <span className="block text-2xs text-silver">{fmtRelativeDayTz(a.arriveBy)}</span>
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-white">{a.name}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-xs text-silver">
            {a.van ?? 'Waiting on a van'}
            {showStore ? ` · ${a.store.name}` : ''}
          </span>
          <Badge size="sm" variant={arrived || onVan ? 'success' : a.van ? 'accent' : 'default'}>
            {arrived ? 'Arrived' : onVan ? 'On the van' : a.van ? 'Van set' : 'Booked'}
          </Badge>
          {!a.hasShift && (
            <Badge size="sm" variant="pending">
              No shift
            </Badge>
          )}
        </div>
      </div>
    </li>
  );
}
