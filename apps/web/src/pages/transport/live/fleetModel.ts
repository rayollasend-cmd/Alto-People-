import type { FleetVan, TransportException, TransportExceptionSeverity } from '@alto-people/shared';
import type { RunMap } from '@/lib/transportApi';
import { STUCK_RUN_MINUTES } from '@/lib/format';
import type { MapMarker, MapRoute, MarkerTone } from '@/components/transport/LazyLiveMap';

/**
 * The desk's fleet, as the map and the list read it (2026-10-28) — pure,
 * so every state → marker → row rule is tested on its own.
 *
 * Lateness has one scale everywhere: under 5 minutes is on time (the
 * contract's "late" exception starts at 5), 5–14 is late (caution), 15 or
 * more is very late (negative).
 */

export const LATE_MINUTES = 5;
export const VERY_LATE_MINUTES = 15;

export type LateTone = 'positive' | 'caution' | 'negative';

export function lateTone(lateMinutes: number | null | undefined): LateTone {
  const m = Math.max(0, Math.round(lateMinutes ?? 0));
  return m >= VERY_LATE_MINUTES ? 'negative' : m >= LATE_MINUTES ? 'caution' : 'positive';
}

/** The list's four groups, in the order the desk reads them. */
export type FleetGroup = 'road' | 'later' | 'idle' | 'out';
export const FLEET_GROUPS: FleetGroup[] = ['road', 'later', 'idle', 'out'];

export function fleetGroup(v: Pick<FleetVan, 'state'>): FleetGroup {
  switch (v.state) {
    case 'on_road':
    case 'no_signal':
      return 'road';
    case 'planned':
      return 'later';
    case 'out_of_service':
      return 'out';
    default:
      return 'idle';
  }
}

/** What a van's chip says — one state, the most urgent first. */
export type VanStatus =
  | { kind: 'sos' }
  | { kind: 'not_closed' }
  | { kind: 'no_signal'; minutes: number | null }
  | { kind: 'late'; minutes: number; tone: 'caution' | 'negative' }
  | { kind: 'on_time' }
  | { kind: 'leaves'; at: string }
  /** Planned, its departure has passed, and it hasn't started. */
  | { kind: 'not_left'; at: string; minutes: number }
  | { kind: 'idle' }
  | { kind: 'out' };

export interface VanExtras {
  /** An unacknowledged SOS on its run. */
  sos?: boolean;
  /** Left on the road hours past its last stop (the live board's `stuck`). */
  stuck?: boolean;
  /** The clock (tests pin it). */
  now?: number;
}

export function vanStatus(v: FleetVan, extras: VanExtras = {}): VanStatus {
  const group = fleetGroup(v);
  if (group === 'road') {
    if (extras.sos) return { kind: 'sos' };
    const late = Math.max(0, Math.round(v.run?.lateMinutes ?? 0));
    if (extras.stuck || late >= STUCK_RUN_MINUTES) return { kind: 'not_closed' };
    if (v.state === 'no_signal') return { kind: 'no_signal', minutes: v.positionAgeMinutes };
    const tone = lateTone(late);
    return tone === 'positive' ? { kind: 'on_time' } : { kind: 'late', minutes: late, tone };
  }
  if (group === 'later') {
    if (!v.nextRun) return { kind: 'idle' };
    const overdue = minutesSince(v.nextRun.departAt, extras.now ?? Date.now()) ?? 0;
    return overdue >= 1 ? { kind: 'not_left', at: v.nextRun.departAt, minutes: overdue } : { kind: 'leaves', at: v.nextRun.departAt };
  }
  if (group === 'out') return { kind: 'out' };
  return { kind: 'idle' };
}

export type ChipVariant = 'success' | 'pending' | 'destructive' | 'info' | 'default';

/** The Badge variant for a status: the palette's chip recipe, a dot on every status. */
export function statusVariant(s: VanStatus): ChipVariant {
  switch (s.kind) {
    case 'sos':
      return 'destructive';
    case 'late':
      return s.tone === 'negative' ? 'destructive' : 'pending';
    case 'not_closed':
    case 'no_signal':
    case 'not_left':
      return 'pending';
    case 'on_time':
      return 'success';
    case 'leaves':
      return 'info';
    default:
      return 'default';
  }
}

/** The marker's look for a van — null when it has never reported a position. */
export function vanMarker(v: FleetVan, opts: { selected?: boolean; label: string; extras?: VanExtras }): MapMarker | null {
  if (!v.position) return null;
  const base: MapMarker = {
    id: vanMarkerId(v.vanId),
    kind: 'van',
    lat: v.position.lat,
    lng: v.position.lng,
    label: opts.label,
    tag: shortName(v.name),
    highlight: !!opts.selected,
  };
  switch (v.state) {
    case 'on_road': {
      const tone: MarkerTone = opts.extras?.sos ? 'negative' : lateTone(v.run?.lateMinutes);
      return { ...base, tone, heading: v.position.heading };
    }
    case 'no_signal':
      return { ...base, hollow: true };
    case 'out_of_service':
      return { ...base, tone: 'neutral', still: true, struck: true };
    case 'planned':
      // Overdue to leave: parked, but in the caution colour.
      return { ...base, tone: vanStatus(v, opts.extras).kind === 'not_left' ? 'caution' : 'neutral', still: true };
    default:
      return { ...base, tone: 'neutral', still: true };
  }
}

