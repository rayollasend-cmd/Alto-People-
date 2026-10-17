import { env } from '../config/env.js';
import type { GeoPoint } from './geocode.js';

/**
 * Road-network routing for the vans — Mapbox, when the API has a token.
 *
 *   legDurations   how long each hop of an ordered route takes on the road
 *                  right now (Directions, driving-traffic) — what the live
 *                  map promises riders and supervisors, instead of a
 *                  straight line × 1.35 at 25 mph.
 *   optimizeOrder  the shortest order to work a set of stops (Optimization
 *                  v1), with the first and/or last point fixed — the
 *                  dispatch planner's order, instead of nearest-next.
 *
 * Both answer null whenever routing is off, the request fails or the stop
 * count is past what the API takes in one call; every caller keeps its own
 * heuristic for exactly that case, so a Mapbox outage degrades to the
 * estimate it had before, never to an error. Answers are remembered for
 * ROUTE_CACHE_MS keyed on the rounded coordinates: a run's map is read
 * every 15 seconds by several people and the road does not change that
 * fast. Tests inject a fake with setRoutingForTests.
 */

export interface RouteLegs {
  /** Seconds per hop: legs[i] is point i → point i + 1. */
  seconds: number[];
  /** Metres per hop. */
  metres: number[];
}

export type LegsLookup = (points: GeoPoint[]) => Promise<RouteLegs | null>;
export type OrderLookup = (points: GeoPoint[], opts: { fixStart: boolean; fixEnd: boolean }) => Promise<number[] | null>;

/** The Directions API takes up to 25 coordinates a call. */
const MAX_DIRECTIONS_POINTS = 25;
/** The Optimization v1 API takes up to 12 coordinates a call. */
const MAX_OPTIMIZE_POINTS = 12;
const ROUTE_CACHE_MS = 10 * 60_000;
const CACHE_MAX = 500;
const TIMEOUT_MS = 4_000;

let testLegs: LegsLookup | null | undefined;
let testOrder: OrderLookup | null | undefined;

/** Tests: inject a fake (or `null` for "routing off"); `undefined` restores the real one. */
export function setRoutingForTests(legs: LegsLookup | null | undefined, order: OrderLookup | null | undefined = legs === undefined ? undefined : null): void {
  testLegs = legs;
  testOrder = order;
  cache.clear();
}

export function routingAvailable(): boolean {
  if (testLegs !== undefined) return testLegs !== null;
  return !!env.MAPBOX_TOKEN && env.GEOCODER !== 'off' && process.env.NODE_ENV !== 'test';
}

const cache = new Map<string, { at: number; value: unknown }>();

function remember<T>(key: string, value: T, now = Date.now()): T {
  if (cache.size >= CACHE_MAX) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) cache.delete(oldest[0]);
  }
  cache.set(key, { at: now, value });
  return value;
}

function recall<T>(key: string, now = Date.now()): T | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (now - hit.at > ROUTE_CACHE_MS) {
    cache.delete(key);
    return undefined;
  }
  return hit.value as T;
}

const coordKey = (p: GeoPoint) => `${p.lng.toFixed(4)},${p.lat.toFixed(4)}`;
const coordPath = (points: GeoPoint[]) => points.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');

async function getJson(url: string): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: ctrl.signal });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const mapboxLegs: LegsLookup = async (points) => {
  if (points.length < 2) return { seconds: [], metres: [] };
  // Past the API's limit, walk the route in overlapping windows.
  if (points.length > MAX_DIRECTIONS_POINTS) {
    const seconds: number[] = [];
    const metres: number[] = [];
    for (let i = 0; i < points.length - 1; i += MAX_DIRECTIONS_POINTS - 1) {
      const part = await mapboxLegs(points.slice(i, i + MAX_DIRECTIONS_POINTS));
      if (!part) return null;
      seconds.push(...part.seconds);
      metres.push(...part.metres);
    }
    return { seconds, metres };
  }
  const url =
    `https://api.mapbox.com/directions/v5/mapbox/driving-traffic/${coordPath(points)}` +
    `?overview=false&steps=false&access_token=${env.MAPBOX_TOKEN}`;
  const body = (await getJson(url)) as { routes?: Array<{ legs?: Array<{ duration?: number; distance?: number }> }> } | null;
  const legs = body?.routes?.[0]?.legs;
  if (!legs || legs.length !== points.length - 1) return null;
  return {
    seconds: legs.map((l) => Math.max(0, Math.round(l.duration ?? 0))),
    metres: legs.map((l) => Math.max(0, Math.round(l.distance ?? 0))),
  };
};

const mapboxOrder: OrderLookup = async (points, opts) => {
  if (points.length < 3) return points.map((_, i) => i);
  if (points.length > MAX_OPTIMIZE_POINTS) return null;
  const q = new URLSearchParams({
    roundtrip: 'false',
    source: opts.fixStart ? 'first' : 'any',
    destination: opts.fixEnd ? 'last' : 'any',
    overview: 'false',
    steps: 'false',
    access_token: env.MAPBOX_TOKEN ?? '',
  });
  const url = `https://api.mapbox.com/optimized-trips/v1/mapbox/driving/${coordPath(points)}?${q.toString()}`;
  const body = (await getJson(url)) as { code?: string; waypoints?: Array<{ waypoint_index?: number }> } | null;
  if (!body || body.code !== 'Ok' || !body.waypoints || body.waypoints.length !== points.length) return null;
  // waypoints[i].waypoint_index is input point i's place in the trip.
  const order: number[] = new Array(points.length);
  for (const [i, w] of body.waypoints.entries()) {
    if (typeof w.waypoint_index !== 'number') return null;
    order[w.waypoint_index] = i;
  }
  return order.every((x) => typeof x === 'number') ? order : null;
};

/** Seconds and metres for each hop of `points`, in order; null when routing is off or failed. */
export async function legDurations(points: GeoPoint[], now = Date.now()): Promise<RouteLegs | null> {
  if (!routingAvailable()) return null;
  const key = `legs:${points.map(coordKey).join(';')}`;
  const hit = recall<RouteLegs | null>(key, now);
  if (hit !== undefined) return hit;
  const lookup = testLegs ?? mapboxLegs;
  return remember(key, await lookup(points), now);
}

/**
 * The order to visit `points` (indices into the input). With `fixStart` the
 * first point stays first; with `fixEnd` the last stays last. Null when
 * routing is off, failed, or there are too many points for one call.
 */
export async function optimizeOrder(points: GeoPoint[], opts: { fixStart: boolean; fixEnd: boolean }, now = Date.now()): Promise<number[] | null> {
  if (!routingAvailable()) return null;
  const key = `order:${opts.fixStart ? 's' : ''}${opts.fixEnd ? 'e' : ''}:${points.map(coordKey).join(';')}`;
  const hit = recall<number[] | null>(key, now);
  if (hit !== undefined) return hit;
  const lookup = testOrder ?? mapboxOrder;
  return remember(key, await lookup(points, opts), now);
}
