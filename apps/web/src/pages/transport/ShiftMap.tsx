import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { MapPin, MapPinOff, Navigation, Users } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/cn';
import { fmtTimeTz } from '@/lib/format';
import { getTripMap, pinRide, type ClusterRider, type GeoPoint, type RideCluster, type RideDirection } from '@/lib/transportApi';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Drawer, DrawerBody, DrawerDescription, DrawerHeader, DrawerTitle } from '@/components/ui/Drawer';
import { Skeleton } from '@/components/ui/Skeleton';
import { QueryError } from '@/components/ui/QueryError';
import { LazyLiveMap, type MapMarker } from '@/components/transport/LazyLiveMap';

/**
 * THE SHIFT'S STOPS — the driver's map for one store shift.
 *
 * Everyone riding it, grouped into stops (riders within a short walk ride
 * together), in the order to work them: farthest from the store first on
 * the way in, nearest drop first coming home. Each stop lists its riders
 * and its addresses, with directions one tap away.
 *
 * An address the lookup couldn't place has no pin: it rides at the end of
 * the list with "Set the pin", and whoever is driving taps the spot once —
 * it sticks to that rider for every ride after.
 */

export interface TripKey {
  locationId: string;
  direction: RideDirection;
  /** YYYY-MM-DD, the store's day. */
  date: string;
  windowLabel: string | null;
  storeName: string;
}

const directionsUrl = (c: RideCluster) =>
  c.point
    ? `https://www.google.com/maps/dir/?api=1&destination=${c.point.lat},${c.point.lng}`
    : `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(c.address)}`;

const walk = (m: number) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);

