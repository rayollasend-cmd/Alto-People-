import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Bus, Clock, MapPin } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { fmtTimeTz } from '@/lib/format';
import { getPublicTrip } from '@/lib/transportApi';
import { Logo } from '@/components/Logo';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { LazyLiveMap, type MapMarker } from '@/components/transport/LazyLiveMap';

/**
 * A shared trip — the page behind the driver's "Share my trip" link. No
 * sign-in: the signed link is the key, and it expires after six hours.
 * It shows the van, where it is and when it reaches its next stop —
 * never who rides it or where anyone lives.
 */
export function TrackPage() {
  const { token = '' } = useParams();
  const q = useQuery({
    queryKey: ['public-trip', token],
    queryFn: () => getPublicTrip(token),
    refetchInterval: 15_000,
    retry: false,
  });
  const trip = q.data?.trip;
  const expired = q.error instanceof ApiError && q.error.status === 404;
  const markers: MapMarker[] = trip?.position
    ? [{ id: 'van', kind: 'van', lat: trip.position.lat, lng: trip.position.lng, heading: trip.position.heading, stale: trip.stale, highlight: true, label: trip.van.name }]
    : [];
  const minutesAway = trip?.next?.etaAt ? Math.max(1, Math.round((Date.parse(trip.next.etaAt) - Date.now()) / 60_000)) : null;
  return (
    <div className="min-h-screen bg-gradient-to-br from-midnight via-navy to-navy-secondary text-ink">
      <main className="mx-auto max-w-2xl px-4 py-10 md:px-6">
        <div className="mb-6 flex items-center justify-center">
          <Logo size="lg" />
        </div>
        {q.isLoading ? (
          <Skeleton className="h-80" />
        ) : expired || !trip ? (
          <EmptyState icon={Bus} title="This link has expired" description="Shared trips stop showing after six hours, or once the run is over. Ask the driver for a new link." />
        ) : (
          <div className="space-y-4">
            <div className="rounded-lg border border-navy-secondary bg-navy p-5">
              <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-silver">
                <Bus className="h-4 w-4" aria-hidden="true" />
                {trip.van.name}
                {trip.van.plate ? ` · ${trip.van.plate}` : ''}
              </div>
              <div className="mt-2 text-2xl font-bold tracking-tight">
                <h1>
                {trip.status === 'COMPLETED'
                  ? 'Trip finished'
                  : trip.status === 'PLANNED'
                    ? 'Not on the road yet'
                    : trip.next
                      ? minutesAway !== null
                        ? `About ${minutesAway} min to ${trip.next.label}`
                        : `On the way to ${trip.next.label}`
                      : 'On the road'}
                </h1>
              </div>
              <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-silver">
                {trip.driver && <span>Driven by {trip.driver}</span>}
                {trip.stopsLeft > 0 && trip.status === 'ACTIVE' && (
                  <span className="inline-flex items-center gap-1">
                    <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
                    {trip.stopsLeft} {trip.stopsLeft === 1 ? 'stop' : 'stops'} left
                  </span>
                )}
                {trip.position && (
                  <span className="inline-flex items-center gap-1">
                    <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                    {trip.stale ? 'Last seen' : 'Updated'} {fmtTimeTz(trip.position.at)}
                  </span>
                )}
              </p>
            </div>
            {markers.length > 0 && <LazyLiveMap ariaLabel={`Where ${trip.van.name} is`} className="h-80 w-full rounded-lg" markers={markers} />}
            <p className="text-center text-xs text-silver">This page shows the van only — never who is riding or where anyone lives.</p>
          </div>
        )}
      </main>
    </div>
  );
}
