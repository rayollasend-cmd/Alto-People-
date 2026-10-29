import { useContext, useState } from 'react';
import { toast } from 'sonner';
import {
  CheckCheck,
  Check,
  ClipboardCheck,
  Clock,
  Flag,
  Home,
  MapPin,
  MessageSquare,
  Navigation,
  Phone,
  PhoneCall,
  RotateCcw,
  Route,
  ShieldAlert,
  Store,
  UserX,
} from '@/components/ui/icons';
import { ApiError } from '@/lib/api';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { cn } from '@/lib/cn';
import { useConfirm } from '@/lib/confirm';
import { fmtMoney, fmtTimeTz } from '@/lib/format';
import { tapArrived, tapBoard, tapBoardAll, tapComplete, tapNoShow, tapUndo, pendingFor } from '@/lib/offlineTransport';
import { NO_SHOW_WAIT_MS, startDriverRun, textRiderHere, type GeoPoint, type Ride, type RideRun } from '@/lib/transportApi';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { fmtClock } from '../rideShifts';
import { OkPrompt, PreTripDialog, navigateTo, useNavApp } from '../DriverTools';
import { DriveMap } from './DriveMap';
import { HoldButton } from './HoldButton';
import { PendingMarksContext, PendingPill, SafetyContext, ShiftMapContext, useAct, useNavMemory, useTick, type Act, type IsBusy } from './driveKit';
import {
  aboardCount,
  conflictsOf,
  driveStep,
  localStatus,
  navKey,
  preTripOwed,
  riding,
  runTz,
  shortName,
  spanParts,
  stopsFor,
  storeNames,
  tripOfRun,
  type DriveStep,
  type Stop,
} from './driveModel';
import { SharingLine, useShareVanLocation } from './vanLocation';
import '@/lib/i18n/en/drive';
import '@/lib/i18n/en/ride';

/**
 * NOW — the driver's one run, Uber-style: the map edge to edge, and under
 * it a sheet with the thing that matters in big type ("Leaves in 26 min")
 * and ONE gold button that steps through the run:
 *
 *   Pre-trip check (once per van per day) → Start run → Navigate to stop 1
 *   → Arrived → the stop's riders, All on board (No-show opens after the
 *   wait, with the clock showing) → the next stop … → the drop-off →
 *   hold to Complete run.
 *
 * Everything else on the sheet is quiet: the safety shield in its corner,
 * Report a problem and the shift's stops at its foot. Taps go through the
 * offline queue, and a tap still waiting to send already moves the card on.
 */

/** The run's one big action: 56px, full width. */
const BIG = 'h-14 w-full text-lg font-semibold';
const EYEBROW = 'text-sm font-semibold uppercase tracking-[0.12em]';

/** Where to point the map app for a stop: the riders' own pin when there is one, else the address. */
const stopPoint = (s: Stop): GeoPoint | null => (s.kind === 'home' ? (s.rides.find((r) => r.point)?.point ?? null) : null);

export interface DriveNowProps {
  run: RideRun;
  /** Every run the driver has (overlaps, the van's pre-trip). */
  runs: RideRun[];
  /** The fleet asks for a pre-trip check (GET /driver/today). */
  preTripRequired: boolean;
  /** The dispatch line, when the driver's answer carries it. */
  dispatchPhone: string | null;
  onReport: () => void;
  onRider: (associateId: string) => void;
  /** More quiet actions for the sheet's foot (Log fuel, the sound switch). */
  more?: React.ReactNode;
}

