import { useEffect, useMemo, useState } from 'react';
import { onLiveEvent } from '@/lib/liveEvents';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Bus, Check, Home, MapPin, Plus, Trash2, UserRound, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { cn } from '@/lib/cn';
import { useConfirm } from '@/lib/confirm';
import { hapticConfirm } from '@/lib/haptics';
import { fmtDayHeaderTz, fmtDayShort, fmtMoney, fmtMonthShortYear, fmtRelativeDayTz, fmtTimeTz, fmtWeekdayTz, localInputToUtcIso, mapsUrl, parseYmd, utcToZonedDatetimeInput, zonedDayKey } from '@/lib/format';
import {
  addRidePlace,
  bookRide,
  cancelMyRide,
  deleteRidePlace,
  getMyTransport,
  getMyCrew,
  getMyLiveRide,
  getShiftTrips,
  giveRideConsent,
  NO_SHOW_WAIT_MS,
  reportTransportIssue,
  signalDriver,
  type BookRideInput,
  type MyLiveRide,
  type MyTransport,
  type Ride,
  type RideDirection,
  type RideStatus,
  type RiderSignal,
  type ShiftTrip,
  type StoreShiftWindow,
  type TransportIssueCategory,
  vanLookText,
} from '@/lib/transportApi';
import { SoundToggle } from '@/components/transport/SoundToggle';
import { useRiderAlerts } from './useRiderAlerts';
import { bookShifts, coverageFor, fmtClock, fmtIn, type Shift } from './rideShifts';
import { fmtWindow, shiftTargetIso, windowForShift } from './shiftTrips';
import { PageHeader } from '@/components/ui/PageHeader';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { Input, Textarea } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { TripMap, tripStage } from './TripMap';
import { Skeleton } from '@/components/ui/Skeleton';
import { QueryError } from '@/components/ui/QueryError';
import { PickupPicker, type Pickup } from './PickupPicker';
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

/**
 * What a rider is told when something didn't go through.
 *
 * ApiError carries the server's own sentence, which is always the better
 * one. Everything else was going straight to String(): an associate in a
 * parking lot with one bar got "TypeError: Failed to fetch" on the button
 * they just pressed, which reads as "the app is broken" rather than "say
 * that again". Same fallback wording as QueryError, for the same reason.
 */
function why(err: unknown): string {
  return err instanceof ApiError ? err.message : 'The request didn’t get through. Check your signal and try again.';
}

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
  // The booking form, open — blank, or prefilled from a shift / a past ride.
  const [booking, setBooking] = useState<BookPrefill | null>(null);
  const [reporting, setReporting] = useState<{ rideId?: string } | null>(null);
  const data = me.data;
  const canBook = !!data?.consent && (data?.stores.length ?? 0) > 0;
  useRiderAlerts(data, useMyLiveRide());
  // With a ride coming the trip leads — the explainer steps aside.
  const riding = !!data?.consent && sortedLive(data.rides, Date.now()).length > 0;

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title={t('ride.title')}
        subtitle={riding ? undefined : t('ride.subtitle')}
        className={riding ? 'mb-3 md:mb-5' : undefined}
        secondaryActions={<SoundToggle onLabel={t('ride.soundsOn')} offLabel={t('ride.soundsOff')} />}
        primaryAction={
          canBook ? (
            <Button onClick={() => setBooking({})}>
              <Plus className="h-4 w-4" />
              {t('ride.book')}
            </Button>
          ) : undefined
        }
      />
      {me.isLoading || !data ? (
        me.isError ? (
          <QueryError what="your rides" query={me} />
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
          <NextRideHero data={data} onBook={() => setBooking({})} onReport={(rideId) => setReporting({ rideId })} />
          <ShiftRides data={data} onCustom={(shift) => setBooking(prefillFromShift(data, shift))} />
          <RideCalendar data={data} />
          <ChargesCard data={data} />
          <PastRides
            data={data}
            onReport={(rideId) => setReporting({ rideId })}
            onBookAgain={(ride) => setBooking(prefillFromRide(data, ride))}
          />
          <SavedPlaces data={data} />
          <div className="mt-2 mb-8 flex justify-center">
            <Button variant="ghost" size="sm" onClick={() => setReporting({})}>
              <AlertTriangle className="h-4 w-4" />
              {t('ride.report')}
            </Button>
          </div>
        </>
      )}
      {data && booking && (
        <BookRideDialog data={data} initial={booking} open onOpenChange={(o) => !o && setBooking(null)} />
      )}
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
    onError: (err) => toast.error(why(err)),
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
      toast.error(why(err));
    }
  };
}

/** Re-render on a tick — countdowns and "Updated 20s ago" move. */
function useTick(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}

const STEPS = ['ride.step.booked', 'ride.step.van', 'ride.step.onWay', 'ride.step.here', 'ride.step.aboard'] as const;

/** Where the ride is, Uber-style: booked → van set → on the way → here → on board. */
export function rideStep(ride: Ride, live: MyLiveRide | null): number {
  if (ride.status === 'BOARDED' || ride.status === 'COMPLETED') return 4;
  if (ride.vanArrivedAt || live?.vanArrivedAt) return 3;
  if (ride.run?.status === 'ACTIVE' || live?.runStatus === 'ACTIVE') return 2;
  if (ride.run) return 1;
  return 0;
}

