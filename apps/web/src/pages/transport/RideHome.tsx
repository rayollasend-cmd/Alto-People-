import { useEffect, useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { onLiveEvent } from '@/lib/liveEvents';
import { useAuth } from '@/lib/auth';
import { useReadable } from '@/lib/useReadable';
import { useUrlParam } from '@/lib/useUrlState';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Bus, Check, Home, MapPin, Plus, Repeat, ThumbsDown, ThumbsUp, Trash2, UserRound, Wallet } from '@/components/ui/icons';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { cn } from '@/lib/cn';
import { useConfirm } from '@/lib/confirm';
import { hapticConfirm } from '@/lib/haptics';
import { fmtDayHeaderTz, fmtDayShort, fmtMoney, fmtRelativeDayTz, fmtTimeTz, fmtWeekdayTz, localInputToUtcIso, parseYmd, utcToZonedDatetimeInput, zonedDayKey } from '@/lib/format';
import {
  addRidePlace,
  bookRide,
  cancelMyRide,
  cancelSeries,
  createSeries,
  getPendingFeedback,
  listMySeries,
  sendRideFeedback,
  deleteRidePlace,
  getMyTransport,
  getMyLiveRide,
  getShiftTrips,
  signRideAuthorization,
  withdrawRideAuthorization,
  reportTransportIssue,
  type BookRideInput,
  type FeedbackReason,
  type SeriesInput,
  type MyLiveRide,
  type MyTransport,
  type Ride,
  type RideDirection,
  type RideNotice,
  type RideStatus,
  type ShiftTrip,
  type StoreShiftWindow,
  type TransportIssueCategory,
} from '@/lib/transportApi';
import { SoundToggle } from '@/components/transport/SoundToggle';
import { LiveTrip } from './rider/LiveTrip';
import { OwedCard } from './rider/OwedCard';
import { ChargesLedger } from './rider/ChargesLedger';
import { RideViewBar } from './rider/RideViewBar';
import { fareWords } from './rider/charges';
import { hasVan, liveTripOwnsGold, tripInProgress } from './rider/tripState';
import { useTick } from './rider/useTick';
import { useRiderAlerts } from './useRiderAlerts';
import { bookShifts, coverageFor, type Shift } from './rideShifts';
import { fmtWindow, shiftTargetIso, windowForShift } from './shiftTrips';
import { downloadDocumentUrl } from '@/lib/documentsApi';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { NoAccess } from '@/components/ui/NoAccess';
import { Field } from '@/components/ui/Field';
import { Input, Textarea } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { TripMap, tripStage } from './TripMap';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { Skeleton } from '@/components/ui/Skeleton';
import { QueryError } from '@/components/ui/QueryError';
import { PickupPicker, type Pickup } from './PickupPicker';
import { ListTemplate } from '@/components/templates';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import '@/lib/i18n/en/ride';
import '@/lib/i18n/en/shift';

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

/** The signed rider's page below the hero, one view at a time (F500 G2:
 *  ten stacked sections made a phone page six screens long). */
const RIDE_VIEWS = ['upcoming', 'history', 'charges', 'places'] as const;
type RideView = (typeof RIDE_VIEWS)[number];