export function DriveNow({ run, runs, preTripRequired, dispatchPhone, onReport, onRider, more }: DriveNowProps) {
  const { t } = useI18n();
  const marks = useContext(PendingMarksContext);
  const safety = useContext(SafetyContext);
  const openShiftMap = useContext(ShiftMapContext);
  const nav = useNavMemory(run.id);
  const { act, isBusy } = useAct();
  const owed = preTripOwed(run, runs, preTripRequired);
  const step = driveStep(run, { preTripOwed: owed, marks, navigated: nav.navigated });
  const sharing = useShareVanLocation(run.id, run.status === 'ACTIVE');
  const tz = runTz(run);
  const sos = !!run.safety?.sosAt && !run.safety.sosAckAt;
  const trip = tripOfRun(run);
  const waitingIds = new Set(run.rides.filter((r) => riding(r) && localStatus(r, run.id, marks) === 'SCHEDULED').map((r) => r.id));

  return (
    <section aria-label={`${run.van.name} ${fmtTimeTz(run.departAt, tz)}`} data-testid="drive-now" data-step={step.kind} className="relative">
      <DriveMap runId={run.id} step={step} waiting={waitingIds} className="-mx-4 -mb-4 h-[28vh] min-h-44 max-h-80 overflow-hidden md:mx-0 md:h-80 md:rounded-lg" />
      <div className="relative rounded-lg border border-line bg-surface px-4 pb-4 pt-4 text-ink elev-2 md:px-5">
        {/* What interrupts goes first, full width: taps still waiting to send
            (with Send now, where the driver is looking), "Everything OK?", a
            run left open hours too long. */}
        {marks.length > 0 && (
          <div className="mb-3">
            <PendingPill marks={marks} />
          </div>
        )}
        <OkPrompt run={run} onHelp={() => safety.open(run)} />
        {run.stuck && (
          <ErrorBanner severity="warning" className="mb-3 text-base">
            {t('drive.stuckRun')}
          </ErrorBanner>
        )}
        <div className="relative">
          {/* The shield: 911, the desk, share the trip, an incident. Always in this corner. */}
          <Button
            size="icon"
            variant={sos ? 'destructive' : 'secondary'}
            className="absolute -right-1 -top-1 coarse:h-12 coarse:w-12"
            aria-label={t('drive.safety')}
            onClick={() => safety.open(run)}
          >
            <ShieldAlert className="h-5 w-5" />
          </Button>
          {step.kind === 'pretrip' || step.kind === 'start' ? (
            <PlannedBody run={run} runs={runs} step={step} preTripRequired={preTripRequired} act={act} isBusy={isBusy} />
          ) : step.kind === 'navigate' || step.kind === 'arrive' ? (
            <ToStopBody run={run} step={step} act={act} isBusy={isBusy} onNavigate={() => nav.remember(navKey(step.stop, 'pickup'))} />
          ) : step.kind === 'board' ? (
            <BoardBody run={run} step={step} act={act} isBusy={isBusy} onRider={onRider} />
          ) : (
            <FinishBody run={run} step={step} act={act} isBusy={isBusy} onNavigate={(s) => nav.remember(navKey(s, 'drop'))} />
          )}
        </div>
        <Conflicts run={run} runs={runs} dispatchPhone={dispatchPhone} />
        {run.status === 'ACTIVE' && (
          <div className="mt-4">
            <SharingLine state={sharing} />
          </div>
        )}
        {(step.kind === 'navigate' || step.kind === 'arrive' || step.kind === 'board') && <ThenStops run={run} step={step} />}
        {run.status === 'ACTIVE' && <PickedUp run={run} current={'stop' in step ? step.stop : null} act={act} isBusy={isBusy} />}
        <div className="mt-4 grid grid-cols-2 gap-1 border-t border-line-subtle pt-3 [&>*]:justify-start [&>*]:px-2">
          <Button variant="ghost" className="h-11 text-base" onClick={onReport}>
            {t('ride.report')}
          </Button>
          {trip && (
            <Button variant="ghost" className="h-11 text-base" onClick={() => openShiftMap(trip)}>
              <Route className="h-4 w-4" />
              {t('drive.shiftStopsBtn')}
            </Button>
          )}
          {dispatchPhone && (
            <Button variant="ghost" className="h-11 text-base" asChild>
              <a href={`tel:${dispatchPhone}`}>
                <PhoneCall className="h-4 w-4" />
                {t('drive.callDispatch')}
              </a>
            </Button>
          )}
          {more}
        </div>
      </div>
    </section>
  );
}

/* ----- Before the run leaves ------------------------------------------------------- */

function Countdown({ ms }: { ms: number }) {
  const { t } = useI18n();
  const { h, m } = spanParts(ms);
  return <>{h > 0 ? (m ? t('drive.spanHM', { h, m }) : t('drive.spanH', { h })) : t('drive.spanM', { m })}</>;
}

