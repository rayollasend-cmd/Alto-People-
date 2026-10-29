import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bus, Check, ChevronRight, Hand, Wallet } from '@/components/ui/icons';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { hapticConfirm } from '@/lib/haptics';
import { useI18n } from '@/lib/i18n';
import { fmtMoney, fmtRelativeDayTz, fmtTimeTz } from '@/lib/format';
import { getMyLiveRide, getMyTransport, signalDriver, type MyTransport, type Ride } from '@/lib/transportApi';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { LazyLiveMap } from '@/components/transport/LazyLiveMap';
import { bookShifts, coverageFor } from './rideShifts';
import { tripGeometry, tripStage } from './TripMap';
import { useRiderAlerts } from './useRiderAlerts';
import { PlateChip } from './rider/PlateChip';
import { owedSummary, paydayText } from './rider/charges';
import { hasVan, liveTripView, tripProgress } from './rider/tripState';
import { useTick } from './rider/useTick';
import '@/lib/i18n/en/ride';

/**
 * The van, on Home — where the associate already looks. The ride that's
 * coming, in miniature of the Ride page's live trip: the countdown ("Mike
 * is 6 min away"), the van and its plate, "I'm outside" the moment it's
 * there — with the van moving on a small map while it's out. With no ride
 * coming, a one-tap round trip for their next shift that needs one. What
 * they owe for rides shows in one line, only when it's above zero.
 */

const H = 3_600_000;
const SOON: Ride['status'][] = ['REQUESTED', 'SCHEDULED', 'BOARDED'];

function why(err: unknown): string {
  // Not String(err): a dropped connection surfaced as "TypeError: Failed to
  // fetch". Kept inline rather than imported from RideHome — that module is
  // the whole Rides page and the dashboard should not pull it in.
  return err instanceof ApiError ? err.message : 'The request didn’t get through. Check your signal and try again.';
}

export function RideStrip() {
  const { can } = useAuth();
  if (!can('ride:transport')) return null;
  return <RideStripInner />;
}

/**
 * "You owe $15.00 for rides · from your pay Fri, Nov 6" — only above zero.
 * When part of it falls to the payday after, it says how much comes out
 * first ("You owe $65.00 for rides · $40.00 from your pay Fri, Oct 30"),
 * the Ride page's own split (owedSummary).
 */
function OwedLine({ data, framed }: { data: MyTransport; framed: boolean }) {
  const { t } = useI18n();
  const s = owedSummary(data);
  if (s.cents <= 0) return null;
  const amount = fmtMoney(s.cents / 100);
  const date = s.payDate ? paydayText(s.payDate) : null;
  return (
    <Link
      to="/rides?view=charges"
      data-testid="home-owed"
      className={cn(
        'flex min-h-11 items-center gap-2.5 px-3.5 py-2.5 text-sm text-ink-muted transition-colors hover:bg-surface-raised/40 hover:text-ink',
        framed ? 'border-t border-line-subtle' : 'mb-4 rounded-lg border border-line bg-surface animate-enter',
      )}
    >
      <Wallet className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 tabular-nums">
        {!date
          ? t('ride.owe.stripNoDate', { amount })
          : s.laterCents > 0
            ? t('ride.owe.stripSplit', { amount, due: fmtMoney((s.cents - s.laterCents) / 100), date })
            : t('ride.owe.strip', { amount, date })}
      </span>
      <ChevronRight className="h-4 w-4 shrink-0" aria-hidden="true" />
    </Link>
  );
}

