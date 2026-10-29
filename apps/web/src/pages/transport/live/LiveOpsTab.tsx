import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { FleetVan } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { useConfirm } from '@/lib/confirm';
import { fmtTimeTz } from '@/lib/format';
import { onLiveEvent } from '@/lib/liveEvents';
import { closeRunFromDispatch, getLiveBoard, type RunMap } from '@/lib/transportApi';
import { useTransportOps } from '@/lib/transportOpsApi';
import { useMinWidth } from '@/lib/useViewport';
import { LazyLiveMap, type MapMarker } from '@/components/transport/LazyLiveMap';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { QueryError } from '@/components/ui/QueryError';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { Bus, Maximize2, Phone, X } from '@/components/ui/icons';
import '@/lib/i18n/en/fleetOps';
import { useFleetT, type FleetT } from './fleetT';
import { ExceptionsQueue, useNow } from './ExceptionsQueue';
import { FleetList, statusText, VanDetails } from './FleetList';
import {
  fleetRoutes,
  groupVans,
  sosRunIds,
  spreadColocated,
  stopMarkers,
  telHref,
  vanIdFromMarker,
  vanMarker,
  vanStatus,
  type VanExtras,
} from './fleetModel';

/**
 * The dispatcher's live operations (2026-10-28) — the Live map tab. Never
 * empty: every van is on the map where it is (moving, with its heading and
 * its lateness as its colour), where it was last heard from (hollow), or
 * parked where it finished (muted); the day's routes for the vans on the
 * road; and beside it — on the right from 1024 px, as a sheet under the map
 * below that — what needs the desk, then every van by what it's doing.
 *
 * Data: GET /transport/ops (the vans, the exceptions; polled every 20 s)
 * plus GET /transport/live for each run's remaining stops and trail (the
 * route lines). A van tapped on the map opens its card; a van picked in the
 * list brings the map to it. The list is the map's accessible mirror.
 */
export interface LiveOpsTabProps {
  /** The day (YYYY-MM-DD); defaults to the page's ?date=, else today. */
  date?: string | null;
  /** "Assign a van" on a needs-a-van exception — the host's dispatch. */
  onOpenRide?: (rideIds: string[]) => void;
}

const isYmd = (s: string | null): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

/**
 * From 1024 px the tab fills the window below the page header — the map
 * owns the screen and the panel scrolls inside itself. Measured, because
 * the header is taller where its subtitle wraps (an iPad) than at 1440.
 */
function useFillHeight(on: boolean, ref: RefObject<HTMLElement | null>, gap = 24, min = 520): number | null {
  const [h, setH] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!on || !el) {
      setH(null);
      return;
    }
    const measure = () => {
      const scroller = el.closest('main');
      const top = el.getBoundingClientRect().top + (scroller?.scrollTop ?? window.scrollY);
      setH(Math.max(min, Math.round(window.innerHeight - top - gap)));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [on, ref, gap, min]);
  return h;
}

function useCloseRun(t: FleetT) {
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  return async (runId: string, vanName: string) => {
    const ok = await confirm({
      title: t('fleetOps.close.title', { van: vanName }),
      description: t('fleetOps.close.body'),
      confirmLabel: t('fleetOps.close.confirm'),
    });
    if (!ok) return;
    try {
      const { unmarkedCancelled } = await closeRunFromDispatch(runId);
      toast.success(unmarkedCancelled > 0 ? t('fleetOps.close.doneUnmarked', { van: vanName, count: unmarkedCancelled }) : t('fleetOps.close.done', { van: vanName }));
      void queryClient.invalidateQueries({ queryKey: ['transport'] });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('fleetOps.close.failed'));
    }
  };
}