function PlannedBody({
  run,
  runs,
  step,
  preTripRequired,
  act,
  isBusy,
}: {
  run: RideRun;
  runs: RideRun[];
  step: Extract<DriveStep, { kind: 'pretrip' | 'start' }>;
  preTripRequired: boolean;
  act: Act;
  isBusy: IsBusy;
}) {
  const { t } = useI18n();
  const now = useTick(15_000);
  const tz = runTz(run);
  const until = Date.parse(run.departAt) - now;
  const late = until < -60_000;
  // Opened from the step ("check") or because the server refused Start ("start" — a pass starts it).
  const [checking, setChecking] = useState<null | 'check' | 'start'>(null);
  const { pickups } = stopsFor(run);
  const riders = run.rides.filter(riding).length;
  const start = () =>
    void act(`start:${run.id}`, async () => {
      try {
        await startDriverRun(run.id);
        toast.success(t('drive.started'));
      } catch (err) {
        // The server is the gate: should it answer "do the check first", the check opens.
        if (err instanceof ApiError && err.code === 'pretrip_required') {
          setChecking('start');
          return;
        }
        throw err;
      }
    });
  return (
    <>
      <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 pr-14">
        <span className={cn(EYEBROW, late ? 'text-caution-800' : 'text-accent')}>{late ? t('drive.lateBy') : t('drive.leavesInLabel')}</span>
        <span className={cn('text-5xl font-bold tabular-nums leading-none tracking-tight', late ? 'text-caution-800' : 'text-ink')} data-testid="drive-countdown">
          <Countdown ms={until} />
        </span>
      </p>
      <p className="mt-3 text-xl font-semibold text-ink">
        {run.van.name} · {fmtTimeTz(run.departAt, tz)} · {run.direction === 'TO_WORK' ? t('ride.toWork') : t('ride.fromWork')}
      </p>
      <p className="mt-1 text-base text-ink-muted">
        {[...storeNames(run, runs), pickups.length === 1 ? t('drive.stopsOne') : t('drive.stopsCount', { count: pickups.length }), riders === 1 ? t('drive.ridersOne') : t('drive.ridersCount', { count: riders })].join(' · ')}
      </p>
      {run.notes && <p className="mt-2 text-base text-ink">{run.notes}</p>}
      <div className="mt-4 space-y-2">
        {step.kind === 'pretrip' ? (
          <>
            <Button className={BIG} onClick={() => setChecking('check')}>
              <ClipboardCheck className="h-5 w-5" />
              {t('drive.preTripFor', { van: run.van.name })}
            </Button>
            <p className="text-center text-sm text-ink-muted">{t('drive.preTripOnce')}</p>
          </>
        ) : (
          <>
            <Button className={BIG} onClick={start} disabled={isBusy(`start:${run.id}`)}>
              {t('drive.start')}
            </Button>
            {preTripRequired && (
              <p className="flex items-center justify-center gap-1.5 text-sm text-positive-800">
                <Check className="h-4 w-4" aria-hidden="true" />
                {t('drive.preTripDoneToday', { van: run.van.name })}
              </p>
            )}
          </>
        )}
      </div>
      <RouteList run={run} />
      {checking && (
        <PreTripDialog
          run={run}
          startsRun={checking === 'start'}
          onClose={() => setChecking(null)}
          onPassed={() => {
            const then = checking;
            setChecking(null);
            if (then === 'start') start();
          }}
        />
      )}
    </>
  );
}

/** The run's stops in order, then where it ends. */
function RouteList({ run }: { run: RideRun }) {
  const { t } = useI18n();
  const tz = runTz(run);
  const { pickups, drops } = stopsFor(run);
  return (
    <ol className="mt-5 divide-y divide-line-subtle border-t border-line-subtle" aria-label={t('drive.route')}>
      {pickups.map((s, i) => (
        <li key={s.key} className="flex items-center gap-3 py-3">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-surface-raised text-base font-semibold tabular-nums text-ink">{i + 1}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-lg text-ink">{s.label}</span>
            <span className="block truncate text-base text-ink-muted">{s.rides.map((r) => shortName(r.rider.name)).join(', ')}</span>
          </span>
          <span className="shrink-0 text-base tabular-nums text-ink-muted">{s.at ? fmtTimeTz(s.at, tz) : ''}</span>
        </li>
      ))}
      {drops.map((d) => (
        <li key={d.key} className="flex items-center gap-3 py-3">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-surface-raised text-ink">
            {d.kind === 'store' ? <Store className="h-4 w-4" aria-hidden="true" /> : <Home className="h-4 w-4" aria-hidden="true" />}
          </span>
          <span className="min-w-0 flex-1 truncate text-lg text-ink">{t('drive.dropOffAt', { place: d.label })}</span>
        </li>
      ))}
    </ol>
  );
}

/* ----- Driving to a pickup ----------------------------------------------------------- */

