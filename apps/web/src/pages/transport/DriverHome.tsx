import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Bus,
  CalendarDays,
  Check,
  CheckCheck,
  Clock,
  Home,
  LocateFixed,
  LocateOff,
  MapPin,
  Navigation,
  Phone,
  RotateCcw,
  Route,
  Store,
  UserX,
} from 'lucide-react';
import { toast } from 'sonner';
import { ShiftMapDrawer, type TripKey } from './ShiftMap';
import { ApiError } from '@/lib/api';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { cn } from '@/lib/cn';
import { hapticConfirm } from '@/lib/haptics';
import { onLiveEvent } from '@/lib/liveEvents';
import { fmtDayHeaderTz, fmtMoney, fmtRelativeDayTz, fmtTimeTz, fmtWeekdayTz, parseYmd, zonedDayKey } from '@/lib/format';
import {
  NO_SHOW_WAIT_MS,
  acceptSeat,
  completeDriverRun,
  declineSeat,
  driverArrived,
  getRiderProfile,
  getSeatRequests,
  getDriverRunLive,
  getDriverWeek,
  getDriverRuns,
  markBoarded,
  markNoShow,
  reportTransportIssue,
  sendVanLocation,
  startDriverRun,
  undoRideMark,
  type Ride,
  type RideRun,
  type SeatRequest,
  type TransportIssueCategory,
} from '@/lib/transportApi';
import { rideAlert, useNewKeys } from '@/lib/rideAlerts';
import { useConfirm, usePrompt } from '@/lib/confirm';
import { SoundToggle } from '@/components/transport/SoundToggle';
import { PageHeader } from '@/components/ui/PageHeader';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { QueryError } from '@/components/ui/QueryError';
import { Textarea } from '@/components/ui/Input';
import { LazyLiveMap, type MapMarker } from '@/components/transport/LazyLiveMap';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { fmtClock, fmtIn } from './rideShifts';

/**
 * Driver mode — the phone on the dash, built around the STOP, not a list:
 *
 *   the day      runs, riders, picked up — three numbers
 *   up next      a run that hasn't left: when it leaves, its stops, Start
 *   on the road  the map, then the stop you're driving to — Navigate,
 *                Arrived (every rider there hears "your van is here"), each
 *                rider On board / No-show, All on board for a housing
 *                complex. A rider's "I'm outside / running late" shows on
 *                their row. No-show opens 3 minutes after Arrived — the
 *                rider isn't charged for a van that never stopped. When
 *                everyone's picked up: the drop-off, Navigate, Finish.
 *
 * Location is shared from this phone while the run is on the road.
 */

const DRIVER_ISSUES: TransportIssueCategory[] = ['VEHICLE', 'SAFETY', 'CONDUCT', 'LATE_VAN', 'OTHER'];

function runTz(run: RideRun): string {
  return run.rides[0]?.store.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function useTick(ms: number, on = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms, on]);
  return now;
}

const directionsUrl = (address: string) =>
  `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}`;

/* ----- Stops: riders grouped by where the van stops -------------------------- */

export interface Stop {
  key: string;
  kind: 'home' | 'store';
  label: string;
  address: string;
  rides: Ride[];
  at: string | null;
}

const riding = (r: Ride) => r.status !== 'CANCELLED';
const homeKey = (r: Ride) => (r.pickup.kind === 'stop' ? `stop:${r.pickup.id}` : `addr:${r.pickup.address.trim().toLowerCase()}`);

function group(rides: Ride[], keyOf: (r: Ride) => string, make: (r: Ride) => Omit<Stop, 'rides' | 'key' | 'at'>): Stop[] {
  const out: Stop[] = [];
  for (const r of rides) {
    const key = keyOf(r);
    let stop = out.find((s) => s.key === key);
    if (!stop) {
      stop = { key, ...make(r), rides: [], at: null };
      out.push(stop);
    }
    stop.rides.push(r);
    const at = r.pickupAt ?? r.targetAt;
    if (!stop.at || at < stop.at) stop.at = at;
  }
  return out;
}

/** Where the van picks up, in order, and where it drops off. To work: homes
 *  (and housing complexes) → the store. Home: the store → each home. */
export function stopsFor(run: RideRun): { pickups: Stop[]; drops: Stop[] } {
  const rides = run.rides.filter(riding).sort((a, b) => (a.pickupOrder ?? 99) - (b.pickupOrder ?? 99));
  const home = (r: Ride) => ({
    kind: 'home' as const,
    label: r.pickup.kind === 'stop' ? r.pickup.name : r.pickup.address,
    address: r.pickup.address,
  });
  const store = (r: Ride) => ({ kind: 'store' as const, label: r.store.name, address: `${r.store.clientName} ${r.store.name}` });
  return run.direction === 'TO_WORK'
    ? { pickups: group(rides, homeKey, home), drops: group(rides, (r) => `store:${r.store.id}`, store) }
    : { pickups: group(rides, (r) => `store:${r.store.id}`, store), drops: group(rides, homeKey, home) };
}

const stopDone = (s: Stop) => s.rides.every((r) => r.status !== 'SCHEDULED');

/* ----- The shift's stops, from anywhere on the page --------------------------- */

const ShiftMapContext = createContext<(trip: TripKey) => void>(() => {});

