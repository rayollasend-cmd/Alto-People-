import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Check, Hand, MapPin, Phone, Share2, Timer, Wallet } from '@/components/ui/icons';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { hapticConfirm } from '@/lib/haptics';
import { useI18n, type Translate } from '@/lib/i18n';
import { fmtMoney, fmtRelativeDayTz, fmtTimeTz, mapsUrl } from '@/lib/format';
import { personPhotoUrl } from '@/lib/photoUrl';
import { shareMyRide } from '@/lib/transportOpsApi';
import { signalDriver, type MyLiveRide, type MyTransport, type Ride, type RiderSignal } from '@/lib/transportApi';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { TripMap, tripStage } from '../TripMap';
import { fmtClock, fmtIn } from '../rideShifts';
import { CrewDialog } from './CrewDialog';
import { PlateChip } from './PlateChip';
import { fareWords } from './charges';
import { liveTripView, tripProgress, type LiveTripView } from './tripState';
import { shareOrCopy } from './share';
import { useTick } from './useTick';
import '@/lib/i18n/en/ride';
import '@/lib/i18n/en/shift';

/**
 * The Uber moment (the transport upgrade, 2026-10-28): the next ride once
 * a van is on it. The map fills the top — the van moving with its
 * heading, the rider's pickup, the route — and a sheet below says ONE
 * thing in big type: when the van leaves, how far off it is, that it's
 * here and how long it waits, or when they'll arrive. Under it the driver
 * and the van to look for (plate as a plate), one row of actions, where
 * exactly to wait, and the fare in words.
 *
 * Privacy: the driver's first name only, never their phone — "Call
 * dispatch" rings the transport desk, and the share link shows the van
 * and its ETA, nothing else.
 */

const H = 3_600_000;

function why(err: unknown): string {
  return err instanceof ApiError ? err.message : 'The request didn’t get through. Check your signal and try again.';
}

/** How fresh the van's position is, in words. */
function ago(t: Translate, iso: string | null, now: number): string {
  if (!iso) return '';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return s < 10 ? t('ride.agoNow') : s < 60 ? t('ride.agoSec', { n: s }) : t('ride.agoMin', { n: Math.round(s / 60) });
}

/** The one line a rider reads first. */
export function tripHeadline(t: Translate, v: LiveTripView, ride: Ride, live: MyLiveRide | null): string {
  const who = v.driverFirst || v.vanName;
  switch (v.phase) {
    case 'before':
      return v.departAt && v.vanName
        ? t('ride.trip.leaves', { van: v.vanName, time: fmtTimeTz(v.departAt, v.tz) })
        : v.pickupAt
          ? t('ride.pickupAt', { time: fmtTimeTz(v.pickupAt, v.tz) })
          : fmtTimeTz(ride.targetAt, v.tz);
    case 'onWay':
      if (v.arrivingNow) return t('ride.liveHere');
      if (v.minutesAway !== null) return who ? t('ride.trip.away', { driver: who, min: v.minutesAway }) : t('ride.liveAway', { min: v.minutesAway });
      return who ? t('ride.trip.onTheWay', { driver: who }) : t('ride.liveOnWay', { van: v.vanName });
    case 'arrived':
      return who ? t('ride.trip.here', { driver: who }) : t('ride.vanHere');
    case 'onBoard':
      return v.etaAt
        ? t('ride.trip.arriving', { time: fmtTimeTz(v.etaAt, v.tz) })
        : t('ride.trip.onBoardTo', { place: live?.destination.label || ride.store.name });
  }
}

/**
 * The API's fare — { cents, words: "Taken from your pay on Nov 6" } in the
 * rider's language — as one sentence with its amount: "$5.00 — taken from
 * your pay on Nov 6". A free ride is just its words ("No charge").
 */