export function RideHome() {
  const { t } = useI18n();
  const { can } = useAuth();
  // "My rides" reads the rider's own record: an account with no person behind
  // it (an admin who runs the vans) never asks — it was a 403 on every visit (CRAWL-15).
  const rides = useReadable('ride:transport', { self: true });
  const me = useQuery({ queryKey: ['transport', 'me'], queryFn: getMyTransport, refetchInterval: 60_000, enabled: rides });
  const [view, setView] = useUrlParam<RideView>('view', 'upcoming', RIDE_VIEWS, { history: 'push' });
  // The booking form, open — blank, or prefilled from a shift / a past ride.
  const [booking, setBooking] = useState<BookPrefill | null>(null);
  const [reporting, setReporting] = useState<{ rideId?: string; category?: TransportIssueCategory } | null>(null);
  const data = me.data;
  // Brief 1A-3: booking needs a current signed authorization (`consent` is
  // the older shape of the same fact).
  const authorized = data ? isAuthorized(data) : false;
  const canBook = authorized && (data?.stores.length ?? 0) > 0;
  const live = useMyLiveRide(rides);
  useRiderAlerts(data, live);
  // With a ride coming the trip leads — the explainer steps aside.
  const next = authorized ? sortedLive(data!.rides, Date.now())[0] : undefined;
  const riding = !!next;
  // ONE gold button on the screen (the transport upgrade): "I'm outside"
  // while the van is coming; else one-tap booking for their shifts; else
  // the empty state's "Request a seat"; else the header's.
  const liveGold = !!next && liveTripOwnsGold(next, live);
  const shiftsGold = !liveGold && view === 'upcoming' && !!data && authorized && coverageFor(data).slice(0, 6).some((c) => c.canBook.length > 0);
  const emptyGold = !liveGold && !shiftsGold && authorized && !next;
  const headerGold = !liveGold && !shiftsGold && !emptyGold;
  // The transportation director (or anyone who runs the vans) who isn't
  // placed at a store rides nothing: the rider pitch is not their page, the
  // board's Rides tab is (F500 G2).
  const runsTheVans = can('view:transport');
  if (runsTheVans && (!rides || (data && data.stores.length === 0 && data.rides.length === 0) || me.isError)) {
    return <Navigate to="/transport?tab=rides" replace />;
  }
  if (!rides) return <NoAccess />;

  return (
    // Design system §4.2 (UX upgrade step 6, the sweep): the List template.
    <ListTemplate
        // A rider reads at 16px on a phone (helper lines at 14px).
        className="mx-auto max-w-3xl max-sm:[&_.text-sm]:text-base max-sm:[&_.text-xs]:text-sm max-sm:[&_.text-xs2]:text-sm"
        title={t('ride.title')}
        subtitle={riding ? undefined : t('ride.subtitle')}
        headerClassName={riding ? 'mb-3 md:mb-5' : undefined}
        secondaryActions={
          <SoundToggle onLabel={t('ride.soundsOn')} offLabel={t('ride.soundsOff')} text={{ on: t('ride.soundsOnShort'), off: t('ride.soundsOffShort') }} />
        }
        primaryAction={
          // With no ride the empty state carries "Request a seat" — not twice on
          // one screen; while the van is coming the screen is the trip's (map first).
          canBook && next && !tripInProgress(next, live) ? (
            <Button variant={headerGold ? 'primary' : 'secondary'} onClick={() => setBooking({})}>
              <Plus className="h-4 w-4" />
              {t('ride.book')}
            </Button>
          ) : undefined
        }
    >
      {me.isLoading || !data ? (
        me.isError ? (
          <QueryError what={t('ride.load.rides')} query={me} />
        ) : (
          <Card>
            <CardContent className="space-y-3">
              <Skeleton className="h-3 w-28" />
              <Skeleton className="h-9 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
            </CardContent>
          </Card>
        )
      ) : !authorized ? (
        <AuthorizationCard data={data} />
      ) : (
        <>
          <RideFeedbackCard place="top" />
          <NextRideHero data={data} gold={emptyGold} onBook={() => setBooking({})} onReport={(rideId) => setReporting({ rideId })} />
          <RideFeedbackCard place="below" />
          {view !== 'charges' && <OwedCard data={data} onLedger={() => setView('charges')} />}
          <RideViewBar
            ariaLabel={t('ride.view.label')}
            value={view}
            onChange={setView}
            className="mb-4"
            options={RIDE_VIEWS.map((v) => ({ value: v, label: t(`ride.view.${v}` as MessageKey) }))}
          />
          {view === 'upcoming' && (
            <div data-testid="ride-view-upcoming">
              <ShiftRides data={data} gold={shiftsGold} onCustom={(shift) => setBooking(prefillFromShift(data, shift))} />
              <RideCalendar data={data} heroId={next?.id ?? null} />
              <StandingBookings />
            </div>
          )}
          {view === 'history' && (
            <div data-testid="ride-view-history">
              {!data.rides.some((r) => !LIVE.includes(r.status)) && (
                <EmptyState size="sm" icon={Bus} title={t('ride.view.historyNone')} className="mb-4" />
              )}
              <PastRides
                data={data}
                onReport={(rideId) => setReporting({ rideId })}
                onBookAgain={(ride) => setBooking(prefillFromRide(data, ride))}
              />
            </div>
          )}
          {view === 'charges' && (
            <div data-testid="ride-view-charges">
              <OwedCard data={data} />
              <ChargesLedger data={data} onQuestion={(rideId) => setReporting({ rideId, category: 'CHARGE_DISPUTE' })} />
              <AuthorizationStatusCard data={data} />
            </div>
          )}
          {view === 'places' && (
            <div data-testid="ride-view-places">
              {data.places.length === 0 && (
                <EmptyState size="sm" icon={MapPin} title={t('ride.view.placesNone')} description={t('ride.view.placesNoneHint')} className="mb-4" />
              )}
              <SavedPlaces data={data} />
            </div>
          )}
          {/* Left, not centred: on a phone Hugo's button floats bottom-right and sat on this link. */}
          <div className="mb-8 mt-2 border-t border-line-subtle pt-3">
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
          initialCategory={reporting.category}
          open={!!reporting}
          onOpenChange={(o) => !o && setReporting(null)}
        />
      )}
    </ListTemplate>
  );
}

/* ----- The deal, signed ---------------------------------------------------- */

/** Brief 1A-3: a current signed authorization — the only state that books or charges. */
function isAuthorized(data: MyTransport): boolean {
  return data.authorization ? data.authorization.current : !!data.consent;
}