function StopHead({ step, tone, extra }: { step: { stop: Stop; n: number; total: number }; tone: 'accent' | 'positive'; extra?: React.ReactNode }) {
  const { t } = useI18n();
  const { stop } = step;
  return (
    <div className="pr-14">
      <p className={cn(EYEBROW, tone === 'positive' ? 'text-positive-800' : 'text-accent')}>
        {t('drive.stopOf', { n: step.n, total: step.total })}
        {extra ? <> · {extra}</> : null}
      </p>
      <p className="mt-1 flex items-start gap-2 text-2xl font-semibold leading-tight text-ink">
        {stop.kind === 'store' ? <Store className="mt-1 h-5 w-5 shrink-0 text-accent" aria-hidden="true" /> : <MapPin className="mt-1 h-5 w-5 shrink-0 text-accent" aria-hidden="true" />}
        <span className="min-w-0">{stop.label}</span>
      </p>
      {stop.address && stop.address !== stop.label && stop.kind === 'home' && <p className="mt-1 text-base text-ink-muted">{stop.address}</p>}
    </div>
  );
}

function ToStopBody({
  run,
  step,
  act,
  isBusy,
  onNavigate,
}: {
  run: RideRun;
  step: Extract<DriveStep, { kind: 'navigate' | 'arrive' }>;
  act: Act;
  isBusy: IsBusy;
  onNavigate: () => void;
}) {
  const { t } = useI18n();
  const { app } = useNavApp();
  const marks = useContext(PendingMarksContext);
  const tz = runTz(run);
  const { stop } = step;
  const waiting = stop.rides.filter((r) => localStatus(r, run.id, marks) === 'SCHEDULED');
  const key = `arrive:${stop.key}`;
  const arrive = () => void act(key, () => tapArrived(run.id, waiting.map((r) => r.id), stop.label));
  const href = navigateTo(app, { point: stopPoint(stop), address: stop.address });
  return (
    <>
      <StopHead step={step} tone="accent" extra={stop.at ? fmtTimeTz(stop.at, tz) : null} />
      <WhoIsHere rides={waiting} />
      <div className="mt-4 space-y-2">
        {step.kind === 'navigate' ? (
          <>
            <Button className={BIG} asChild>
              <a href={href} target="_blank" rel="noreferrer" onClick={onNavigate}>
                <Navigation className="h-5 w-5" />
                {t('drive.navigateToStop', { n: step.n })}
              </a>
            </Button>
            <Button variant="ghost" className="h-12 w-full text-base" onClick={arrive} disabled={isBusy(key)}>
              <MapPin className="h-4 w-4" />
              {t('drive.alreadyHere')}
            </Button>
          </>
        ) : (
          <>
            <Button className={BIG} onClick={arrive} disabled={isBusy(key)}>
              <MapPin className="h-5 w-5" />
              <span className="truncate">{t('drive.arrivedAtStop', { stop: stop.label })}</span>
            </Button>
            <Button variant="ghost" className="h-12 w-full text-base" asChild>
              <a href={href} target="_blank" rel="noreferrer">
                <Navigation className="h-4 w-4" />
                {t('drive.directionsAgain')}
              </a>
            </Button>
          </>
        )}
        <p className="text-center text-sm text-ink-muted">{t('drive.arrivedHint')}</p>
      </div>
    </>
  );
}

/** Who's waiting at the stop, and what they told the driver ("Outside", "Running late"). */
function WhoIsHere({ rides }: { rides: Ride[] }) {
  const { t } = useI18n();
  if (rides.length === 0) return null;
  return (
    <ul className="mt-3 flex flex-wrap gap-2" aria-label={t('drive.waitingHere')}>
      {rides.map((r) => (
        <li key={r.id} className="inline-flex items-center gap-2 rounded-full border border-line px-3 py-1.5 text-base text-ink">
          {shortName(r.rider.name)}
          {r.riderSignal && (
            <Badge size="lg" className="text-sm" variant={r.riderSignal.kind === 'OUTSIDE' ? 'success' : 'pending'}>
              {t(`drive.signal.${r.riderSignal.kind}` as MessageKey)}
            </Badge>
          )}
        </li>
      ))}
    </ul>
  );
}

/* ----- At the kerb: the manifest -------------------------------------------------------- */