export function ShiftMapDrawer({ trip, open, onClose }: { trip: TripKey | null; open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [pinFor, setPinFor] = useState<{ rider: ClusterRider; cluster: RideCluster } | null>(null);
  const q = useQuery({
    queryKey: ['transport', 'trip-map', trip?.locationId, trip?.direction, trip?.date, trip?.windowLabel],
    queryFn: () => getTripMap({ locationId: trip!.locationId, direction: trip!.direction, date: trip!.date, windowLabel: trip!.windowLabel }),
    enabled: !!trip && open,
  });
  const data = q.data;
  const store = data?.trip.store;

  const markers: MapMarker[] = [];
  if (store?.point) markers.push({ id: 'store', kind: 'store', ...store.point, label: store.name });
  for (const c of data?.clusters ?? []) {
    if (c.point) markers.push({ id: c.key, kind: 'stop', ...c.point, order: c.order, label: `${c.label} · ${c.riders.length}` });
  }
  const route: Array<[number, number]> = (data?.clusters ?? [])
    .filter((c) => c.point)
    .map((c) => [c.point!.lng, c.point!.lat] as [number, number]);
  if (store?.point) {
    if (data?.trip.direction === 'TO_WORK') route.push([store.point.lng, store.point.lat]);
    else route.unshift([store.point.lng, store.point.lat]);
  }

  return (
    <Drawer open={open} onOpenChange={(o) => !o && onClose()} width="max-w-2xl">
      <DrawerHeader>
        <DrawerTitle>{t('drive.shiftStops')}</DrawerTitle>
        <DrawerDescription>
          {trip
            ? [trip.storeName, trip.windowLabel ?? null, trip.direction === 'TO_WORK' ? t('ride.toWork') : t('ride.fromWork')]
                .filter(Boolean)
                .join(' · ')
            : ''}
        </DrawerDescription>
      </DrawerHeader>
      <DrawerBody>
        {q.isError ? (
          <QueryError what="this shift's stops" query={q} />
        ) : q.isLoading || !data ? (
          <div className="space-y-3">
            <Skeleton className="h-56 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : data.trip.riders === 0 ? (
          <p className="text-sm text-silver">{t('drive.shiftNoRiders')}</p>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
              <span className="flex items-center gap-1.5 text-white">
                <Users className="h-4 w-4 text-gold" aria-hidden="true" />
                {t('drive.shiftRiders', { riders: data.trip.riders, stops: data.clusters.length })}
              </span>
              {data.trip.scheduled > 0 && <span className="text-silver">{t('drive.shiftSeated', { count: data.trip.scheduled })}</span>}
              {data.trip.requested > 0 && <span className="text-gold">{t('drive.shiftAsking', { count: data.trip.requested })}</span>}
              {store?.clientName && <span className="ml-auto text-xs text-silver/70">{store.clientName}</span>}
            </div>

            {markers.length > 0 && (
              <LazyLiveMap
                ariaLabel={t('drive.shiftMapLabel')}
                className="h-64 w-full sm:h-72"
                markers={markers}
                route={route.length > 1 ? route : undefined}
              />
            )}

            <ol className="space-y-2">
              {data.clusters.map((c) => (
                <li key={c.key} className={cn('rounded-lg border p-3', c.mapped ? 'border-navy-secondary' : 'border-warning/40 bg-warning/[0.06]')}>
                  <div className="flex items-start gap-2.5">
                    <span
                      className={cn(
                        'mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full text-2xs font-semibold',
                        c.mapped ? 'bg-gold/20 text-gold' : 'bg-warning/20 text-warning',
                      )}
                      aria-hidden="true"
                    >
                      {c.mapped ? c.order : '?'}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="text-sm font-medium text-white">{c.label}</span>
                        <span className="text-xs text-silver/70">
                          {t('drive.shiftStopRiders', { count: c.riders.length })}
                          {c.spreadM >= 60 && ` · ${t('drive.shiftSpread', { walk: walk(c.spreadM) })}`}
                        </span>
                        {c.etaAt && <span className="text-xs tabular-nums text-gold">{fmtTimeTz(c.etaAt, store?.timezone)}</span>}
                      </div>
                      {c.address && c.address !== c.label && <div className="truncate text-xs text-silver/70">{c.address}</div>}
                      <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
                        {c.riders.map((r) => (
                          <li key={r.rideId} className="flex items-center gap-1.5">
                            <Avatar src={r.photoUrl ?? null} name={r.name} size="xs" />
                            <span className="text-xs text-white">{r.name}</span>
                            {r.status === 'REQUESTED' && <span className="text-2xs text-gold">{t('drive.shiftAskingTag')}</span>}
                            {!r.pinned && (
                              <button
                                type="button"
                                onClick={() => setPinFor({ rider: r, cluster: c })}
                                className="inline-flex items-center gap-0.5 rounded text-2xs text-warning underline underline-offset-2 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
                              >
                                <MapPinOff className="h-3 w-3" aria-hidden="true" />
                                {c.mapped ? t('drive.pinFix') : t('drive.pinSet')}
                              </button>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                    <Button asChild size="xs" variant="ghost">
                      <a href={directionsUrl(c)} target="_blank" rel="noreferrer noopener" aria-label={t('drive.shiftDirections', { stop: c.label })}>
                        <Navigation className="h-3.5 w-3.5" />
                      </a>
                    </Button>
                  </div>
                </li>
              ))}
            </ol>
            {data.unmapped > 0 && (
              <p className="flex items-start gap-1.5 text-xs text-warning">
                <MapPinOff className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                {t('drive.shiftUnmapped', { count: data.unmapped })}
              </p>
            )}
          </div>
        )}
      </DrawerBody>
      <PinDialog
        rider={pinFor?.rider ?? null}
        near={pinFor?.cluster.point ?? store?.point ?? null}
        onClose={() => setPinFor(null)}
        onSaved={() => {
          setPinFor(null);
          void queryClient.invalidateQueries({ queryKey: ['transport'] });
        }}
      />
    </Drawer>
  );
}

/** Tap the spot the van should stop — once, and it's remembered. */
export function PinDialog({
  rider,
  near,
  onClose,
  onSaved,
}: {
  rider: ClusterRider | null;
  near: GeoPoint | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [point, setPoint] = useState<GeoPoint | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!rider || !point) return;
    setBusy(true);
    try {
      await pinRide(rider.rideId, point);
      toast.success(t('drive.pinSaved', { name: rider.name.split(' ')[0] ?? rider.name }));
      setPoint(null);
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not save the pin.');
    } finally {
      setBusy(false);
    }
  };
  const markers: MapMarker[] = [];
  if (point) markers.push({ id: 'pin', kind: 'stop', ...point, label: rider?.name ?? '', highlight: true });
  else if (near) markers.push({ id: 'near', kind: 'store', ...near, label: '' });

  return (
    <Dialog
      open={!!rider}
      onOpenChange={(o) => {
        if (!o && !busy) {
          setPoint(null);
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('drive.pinTitle', { name: rider?.name ?? '' })}</DialogTitle>
          <DialogDescription>
            {rider?.address} — {t('drive.pinHelp')}
          </DialogDescription>
        </DialogHeader>
        <LazyLiveMap
          ariaLabel={t('drive.pinMapLabel')}
          className="h-64 w-full"
          markers={markers}
          maxZoom={17}
          onPick={(p) => setPoint(p)}
          fitKey={point ? 'picked' : 'start'}
        />
        <p className="flex items-center gap-1.5 text-xs text-silver">
          <MapPin className="h-3.5 w-3.5 shrink-0 text-gold" aria-hidden="true" />
          {point ? t('drive.pinPicked') : t('drive.pinTap')}
        </p>
        <DialogFooter>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setPoint(null);
              onClose();
            }}
          >
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void save()} loading={busy} disabled={!point || busy}>
            {t('drive.pinSave')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