function AuthorizationCard({ data }: { data: MyTransport }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [typedName, setTypedName] = useState('');
  const auth = data.authorization ?? null;
  const agreement = auth?.agreement ?? null;
  const sign = useMutation({
    mutationFn: () => signRideAuthorization(typedName.trim(), agreement?.version),
    onSuccess: async () => {
      hapticConfirm();
      toast.success(t('ride.authorizationDone'));
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
  // Signed before, but the words or the rate changed, or they withdrew.
  const signedBefore = !!auth?.signedAt;
  const canSign = typedName.trim().length >= 2 && !!agreement;
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
        ) : !agreement ? (
          <p className="mt-5 text-sm text-warning">{t('ride.authorizationNoRate')}</p>
        ) : (
          <form
            className="mt-5 space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (canSign && !sign.isPending) sign.mutate();
            }}
          >
            {signedBefore && (
              <p className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 p-3 text-sm text-warning">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <span>
                  {t('ride.authorizationAgain')}
                  {auth?.reason ? ` — ${auth.reason}` : ''}
                </span>
              </p>
            )}
            <div className="rounded-md border border-navy-secondary bg-navy-secondary/40">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-navy-secondary px-4 py-2.5">
                <h3 className="text-sm font-semibold text-white">{agreement.title}</h3>
                <span className="text-xs text-silver tabular-nums">
                  {t('ride.authorizationRate', { fare: cents(agreement.fareCents), fee: cents(agreement.noShowFeeCents) })}
                </span>
              </div>
              <div
                className="max-h-64 space-y-2 overflow-y-auto px-4 py-3 text-sm leading-relaxed text-silver focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
                data-testid="ride-authorization-text"
                // A scrolling region the keyboard can reach and scroll.
                tabIndex={0}
                role="region"
                aria-label={agreement.title}
              >
                {agreement.body.split(/\n\s*\n/).map((para, i) => (
                  <p key={i} className="whitespace-pre-line">
                    {para}
                  </p>
                ))}
              </div>
            </div>
            <p className="text-xs text-silver/80">{t('ride.authorizationRead')}</p>
            <Field label={t('ride.authorizationName')}>
              {(p) => (
                <Input
                  {...p}
                  value={typedName}
                  onChange={(e) => setTypedName(e.target.value)}
                  autoComplete="name"
                  maxLength={200}
                  className="font-serif text-lg italic"
                />
              )}
            </Field>
            <Button type="submit" loading={sign.isPending} disabled={!canSign || sign.isPending}>
              {t('ride.authorizationSign')}
            </Button>
          </form>
        )}
      </div>
    </section>
  );
}