export function liveFareWords(t: Translate, lang: string, fare: { cents: number; words: string }): string {
  if (fare.cents <= 0) return fare.words;
  const words = fare.words ? fare.words.charAt(0).toLocaleLowerCase(lang) + fare.words.slice(1) : '';
  return words ? t('ride.fare.withWords', { amount: fmtMoney(fare.cents / 100), words }) : fmtMoney(fare.cents / 100);
}

/** "Look for the white Ford Transit, ALT 101". */
function lookLine(t: Translate, lang: string, v: LiveTripView): string | null {
  // English reads "the white Ford Transit"; other languages place the colour themselves.
  const look = lang === 'en' && v.look ? v.look.charAt(0).toLowerCase() + v.look.slice(1) : v.look;
  if (look && v.plate) return t('ride.trip.lookFor', { look, plate: v.plate });
  if (look) return t('ride.trip.lookForNoPlate', { look });
  if (v.plate && v.vanName) return t('ride.trip.lookForVan', { van: v.vanName, plate: v.plate });
  return null;
}

/** Where the rider waits: their home end on the way to work, the store on the way home. */
function waitPlace(ride: Ride, live: MyLiveRide | null): string {
  if (live?.pickup.label) return live.pickup.label;
  if (ride.direction === 'FROM_WORK') return ride.store.name;
  return ride.pickup.kind === 'stop' ? ride.pickup.name : ride.pickup.address;
}