function BoardBody({
  run,
  step,
  act,
  isBusy,
  onRider,
}: {
  run: RideRun;
  step: Extract<DriveStep, { kind: 'board' }>;
  act: Act;
  isBusy: IsBusy;
  onRider: (associateId: string) => void;
}) {
  const { t } = useI18n();
  const marks = useContext(PendingMarksContext);
  const tz = runTz(run);
  const { stop } = step;
  const waiting = stop.rides.filter((r) => localStatus(r, run.id, marks) === 'SCHEDULED');
  // The no-show clock runs from the SERVER's arrival — never from a tap
  // still waiting to send — so a rider always gets their full wait. The wait
  // itself is the server's (apps/api lib/transport NO_SHOW_WAIT_MINUTES, 3);
  // NO_SHOW_WAIT_MS mirrors it, and the server refuses an early no-show anyway.
  const sentAt = stop.rides.map((r) => r.vanArrivedAt).find(Boolean) ?? null;
  const openAt = sentAt ? Date.parse(sentAt) + NO_SHOW_WAIT_MS : null;
  const now = useTick(1_000, openAt !== null && Date.now() < openAt + 1_000);
  const boardAllKey = `boardAll:${stop.key}`;
  return (
    <>
      <StopHead step={step} tone="positive" extra={step.arrivedSent ? t('drive.arrivedAt', { time: fmtTimeTz(step.arrivedAt, tz) }) : t('drive.arrivedSending')} />
      <NoShowClock openAt={openAt} now={now} />
      <div className="mt-4">
        <Button className={BIG} onClick={() => void act(boardAllKey, () => tapBoardAll(run.id, waiting.map((r) => r.id), stop.label))} disabled={isBusy(boardAllKey) || waiting.length === 0}>
          <CheckCheck className="h-5 w-5" />
          {waiting.length === 1 ? t('drive.allOnBoardOne', { name: shortName(waiting[0]!.rider.name) }) : t('drive.allOnBoardN', { count: waiting.length })}
        </Button>
      </div>
      <ul className="mt-3 divide-y divide-line-subtle border-t border-line-subtle" aria-label={t('drive.manifest')}>
        {stop.rides.map((r) => (
          <RiderRow key={r.id} ride={r} runId={run.id} openAt={openAt} now={now} act={act} isBusy={isBusy} onRider={onRider} />
        ))}
      </ul>
    </>
  );
}

/** "No-show opens in 2:41" — the wait, counting down where the driver can see it. */
function NoShowClock({ openAt, now }: { openAt: number | null; now: number }) {
  const { t } = useI18n();
  if (openAt === null) return <p className="mt-2 text-base text-ink-muted">{t('drive.noShowAfterSend')}</p>;
  const left = openAt - now;
  return (
    <p className="mt-2 flex items-center gap-2 text-base text-ink-muted" role="timer" aria-live="off">
      <Clock className="h-4 w-4 shrink-0" aria-hidden="true" />
      {left > 0 ? (
        <span>
          {t('drive.noShowOpensIn')} <span className="font-semibold tabular-nums text-ink">{fmtClock(left)}</span>
        </span>
      ) : (
        t('drive.noShowOpen')
      )}
    </p>
  );
}