function RideStepper({ step, tone }: { step: number; tone: 'gold' | 'success' }) {
  const { t } = useI18n();
  return (
    <ol className="mt-3 grid grid-cols-5 gap-1" aria-label={t(STEPS[step]!)}>
      {STEPS.map((k, i) => (
        <li key={k} className="min-w-0" aria-current={i === step ? 'step' : undefined}>
          <div
            className={cn(
              'h-1.5 rounded-full',
              i < step ? (tone === 'success' ? 'bg-success/60' : 'bg-gold/60') : i === step ? (tone === 'success' ? 'bg-success' : 'bg-gold') : 'bg-navy-secondary',
            )}
          />
          <div className={cn('mt-1 truncate text-2xs', i === step ? 'font-semibold text-white' : 'text-silver/70')}>{t(k)}</div>
        </li>
      ))}
    </ol>
  );
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
  const queryClient = useQueryClient();
  const [signalling, setSignalling] = useState(false);
  const [crewOpen, setCrewOpen] = useState(false);
  const next = sortedLive(data.rides, Date.now())[0];
  const live = useMyLiveRide();
  const liveHere = live && next && live.rideId === next.id ? live : null;
  const arrivedAt = next?.vanArrivedAt ?? liveHere?.vanArrivedAt ?? null;
  const now = useTick(arrivedAt ? 1_000 : 15_000);

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
  const stage = tripStage(next, liveHere);
  const onVan = stage === 'ON_BOARD';
  const here = stage === 'HERE' && next.status === 'SCHEDULED';
  const onTheWay = stage === 'ON_THE_WAY';
  const step = rideStep(next, liveHere);
  const headlineAt = next.pickupAt ?? next.targetAt;
  const untilPickup = Date.parse(headlineAt) - now;
  const cancellable = OPEN.includes(next.status) && next.run?.status !== 'ACTIVE';
  const driverFirst = next.run?.driver.name.split(' ')[0] ?? liveHere?.driver ?? '';
  const vanName = next.run?.van.name ?? liveHere?.van?.name ?? '';
  const signal = next.riderSignal?.kind ?? liveHere?.riderSignal ?? null;
  const targetLine =
    next.direction === 'TO_WORK'
      ? t('ride.arriveBy', { time: fmtTimeTz(next.targetAt, tz) })
      : t('ride.leaveAt', { time: fmtTimeTz(next.targetAt, tz) });
  const green = onVan || here;
  const waitLeft = arrivedAt ? Date.parse(arrivedAt) + NO_SHOW_WAIT_MS - now : 0;
  const shift = next.windowLabel ?? null;
  const waitlist = next.status === 'REQUESTED' ? (next.waitlist ?? null) : null;
  const tripLine = [
    next.direction === 'TO_WORK' ? t('ride.toWork') : t('ride.fromWork'),
    next.store.name,
    ...(shift ? [t('ride.shiftTag', { shift })] : []),
    targetLine,
  ].join(' · ');
  // The live numbers, once the van is out.
  const liveOut = liveHere?.runStatus === 'ACTIVE' ? liveHere : null;
  const eta = liveOut ? (onVan ? liveOut.destination.etaAt : liveOut.pickup.etaAt) : null;
  const mins = eta ? Math.max(0, Math.round((Date.parse(eta) - now) / 60_000)) : null;

  const tell = async (kind: RiderSignal) => {
    setSignalling(true);
    try {
      await signalDriver(next.id, kind);
      hapticConfirm();
      toast.success(kind === 'OUTSIDE' ? t('ride.toldOutside', { driver: driverFirst }) : t('ride.toldLate', { driver: driverFirst }));
      await queryClient.invalidateQueries({ queryKey: ['transport', 'me'] });
    } catch (err) {
      toast.error(why(err));
    } finally {
      setSignalling(false);
    }
  };

  // The one line a rider reads first, per stage.
  const headline =
    stage === 'FINDING' && waitlist ? (
      <div className="mt-2 text-3xl font-bold leading-tight tracking-tight text-white sm:text-4xl">
        {t('ride.waitlistTitle', { position: waitlist.position })}
      </div>
    ) : stage === 'FINDING' ? (
      <div className="mt-2 flex items-baseline gap-1 text-3xl font-bold leading-tight tracking-tight text-white sm:text-4xl">
        {t('ride.findingDriver')}
        <FindingDots />
      </div>
    ) : here ? (
      <div className="mt-2 text-3xl font-bold leading-tight tracking-tight text-white sm:text-4xl">{t('ride.vanHere')}</div>
    ) : onVan && liveOut ? (
      <div className="mt-2 text-3xl font-bold leading-tight tracking-tight text-white tabular-nums sm:text-4xl">
        {eta ? t('ride.liveArriving', { time: fmtTimeTz(eta, tz) }) : t('ride.onVan')}
      </div>
    ) : onTheWay && liveOut ? (
      <div className="mt-2 text-3xl font-bold leading-tight tracking-tight text-white tabular-nums sm:text-4xl">
        {mins === null ? t('ride.liveOnWay', { van: vanName }) : mins <= 1 ? t('ride.liveHere') : t('ride.liveAway', { min: mins })}
      </div>
    ) : (
      <div className="mt-2 text-3xl font-bold leading-tight tracking-tight text-white sm:text-4xl">
        {fmtRelativeDayTz(headlineAt, tz, now)}
        <span className="text-silver/50"> · </span>
        <span className="tabular-nums">
          {next.pickupAt ? t('ride.pickupAt', { time: fmtTimeTz(next.pickupAt, tz) }) : fmtTimeTz(next.targetAt, tz)}
        </span>
      </div>
    );

  const subline = here ? (
    <>
      <p className="mt-1.5 text-sm text-silver">{t('ride.vanHereBody', { driver: driverFirst, place: pickupPlace(next) })}</p>
      <WaitRing left={waitLeft} />
    </>
  ) : onTheWay && liveOut ? (
    <LiveLines live={liveOut} vanName={vanName} />
  ) : onVan && liveOut ? (
    <>
      <p className="mt-1.5 text-sm text-silver">
        {next.direction === 'TO_WORK' ? t('ride.toWork') : t('ride.fromWork')} · {liveOut.destination.label}
      </p>
      <TripProgress from={next.boardedAt ?? liveOut.departAt} to={eta} now={now} />
    </>
  ) : stage === 'FINDING' ? (
    <>
      <p className="mt-1.5 text-sm text-silver">
        {fmtRelativeDayTz(headlineAt, tz, now)} · {tripLine}
      </p>
      {waitlist ? (
        <p className="mt-1 text-xs text-warning">
          {t('ride.waitlistBody', { shift: shift ?? '', position: waitlist.position, of: waitlist.of })}
        </p>
      ) : (
        <p className="mt-1 text-xs text-silver/80">
          {next.seats ? t('ride.seatsWaiting') : t('ride.waitingVanBody')}
        </p>
      )}
    </>
  ) : (
    <>
      <p className="mt-1.5 text-sm text-silver">{tripLine}</p>
      {next.run && next.run.status === 'PLANNED' && (
        <p className="mt-0.5 text-xs text-silver/80">
          {t('ride.liveLeaves', { van: next.run.van.name, time: fmtTimeTz(next.run.departAt, tz) })}
        </p>
      )}
    </>
  );

  const vanChip = next.run?.van.plate ? (
    <span className="shrink-0 rounded-md border border-silver/40 bg-white px-2 py-1 font-mono text-xs font-bold tracking-wider text-[#0B1832]">
      {next.run.van.plate}
    </span>
  ) : null;

  return (
    <section
      aria-label={t('ride.nextRide')}
      className={cn(
        'relative mb-4 overflow-hidden border-y bg-navy animate-enter -mx-4 sm:mx-0 sm:rounded-xl sm:border',
        green ? 'border-success/40' : 'border-gold/30',
      )}
    >
      {liveHere && (
        <TripMap
          stage={stage}
          live={liveHere}
          vanLabel={vanName}
          className="h-[42vh] min-h-[15rem] max-h-[26rem]"
          overlay={
            <div className="rounded-xl border border-navy-secondary bg-navy/95 p-4 shadow-2xl backdrop-blur">
              <div className="text-xs font-medium uppercase tracking-wider text-gold">{t('ride.nextRide')}</div>
              {headline}
              {!here && !onTheWay && !onVan && <p className="mt-1 text-sm text-silver">{tripLine}</p>}
              {(onTheWay || onVan) && liveOut && (
                <p className="mt-1 text-sm text-silver">
                  {vanName}
                  {next.run?.van.plate ? ` · ${next.run.van.plate}` : ''} · {driverFirst}
                </p>
              )}
            </div>
          }
        />
      )}
      <div
        className={cn(
          'relative p-5',
          liveHere && '-mt-5 rounded-t-2xl border-t border-navy-secondary/80 bg-navy shadow-[0_-12px_30px_rgba(0,0,0,.45)]',
          green
            ? 'bg-gradient-to-br from-success/[0.12] via-navy to-navy'
            : 'bg-gradient-to-br from-gold/[0.12] via-navy to-navy',
        )}
      >
        <div className="flex items-center justify-between gap-2">
          <span className={cn('flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider', green ? 'text-success' : 'text-gold')}>
            <Bus className="h-3.5 w-3.5" aria-hidden="true" />
            {here ? t('ride.vanHere') : onVan ? t('ride.onVan') : t('ride.nextRide')}
          </span>
          {here ? (
            <span className="relative flex h-2 w-2" aria-hidden="true">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60 motion-reduce:hidden" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
            </span>
          ) : (onTheWay || onVan) && eta ? (
            <span className="text-xs tabular-nums text-silver/80">{t('ride.etaAt', { time: fmtTimeTz(eta, tz) })}</span>
          ) : !onVan && !onTheWay && untilPickup > 0 && untilPickup < 24 * H ? (
            <span className="text-xs tabular-nums text-silver/80">
              {next.pickupAt ? t('ride.pickupIn', { time: fmtIn(untilPickup) }) : t('ride.leavesIn', { time: fmtIn(untilPickup) })}
            </span>
          ) : (
            <RideBadge ride={next} />
          )}
        </div>

        {headline}
        {subline}

        <RideStepper step={step} tone={green ? 'success' : 'gold'} />

        <div className="mt-4 space-y-2.5 border-t border-navy-secondary/60 pt-3">
          {next.run ? (
            <button
              type="button"
              onClick={() => setCrewOpen(true)}
              className="-mx-2 flex w-[calc(100%+1rem)] items-center gap-2.5 rounded-md px-2 py-1 text-left hover:bg-navy-secondary/30"
              aria-label={t('ride.crewOpen')}
            >
              <Avatar
                src={next.run.driver.associateId ? `/api/associates/${next.run.driver.associateId}/photo` : undefined}
                name={next.run.driver.name}
                email=""
                size="md"
              />
              <div className="min-w-0 flex-1">
                <div className="text-sm">
                  <span className="font-medium text-white">{driverFirst}</span>
                  <span className="text-silver"> · {next.run.van.name}</span>
                </div>
                <div className="truncate text-xs text-silver">{vanLookText(next.run.van) || t('ride.driverLabel')}</div>
              </div>
              {vanChip}
            </button>
          ) : null}
          {next.coRiders && next.coRiders.length > 0 && <RidingWith ride={next} />}
          <div className="flex items-center gap-2 text-sm text-silver">
            <MapPin className="h-4 w-4 shrink-0 text-silver/70" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{pickupPlace(next)}</span>
            {next.direction === 'TO_WORK' && (
              <a
                href={mapsUrl(next.pickup.address)}
                target="_blank"
                rel="noreferrer"
                // min-h-9 was a half-measure: 36px is still under the 44px
                // floor, and this one opens Maps while they're walking out.
                className="inline-flex shrink-0 items-center text-sm text-gold underline underline-offset-2 hover:text-gold-bright coarse:min-h-11"
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
        </div>

        {crewOpen && <CrewDialog rideId={next.id} onClose={() => setCrewOpen(false)} />}

        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
          {(onTheWay || here) &&
            (signal ? (
              <span className="inline-flex items-center gap-1 text-sm text-success">
                <Check className="h-4 w-4" aria-hidden="true" />
                {signal === 'OUTSIDE' ? t('ride.toldOutside', { driver: driverFirst }) : t('ride.toldLate', { driver: driverFirst })}
              </span>
            ) : (
              <>
                <Button size="sm" onClick={() => void tell('OUTSIDE')} disabled={signalling}>
                  <Check className="h-3.5 w-3.5" />
                  {t('ride.imOutside')}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => void tell('LATE')} disabled={signalling}>
                  {t('ride.runningLate')}
                </Button>
              </>
            ))}
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

/** "Finding you a driver…" — the dots breathe while drivers look. */
function FindingDots() {
  return (
    <span className="inline-flex gap-1 self-center" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 animate-pulse rounded-full bg-gold motion-reduce:animate-none"
          style={{ animationDelay: `${i * 200}ms` }}
        />
      ))}
    </span>
  );
}