/** Once signed: when, as whom, at what rate — the PDF, and the way out. */
function AuthorizationStatusCard({ data }: { data: MyTransport }) {
  const { t } = useI18n();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const auth = data.authorization;
  const withdraw = useMutation({
    mutationFn: withdrawRideAuthorization,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['transport', 'me'] });
    },
    onError: (err) => toast.error(why(err)),
  });
  if (!auth?.signedAt) return null;
  return (
    <Card className="mb-4">
      <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium uppercase tracking-wider text-silver">{t('ride.authorizationTitle')}</div>
          <div className="mt-0.5 text-sm text-white">
            {t('ride.authorizationSigned', { date: fmtDayShort(new Date(auth.signedAt), { anchored: true }), name: auth.signedName ?? '' })}
          </div>
          <div className="text-xs text-silver tabular-nums">
            {t('ride.authorizationTerms', { version: auth.version ?? 1, fare: cents(auth.fareCents ?? 0), fee: cents(auth.noShowFeeCents ?? 0) })}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {auth.documentId && (
            <Button variant="secondary" size="sm" asChild>
              <a href={downloadDocumentUrl(auth.documentId)} target="_blank" rel="noreferrer">
                {t('ride.authorizationPdf')}
              </a>
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            loading={withdraw.isPending}
            disabled={withdraw.isPending}
            onClick={async () => {
              const ok = await confirm({
                title: t('ride.authorizationWithdrawTitle'),
                description: t('ride.authorizationWithdrawBody'),
                confirmLabel: t('ride.authorizationWithdraw'),
                destructive: true,
              });
              if (ok) withdraw.mutate();
            }}
          >
            {t('ride.authorizationWithdraw')}
          </Button>
        </div>
      </CardContent>
    </Card>
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
  gold,
  onBook,
  onReport,
}: {
  data: MyTransport;
  /** The empty state's "Request a seat" is the screen's one gold button. */
  gold: boolean;
  onBook: () => void;
  onReport: (rideId: string) => void;
}) {
  const { t } = useI18n();
  const cancel = useCancelRide();
  const now = useTick(15_000);
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
            <Button variant={gold ? 'primary' : 'secondary'} onClick={onBook}>
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

  const cancellable = OPEN.includes(next.status) && next.run?.status !== 'ACTIVE';
  // A van is on it: the map-first trip (rider/LiveTrip).
  if (hasVan(next, liveHere)) {
    return (
      <LiveTrip
        data={data}
        ride={next}
        live={liveHere}
        cancellable={cancellable}
        onCancel={() => void cancel(next)}
        onReport={() => onReport(next.id)}
      />
    );
  }

  // Still finding a driver (or waiting in line for a seat): the trip on the
  // map, the one line that says so, and where the ride is in its steps.
  const tz = next.store.timezone;
  const stage = tripStage(next, liveHere);
  const step = rideStep(next, liveHere);
  const headlineAt = next.pickupAt ?? next.targetAt;
  const shift = next.windowLabel ?? null;
  const waitlist = next.status === 'REQUESTED' ? (next.waitlist ?? null) : null;
  const targetLine =
    next.direction === 'TO_WORK'
      ? t('ride.arriveBy', { time: fmtTimeTz(next.targetAt, tz) })
      : t('ride.leaveAt', { time: fmtTimeTz(next.targetAt, tz) });
  const tripLine = [
    next.direction === 'TO_WORK' ? t('ride.toWork') : t('ride.fromWork'),
    next.store.name,
    ...(shift ? [t('ride.shiftTag', { shift })] : []),
    targetLine,
  ].join(' · ');
  const headline = waitlist ? t('ride.waitlistTitle', { position: waitlist.position }) : t('ride.findingDriver');

  return (
    <section
      aria-label={t('ride.nextRide')}
      className="relative -mx-4 mb-4 overflow-hidden border-b border-line bg-surface animate-enter sm:mx-0 sm:rounded-lg sm:border"
    >
      {liveHere && (
        <TripMap
          stage={stage}
          live={liveHere}
          vanLabel=""
          className="h-[34vh] min-h-[14rem] max-h-[22rem]"
          tapToExpand
          overlay={
            <div className="rounded-lg border border-line bg-surface-overlay/95 p-4 elev-3 backdrop-blur">
              <p className="text-2xl font-bold leading-tight tracking-tight text-ink">{headline}</p>
              <p className="mt-1 text-sm text-ink-muted">{tripLine}</p>
            </div>
          }
        />
      )}
      <div className={cn('relative bg-surface p-5', liveHere && '-mt-4 rounded-t-lg border-t border-line elev-2')}>
        {liveHere && <div className="mx-auto -mt-2 mb-3 h-1 w-10 rounded-full bg-line-strong/60" aria-hidden="true" />}
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-[0.18em] text-accent">
            <Bus className="h-3.5 w-3.5" aria-hidden="true" />
            {t('ride.nextRide')}
          </span>
          <RideBadge ride={next} />
        </div>
        <p aria-live="polite" className="mt-2 flex items-baseline gap-1 text-[1.75rem] font-bold leading-[1.15] tracking-tight text-ink sm:text-4xl">
          {headline}
          {!waitlist && <FindingDots />}
        </p>
        <p className="mt-1.5 text-base text-ink-muted">
          {fmtRelativeDayTz(headlineAt, tz, now)} · {tripLine}
        </p>
        {waitlist ? (
          <p className="mt-1 text-sm text-caution-800">{t('ride.waitlistBody', { shift: shift ?? '', position: waitlist.position, of: waitlist.of })}</p>
        ) : (
          <p className="mt-1 text-sm text-ink-muted">{next.seats ? t('ride.seatsWaiting') : t('ride.waitingVanBody')}</p>
        )}

        <RideStepper step={step} tone="gold" />

        <div className="mt-4 space-y-2.5 border-t border-line-subtle pt-3">
          {next.coRiders && next.coRiders.length > 0 && <RidingWith ride={next} />}
          <div className="flex items-center gap-2 text-sm text-ink-muted">
            <MapPin className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{pickupPlace(next)}</span>
          </div>
          {next.direction === 'FROM_WORK' && (
            <div className="flex items-center gap-2 text-sm text-ink-muted">
              <Home className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{homeEnd(next)}</span>
            </div>
          )}
          <div className="flex items-start gap-2 text-sm text-ink-muted">
            <Wallet className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1 tabular-nums">{fareWords(t, next.fareCents, data.charges.nextPayday, next.serviceDate, data.charges.payroll)}</span>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-2">
          {cancellable && (
            <Button size="sm" variant="secondary" onClick={() => void cancel(next)}>
              {t('ride.cancel')}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => onReport(next.id)}>
            {t('ride.report')}
          </Button>
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
          className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent motion-reduce:animate-none"
          style={{ animationDelay: `${i * 200}ms` }}
        />
      ))}
    </span>
  );
}

/* ----- Rides for your shifts — one tap ------------------------------------- */

