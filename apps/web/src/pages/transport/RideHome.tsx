import { useEffect, useMemo, useState } from 'react';
import { onLiveEvent } from '@/lib/liveEvents';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Bus, Check, Home, MapPin, Plus, Trash2, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { cn } from '@/lib/cn';
import { useConfirm } from '@/lib/confirm';
import { hapticConfirm } from '@/lib/haptics';
import {
  fmtMoney,
  fmtRelativeDayTz,
  fmtTimeTz,
  localInputToUtcIso,
  mapsUrl,
  parseYmd,
  utcToZonedDatetimeInput,
  zonedDayKey,
} from '@/lib/format';
import {
  addRidePlace,
  bookRide,
  cancelMyRide,
  deleteRidePlace,
  getMyTransport,
  getMyLiveRide,
  giveRideConsent,
  reportTransportIssue,
  whereAmI,
  type BookRideInput,
  type GeoPoint,
  type MyLiveRide,
  type MyTransport,
  type Ride,
  type RideDirection,
  type RideStatus,
  type TransportIssueCategory,
} from '@/lib/transportApi';
import { PageHeader } from '@/components/ui/PageHeader';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { Input, Textarea } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { LazyLiveMap, type MapMarker } from '@/components/transport/LazyLiveMap';
import { Skeleton } from '@/components/ui/Skeleton';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';

/**
 * The associate's Ride tab — the Alto vans.
 *
 *   first visit   the deal, once: $5 a ride, $1 for a missed van, taken
 *                 from pay each period, book 10 hours ahead — agree, then book
 *   next ride     one hero, the MyShiftHero grammar: waiting on a van (gold),
 *                 van confirmed with the pickup time, van and driver (gold),
 *                 on the van (green)
 *   book          to work, home, or both ways — any store they're placed at,
 *                 a housing complex, a saved address or a new one. Rides
 *                 never depend on the schedule; their shifts are shortcuts.
 *   money         what's coming out of pay, and the next payday
 *   problems      one form to transportation
 */

const OPEN: RideStatus[] = ['REQUESTED', 'SCHEDULED'];
const LIVE: RideStatus[] = ['REQUESTED', 'SCHEDULED', 'BOARDED'];
const H = 3_600_000;
const ISSUE_CATEGORIES: TransportIssueCategory[] = [
  'LATE_VAN',
  'MISSED_PICKUP',
  'CHARGE_DISPUTE',
  'SAFETY',
  'VEHICLE',
  'CONDUCT',
  'OTHER',
];

const cents = (n: number) => fmtMoney(n / 100);

export function statusVariant(s: RideStatus): 'accent' | 'info' | 'success' | 'pending' | 'destructive' | 'default' {
  return s === 'REQUESTED'
    ? 'pending'
    : s === 'SCHEDULED'
      ? 'accent'
      : s === 'BOARDED' || s === 'COMPLETED'
        ? 'success'
        : s === 'NO_SHOW'
          ? 'destructive'
          : 'default';
}

/** Where the rider is picked up, as a phrase — home end for a ride to
 *  work, the store for a ride home. */
function pickupPlace(r: Ride): string {
  if (r.direction === 'FROM_WORK') return r.store.name;
  return r.pickup.kind === 'stop' ? r.pickup.name : r.pickup.address;
}

function homeEnd(r: Ride): string {
  return r.pickup.kind === 'stop' ? r.pickup.name : r.pickup.address;
}

export function RideHome() {
  const { t } = useI18n();
  const me = useQuery({ queryKey: ['transport', 'me'], queryFn: getMyTransport, refetchInterval: 60_000 });
  const [booking, setBooking] = useState(false);
  const [reporting, setReporting] = useState<{ rideId?: string } | null>(null);
  const data = me.data;
  const canBook = !!data?.consent && (data?.stores.length ?? 0) > 0;

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title={t('ride.title')}
        subtitle={t('ride.subtitle')}
        primaryAction={
          canBook ? (
            <Button onClick={() => setBooking(true)}>
              <Plus className="h-4 w-4" />
              {t('ride.book')}
            </Button>
          ) : undefined
        }
      />
      {me.isLoading || !data ? (
        me.error ? (
          <Card>
            <CardContent className="p-5 text-sm text-alert">
              {me.error instanceof ApiError ? me.error.message : String(me.error)}
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="space-y-3 p-5">
              <Skeleton className="h-3 w-28" />
              <Skeleton className="h-9 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
            </CardContent>
          </Card>
        )
      ) : !data.consent ? (
        <ConsentCard data={data} />
      ) : (
        <>
          <NextRideHero data={data} onBook={() => setBooking(true)} onReport={(rideId) => setReporting({ rideId })} />
          <UpcomingRides data={data} />
          <ChargesCard data={data} />
          <PastRides data={data} onReport={(rideId) => setReporting({ rideId })} />
          <SavedPlaces data={data} />
          <div className="mt-2 mb-8 flex justify-center">
            <Button variant="ghost" size="sm" onClick={() => setReporting({})}>
              <AlertTriangle className="h-4 w-4" />
              {t('ride.report')}
            </Button>
          </div>
        </>
      )}
      {data && booking && <BookRideDialog data={data} open={booking} onOpenChange={setBooking} />}
      {data && reporting && (
        <ReportDialog
          rides={data.rides}
          initialRideId={reporting.rideId}
          open={!!reporting}
          onOpenChange={(o) => !o && setReporting(null)}
        />
      )}
    </div>
  );
}