function RideStripInner() {
  const { t, lang } = useI18n();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [told, setTold] = useState(false);
  const me = useQuery({ queryKey: ['transport', 'me'], queryFn: getMyTransport, staleTime: 60_000, retry: false });
  const live = useQuery({
    queryKey: ['transport', 'me', 'live'],
    queryFn: getMyLiveRide,
    refetchInterval: (q) => (q.state.data?.live?.runStatus === 'ACTIVE' ? 15_000 : 120_000),
    retry: false,
  });
  const data = me.data;
  useRiderAlerts(data?.consent ? data : undefined, live.data?.live ?? null);
  const now = useTick(15_000);
  if (!data?.consent) return null;

  const next = data.rides
    .filter((r) => SOON.includes(r.status) && Date.parse(r.pickupAt ?? r.targetAt) < now + 24 * H && Date.parse(r.targetAt) > now - 6 * H)
    .sort((a, b) => Date.parse(a.pickupAt ?? a.targetAt) - Date.parse(b.pickupAt ?? b.targetAt))[0];

  if (next) {
    const l = live.data?.live?.rideId === next.id ? live.data.live : null;
    const tz = next.store.timezone;
    const dir = next.direction === 'TO_WORK' ? t('ride.toWork') : t('ride.fromWork');
    const van = hasVan(next, l);
    const v = van ? liveTripView(next, l, now) : null;
    const who = v ? v.driverFirst || v.vanName : '';
    const outside = told || v?.signal === 'OUTSIDE';
    let line: string;
    let sub: string;
    if (!v) {
      line = `${fmtRelativeDayTz(next.targetAt, tz, now)} · ${t('ride.homeStripWaiting')}`;
      sub = dir;
    } else if (v.phase === 'arrived') {
      line = who ? t('ride.trip.here', { driver: who }) : t('ride.vanHere');
      const look = lang === 'en' && v.look ? v.look.charAt(0).toLowerCase() + v.look.slice(1) : v.look;
      sub = look ? t('ride.trip.lookForNoPlate', { look }) : `${v.vanName} · ${dir}`;
    } else if (v.phase === 'onBoard') {
      line = v.etaAt ? t('ride.trip.arriving', { time: fmtTimeTz(v.etaAt, tz) }) : t('ride.onVan');
      sub = `${v.vanName} · ${dir}`;
    } else if (v.phase === 'onWay') {
      line = v.arrivingNow
        ? t('ride.liveHere')
        : v.minutesAway !== null
          ? who
            ? t('ride.trip.away', { driver: who, min: v.minutesAway })
            : t('ride.liveAway', { min: v.minutesAway })
          : t('ride.trip.onTheWay', { driver: who });
      sub = `${v.vanName} · ${dir}`;
    } else {
      line = v.pickupAt
        ? `${fmtRelativeDayTz(v.pickupAt, tz, now)} · ${t('ride.pickupAt', { time: fmtTimeTz(v.pickupAt, tz) })}`
        : v.departAt && v.vanName
          ? `${fmtRelativeDayTz(v.departAt, tz, now)} · ${t('ride.trip.leaves', { van: v.vanName, time: fmtTimeTz(v.departAt, tz) })}`
          : `${fmtRelativeDayTz(next.targetAt, tz, now)} · ${fmtTimeTz(next.targetAt, tz)}`;
      sub = `${v.vanName} · ${dir}`;
    }
    const green = v?.phase === 'arrived' || v?.phase === 'onBoard';
    const stage = tripStage(next, l);
    const geo =
      l?.position && (stage === 'ON_THE_WAY' || stage === 'HERE' || stage === 'ON_BOARD')
        ? tripGeometry(stage, l, next.run?.van.name ?? l.van?.name ?? '')
        : null;
    const progress = v?.phase === 'onBoard' ? tripProgress(next.boardedAt ?? v.departAt, v.etaAt, now) : null;

    const tell = async () => {
      setBusy(true);
      try {
        await signalDriver(next.id, 'OUTSIDE');
        hapticConfirm();
        setTold(true);
        await queryClient.invalidateQueries({ queryKey: ['transport', 'me'] });
      } catch (err) {
        toast.error(why(err));
      } finally {
        setBusy(false);
      }
    };

    return (
      <div className={cn('mb-4 overflow-hidden rounded-lg border bg-surface animate-enter', green ? 'border-positive-200' : 'border-line')} data-testid="home-ride" data-phase={v?.phase ?? 'finding'}>
        <Link to="/rides" className="block transition-colors hover:bg-surface-raised/30">
          {geo && (
            <div className="relative h-36 border-b border-line-subtle">
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
                <span className="pointer-events-none absolute left-2.5 top-2.5 inline-flex items-center gap-1.5 rounded-full bg-midnight/85 px-2.5 py-1 text-2xs font-semibold uppercase tracking-wider text-ink shadow backdrop-blur">
                  <span className="relative flex h-1.5 w-1.5" aria-hidden="true">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-positive-700 opacity-70 motion-reduce:hidden" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-positive-700" />
                  </span>
                  {t('ride.mapLive')}
                </span>
              )}
            </div>
          )}
          <span className="flex items-center gap-3 p-3.5">
            <span
              className={cn(
                'grid h-10 w-10 shrink-0 place-items-center rounded-full',
                green ? 'bg-positive-100 text-positive-800' : 'bg-surface-raised text-accent',
              )}
              aria-hidden="true"
            >
              <Bus className="h-5 w-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="text-2xs font-semibold uppercase tracking-[0.18em] text-ink-muted">{t('ride.homeStripTitle')}</span>
                {v?.phase === 'onWay' && v.lateMinutes > 0 && (
                  <Badge variant="pending" size="sm">
                    {t('ride.trip.late', { min: v.lateMinutes })}
                  </Badge>
                )}
              </span>
              <span className="line-clamp-2 block text-base font-semibold leading-snug text-ink tabular-nums" data-testid="home-ride-line">
                {line}
              </span>
              <span className="line-clamp-2 block text-sm text-ink-muted">{sub}</span>
            </span>
            {v?.plate ? <PlateChip plate={v.plate} size="sm" /> : <ChevronRight className="h-4 w-4 shrink-0 text-ink-muted" aria-hidden="true" />}
          </span>
          {progress !== null && (
            <span className="mx-3.5 mb-3 block h-1.5 overflow-hidden rounded-full bg-surface-raised" aria-hidden="true">
              <span className="block h-full rounded-full bg-positive-700" style={{ width: `${Math.round(progress * 100)}%` }} />
            </span>
          )}
        </Link>
        {v?.phase === 'arrived' && (
          <div className="flex items-center gap-3 border-t border-line-subtle px-3.5 py-3">
            {outside ? (
              <p role="status" className="flex items-center gap-1.5 text-sm font-medium text-positive-800">
                <Check className="h-4 w-4" aria-hidden="true" />
                {t('ride.toldOutside', { driver: who })}
              </p>
            ) : (
              <Button onClick={() => void tell()} loading={busy} disabled={busy} className="w-full">
                <Hand className="h-4 w-4" />
                {t('ride.imOutside')}
              </Button>
            )}
          </div>
        )}
        <OwedLine data={data} framed />
      </div>
    );
  }

  // No ride coming: the next shift that still needs one, within the week.
  const need = coverageFor(data, now).find((c) => c.canBook.length > 0 && Date.parse(c.shift.startsAt) < now + 7 * 24 * H);
  if (!need) return <OwedLine data={data} framed={false} />;
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
      toast.error(why(err));
    } finally {
      setBusy(false);
      await queryClient.invalidateQueries({ queryKey: ['transport', 'me'] });
    }
  };

  return (
    <div className="mb-4 overflow-hidden rounded-lg border border-line bg-surface animate-enter">
      <div className="flex items-center gap-3 p-3.5">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-surface-raised text-accent" aria-hidden="true">
          <Bus className="h-5 w-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-ink">{t('ride.homeStripNeed', { when })}</span>
          {data.defaultPickup && <span className="block truncate text-xs text-ink-muted">{t('ride.forShiftsFrom', { pickup: data.defaultPickup.label })}</span>}
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
      <OwedLine data={data} framed />
    </div>
  );
}
