import { rideAlert, useNewKeys, type RideAlert } from '@/lib/rideAlerts';
import type { MyLiveRide, MyTransport } from '@/lib/transportApi';

/**
 * The rider's ride-hailing moments, felt and heard the moment they happen:
 * a driver accepted the seat, the van is ~10 minutes out, the van is here,
 * they're on board. Each fires once per ride — never on opening the page.
 */
const ORDER: RideAlert[] = ['arrived', 'near', 'confirmed', 'aboard'];

export function useRiderAlerts(data: MyTransport | undefined, live: MyLiveRide | null): void {
  const keys = data
    ? [
        ...data.rides.flatMap((r) => [
          ...(r.run ? [`confirmed:${r.id}`] : []),
          ...(r.vanArrivedAt ? [`arrived:${r.id}`] : []),
          ...(r.status === 'BOARDED' ? [`aboard:${r.id}`] : []),
        ]),
        ...(live?.runStatus === 'ACTIVE' &&
        live.status === 'SCHEDULED' &&
        live.pickup.etaAt &&
        Date.parse(live.pickup.etaAt) - Date.now() <= 10 * 60_000
          ? [`near:${live.rideId}`]
          : []),
        ...(live?.vanArrivedAt ? [`arrived:${live.rideId}`] : []),
      ]
    : null;
  useNewKeys(keys, (fresh) => {
    const kinds = new Set(fresh.map((k) => k.split(':')[0] as RideAlert));
    const top = ORDER.find((k) => kinds.has(k));
    if (top) rideAlert(top);
  });
}