function RiderRow({
  ride,
  runId,
  openAt,
  now,
  act,
  isBusy,
  onRider,
}: {
  ride: Ride;
  runId: string;
  openAt: number | null;
  now: number;
  act: Act;
  isBusy: IsBusy;
  onRider: (associateId: string) => void;
}) {
  const { t } = useI18n();
  const confirm = useConfirm();
  const marks = useContext(PendingMarksContext);
  const pending = pendingFor(ride.id, runId, marks);
  const key = `ride:${ride.id}`;
  const name = shortName(ride.rider.name);
  const first = ride.rider.name.split(' ')[0] ?? ride.rider.name;
  // Marked, or a mark on its way (floor walk 5: the row says so at once).
  if ((ride.status !== 'SCHEDULED' && pending !== 'undo') || pending === 'board' || pending === 'no-show') return <MarkedRow ride={ride} runId={runId} act={act} isBusy={isBusy} />;
  const canNoShow = openAt !== null && now >= openAt;
  const noShow = async () => {
    const ok = await confirm({
      title: t('drive.noShowConfirm', { name: ride.rider.name }),
      description: t('drive.noShowBody', { fee: fmtMoney(ride.noShowFeeCents / 100) }),
      confirmLabel: t('drive.noShow'),
      destructive: true,
    });
    if (ok) await act(key, () => tapNoShow(ride));
  };
  // Floor walk 18: "I'm here", in the rider's language, one tap.
  const textHere = () =>
    void act(`text:${ride.id}`, async () => {
      const r = await textRiderHere(ride.id);
      if (r.sent) toast.success(t('drive.textSent', { name: first }));
      else if (r.reason === 'no_phone') toast.error(t('drive.textNoPhone', { name: first }));
      else if (r.smsHref) {
        toast.info(t('drive.textNotConnected'));
        window.location.href = r.smsHref;
      } else toast.error(t('drive.textFailed'));
    });
  return (
    <li className="py-3" data-testid="manifest-row">
      <div className="flex min-h-12 items-center gap-3">
        <button
          type="button"
          onClick={() => onRider(ride.rider.associateId)}
          aria-label={`${t('drive.riderProfile')}: ${ride.rider.name}`}
          className="grid h-11 w-11 shrink-0 place-items-center rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
        >
          <Avatar src={`/api/associates/${ride.rider.associateId}/photo`} name={ride.rider.name} email="" size="md" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-lg font-semibold text-ink">{name}</span>
            {ride.riderSignal && (
              <Badge size="lg" className="text-sm" variant={ride.riderSignal.kind === 'OUTSIDE' ? 'success' : 'pending'}>{t(`drive.signal.${ride.riderSignal.kind}` as MessageKey)}</Badge>
            )}
            {ride.signatureNeeded && (
              <Badge size="lg" className="text-sm" variant="pending" title={ride.signatureNeeded}>
                {t('drive.notSigned')}
              </Badge>
            )}
          </div>
          {ride.direction === 'FROM_WORK' && <p className="truncate text-base text-ink-muted">{t('drive.dropAt', { place: ride.pickup.kind === 'stop' ? ride.pickup.name : ride.pickup.address })}</p>}
          {ride.note && <p className="text-base text-accent">{ride.note}</p>}
        </div>
        {ride.rider.phone && (
          <span className="flex shrink-0 items-center">
            <Button size="icon" variant="ghost" onClick={textHere} disabled={isBusy(`text:${ride.id}`)} aria-label={`${t('drive.textHere')}: ${ride.rider.name}`}>
              <MessageSquare className="h-5 w-5" />
            </Button>
            <Button size="icon" variant="ghost" asChild>
              <a href={`tel:${ride.rider.phone}`} aria-label={`${t('drive.call')} ${ride.rider.name}`}>
                <Phone className="h-5 w-5" />
              </a>
            </Button>
          </span>
        )}
      </div>
      {/* The two marks that put money on or off a rider's account: a thumb's width each, never 8px apart. */}
      <div className="mt-2 grid grid-cols-2 gap-3">
        <Button variant="secondary" className="h-14 text-base font-semibold" onClick={() => void act(key, () => tapBoard(ride))} disabled={isBusy(key)} aria-label={`${t('drive.onBoard')}: ${ride.rider.name}`}>
          <Check className="h-5 w-5 text-positive-700" />
          {t('drive.onBoard')}
        </Button>
        <Button variant="secondary" className="h-14 text-base font-semibold" onClick={() => void noShow()} disabled={isBusy(key) || !canNoShow} aria-label={`${t('drive.noShow')}: ${ride.rider.name}`}>
          {canNoShow ? <UserX className="h-5 w-5" /> : <Clock className="h-5 w-5" />}
          {openAt !== null && !canNoShow ? t('drive.noShowIn', { time: fmtClock(openAt - now) }) : t('drive.noShow')}
        </Button>
      </div>
    </li>
  );
}

function MarkedRow({ ride, runId, act, isBusy }: { ride: Ride; runId: string; act: Act; isBusy: IsBusy }) {
  const { t } = useI18n();
  const marks = useContext(PendingMarksContext);
  const pending = pendingFor(ride.id, runId, marks);
  const sending = pending === 'board' || pending === 'no-show';
  const noShow = sending ? pending === 'no-show' : ride.status === 'NO_SHOW';
  const label = sending ? (noShow ? t('drive.noShowSending') : t('drive.onBoardSending')) : noShow ? t('drive.noShow') : t('drive.onBoard');
  return (
    <li className="flex min-h-14 items-center gap-3 py-2">
      {noShow ? <UserX className="h-5 w-5 shrink-0 text-negative-700" aria-hidden="true" /> : <Check className="h-5 w-5 shrink-0 text-positive-700" aria-hidden="true" />}
      <span className="min-w-0 flex-1 truncate text-lg text-ink">{shortName(ride.rider.name)}</span>
      <Badge size="lg" className="text-sm" variant={noShow ? 'destructive' : 'success'}>
        {label}
      </Badge>
      {/* The safety net under a mis-tapped On board / No-show — once the mark has landed. */}
      {!sending && (ride.status === 'BOARDED' || ride.status === 'NO_SHOW') && (
        <Button variant="ghost" className="h-11 text-base" onClick={() => void act(`ride:${ride.id}`, () => tapUndo(ride))} disabled={pending === 'undo' || isBusy(`ride:${ride.id}`)}>
          <RotateCcw className="h-4 w-4" />
          {pending === 'undo' ? t('drive.undoSending') : t('drive.undo')}
        </Button>
      )}
    </li>
  );
}

