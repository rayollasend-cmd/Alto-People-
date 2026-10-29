import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, Camera, Check, Fuel, Home, MapPin, Phone, ShieldAlert, Store, Volume2, VolumeX } from '@/components/ui/icons';
import { toast } from 'sonner';
import { ShiftMapDrawer, type TripKey } from './ShiftMap';
import { ApiError } from '@/lib/api';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { cn } from '@/lib/cn';
import { hapticConfirm } from '@/lib/haptics';
import { onLiveEvent } from '@/lib/liveEvents';
import { fmtMonthShortYear, fmtRelativeDayTz, fmtTimeTz } from '@/lib/format';
import {
  acceptSeat,
  declineSeat,
  getRiderProfile,
  getSeatRequests,
  getDriverClients,
  requestDriverClients,
  dropDriverClient,
  type DriverAccessStatus,
  getDriverToday,
  getDriverRuns,
  logFuel,
  reportTransportIssue,
  uploadTransportPhoto,
  type RideRun,
  type SeatRequest,
  type TransportIssueCategory,
} from '@/lib/transportApi';
import { rideAlert, useNewKeys } from '@/lib/rideAlerts';
import { currentDriverFix } from '@/lib/driverPosition';
import { Input } from '@/components/ui/Input';
import { usePrompt } from '@/lib/confirm';
import { useRideSounds } from '@/lib/rideAlerts';
import { HomeTemplate } from '@/components/templates';
import { HugoSeat } from '@/components/home/HugoSeat';
import { LiveNow } from '@/components/ui/LiveNow';
import { useAuth } from '@/lib/auth';
import { useGreeting, greetingName } from '@/lib/greeting';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { QueryError } from '@/components/ui/QueryError';
import { Textarea } from '@/components/ui/Input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { CredentialBanner, IncidentDialog, SafetyDialog } from './DriverTools';
import { DriveNow } from './driver/DriveNow';
import { DriveHeader } from './driver/DriveHeader';
import { DayDone, LaterToday, RunSheet } from './driver/LaterToday';
import { WeekStrip } from './driver/WeekStrip';
import { PendingMarksContext, PendingPill, SafetyContext, ShiftMapContext, usePendingMarks, useTick } from './driver/driveKit';
import { planDay } from './driver/driveModel';
import '@/lib/i18n/en/drive';
import '@/lib/i18n/en/ride';

export { stopsFor, type Stop } from './driver/driveModel';
export { useShareVanLocation } from './driver/vanLocation';

/**
 * The driver's home — drive mode, the Uber driver moment:
 *
 *   NOW         the run on the road, else the next one today: the map edge
 *               to edge, the countdown in big type, and ONE gold button
 *               that steps through the run (driver/DriveNow)
 *   the header  the day's one count ("Today: 2 of 4 runs done · 15
 *               riders"), the pay pill (it ticks on the clock and opens
 *               the pay sheet) and the time clock — quiet beside the run
 *   below       seat requests when there are any, Later today, the runs
 *               that never ran as one line of history, this week, the
 *               clients they drive for
 *
 * Safety and Report a problem are one tap away on the run and in the
 * header's list; taps with no signal wait in the offline queue, and the
 * banner says how many.
 */

const DRIVER_ISSUES: TransportIssueCategory[] = ['VEHICLE', 'SAFETY', 'CONDUCT', 'LATE_VAN', 'OTHER'];

/* ----- The page ---------------------------------------------------------------- */