/** "Stops" — the shift's pickups, clustered and in order. */
function StopsButton({ trip, className }: { trip: TripKey | null; className?: string }) {
  const { t } = useI18n();
  const open = useContext(ShiftMapContext);
  if (!trip) return null;
  return (
    <Button variant="ghost" size="xs" className={className} onClick={() => open(trip)}>
      <Route className="h-3.5 w-3.5" />
      {t('drive.shiftStopsBtn')}
    </Button>
  );
}

/** The trip a run serves: its store, its shift, its day. */
function tripOfRun(run: RideRun): TripKey | null {
  const first = run.rides.find(riding) ?? run.rides[0];
  if (!first) return null;
  return {
    locationId: first.store.id,
    direction: run.direction,
    date: run.serviceDate,
    windowLabel: first.windowLabel ?? null,
    storeName: first.store.name,
  };
}

/* ----- The page ---------------------------------------------------------------- */

export function DriverHome() {
  const { t } = useI18n();
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
  const active = all.filter((r) => r.status === 'ACTIVE');
  const planned = all.filter((r) => r.status === 'PLANNED');
  const done = all.filter((r) => r.status === 'COMPLETED' && isRecent(r));

  return (
    <ShiftMapContext.Provider value={setShiftMap}>
      <div className="mx-auto max-w-2xl">
      <PageHeader
        title={t('drive.title')}
        subtitle={t('drive.subtitle')}
        secondaryActions={
          <>
            <SoundToggle onLabel={t('ride.soundsOn')} offLabel={t('ride.soundsOff')} />
            <Button variant="ghost" size="sm" onClick={() => setReporting(null)}>
              <AlertTriangle className="h-4 w-4" />
              {t('ride.report')}
            </Button>
          </>
        }
      />
      <SeatRequests onRider={setRider} />
      {runs.isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-20" />
          <Skeleton className="h-64" />
        </div>
      ) : runs.isError ? (
        <QueryError what="today's runs" query={runs} />
      ) : active.length + planned.length + done.length === 0 ? (
        <EmptyState icon={Bus} title={t('drive.none')} description={t('drive.noneBody')} />
      ) : (
        <div className="space-y-4">
          <DayStats runs={[...active, ...planned, ...done]} />
          {active.map((run) => (
            <OnTheRoad key={run.id} run={run} onReport={() => setReporting(run.id)} onRider={setRider} />
          ))}
          {planned.map((run, i) => (
            <UpNext key={run.id} run={run} hero={active.length === 0 && i === 0} onReport={() => setReporting(run.id)} />
          ))}
          {done.map((run) => (
            <Finished key={run.id} run={run} />
          ))}
        </div>
      )}
      <DriverWeekCalendar onRider={setRider} />
      {reporting !== undefined && (
        <DriverReportDialog runId={reporting} open onOpenChange={(o) => !o && setReporting(undefined)} />
      )}
      {rider && <RiderDialog associateId={rider} onClose={() => setRider(null)} />}
      <ShiftMapDrawer trip={shiftMap} open={!!shiftMap} onClose={() => setShiftMap(null)} />
      </div>
    </ShiftMapContext.Provider>
  );
}

/**
 * The driver's week, like a schedule: a strip of days, each day's runs —
 * the shift, the store, when they leave, seats filled — with the riders in
 * pickup order (names and faces; tap one for their profile), and the
 * shifts still asking for seats that day.
 */