/** The time left to get on board, as a ring that runs down. */
function WaitRing({ left }: { left: number }) {
  const { t } = useI18n();
  const frac = Math.max(0, Math.min(1, left / NO_SHOW_WAIT_MS));
  const r = 16;
  const c = 2 * Math.PI * r;
  if (left <= 0) return <p className="mt-2 text-sm font-semibold text-warning">{t('ride.waitOver')}</p>;
  return (
    <div className="mt-2 flex items-center gap-2.5">
      <svg viewBox="0 0 40 40" className="h-9 w-9 shrink-0 -rotate-90" aria-hidden="true">
        <circle cx="20" cy="20" r={r} fill="none" strokeWidth="4" className="stroke-navy-secondary" />
        <circle
          cx="20"
          cy="20"
          r={r}
          fill="none"
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - frac)}
          className="stroke-success transition-[stroke-dashoffset] duration-1000 ease-linear"
        />
      </svg>
      <p className="text-sm font-semibold tabular-nums text-success">{t('ride.waitLeft', { time: fmtClock(left) })}</p>
    </div>
  );
}

/** On board: how far into the trip, by the clock. */
function TripProgress({ from, to, now }: { from: string | null; to: string | null; now: number }) {
  if (!from || !to) return null;
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (!(b > a)) return null;
  const pct = Math.round(Math.max(0.04, Math.min(1, (now - a) / (b - a))) * 100);
  return (
    <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-navy-secondary" aria-hidden="true">
      <div className="h-full rounded-full bg-success transition-[width] duration-1000" style={{ width: `${pct}%` }} />
    </div>
  );
}

