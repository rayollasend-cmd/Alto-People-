import type { GeoPoint } from './geocode.js';
import { haversineM } from './transportLive.js';

/**
 * Pickups, clustered — the driver's stops for one shift.
 *
 * Two riders within a short walk of each other are one stop: the van pulls
 * over once and both get on. Everything inside a cluster is listed, so the
 * driver still sees each address (and can drive the block if the walk is
 * on the long side).
 *
 * Order: for a run TO work, farthest from the store first, then always the
 * nearest next — the van fills as it closes on the store, exactly the rule
 * dispatch plans with. Coming home, the reverse: nearest drop first.
 *
 * Riders whose address has no point yet (the geocoder missed, or it's a
 * brand-new address) can't be placed on the map; they group by address
 * text instead and come back `mapped: false`, so the driver can drop the
 * pin once and it's remembered.
 */

/** Riders within this of each other share one stop. */
export const CLUSTER_RADIUS_M = 400;

export interface ClusterMember {
  rideId: string;
  associateId: string;
  name: string;
  /** Where they said to meet — a named stop, or their address. */
  label: string;
  address: string;
  point: GeoPoint | null;
  /** The coordinates are the rider's or a stop's, not a lookup's guess. */
  pinned: boolean;
  status: string;
}

export interface RideCluster {
  key: string;
  /** The named stop, else the street the addresses share, else the first. */
  label: string;
  address: string;
  point: GeoPoint | null;
  /** 1-based, in the order the van should work them. */
  order: number;
  riders: ClusterMember[];
  /** How far apart the addresses in this cluster are, in meters. */
  spreadM: number;
  /** Has a point: it can be drawn, and driven to. */
  mapped: boolean;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** "7215 Thomas Dr, Panama City Beach, FL" → "Thomas Dr". */
function street(address: string): string | null {
  const first = address.split(',')[0]?.trim();
  if (!first) return null;
  const named = first.replace(/^\d+[a-z]?\s+/i, '').trim();
  return named.length >= 3 && named !== first.trim() ? named : null;
}

/**
 * What to call a stop: a named pickup point if anyone chose one, else the
 * street when the addresses share it ("Thomas Dr" for three houses on it),
 * else the first address.
 */
function labelFor(riders: ClusterMember[]): string {
  const named = riders.find((r) => r.label && r.address && norm(r.label) !== norm(r.address));
  if (named) return named.label;
  const streets = riders.map((r) => street(r.address || r.label));
  if (riders.length > 1 && streets[0] && streets.every((x) => x && norm(x) === norm(streets[0]!))) return streets[0]!;
  return riders[0]?.label || riders[0]?.address || '';
}

function centroid(points: GeoPoint[]): GeoPoint {
  return {
    lat: points.reduce((s, p) => s + p.lat, 0) / points.length,
    lng: points.reduce((s, p) => s + p.lng, 0) / points.length,
  };
}

/**
 * Group riders into stops. Greedy and deterministic: each rider joins the
 * first cluster whose center is within `radiusM`, else opens one.
 */
export function clusterMembers(members: ClusterMember[], radiusM = CLUSTER_RADIUS_M): RideCluster[] {
  const clusters: Array<RideCluster & { points: GeoPoint[] }> = [];
  const byStop = new Map<string, number>();

  for (const m of members) {
    // A named stop is a stop: everyone who chose it belongs together.
    const stopKey = m.point ? null : `addr:${norm(m.address || m.label)}`;
    if (!m.point) {
      const seen = stopKey ? byStop.get(stopKey) : undefined;
      if (seen !== undefined) {
        clusters[seen]!.riders.push(m);
        continue;
      }
      clusters.push({
        key: stopKey ?? `ride:${m.rideId}`,
        label: m.label || m.address,
        address: m.address,
        point: null,
        order: 0,
        riders: [m],
        spreadM: 0,
        mapped: false,
        points: [],
      });
      if (stopKey) byStop.set(stopKey, clusters.length - 1);
      continue;
    }
    const near = clusters.find((c) => c.point && haversineM(c.point, m.point!) <= radiusM);
    if (near) {
      near.riders.push(m);
      near.points.push(m.point);
      near.point = centroid(near.points);
      near.spreadM = Math.round(Math.max(...near.points.map((p) => haversineM(near.point!, p))) * 2);
      continue;
    }
    clusters.push({
      key: `pt:${m.point.lat.toFixed(4)},${m.point.lng.toFixed(4)}`,
      label: m.label || m.address,
      address: m.address,
      point: m.point,
      order: 0,
      riders: [m],
      spreadM: 0,
      mapped: true,
      points: [m.point],
    });
  }
  return clusters.map(({ points: _points, ...c }) => ({ ...c, label: labelFor(c.riders) }));
}

/**
 * The order to work the stops: away from the store first and inward for a
 * pickup run, nearest-first coming home. Unmapped stops keep their place at
 * the end — nobody can route to what has no pin yet.
 */
export function orderClusters(clusters: RideCluster[], store: GeoPoint | null, direction: 'TO_WORK' | 'FROM_WORK'): RideCluster[] {
  const mapped = clusters.filter((c) => c.point);
  const rest = clusters.filter((c) => !c.point);
  let route: RideCluster[] = [];
  if (!store || mapped.length === 0) {
    route = mapped;
  } else if (direction === 'FROM_WORK') {
    // Leaving the store: drop the nearest first, working outward.
    route = [...mapped].sort((a, b) => haversineM(store, a.point!) - haversineM(store, b.point!));
  } else {
    // Start at the farthest rider, then always hop to the nearest one left.
    const left = [...mapped].sort((a, b) => haversineM(store, b.point!) - haversineM(store, a.point!));
    let at = left.shift()!;
    route = [at];
    while (left.length > 0) {
      left.sort((a, b) => haversineM(at.point!, a.point!) - haversineM(at.point!, b.point!));
      at = left.shift()!;
      route.push(at);
    }
  }
  return [...route, ...rest].map((c, i) => ({ ...c, order: i + 1 }));
}

/** Both steps, as the driver's view needs them. */
export function clusterAndOrder(
  members: ClusterMember[],
  store: GeoPoint | null,
  direction: 'TO_WORK' | 'FROM_WORK',
  radiusM = CLUSTER_RADIUS_M,
): RideCluster[] {
  return orderClusters(clusterMembers(members, radiusM), store, direction);
}