/* ----- After the pickups ------------------------------------------------------------------- */

function FinishBody({
  run,
  step,
  act,
  isBusy,
  onNavigate,
}: {
  run: RideRun;
  step: Extract<DriveStep, { kind: 'drop' | 'complete' }>;
  act: Act;
  isBusy: IsBusy;
  onNavigate: (stop: Stop) => void;
}) {
  const { t } = useI18n();
  const { app } = useNavApp();
  const marks = useContext(PendingMarksContext);
  const aboard = aboardCount(run, marks);
  const completeKey = `complete:${run.id}`;
  const complete = (
    <HoldButton
      variant={step.kind === 'complete' ? 'primary' : 'secondary'}
      holding={t('drive.keepHolding')}
      hint={t('drive.holdHint')}
      confirm={{ title: t('drive.completeConfirm'), description: t('drive.completeConfirmBody'), confirmLabel: t('drive.completeRun') }}
      onConfirm={() => void act(completeKey, () => tapComplete(run.id, run.van.name), t('drive.finished'))}
      disabled={isBusy(completeKey)}
    >
      {t('drive.holdToComplete')}
    </HoldButton>
  );
  return (
    <>
      <p className={cn(EYEBROW, 'pr-14 text-positive-800')}>
        {t('drive.pickupsDone')}
        {aboard > 0 ? <> · {aboard === 1 ? t('drive.aboardOne') : t('drive.aboardN', { count: aboard })}</> : null}
      </p>
      {step.kind === 'drop' ? (
        <>
          <p className="mt-1 flex items-start gap-2 pr-14 text-2xl font-semibold leading-tight text-ink">
            <Flag className="mt-1 h-5 w-5 shrink-0 text-accent" aria-hidden="true" />
            <span className="min-w-0">
              {step.total > 1 ? t('drive.dropOfN', { n: step.n, total: step.total, place: step.stop.label }) : t('drive.dropOffAt', { place: step.stop.label })}
            </span>
          </p>
          {step.stop.kind === 'home' && (
            <p className="mt-1 text-base text-ink-muted">
              {step.stop.rides
                .filter((r) => localStatus(r, run.id, marks) === 'BOARDED')
                .map((r) => shortName(r.rider.name))
                .join(', ')}
            </p>
          )}
          <div className="mt-4 space-y-3">
            <Button className={BIG} asChild>
              <a href={navigateTo(app, { point: stopPoint(step.stop), address: step.stop.address })} target="_blank" rel="noreferrer" onClick={() => onNavigate(step.stop)}>
                <Navigation className="h-5 w-5" />
                {t('drive.navigateToDrop')}
              </a>
            </Button>
            {complete}
          </div>
        </>
      ) : (
        <>
          <p className="mt-1 pr-14 text-2xl font-semibold leading-tight text-ink">{aboard > 0 ? t('drive.allDropped') : t('drive.nobodyAboard')}</p>
          <div className="mt-4">{complete}</div>
        </>
      )}
    </>
  );
}

/* ----- Around the step ---------------------------------------------------------------------- */

