import { prisma } from '../db.js';
import { env } from '../config/env.js';

/**
 * Address → coordinates for the vans' map (pickups, stops, stores).
 *
 * Every answer — found or not — lands in GeoCache keyed by the normalized
 * address, so an address is looked up once, ever: the map never waits on a
 * lookup it already made, and a bad address isn't retried on every refresh
 * (misses are retried after a week, in case it was a provider blip).
 *
 * Providers (env GEOCODER): OpenStreetMap's Nominatim needs no key but asks
 * for at most one request a second and an identifying User-Agent — the
 * calls are serialized here to honor that. Mapbox takes over when a
 * MAPBOX_TOKEN is set. 'off' (the default under NODE_ENV=test) never
 * leaves the process; tests inject a fake with setGeocoderForTests.
 */

export interface GeoPoint {
  lat: number;
  lng: number;
}

type Lookup = (address: string) => Promise<GeoPoint | null>;
type ReverseLookup = (p: GeoPoint) => Promise<string | null>;

const MISS_RETRY_MS = 7 * 86_400_000;
const TIMEOUT_MS = 5_000;
const USER_AGENT = 'AltoPeople/1.0 (transportation; info@altohr.com)';

export function geocoderName(): 'nominatim' | 'mapbox' | 'off' {
  if (env.GEOCODER) return env.GEOCODER === 'mapbox' && !env.MAPBOX_TOKEN ? 'off' : env.GEOCODER;
  if (env.NODE_ENV === 'test') return 'off';
  return env.MAPBOX_TOKEN ? 'mapbox' : 'nominatim';
}

export function normalizeAddress(address: string): string {
  return address.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 300);
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`geocoder ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// Nominatim's usage policy: one request per second, absolute.
let nominatimQueue: Promise<unknown> = Promise.resolve();
let nominatimLast = 0;
function nominatimPaced<T>(fn: () => Promise<T>): Promise<T> {
  const run = nominatimQueue.then(async () => {
    const wait = nominatimLast + 1_100 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    nominatimLast = Date.now();
    return fn();
  });
  nominatimQueue = run.catch(() => undefined);
  return run;
}

const nominatim: Lookup = (address) =>
  nominatimPaced(async () => {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=us&q=${encodeURIComponent(address)}`;
    const rows = (await getJson(url, { 'User-Agent': USER_AGENT })) as Array<{ lat: string; lon: string }>;
    const hit = rows[0];
    return hit ? { lat: Number(hit.lat), lng: Number(hit.lon) } : null;
  });

const nominatimReverse: ReverseLookup = (p) =>
  nominatimPaced(async () => {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&lat=${p.lat}&lon=${p.lng}`;
    const row = (await getJson(url, { 'User-Agent': USER_AGENT })) as {
      address?: Record<string, string>;
      display_name?: string;
    };
    const a = row.address;
    if (!a) return row.display_name ?? null;
    const street = [a.house_number, a.road].filter(Boolean).join(' ');
    const city = a.city ?? a.town ?? a.village ?? a.hamlet ?? '';
    const parts = [street, city, [a.state, a.postcode].filter(Boolean).join(' ')].filter(Boolean);
    return parts.length ? parts.join(', ') : (row.display_name ?? null);
  });

const mapbox: Lookup = async (address) => {
  const url = `https://api.mapbox.com/search/geocode/v6/forward?limit=1&country=us&q=${encodeURIComponent(address)}&access_token=${env.MAPBOX_TOKEN}`;
  const body = (await getJson(url)) as { features?: Array<{ geometry: { coordinates: [number, number] } }> };
  const f = body.features?.[0];
  return f ? { lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] } : null;
};

const mapboxReverse: ReverseLookup = async (p) => {
  const url = `https://api.mapbox.com/search/geocode/v6/reverse?limit=1&longitude=${p.lng}&latitude=${p.lat}&access_token=${env.MAPBOX_TOKEN}`;
  const body = (await getJson(url)) as { features?: Array<{ properties: { full_address?: string; name?: string } }> };
  const f = body.features?.[0];
  return f?.properties.full_address ?? f?.properties.name ?? null;
};

let testLookup: Lookup | null = null;
let testReverse: ReverseLookup | null = null;

/** Tests: answer lookups in-process (null restores the configured provider). */
export function setGeocoderForTests(lookup: Lookup | null, reverse: ReverseLookup | null = null): void {
  testLookup = lookup;
  testReverse = reverse;
}

function provider(): { name: string; lookup: Lookup | null; reverse: ReverseLookup | null } {
  if (testLookup || testReverse) return { name: 'test', lookup: testLookup, reverse: testReverse };
  const name = geocoderName();
  if (name === 'nominatim') return { name, lookup: nominatim, reverse: nominatimReverse };
  if (name === 'mapbox') return { name, lookup: mapbox, reverse: mapboxReverse };
  return { name, lookup: null, reverse: null };
}

/** Coordinates for an address — cached; null when unknown or lookups are off. */
export async function geocode(address: string | null | undefined): Promise<GeoPoint | null> {
  if (!address || address.trim().length < 5) return null;
  const key = normalizeAddress(address);
  const cached = await prisma.geoCache.findUnique({ where: { key } });
  if (cached?.found && cached.lat !== null && cached.lng !== null) {
    return { lat: Number(cached.lat), lng: Number(cached.lng) };
  }
  if (cached && !cached.found && Date.now() - cached.createdAt.getTime() < MISS_RETRY_MS) return null;
  const p = provider();
  if (!p.lookup) return null;
  let point: GeoPoint | null = null;
  try {
    point = await p.lookup(address);
  } catch (err) {
    // A provider outage isn't a miss — don't cache it.
    console.warn('[alto-people/api] geocode failed:', (err as Error).message);
    return null;
  }
  const valid = point && Number.isFinite(point.lat) && Number.isFinite(point.lng) ? point : null;
  await prisma.geoCache.upsert({
    where: { key },
    create: { key, lat: valid?.lat ?? null, lng: valid?.lng ?? null, found: !!valid, provider: p.name },
    update: { lat: valid?.lat ?? null, lng: valid?.lng ?? null, found: !!valid, provider: p.name, createdAt: new Date() },
  });
  return valid;
}

/** "Use where I am now": a street address for a point, or null. */
export async function reverseGeocode(point: GeoPoint): Promise<string | null> {
  const p = provider();
  if (!p.reverse) return null;
  try {
    return await p.reverse(point);
  } catch (err) {
    console.warn('[alto-people/api] reverse geocode failed:', (err as Error).message);
    return null;
  }
}
