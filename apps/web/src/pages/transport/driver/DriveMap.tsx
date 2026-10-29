import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Crosshair } from '@/components/ui/icons';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/cn';
import { getDriverRunLive, type RunMap } from '@/lib/transportApi';
import { LazyLiveMap, type MapMarker } from '@/components/transport/LazyLiveMap';
import type { DriveStep } from './driveModel';
import '@/lib/i18n/en/drive';

/**
 * The run on the map, edge to edge above the sheet: the van, the stops
 * numbered in order (the one being driven to highlighted), the dashed
 * route through them and — on the road — a bold line flowing from the van
 * to where it's headed. The van glides as its phone reports and the map
 * keeps it in view; it fits the run again on every step, and the
 * crosshair fits it on demand.
 */

const pt = (p: { lat: number; lng: number }): [number, number] => [p.lng, p.lat];

export function driveGeometry(
  run: RunMap,
  step: DriveStep | null,
  /** Rides still waiting to be picked up — the route runs through their stops, not the ones behind the van. */
  waiting: ReadonlySet<string> | null = null,
): { markers: MapMarker[]; route?: Array<[number, number]>; path?: Array<[number, number]> } {
  const stop = step && 'stop' in step ? step.stop : null;
  const focus = new Set(stop?.rides.map((r) => r.id) ?? []);
  // The waypoint the van is headed for: the store, a pickup, or a home drop-off.
  const targetKind = !stop ? null : stop.kind === 'store' ? 'store' : step?.kind === 'drop' ? 'drop' : 'pickup';
  const isFocus = (kind: string, rideIds: string[]) => kind === targetKind && rideIds.some((id) => focus.has(id));
  const markers: MapMarker[] = [];
  if (run.position) markers.push({ id: 'van', kind: 'van', ...run.position, label: run.van.name, stale: run.stale, highlight: true });
  for (const c of run.clusters ?? []) {
    const rideIds = c.riders.map((r) => r.rideId);
    if (c.point) markers.push({ id: c.key, kind: 'stop', ...c.point, order: c.order, label: `${c.label} · ${c.riders.length}`, highlight: (targetKind === 'pickup' || targetKind === 'drop') && rideIds.some((id) => focus.has(id)) });
  }
  for (const w of run.waypoints) {
    if (w.point && w.kind === 'store') markers.push({ id: `s-${w.label}`, kind: 'store', ...w.point, label: w.label, highlight: isFocus('store', w.rideIds) });
  }
  const behind = (w: RunMap['waypoints'][number]) => run.status === 'ACTIVE' && !!waiting && w.kind === 'pickup' && !w.rideIds.some((id) => waiting.has(id));
  const stops = run.waypoints.filter((w) => w.point && !behind(w));
  const route: Array<[number, number]> = [...(run.position ? [pt(run.position)] : []), ...stops.map((w) => pt(w.point!))];
  const target = stops.find((w) => isFocus(w.kind, w.rideIds));
  const path = run.status === 'ACTIVE' && run.position && target?.point ? [pt(run.position), pt(target.point)] : undefined;
  return { markers, route: route.length > 1 ? route : undefined, path };
}

export function DriveMap({ runId, step, waiting, className }: { runId: string; step: DriveStep | null; waiting?: ReadonlySet<string>; className?: string }) {
  const { t } = useI18n();
  const [recenter, setRecenter] = useState(0);
  const live = useQuery({
    queryKey: ['transport', 'driver', 'live', runId],
    queryFn: () => getDriverRunLive(runId),
    refetchInterval: 15_000,
  });
  const run = live.data?.run ?? null;
  const geo = useMemo(() => (run ? driveGeometry(run, step, waiting ?? null) : null), [run, step, waiting]);
  // No map is better than a broken one: the sheet has every stop in words.
  if (!geo || geo.markers.length === 0) return null;
  const stepKey = step ? `${step.kind}:${'stop' in step ? step.stop.key : ''}` : 'none';
  return (
    <div className={cn('relative', className)} data-testid="drive-map">
      <LazyLiveMap
        ariaLabel={t('drive.map')}
        className="h-full w-full rounded-none"
        markers={geo.markers}
        route={geo.route}
        path={geo.path}
        trail={run?.trail}
        maxZoom={16}
        padding={{ top: 56, bottom: 48, left: 40, right: 64 }}
        fitKey={`${stepKey}:${recenter}`}
        controls={false}
        footInset={20}
        // Inline above the sheet: one finger scrolls the page, two move the map.
        cooperativeGestures
      />
      <button
        type="button"
        onClick={() => setRecenter((n) => n + 1)}
        aria-label={t('drive.recenter')}
        title={t('drive.recenter')}
        className="absolute right-3 top-3 grid h-11 w-11 place-items-center rounded-full bg-surface-overlay/90 text-ink elev-2 backdrop-blur transition-colors hover:bg-surface-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
      >
        <Crosshair className="h-5 w-5" />
      </button>
    </div>
  );
}