export function LiveOpsTab({ date: dateProp, onOpenRide }: LiveOpsTabProps = {}) {
  const t = useFleetT();
  const [params, setParams] = useSearchParams();
  const urlDate = params.get('date');
  const date = dateProp !== undefined ? dateProp : isYmd(urlDate) ? urlDate : null;
  const ops = useTransportOps(date);
  const live = useQuery({
    queryKey: ['transport', 'live', date ?? 'today'],
    queryFn: () => getLiveBoard(date ?? undefined),
    refetchInterval: 20_000,
  });
  const queryClient = useQueryClient();
  useEffect(
    () =>
      onLiveEvent('transport', () => {
        void queryClient.invalidateQueries({ queryKey: ['transport', 'ops'] });
        void queryClient.invalidateQueries({ queryKey: ['transport', 'live'] });
      }),
    [queryClient],
  );
  const wide = useMinWidth(1024);
  const { can } = useAuth();
  const manage = can('manage:transport');
  const closeRun = useCloseRun(t);
  const now = useNow();

  const [selected, setSelected] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ lat: number; lng: number; key: number } | null>(null);
  const [fitKey, setFitKey] = useState(0);
  const [card, setCard] = useState(false);
  const rows = useRef(new Map<string, HTMLElement>());
  const frame = useRef<HTMLDivElement | null>(null);

  const board = ops.data;
  const vans = useMemo(() => board?.vans ?? [], [board]);
  const tz = board?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const liveByRun = useMemo(() => new Map<string, RunMap>((live.data?.runs ?? []).map((r) => [r.runId, r])), [live.data]);
  const sosRuns = useMemo(() => sosRunIds(board?.exceptions ?? []), [board]);
  const extrasFor = useCallback(
    (v: FleetVan): VanExtras => ({
      sos: !!v.run && sosRuns.has(v.run.runId),
      stuck: !!v.run && !!liveByRun.get(v.run.runId)?.stuck,
      now,
    }),
    [sosRuns, liveByRun, now],
  );
  const groups = useMemo(() => groupVans(vans, sosRuns), [vans, sosRuns]);
  const selectedVan = vans.find((v) => v.vanId === selected) ?? null;

  const pick = useCallback(
    (vanId: string, opts: { fromMap?: boolean } = {}) => {
      const v = vans.find((x) => x.vanId === vanId);
      if (!v) return;
      setSelected(vanId);
      if (!opts.fromMap && v.position) setFocus({ lat: v.position.lat, lng: v.position.lng, key: Date.now() });
      if (opts.fromMap) {
        if (wide) rows.current.get(vanId)?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
        else setCard(true);
      }
    },
    [vans, wide],
  );
  /** Pick the van on this run; false when no van is on it now. */
  const selectRun = useCallback(
    (runId: string) => {
      const v = vans.find((x) => x.run?.runId === runId || x.nextRun?.runId === runId);
      if (!v) return false;
      pick(v.vanId);
      rows.current.get(v.vanId)?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
      return true;
    },
    [vans, pick],
  );
  const pickRun = useCallback(
    (runId: string) => {
      if (selectRun(runId)) return;
      // Not one of the vans' runs right now (done, or another day's): the board has it.
      setParams(
        (p) => {
          const next = new URLSearchParams(p);
          next.delete('tab');
          next.set('run', runId);
          return next;
        },
        { replace: true },
      );
    },
    [selectRun, setParams],
  );

  // ?run= (an exception's "Open run" from the Today tab) picks that van, once.
  const runParam = params.get('run');
  useEffect(() => {
    if (!runParam || !board) return;
    selectRun(runParam);
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        next.delete('run');
        return next;
      },
      { replace: true },
    );
  }, [runParam, board, selectRun, setParams]);

  const markers = useMemo<MapMarker[]>(() => {
    const out: MapMarker[] = [];
    for (const v of vans) {
      const status = vanStatus(v, extrasFor(v));
      const driver = v.run?.driverName ?? v.nextRun?.driverName;
      const label = [v.name, driver, statusText(t, status, tz)].filter(Boolean).join(' · ');
      const m = vanMarker(v, { selected: v.vanId === selected, label, extras: extrasFor(v) });
      if (m) out.push(m);
    }
    const run = selectedVan?.run ? liveByRun.get(selectedVan.run.runId) : undefined;
    return spreadColocated([...out, ...stopMarkers(run)]);
  }, [vans, extrasFor, selected, selectedVan, liveByRun, t, tz]);
  const routes = useMemo(() => fleetRoutes(vans, liveByRun, selected), [vans, liveByRun, selected]);
  const trail = selectedVan?.run ? liveByRun.get(selectedVan.run.runId)?.trail : undefined;
  const fill = useFillHeight(wide && !!ops.data, frame);

  const GRID = 'grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px] xl:grid-cols-[minmax(0,1fr)_380px]';
  if (ops.isLoading) {
    return (
      <div ref={frame} className={cn(GRID, 'lg:h-[calc(100dvh-18rem)] lg:min-h-[520px]')} aria-busy="true">
        <Skeleton className="h-[50vh] min-h-72 lg:h-full" />
        <div className="space-y-3">
          <Skeleton className="h-20" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      </div>
    );
  }
  if (ops.isError || !board) return <QueryError what={t('fleetOps.what')} query={ops} />;

  const onRoad = groups.road.length;
  const selectedTel = telHref(selectedVan?.run?.driverPhone);

  return (
    <div ref={frame} className={GRID} style={fill ? { height: fill } : undefined} data-testid="live-ops">
      <div className="relative h-[50vh] min-h-72 overflow-hidden rounded-lg border border-line lg:h-full">
        <LazyLiveMap
          ariaLabel={t('fleetOps.mapAria')}
          className="h-full w-full rounded-none"
          markers={markers}
          routes={routes}
          trail={trail}
          center={board.center}
          focus={focus}
          fitOnce
          fitKey={fitKey}
          maxZoom={13}
          padding={56}
          cooperativeGestures={!wide}
          footInset={wide ? 0 : 16}
          onMarkerClick={(id) => {
            const vanId = vanIdFromMarker(id);
            if (vanId) pick(vanId, { fromMap: true });
          }}
        />
        <div className="pointer-events-none absolute inset-x-2 top-2 flex items-start gap-2">
          <Button
            size="xs"
            variant="secondary"
            className="pointer-events-auto bg-surface text-ink elev-1"
            onClick={() => {
              setSelected(null);
              setCard(false);
              setFitKey((k) => k + 1);
            }}
          >
            <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
            {t('fleetOps.showAll')}
          </Button>
        </div>
        <MapLegend t={t} className={cn('absolute left-2', !wide && card && selectedVan ? 'hidden' : wide ? 'bottom-2' : 'bottom-6')} />
        {!wide && card && selectedVan && (
          <section className="absolute inset-x-2 bottom-6 rounded-lg border border-line bg-surface p-3 elev-2" aria-label={selectedVan.name} data-testid="van-card">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <VanDetails v={selectedVan} status={vanStatus(selectedVan, extrasFor(selectedVan))} tz={tz} now={now} t={t} />
              </div>
              <Button size="icon-sm" variant="ghost" aria-label={t('fleetOps.closeCard')} onClick={() => setCard(false)}>
                <X className="h-4 w-4" />
              </Button>
            </div>
            {selectedTel && selectedVan.run && (
              <Button size="sm" variant="secondary" className="mt-2" asChild>
                <a href={selectedTel} aria-label={t('fleetOps.callNamed', { name: selectedVan.run.driverName })}>
                  <Phone className="h-3.5 w-3.5" aria-hidden="true" />
                  {t('fleetOps.callDriver')}
                </a>
              </Button>
            )}
          </section>
        )}
      </div>

      <aside
        aria-label={t('fleetOps.panelAria')}
        className={cn(
          'flex min-h-0 flex-col rounded-lg border border-line bg-surface',
          // Under 1024 px the panel is a sheet drawn up over the map's foot.
          '-mt-8 elev-2 lg:mt-0',
        )}
      >
        <div aria-hidden="true" className="mx-auto mt-2 h-1 w-10 rounded-full bg-line lg:hidden" />
        <SectionTitle
          className="mb-0 border-b border-line-subtle px-3 py-2.5"
          title={
            <>
              {t('fleetOps.fleet')}
              <span className="ml-2 text-sm font-normal tabular-nums text-ink-muted">
                {onRoad > 0 ? t('fleetOps.onRoadOf', { n: onRoad, total: vans.length }) : t('fleetOps.vansCount', { count: vans.length })}
              </span>
            </>
          }
          trailing={
            <span className="shrink-0 text-xs2 text-ink-muted" title={t('fleetOps.refreshes')}>
              {t('fleetOps.asOf', { time: fmtTimeTz(board.generatedAt, tz) })}
            </span>
          }
        />
        <div className="min-h-0 flex-1 space-y-5 p-3 lg:overflow-y-auto">
          <ExceptionsQueue date={date} max={3} onOpenRun={pickRun} onOpenRide={onOpenRide} />
          {vans.length === 0 ? (
            <EmptyState
              icon={Bus}
              title={t('fleetOps.noVans')}
              description={t('fleetOps.noVansBody')}
              action={
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    setParams(
                      (p) => {
                        const next = new URLSearchParams(p);
                        next.set('tab', 'vans');
                        return next;
                      },
                      { replace: true },
                    )
                  }
                >
                  {t('fleetOps.addVan')}
                </Button>
              }
            />
          ) : (
            <FleetList
              vans={groups}
              extrasFor={extrasFor}
              tz={tz}
              now={now}
              t={t}
              selected={selected}
              onSelect={(id) => (selected === id ? setSelected(null) : pick(id))}
              onCloseRun={manage ? (runId, name) => void closeRun(runId, name) : undefined}
              rowRef={(id, el) => {
                if (el) rows.current.set(id, el);
                else rows.current.delete(id);
              }}
            />
          )}
        </div>
      </aside>
    </div>
  );
}

/** What the marker colours mean — status words with the markers' own fills. */
function MapLegend({ t, className }: { t: FleetT; className?: string }) {
  const item = (dot: string, label: string) => (
    <li className="inline-flex items-center gap-1.5">
      <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full', dot)} aria-hidden="true" />
      {label}
    </li>
  );
  return (
    <ul
      aria-label={t('fleetOps.legend')}
      className={cn('flex max-w-[calc(100%-3.25rem)] flex-wrap gap-x-3 gap-y-1 rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs2 text-ink elev-1', className)}
    >
      {item('bg-positive-600', t('fleetOps.chip.onTime'))}
      {item('bg-caution-600', t('fleetOps.legend.late'))}
      {item('bg-negative-600', t('fleetOps.legend.veryLate'))}
      {item('border-2 border-dashed border-silver bg-surface', t('fleetOps.chip.noSignal'))}
      {item('bg-neutral-600', t('fleetOps.legend.parked'))}
    </ul>
  );
}