/* ----- The deal, once ------------------------------------------------------ */

function ConsentCard({ data }: { data: MyTransport }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const agree = useMutation({
    mutationFn: giveRideConsent,
    onSuccess: async () => {
      hapticConfirm();
      toast.success(t('ride.consentDone'));
      await queryClient.invalidateQueries({ queryKey: ['transport', 'me'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : String(err)),
  });
  const s = data.settings;
  const points = [
    t('ride.consentFare', { fare: cents(s.fareCents), round: cents(s.fareCents * 2) }),
    t('ride.consentNoShow', { fee: cents(s.noShowFeeCents) }),
    t('ride.consentPay'),
    t('ride.consentCutoff', { hours: s.cutoffHours }),
  ];
  return (
    <section className="relative mb-4 overflow-hidden rounded-lg border border-gold/30 bg-navy bg-gradient-to-br from-gold/[0.14] via-transparent to-transparent animate-enter">
      <div className="relative p-5">
        <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-gold">
          <Bus className="h-3.5 w-3.5" aria-hidden="true" />
          {t('ride.consentEyebrow')}
        </span>
        <h2 className="mt-2 text-2xl font-bold tracking-tight text-white sm:text-3xl">{t('ride.consentTitle')}</h2>
        <p className="mt-1.5 text-sm text-silver">{t('ride.consentBody')}</p>
        <ul className="mt-4 space-y-2">
          {points.map((p) => (
            <li key={p} className="flex items-start gap-2 text-sm text-white">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-gold" aria-hidden="true" />
              {p}
            </li>
          ))}
        </ul>
        {data.stores.length === 0 ? (
          <p className="mt-5 text-sm text-warning">{t('ride.noStores')}</p>
        ) : (
          <>
            <Button className="mt-5" onClick={() => agree.mutate()} loading={agree.isPending} disabled={agree.isPending}>
              {t('ride.consentAgree')}
            </Button>
            <p className="mt-2 text-xs text-silver/80">{t('ride.consentFine')}</p>
          </>
        )}
      </div>
    </section>
  );
}

/* ----- The next ride ------------------------------------------------------- */

function sortedLive(rides: Ride[], now: number): Ride[] {
  return rides
    .filter((r) => LIVE.includes(r.status) && new Date(r.targetAt).getTime() > now - 12 * H)
    .sort((a, b) => new Date(a.pickupAt ?? a.targetAt).getTime() - new Date(b.pickupAt ?? b.targetAt).getTime());
}

function useCancelRide() {
  const { t } = useI18n();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  return async (ride: Ride) => {
    const ok = await confirm({
      title: t('ride.cancelTitle'),
      description: t('ride.cancelBody'),
      confirmLabel: t('ride.cancel'),
      cancelLabel: t('ride.keep'),
      destructive: true,
    });
    if (!ok) return;
    try {
      await cancelMyRide(ride.id);
      toast.success(t('ride.cancelled'));
      await queryClient.invalidateQueries({ queryKey: ['transport', 'me'] });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : String(err));
    }
  };
}

function NextRideHero({
  data,
  onBook,
  onReport,
}: {
  data: MyTransport;
  onBook: () => void;
  onReport: (rideId: string) => void;
}) {
  const { t } = useI18n();
  const cancel = useCancelRide();
  const now = Date.now();
  const next = sortedLive(data.rides, now)[0];
  const live = useMyLiveRide();
  const liveHere = live && next && live.rideId === next.id ? live : null;

  if (!next) {
    return (
      <EmptyState
        icon={Bus}
        title={t('ride.none')}
        description={t('ride.noneBody')}
        action={
          data.stores.length > 0 ? (
            <Button onClick={onBook}>
              <Plus className="h-4 w-4" />
              {t('ride.book')}
            </Button>
          ) : (
            <span className="text-sm text-warning">{t('ride.noStores')}</span>
          )
        }
        className="mb-4"
      />
    );
  }

  const tz = next.store.timezone;
  const onVan = next.status === 'BOARDED';
  const waiting = next.status === 'REQUESTED';
  const headlineAt = next.pickupAt ?? next.targetAt;
  const cancellable = OPEN.includes(next.status) && next.run?.status !== 'ACTIVE';
  const targetLine =
    next.direction === 'TO_WORK'
      ? t('ride.arriveBy', { time: fmtTimeTz(next.targetAt, tz) })
      : t('ride.leaveAt', { time: fmtTimeTz(next.targetAt, tz) });

  return (
    <section
      aria-label={t('ride.nextRide')}
      className={cn(
        'relative mb-4 overflow-hidden rounded-lg border bg-navy animate-enter',
        onVan
          ? 'border-success/40 bg-gradient-to-br from-success/[0.12] via-transparent to-transparent'
          : 'border-gold/30 bg-gradient-to-br from-gold/[0.14] via-transparent to-transparent',
      )}
    >
      <div className="relative p-5">
        <div className="flex items-center justify-between gap-2">
          <span
            className={cn(
              'flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider',
              onVan ? 'text-success' : 'text-gold',
            )}
          >
            <Bus className="h-3.5 w-3.5" aria-hidden="true" />
            {onVan ? t('ride.onVan') : t('ride.nextRide')}
          </span>
          <Badge variant={statusVariant(next.status)}>{t(`ride.status.${next.status}` as MessageKey)}</Badge>
        </div>

        <div className="mt-2 text-3xl font-bold leading-tight tracking-tight text-white sm:text-4xl">
          {fmtRelativeDayTz(headlineAt, tz, now)}
          <span className="text-silver/50"> · </span>
          <span className="tabular-nums">
            {next.pickupAt ? t('ride.pickupAt', { time: fmtTimeTz(next.pickupAt, tz) }) : fmtTimeTz(next.targetAt, tz)}
          </span>
        </div>
        <p className="mt-1.5 text-sm text-silver">
          {next.direction === 'TO_WORK' ? t('ride.toWork') : t('ride.fromWork')} · {next.store.name}
          {' · '}
          {targetLine}
        </p>

        {liveHere && <LiveRideBlock live={liveHere} />}

        <div className="mt-4 space-y-2.5 border-t border-navy-secondary/60 pt-3">
          <div className="flex items-center gap-2 text-sm text-silver">
            <MapPin className="h-4 w-4 shrink-0 text-silver/70" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{pickupPlace(next)}</span>
            {next.direction === 'TO_WORK' && (
              <a
                href={mapsUrl(next.pickup.address)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex shrink-0 items-center text-sm text-gold underline underline-offset-2 hover:text-gold-bright coarse:min-h-9"
              >
                {t('shift.directions')}
              </a>
            )}
          </div>
          {next.direction === 'FROM_WORK' && (
            <div className="flex items-center gap-2 text-sm text-silver">
              <Home className="h-4 w-4 shrink-0 text-silver/70" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{homeEnd(next)}</span>
            </div>
          )}
          {next.run ? (
            <div className="flex items-center gap-2 text-sm text-white">
              <Bus className="h-4 w-4 shrink-0 text-gold" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">
                {t('ride.vanDriver', { van: next.run.van.name, driver: next.run.driver.name.split(' ')[0] ?? '' })}
                {next.run.van.plate && (
                  <span className="text-silver/80"> · {t('ride.plate', { plate: next.run.van.plate })}</span>
                )}
              </span>
            </div>
          ) : (
            waiting && <p className="text-sm text-silver">{t('ride.waitingVanBody')}</p>
          )}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
          {cancellable && (
            <Button size="sm" variant="secondary" onClick={() => void cancel(next)}>
              {t('ride.cancel')}
            </Button>
          )}
          <button
            type="button"
            onClick={() => onReport(next.id)}
            className="inline-flex items-center text-sm text-silver hover:text-white coarse:min-h-11"
          >
            {t('ride.report')}
          </button>
        </div>
      </div>
    </section>
  );
}

/* ----- The van, live ------------------------------------------------------- */

/** The rider's ride while the van is out (or about to leave): refetched
 *  every 15s, and the moment the server says the van moved. */
function useMyLiveRide(): MyLiveRide | null {
  const queryClient = useQueryClient();
  const q = useQuery({
    queryKey: ['transport', 'me', 'live'],
    queryFn: getMyLiveRide,
    refetchInterval: (query) => (query.state.data?.live?.runStatus === 'ACTIVE' ? 15_000 : 60_000),
  });
  useEffect(
    () =>
      onLiveEvent('transport', () => {
        void queryClient.invalidateQueries({ queryKey: ['transport', 'me'] });
      }),
    [queryClient],
  );
  return q.data?.live ?? null;
}

function useAgo(iso: string | null | undefined): string {
  const { t } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(id);
  }, []);
  if (!iso) return '';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return s < 10 ? t('ride.agoNow') : s < 60 ? t('ride.agoSec', { n: s }) : t('ride.agoMin', { n: Math.round(s / 60) });
}

const pt = (p: GeoPoint): [number, number] => [p.lng, p.lat];

export function LiveRideBlock({ live }: { live: MyLiveRide }) {
  const { t } = useI18n();
  const ago = useAgo(live.position?.at);
  const tz = live.timezone;
  const onVan = live.status === 'BOARDED';
  const toWork = live.direction === 'TO_WORK';
  const eta = onVan ? live.destination.etaAt : live.pickup.etaAt;
  const mins = eta ? Math.max(0, Math.round((Date.parse(eta) - Date.now()) / 60_000)) : null;

  const markers: MapMarker[] = [];
  if (live.position) {
    markers.push({ id: 'van', kind: 'van', ...live.position, label: live.van.name, stale: live.stale, highlight: true });
  }
  if (live.pickup.point && !onVan) {
    markers.push({ id: 'pickup', kind: toWork ? 'home' : 'store', ...live.pickup.point, label: live.pickup.label });
  }
  if (live.destination.point) {
    markers.push({ id: 'dest', kind: toWork ? 'store' : 'home', ...live.destination.point, label: live.destination.label });
  }
  const route = [
    ...(live.position ? [pt(live.position)] : []),
    ...(!onVan && live.pickup.point ? [pt(live.pickup.point)] : []),
    ...(live.destination.point ? [pt(live.destination.point)] : []),
  ];

  return (
    <div className="mt-4 rounded-md border border-navy-secondary/70 bg-navy-secondary/20 p-3">
      {live.runStatus === 'ACTIVE' ? (
        <>
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-2xl font-bold tracking-tight text-white tabular-nums">
              {onVan
                ? eta
                  ? t('ride.liveArriving', { time: fmtTimeTz(eta, tz) })
                  : t('ride.onVan')
                : mins === null
                  ? t('ride.liveOnWay', { van: live.van.name })
                  : mins <= 1
                    ? t('ride.liveHere')
                    : t('ride.liveAway', { min: mins })}
            </span>
            {live.position && (
              <span className={cn('shrink-0 text-xs', live.stale ? 'text-warning' : 'text-silver')}>
                {live.stale ? t('ride.liveStale', { ago }) : t('ride.liveUpdated', { ago })}
              </span>
            )}
          </div>
          {!onVan && (
            <p className="mt-0.5 text-sm text-silver">
              {t('ride.liveOnWay', { van: live.van.name })} ·{' '}
              {live.stopsBefore === 0
                ? t('ride.liveNextStop')
                : live.stopsBefore === 1
                  ? t('ride.liveStopsOne')
                  : t('ride.liveStopsMany', { count: live.stopsBefore })}
            </p>
          )}
          {live.lateMinutes >= 5 && (
            <p className="mt-1 text-sm font-medium text-warning">{t('ride.liveLate', { min: live.lateMinutes })}</p>
          )}
        </>
      ) : (
        <>
          <p className="text-sm font-medium text-white">
            {t('ride.liveLeaves', { van: live.van.name, time: fmtTimeTz(live.departAt, tz) })}
          </p>
          <p className="text-xs text-silver">{t('ride.liveNoPosition')}</p>
        </>
      )}
      {markers.length > 0 && (
        <LazyLiveMap
          ariaLabel={t('ride.liveMap')}
          className="mt-3 h-56 w-full sm:h-64"
          markers={markers}
          route={route.length > 1 ? route : undefined}
        />
      )}
    </div>
  );
}

/* ----- The rest of what's booked ------------------------------------------ */

function RideRow({ ride, action }: { ride: Ride; action?: React.ReactNode }) {
  const { t } = useI18n();
  const tz = ride.store.timezone;
  const at = ride.pickupAt ?? ride.targetAt;
  return (
    <li className="flex items-center gap-3 py-3">
      <div
        className={cn(
          'grid h-10 w-10 shrink-0 place-items-center rounded-full',
          ride.direction === 'TO_WORK' ? 'bg-gold/15 text-gold' : 'bg-steel/15 text-sky',
        )}
        aria-hidden="true"
      >
        {ride.direction === 'TO_WORK' ? <Bus className="h-4 w-4" /> : <Home className="h-4 w-4" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-white">
          {fmtRelativeDayTz(at, tz)} · <span className="whitespace-nowrap tabular-nums">{fmtTimeTz(at, tz)}</span>
        </div>
        <div className="truncate text-xs text-silver">
          {ride.direction === 'TO_WORK' ? t('ride.toWork') : t('ride.fromWork')} · {ride.store.name}
          {ride.run ? ` · ${ride.run.van.name}` : ''}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <Badge variant={statusVariant(ride.status)} size="sm">
            {t(`ride.status.${ride.status}` as MessageKey)}
          </Badge>
          {ride.owedCents > 0 && <span className="text-xs tabular-nums text-silver">{cents(ride.owedCents)}</span>}
          {ride.waived && <span className="text-xs text-success">{t('ride.waived')}</span>}
        </div>
      </div>
      {action}
    </li>
  );
}

function UpcomingRides({ data }: { data: MyTransport }) {
  const { t } = useI18n();
  const cancel = useCancelRide();
  const rest = sortedLive(data.rides, Date.now()).slice(1);
  if (rest.length === 0) return null;
  return (
    <Card className="mb-4">
      <CardContent className="pt-5">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-silver">{t('ride.upcoming')}</h2>
        <ul className="divide-y divide-navy-secondary/60">
          {rest.map((r) => (
            <RideRow
              key={r.id}
              ride={r}
              action={
                OPEN.includes(r.status) && r.run?.status !== 'ACTIVE' ? (
                  <Button size="icon-sm" variant="ghost" aria-label={t('ride.cancel')} onClick={() => void cancel(r)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                ) : undefined
              }
            />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function ChargesCard({ data }: { data: MyTransport }) {
  const { t } = useI18n();
  const c = data.charges;
  const payday = c.nextPayday ? parseYmd(c.nextPayday.payDate) : null;
  return (
    <Card className="mb-4">
      <CardContent className="flex items-center gap-4 pt-5">
        <div className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-gold/15 text-gold" aria-hidden="true">
          <Wallet className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium uppercase tracking-wider text-silver">{t('ride.chargesTitle')}</div>
          {c.pendingCents > 0 ? (
            <>
              <div className="mt-0.5 text-lg font-semibold text-white tabular-nums">
                {t('ride.chargesOwed', { amount: cents(c.pendingCents) })}
              </div>
              <div className="text-xs text-silver">
                {t('ride.chargesDetail', { rides: c.rides, noShows: c.noShows })}
                {payday && (
                  <>
                    {' · '}
                    {t('ride.nextPayday', {
                      date: payday.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }),
                    })}
                  </>
                )}
              </div>
            </>
          ) : (
            <div className="mt-0.5 text-sm text-white">{t('ride.chargesNone')}</div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function PastRides({ data, onReport }: { data: MyTransport; onReport: (rideId: string) => void }) {
  const { t } = useI18n();
  const past = data.rides
    .filter((r) => !LIVE.includes(r.status))
    .sort((a, b) => new Date(b.targetAt).getTime() - new Date(a.targetAt).getTime())
    .slice(0, 12);
  if (past.length === 0) return null;
  return (
    <Card className="mb-4">
      <CardContent className="pt-5">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-silver">{t('ride.past')}</h2>
        <ul className="divide-y divide-navy-secondary/60">
          {past.map((r) => (
            <RideRow
              key={r.id}
              ride={r}
              action={
                r.status === 'NO_SHOW' || r.status === 'COMPLETED' ? (
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t('ride.report')}
                    onClick={() => onReport(r.id)}
                  >
                    <AlertTriangle className="h-4 w-4" />
                  </Button>
                ) : undefined
              }
            />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function SavedPlaces({ data }: { data: MyTransport }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  if (data.places.length === 0) return null;
  const remove = async (id: string) => {
    try {
      await deleteRidePlace(id);
      await queryClient.invalidateQueries({ queryKey: ['transport', 'me'] });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : String(err));
    }
  };
  return (
    <Card className="mb-4">
      <CardContent className="pt-5">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-silver">{t('ride.places')}</h2>
        <ul className="divide-y divide-navy-secondary/60">
          {data.places.map((p) => (
            <li key={p.id} className="flex items-center gap-3 py-2.5">
              <Home className="h-4 w-4 shrink-0 text-silver/70" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <div className="text-sm text-white">{p.label}</div>
                <div className="truncate text-xs text-silver">{p.address}</div>
              </div>
              <Button size="xs" variant="ghost" onClick={() => void remove(p.id)}>
                {t('ride.removePlace')}
              </Button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/* ----- Book a ride ---------------------------------------------------------- */

type Way = RideDirection | 'BOTH';

/** "HH:MM" of an instant in `tz`. */
function hhmm(iso: string, tz: string): string {
  return utcToZonedDatetimeInput(iso, tz).slice(11, 16);
}

function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const at = new Date(Date.UTC(y!, m! - 1, d! + n));
  return at.toISOString().slice(0, 10);
}

export function BookRideDialog({
  data,
  open,
  onOpenChange,
}: {
  data: MyTransport;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const s = data.settings;
  const [way, setWay] = useState<Way>('TO_WORK');
  const [storeId, setStoreId] = useState(data.stores.length === 1 ? data.stores[0]!.id : '');
  const store = data.stores.find((x) => x.id === storeId) ?? null;
  const tz = store?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const earliest = useMemo(() => new Date(Date.now() + s.cutoffHours * H + 5 * 60_000), [s.cutoffHours]);
  // Open on the first bookable day: a 7:00 arrival that's already inside
  // the cutoff moves to the next morning instead of opening on an error.
  const [date, setDate] = useState(() => {
    const first = zonedDayKey(earliest, tz);
    return new Date(localInputToUtcIso(`${first}T07:00`, tz)) < earliest ? addDays(first, 1) : first;
  });
  const [arrive, setArrive] = useState('07:00');
  const [leave, setLeave] = useState('15:30');
  const [shiftId, setShiftId] = useState<string | null>(null);
  const firstPickup = data.places[0] ? `place:${data.places[0].id}` : data.stops[0] ? `stop:${data.stops[0].id}` : 'new';
  const [pickup, setPickup] = useState(firstPickup);
  const [address, setAddress] = useState('');
  // "Use where I am now": the phone's point, kept while the address it
  // filled in is unchanged.
  const [here, setHere] = useState<{ point: GeoPoint; address: string } | null>(null);
  const [locating, setLocating] = useState(false);
  const [saveAs, setSaveAs] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setError(null), [way, storeId, date, arrive, leave, pickup]);

  const shortcuts = data.shifts.filter(
    (sh) => sh.locationId && data.stores.some((x) => x.id === sh.locationId) && new Date(sh.endsAt) > earliest,
  );

  const pickShift = (id: string) => {
    const sh = data.shifts.find((x) => x.id === id);
    if (!sh) return;
    const st = data.stores.find((x) => x.id === sh.locationId);
    const z = st?.timezone ?? tz;
    setShiftId(sh.id);
    setStoreId(sh.locationId!);
    setDate(zonedDayKey(sh.startsAt, z));
    setArrive(hhmm(sh.startsAt, z));
    setLeave(hhmm(sh.endsAt, z));
  };

  // The instants, in the store's zone. A leave time at or before the arrive
  // time on a round trip is the next morning (an overnight shift).
  const toWorkAt = date && arrive ? localInputToUtcIso(`${date}T${arrive}`, tz) : null;
  const leaveDate = way === 'BOTH' && leave <= arrive ? addDays(date, 1) : date;
  const fromWorkAt = date && leave ? localInputToUtcIso(`${leaveDate}T${leave}`, tz) : null;
  const legs: Array<{ direction: RideDirection; at: string | null }> =
    way === 'TO_WORK'
      ? [{ direction: 'TO_WORK', at: toWorkAt }]
      : way === 'FROM_WORK'
        ? [{ direction: 'FROM_WORK', at: fromWorkAt }]
        : [
            { direction: 'TO_WORK', at: toWorkAt },
            { direction: 'FROM_WORK', at: fromWorkAt },
          ];
  const tooSoon = legs.some((l) => l.at && new Date(l.at) < earliest);
  const total = legs.length * s.fareCents;
  const pickupLabel = way === 'TO_WORK' ? t('ride.pickupTo') : way === 'FROM_WORK' ? t('ride.pickupFrom') : t('ride.pickupBoth');

  const useWhereIAm = () => {
    if (!navigator.geolocation) return setError(t('ride.locateFailed'));
    setLocating(true);
    setError(null);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const point = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        try {
          const { address: found } = await whereAmI(point);
          const text = found ?? `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`;
          setAddress(text);
          setHere({ point, address: text });
        } catch {
          setError(t('ride.locateFailed'));
        } finally {
          setLocating(false);
        }
      },
      () => {
        setLocating(false);
        setError(t('ride.locateFailed'));
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
    );
  };

  const submit = async () => {
    if (!store) return setError(t('ride.pickStore'));
    if (pickup === 'new' && address.trim().length < 5) return setError(t('ride.pickPickup'));
    if (tooSoon || legs.some((l) => !l.at)) return;
    setBusy(true);
    setError(null);
    try {
      let home: Pick<BookRideInput, 'stopId' | 'placeId' | 'address'>;
      if (pickup.startsWith('stop:')) home = { stopId: pickup.slice(5) };
      else if (pickup.startsWith('place:')) home = { placeId: pickup.slice(6) };
      else {
        const point = here && here.address === address ? here.point : null;
        if (saveAs.trim()) {
          const { place } = await addRidePlace({ label: saveAs.trim(), address: address.trim(), ...(point ?? {}) });
          home = { placeId: place.id };
        } else home = { address: address.trim(), ...(point ?? {}) };
      }
      let booked = 0;
      for (const leg of legs) {
        try {
          await bookRide({
            direction: leg.direction,
            locationId: store.id,
            ...home,
            targetAt: leg.at!,
            ...(note.trim() ? { note: note.trim() } : {}),
            ...(shiftId ? { shiftId } : {}),
          });
          booked += 1;
        } catch (err) {
          const msg = err instanceof ApiError ? err.message : String(err);
          if (booked === 0) throw err;
          toast.warning(t('ride.bookedHalf', { error: msg }));
          await queryClient.invalidateQueries({ queryKey: ['transport', 'me'] });
          onOpenChange(false);
          return;
        }
      }
      hapticConfirm();
      toast.success(legs.length === 2 ? t('ride.bookedBoth') : t('ride.booked'));
      await queryClient.invalidateQueries({ queryKey: ['transport', 'me'] });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('ride.book')}</DialogTitle>
          <DialogDescription>
            {t('ride.bookDesc', { fare: cents(s.fareCents), hours: s.cutoffHours })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <SegmentedControl<Way>
            ariaLabel={t('ride.book')}
            value={way}
            onChange={setWay}
            options={[
              { value: 'TO_WORK', label: t('ride.dirTo') },
              { value: 'FROM_WORK', label: t('ride.dirFrom') },
              { value: 'BOTH', label: t('ride.dirBoth') },
            ]}
          />

          {shortcuts.length > 0 && (
            <div>
              <div className="mb-1.5 text-xs font-medium uppercase tracking-wider text-silver">{t('ride.fromShift')}</div>
              <div className="flex flex-wrap gap-1.5">
                {shortcuts.slice(0, 6).map((sh) => {
                  const z = data.stores.find((x) => x.id === sh.locationId)?.timezone ?? tz;
                  return (
                    <button
                      key={sh.id}
                      type="button"
                      onClick={() => pickShift(sh.id)}
                      aria-pressed={shiftId === sh.id}
                      className={cn(
                        'rounded-full border px-3 py-1 text-xs transition coarse:min-h-11',
                        shiftId === sh.id
                          ? 'border-gold bg-gold/15 text-gold'
                          : 'border-navy-secondary text-silver hover:border-silver/40 hover:text-white',
                      )}
                    >
                      {fmtRelativeDayTz(sh.startsAt, z)} · {fmtTimeTz(sh.startsAt, z)}–{fmtTimeTz(sh.endsAt, z)}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {data.stores.length > 1 && (
            <Field label={t('ride.store')} required>
              {(p) => (
                <Select {...p} value={storeId} onChange={(e) => { setStoreId(e.target.value); setShiftId(null); }}>
                  <option value="">{t('ride.pickStore')}</option>
                  {data.stores.map((st) => (
                    <option key={st.id} value={st.id}>
                      {st.clientName} · {st.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label={t('ride.date')} required>
              {(p) => (
                <Input
                  {...p}
                  type="date"
                  value={date}
                  min={zonedDayKey(earliest, tz)}
                  onChange={(e) => { setDate(e.target.value); setShiftId(null); }}
                />
              )}
            </Field>
            {way !== 'FROM_WORK' && (
              <Field label={t('ride.arriveByLabel')} required>
                {(p) => <Input {...p} type="time" value={arrive} onChange={(e) => { setArrive(e.target.value); setShiftId(null); }} />}
              </Field>
            )}
            {way !== 'TO_WORK' && (
              <Field label={t('ride.leaveAtLabel')} required>
                {(p) => <Input {...p} type="time" value={leave} onChange={(e) => { setLeave(e.target.value); setShiftId(null); }} />}
              </Field>
            )}
          </div>

          <Field label={pickupLabel} required>
            {(p) => (
              <Select {...p} value={pickup} onChange={(e) => setPickup(e.target.value)}>
                {data.stops.length > 0 && (
                  <optgroup label={t('ride.groupStops')}>
                    {data.stops.map((st) => (
                      <option key={st.id} value={`stop:${st.id}`}>
                        {st.name}
                      </option>
                    ))}
                  </optgroup>
                )}
                {data.places.length > 0 && (
                  <optgroup label={t('ride.groupSaved')}>
                    {data.places.map((pl) => (
                      <option key={pl.id} value={`place:${pl.id}`}>
                        {pl.label} — {pl.address}
                      </option>
                    ))}
                  </optgroup>
                )}
                <option value="new">{t('ride.newAddress')}</option>
              </Select>
            )}
          </Field>
          {pickup === 'new' && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label={t('ride.address')} required className="sm:col-span-2">
                {(p) => (
                  <Input
                    {...p}
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    placeholder={t('ride.addressPlaceholder')}
                    autoComplete="street-address"
                  />
                )}
              </Field>

              <Field label={t('ride.saveAs')}>
                {(p) => (
                  <Input {...p} value={saveAs} onChange={(e) => setSaveAs(e.target.value)} placeholder={t('ride.saveAsPlaceholder')} maxLength={40} />
                )}
              </Field>
              <div className="sm:col-span-3 -mt-1">
                <Button type="button" size="xs" variant="ghost" onClick={useWhereIAm} loading={locating} disabled={locating}>
                  <MapPin className="h-3.5 w-3.5" />
                  {locating ? t('ride.locating') : t('ride.useWhereIAm')}
                </Button>
              </div>
            </div>
          )}
          <Field label={t('ride.note')}>
            {(p) => (
              <Input {...p} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('ride.notePlaceholder')} maxLength={300} />
            )}
          </Field>

          {tooSoon && (
            <p role="alert" className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-warning">
              {t('ride.tooSoon', {
                hours: s.cutoffHours,
                when: `${fmtRelativeDayTz(earliest, tz)} ${fmtTimeTz(earliest, tz)}`,
              })}
            </p>
          )}
          {error && (
            <p role="alert" className="rounded-md border border-alert/40 bg-alert/10 p-3 text-sm text-alert">
              {error}
            </p>
          )}
        </div>
        <DialogFooter className="items-center sm:justify-between">
          <span className="text-sm text-silver tabular-nums">{t('ride.total', { amount: cents(total) })}</span>
          <Button onClick={() => void submit()} loading={busy} disabled={busy || tooSoon || !store}>
            {legs.length === 2 ? t('ride.bookBoth') : t('ride.bookOne')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ----- Report a problem ----------------------------------------------------- */

function ReportDialog({
  rides,
  initialRideId,
  open,
  onOpenChange,
}: {
  rides: Ride[];
  initialRideId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const initial = rides.find((r) => r.id === initialRideId);
  const [category, setCategory] = useState<TransportIssueCategory>(
    initial?.status === 'NO_SHOW' ? 'CHARGE_DISPUTE' : 'LATE_VAN',
  );
  const [rideId, setRideId] = useState(initialRideId ?? '');
  const [body, setBody] = useState('');
  const send = useMutation({
    mutationFn: () => reportTransportIssue({ category, body: body.trim(), ...(rideId ? { rideId } : {}) }),
    onSuccess: () => {
      toast.success(t('ride.reportSent'));
      onOpenChange(false);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : String(err)),
  });
  const choices = rides
    .filter((r) => r.status !== 'CANCELLED')
    .sort((a, b) => new Date(b.targetAt).getTime() - new Date(a.targetAt).getTime())
    .slice(0, 15);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('ride.report')}</DialogTitle>
          <DialogDescription>{t('ride.reportDesc')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Field label={t('ride.reportWhat')} required>
            {(p) => (
              <Select {...p} value={category} onChange={(e) => setCategory(e.target.value as TransportIssueCategory)}>
                {ISSUE_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {t(`ride.cat.${c}` as MessageKey)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {choices.length > 0 && (
            <Field label={t('ride.reportRide')}>
              {(p) => (
                <Select {...p} value={rideId} onChange={(e) => setRideId(e.target.value)}>
                  <option value="">{t('ride.reportNoRide')}</option>
                  {choices.map((r) => (
                    <option key={r.id} value={r.id}>
                      {fmtRelativeDayTz(r.pickupAt ?? r.targetAt, r.store.timezone)}{' '}
                      {fmtTimeTz(r.pickupAt ?? r.targetAt, r.store.timezone)} ·{' '}
                      {r.direction === 'TO_WORK' ? t('ride.toWork') : t('ride.fromWork')} ·{' '}
                      {t(`ride.status.${r.status}` as MessageKey)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
          <Field label={t('ride.reportBody')} required>
            {(p) => <Textarea {...p} rows={4} value={body} onChange={(e) => setBody(e.target.value)} maxLength={2000} />}
          </Field>
        </div>
        <DialogFooter>
          <Button
            onClick={() => send.mutate()}
            loading={send.isPending}
            disabled={send.isPending || body.trim().length < 5}
          >
            {t('ride.reportSend')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
