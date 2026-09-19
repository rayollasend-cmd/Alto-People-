import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Bus, Check, Home, LocateFixed, LocateOff, MapPin, Phone, RotateCcw, UserX } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { cn } from '@/lib/cn';
import { useConfirm } from '@/lib/confirm';
import { hapticConfirm } from '@/lib/haptics';
import { fmtMoney, fmtRelativeDayTz, fmtTimeTz, mapsUrl } from '@/lib/format';
import {
  completeDriverRun,
  getDriverRunLive,
  getDriverRuns,
  markBoarded,
  markNoShow,
  reportTransportIssue,
  sendVanLocation,
  startDriverRun,
  undoRideMark,
  type Ride,
  type RideRun,
  type TransportIssueCategory,
} from '@/lib/transportApi';
import { PageHeader } from '@/components/ui/PageHeader';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
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

/**
 * Driver mode — the driver's phone on the dash. Their runs from yesterday
 * to the day after tomorrow, soonest first; the one on the road (or next
 * to leave) opens as the hero. Each rider in pickup order with the place,
 * the time and a call button; one tap for on board, one for a no-show
 * (confirmed — it costs the rider), undo for a mis-tap. Marking the first
 * rider starts the run; Finish closes it once everyone is marked.
 */

const DRIVER_ISSUES: TransportIssueCategory[] = ['VEHICLE', 'SAFETY', 'CONDUCT', 'LATE_VAN', 'OTHER'];

function runTz(run: RideRun): string {
  return run.rides[0]?.store.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function DriverHome() {
  const { t } = useI18n();
  const runs = useQuery({ queryKey: ['transport', 'driver'], queryFn: getDriverRuns, refetchInterval: 60_000 });
  const [reporting, setReporting] = useState<string | null | undefined>(undefined);
  const list = (runs.data?.runs ?? []).filter((r) => r.status !== 'COMPLETED' || isRecent(r));
  // The van on the road first, then what leaves next.
  const open = [...list.filter((r) => r.status === 'ACTIVE'), ...list.filter((r) => r.status === 'PLANNED')];
  const done = list.filter((r) => r.status === 'COMPLETED');

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title={t('drive.title')}
        subtitle={t('drive.subtitle')}
        secondaryActions={
          <Button variant="ghost" size="sm" onClick={() => setReporting(null)}>
            <AlertTriangle className="h-4 w-4" />
            {t('ride.report')}
          </Button>
        }
      />
      {runs.isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-40" />
          <Skeleton className="h-24" />
        </div>
      ) : runs.error ? (
        <p className="text-sm text-alert">{runs.error instanceof ApiError ? runs.error.message : String(runs.error)}</p>
      ) : open.length === 0 && done.length === 0 ? (
        <EmptyState icon={Bus} title={t('drive.none')} description={t('drive.noneBody')} />
      ) : (
        <div className="space-y-4">
          {open.map((run, i) => (
            <RunCard key={run.id} run={run} hero={i === 0} onReport={() => setReporting(run.id)} />
          ))}
          {done.map((run) => (
            <RunCard key={run.id} run={run} hero={false} onReport={() => setReporting(run.id)} />
          ))}
        </div>
      )}
      {reporting !== undefined && (
        <DriverReportDialog runId={reporting} open onOpenChange={(o) => !o && setReporting(undefined)} />
      )}
    </div>
  );
}

function isRecent(r: RideRun): boolean {
  return !!r.endedAt && Date.now() - new Date(r.endedAt).getTime() < 6 * 3_600_000;
}