function DriverWeekCalendar({ onRider }: { onRider: (associateId: string) => void }) {
  const { t } = useI18n();
  const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = zonedDayKey(new Date(), localTz);
  const q = useQuery({ queryKey: ['transport', 'driver', 'week', today], queryFn: () => getDriverWeek(today, 7), refetchInterval: 60_000 });
  const [picked, setPicked] = useState(today);
  if (q.isError) return <QueryError what="your week" query={q} />;
  if (!q.data) return null;
  const days = Array.from({ length: 7 }, (_, i) => new Date(Date.parse(`${today}T12:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10));
  const runsOn = (d: string) => q.data.runs.filter((r) => r.serviceDate === d);
  const askingOn = (d: string) => q.data.asking.filter((a) => a.serviceDate === d);
  const label = (d: string) => {
    const at = parseYmd(d)!;
    return {
      dow: fmtWeekdayTz(at),
      num: at.getDate(),
      long: fmtDayHeaderTz(at),
    };
  };
  const runs = runsOn(picked);
  const asking = askingOn(picked);
  return (
    <Card className="mt-6">
      <CardContent className="pt-5">
        <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-silver">
          <CalendarDays className="h-4 w-4 text-gold" aria-hidden="true" />
          {t('drive.week')}
        </h2>
        <div className="-mx-1 mt-3 flex gap-1.5 overflow-x-auto px-1 pb-1 scrollbar-none" role="tablist" aria-label={t('drive.week')}>
          {days.map((d) => {
            const n = runsOn(d).length;
            const ask = askingOn(d).reduce((m, a) => m + a.count, 0);
            const on = d === picked;
            const l = label(d);
            return (
              <button
                key={d}
                type="button"
                role="tab"
                aria-selected={on}
                aria-label={l.long}
                onClick={() => setPicked(d)}
                className={cn(
                  'flex w-12 shrink-0 flex-col items-center rounded-lg border py-2 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright',
                  on ? 'border-gold ring-1 ring-gold/60' : 'border-navy-secondary hover:border-silver/40',
                )}
              >
                <span className={cn('text-2xs uppercase', on ? 'text-gold' : 'text-silver')}>{l.dow}</span>
                <span className={cn('text-base font-semibold tabular-nums', on ? 'text-white' : 'text-silver')}>{l.num}</span>
                <span className="mt-1 flex h-1.5 gap-0.5" aria-hidden="true">
                  {Array.from({ length: Math.min(3, n) }, (_, i) => (
                    <span key={i} className="h-1.5 w-1.5 rounded-full bg-gold" />
                  ))}
                  {ask > 0 && <span className="h-1.5 w-1.5 rounded-full bg-sky" />}
                </span>
              </button>
            );
          })}
        </div>
        <div className="mt-3 text-xs font-medium text-silver">{label(picked).long}</div>
        {runs.length === 0 && asking.length === 0 && <p className="py-3 text-sm text-silver/70">{t('drive.weekNone')}</p>}
        <ul className="mt-2 space-y-3">
          {runs.map((run) => (
            <li key={run.id} className="rounded-lg border border-navy-secondary p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-semibold text-white">
                    {run.shift ? t('ride.shiftTag', { shift: run.shift }) : fmtTimeTz(run.departAt, run.timezone)}
                    <span className="font-normal text-silver">
                      {' · '}
                      {run.direction === 'TO_WORK' ? t('ride.toWork') : t('ride.fromWork')}
                    </span>
                  </div>
                  <div className="truncate text-xs text-silver">
                    {run.stores.join(', ')} · {run.van.name} · {t('drive.departs', { time: fmtTimeTz(run.departAt, run.timezone) })}
                  </div>
                </div>
                <span className="flex shrink-0 items-center gap-1">
                  <StopsButton
                    trip={
                      run.storeId
                        ? {
                            locationId: run.storeId,
                            direction: run.direction,
                            date: run.serviceDate,
                            windowLabel: run.shift,
                            storeName: run.stores[0] ?? '',
                          }
                        : null
                    }
                  />
                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums',
                      run.seats.taken >= run.seats.capacity ? 'bg-success/15 text-success' : 'bg-navy-secondary text-white',
                    )}
                  >
                    {t('drive.seats', { taken: run.seats.taken, capacity: run.seats.capacity })}
                  </span>
                </span>
              </div>
              <ol className="mt-2.5 space-y-1.5">
                {run.riders.map((r, i) => (
                  <li key={r.rideId}>
                    {/* The rider's pickup place belongs INSIDE the button.
                        It used to be a sibling div under a 32px-tall row, so
                        the bottom third of what reads as one rider did
                        nothing when a thumb landed there — and its indent
                        was a hand-measured 3.35rem that never lined up with
                        the avatar column anyway. In the name's column it
                        aligns by construction. coarse:min-h-11 then buys the
                        row the 44px a finger needs, without padding out the
                        dense list a mouse is perfectly happy with. */}
                    <button
                      type="button"
                      onClick={() => onRider(r.associateId)}
                      className="-mx-1 flex w-[calc(100%+0.5rem)] items-center gap-2.5 rounded-md px-1 py-0.5 text-left hover:bg-navy-secondary/30 coarse:min-h-11"
                    >
                      <span className="w-4 shrink-0 text-right text-2xs tabular-nums text-silver/70">{i + 1}</span>
                      <Avatar src={r.photoUrl ?? undefined} name={r.name} email="" size="sm" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-white">{r.name}</span>
                        <span className="block truncate text-2xs text-silver/80">{r.place}</span>
                      </span>
                      <span className="shrink-0 text-xs tabular-nums text-silver">
                        {r.pickupAt ? fmtTimeTz(r.pickupAt, run.timezone) : ''}
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            </li>
          ))}
          {asking.map((a) => (
            <li
              key={`${a.store.id}|${a.direction}|${a.windowLabel ?? a.targetAt}`}
              className="flex items-center gap-2.5 rounded-lg border border-dashed border-sky/40 px-3 py-2.5 text-sm"
            >
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-sky/15 text-xs font-semibold text-sky">{a.count}</span>
              <span className="min-w-0 flex-1 truncate text-silver">
                {t('drive.asking', { count: a.count })}
                {' · '}
                <span className="text-white">
                  {a.windowLabel ? t('ride.shiftTag', { shift: a.windowLabel }) : fmtTimeTz(a.targetAt, a.store.timezone)}
                </span>
                {' · '}
                {a.direction === 'TO_WORK' ? t('ride.toWork') : t('ride.fromWork')} · {a.store.name}
              </span>
              <StopsButton
                trip={{
                  locationId: a.store.id,
                  direction: a.direction,
                  date: a.serviceDate,
                  windowLabel: a.windowLabel,
                  storeName: a.store.name,
                }}
              />
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function isRecent(r: RideRun): boolean {
  return !!r.endedAt && Date.now() - new Date(r.endedAt).getTime() < 6 * 3_600_000;
}

function DayStats({ runs }: { runs: RideRun[] }) {
  const { t } = useI18n();
  const rides = runs.flatMap((r) => r.rides.filter(riding));
  const up = rides.filter((r) => r.status === 'BOARDED' || r.status === 'COMPLETED').length;
  const tiles = [
    { label: t('drive.statRuns'), value: runs.length },
    { label: t('drive.statRiders'), value: rides.length },
    { label: t('drive.statDone'), value: `${up}/${rides.length}` },
  ];
  return (
    <div className="grid grid-cols-3 gap-2">
      {tiles.map((x) => (
        <div key={x.label} className="rounded-lg border border-navy-secondary bg-navy px-3 py-2.5">
          <div className="text-2xs font-medium uppercase tracking-wider text-silver">{x.label}</div>
          <div className="mt-0.5 text-xl font-bold tabular-nums text-white">{x.value}</div>
        </div>
      ))}
    </div>
  );
}

/** Run a driver action, then refresh the runs. */
function useAct() {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>, success?: string) => {
    setBusy(true);
    try {
      await fn();
      hapticConfirm();
      if (success) toast.success(success);
      await queryClient.invalidateQueries({ queryKey: ['transport', 'driver'] });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return { act, busy };
}

function RunHeader({ run, tone }: { run: RideRun; tone: 'success' | 'gold' | 'quiet' }) {
  const { t } = useI18n();
  const tz = runTz(run);
  const stores = [...new Set(run.rides.filter(riding).map((r) => r.store.name))];
  // Whose store it is — the brand the riders clock in for.
  const clients = [...new Set(run.rides.filter(riding).map((r) => r.store.clientName))];
  const client = clients.length === 1 ? clients[0] : null;
  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <span
          className={cn(
            'flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider',
            tone === 'success' ? 'text-success' : tone === 'gold' ? 'text-gold' : 'text-silver',
          )}
        >
          <Bus className="h-3.5 w-3.5" aria-hidden="true" />
          {run.van.name}
          {run.van.plate ? ` · ${run.van.plate}` : ''}
        </span>
        <Badge variant={tone === 'success' ? 'success' : tone === 'gold' ? 'accent' : 'default'}>
          {t(`drive.status.${run.status}` as MessageKey)}
        </Badge>
      </div>
      <div className="mt-2 text-2xl font-bold tracking-tight text-white sm:text-3xl">
        {fmtRelativeDayTz(run.departAt, tz)}
        <span className="text-silver/50"> · </span>
        <span className="tabular-nums">{t('drive.departs', { time: fmtTimeTz(run.departAt, tz) })}</span>
      </div>
      <p className="mt-1 flex flex-wrap items-center gap-x-1 text-sm text-silver">
        <span>
          {run.direction === 'TO_WORK' ? t('ride.toWork') : t('ride.fromWork')}
          {stores.length > 0 && ` · ${stores.join(', ')}`}
          {client && <span className="text-silver/60"> ({client})</span>} · {t('drive.seats', { taken: run.seats.taken, capacity: run.seats.capacity })}
        </span>
        <StopsButton trip={tripOfRun(run)} className="ml-auto" />
      </p>
      {run.notes && <p className="mt-2 text-sm text-white">{run.notes}</p>}
    </>
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
  const van = q.data?.van ?? null;
  // A new seat request: buzz, chime — the ride-share "ding".
  useNewKeys(q.data ? requests.map((r) => `req:${r.id}`) : null, () => rideAlert('request'));
  if (q.isError) return <QueryError what="seat requests" query={q} />;
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
    <section aria-label={t('drive.requests')} className="mb-4 space-y-3">
      {van ? (
        <div className="flex items-center gap-3 rounded-lg border border-navy-secondary bg-navy px-3.5 py-2.5 text-sm">
          <Bus className="h-4 w-4 shrink-0 text-gold" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">
            <span className="text-silver">{t('drive.yourVan')} · </span>
            <span className="font-medium text-white">{van.name}</span>
            {van.look && <span className="text-silver"> · {van.look}</span>}
          </span>
          {van.plate && (
            <span className="shrink-0 rounded-md border border-silver/40 bg-white px-2 py-0.5 font-mono text-xs font-bold tracking-wider text-[#0B1832]">
              {van.plate}
            </span>
          )}
        </div>
      ) : (
        <p className="rounded-lg border border-warning/40 bg-warning/10 px-3.5 py-2.5 text-sm text-warning">{t('drive.noVan')}</p>
      )}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-silver">
          {t('drive.requests')} <span className="text-white">{requests.length}</span>
        </h2>
      </div>
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
    </section>
  );
}

/** A rider's profile — who they are, how to reach them, how they ride. */
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
          <QueryError what="this rider" query={q} />
        ) : !r ? (
          <Skeleton className="h-32" />
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <Avatar src={`/api/associates/${r.associateId}/photo`} name={r.name} email="" size="xl" />
              <div className="min-w-0">
                <div className="text-lg font-semibold text-white">{r.name}</div>
                <div className="text-xs text-silver">
                  {t('drive.riderSince', { date: new Date(r.since).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }) })}
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

/* ----- On the road: the stop you're driving to ----------------------------------- */

function OnTheRoad({ run, onReport, onRider }: { run: RideRun; onReport: () => void; onRider: (associateId: string) => void }) {
  const { t } = useI18n();
  const { act, busy } = useAct();
  const sharing = useShareVanLocation(run.id, true);
  const { pickups, drops } = stopsFor(run);
  const current = pickups.find((s) => !stopDone(s)) ?? null;
  const n = current ? pickups.indexOf(current) + 1 : pickups.length;
  const later = current ? pickups.slice(n) : [];
  const finished = pickups.filter(stopDone);
  const tz = runTz(run);

  return (
    <section
      aria-label={`${run.van.name} ${fmtTimeTz(run.departAt, tz)}`}
      className="relative overflow-hidden rounded-lg border border-success/40 bg-navy bg-gradient-to-br from-success/[0.12] via-transparent to-transparent"
    >
      <div className="p-5">
        <RunHeader run={run} tone="success" />
        <SharingPill state={sharing} />
        <RunMap runId={run.id} />

        {current ? (
          <StopCard run={run} stop={current} n={n} total={pickups.length} act={act} busy={busy} onRider={onRider} />
        ) : (
          <DropCard run={run} drops={drops} act={act} busy={busy} />
        )}

        {later.length > 0 && (
          <div className="mt-4">
            <h3 className="text-2xs font-semibold uppercase tracking-wider text-silver">{t('drive.laterStops')}</h3>
            <ol className="mt-1 divide-y divide-navy-secondary/60">
              {later.map((s, i) => (
                <li key={s.key} className="flex items-center gap-3 py-2 text-sm">
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-navy-secondary text-xs font-semibold text-white">
                    {n + i + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-white">{s.label}</span>
                  <span className="shrink-0 text-xs tabular-nums text-silver">
                    {s.at ? fmtTimeTz(s.at, tz) : ''} · {s.rides.length}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        )}
        {finished.length > 0 && current && (
          <div className="mt-4">
            <h3 className="text-2xs font-semibold uppercase tracking-wider text-silver">{t('drive.doneStops')}</h3>
            <ul className="mt-1 space-y-1">
              {finished.flatMap((s) => s.rides).map((r) => (
                <MarkedRow key={r.id} ride={r} act={act} busy={busy} />
              ))}
            </ul>
          </div>
        )}
        <button
          type="button"
          onClick={onReport}
          className="mt-4 inline-flex items-center text-sm text-silver hover:text-white coarse:min-h-11"
        >
          {t('ride.report')}
        </button>
      </div>
    </section>
  );
}

function StopCard({
  run,
  stop,
  n,
  total,
  act,
  busy,
  onRider,
}: {
  run: RideRun;
  stop: Stop;
  n: number;
  total: number;
  act: (fn: () => Promise<unknown>, success?: string) => Promise<void>;
  busy: boolean;
  onRider: (associateId: string) => void;
}) {
  const { t } = useI18n();
  const tz = runTz(run);
  const waiting = stop.rides.filter((r) => r.status === 'SCHEDULED');
  const arrivedAt = stop.rides.map((r) => r.vanArrivedAt).find(Boolean) ?? null;
  const now = useTick(1_000, !!arrivedAt);

  return (
    <div className="mt-4 rounded-lg border border-gold/40 bg-gold/[0.06] p-4">
      <div className="flex items-center justify-between gap-2 text-2xs font-semibold uppercase tracking-wider text-gold">
        <span>
          {t('drive.nextStop')} · {t('drive.stopOf', { n, total })}
        </span>
        {stop.at && <span className="tabular-nums text-silver">{fmtTimeTz(stop.at, tz)}</span>}
      </div>
      <div className="mt-1.5 flex items-start gap-2">
        {stop.kind === 'store' ? (
          <Store className="mt-1 h-4 w-4 shrink-0 text-gold" aria-hidden="true" />
        ) : (
          <MapPin className="mt-1 h-4 w-4 shrink-0 text-gold" aria-hidden="true" />
        )}
        <div className="min-w-0">
          <div className="text-lg font-semibold leading-snug text-white">{stop.label}</div>
          {stop.label !== stop.address && <div className="text-xs text-silver">{stop.address}</div>}
        </div>
      </div>

      {/* The three controls the run is actually driven with. Button's own
          size="sm" already gives them 44px of height on any finger; what it
          does NOT do is grow the label, so these read at 12px — too small
          for a glance from the driver's seat, and far too small in direct
          sun. Compact 12px stays for the mouse, 14px on touch, and the
          gutter widens with it so Arrived isn't 8px from All on board. */}
      <div className="mt-3 flex flex-wrap items-center gap-2 coarse:gap-3">
        {/* Navigate leads while you are still driving to the stop, and
            steps back once you are standing at it — at which point the
            marks are the only thing left to do and a live directions link
            is just something else to hit by mistake. */}
        <Button
          size="sm"
          className="coarse:text-sm"
          variant={arrivedAt ? 'secondary' : 'primary'}
          asChild
        >
          <a href={directionsUrl(stop.address)} target="_blank" rel="noreferrer">
            <Navigation className="h-3.5 w-3.5" />
            {t('drive.navigate')}
          </a>
        </Button>
        {arrivedAt ? (
          <span className="inline-flex items-center gap-1 text-sm text-success">
            <Check className="h-4 w-4" aria-hidden="true" />
            {t('drive.arrivedAt', { time: fmtTimeTz(arrivedAt, tz) })}
          </span>
        ) : (
          <Button
            size="sm"
            className="coarse:text-sm"
            onClick={() => void act(() => driverArrived(run.id, waiting.map((r) => r.id)))}
            disabled={busy}
          >
            <MapPin className="h-3.5 w-3.5" />
            {t('drive.arrived')}
          </Button>
        )}
        {waiting.length > 1 && (
          <Button
            size="sm"
            className="coarse:text-sm"
            variant={arrivedAt ? 'primary' : 'secondary'}
            onClick={() =>
              void act(async () => {
                for (const r of waiting) await markBoarded(r.id);
              })
            }
            disabled={busy}
          >
            <CheckCheck className="h-3.5 w-3.5" />
            {t('drive.allOnBoard')}
          </Button>
        )}
      </div>
      {!arrivedAt && <p className="mt-2 text-xs text-silver">{t('drive.arrivedHint')}</p>}

      <ul className="mt-3 divide-y divide-navy-secondary/60 border-t border-navy-secondary/60">
        {stop.rides.map((r) => (
          <RiderAtStop key={r.id} ride={r} now={now} act={act} busy={busy} onRider={onRider} />
        ))}
      </ul>
    </div>
  );
}

function RiderAtStop({
  ride,
  now,
  act,
  busy,
  onRider,
}: {
  ride: Ride;
  now: number;
  act: (fn: () => Promise<unknown>, success?: string) => Promise<void>;
  busy: boolean;
  onRider: (associateId: string) => void;
}) {
  const { t } = useI18n();
  const confirm = useConfirm();
  if (ride.status !== 'SCHEDULED') return <MarkedRow ride={ride} act={act} busy={busy} />;
  const openAt = ride.vanArrivedAt ? Date.parse(ride.vanArrivedAt) + NO_SHOW_WAIT_MS : null;
  const canNoShow = openAt !== null && now >= openAt;
  const noShow = async () => {
    const ok = await confirm({
      title: t('drive.noShowConfirm', { name: ride.rider.name }),
      description: t('drive.noShowBody', { fee: fmtMoney(ride.noShowFeeCents / 100) }),
      confirmLabel: t('drive.noShow'),
      destructive: true,
    });
    if (ok) await act(() => markNoShow(ride.id));
  };
  return (
    <li className="py-3">
      <div className="flex items-center gap-3">
        {/* The only door into the rider's card from this row — the name
            isn't a link here, unlike on a seat request — and at Avatar `sm`
            it was a 32px target. Growing the button to 44 on touch shifts
            the name column right by the difference, so the mark row below
            tracks it with coarse:pl-14 (44 + the same gap-3). */}
        <button
          type="button"
          onClick={() => onRider(ride.rider.associateId)}
          aria-label={`${t('drive.riderProfile')}: ${ride.rider.name}`}
          className="grid shrink-0 place-items-center rounded-full coarse:h-11 coarse:w-11"
        >
          <Avatar src={`/api/associates/${ride.rider.associateId}/photo`} name={ride.rider.name} email="" size="sm" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-medium text-white">{ride.rider.name}</span>
            {ride.riderSignal && (
              <Badge size="sm" variant={ride.riderSignal.kind === 'OUTSIDE' ? 'success' : 'pending'}>
                {t(`drive.signal.${ride.riderSignal.kind}` as MessageKey)}
              </Badge>
            )}
          </div>
          {ride.direction === 'FROM_WORK' && <div className="text-xs text-silver">{t('drive.dropAt', { place: ride.pickup.kind === 'stop' ? ride.pickup.name : ride.pickup.address })}</div>}
          {ride.note && <div className="text-xs text-gold">{ride.note}</div>}
        </div>
        {ride.rider.phone && (
          <Button size="icon-sm" variant="ghost" asChild>
            <a href={`tel:${ride.rider.phone}`} aria-label={`${t('drive.call')} ${ride.rider.name}`}>
              <Phone className="h-4 w-4" />
            </a>
          </Button>
        )}
      </div>
      {/* The two marks that put money on or off a rider's account, named at
          12px until now. 14px on touch so the pair can be told apart at
          arm's length in sun, and a finger's width of dead space between
          them — On board and a no-show fee should not be 8px apart when the
          phone is being held one-handed on a kerb. */}
      <div className="mt-2 flex flex-wrap items-center gap-2 pl-11 coarse:gap-3 coarse:pl-14">
        <Button size="sm" className="coarse:text-sm" onClick={() => void act(() => markBoarded(ride.id))} disabled={busy}>
          <Check className="h-3.5 w-3.5" />
          {t('drive.onBoard')}
        </Button>
        <Button size="sm" className="coarse:text-sm" variant="secondary" onClick={() => void noShow()} disabled={busy || !canNoShow}>
          {canNoShow || openAt === null ? <UserX className="h-3.5 w-3.5" /> : <Clock className="h-3.5 w-3.5" />}
          {openAt !== null && !canNoShow ? t('drive.noShowIn', { time: fmtClock(openAt - now) }) : t('drive.noShow')}
        </Button>
      </div>
    </li>
  );
}

function MarkedRow({
  ride,
  act,
  busy,
}: {
  ride: Ride;
  act: (fn: () => Promise<unknown>, success?: string) => Promise<void>;
  busy: boolean;
}) {
  const { t } = useI18n();
  const noShow = ride.status === 'NO_SHOW';
  return (
    <li className="flex items-center gap-2 py-1.5 text-sm">
      {noShow ? (
        <UserX className="h-4 w-4 shrink-0 text-alert" aria-hidden="true" />
      ) : (
        <Check className="h-4 w-4 shrink-0 text-success" aria-hidden="true" />
      )}
      <span className="min-w-0 flex-1 truncate text-white">{ride.rider.name}</span>
      <Badge size="sm" variant={noShow ? 'destructive' : 'success'}>
        {t(`ride.status.${ride.status}` as MessageKey)}
      </Badge>
      {/* The entire safety net under a mis-tapped On board / No-show. A
          12px ghost label reads as chrome; on the device where the mis-tap
          happens it should read as a way out. */}
      {(ride.status === 'BOARDED' || noShow) && (
        <Button size="xs" variant="ghost" className="coarse:text-sm" onClick={() => void act(() => undoRideMark(ride.id))} disabled={busy}>
          <RotateCcw className="h-3.5 w-3.5" />
          {t('drive.undo')}
        </Button>
      )}
    </li>
  );
}

/** Everyone's picked up: where they're going, and Finish. */
function DropCard({
  run,
  drops,
  act,
  busy,
}: {
  run: RideRun;
  drops: Stop[];
  act: (fn: () => Promise<unknown>, success?: string) => Promise<void>;
  busy: boolean;
}) {
  const { t } = useI18n();
  const aboard = run.rides.filter((r) => r.status === 'BOARDED').length;
  return (
    <div className="mt-4 rounded-lg border border-success/40 bg-success/[0.06] p-4">
      <div className="text-2xs font-semibold uppercase tracking-wider text-success">{t('drive.pickupsDone')}</div>
      <div className="mt-1 text-lg font-semibold text-white">
        {drops.length === 1 ? t('drive.dropOffAt', { place: drops[0]!.label }) : t('drive.dropOffs')}
      </div>
      <ol className="mt-2 space-y-2">
        {drops.map((d, i) => (
          <li key={d.key} className="flex items-center gap-2 text-sm">
            {d.kind === 'store' ? (
              <Store className="h-4 w-4 shrink-0 text-silver" aria-hidden="true" />
            ) : (
              <Home className="h-4 w-4 shrink-0 text-silver" aria-hidden="true" />
            )}
            <span className="min-w-0 flex-1 truncate text-white">
              {drops.length > 1 ? `${i + 1}. ` : ''}
              {d.label}
              <span className="text-silver"> · {d.rides.filter((r) => r.status === 'BOARDED').map((r) => r.rider.name.split(' ')[0]).join(', ')}</span>
            </span>
            <Button size="xs" variant="secondary" asChild>
              <a href={directionsUrl(d.address)} target="_blank" rel="noreferrer">
                <Navigation className="h-3.5 w-3.5" />
                {t('drive.navigate')}
              </a>
            </Button>
          </li>
        ))}
      </ol>
      {/* `sm:w-auto` was handing the run's last and least reversible action
          back to a text-width button on an iPad — 768-1194px is "desktop"
          by breakpoint and every tap on it is still a finger. Gating the
          shrink behind fine: keeps the wide, unmissable bar on all touch
          and the tidy inline button on a mouse. */}
      <Button className="mt-3 w-full fine:sm:w-auto" onClick={() => void act(() => completeDriverRun(run.id), t('drive.finished'))} disabled={busy}>
        <Check className="h-4 w-4" />
        {t('drive.finish')}
        {aboard > 0 ? ` · ${aboard}` : ''}
      </Button>
    </div>
  );
}

/* ----- Up next: a run that hasn't left ------------------------------------------ */

function UpNext({ run, hero, onReport }: { run: RideRun; hero: boolean; onReport: () => void }) {
  const { t } = useI18n();
  const { act, busy } = useAct();
  const now = useTick(30_000);
  const tz = runTz(run);
  const { pickups } = stopsFor(run);
  const until = Date.parse(run.departAt) - now;
  return (
    <section
      aria-label={`${run.van.name} ${fmtTimeTz(run.departAt, tz)}`}
      className={cn(
        'relative overflow-hidden rounded-lg border bg-navy',
        hero ? 'border-gold/30 bg-gradient-to-br from-gold/[0.14] via-transparent to-transparent' : 'border-navy-secondary',
      )}
    >
      <div className="p-5">
        <RunHeader run={run} tone="gold" />
        {until > 0 && <p className="mt-1 text-xs tabular-nums text-gold">{t('drive.leavesIn', { time: fmtIn(until) })}</p>}
        {hero && <RunMap runId={run.id} />}
        <ol className="mt-3 divide-y divide-navy-secondary/60 border-t border-navy-secondary/60">
          {pickups.map((s, i) => (
            <li key={s.key} className="flex items-center gap-3 py-2 text-sm">
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-navy-secondary text-xs font-semibold text-white">
                {i + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-white">{s.label}</span>
                <span className="block truncate text-xs text-silver">{s.rides.map((r) => r.rider.name).join(', ')}</span>
              </span>
              <span className="shrink-0 text-xs tabular-nums text-silver">{s.at ? fmtTimeTz(s.at, tz) : ''}</span>
            </li>
          ))}
        </ol>
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
          <Button onClick={() => void act(() => startDriverRun(run.id), t('drive.started'))} disabled={busy}>
            {t('drive.start')}
          </Button>
          <button type="button" onClick={onReport} className="inline-flex items-center text-sm text-silver hover:text-white coarse:min-h-11">
            {t('ride.report')}
          </button>
        </div>
      </div>
    </section>
  );
}

function Finished({ run }: { run: RideRun }) {
  const { t } = useI18n();
  const tz = runTz(run);
  const rides = run.rides.filter(riding);
  const noShows = rides.filter((r) => r.status === 'NO_SHOW').length;
  return (
    <div className="flex items-center gap-3 rounded-lg border border-navy-secondary bg-navy p-3.5 text-sm">
      <Check className="h-4 w-4 shrink-0 text-success" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-white">
        {run.van.name} · {fmtTimeTz(run.departAt, tz)}
      </span>
      <span className="shrink-0 text-xs text-silver">
        {t('drive.status.COMPLETED')} · {rides.length - noShows}/{rides.length}
      </span>
    </div>
  );
}

/* ----- The van's location, from this phone ------------------------------- */

type SharingState = 'locating' | 'on' | 'denied' | 'unsupported';

const SEND_EVERY_MS = 10_000;

/**
 * While the run is on the road: watch the phone's GPS and send the van's
 * position every ~10 seconds (sooner after a big move), and keep the
 * screen awake so the phone doesn't stop sharing mid-route.
 */
export function useShareVanLocation(runId: string, active: boolean): SharingState {
  const [state, setState] = useState<SharingState>('locating');
  const latest = useRef<GeolocationPosition | null>(null);
  const lastSent = useRef<{ at: number; lat: number; lng: number } | null>(null);

  useEffect(() => {
    if (!active) return;
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setState('unsupported');
      return;
    }
    let stopped = false;
    const send = (pos: GeolocationPosition) => {
      const c = pos.coords;
      lastSent.current = { at: Date.now(), lat: c.latitude, lng: c.longitude };
      void sendVanLocation(runId, {
        lat: c.latitude,
        lng: c.longitude,
        heading: c.heading !== null && Number.isFinite(c.heading) ? c.heading : null,
        speed: c.speed !== null && Number.isFinite(c.speed) ? c.speed : null,
        accuracy: Number.isFinite(c.accuracy) ? c.accuracy : null,
      }).catch(() => {
        /* the next tick retries */
      });
    };
    const watch = navigator.geolocation.watchPosition(
      (pos) => {
        if (stopped) return;
        latest.current = pos;
        setState('on');
        const prev = lastSent.current;
        const moved = prev ? Math.hypot(pos.coords.latitude - prev.lat, pos.coords.longitude - prev.lng) > 0.0008 : true;
        if (!prev || Date.now() - prev.at >= SEND_EVERY_MS || (moved && Date.now() - prev.at >= 5_000)) send(pos);
      },
      (err) => {
        if (!stopped) setState(err.code === err.PERMISSION_DENIED ? 'denied' : 'locating');
      },
      { enableHighAccuracy: true, maximumAge: 5_000, timeout: 30_000 },
    );
    // Parked at a stop, the GPS may go quiet — keep the riders' map fresh.
    const tick = window.setInterval(() => {
      if (latest.current && (!lastSent.current || Date.now() - lastSent.current.at >= SEND_EVERY_MS)) send(latest.current);
    }, SEND_EVERY_MS);

    // Keep the screen on while driving the route.
    let lock: { release: () => Promise<void> } | null = null;
    const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } };
    const holdScreen = () => {
      if (document.visibilityState === 'visible' && nav.wakeLock) {
        nav.wakeLock
          .request('screen')
          .then((l) => {
            lock = l;
          })
          .catch(() => {});
      }
    };
    holdScreen();
    document.addEventListener('visibilitychange', holdScreen);

    return () => {
      stopped = true;
      navigator.geolocation.clearWatch(watch);
      window.clearInterval(tick);
      document.removeEventListener('visibilitychange', holdScreen);
      void lock?.release().catch(() => {});
    };
  }, [runId, active]);

  return state;
}

function SharingPill({ state }: { state: SharingState }) {
  const { t } = useI18n();
  const on = state === 'on';
  return (
    <p
      role="status"
      className={cn(
        'mt-3 flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs',
        on ? 'bg-success/10 text-success' : state === 'locating' ? 'bg-navy-secondary/40 text-silver' : 'bg-warning/10 text-warning',
      )}
    >
      {on || state === 'locating' ? (
        <LocateFixed className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      ) : (
        <LocateOff className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      )}
      {on
        ? t('drive.sharing')
        : state === 'locating'
          ? t('drive.locating')
          : state === 'denied'
            ? t('drive.locationOff')
            : t('drive.locationUnsupported')}
    </p>
  );
}

/** The run on the map: the van, and the stops left in order. */
function RunMap({ runId }: { runId: string }) {
  const { t } = useI18n();
  const live = useQuery({
    queryKey: ['transport', 'driver', 'live', runId],
    queryFn: () => getDriverRunLive(runId),
    refetchInterval: 15_000,
  });
  const run = live.data?.run;
  if (live.isError) return <QueryError what="this run" query={live} />;
  if (!run) return null;
  const markers: MapMarker[] = [];
  if (run.position) markers.push({ id: 'van', kind: 'van', ...run.position, label: run.van.name, stale: run.stale, highlight: true });
  // One pin per stop: riders within a short walk of each other share it.
  for (const c of run.clusters ?? []) {
    if (c.point) markers.push({ id: c.key, kind: 'stop', ...c.point, order: c.order, label: `${c.label} · ${c.riders.length}` });
  }
  for (const w of run.waypoints) {
    if (w.point && w.kind === 'store') markers.push({ id: `s-${w.label}`, kind: 'store', ...w.point, label: w.label });
  }
  const route: Array<[number, number]> = [
    ...(run.position ? [[run.position.lng, run.position.lat] as [number, number]] : []),
    ...run.waypoints.filter((w) => w.point).map((w) => [w.point!.lng, w.point!.lat] as [number, number]),
  ];
  return (
    <div className="mt-3">
      {markers.length > 0 && (
        <LazyLiveMap ariaLabel={t('drive.map')} className="h-72 w-full sm:h-80" markers={markers} route={route.length > 1 ? route : undefined} trail={run.trail} />
      )}

    </div>
  );
}

function DriverReportDialog({
  runId,
  open,
  onOpenChange,
}: {
  runId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const [category, setCategory] = useState<TransportIssueCategory>('VEHICLE');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try {
      await reportTransportIssue({ category, body: body.trim(), ...(runId ? { runId } : {}) });
      toast.success(t('ride.reportSent'));
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
        </div>
        <DialogFooter>
          <Button onClick={() => void send()} loading={busy} disabled={busy || body.trim().length < 5}>
            {t('ride.reportSend')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
