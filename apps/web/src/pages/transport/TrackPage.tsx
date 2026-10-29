import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Bus, Clock, MapPin } from '@/components/ui/icons';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useI18n } from '@/lib/i18n';
import { fmtTimeTz } from '@/lib/format';
import { getPublicTrip, type PublicTrip } from '@/lib/transportApi';
import { Logo } from '@/components/Logo';
import { Skeleton } from '@/components/ui/Skeleton';
import { LinkProblem } from '@/components/LinkProblem';
import { LazyLiveMap, type MapMarker } from '@/components/transport/LazyLiveMap';
import { PlateChip } from './rider/PlateChip';
import { useTick } from './rider/useTick';
import '@/lib/i18n/en/ride';

/**
 * A shared trip — the page behind "Share trip" (the rider's, or the
 * driver's "Share my trip"). No sign-in: the signed link is the key, and
 * it expires. Map first, like the ride it follows: the van where it is,
 * then in big type how long until its next stop. Never who rides it or
 * where anyone lives — the van, its plate and the ETA only.
 */
export function TrackPage() {
  const { t } = useI18n();
  const { token = '' } = useParams();
  const q = useQuery({
    queryKey: ['public-trip', token],
    queryFn: () => getPublicTrip(token),
    refetchInterval: 15_000,
    retry: false,
  });
  const now = useTick(15_000);
  const trip = q.data?.trip;
  // 410: a real link past its time (or the trip is over); 404: a link nobody sent (F500 G5).
  const expired = q.error instanceof ApiError && q.error.status === 410;
  const invalid = q.error instanceof ApiError && q.error.status === 404;

  return (
    <div className="min-h-[100dvh] bg-surface-sunken text-ink">
      <header className="flex items-center justify-center px-4 pb-3 pt-[calc(env(safe-area-inset-top,0px)+0.75rem)]">
        <Logo size="md" />
      </header>
      <main className="mx-auto w-full max-w-2xl pb-[calc(env(safe-area-inset-bottom,0px)+1.5rem)] sm:px-6">
        {q.isLoading ? (
          <div className="space-y-3 px-4 sm:px-0">
            <Skeleton className="h-[44vh] min-h-[16rem]" />
            <Skeleton className="h-32" />
          </div>
        ) : expired ? (
          <LinkProblem className="mx-4 sm:mx-0" kind="expired" title={t('ride.track.expiredTitle')} reason={t('ride.track.expiredBody')} />
        ) : invalid ? (
          <LinkProblem className="mx-4 sm:mx-0" kind="invalid" title={t('ride.track.invalidTitle')} reason={t('ride.track.invalidBody')} />
        ) : !trip ? (
          <LinkProblem className="mx-4 sm:mx-0" kind="error" title={t('ride.track.errorTitle')} reason={t('ride.track.errorBody')} />
        ) : (
          <SharedTrip trip={trip} now={now} />
        )}
      </main>
    </div>
  );
}

function SharedTrip({ trip, now }: { trip: PublicTrip; now: number }) {
  const { t } = useI18n();
  const markers: MapMarker[] = trip.position
    ? [{ id: 'van', kind: 'van', lat: trip.position.lat, lng: trip.position.lng, heading: trip.position.heading, stale: trip.stale, highlight: true, label: trip.van.name }]
    : [];
  const etaMs = trip.next?.etaAt ? Date.parse(trip.next.etaAt) - now : null;
  const minutesAway = etaMs === null ? null : Math.max(1, Math.round(etaMs / 60_000));
  const out = trip.status === 'ACTIVE';
  const fresh = out && !!trip.position && !trip.stale;
  const headline =
    trip.status === 'COMPLETED'
      ? t('ride.track.finished')
      : trip.status === 'PLANNED'
        ? t('ride.track.notYet')
        : trip.next
          ? etaMs !== null && etaMs < 60_000
            ? t('ride.track.arriving', { place: trip.next.label })
            : minutesAway !== null
              ? t('ride.track.eta', { min: minutesAway, place: trip.next.label })
              : t('ride.track.onWayTo', { place: trip.next.label })
          : t('ride.track.onRoad');
  return (
    <div className="sm:overflow-hidden sm:rounded-lg sm:border sm:border-line">
      <div className="relative h-[46vh] min-h-[16rem] max-h-[30rem] bg-surface-raised">
        {markers.length > 0 ? (
          <LazyLiveMap ariaLabel={t('ride.track.where', { van: trip.van.name })} className="h-full w-full rounded-none" markers={markers} maxZoom={15} controls={false} padding={{ top: 48, bottom: 56, left: 40, right: 40 }} />
        ) : (
          <div className="grid h-full place-items-center px-8 text-center text-sm text-ink-muted">
            <span className="flex flex-col items-center gap-2">
              <Bus className="h-6 w-6" aria-hidden="true" />
              {t('ride.track.noPosition')}
            </span>
          </div>
        )}
        {fresh && (
          <span className="pointer-events-none absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-full bg-midnight/85 px-2.5 py-1 text-2xs font-semibold uppercase tracking-wider text-ink backdrop-blur">
            <span className="relative flex h-2 w-2" aria-hidden="true">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-positive-700 opacity-70 motion-reduce:hidden" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-positive-700" />
            </span>
            {t('ride.mapLive')}
          </span>
        )}
      </div>
      <section className="relative -mt-4 rounded-t-lg border-t border-line bg-surface px-4 pb-6 pt-3 elev-2 sm:px-6">
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-line-strong/60" aria-hidden="true" />
        <div className="flex items-center justify-between gap-2">
          <span className="text-2xs font-semibold uppercase tracking-[0.18em] text-ink-muted">{t('ride.track.eyebrow')}</span>
          {out && trip.next?.etaAt && <span className="text-sm tabular-nums text-ink-muted">{t('ride.track.etaAt', { time: fmtTimeTz(trip.next.etaAt) })}</span>}
        </div>
        <div className="mt-1.5 text-[1.75rem] font-bold leading-[1.15] tracking-tight text-ink tabular-nums sm:text-4xl" aria-live="polite">
          <h1>{headline}</h1>
        </div>
        {out && trip.stopsLeft > 0 && (
          <p className="mt-1 flex items-center gap-1.5 text-base text-ink-muted">
            <MapPin className="h-4 w-4 shrink-0" aria-hidden="true" />
            {t('ride.track.stopsLeft', { count: trip.stopsLeft })}
          </p>
        )}
        <div className="mt-4 flex items-center gap-3 rounded-lg border border-line bg-surface-raised/40 p-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-surface-raised text-accent" aria-hidden="true">
            <Bus className="h-5 w-5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-base font-semibold text-ink">{trip.van.name}</span>
            {trip.driver && <span className="block truncate text-sm text-ink-muted">{t('ride.track.driven', { driver: trip.driver })}</span>}
          </span>
          {trip.van.plate && <PlateChip plate={trip.van.plate} />}
        </div>
        {trip.position && (
          <p className={cn('mt-3 flex items-center gap-1.5 text-sm', trip.stale ? 'text-caution-800' : 'text-ink-muted')}>
            <Clock className="h-4 w-4 shrink-0" aria-hidden="true" />
            {trip.stale ? t('ride.track.lastSeen', { time: fmtTimeTz(trip.position.at) }) : t('ride.track.updated', { time: fmtTimeTz(trip.position.at) })}
          </p>
        )}
        <p className="mt-4 border-t border-line-subtle pt-3 text-sm text-ink-muted">{t('ride.track.privacy')}</p>
      </section>
    </div>
  );
}