function RunCard({ run, hero, onReport }: { run: RideRun; hero: boolean; onReport: () => void }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const tz = runTz(run);
  const riders = run.rides.filter((r) => r.status !== 'CANCELLED');
  const left = riders.filter((r) => r.status === 'SCHEDULED').length;
  const active = run.status === 'ACTIVE';
  const closed = run.status === 'COMPLETED' || run.status === 'CANCELLED';

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

  const stores = [...new Set(riders.map((r) => r.store.name))];
  const sharing = useShareVanLocation(run.id, active);

  return (
    <section
      aria-label={`${run.van.name} ${fmtTimeTz(run.departAt, tz)}`}
      className={cn(
        'relative overflow-hidden rounded-lg border bg-navy',
        active
          ? 'border-success/40 bg-gradient-to-br from-success/[0.12] via-transparent to-transparent'
          : hero && !closed
            ? 'border-gold/30 bg-gradient-to-br from-gold/[0.14] via-transparent to-transparent'
            : 'border-navy-secondary',
      )}
    >
      <div className="p-5">
        <div className="flex items-center justify-between gap-2">
          <span
            className={cn(
              'flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider',
              active ? 'text-success' : closed ? 'text-silver' : 'text-gold',
            )}
          >
            <Bus className="h-3.5 w-3.5" aria-hidden="true" />
            {run.van.name}
            {run.van.plate ? ` · ${run.van.plate}` : ''}
          </span>
          <Badge variant={active ? 'success' : closed ? 'default' : 'accent'}>
            {t(`drive.status.${run.status}` as MessageKey)}
          </Badge>
        </div>
        <div className="mt-2 text-2xl font-bold tracking-tight text-white sm:text-3xl">
          {fmtRelativeDayTz(run.departAt, tz)}
          <span className="text-silver/50"> · </span>
          <span className="tabular-nums">{t('drive.departs', { time: fmtTimeTz(run.departAt, tz) })}</span>
        </div>
        <p className="mt-1 text-sm text-silver">
          {run.direction === 'TO_WORK' ? t('ride.toWork') : t('ride.fromWork')}
          {stores.length > 0 && ` · ${stores.join(', ')}`}
          {' · '}
          {t('drive.seats', { taken: run.seats.taken, capacity: run.seats.capacity })}
        </p>
        {run.notes && <p className="mt-2 text-sm text-white">{run.notes}</p>}
        {active && <SharingPill state={sharing} />}
        {active && <RunMap runId={run.id} />}

        <ol className="mt-4 divide-y divide-navy-secondary/60 border-t border-navy-secondary/60">
          {riders.map((r, i) => (
            <RiderRow key={r.id} ride={r} n={i + 1} closed={closed} busy={busy} act={act} />
          ))}
        </ol>

        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
          {run.status === 'PLANNED' && (
            <Button onClick={() => void act(() => startDriverRun(run.id), t('drive.started'))} disabled={busy}>
              {t('drive.start')}
            </Button>
          )}
          {active && (
            <Button
              onClick={() => void act(() => completeDriverRun(run.id), t('drive.finished'))}
              disabled={busy || left > 0}
            >
              <Check className="h-4 w-4" />
              {t('drive.finish')}
            </Button>
          )}
          {active && left > 0 && <span className="text-sm text-silver">{t('drive.left', { count: left })}</span>}
          <button
            type="button"
            onClick={onReport}
            className="inline-flex items-center text-sm text-silver hover:text-white coarse:min-h-11"
          >
            {t('ride.report')}
          </button>
        </div>
      </div>
    </section>
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
  if (!run) return null;
  const markers: MapMarker[] = [];
  if (run.position) markers.push({ id: 'van', kind: 'van', ...run.position, label: run.van.name, stale: run.stale, highlight: true });
  let n = 0;
  for (const w of run.waypoints) {
    if (!w.point) continue;
    if (w.kind === 'store') markers.push({ id: `s-${w.label}`, kind: 'store', ...w.point, label: w.label });
    else markers.push({ id: `w-${w.rideIds.join(',')}`, kind: 'stop', ...w.point, order: ++n, label: w.label });
  }
  const route: Array<[number, number]> = [
    ...(run.position ? [[run.position.lng, run.position.lat] as [number, number]] : []),
    ...run.waypoints.filter((w) => w.point).map((w) => [w.point!.lng, w.point!.lat] as [number, number]),
  ];
  const next = run.waypoints.find((w) => w.point);
  return (
    <div className="mt-3">
      {markers.length > 0 && (
        <LazyLiveMap ariaLabel={t('drive.map')} className="h-56 w-full sm:h-72" markers={markers} route={route.length > 1 ? route : undefined} trail={run.trail} />
      )}
      {next?.point && (
        <Button size="sm" variant="secondary" className="mt-2" asChild>
          <a href={`https://www.google.com/maps/dir/?api=1&destination=${next.point.lat},${next.point.lng}`} target="_blank" rel="noreferrer">
            <MapPin className="h-3.5 w-3.5" />
            {t('drive.navigate')} · {next.label}
          </a>
        </Button>
      )}
    </div>
  );
}

function RiderRow({
  ride,
  n,
  closed,
  busy,
  act,
}: {
  ride: Ride;
  n: number;
  closed: boolean;
  busy: boolean;
  act: (fn: () => Promise<unknown>, success?: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const confirm = useConfirm();
  const tz = ride.store.timezone;
  const toWork = ride.direction === 'TO_WORK';
  const home = ride.pickup.kind === 'stop' ? ride.pickup.name : ride.pickup.address;
  const where = toWork ? home : ride.store.name;
  const drop = toWork ? ride.store.name : home;
  const marked = ride.status === 'BOARDED' || ride.status === 'NO_SHOW' || ride.status === 'COMPLETED';

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
      <div className="flex items-start gap-3">
        <span
          className={cn(
            'mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-semibold tabular-nums',
            ride.status === 'BOARDED' || ride.status === 'COMPLETED'
              ? 'bg-success/20 text-success'
              : ride.status === 'NO_SHOW'
                ? 'bg-alert/20 text-alert'
                : 'bg-navy-secondary text-white',
          )}
          aria-hidden="true"
        >
          {ride.status === 'BOARDED' || ride.status === 'COMPLETED' ? <Check className="h-3.5 w-3.5" /> : n}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate font-medium text-white">{ride.rider.name}</span>
            {ride.pickupAt && (
              <span className="shrink-0 text-sm tabular-nums text-white">{fmtTimeTz(ride.pickupAt, tz)}</span>
            )}
          </div>
          <a
            href={mapsUrl(toWork ? ride.pickup.address : ride.store.name)}
            target="_blank"
            rel="noreferrer"
            className="mt-0.5 flex items-center gap-1 text-sm text-silver hover:text-white"
          >
            <MapPin className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">{where}</span>
          </a>
          <div className="mt-0.5 flex items-center gap-1 text-xs text-silver/80">
            <Home className="h-3 w-3 shrink-0" aria-hidden="true" />
            <span className="truncate">{t('drive.dropAt', { place: drop })}</span>
          </div>
          {ride.note && <p className="mt-1 text-xs text-gold">{ride.note}</p>}
        </div>
      </div>
      {!closed && (
        <div className="mt-2 flex flex-wrap items-center gap-2 pl-10">
          {ride.status === 'SCHEDULED' ? (
            <>
              <Button size="sm" onClick={() => void act(() => markBoarded(ride.id))} disabled={busy}>
                <Check className="h-3.5 w-3.5" />
                {t('drive.onBoard')}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => void noShow()} disabled={busy}>
                <UserX className="h-3.5 w-3.5" />
                {t('drive.noShow')}
              </Button>
            </>
          ) : (
            marked && (
              <>
                <Badge variant={ride.status === 'NO_SHOW' ? 'destructive' : 'success'}>
                  {t(`ride.status.${ride.status}` as MessageKey)}
                </Badge>
                <Button size="xs" variant="ghost" onClick={() => void act(() => undoRideMark(ride.id))} disabled={busy}>
                  <RotateCcw className="h-3.5 w-3.5" />
                  {t('drive.undo')}
                </Button>
              </>
            )
          )}
          {ride.rider.phone && (
            <Button size="sm" variant="ghost" asChild>
              <a href={`tel:${ride.rider.phone}`}>
                <Phone className="h-3.5 w-3.5" />
                {t('drive.call')}
              </a>
            </Button>
          )}
        </div>
      )}
      {closed && marked && (
        <div className="mt-1.5 pl-10">
          <Badge size="sm" variant={ride.status === 'NO_SHOW' ? 'destructive' : 'success'}>
            {t(`ride.status.${ride.status}` as MessageKey)}
          </Badge>
        </div>
      )}
    </li>
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
      <DialogContent className="max-w-md">
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
