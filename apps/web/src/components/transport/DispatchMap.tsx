import { LazyLiveMap, type MapMarker } from './LazyLiveMap';
import type { GeoPoint, RideDirection } from '@/lib/transportApi';

/**
 * Transport walk 5 — the map beside Dispatch and Plan runs.
 *
 * Numbered pickup pins in the current order, the store's pin, and a line
 * through them the way the van will drive (to work: pickups then the
 * store; home: the store then the drops). Tap pins in sequence to reorder
 * (the dialog owns that state). A ride with no map location has no pin —
 * the dialog's list says "no map location" beside it.
 */

export interface DispatchStop {
  id: string;
  label: string;
  point: GeoPoint | null;
}

export function DispatchMap({
  direction,
  store,
  stops,
  onStopClick,
  className,
  interactive = true,
}: {
  direction: RideDirection;
  store: { name: string; point: GeoPoint | null } | null;
  stops: DispatchStop[];
  onStopClick?: (id: string) => void;
  className?: string;
  interactive?: boolean;
}) {
  const markers: MapMarker[] = [];
  if (store?.point) markers.push({ id: 'store', kind: 'store', ...store.point, label: store.name });
  let n = 0;
  for (const s of stops) {
    n += 1;
    if (s.point) markers.push({ id: s.id, kind: 'stop', ...s.point, order: n, label: `${n}. ${s.label}` });
  }
  const line: Array<[number, number]> = stops.filter((s) => s.point).map((s) => [s.point!.lng, s.point!.lat]);
  if (store?.point) {
    if (direction === 'TO_WORK') line.push([store.point.lng, store.point.lat]);
    else line.unshift([store.point.lng, store.point.lat]);
  }
  if (markers.length === 0) return null;
  return (
    <LazyLiveMap
      ariaLabel="Pickups on the map, in order"
      className={className ?? 'h-60 w-full'}
      markers={markers}
      route={line.length > 1 ? line : undefined}
      onMarkerClick={onStopClick ? (id) => id !== 'store' && onStopClick(id) : undefined}
      controls={interactive}
      interactive={interactive}
      cooperativeGestures
    />
  );
}