export function DriverHome() {
  const { t } = useI18n();
  const greet = useGreeting();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const runs = useQuery({ queryKey: ['transport', 'driver'], queryFn: getDriverRuns, refetchInterval: 30_000 });
  // A rider's "I'm outside" lands now, not on the next poll.
  useEffect(
    () => onLiveEvent('transport', () => void queryClient.invalidateQueries({ queryKey: ['transport', 'driver'] })),
    [queryClient],
  );
  const [reporting, setReporting] = useState<string | null | undefined>(undefined);
  const [rider, setRider] = useState<string | null>(null);
  const [shiftMap, setShiftMap] = useState<TripKey | null>(null);
  const [openRun, setOpenRun] = useState<RideRun | null>(null);
  // The safety sheet (undefined: closed; null: open without a run) and the
  // incident report it can hand on to.
  const [safetyRun, setSafetyRun] = useState<RideRun | null | undefined>(undefined);
  const [soundsOn, setSoundsOn] = useRideSounds();
  const [incidentRun, setIncidentRun] = useState<RideRun | null | undefined>(undefined);
  const [fueling, setFueling] = useState(false);
  const marks = usePendingMarks();
  // The assistant's "Report a van issue" lands here (/?report=van): the report, van switch on.
  const [params, setParams] = useSearchParams();
  const vanReport = params.get('report') === 'van';
  const all = runs.data?.runs ?? [];
  // A rider's "I'm outside" / "running late", and a run the desk put on
  // them: buzz, chime.
  useNewKeys(
    runs.data
      ? [
          ...all.flatMap((r) => r.rides.filter((x) => x.riderSignal).map((x) => `signal:${x.id}:${x.riderSignal!.at}`)),
          ...all.map((r) => `run:${r.id}`),
        ]
      : null,
    (fresh) => rideAlert(fresh.some((k) => k.startsWith('signal:')) ? 'signal' : 'confirmed'),
  );
  // The day, from the runs list alone: NOW, later, finished, didn't run, and the counts.
  const now = useTick(30_000);
  const plan = runs.data ? planDay(all, runs.data.today, now, runs.data.counts) : null;
  const current = plan?.now ?? null;
  // The setup state, as ONE banner: the desk assigns the van; the driver asks
  // for clients. The read is the seat-request read (same key, one request).
  const setup = useQuery({ queryKey: ['transport', 'driver', 'requests'], queryFn: getSeatRequests, refetchInterval: 30_000 });
  const noVan = !!setup.data && !setup.data.van;
  const clientsSummary = setup.data?.clients;
  const noClients = !!clientsSummary && !clientsSummary.all && clientsSummary.approved === 0;
  const setupBanner =
    noVan && noClients ? t('drive.notSetUp') : noVan ? t('drive.noVan') : noClients ? t('drive.noClients') : null;
  const requestCount = setup.data?.requests?.length ?? 0;
  // The pre-trip rule, the dispatch line and the driver's papers ride on /driver/today.
  const todayQ = useQuery({ queryKey: ['transport', 'driver', 'today'], queryFn: getDriverToday, refetchInterval: 60_000 });
  const preTripRequired = todayQ.data?.preTripRequired === true;
  const dispatchPhone = todayQ.data?.dispatchPhone ?? null;
  // Transport walk 9: fuel goes on the van being driven, else theirs.
  const fuelVan = current?.van ?? setup.data?.van ?? null;
  useEffect(() => {
    if (vanReport && reporting === undefined) setReporting(current?.id ?? null);
    // Once, when the link opens the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vanReport]);

  const hero = runs.isLoading ? (
    <div className="space-y-3">
      <Skeleton className="-mx-4 h-56 md:mx-0" />
      <Skeleton className="h-48" />
    </div>
  ) : runs.isError ? (
    <QueryError what={t('drive.load.runs')} query={runs} />
  ) : current ? (
    <DriveNow
      key={current.id}
      run={current}
      runs={all}
      preTripRequired={preTripRequired}
      dispatchPhone={dispatchPhone}
      onReport={() => setReporting(current.id)}
      onRider={setRider}
      more={
        <>
          {fuelVan && (
            <Button variant="ghost" className="h-11 text-base" onClick={() => setFueling(true)}>
              <Fuel className="h-4 w-4" />
              {t('drive.logFuel')}
            </Button>
          )}
          <Button variant="ghost" className="h-11 text-base" onClick={() => setSoundsOn(!soundsOn)} title={soundsOn ? t('ride.soundsOn') : t('ride.soundsOff')}>
            {soundsOn ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
            {soundsOn ? t('drive.soundsOnShort') : t('drive.soundsOffShort')}
          </Button>
        </>
      }
    />
  ) : plan ? (
    <DayDone plan={plan} />
  ) : null;

  return (
    <SafetyContext.Provider value={{ open: (run) => setSafetyRun(run) }}>
    <PendingMarksContext.Provider value={marks}>
    <ShiftMapContext.Provider value={setShiftMap}>
      <HomeTemplate
        // Drive mode on a phone: the greeting on one line, so NOW's button is in view.
        className="mx-auto max-w-2xl max-sm:[&_h1]:text-2xl"
        title={
          <>
            <LiveNow render={(n) => greet(n.getHours())} />
            {greetingName(user, '') ? (
              <>
                , <span className="text-accent">{greetingName(user, '')}</span>
              </>
            ) : null}
            .
          </>
        }
        topbarTitle={t('drive.title')}
        meta={<DriveHeader counts={plan?.counts ?? null} />}
        // The header's actions as one list, none of them gold — the run's
        // button is the one. On a phone they open from "More"; Safety and
        // Report a problem are on the run itself too.
        // With a run NOW they ride at the foot of its sheet instead (the
        // header's "More" cost the phone a row above the run's button).
        actions={
          current
            ? undefined
            : [
                { key: 'safety', label: t('drive.safety'), icon: ShieldAlert, onSelect: () => setSafetyRun(null) },
                { key: 'report', label: t('ride.report'), icon: AlertTriangle, onSelect: () => setReporting(null) },
                { key: 'fuel', label: t('drive.logFuel'), icon: Fuel, onSelect: () => setFueling(true), hidden: !fuelVan },
                { key: 'sounds', label: soundsOn ? t('drive.soundsOnShort') : t('drive.soundsOffShort'), icon: soundsOn ? Volume2 : VolumeX, onSelect: () => setSoundsOn(!soundsOn), hint: soundsOn ? t('ride.soundsOn') : t('ride.soundsOff') },
              ]
        }
        banners={
          setupBanner || (marks.length > 0 && !current) || todayQ.data?.credentials ? (
            <div className="space-y-2 empty:hidden">
              {/* With a run NOW the taps' line sits on its sheet, by the button they came from. */}
              {!current && <PendingPill marks={marks} />}
              <CredentialBanner credentials={todayQ.data?.credentials} />
              {setupBanner && (
                <p role="status" className="rounded-lg border border-caution-300 bg-caution-50 px-4 py-2.5 text-base text-caution-800">
                  {setupBanner}
                </p>
              )}
            </div>
          ) : undefined
        }
        hero={hero}
        decisions={requestCount > 0 ? { title: t('drive.requests'), count: requestCount, content: <SeatRequests onRider={setRider} /> } : undefined}
        // Floor walk 19: the driver's own starters — their runs, never a rider's ride.
        assistant={<HugoSeat prompts={[t('drive.hugoNextRun'), t('drive.hugoRiders'), t('drive.hugoVanIssue')]} />}
      >
        {plan && <LaterToday plan={plan} runs={all} onOpen={setOpenRun} />}
        <WeekStrip onRider={setRider} />
        <DriverClients />
      </HomeTemplate>
      {reporting !== undefined && (
        <DriverReportDialog
          runId={reporting}
          open
          vanOffFirst={vanReport}
          onOpenChange={(o) => {
            if (o) return;
            setReporting(undefined);
            if (vanReport) {
              const next = new URLSearchParams(params);
              next.delete('report');
              setParams(next, { replace: true });
            }
          }}
        />
      )}
      {rider && <RiderDialog associateId={rider} onClose={() => setRider(null)} />}
      {openRun && <RunSheet run={all.find((r) => r.id === openRun.id) ?? openRun} runs={all} dispatchPhone={dispatchPhone} onClose={() => setOpenRun(null)} />}
      <ShiftMapDrawer trip={shiftMap} open={!!shiftMap} onClose={() => setShiftMap(null)} />
      {safetyRun !== undefined && (
        <SafetyDialog
          run={safetyRun ? (all.find((r) => r.id === safetyRun.id) ?? safetyRun) : null}
          onClose={() => setSafetyRun(undefined)}
          onIncident={() => {
            setIncidentRun(safetyRun ?? null);
            setSafetyRun(undefined);
          }}
        />
      )}
      {incidentRun !== undefined && <IncidentDialog run={incidentRun} onClose={() => setIncidentRun(undefined)} />}
      {fueling && fuelVan && <FuelDialog van={fuelVan} onClose={() => setFueling(false)} />}
    </ShiftMapContext.Provider>
    </PendingMarksContext.Provider>
    </SafetyContext.Provider>
  );
}

/* ----- Seat requests: accept or decline, ride-share style -------------------- */

function SeatRequests({ onRider }: { onRider: (associateId: string) => void }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const prompt = usePrompt();
  const q = useQuery({ queryKey: ['transport', 'driver', 'requests'], queryFn: getSeatRequests, refetchInterval: 30_000 });
  const [busy, setBusy] = useState<string | null>(null);
  const requests = q.data?.requests ?? [];
  // Accepting needs a van (it shows in the Today card's header now).
  const van = q.data?.van ?? null;
  // A new seat request: buzz, chime — the ride-share "ding".
  useNewKeys(q.data ? requests.map((r) => `req:${r.id}`) : null, () => rideAlert('request'));
  if (q.isError) return <QueryError what={t('drive.load.seatRequests')} query={q} />;
  if (q.isPending) return <Skeleton className="h-20 w-full rounded-lg" />;
  if (!q.data) return null;

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['transport', 'driver'] });
  const accept = async (r: SeatRequest) => {
    setBusy(r.id);
    try {
      await acceptSeat(r.id);
      hapticConfirm();
      toast.success(t('drive.accepted', { name: r.rider.name.split(' ')[0] ?? r.rider.name }));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(null);
      await refresh();
    }
  };
  const decline = async (r: SeatRequest) => {
    const reason = await prompt({
      title: t('drive.declineTitle', { name: r.rider.name.split(' ')[0] ?? r.rider.name }),
      description: t('drive.declineBody'),
      reasonLabel: t('drive.declineReason'),
      required: false,
      confirmLabel: t('drive.decline'),
    });
    if (reason === null) return;
    setBusy(r.id);
    try {
      await declineSeat(r.id, reason || undefined);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(null);
      await refresh();
    }
  };

  return (
    <div className="space-y-3">
      {requests.length === 0 ? (
        <p className="text-sm text-silver">{t('drive.requestsNone')}</p>
      ) : (
        <ul className="space-y-2">
          {requests.map((r) => {
            const tz = r.store.timezone;
            return (
              <li key={r.id} className="rounded-lg border border-gold/40 bg-gold/[0.05] p-3.5 animate-enter">
                <div className="flex items-start gap-3">
                  {/* A portrait used as a button still has to be a 44px
                      button: Avatar `md` is a 40px near-miss. The BOX grows
                      on touch, not the picture — place-items-center keeps
                      the 40px headshot where it was. */}
                  <button
                    type="button"
                    onClick={() => onRider(r.rider.associateId)}
                    aria-label={`${t('drive.riderProfile')}: ${r.rider.name}`}
                    className="grid shrink-0 place-items-center rounded-full coarse:h-11 coarse:w-11"
                  >
                    <Avatar src={`/api/associates/${r.rider.associateId}/photo`} name={r.rider.name} email="" size="md" />
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <button type="button" onClick={() => onRider(r.rider.associateId)} className="truncate text-left font-semibold text-white hover:underline">
                        {r.rider.name}
                      </button>
                      <span className="shrink-0 text-sm font-semibold tabular-nums text-gold">{fmtRelativeDayTz(r.targetAt, tz)}</span>
                    </div>
                    <div className="text-sm text-white tabular-nums">
                      {r.windowLabel && <span className="font-semibold text-gold">{t('ride.shiftTag', { shift: r.windowLabel })} · </span>}
                      {r.direction === 'TO_WORK'
                        ? t('drive.arriveBy', { store: r.store.name, time: fmtTimeTz(r.targetAt, tz) })
                        : t('drive.leaveStore', { store: r.store.name, time: fmtTimeTz(r.targetAt, tz) })}
                    </div>
                    {r.waitlist && (
                      <span className="mt-1 inline-flex items-center rounded-full bg-warning/15 px-2 py-0.5 text-2xs font-semibold text-warning">
                        {t('drive.inLine', { position: r.waitlist.position, shift: r.windowLabel ?? '' })}
                      </span>
                    )}
                    {r.shortNotice && (
                      <span className="mt-1 inline-flex items-center rounded-full bg-gold/15 px-2 py-0.5 text-2xs font-semibold text-gold">
                        {t('drive.shortNotice')}
                      </span>
                    )}
                    <div className="mt-0.5 flex items-center gap-1 text-xs text-silver">
                      {r.direction === 'TO_WORK' ? <MapPin className="h-3 w-3 shrink-0" aria-hidden="true" /> : <Home className="h-3 w-3 shrink-0" aria-hidden="true" />}
                      <span className="truncate">{r.pickup.kind === 'stop' ? r.pickup.name : r.pickup.address}</span>
                    </div>
                    {r.note && <div className="text-xs text-gold">{r.note}</div>}
                    {r.fits && (
                      <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-2xs font-semibold text-success">
                        <Check className="h-3 w-3" aria-hidden="true" />
                        {t('drive.fits', { time: fmtTimeTz(r.fits.departAt, tz) })}
                      </span>
                    )}
                  </div>
                </div>
                {/* Decline and Accept are the same size, side by side, and
                    only one of them is recoverable from this screen — the
                    declined rider goes back in the pool. 8px between them is
                    a fat-finger miss; on touch they get a real gutter. */}
                <div className="mt-3 grid grid-cols-2 gap-2 coarse:gap-3">
                  <Button variant="secondary" onClick={() => void decline(r)} disabled={busy === r.id}>
                    {t('drive.decline')}
                  </Button>
                  <Button onClick={() => void accept(r)} loading={busy === r.id} disabled={busy === r.id || !van}>
                    <Check className="h-4 w-4" />
                    {t('drive.accept')}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** A rider's profile — who they are, how to reach them, how they ride. */
/* ----- Clients I drive for ---------------------------------------------------- */

/**
 * Which clients this driver picks up for. They ask — all clients, or the
 * ones they want — transportation approves or denies, and seat requests
 * from approved clients are the only ones they see. A new driver drives
 * for nobody, so this sits right under the (empty) requests.
 */
function DriverClients() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ['transport', 'driver', 'clients'], queryFn: getDriverClients, refetchInterval: 60_000 });
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  if (q.isError) return <QueryError what={t('drive.load.clients')} query={q} />;
  if (q.isPending) return <Skeleton className="h-20 w-full rounded-lg" />;
  if (!q.data) return null;
  // Tolerate a thin answer (an older API, a generic test mock): no clients is a quiet card.
  const d = { ...q.data, clients: q.data.clients ?? [] };
  const allApproved = d.all?.status === 'APPROVED';
  const approved = allApproved ? [t('drive.allClients')] : d.clients.filter((c) => c.access?.status === 'APPROVED').map((c) => c.name);
  const waiting = [
    ...(d.all?.status === 'REQUESTED' ? [t('drive.allClients')] : []),
    ...d.clients.filter((c) => c.access?.status === 'REQUESTED').map((c) => c.name),
  ];
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['transport', 'driver'] });
  const send = async () => {
    setBusy('send');
    try {
      await requestDriverClients({ ...(all ? { all: true } : { clientIds: picked }), ...(note.trim() ? { note: note.trim() } : {}) });
      hapticConfirm();
      toast.success(t('drive.clientsAsked'));
      setOpen(false);
      setAll(false);
      setPicked([]);
      setNote('');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(null);
      await refresh();
    }
  };
  const drop = async (key: string) => {
    setBusy(key);
    try {
      await dropDriverClient(key);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(null);
      await refresh();
    }
  };
  const box =
    'h-4 w-4 shrink-0 rounded border-navy-secondary bg-navy text-gold focus:ring-gold focus:ring-offset-0 disabled:opacity-60';
  // Driving for every client limits nothing and leaves nothing to ask: the
  // daily home doesn't carry the setting then (it shows when it narrows the
  // runs, or a request waits).
  if (allApproved && waiting.length === 0 && !open) return null;
  return (
    <section aria-label={t('drive.clients')} className="rounded-lg border border-navy-secondary bg-navy px-3.5 py-3">
      <div className="flex items-start gap-3">
        <Store className="mt-0.5 h-4 w-4 shrink-0 text-gold" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-white">{t('drive.clients')}</h2>
          <p className="text-xs text-silver">{approved.length ? approved.join(', ') : t('drive.clientsNone')}</p>
          {waiting.length > 0 && <p className="text-xs text-warning">{t('drive.clientsPending', { names: waiting.join(', ') })}</p>}
        </div>
        <Button size="sm" variant={approved.length ? 'secondary' : 'primary'} onClick={() => setOpen((o) => !o)}>
          {open ? t('drive.clientsCancel') : approved.length ? t('drive.clientsChange') : t('drive.clientsAsk')}
        </Button>
      </div>
      {open && (
        <div className="mt-3 space-y-2 border-t border-navy-secondary pt-3">
          <p className="text-xs text-silver">{t('drive.clientsBody')}</p>
          <ul className="space-y-1.5">
            {!allApproved && (
              <li className="flex items-center gap-2">
                <label className="flex min-w-0 flex-1 items-center gap-2 text-sm text-white coarse:min-h-11">
                  <input
                    type="checkbox"
                    checked={all || d.all?.status === 'REQUESTED'}
                    disabled={d.all?.status === 'REQUESTED'}
                    onChange={(e) => setAll(e.target.checked)}
                    className={box}
                  />
                  <span className="truncate">{t('drive.allClients')}</span>
                  {d.all && <AccessChip status={d.all.status} />}
                </label>
                {d.all?.status === 'REQUESTED' && (
                  <button type="button" onClick={() => void drop('all')} disabled={busy !== null} className="text-xs text-silver hover:text-white coarse:min-h-11">
                    {t('drive.clientsWithdraw')}
                  </button>
                )}
              </li>
            )}
            {d.clients.map((c) => {
              const st = c.access?.status ?? null;
              const locked = allApproved || st === 'APPROVED' || st === 'REQUESTED';
              return (
                <li key={c.id} className="flex items-center gap-2">
                  <label className="flex min-w-0 flex-1 items-center gap-2 text-sm text-white coarse:min-h-11">
                    <input
                      type="checkbox"
                      checked={locked || all || picked.includes(c.id)}
                      disabled={locked || all}
                      onChange={(e) => setPicked((p) => (e.target.checked ? [...p, c.id] : p.filter((x) => x !== c.id)))}
                      className={box}
                    />
                    <span className="truncate">{c.name}</span>
                    {st && !allApproved && <AccessChip status={st} />}
                  </label>
                  {st === 'DENIED' && c.access?.decisionNote && (
                    <span className="max-w-[45%] truncate text-xs text-silver/70">{c.access.decisionNote}</span>
                  )}
                  {(st === 'APPROVED' || st === 'REQUESTED') && !allApproved && (
                    <button type="button" onClick={() => void drop(c.id)} disabled={busy !== null} className="shrink-0 text-xs text-silver hover:text-white coarse:min-h-11">
                      {st === 'APPROVED' ? t('drive.clientsRemove') : t('drive.clientsWithdraw')}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={300}
            placeholder={t('drive.clientsNote')}
            aria-label={t('drive.clientsNote')}
            className="h-11 w-full rounded-md border border-navy-secondary bg-navy-secondary/40 px-3 text-base text-white placeholder:text-silver/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
          />
          <Button size="sm" onClick={() => void send()} loading={busy === 'send'} disabled={(!all && picked.length === 0) || busy !== null}>
            {t('drive.clientsSend')}
          </Button>
        </div>
      )}
    </section>
  );
}

function AccessChip({ status }: { status: DriverAccessStatus }) {
  const { t } = useI18n();
  const tone =
    status === 'APPROVED' ? 'bg-success/15 text-success' : status === 'REQUESTED' ? 'bg-warning/15 text-warning' : 'bg-alert/15 text-alert';
  return (
    <span className={cn('inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-2xs font-semibold', tone)}>
      {t(`drive.status.${status}` as MessageKey)}
    </span>
  );
}

function RiderDialog({ associateId, onClose }: { associateId: string; onClose: () => void }) {
  const { t } = useI18n();
  const q = useQuery({ queryKey: ['transport', 'rider', associateId], queryFn: () => getRiderProfile(associateId) });
  const r = q.data?.rider;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      {/* `sm:`-scoped on purpose. Below sm the DialogContent IS the phone's
          bottom sheet — inset-x-0 + w-full — and an unscoped max-width caps
          that sheet and leaves it pinned to the left edge (384px of sheet
          against 430px of Pro Max, with the sliver of page showing down the
          right). Worse, the cap never applied on desktop anyway: Dialog's
          own `sm:max-w-lg` is a media rule and outranks it there. Scoping it
          both unbreaks the sheet and finally makes the cap mean something. */}
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('drive.riderProfile')}</DialogTitle>
        </DialogHeader>
        {q.isError ? (
          <QueryError what={t('drive.load.rider')} query={q} />
        ) : !r ? (
          <Skeleton className="h-32" />
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <Avatar src={`/api/associates/${r.associateId}/photo`} name={r.name} email="" size="xl" />
              <div className="min-w-0">
                <div className="text-lg font-semibold text-white">{r.name}</div>
                <div className="text-xs text-silver">
                  {t('drive.riderSince', { date: fmtMonthShortYear(r.since) })}
                </div>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2 text-center">
              {[
                t('drive.riderRides', { count: r.rides }),
                t('drive.riderNoShows', { count: r.noShows }),
                t('drive.riderCancelled', { count: r.cancelled }),
              ].map((x) => (
                <div key={x} className="rounded-md border border-navy-secondary px-2 py-2 text-xs text-white">
                  {x}
                </div>
              ))}
            </div>
            {r.phone && (
              <Button className="w-full" variant="secondary" asChild>
                <a href={`tel:${r.phone}`}>
                  <Phone className="h-4 w-4" />
                  {t('drive.call')} · {r.phone}
                </a>
              </Button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The phone's position now: the stream's last fix, else one quick read (5 s). Null when there is none. */
function positionNow(): Promise<{ lat: number; lng: number } | null> {
  const fix = currentDriverFix();
  if (fix) return Promise.resolve({ lat: fix.lat, lng: fix.lng });
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 5_000, maximumAge: 30_000 },
    );
  });
}

/** Photos for a report or a receipt: up to `max`, uploaded as they're picked. */
function usePhotoPicker(max: number) {
  const [keys, setKeys] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const add = async (files: FileList | null) => {
    if (!files) return;
    setUploading(true);
    try {
      for (const f of Array.from(files).slice(0, Math.max(0, max - keys.length))) {
        const { key } = await uploadTransportPhoto(f);
        setKeys((k) => [...k, key]);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  };
  return { keys, uploading, add };
}

/**
 * Report a problem from the road. Floor walk 16: photos, where the phone
 * is, and "Van can't run safely" — which takes the van off the road (the
 * out-of-service record and an incident), and moves or flags its runs.
 */
function DriverReportDialog({
  runId,
  open,
  onOpenChange,
  vanOffFirst = false,
}: {
  runId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Opened from "Report a van issue": the van-off switch starts on. */
  vanOffFirst?: boolean;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [category, setCategory] = useState<TransportIssueCategory>('VEHICLE');
  const [body, setBody] = useState('');
  const [vanOff, setVanOff] = useState(vanOffFirst);
  const [busy, setBusy] = useState(false);
  const photos = usePhotoPicker(6);
  const fileRef = useRef<HTMLInputElement>(null);
  const send = async () => {
    setBusy(true);
    try {
      const at = await positionNow();
      const r = await reportTransportIssue({
        category,
        body: body.trim(),
        ...(runId ? { runId } : {}),
        ...(photos.keys.length ? { photoKeys: photos.keys } : {}),
        ...(at ? { lat: at.lat, lng: at.lng } : {}),
        ...(vanOff ? { vanOutOfService: true } : {}),
      });
      hapticConfirm();
      toast.success(r.vanParked ? t('drive.vanParked') : t('ride.reportSent'));
      if (r.vanParked) await queryClient.invalidateQueries({ queryKey: ['transport', 'driver'] });
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* `sm:`-scoped for the same reason as the rider card above: a bare
          max-width is a desktop measure aimed at the phone's bottom sheet. */}
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('ride.report')}</DialogTitle>
          <DialogDescription>{t('ride.reportDesc')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Field label={t('ride.reportWhat')} required>
            {(p) => (
              <Select {...p} value={category} onChange={(e) => setCategory(e.target.value as TransportIssueCategory)}>
                {DRIVER_ISSUES.map((c) => (
                  <option key={c} value={c}>
                    {t(`ride.cat.${c}` as MessageKey)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('ride.reportBody')} required>
            {(p) => <Textarea {...p} rows={4} value={body} onChange={(e) => setBody(e.target.value)} maxLength={2000} />}
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <input ref={fileRef} type="file" accept="image/*" capture="environment" multiple className="hidden" onChange={(e) => void photos.add(e.target.files)} />
            <Button size="sm" variant="secondary" onClick={() => fileRef.current?.click()} loading={photos.uploading} disabled={photos.uploading || photos.keys.length >= 6}>
              <Camera className="h-3.5 w-3.5" />
              {t('drive.reportAddPhoto')}
            </Button>
            {photos.keys.length > 0 && <span className="text-xs text-silver">{t('drive.photosAdded', { count: photos.keys.length })}</span>}
          </div>
          <p className="flex items-center gap-1.5 text-xs text-silver">
            <MapPin className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {t('drive.reportLocation')}
          </p>
          <label className="flex items-start gap-2 rounded-md border border-alert/40 bg-alert/[0.06] p-3 text-sm text-ink coarse:min-h-11">
            <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 coarse:h-6 coarse:w-6" checked={vanOff} onChange={(e) => setVanOff(e.target.checked)} />
            <span>
              <span className="block font-medium">{t('drive.vanCantRun')}</span>
              <span className="block text-xs text-silver">{t('drive.vanCantRunHint')}</span>
            </span>
          </label>
        </div>
        <DialogFooter>
          <Button variant={vanOff ? 'destructive' : 'primary'} onClick={() => void send()} loading={busy} disabled={busy || photos.uploading || body.trim().length < 5}>
            {vanOff ? t('drive.vanCantRunSend') : t('ride.reportSend')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Transport walk 9 — fuel at the pump, one tap from the driver's home:
 * what it cost, gallons, the odometer, a photo of the receipt. It lands in
 * the van's service log (with who logged it) and in cost per seat.
 */
function FuelDialog({ van, onClose }: { van: { id: string; name: string }; onClose: () => void }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [cost, setCost] = useState('');
  const [gallons, setGallons] = useState('');
  const [odometer, setOdometer] = useState('');
  const [busy, setBusy] = useState(false);
  const photo = usePhotoPicker(1);
  const fileRef = useRef<HTMLInputElement>(null);
  const dollars = Number.parseFloat(cost);
  const valid = Number.isFinite(dollars) && dollars > 0;
  const save = async () => {
    setBusy(true);
    try {
      const gal = Number.parseFloat(gallons);
      const odo = Number.parseInt(odometer, 10);
      await logFuel(van.id, {
        costCents: Math.round(dollars * 100),
        gallons: Number.isFinite(gal) ? gal : null,
        odometerMiles: Number.isFinite(odo) ? odo : null,
        photoKey: photo.keys[0] ?? null,
      });
      hapticConfirm();
      toast.success(t('drive.fuelSaved'));
      await queryClient.invalidateQueries({ queryKey: ['transport'] });
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('drive.fuelTitle', { van: van.name })}</DialogTitle>
          <DialogDescription>{t('drive.fuelBody')}</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('drive.fuelCost')} required className="col-span-2">
            {(p) => <Input {...p} type="number" inputMode="decimal" min="0" step="0.01" value={cost} onChange={(e) => setCost(e.target.value)} />}
          </Field>
          <Field label={t('drive.fuelGallons')}>
            {(p) => <Input {...p} type="number" inputMode="decimal" min="0" step="0.1" value={gallons} onChange={(e) => setGallons(e.target.value)} />}
          </Field>
          <Field label={t('drive.fuelOdometer')}>
            {(p) => <Input {...p} type="number" inputMode="numeric" min="0" step="1" value={odometer} onChange={(e) => setOdometer(e.target.value)} />}
          </Field>
          <div className="col-span-2 flex items-center gap-2">
            <input ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => void photo.add(e.target.files)} />
            <Button size="sm" variant="secondary" onClick={() => fileRef.current?.click()} loading={photo.uploading} disabled={photo.uploading || photo.keys.length > 0}>
              <Camera className="h-3.5 w-3.5" />
              {photo.keys.length > 0 ? t('drive.fuelReceiptAdded') : t('drive.fuelReceipt')}
            </Button>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void save()} loading={busy} disabled={busy || photo.uploading || !valid}>
            {t('drive.fuelSave')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