export const vanMarkerId = (vanId: string) => `van-${vanId}`;
export const vanIdFromMarker = (id: string) => (id.startsWith('van-') ? id.slice(4) : null);

/** "Van 2" stays "Van 2"; a long name keeps its first 10 characters for the map's tag. */
export function shortName(name: string): string {
  const n = name.trim();
  return n.length <= 10 ? n : `${n.slice(0, 9)}…`;
}

/**
 * Vans parked on one spot (the depot, a store) would stack into one dot:
 * spread each group of co-located vans side by side, in pixels.
 */
export function spreadColocated(markers: MapMarker[], gapPx = 42): MapMarker[] {
  const groups = new Map<string, number[]>();
  markers.forEach((m, i) => {
    if (m.kind !== 'van') return;
    const key = `${m.lat.toFixed(4)},${m.lng.toFixed(4)}`;
    groups.set(key, [...(groups.get(key) ?? []), i]);
  });
  const out = markers.slice();
  for (const idx of groups.values()) {
    if (idx.length < 2) continue;
    idx.forEach((i, k) => {
      out[i] = { ...out[i]!, offset: [Math.round((k - (idx.length - 1) / 2) * gapPx), 0] };
    });
  }
  return out;
}

/** The rest of a run's route, from where the van is through its remaining stops. */
export function remainingRoute(v: FleetVan, live: RunMap | undefined): Array<[number, number]> {
  const coords: Array<[number, number]> = [];
  if (v.position) coords.push([v.position.lng, v.position.lat]);
  for (const w of live?.waypoints ?? []) if (w.point) coords.push([w.point.lng, w.point.lat]);
  return coords;
}

/** One route per van on the road (the selected one bold). */
export function fleetRoutes(vans: FleetVan[], liveByRun: Map<string, RunMap>, selectedVanId: string | null): MapRoute[] {
  const out: MapRoute[] = [];
  for (const v of vans) {
    if (fleetGroup(v) !== 'road' || !v.run) continue;
    const coords = remainingRoute(v, liveByRun.get(v.run.runId));
    if (coords.length < 2) continue;
    out.push({ id: v.run.runId, coords, tone: v.state === 'no_signal' ? 'neutral' : lateTone(v.run.lateMinutes), strong: v.vanId === selectedVanId });
  }
  return out;
}

/** The picked van's remaining stops, numbered, with its store(s). */
export function stopMarkers(live: RunMap | undefined): MapMarker[] {
  if (!live) return [];
  const out: MapMarker[] = [];
  let n = 0;
  live.waypoints.forEach((w, i) => {
    if (!w.point) return;
    if (w.kind === 'store') out.push({ id: `store-${live.runId}-${i}`, kind: 'store', ...w.point, label: w.label });
    else out.push({ id: `stop-${live.runId}-${i}`, kind: 'stop', ...w.point, order: ++n, label: w.label });
  });
  return out;
}

const byName = (a: FleetVan, b: FleetVan) => a.name.localeCompare(b.name, undefined, { numeric: true });

/** The vans in each group, the one that needs the desk first. */
export function groupVans(vans: FleetVan[], sosRuns: Set<string>): Record<FleetGroup, FleetVan[]> {
  const out: Record<FleetGroup, FleetVan[]> = { road: [], later: [], idle: [], out: [] };
  for (const v of vans) out[fleetGroup(v)].push(v);
  out.road.sort((a, b) => {
    const sa = a.run && sosRuns.has(a.run.runId) ? 1 : 0;
    const sb = b.run && sosRuns.has(b.run.runId) ? 1 : 0;
    if (sa !== sb) return sb - sa;
    const la = a.run?.lateMinutes ?? 0;
    const lb = b.run?.lateMinutes ?? 0;
    if (la !== lb) return lb - la;
    return byName(a, b);
  });
  out.later.sort((a, b) => (a.nextRun?.departAt ?? '').localeCompare(b.nextRun?.departAt ?? '') || byName(a, b));
  out.idle.sort(byName);
  out.out.sort(byName);
  return out;
}

/** The runs with an SOS nobody has acknowledged. */
export function sosRunIds(exceptions: TransportException[]): Set<string> {
  return new Set(exceptions.filter((e) => e.kind === 'sos' && e.runId).map((e) => e.runId!));
}

const SEVERITY_RANK: Record<TransportExceptionSeverity, number> = { high: 0, medium: 1, low: 2 };

/** SOS on top, then the contract's order (highest severity first, then oldest) — re-asserted, never trusted blind. */
export function orderExceptions(list: TransportException[]): TransportException[] {
  return list
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      const sa = a.e.kind === 'sos' ? 0 : 1;
      const sb = b.e.kind === 'sos' ? 0 : 1;
      if (sa !== sb) return sa - sb;
      const r = SEVERITY_RANK[a.e.severity] - SEVERITY_RANK[b.e.severity];
      if (r !== 0) return r;
      const t = Date.parse(a.e.at) - Date.parse(b.e.at);
      return Number.isFinite(t) && t !== 0 ? t : a.i - b.i;
    })
    .map((x) => x.e);
}

/** Whole minutes since an instant (never negative). */
export function minutesSince(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 60_000)) : null;
}

/** A phone number a tel: link can dial ("+1 850-555-0100" → "+18505550100"). */
export function telHref(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^\d+]/g, '');
  return digits.replace(/\D/g, '').length >= 7 ? `tel:${digits}` : null;
}
