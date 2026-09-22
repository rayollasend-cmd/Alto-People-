import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bus, ChevronRight } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { hapticConfirm } from '@/lib/haptics';
import { useI18n } from '@/lib/i18n';
import { fmtMoney, fmtRelativeDayTz, fmtTimeTz } from '@/lib/format';
import { getMyLiveRide, getMyTransport, type Ride } from '@/lib/transportApi';
import { Button } from '@/components/ui/Button';
import { LazyLiveMap } from '@/components/transport/LazyLiveMap';
import { bookShifts, coverageFor } from './rideShifts';
import { tripGeometry, tripStage } from './TripMap';
import { useRiderAlerts } from './useRiderAlerts';

/**
 * The van, on Home — where the associate already looks. One line under the
 * shift card: the ride that's coming (live: "about 8 min away", "your van is
 * here" — with the van moving on a small map while it's out), or, when
 * their next shift has no ride, a one-tap round trip from where they went
 * last time. Quiet otherwise.
 */

const H = 3_600_000;
const SOON: Ride['status'][] = ['REQUESTED', 'SCHEDULED', 'BOARDED'];

export function RideStrip() {
  const { can } = useAuth();
  if (!can('ride:transport')) return null;
  return <RideStripInner />;
}

function RideStripInner() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const me = useQuery({ queryKey: ['transport', 'me'], queryFn: getMyTransport, staleTime: 60_000, retry: false });
  const live = useQuery({
    queryKey: ['transport', 'me', 'live'],
    queryFn: getMyLiveRide,
    refetchInterval: (q) => (q.state.data?.live?.runStatus === 'ACTIVE' ? 15_000 : 120_000),
    retry: false,
  });
  const data = me.data;
  useRiderAlerts(data?.consent ? data : undefined, live.data?.live ?? null);
  if (!data?.consent) return null;
  const now = Date.now();

  const next = data.rides
    .filter((r) => SOON.includes(r.status) && Date.parse(r.pickupAt ?? r.targetAt) < now + 24 * H && Date.parse(r.targetAt) > now - 6 * H)
    .sort((a, b) => Date.parse(a.pickupAt ?? a.targetAt) - Date.parse(b.pickupAt ?? b.targetAt))[0];

  if (next) {
    const l = live.data?.live?.rideId === next.id ? live.data.live : null;
    const tz = next.store.timezone;
    const here = next.status === 'SCHEDULED' && !!(next.vanArrivedAt ?? l?.vanArrivedAt);
    const eta = l?.runStatus === 'ACTIVE' ? (next.status === 'BOARDED' ? l.destination.etaAt : l.pickup.etaAt) : null;
    const mins = eta ? Math.max(1, Math.round((Date.parse(eta) - now) / 60_000)) : null;
    const line = here
      ? t('ride.vanHere')
      : next.status === 'BOARDED'
        ? eta
          ? t('ride.liveArriving', { time: fmtTimeTz(eta, tz) })
          : t('ride.onVan')
        : mins !== null
          ? t('ride.liveAway', { min: mins })
          : next.pickupAt
            ? `${fmtRelativeDayTz(next.pickupAt, tz)} · ${t('ride.pickupAt', { time: fmtTimeTz(next.pickupAt, tz) })}`
            : `${fmtRelativeDayTz(next.targetAt, tz)} · ${t('ride.homeStripWaiting')}`;
    const sub = next.run
      ? `${next.run.van.name} · ${next.direction === 'TO_WORK' ? t('ride.toWork') : t('ride.fromWork')}`
      : next.direction === 'TO_WORK'
        ? t('ride.toWork')
        : t('ride.fromWork');
    const green = here || next.status === 'BOARDED' || mins !== null;
    const stage = tripStage(next, l);
    const geo =
      l?.position && (stage === 'ON_THE_WAY' || stage === 'HERE' || stage === 'ON_BOARD')
        ? tripGeometry(stage, l, next.run?.van.name ?? l.van?.name ?? '')
        : null;
    return (
      <Link
        to="/rides"
        className={cn(
          'mb-4 block overflow-hidden rounded-lg border transition-colors animate-enter',
          green ? 'border-success/40 bg-success/[0.06] hover:bg-success/[0.1]' : 'border-navy-secondary bg-navy hover:border-silver/40',
        )}
      >
        {geo && (
          <div className="relative h-36 border-b border-success/20">
            <LazyLiveMap
              ariaLabel={t('ride.liveMap')}
              className="h-full w-full rounded-none"
              markers={geo.markers}
              route={geo.route}
              path={geo.path}
              maxZoom={geo.maxZoom}
              padding={28}
              controls={false}
              interactive={false}
            />
            {!l?.stale && (
              <span className="pointer-events-none absolute left-2.5 top-2.5 inline-flex items-center gap-1.5 rounded-full bg-midnight/85 px-2 py-0.5 text-2xs font-semibold uppercase tracking-wider text-white shadow backdrop-blur">
                <span className="relative flex h-1.5 w-1.5" aria-hidden="true">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-70 motion-reduce:hidden" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-success" />
                </span>
                {t('ride.mapLive')}
              </span>
            )}
          </div>
        )}
        <span className="flex items-center gap-3 p-3.5">
        <span
          className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-full', green ? 'bg-success/15 text-success' : 'bg-gold/15 text-gold')}
          aria-hidden="true"
        >
          <Bus className="h-5 w-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-2xs font-medium uppercase tracking-wider text-silver">{t('ride.homeStripTitle')}</span>
          <span className="block truncate text-sm font-semibold text-white tabular-nums">{line}</span>
          <span className="block truncate text-xs text-silver">{sub}</span>
        </span>
        <ChevronRight className="h-4 w-4 shrink-0 text-silver" aria-hidden="true" />
        </span>
      </Link>
    );
  }

  // No ride coming: the next shift that still needs one, within the week.
  const need = coverageFor(data, now).find((c) => c.canBook.length > 0 && Date.parse(c.shift.startsAt) < now + 7 * 24 * H);
  if (!need) return null;
  const store = data.stores.find((st) => st.id === need.shift.locationId);
  const tz = store?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const when = `${fmtRelativeDayTz(need.shift.startsAt, tz)} ${fmtTimeTz(need.shift.startsAt, tz)}`;
  const amount = fmtMoney((need.canBook.length * data.settings.fareCents) / 100);

  const book = async () => {
    setBusy(true);
    try {
      const n = await bookShifts(data, [need]);
      hapticConfirm();
      toast.success(n === 1 ? t('ride.booked') : t('ride.bookedCount', { count: n }));
    } catch (err) {
      // Not String(err): a dropped connection surfaced here as "TypeError:
      // Failed to fetch" on the one-tap book button. Kept inline rather
      // than imported from RideHome — that module is the whole Rides page
      // and the dashboard should not be pulling it in for one sentence.
      toast.error(err instanceof ApiError ? err.message : 'The request didn’t get through. Check your signal and try again.');
    } finally {
      setBusy(false);
      await queryClient.invalidateQueries({ queryKey: ['transport', 'me'] });
    }
  };

  return (
    <div className="mb-4 flex items-center gap-3 rounded-lg border border-navy-secondary bg-navy p-3.5 animate-enter">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-gold/15 text-gold" aria-hidden="true">
        <Bus className="h-5 w-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-white">{t('ride.homeStripNeed', { when })}</span>
        {data.defaultPickup && (
          <span className="block truncate text-xs text-silver">{t('ride.forShiftsFrom', { pickup: data.defaultPickup.label })}</span>
        )}
      </span>
      {data.defaultPickup ? (
        <Button size="sm" onClick={() => void book()} loading={busy} disabled={busy} className="shrink-0">
          {need.canBook.length === 2
            ? t('ride.roundTrip', { amount })
            : need.canBook[0] === 'FROM_WORK'
              ? t('ride.addHome', { amount })
              : t('ride.addThere', { amount })}
        </Button>
      ) : (
        <Button size="sm" variant="secondary" asChild className="shrink-0">
          <Link to="/rides">{t('ride.book')}</Link>
        </Button>
      )}
    </div>
  );
}