/** The stops after this one — where the van goes next, with directions a tap away. */
function ThenStops({ run, step }: { run: RideRun; step: Extract<DriveStep, { stop: Stop }> }) {
  const { t } = useI18n();
  const { app } = useNavApp();
  const tz = runTz(run);
  const { pickups, drops } = stopsFor(run);
  const later = pickups.slice(step.n);
  if (later.length === 0 && drops.length === 0) return null;
  return (
    <div className="mt-4">
      <p className="text-sm font-semibold uppercase tracking-[0.12em] text-ink-muted">{t('drive.then')}</p>
      <ol className="mt-1 divide-y divide-line-subtle" aria-label={t('drive.laterStops')}>
        {later.map((s, i) => (
          <li key={s.key} className="flex min-h-14 items-center gap-3 py-2">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-surface-raised text-base font-semibold tabular-nums text-ink">{step.n + i + 1}</span>
            <span className="min-w-0 flex-1">
              <span className="block text-lg leading-snug text-ink">{s.label}</span>
              <span className="block text-base text-ink-muted">
                {s.at ? <span className="tabular-nums">{fmtTimeTz(s.at, tz)} · </span> : null}
                {s.rides.map((r) => shortName(r.rider.name)).join(', ')}
              </span>
              {s.address && s.address !== s.label && <span className="block truncate text-base text-ink-muted">{s.address}</span>}
            </span>
            <Button size="icon" variant="ghost" asChild>
              <a href={navigateTo(app, { point: stopPoint(s), address: s.address })} target="_blank" rel="noreferrer" aria-label={`${t('drive.navigate')}: ${s.label}`}>
                <Navigation className="h-5 w-5" />
              </a>
            </Button>
          </li>
        ))}
        {drops.map((d) => (
          <li key={d.key} className="flex min-h-14 items-center gap-3 py-2">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-surface-raised text-ink">
              {d.kind === 'store' ? <Store className="h-4 w-4" aria-hidden="true" /> : <Home className="h-4 w-4" aria-hidden="true" />}
            </span>
            <span className="min-w-0 flex-1 truncate text-lg text-ink">{t('drive.dropOffAt', { place: d.label })}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Riders already marked at earlier stops — folded away, each with Undo for a mis-tap. */
function PickedUp({ run, current, act, isBusy }: { run: RideRun; current: Stop | null; act: Act; isBusy: IsBusy }) {
  const { t } = useI18n();
  const marks = useContext(PendingMarksContext);
  const here = new Set(current?.rides.map((r) => r.id) ?? []);
  // Marked here or on their way: a tap still sending shows as marked.
  const marked = run.rides.filter((r) => riding(r) && !here.has(r.id) && r.status !== 'REQUESTED' && localStatus(r, run.id, marks) !== 'SCHEDULED');
  if (marked.length === 0) return null;
  const onBoard = marked.filter((r) => localStatus(r, run.id, marks) === 'BOARDED' || r.status === 'COMPLETED').length;
  const missed = marked.filter((r) => localStatus(r, run.id, marks) === 'NO_SHOW').length;
  return (
    <details className="mt-4 rounded-lg border border-line-subtle px-3 [&_summary::-webkit-details-marker]:hidden">
      <summary className="flex min-h-12 cursor-pointer items-center gap-2 text-base text-ink">
        <Check className="h-4 w-4 shrink-0 text-positive-700" aria-hidden="true" />
        {t('drive.pickedUpSummary', { boarded: onBoard, missed })}
      </summary>
      <ul className="divide-y divide-line-subtle pb-1">
        {marked.map((r) => (
          <MarkedRow key={r.id} ride={r} runId={run.id} act={act} isBusy={isBusy} />
        ))}
      </ul>
    </details>
  );
}

/** "Overlaps your 2:10 PM run on Van 1 — call dispatch": calm, specific, with the call one tap away. */
function Conflicts({ run, runs, dispatchPhone }: { run: RideRun; runs: RideRun[]; dispatchPhone: string | null }) {
  const { t } = useI18n();
  const lines = conflictsOf(run, runs);
  if (lines.length === 0) return null;
  return (
    <div className="mt-4 space-y-2" data-testid="drive-conflicts">
      {lines.map((c, i) => (
        <ErrorBanner
          key={i}
          severity="warning"
          className="text-base"
          action={
            dispatchPhone ? (
              <Button size="sm" variant="secondary" className="coarse:text-sm" asChild>
                <a href={`tel:${dispatchPhone}`}>
                  <PhoneCall className="h-4 w-4" />
                  {t('drive.callDispatch')}
                </a>
              </Button>
            ) : undefined
          }
        >
          {c.kind === 'driver'
            ? c.other
              ? t('drive.overlapRun', { time: fmtTimeTz(c.other.departAt, runTz(c.other)), van: c.other.van.name })
              : t('drive.overlapOther', { minutes: c.overlapMinutes })
            : t('drive.overlapVan', { van: run.van.name })}
        </ErrorBanner>
      ))}
    </div>
  );
}