export function LiveTrip({
  data,
  ride,
  live,
  cancellable,
  onCancel,
  onReport,
}: {
  data: MyTransport;
  ride: Ride;
  live: MyLiveRide | null;
  cancellable: boolean;
  onCancel: () => void;
  onReport: () => void;
}) {
  const { t, lang } = useI18n();
  const queryClient = useQueryClient();
  const [crewOpen, setCrewOpen] = useState(false);
  const [sending, setSending] = useState<RiderSignal | null>(null);
  const [sent, setSent] = useState<RiderSignal | null>(null);
  const [sharing, setSharing] = useState(false);
  const l = live && live.rideId === ride.id ? live : null;
  const now = useTick(ride.vanArrivedAt || l?.vanArrivedAt ? 1_000 : 10_000);
  const v = liveTripView(ride, l, now);
  const stage = tripStage(ride, l);
  const who = v.driverFirst || v.vanName;
  // "I'm outside" outranks "running late": once outside, that's what the driver knows.
  const signal: RiderSignal | null = sent === 'OUTSIDE' || v.signal === 'OUTSIDE' ? 'OUTSIDE' : (sent ?? v.signal);
  const headline = tripHeadline(t, v, ride, l);
  const signals = v.phase === 'onWay' || v.phase === 'arrived';
  const dispatchPhone = (l?.dispatchPhone ?? data.settings.dispatchPhone ?? '').trim() || null;
  const fare = l?.fare
    ? liveFareWords(t, lang, l.fare)
    : fareWords(t, ride.owedCents > 0 ? ride.owedCents : ride.fareCents, data.charges.nextPayday, ride.serviceDate);
  const look = lookLine(t, lang, v);

  const tell = async (kind: RiderSignal) => {
    setSending(kind);
    try {
      await signalDriver(ride.id, kind);
      hapticConfirm();
      setSent(kind);
      await queryClient.invalidateQueries({ queryKey: ['transport', 'me'] });
    } catch (err) {
      toast.error(why(err));
    } finally {
      setSending(null);
    }
  };

  const share = async () => {
    setSharing(true);
    try {
      const link = await shareMyRide(ride.id);
      const outcome = await shareOrCopy({ url: link.url, title: t('ride.share.title'), text: t('ride.share.text', { van: v.vanName }) });
      if (outcome === 'copied') toast.success(t('ride.share.copied'));
      else if (outcome === 'failed') toast.error(t('ride.share.failed'), { description: link.url });
    } catch (err) {
      toast.error(why(err));
    } finally {
      setSharing(false);
    }
  };

  /* ---- the status line above the headline ---- */
  const untilDepart = v.departAt ? Date.parse(v.departAt) - now : null;
  const eyebrow =
    v.phase === 'before'
      ? fmtRelativeDayTz(v.departAt ?? v.pickupAt ?? ride.targetAt, v.tz, now)
      : v.phase === 'onWay'
        ? t('ride.step.onWay')
        : v.phase === 'arrived'
          ? t('ride.step.here')
          : t('ride.step.aboard');
  const fresh = !!v.positionAt && !v.stale && v.phase !== 'before';
  const statusTone = v.phase === 'arrived' || v.phase === 'onBoard' ? 'text-positive-800' : v.phase === 'onWay' ? 'text-ink' : 'text-accent';
  const chip =
    v.phase === 'before' ? (
      untilDepart !== null && untilDepart > 0 && untilDepart < 24 * H ? (
        <span className="text-sm tabular-nums text-ink-muted">{t('ride.leavesIn', { time: fmtIn(untilDepart) })}</span>
      ) : null
    ) : v.phase === 'onWay' ? (
      v.lateMinutes > 0 ? (
        <Badge variant="pending" size="lg">{t('ride.trip.late', { min: v.lateMinutes })}</Badge>
      ) : v.etaAt ? (
        <Badge variant="success" size="lg">{t('ride.trip.onTime')}</Badge>
      ) : null
    ) : null;

  /* ---- under the headline: the second fact ---- */
  const stopsText =
    v.stopsBefore === null
      ? null
      : v.stopsBefore === 0
        ? t('ride.liveNextStop')
        : v.stopsBefore === 1
          ? t('ride.liveStopsOne')
          : t('ride.liveStopsMany', { count: v.stopsBefore });
  const targetLine =
    ride.direction === 'TO_WORK' ? t('ride.arriveBy', { time: fmtTimeTz(ride.targetAt, v.tz) }) : t('ride.leaveAt', { time: fmtTimeTz(ride.targetAt, v.tz) });
  const tripLine = [
    ride.direction === 'TO_WORK' ? t('ride.toWork') : t('ride.fromWork'),
    ride.store.name,
    ...(ride.windowLabel ? [t('ride.shiftTag', { shift: ride.windowLabel })] : []),
    targetLine,
  ].join(' · ');
  const freshness =
    v.positionAt && v.phase !== 'before' ? (
      <p className={cn('mt-1 text-sm', v.stale ? 'text-caution-800' : 'text-ink-muted')}>
        {v.stale ? t('ride.liveStale', { ago: ago(t, v.positionAt, now) }) : t('ride.liveUpdated', { ago: ago(t, v.positionAt, now) })}
      </p>
    ) : null;

  const second =
    v.phase === 'before' ? (
      <>
        <p className="mt-1 text-lg font-medium text-ink tabular-nums">
          {v.pickupAt ? t('ride.trip.pickupAt', { time: fmtTimeTz(v.pickupAt, v.tz), place: waitPlace(ride, l) }) : targetLine}
        </p>
        <p className="mt-0.5 text-sm text-ink-muted">{tripLine}</p>
      </>
    ) : v.phase === 'onWay' ? (
      <>
        <p className="mt-1 text-lg font-medium text-ink tabular-nums">
          {[v.pickupAt ? t('ride.pickupAt', { time: fmtTimeTz(v.pickupAt, v.tz) }) : null, stopsText].filter(Boolean).join(' · ')}
        </p>
        {freshness}
      </>
    ) : v.phase === 'arrived' ? (
      <>
        {look && <p className="mt-1 text-lg font-medium text-ink">{look}</p>}
        <WaitRow v={v} who={who} />
      </>
    ) : (
      <>
        <TripBar value={tripProgress(ride.boardedAt ?? v.departAt, v.etaAt, now)} />
        <p className="mt-2 text-base text-ink-muted">{t('ride.trip.to', { place: l?.destination.label || (ride.direction === 'TO_WORK' ? ride.store.name : waitPlace(ride, null)) })}</p>
        {freshness}
      </>
    );

  /* ---- one row of actions ---- */
  const tiles: TileProps[] = [];
  if (signals) {
    tiles.push({
      label: t('ride.imOutside'),
      icon: signal === 'OUTSIDE' ? Check : Hand,
      primary: signal !== 'OUTSIDE',
      done: signal === 'OUTSIDE',
      busy: sending === 'OUTSIDE',
      disabled: signal === 'OUTSIDE' || !!sending,
      onClick: () => void tell('OUTSIDE'),
    });
    tiles.push({
      label: t('ride.runningLate'),
      icon: signal === 'LATE' ? Check : Timer,
      done: signal === 'LATE',
      busy: sending === 'LATE',
      disabled: !!signal || !!sending,
      onClick: () => void tell('LATE'),
    });
  }
  if (dispatchPhone) {
    tiles.push({ label: t('ride.trip.callDispatch'), ariaLabel: t('ride.trip.callDispatchAt', { phone: dispatchPhone }), icon: Phone, href: `tel:${dispatchPhone.replace(/[^\d+]/g, '')}` });
  }
  tiles.push({ label: t('ride.trip.share'), icon: Share2, busy: sharing, disabled: sharing, onClick: () => void share() });

  const note = l?.pickupNote?.trim() || null;
  const waitMinutes = Math.round(v.waitMs / 60_000);
  const showWait = v.phase !== 'onBoard';

  const sheet = (
    <div
      className={cn(
        'relative bg-surface px-4 pb-5 pt-3 sm:px-5',
        l && '-mt-4 rounded-t-lg border-t border-line elev-2',
      )}
    >
      {l && <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-line-strong/60" aria-hidden="true" />}
      <div className="flex min-h-7 items-center justify-between gap-2">
        <span className={cn('inline-flex min-w-0 items-center gap-1.5 text-2xs font-semibold uppercase tracking-[0.18em]', statusTone)}>
          {fresh ? (
            <span className="relative flex h-2 w-2 shrink-0" aria-hidden="true">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-positive-700 opacity-60 motion-reduce:hidden" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-positive-700" />
            </span>
          ) : null}
          <span className="truncate">{eyebrow}</span>
        </span>
        {chip}
      </div>
      <p aria-live="polite" className="mt-1.5 text-[1.75rem] font-bold leading-[1.15] tracking-tight text-ink tabular-nums sm:text-4xl" data-testid="trip-headline">
        {headline}
      </p>
      {second}

      {/* What they told the driver. */}
      {signal && signals && (
        <p role="status" className="mt-3 flex items-center gap-1.5 text-sm font-medium text-positive-800">
          <Check className="h-4 w-4 shrink-0" aria-hidden="true" />
          {signal === 'OUTSIDE' ? t('ride.toldOutside', { driver: who }) : t('ride.toldLate', { driver: who })}
        </p>
      )}
      <div className={cn('grid gap-1', signal && signals ? 'mt-2' : 'mt-3', tiles.length === 4 ? 'grid-cols-4' : tiles.length === 3 ? 'grid-cols-3' : tiles.length === 2 ? 'grid-cols-2' : 'grid-cols-1')}>
        {tiles.map((tile) => (
          <Tile key={tile.label} {...tile} />
        ))}
      </div>

      {/* Who's driving, and the van to look for. */}
      <button
        type="button"
        onClick={() => setCrewOpen(true)}
        disabled={!ride.run}
        aria-label={t('ride.crewOpen')}
        className="mt-3 flex w-full items-center gap-3 rounded-lg border border-line bg-surface-raised/40 p-3 text-left transition-colors hover:bg-surface-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright disabled:cursor-default disabled:hover:bg-surface-raised/40"
      >
        <Avatar src={ride.run ? personPhotoUrl(ride.run.driver) : null} name={ride.run?.driver.name ?? who} email="" size="lg" className="self-start" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate text-lg font-semibold text-ink">{v.driverFirst || t('ride.driverLabel')}</span>
            {v.plate && <PlateChip plate={v.plate} />}
          </span>
          <span className="mt-0.5 block text-sm text-ink-muted">{[v.look, v.vanName].filter(Boolean).join(' · ')}</span>
          {(ride.seats || (ride.coRiders?.length ?? 0) > 0) && (
            <span className="block text-sm text-ink-muted">
              {[
                (ride.coRiders?.length ?? 0) > 0
                  ? ride.coRiders!.length === 1
                    ? t('ride.ridingWithOne')
                    : t('ride.ridingWith', { count: ride.coRiders!.length })
                  : null,
                ride.seats ? t('ride.seatsFilled', { taken: ride.seats.taken, capacity: ride.seats.capacity }) : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          )}
        </span>
      </button>

      {/* Where exactly to wait, and the rule. */}
      {showWait && (
        <div className="mt-4 flex gap-3 border-t border-line-subtle pt-4">
          <MapPin className="mt-0.5 h-5 w-5 shrink-0 text-accent" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <div className="text-2xs font-semibold uppercase tracking-[0.18em] text-ink-muted">{t('ride.trip.whereToWait')}</div>
            <div className="mt-0.5 text-base font-medium text-ink">{waitPlace(ride, l)}</div>
            {note && <div className="text-base text-ink">{note}</div>}
            <div className="mt-1 text-sm text-ink-muted">{t('ride.trip.waitRule', { count: waitMinutes })}</div>
          </div>
          {ride.direction === 'TO_WORK' && ride.pickup.address && (
            <a
              href={mapsUrl(ride.pickup.address)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex shrink-0 items-start text-sm text-accent underline underline-offset-2 hover:text-gold-bright coarse:min-h-11"
            >
              {t('shift.directions')}
            </a>
          )}
        </div>
      )}

      {/* The fare, in words. */}
      <div className={cn('flex items-start gap-3', showWait ? 'mt-3' : 'mt-4 border-t border-line-subtle pt-4')}>
        <Wallet className="mt-0.5 h-5 w-5 shrink-0 text-ink-muted" aria-hidden="true" />
        <p className="min-w-0 flex-1 text-base text-ink tabular-nums" data-testid="trip-fare">
          {fare}
        </p>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-2 border-t border-line-subtle pt-3">
        {cancellable && (
          <Button size="sm" variant="secondary" onClick={onCancel}>
            {t('ride.cancel')}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onReport}>
          {t('ride.report')}
        </Button>
      </div>
    </div>
  );

  return (
    <section
      aria-label={t('ride.nextRide')}
      data-phase={v.phase}
      className="relative -mx-4 mb-4 overflow-hidden border-b border-line bg-surface animate-enter sm:mx-0 sm:rounded-lg sm:border"
    >
      {l && (
        <TripMap
          stage={stage}
          live={l}
          vanLabel={v.vanName}
          className={cn(v.phase === 'arrived' ? 'h-[32vh] min-h-[13rem]' : 'h-[40vh] min-h-[15rem]', 'max-h-[26rem]')}
          tapToExpand
          overlay={
            <div className="rounded-lg border border-line bg-surface-overlay/95 p-4 elev-3 backdrop-blur">
              <div className="text-2xs font-semibold uppercase tracking-[0.18em] text-ink-muted">{eyebrow}</div>
              <p className="mt-1 text-2xl font-bold leading-tight tracking-tight text-ink tabular-nums">{headline}</p>
              <div className="mt-2 flex items-center justify-between gap-3">
                <span className="min-w-0 truncate text-sm text-ink-muted">{[v.driverFirst, v.look || v.vanName].filter(Boolean).join(' · ')}</span>
                {v.plate && <PlateChip plate={v.plate} size="sm" />}
              </div>
            </div>
          }
        />
      )}
      {sheet}
      {crewOpen && <CrewDialog rideId={ride.id} onClose={() => setCrewOpen(false)} />}
    </section>
  );
}

/** Arrived: the wait, running down — "Mike waits 3 minutes · 2:41 to get on board". */
function WaitRow({ v, who }: { v: LiveTripView; who: string }) {
  const { t } = useI18n();
  const frac = Math.max(0, Math.min(1, v.waitLeftMs / v.waitMs));
  const r = 16;
  const c = 2 * Math.PI * r;
  const minutes = Math.round(v.waitMs / 60_000);
  return (
    <div className="mt-3 flex items-center gap-3 rounded-lg border border-positive-200 bg-positive-50 px-3 py-2.5">
      <svg viewBox="0 0 40 40" className="h-9 w-9 shrink-0 -rotate-90" aria-hidden="true">
        <circle cx="20" cy="20" r={r} fill="none" strokeWidth="4" className="stroke-positive-200" />
        <circle
          cx="20"
          cy="20"
          r={r}
          fill="none"
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - frac)}
          className="stroke-positive-700 transition-[stroke-dashoffset] duration-1000 ease-linear"
        />
      </svg>
      <div className="min-w-0">
        <p className="text-base font-semibold text-positive-800">{who ? t('ride.trip.waits', { driver: who, count: minutes }) : t('ride.trip.waitRule', { count: minutes })}</p>
        {v.waitLeftMs > 0 ? (
          <p className="text-sm font-medium tabular-nums text-positive-800">{t('ride.waitLeft', { time: fmtClock(v.waitLeftMs) })}</p>
        ) : (
          <p className="text-sm font-semibold text-caution-800">{t('ride.waitOver')}</p>
        )}
      </div>
    </div>
  );
}

/** On board: how far into the trip, by the clock. */
function TripBar({ value }: { value: number | null }) {
  const { t } = useI18n();
  if (value === null) return null;
  const pct = Math.round(value * 100);
  return (
    <div
      className="mt-3 h-2 overflow-hidden rounded-full bg-surface-raised"
      role="progressbar"
      aria-label={t('ride.trip.progress')}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
    >
      <div className="h-full rounded-full bg-positive-700 transition-[width] duration-1000" style={{ width: `${pct}%` }} />
    </div>
  );
}

interface TileProps {
  label: string;
  ariaLabel?: string;
  icon: React.ComponentType<{ className?: string }>;
  primary?: boolean;
  done?: boolean;
  busy?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  href?: string;
}

/** One action: a round button with its words under it — big enough for a thumb at the gate. */
function Tile({ label, ariaLabel, icon: Icon, primary, done, busy, disabled, onClick, href }: TileProps) {
  const inner = (
    <>
      <span
        className={cn(
          'grid h-12 w-12 place-items-center rounded-full transition-[transform,background-color,border-color] group-active:scale-95',
          primary
            ? 'btn-gold text-on-accent'
            : done
              ? 'border border-positive-200 bg-positive-100 text-positive-800'
              : 'border border-line bg-surface-raised text-ink group-hover:border-line-strong',
          busy && 'animate-pulse',
        )}
        aria-hidden="true"
      >
        <Icon className="h-5 w-5" />
      </span>
      <span className={cn('text-[13px] font-medium leading-tight', primary ? 'text-ink' : 'text-ink-muted group-hover:text-ink')}>{label}</span>
    </>
  );
  const cls =
    'group flex min-h-[4.75rem] flex-col items-center justify-start gap-1.5 rounded-lg px-1 py-1.5 text-center focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright disabled:cursor-default';
  if (href) {
    return (
      <a href={href} className={cls} aria-label={ariaLabel}>
        {inner}
      </a>
    );
  }
  return (
    <button type="button" className={cls} onClick={onClick} disabled={disabled} aria-label={ariaLabel} aria-pressed={done ? true : undefined} aria-busy={busy || undefined}>
      {inner}
    </button>
  );
}