export function ShiftRides({ data, gold = true, onCustom }: { data: MyTransport; gold?: boolean; onCustom: (shift: Shift) => void }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const covers = coverageFor(data).slice(0, 6);
  if (covers.length === 0) return null;
  const fare = data.settings.fareCents;
  const pickup = data.defaultPickup;
  const open = covers.filter((c) => c.canBook.length > 0);
  const openLegs = open.reduce((n, c) => n + c.canBook.length, 0);
  // One gold button: "Book all" when there is more than one to book, else
  // the one row's — and none while the live trip holds the gold.
  const bookAll = !!pickup && open.length > 1;
  const goldRow = gold && !bookAll ? open[0] : undefined;

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
      <CardContent>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-silver">{t('ride.forShifts')}</h2>
            <p className="mt-0.5 text-xs text-silver/80">
              {pickup ? t('ride.forShiftsFrom', { pickup: pickup.label }) : t('ride.forShiftsNoPickup')}
            </p>
          </div>
          {bookAll && (
            <Button size="sm" variant={gold ? 'primary' : 'secondary'} className="shrink-0" onClick={() => void book('all', open)} loading={busy === 'all'} disabled={!!busy}>
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
              <li key={c.shift.id} className="flex min-h-16 items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  {/* The day on its own line, the time range whole on the next: at 390px
                      "Tomorrow · 6:00 AM–2:00 PM" broke in the middle of a time. */}
                  <div className="text-xs font-medium text-ink-muted" data-testid="shift-day">
                    {fmtRelativeDayTz(c.shift.startsAt, tz)}
                  </div>
                  <div className="whitespace-nowrap text-base font-semibold text-ink tabular-nums" data-testid="shift-time">
                    {fmtTimeTz(c.shift.startsAt, tz)}–{fmtTimeTz(c.shift.endsAt, tz)}
                  </div>
                  <div className="truncate text-xs text-silver">
                    {store?.name}
                    {c.shortNotice && ` · ${t('ride.shortNoticeChip')}`}
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
                    variant={c === goldRow ? 'primary' : 'secondary'}
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
function useMyLiveRide(enabled = true): MyLiveRide | null {
  const queryClient = useQueryClient();
  const q = useQuery({
    queryKey: ['transport', 'me', 'live'],
    queryFn: getMyLiveRide,
    enabled,
    // 15 s while the van is out, and in the half hour before it leaves (so
    // "Mike is on the way" lands without a pull); a minute otherwise.
    refetchInterval: (query) => {
      const l = query.state.data?.live;
      if (l?.runStatus === 'ACTIVE') return 15_000;
      if (l?.runStatus === 'PLANNED' && l.departAt && Date.parse(l.departAt) - Date.now() < 30 * 60_000) return 15_000;
      return 60_000;
    },
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
          {ride.heldForSignature ? (
            <span className="text-xs text-warning">{t('ride.heldForSignature')}</span>
          ) : ride.waiveKind === 'NOT_AUTHORIZED' ? (
            <span className="text-xs text-warning">{t('ride.notCharged')}</span>
          ) : (
            ride.waived && <span className="text-xs text-success">{t('ride.waived')}</span>
          )}
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
function RideCalendar({ data, heroId }: { data: MyTransport; heroId: string | null }) {
  const { t } = useI18n();
  const cancel = useCancelRide();
  const now = Date.now();
  // The next ride is the hero above — listing it here again was the page's
  // duplicate (audit 2026-10-28). The strip is for the rides after it.
  const live = sortedLive(data.rides, now).filter((r) => r.id !== heroId);
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
      <CardContent>
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
                    <Button size="icon" variant="ghost" aria-label={t('ride.cancel')} onClick={() => void cancel(r)}>
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

/* ----- After the ride: a thumb, and why ----------------------------------- */

/**
 * "How was the ride?" — one card for the latest finished ride not yet
 * rated. A thumb up sends at once; a thumb down asks why. Never a public
 * score: transportation reads the trend by driver and route.
 */
export function RideFeedbackCard({ place }: { place?: 'top' | 'below' } = {}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ['transport', 'me', 'feedback'], queryFn: getPendingFeedback, staleTime: 60_000 });
  const [down, setDown] = useState(false);
  const [reason, setReason] = useState<FeedbackReason | null>(null);
  const [note, setNote] = useState('');
  const send = useMutation({
    mutationFn: (v: { rideId: string; thumbsUp: boolean }) =>
      sendRideFeedback(v.rideId, { thumbsUp: v.thumbsUp, reason: v.thumbsUp ? 'GREAT' : reason, note: note.trim() || null }),
    onSuccess: async () => {
      hapticConfirm();
      toast.success(t('ride.fbThanks'));
      setDown(false);
      setReason(null);
      setNote('');
      await queryClient.invalidateQueries({ queryKey: ['transport', 'me', 'feedback'] });
    },
    onError: (err) => toast.error(why(err)),
  });
  const ride = q.data?.rides?.[0];
  if (!ride) return null;
  // Just finished: the trip's last state — "You made it", then the rating —
  // at the top of the page. Older: a quiet card below the next ride.
  const done = !!ride.completedAt && Date.now() - Date.parse(ride.completedAt) < 3 * H;
  if ((place === 'top' && !done) || (place === 'below' && done)) return null;
  const reasons = (q.data?.reasons ?? []).filter((r) => r !== 'GREAT');
  const when = ride.completedAt ? `${fmtRelativeDayTz(ride.completedAt, ride.timezone)} ${fmtTimeTz(ride.completedAt, ride.timezone)}` : ride.store;
  return (
    <Card className={cn('mb-4', done && 'border-positive-200')} data-testid="ride-feedback" data-done={done || undefined}>
      <CardContent>
        {done && (
          <div className="mb-3">
            <div className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-[0.18em] text-positive-800">
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
              {t('ride.done.eyebrow')}
            </div>
            <p className="mt-1 text-[1.75rem] font-bold leading-[1.15] tracking-tight text-ink">
              {ride.direction === 'FROM_WORK' ? t('ride.done.home') : t('ride.done.title', { place: ride.store })}
            </p>
          </div>
        )}
        <SectionTitle className="mb-0" title={t('ride.fbTitle')} description={t('ride.fbBody', { van: ride.van ?? '', driver: ride.driver ?? '', when })} />
        <div className="mt-3 flex flex-wrap gap-2 coarse:gap-3">
          <Button size="sm" variant="secondary" onClick={() => send.mutate({ rideId: ride.rideId, thumbsUp: true })} disabled={send.isPending}>
            <ThumbsUp className="h-4 w-4" />
            {t('ride.fbUp')}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            className={cn(down && 'border-accent-300 bg-accent-100 text-accent-800 hover:bg-accent-100')}
            onClick={() => setDown(true)}
            disabled={send.isPending}
            aria-pressed={down}
          >
            <ThumbsDown className="h-4 w-4" />
            {t('ride.fbDown')}
          </Button>
        </div>
        {down && (
          <div className="mt-3 space-y-3">
            <div>
              <div className="mb-1.5 text-xs font-medium text-silver">{t('ride.fbWhy')}</div>
              <div className="flex flex-wrap gap-1.5">
                {reasons.map((r) => (
                  <button
                    key={r}
                    type="button"
                    aria-pressed={reason === r}
                    onClick={() => setReason(r)}
                    className={cn(
                      'rounded-full border px-3 py-1 text-xs transition coarse:min-h-11',
                      reason === r ? 'border-gold bg-gold/15 text-gold' : 'border-navy-secondary text-silver hover:text-ink',
                    )}
                  >
                    {t(`ride.fbReason.${r}` as MessageKey)}
                  </button>
                ))}
              </div>
            </div>
            <Field label={t('ride.fbNote')}>
              {(p) => <Input {...p} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />}
            </Field>
            <Button size="sm" onClick={() => send.mutate({ rideId: ride.rideId, thumbsUp: false })} loading={send.isPending} disabled={send.isPending || !reason}>
              {t('ride.fbSend')}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ----- Standing bookings -------------------------------------------------- */

/** "Mon, Wed, Fri" in the rider's language. */
function daysLabel(days: number[], lang: string): string {
  const fmt = new Intl.DateTimeFormat(lang, { weekday: 'short', timeZone: 'UTC' });
  // 2026-01-04 is a Sunday.
  return [...days].sort().map((d) => fmt.format(new Date(Date.UTC(2026, 0, 4 + d)))).join(', ');
}

export function StandingBookings() {
  const { t, lang } = useI18n();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const q = useQuery({ queryKey: ['transport', 'me', 'series'], queryFn: listMySeries, staleTime: 60_000 });
  const series = q.data?.series ?? [];
  if (series.length === 0) return null;
  const stop = async (id: string) => {
    const ok = await confirm({ title: t('ride.seriesStop'), description: t('ride.seriesStopped'), confirmLabel: t('ride.seriesStop'), destructive: true });
    if (!ok) return;
    try {
      await cancelSeries(id);
      toast.success(t('ride.seriesStopped'));
      await queryClient.invalidateQueries({ queryKey: ['transport', 'me'] });
    } catch (err) {
      toast.error(why(err));
    }
  };
  return (
    <Card className="mb-4">
      <CardContent>
        <SectionTitle className="mb-0" title={t('ride.seriesTitle')} icon={Repeat} description={t('ride.seriesBody')} />
        <ul className="mt-2 divide-y divide-navy-secondary/60">
          {series.map((x) => (
            <li key={x.id} className="flex items-center gap-3 py-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-ink">
                  {x.direction === 'TO_WORK' ? t('ride.toWork') : t('ride.fromWork')} · {x.store.name}
                </div>
                <div className="truncate text-xs text-silver">
                  {daysLabel(x.daysOfWeek, lang)} · {x.windowLabel ? t('ride.shiftTag', { shift: x.windowLabel }) : x.timeOfDay}
                  {' · '}
                  {x.pickup.kind === 'stop' ? x.pickup.name : x.pickup.address}
                </div>
                {x.bookedThrough && (
                  <div className="text-xs text-silver/80">{t('ride.seriesThrough', { date: fmtDayShort(x.bookedThrough, { anchored: true }) })}</div>
                )}
              </div>
              <Button size="xs" variant="ghost" onClick={() => void stop(x.id)}>
                {t('ride.seriesStop')}
              </Button>
            </li>
          ))}
        </ul>
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
      <CardContent>
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
      <CardContent>
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
  // eslint-disable-next-line no-restricted-syntax -- UTC on purpose: date-only arithmetic on a UTC-midnight date, no instant involved
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
  const { t, lang } = useI18n();
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
  // The earliest a seat can be requested right now: on short notice when
  // the director allows it, else the planning cutoff. A ride between the
  // two is "short notice" — allowed, flagged, and a driver has to take it.
  const shortMs = s.shortNoticeMinutes > 0 ? s.shortNoticeMinutes * 60_000 : null;
  const earliest = useMemo(
    () => new Date(Date.now() + (shortMs ?? s.cutoffHours * H) + 5 * 60_000),
    [shortMs, s.cutoffHours],
  );
  const plannedFrom = useMemo(() => new Date(Date.now() + s.cutoffHours * H + 5 * 60_000), [s.cutoffHours]);
  // Open on today while anything today can still be requested; else the
  // first day that can — and SAY so. The old silent jump to tomorrow is
  // how "I booked a ride home" became a ride for tomorrow afternoon.
  const [{ date: initialDate, moved: dateMoved }] = useState(() => {
    if (initial.date) return { date: initial.date, moved: false };
    const today = zonedDayKey(new Date(), tz);
    const first = zonedDayKey(earliest, tz);
    if (first !== today) return { date: first, moved: true };
    const ws = store?.windows ?? [];
    const todayOpen =
      ws.length === 0 ||
      ws.some((w) =>
        (['TO_WORK', 'FROM_WORK'] as const).some((d) => new Date(shiftTargetIso(w, today, d, tz)) >= earliest),
      );
    return todayOpen ? { date: today, moved: false } : { date: addDays(today, 1), moved: true };
  });
  const [date, setDate] = useState(initialDate);
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
  // A saved address the booking refused for having no pin: the picker
  // opens the pin step on it.
  const [pinPlaceId, setPinPlaceId] = useState<string | null>(null);
  const [saveAs, setSaveAs] = useState('');
  const [note, setNote] = useState('');
  // A standing booking: the same ride on these days, every week.
  const [repeat, setRepeat] = useState(false);
  const [repeatDays, setRepeatDays] = useState<number[]>([]);
  const [repeatUntil, setRepeatUntil] = useState('');
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
  const noticeOf = (at: string | null): RideNotice | null =>
    !at ? null : new Date(at) < earliest ? 'closed' : new Date(at) < plannedFrom ? 'short_notice' : 'planned';
  const tooSoon = legs.some((l) => noticeOf(l.at) === 'closed');
  const shortNotice = !tooSoon && legs.some((l) => noticeOf(l.at) === 'short_notice');
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
    const days = repeatDays;
    if (repeat && days.length === 0) return setError(t('ride.repeatPickDays'));
    if (tooSoon && !repeat) return;
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
      if (repeat) {
        // Booked forward by the server under the same rules as a hand booking.
        let count = 0;
        for (const leg of legs) {
          const legTime = leg.direction === 'TO_WORK' ? arrive : leave;
          const body: SeriesInput = {
            direction: leg.direction,
            locationId: store.id,
            ...home,
            ...(picked ? { windowLabel: picked.label } : { timeOfDay: legTime }),
            daysOfWeek: days,
            startsOn: date,
            endsOn: repeatUntil || null,
            ...(note.trim() ? { note: note.trim() } : {}),
          };
          count += (await createSeries(body)).booked;
        }
        hapticConfirm();
        toast.success(t('ride.repeatBooked', { count }));
        await queryClient.invalidateQueries({ queryKey: ['transport', 'me'] });
        onOpenChange(false);
        return;
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
        toast.success(legs.length === 2 ? t('ride.bookedBoth') : t('ride.booked'), {
          description: fareWords(t, total, data.charges.nextPayday, date, data.charges.payroll),
        });
      }
      await queryClient.invalidateQueries({ queryKey: ['transport', 'me'] });
      await queryClient.invalidateQueries({ queryKey: ['transport', 'trips'] });
      onOpenChange(false);
    } catch (err) {
      // A saved address that was never placed on the map: open the pin
      // step on it rather than echoing a message about suggestions.
      const placeId =
        err instanceof ApiError && err.code === 'place_not_located'
          ? (err.details as { placeId?: string } | undefined)?.placeId
          : undefined;
      if (placeId) setPinPlaceId(placeId);
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
                      {st.mine ? ` · ${t('ride.yourStore')}` : ''}
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
          {dateMoved && (
            <p role="status" className="text-xs text-silver">
              {t('ride.dateMoved', {
                when: `${fmtRelativeDayTz(earliest, tz)} ${fmtTimeTz(earliest, tz)}`,
                day: fmtRelativeDayTz(localInputToUtcIso(`${date}T12:00`, tz), tz),
              })}
            </p>
          )}

          {/* Without this, a failed trip lookup just showed every shift as
              having no seats taken — a rider would book into a van that
              was already full. */}
          {trips.isError && <QueryError what={t('ride.load.seats')} query={trips} />}
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
            profileAddress={data.profileAddress ?? null}
            locationId={store?.id ?? null}
            label={pickupLabel}
            invalid={!!error && !pickup}
            pinPlaceId={pinPlaceId}
            onPinPlaceDone={() => {
              setPinPlaceId(null);
              setError(null);
            }}
            onPlaceAdded={() => void queryClient.invalidateQueries({ queryKey: ['transport', 'me'] })}
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

          <div className="rounded-lg border border-navy-secondary p-3">
            <label className="flex items-center gap-2 text-sm text-ink coarse:min-h-11">
              <input
                type="checkbox"
                className="h-4 w-4 coarse:h-6 coarse:w-6"
                checked={repeat}
                onChange={(e) => {
                  setRepeat(e.target.checked);
                  if (e.target.checked && repeatDays.length === 0) setRepeatDays([new Date(`${date}T12:00:00Z`).getUTCDay()]);
                }}
              />
              <Repeat className="h-4 w-4 text-silver" aria-hidden="true" />
              {t('ride.repeatWeekly')}
            </label>
            {repeat && (
              <div className="mt-3 space-y-3">
                <fieldset>
                  <legend className="mb-1.5 text-xs font-medium text-silver">{t('ride.repeatDays')}</legend>
                  <div className="flex flex-wrap gap-1.5">
                    {[1, 2, 3, 4, 5, 6, 0].map((d) => {
                      const on = repeatDays.includes(d);
                      return (
                        <button
                          key={d}
                          type="button"
                          aria-pressed={on}
                          onClick={() => setRepeatDays((x) => (on ? x.filter((y) => y !== d) : [...x, d]))}
                          className={cn(
                            'min-w-11 rounded-full border px-3 py-1 text-xs transition coarse:min-h-11',
                            on ? 'border-gold bg-gold/15 text-gold' : 'border-navy-secondary text-silver hover:text-ink',
                          )}
                        >
                          {daysLabel([d], lang)}
                        </button>
                      );
                    })}
                  </div>
                </fieldset>
                <Field label={t('ride.repeatUntil')}>
                  {(p) => <Input {...p} type="date" value={repeatUntil} min={date} onChange={(e) => setRepeatUntil(e.target.value)} className="w-44" />}
                </Field>
                <p className="text-xs text-silver">{t('ride.repeatHint')}</p>
              </div>
            )}
          </div>

          {tooSoon && (
            <p role="alert" className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-warning">
              {t('ride.tooSoon', { when: `${fmtRelativeDayTz(earliest, tz)} ${fmtTimeTz(earliest, tz)}` })}
              {s.dispatchPhone && (
                <>
                  {' '}
                  {t('ride.callDispatch')}{' '}
                  <a href={`tel:${s.dispatchPhone.replace(/[^+\d]/g, '')}`} className="font-semibold underline">
                    {s.dispatchPhone}
                  </a>
                </>
              )}
            </p>
          )}
          {shortNotice && (
            <p role="status" className="rounded-md border border-gold/40 bg-gold/10 p-3 text-sm text-gold">
              {t('ride.shortNoticeNote')}
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
          <span className="min-w-0 text-sm text-silver tabular-nums" data-testid="booking-fare">
            {fareWords(t, total, data.charges.nextPayday, date, data.charges.payroll)}
          </span>
          <Button
            className="shrink-0"
            onClick={() => void submit()}
            loading={busy}
            disabled={busy || (tooSoon && !repeat) || !store || (byShift && !picked) || (repeat && repeatDays.length === 0)}
          >
            {repeat
              ? t('ride.repeatBtn')
              : fullLegs.length === legs.length && fullLegs.length > 0
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
    const notice = trip.notice ?? (trip.bookable ? 'planned' : 'closed');
    if (notice === 'closed' || notice === 'too_far') return { text: lead + t('ride.seatTooSoon'), tone: 'text-silver/60' };
    if (trip.full) return { text: lead + t('ride.seatFull', { position: trip.waiting + 1 }), tone: 'text-warning' };
    if (notice === 'short_notice') return { text: lead + t('ride.seatShortNotice'), tone: 'text-gold' };
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
  initialCategory,
  open,
  onOpenChange,
}: {
  rides: Ride[];
  initialRideId?: string;
  /** "Question a charge" opens on CHARGE_DISPUTE. */
  initialCategory?: TransportIssueCategory;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const initial = rides.find((r) => r.id === initialRideId);
  const [category, setCategory] = useState<TransportIssueCategory>(
    initialCategory ?? (initial?.status === 'NO_SHOW' ? 'CHARGE_DISPUTE' : 'LATE_VAN'),
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
  const recent = rides
    .filter((r) => r.status !== 'CANCELLED')
    .sort((a, b) => new Date(b.targetAt).getTime() - new Date(a.targetAt).getTime())
    .slice(0, 15);
  // The ride a charge was questioned on is always one of the choices, however old.
  const choices = initial && !recent.includes(initial) ? [initial, ...recent] : recent;
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