/** The van to look for and who's driving it — the ride-hailing card. */
function CrewDialog({ rideId, onClose }: { rideId: string; onClose: () => void }) {
  const { t } = useI18n();
  const q = useQuery({ queryKey: ['transport', 'me', 'crew', rideId], queryFn: () => getMyCrew(rideId) });
  const crew = q.data?.crew;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('ride.crewTitle')}</DialogTitle>
        </DialogHeader>
        {q.isError ? (
          <QueryError what="who else is on this ride" query={q} />
        ) : !crew ? (
          <Skeleton className="h-40" />
        ) : (
          <div className="space-y-4">
            <div className="rounded-lg border border-navy-secondary bg-navy-secondary/20 p-4 text-center">
              <div className="text-2xs font-medium uppercase tracking-wider text-silver">{t('ride.lookFor')}</div>
              {crew.van.plate && (
                <div className="mx-auto mt-2 inline-block rounded-md border-2 border-[#0B1832] bg-white px-4 py-1.5 font-mono text-2xl font-bold tracking-widest text-[#0B1832]">
                  {crew.van.plate}
                </div>
              )}
              <div className="mt-2 text-lg font-semibold text-white">{crew.van.look || crew.van.name}</div>
              <div className="text-sm text-silver">
                {crew.van.name} · {t('ride.crewSeats', { count: crew.van.capacity })}
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Avatar
                src={crew.driver.associateId ? `/api/associates/${crew.driver.associateId}/photo` : undefined}
                name={crew.driver.name}
                email=""
                size="lg"
              />
              <div className="min-w-0">
                <div className="text-base font-semibold text-white">{crew.driver.name}</div>
                <div className="text-xs text-silver">
                  {t('ride.crewSince', {
                    date: fmtMonthShortYear(crew.driver.since),
                  })}
                </div>
                <div className="mt-0.5 text-xs text-silver">
                  {t('ride.crewTrips', { count: crew.driver.trips })} · {t('ride.crewRiders', { count: crew.driver.riders })}
                </div>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ----- Rides for your shifts — one tap ------------------------------------- */

export function ShiftRides({ data, onCustom }: { data: MyTransport; onCustom: (shift: Shift) => void }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const covers = coverageFor(data).slice(0, 6);
  if (covers.length === 0) return null;
  const fare = data.settings.fareCents;
  const pickup = data.defaultPickup;
  const open = covers.filter((c) => c.canBook.length > 0);
  const openLegs = open.reduce((n, c) => n + c.canBook.length, 0);

  const book = async (key: string, list: typeof covers) => {
    if (!pickup) return onCustom(list[0]!.shift);
    setBusy(key);
    try {
      const n = await bookShifts(data, list);
      hapticConfirm();
      toast.success(n === 1 ? t('ride.booked') : t('ride.bookedCount', { count: n }));
    } catch (err) {
      toast.error(why(err));
    } finally {
      setBusy(null);
      await queryClient.invalidateQueries({ queryKey: ['transport', 'me'] });
    }
  };

  return (
    <Card className="mb-4">
      <CardContent className="pt-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-silver">{t('ride.forShifts')}</h2>
            <p className="mt-0.5 text-xs text-silver/80">
              {pickup ? t('ride.forShiftsFrom', { pickup: pickup.label }) : t('ride.forShiftsNoPickup')}
            </p>
          </div>
          {pickup && open.length > 1 && (
            <Button size="sm" onClick={() => void book('all', open)} loading={busy === 'all'} disabled={!!busy}>
              {t('ride.bookAll', { amount: cents(openLegs * fare) })}
            </Button>
          )}
        </div>
        <ul className="mt-2 divide-y divide-navy-secondary/60">
          {covers.map((c) => {
            const store = data.stores.find((st) => st.id === c.shift.locationId);
            const tz = store?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
            const both = !!c.there && !!c.home;
            const label =
              c.canBook.length === 2
                ? t('ride.roundTrip', { amount: cents(2 * fare) })
                : c.canBook[0] === 'FROM_WORK'
                  ? t('ride.addHome', { amount: cents(fare) })
                  : t('ride.addThere', { amount: cents(fare) });
            return (
              <li key={c.shift.id} className="flex items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-white">
                    {fmtRelativeDayTz(c.shift.startsAt, tz)} ·{' '}
                    <span className="tabular-nums">
                      {fmtTimeTz(c.shift.startsAt, tz)}–{fmtTimeTz(c.shift.endsAt, tz)}
                    </span>
                  </div>
                  <div className="truncate text-xs text-silver">
                    {store?.name}
                    {c.there && !both && ` · ${t('ride.thereBooked')}`}
                    {c.home && !both && ` · ${t('ride.homeBooked')}`}
                  </div>
                </div>
                {both ? (
                  <span className="inline-flex shrink-0 items-center gap-1 text-xs text-success">
                    <Check className="h-3.5 w-3.5" aria-hidden="true" />
                    {t('ride.bothBooked')}
                  </span>
                ) : c.canBook.length === 0 ? (
                  <span className="shrink-0 text-xs text-silver/70">{t('ride.tooSoonShift')}</span>
                ) : (
                  <Button
                    size="sm"
                    variant={c === open[0] ? 'primary' : 'secondary'}
                    className="shrink-0"
                    onClick={() => void book(c.shift.id, [c])}
                    loading={busy === c.shift.id}
                    disabled={!!busy}
                  >
                    {label}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
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

/** Where the van is, in words: who's coming and the stops before them,
 *  how fresh the position is, and whether it's running late. */
function LiveLines({ live, vanName }: { live: MyLiveRide; vanName: string }) {
  const { t } = useI18n();
  const ago = useAgo(live.position?.at);
  return (
    <>
      <p className="mt-1.5 text-sm text-silver">
        {t('ride.liveOnWay', { van: vanName })} ·{' '}
        {live.stopsBefore === 0
          ? t('ride.liveNextStop')
          : live.stopsBefore === 1
            ? t('ride.liveStopsOne')
            : t('ride.liveStopsMany', { count: live.stopsBefore })}
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 text-xs">
        {live.position && (
          <span className={live.stale ? 'text-warning' : 'text-silver/80'}>
            {live.stale ? t('ride.liveStale', { ago }) : t('ride.liveUpdated', { ago })}
          </span>
        )}
        {live.lateMinutes >= 5 && <span className="font-medium text-warning">{t('ride.liveLate', { min: live.lateMinutes })}</span>}
      </div>
    </>
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
          {ride.windowLabel ? ` · ${t('ride.shiftTag', { shift: ride.windowLabel })}` : ''}
          {ride.run ? ` · ${ride.run.van.name}` : ''}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <RideBadge ride={ride} size="sm" />
          {ride.coRiders && ride.coRiders.length > 0 && <FaceStack faces={ride.coRiders} size={20} max={5} />}
          {ride.owedCents > 0 && <span className="text-xs tabular-nums text-silver">{cents(ride.owedCents)}</span>}
          {ride.waived && <span className="text-xs text-success">{t('ride.waived')}</span>}
        </div>
      </div>
      {action}
    </li>
  );
}

/**
 * Their rides like the schedule — a strip of days, each with a dot per
 * ride, and the day's rides under it: which shift, the van, where they
 * stand in line, and the faces they ride with.
 */
function RideCalendar({ data }: { data: MyTransport }) {
  const { t } = useI18n();
  const cancel = useCancelRide();
  const now = Date.now();
  const live = sortedLive(data.rides, now);
  const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const dayOf = (r: Ride) => zonedDayKey(r.pickupAt ?? r.targetAt, r.store.timezone);
  const today = zonedDayKey(new Date(now), localTz);
  const last = live.reduce((m, r) => (dayOf(r) > m ? dayOf(r) : m), today);
  const span = Math.min(31, Math.max(7, (Date.parse(`${last}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000 + 1));
  const days = Array.from({ length: span }, (_, i) => addDays(today, i));
  const firstWithRide = days.find((d) => live.some((r) => dayOf(r) === d)) ?? today;
  const [picked, setPicked] = useState<string | null>(null);
  const day = picked && days.includes(picked) ? picked : firstWithRide;
  if (live.length === 0) return null;
  const onDay = live.filter((r) => dayOf(r) === day);
  const label = (d: string) => {
    const at = parseYmd(d)!;
    return {
      dow: fmtWeekdayTz(at),
      num: at.getDate(),
      long: fmtDayHeaderTz(at),
    };
  };
  return (
    <Card className="mb-4">
      <CardContent className="pt-5">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-silver">{t('ride.calendar')}</h2>
        <div className="-mx-1 mt-3 flex gap-1.5 overflow-x-auto px-1 pb-1 scrollbar-none" role="tablist" aria-label={t('ride.calendar')}>
          {days.map((d) => {
            const rides = live.filter((r) => dayOf(r) === d);
            const on = d === day;
            const l = label(d);
            return (
              <button
                key={d}
                type="button"
                role="tab"
                aria-selected={on}
                aria-label={`${l.long}${rides.length ? ` · ${rides.length}` : ''}`}
                onClick={() => setPicked(d)}
                className={cn(
                  'flex w-12 shrink-0 flex-col items-center rounded-lg border py-2 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright',
                  on ? 'border-gold ring-1 ring-gold/60' : 'border-navy-secondary hover:border-silver/40',
                )}
              >
                <span className={cn('text-2xs uppercase', on ? 'text-gold' : 'text-silver')}>{l.dow}</span>
                <span className={cn('text-base font-semibold tabular-nums', on ? 'text-white' : 'text-silver')}>{l.num}</span>
                <span className="mt-1 flex h-1.5 gap-0.5" aria-hidden="true">
                  {rides.slice(0, 3).map((r) => (
                    <span
                      key={r.id}
                      className={cn(
                        'h-1.5 w-1.5 rounded-full',
                        r.status === 'REQUESTED' ? (r.waitlist ? 'bg-warning' : 'bg-silver/60') : 'bg-success',
                      )}
                    />
                  ))}
                </span>
              </button>
            );
          })}
        </div>
        <div className="mt-3 text-xs font-medium text-silver">{label(day).long}</div>
        {onDay.length === 0 ? (
          <p className="py-3 text-sm text-silver/70">{t('ride.calendarNone')}</p>
        ) : (
          <ul className="divide-y divide-navy-secondary/60">
            {onDay.map((r) => (
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
        )}
      </CardContent>
    </Card>
  );
}

/** A ride's status — "On the waitlist · #2" when its shift's vans are full. */
function RideBadge({ ride, size }: { ride: Ride; size?: 'sm' }) {
  const { t } = useI18n();
  if (ride.status === 'REQUESTED' && ride.waitlist) {
    return (
      <Badge variant="pending" size={size}>
        {t('ride.waitlistBadge', { position: ride.waitlist.position })}
      </Badge>
    );
  }
  return (
    <Badge variant={statusVariant(ride.status)} size={size}>
      {t(`ride.status.${ride.status}` as MessageKey)}
    </Badge>
  );
}

/** Faces, overlapping — a photo, else a plain head. Never a name. */
export function FaceStack({ faces, size = 28, max = 6 }: { faces: Array<{ photoUrl: string | null }>; size?: number; max?: number }) {
  const extra = faces.length - max;
  return (
    <span className="flex -space-x-1.5" aria-hidden="true">
      {faces.slice(0, max).map((f, i) =>
        f.photoUrl ? (
          <img
            key={i}
            src={f.photoUrl}
            alt=""
            loading="lazy"
            className="rounded-full object-cover ring-2 ring-navy"
            style={{ width: size, height: size }}
          />
        ) : (
          <span
            key={i}
            className="grid place-items-center rounded-full bg-navy-secondary text-silver ring-2 ring-navy"
            style={{ width: size, height: size }}
          >
            <UserRound style={{ width: size * 0.55, height: size * 0.55 }} />
          </span>
        ),
      )}
      {extra > 0 && (
        <span
          className="grid place-items-center rounded-full bg-navy-secondary text-2xs font-semibold text-white ring-2 ring-navy"
          style={{ width: size, height: size }}
        >
          +{extra}
        </span>
      )}
    </span>
  );
}

/** Who they ride with — the van's other riders as faces, and its seats. */
function RidingWith({ ride }: { ride: Ride }) {
  const { t } = useI18n();
  const n = ride.coRiders?.length ?? 0;
  return (
    <div className="flex items-center gap-2.5 text-sm text-silver">
      <FaceStack faces={ride.coRiders ?? []} />
      <span className="min-w-0 truncate">
        {n === 1 ? t('ride.ridingWithOne') : t('ride.ridingWith', { count: n })}
        {ride.seats ? ` · ${t('ride.seatsFilled', { taken: ride.seats.taken, capacity: ride.seats.capacity })}` : ''}
      </span>
    </div>
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
                      date: fmtDayShort(payday, { anchored: true }),
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

function PastRides({
  data,
  onReport,
  onBookAgain,
}: {
  data: MyTransport;
  onReport: (rideId: string) => void;
  onBookAgain: (ride: Ride) => void;
}) {
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
                <div className="flex shrink-0 items-center gap-1">
                  {data.stores.some((st) => st.id === r.store.id) && (
                    <Button size="xs" variant="secondary" onClick={() => onBookAgain(r)}>
                      {t('ride.bookAgain')}
                    </Button>
                  )}
                  {(r.status === 'NO_SHOW' || r.status === 'COMPLETED') && (
                    <Button size="icon-sm" variant="ghost" aria-label={t('ride.report')} onClick={() => onReport(r.id)}>
                      <AlertTriangle className="h-4 w-4" />
                    </Button>
                  )}
                </div>
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
      toast.error(why(err));
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

/** What the booking form opens with — a shift, a past ride, or nothing. */
export interface BookPrefill {
  way?: Way;
  /** A store shift to open on. */
  windowLabel?: string;
  storeId?: string;
  date?: string;
  arrive?: string;
  leave?: string;
  shiftId?: string | null;
  pickup?: Pickup | null;
}

/**
 * Where they went last time, ready to book again in one tap.
 *
 * A remembered ADDRESS only counts if we kept its coordinates. Without
 * them it is just a string we once failed to place, and pre-filling it
 * would hand the rider back the very pickup the driver couldn't find —
 * so it falls through and they pick again, which now resolves it.
 *
 * Someone who has never ridden starts with nothing chosen. This used to
 * fall back to the company's first stop, alphabetically — a pickup they
 * never picked, shown ticked as if they had, and booked from if they did
 * not notice. Every stop is still one tap away in the picker.
 */
function initialPickup(data: MyTransport, initial: BookPrefill): Pickup | null {
  if (initial.pickup) return initial.pickup;
  const d = data.defaultPickup;
  if (d?.kind === 'stop') {
    const stop = data.stops.find((x) => x.id === d.stopId);
    if (stop) return { kind: 'stop', id: stop.id, name: stop.name };
  }
  if (d?.kind === 'place') {
    const place = data.places.find((x) => x.id === d.placeId);
    if (place) return { kind: 'place', id: place.id, label: place.label, address: place.address };
  }
  if (d?.kind === 'address' && d.lat !== null && d.lng !== null) {
    return { kind: 'address', address: d.address, lat: d.lat, lng: d.lng, precision: 'exact' };
  }
  // A place they saved is one they chose.
  const p = data.places[0];
  if (p) return { kind: 'place', id: p.id, label: p.label, address: p.address };
  return null;
}

export function prefillFromShift(data: MyTransport, shift: Shift): BookPrefill {
  const tz = data.stores.find((st) => st.id === shift.locationId)?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return {
    way: 'BOTH',
    storeId: shift.locationId ?? undefined,
    date: zonedDayKey(shift.startsAt, tz),
    arrive: hhmm(shift.startsAt, tz),
    leave: hhmm(shift.endsAt, tz),
    shiftId: shift.id,
  };
}

/** The same ride again — same store, pickup, way and time — on the next
 *  day it can still be booked. */
export function prefillFromRide(data: MyTransport, ride: Ride): BookPrefill {
  const tz = ride.store.timezone;
  const at = hhmm(ride.targetAt, tz);
  const earliest = Date.now() + data.settings.cutoffHours * H + 5 * 60_000;
  let day = zonedDayKey(new Date(Math.max(Date.now(), Date.parse(ride.targetAt))), tz);
  for (let i = 0; i < 8 && Date.parse(localInputToUtcIso(`${day}T${at}`, tz)) < earliest; i++) day = addDays(day, 1);
  const pickup: { pickup: Pickup | null } = {
    pickup: (() => {
      if (ride.pickup.kind === 'stop' && ride.pickup.id) {
        return { kind: 'stop', id: ride.pickup.id, name: ride.pickup.name ?? '' };
      }
      const saved = data.places.find((p) => p.address === ride.pickup.address);
      if (saved) return { kind: 'place', id: saved.id, label: saved.label, address: saved.address };
      // Repeating a ride keeps the point it actually used; an old ride
      // without one has to be picked again rather than repeated blind.
      if (ride.pickup.address && ride.point) {
        return {
          kind: 'address',
          address: ride.pickup.address,
          lat: ride.point.lat,
          lng: ride.point.lng,
          precision: 'exact',
        };
      }
      return null;
    })(),
  };
  return {
    way: ride.direction,
    storeId: ride.store.id,
    date: day,
    ...(ride.direction === 'TO_WORK' ? { arrive: at } : { leave: at }),
    ...pickup,
  };
}

export function BookRideDialog({
  data,
  initial = {},
  open,
  onOpenChange,
}: {
  data: MyTransport;
  initial?: BookPrefill;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const s = data.settings;
  // Most rides are there and back; most associates ride from the same
  // place to the same store — start there.
  const [way, setWay] = useState<Way>(initial.way ?? 'BOTH');
  const [storeId, setStoreId] = useState(
    initial.storeId ?? data.defaultStoreId ?? (data.stores.length === 1 ? data.stores[0]!.id : ''),
  );
  const store = data.stores.find((x) => x.id === storeId) ?? null;
  const tz = store?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const earliest = useMemo(() => new Date(Date.now() + s.cutoffHours * H + 5 * 60_000), [s.cutoffHours]);
  // Open on the first bookable day.
  //
  // Judged by the earliest moment the day can actually be booked: the
  // first shift window when the store plans by shift (the default when it
  // has windows), else the 07:00 the "other time" form starts on. Judging
  // every day by 07:00 while by-shift targets a 06:00 window opened the
  // dialog on a day whose first shift was already inside the cutoff — the
  // shift list rendered, "too soon" appeared, and the button sat disabled
  // with no way forward except noticing the date and changing it.
  const [date, setDate] = useState(() => {
    if (initial.date) return initial.date;
    const first = zonedDayKey(earliest, tz);
    const openMinute = (store?.windows ?? []).reduce(
      (min, w) => Math.min(min, w.startMinute),
      7 * 60,
    );
    const openAt = `${String(Math.floor(openMinute / 60)).padStart(2, '0')}:${String(
      openMinute % 60,
    ).padStart(2, '0')}`;
    return new Date(localInputToUtcIso(`${first}T${openAt}`, tz)) < earliest
      ? addDays(first, 1)
      : first;
  });
  const [arrive, setArrive] = useState(initial.arrive ?? '07:00');
  const [leave, setLeave] = useState(initial.leave ?? '15:30');
  const [shiftId, setShiftId] = useState<string | null>(initial.shiftId ?? null);
  // By shift (the store's shifts — how the vans are planned), or at an
  // other time. A prefill that lands on a store shift opens on it.
  const windows = store?.windows ?? [];
  const startWindow =
    initial.arrive && windows.length > 0
      ? (windows.find((w) => Math.abs(w.startMinute - minutesOf(initial.arrive!)) <= 30)?.label ?? null)
      : null;
  const [mode, setMode] = useState<'shift' | 'time'>(
    windows.length > 0 && (!initial.arrive || startWindow || initial.leave === undefined) ? 'shift' : 'time',
  );
  const [windowLabel, setWindowLabel] = useState<string | null>(initial.windowLabel ?? startWindow);
  const byShift = mode === 'shift' && windows.length > 0;
  const picked = byShift ? (windows.find((w) => w.label === windowLabel) ?? null) : null;
  const trips = useQuery({
    queryKey: ['transport', 'trips', storeId, date],
    queryFn: () => getShiftTrips(storeId, date),
    enabled: byShift && !!storeId && !!date,
    staleTime: 20_000,
  });
  const [pickup, setPickup] = useState<Pickup | null>(() => initialPickup(data, initial));
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
    // The store's shift it is, when there is one — else its own hours.
    const match = windowForShift(st, sh.startsAt);
    if (match) {
      setMode('shift');
      setWindowLabel(match.window.label);
      setDate(match.date);
    } else {
      setMode('time');
      setDate(zonedDayKey(sh.startsAt, z));
    }
    setArrive(hhmm(sh.startsAt, z));
    setLeave(hhmm(sh.endsAt, z));
  };

  // The instants, in the store's zone. A leave time at or before the arrive
  // time on a round trip is the next morning (an overnight shift).
  const leaveDate = way === 'BOTH' && leave <= arrive ? addDays(date, 1) : date;
  const toWorkAt = byShift
    ? picked && date
      ? shiftTargetIso(picked, date, 'TO_WORK', tz)
      : null
    : date && arrive
      ? localInputToUtcIso(`${date}T${arrive}`, tz)
      : null;
  const fromWorkAt = byShift
    ? picked && date
      ? shiftTargetIso(picked, date, 'FROM_WORK', tz)
      : null
    : date && leave
      ? localInputToUtcIso(`${leaveDate}T${leave}`, tz)
      : null;
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
  // Where each leg of the picked shift stands: seats left, or its line.
  const tripOf = (w: string, d: RideDirection) => trips.data?.trips.find((x) => x.windowLabel === w && x.direction === d);
  const fullLegs = picked ? legs.filter((l) => tripOf(picked.label, l.direction)?.full) : [];
  const pickupLabel = way === 'TO_WORK' ? t('ride.pickupTo') : way === 'FROM_WORK' ? t('ride.pickupFrom') : t('ride.pickupBoth');

  const submit = async () => {
    if (!store) return setError(t('ride.pickStore'));
    if (!pickup) return setError(t('ride.pickRequired'));
    if (byShift && !picked) return setError(t('ride.pickShift'));
    // A cleared date or time field leaves a leg with no instant. This used
    // to `return` bare: the button did nothing, said nothing, and stayed
    // enabled — tap it again and it does nothing again. That is the shape
    // of "I pressed save and it just sat there". tooSoon keeps its silent
    // return because it already has its own banner above the button.
    if (legs.some((l) => !l.at)) return setError(t('ride.pickWhen'));
    if (tooSoon) return;
    setBusy(true);
    setError(null);
    try {
      let home: Pick<BookRideInput, 'stopId' | 'placeId' | 'address' | 'lat' | 'lng'>;
      if (pickup.kind === 'stop') home = { stopId: pickup.id };
      else if (pickup.kind === 'place') home = { placeId: pickup.id };
      else if (saveAs.trim()) {
        // Saving it carries the coordinates across, so next time it is one
        // tap and never needs a lookup again.
        const { place } = await addRidePlace({
          label: saveAs.trim(),
          address: pickup.address,
          lat: pickup.lat,
          lng: pickup.lng,
        });
        home = { placeId: place.id };
      } else {
        home = { address: pickup.address, lat: pickup.lat, lng: pickup.lng };
      }
      let booked = 0;
      let inLine: { position: number; direction: RideDirection } | null = null;
      for (const leg of legs) {
        try {
          const { ride } = await bookRide({
            direction: leg.direction,
            locationId: store.id,
            ...home,
            ...(picked ? { windowLabel: picked.label, date } : { targetAt: leg.at! }),
            ...(note.trim() ? { note: note.trim() } : {}),
            ...(shiftId ? { shiftId } : {}),
          });
          if (ride.waitlist) inLine = { position: ride.waitlist.position, direction: leg.direction };
          booked += 1;
        } catch (err) {
          const msg = why(err);
          if (booked === 0) throw err;
          toast.warning(t('ride.bookedHalf', { error: msg }));
          await queryClient.invalidateQueries({ queryKey: ['transport', 'me'] });
          onOpenChange(false);
          return;
        }
      }
      hapticConfirm();
      if (inLine && picked) {
        toast.success(t('ride.bookedWaitlist', { position: inLine.position, shift: picked.label }));
      } else {
        toast.success(legs.length === 2 ? t('ride.bookedBoth') : t('ride.booked'));
      }
      await queryClient.invalidateQueries({ queryKey: ['transport', 'me'] });
      await queryClient.invalidateQueries({ queryKey: ['transport', 'trips'] });
      onOpenChange(false);
    } catch (err) {
      setError(why(err));
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
                <Select
                  {...p}
                  value={storeId}
                  onChange={(e) => {
                    const next = data.stores.find((x) => x.id === e.target.value);
                    setStoreId(e.target.value);
                    setShiftId(null);
                    setWindowLabel(null);
                    setMode(next?.windows?.length ? 'shift' : 'time');
                  }}
                >
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
          </div>

          {/* Without this, a failed trip lookup just showed every shift as
              having no seats taken — a rider would book into a van that
              was already full. */}
          {trips.isError && <QueryError what="seats left on these shifts" query={trips} />}
          {windows.length > 0 && (
            <ShiftPicker
              windows={windows}
              way={way}
              mode={mode}
              picked={windowLabel}
              tripOf={tripOf}
              onPick={(label) => {
                setMode('shift');
                setWindowLabel(label);
                setShiftId(null);
              }}
              onOther={() => {
                setMode('time');
                setWindowLabel(null);
              }}
            />
          )}
          {picked && fullLegs.length > 0 && (
            <p className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-warning">
              {t('ride.waitlistNote', {
                shift: picked.label,
                position: (tripOf(picked.label, fullLegs[0]!.direction)?.waiting ?? 0) + 1,
              })}
            </p>
          )}

          {!byShift && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
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
          )}

          <PickupPicker
            value={pickup}
            onChange={setPickup}
            stops={data.stops}
            places={data.places}
            locationId={store?.id ?? null}
            label={pickupLabel}
            invalid={!!error && !pickup}
          />
          {/* Offered only for an address they searched for: a stop or an
              already-saved place has nothing to save. */}
          {pickup?.kind === 'address' && (
            <Field label={t('ride.saveAs')}>
              {(p) => (
                <Input
                  {...p}
                  value={saveAs}
                  onChange={(e) => setSaveAs(e.target.value)}
                  placeholder={t('ride.saveAsPlaceholder')}
                  maxLength={40}
                />
              )}
            </Field>
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
        {/* One bar, price then button, on every size. DialogFooter stacks
            column-REVERSE on phones, which put the gold button above the
            price it charges and left it floating mid-sheet rather than in
            the bottom corner a thumb rests on. Sticky, because the form is
            taller than a phone: the button sat a whole screen below where
            the sheet opens, and associates could not find it. */}
        <DialogFooter sticky className="flex-row items-center justify-between gap-3 sm:justify-between">
          <span className="min-w-0 text-sm text-silver tabular-nums">{t('ride.total', { amount: cents(total) })}</span>
          <Button
            className="shrink-0"
            onClick={() => void submit()}
            loading={busy}
            disabled={busy || tooSoon || !store || (byShift && !picked)}
          >
            {fullLegs.length === legs.length && fullLegs.length > 0
              ? t('ride.joinWaitlist')
              : legs.length === 2
                ? t('ride.bookBoth')
                : t('ride.bookOne')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** "07:30" → 450. */
function minutesOf(hhmmText: string): number {
  const [h, m] = hhmmText.split(':').map(Number) as [number, number];
  return h * 60 + m;
}

/**
 * The store's shifts as cards — pick the one you work. Each says where its
 * seats stand, each way you're booking: seats left, open (no van on it yet
 * — a driver takes it), or full with the line you'd join. "Other time"
 * is for the exceptions: leaving early, a late start.
 */
function ShiftPicker({
  windows,
  way,
  mode,
  picked,
  tripOf,
  onPick,
  onOther,
}: {
  windows: StoreShiftWindow[];
  way: Way;
  mode: 'shift' | 'time';
  picked: string | null;
  tripOf: (w: string, d: RideDirection) => ShiftTrip | undefined;
  onPick: (label: string) => void;
  onOther: () => void;
}) {
  const { t } = useI18n();
  const dirs: RideDirection[] = way === 'BOTH' ? ['TO_WORK', 'FROM_WORK'] : [way];
  // Only what differs between shifts earns a line. "Open — a driver will
  // take it" is true of nearly every shift, and repeated per leg it turned
  // five shifts into a screen and a half of the same sentence, pushing the
  // pickup and the button out of reach. Seats left, a full van or a
  // too-late shift are what someone picking between them needs to see.
  const line = (w: string, d: RideDirection) => {
    const trip = tripOf(w, d);
    if (!trip) return null;
    const lead = way === 'BOTH' ? `${d === 'TO_WORK' ? t('ride.legThere') : t('ride.legHome')} · ` : '';
    if (!trip.bookable) return { text: lead + t('ride.seatTooSoon'), tone: 'text-silver/60' };
    if (trip.full) return { text: lead + t('ride.seatFull', { position: trip.waiting + 1 }), tone: 'text-warning' };
    if (trip.seats) {
      const left = trip.seats.capacity - trip.seats.taken;
      return { text: lead + (left === 1 ? t('ride.seatLeftOne') : t('ride.seatsLeft', { count: left })), tone: 'text-success' };
    }
    return null;
  };
  return (
    <div>
      <div className="mb-1.5 text-xs font-medium uppercase tracking-wider text-silver">{t('ride.whichShift')}</div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup" aria-label={t('ride.whichShift')}>
        {windows.map((w) => {
          const on = mode === 'shift' && picked === w.label;
          return (
            <button
              key={w.label}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onPick(w.label)}
              className={cn(
                'rounded-lg border px-3 py-2.5 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright coarse:min-h-11',
                on ? 'border-gold ring-1 ring-gold/60' : 'border-navy-secondary hover:border-silver/40',
              )}
            >
              <span className="flex items-baseline justify-between gap-2">
                <span className={cn('text-sm font-semibold', on ? 'text-gold' : 'text-white')}>{w.label}</span>
                <span className="text-xs tabular-nums text-silver">{fmtWindow(w)}</span>
              </span>
              {dirs.map((d) => {
                const l = line(w.label, d);
                return l ? (
                  <span key={d} className={cn('mt-0.5 block text-xs tabular-nums', l.tone)}>
                    {l.text}
                  </span>
                ) : null;
              })}
            </button>
          );
        })}
        <button
          type="button"
          role="radio"
          aria-checked={mode === 'time'}
          onClick={onOther}
          className={cn(
            'rounded-lg border border-dashed px-3 py-2.5 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright coarse:min-h-11',
            mode === 'time' ? 'border-gold ring-1 ring-gold/60' : 'border-navy-secondary hover:border-silver/40',
          )}
        >
          <span className={cn('block text-sm font-semibold', mode === 'time' ? 'text-gold' : 'text-white')}>{t('ride.otherTime')}</span>
          <span className="mt-0.5 block text-xs text-silver">{t('ride.otherTimeBody')}</span>
        </button>
      </div>
    </div>
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
    onError: (err) => toast.error(why(err)),
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
