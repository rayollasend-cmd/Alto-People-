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
type SearchLookup = (q: string, near: GeoPoint | null) => Promise<AddressSuggestion[]>;

/**
 * One candidate address, with coordinates already attached.
 *
 * The whole point of picking over typing: a suggestion carries its own
 * point, so a booking made from one can never land in the van list
 * unmappable. `precision` says how much to trust the pin — 'approximate'
 * means the provider interpolated along a street or only got as far as the
 * block, which is where the rider gets asked to confirm on a map.
 */
export interface AddressSuggestion {
  /** The headline — usually the street line. */
  label: string;
  /** The full one-line address, stored on the ride. */
  address: string;
  lat: number;
  lng: number;
  precision: 'exact' | 'approximate';
}

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

/** "382 Flamingo Drive, Destin, Florida 32541" — the line a driver reads,
 *  rather than Nominatim's "382, Flamingo Drive, …, Okaloosa County, …". */
function streetLine(a: Record<string, string>): string | null {
  const street = [a.house_number, a.road].filter(Boolean).join(' ');
  const city = a.city ?? a.town ?? a.village ?? a.hamlet ?? '';
  const parts = [street, city, [a.state, a.postcode].filter(Boolean).join(' ')].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

const nominatimReverse: ReverseLookup = (p) =>
  nominatimPaced(async () => {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&lat=${p.lat}&lon=${p.lng}`;
    const row = (await getJson(url, { 'User-Agent': USER_AGENT })) as {
      address?: Record<string, string>;
      display_name?: string;
    };
    return (row.address && streetLine(row.address)) ?? row.display_name ?? null;
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

/**
 * Mapbox's forward geocoder in autocomplete mode.
 *
 * `proximity` is the store the rider is booking against, which is what
 * makes "1500 nw 7" return the one down the road rather than an identical
 * street four states away. `types` keeps it to things a van can pull up
 * to. `accuracy` is the provider grading its own answer: rooftop and
 * parcel mean it found the building, anything else means it guessed along
 * a line and the rider should see a map.
 */
const mapboxSearch: SearchLookup = async (q, near) => {
  const params = new URLSearchParams({
    q,
    limit: '6',
    country: 'us',
    autocomplete: 'true',
    types: 'address,street,poi',
    access_token: env.MAPBOX_TOKEN ?? '',
  });
  if (near) params.set('proximity', `${near.lng},${near.lat}`);
  const body = (await getJson(
    `https://api.mapbox.com/search/geocode/v6/forward?${params.toString()}`,
  )) as {
    features?: Array<{
      geometry: { coordinates: [number, number] };
      properties: {
        name?: string;
        full_address?: string;
        place_formatted?: string;
        feature_type?: string;
        coordinates?: { accuracy?: string };
      };
    }>;
  };
  const EXACT = new Set(['rooftop', 'parcel', 'point']);
  return (body.features ?? []).flatMap((f) => {
    const [lng, lat] = f.geometry.coordinates;
    const address = f.properties.full_address ?? f.properties.name;
    if (!address || !Number.isFinite(lat) || !Number.isFinite(lng)) return [];
    const acc = f.properties.coordinates?.accuracy;
    return [{
      label: f.properties.name ?? address,
      address,
      lat,
      lng,
      precision: (f.properties.feature_type === 'address' && acc && EXACT.has(acc)
        ? 'exact'
        : 'approximate') as AddressSuggestion['precision'],
    }];
  });
};

/**
 * Nominatim's search, paced through the same one-per-second queue as every
 * other call to it. Their usage policy asks for that explicitly and also
 * discourages per-keystroke autocomplete, which is why the route debounces
 * hard before ever getting here.
 */
const nominatimSearch: SearchLookup = (q, near) =>
  nominatimPaced(async () => {
    const params = new URLSearchParams({
      format: 'jsonv2',
      limit: '6',
      countrycodes: 'us',
      addressdetails: '1',
      q,
    });
    if (near) {
      // A degree of latitude is ~69 miles; this box is the surrounding
      // ~35 miles, biased but not bounded, so a genuine out-of-area match
      // can still surface below the local ones.
      const d = 0.5;
      params.set('viewbox', `${near.lng - d},${near.lat + d},${near.lng + d},${near.lat - d}`);
    }
    const rows = (await getJson(
      `https://nominatim.openstreetmap.org/search?${params.toString()}`,
      { 'User-Agent': USER_AGENT },
    )) as Array<{
      lat: string;
      lon: string;
      display_name?: string;
      name?: string;
      addresstype?: string;
      address?: Record<string, string>;
    }>;
    return rows.flatMap((r) => {
      const lat = Number(r.lat);
      const lng = Number(r.lon);
      const a = r.address ?? {};
      // A place on a road reads as a street address; a town or a park,
      // which has none, keeps the provider's own name for itself.
      const address = (a.road ? streetLine(a) : null) ?? r.display_name;
      if (!address || !Number.isFinite(lat) || !Number.isFinite(lng)) return [];
      const street = [a.house_number, a.road].filter(Boolean).join(' ');
      return [{
        label: street || r.name || address.split(',')[0]!,
        address,
        lat,
        lng,
        // house_number present means it resolved to a building, not a road.
        precision: (a.house_number ? 'exact' : 'approximate') as AddressSuggestion['precision'],
      }];
    });
  });

let testLookup: Lookup | null = null;
let testReverse: ReverseLookup | null = null;
let testSearch: SearchLookup | null = null;

/** Tests: answer lookups in-process (null restores the configured provider). */
export function setGeocoderForTests(
  lookup: Lookup | null,
  reverse: ReverseLookup | null = null,
  search: SearchLookup | null = null,
): void {
  testLookup = lookup;
  testReverse = reverse;
  testSearch = search;
}

function provider(): {
  name: string;
  lookup: Lookup | null;
  reverse: ReverseLookup | null;
  search: SearchLookup | null;
} {
  if (testLookup || testReverse || testSearch) {
    return { name: 'test', lookup: testLookup, reverse: testReverse, search: testSearch };
  }
  const name = geocoderName();
  if (name === 'nominatim') {
    return { name, lookup: nominatim, reverse: nominatimReverse, search: nominatimSearch };
  }
  if (name === 'mapbox') {
    return { name, lookup: mapbox, reverse: mapboxReverse, search: mapboxSearch };
  }
  return { name, lookup: null, reverse: null, search: null };
}

/**
 * Candidate addresses for a partial query — the picker's supply.
 *
 * Cached in-process rather than in GeoCache: that table answers "where is
 * this exact address", keyed by the normalized full string, and a partial
 * query is a different question with a different answer shape. A rider
 * typing "1500 nw 7th" sends four or five requests that all want the same
 * list, and every one of them is billed by Mapbox and rate-limited by
 * Nominatim, so a short memory pays for itself immediately. Small and
 * time-boxed — suggestions aren't worth persisting past the booking.
 */
const SEARCH_TTL_MS = 5 * 60_000;
const SEARCH_CACHE_MAX = 300;
const searchCache = new Map<string, { at: number; results: AddressSuggestion[] }>();

/**
 * "Apt 2", "#2", "Unit B" — taken off before the lookup, put back after.
 *
 * No geocoder knows which door in a building is whose, and Nominatim
 * misreads the attempt outright: "382 Flamingo Dr Unit B" finds nothing,
 * "…Apt 2" drops to the bare street, and "…#2" comes back as 2 Flamingo
 * Drive — a different house, graded exact, so not even the pin step
 * catches it. Riders in apartments type their unit because the driver
 * needs it. So the search gets the building and the address keeps the
 * unit.
 *
 * The unit itself must hold a digit or be a single letter, so a street
 * that merely contains one of these words ("Lot Rd", "Suite Dr") stays a
 * street.
 */
const UNIT =
  /(?:^|[\s,]+)((?:apt|apartment|apto|unit|ste|suite|lot|bldg|building|rm|room|trlr|spc)(?:\.?\s*#\s*|\.\s*|\s+)(?:[a-z]?-?\d[a-z0-9-]*|[a-z])|#\s*[a-z0-9][a-z0-9-]*)(?=$|[\s,])/gi;

export function splitUnit(query: string): { street: string; unit: string | null } {
  const units: string[] = [];
  const street = query
    .replace(UNIT, (_m, u: string) => {
      units.push(u.replace(/\s+/g, ' '));
      return ' ';
    })
    .replace(/\s+,/g, ',')
    .replace(/,+/g, ',')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,]+|[\s,]+$/g, '');
  return { street, unit: units.length ? units.join(' ') : null };
}

/** The unit back on the street line, where a driver reads for it. */
function withUnit(s: AddressSuggestion, unit: string): AddressSuggestion {
  const label = `${s.label} ${unit}`;
  return {
    ...s,
    label,
    address: s.address.startsWith(s.label) ? label + s.address.slice(s.label.length) : `${unit}, ${s.address}`,
  };
}

export async function searchAddresses(
  query: string,
  near?: GeoPoint | null,
): Promise<AddressSuggestion[]> {
  const { street: q, unit } = splitUnit(query.trim());
  // Below four characters everything matches and nothing is useful — and
  // on Nominatim it would burn the one-per-second budget on noise.
  if (q.length < 4) return [];
  const key = `${normalizeAddress(q)}|${near ? `${near.lat.toFixed(2)},${near.lng.toFixed(2)}` : ''}`;
  const hit = searchCache.get(key);
  let results: AddressSuggestion[];
  if (hit && Date.now() - hit.at < SEARCH_TTL_MS) {
    results = hit.results;
  } else {
    const p = provider();
    if (!p.search) return [];
    try {
      results = await p.search(q, near ?? null);
    } catch (err) {
      // An outage means "no suggestions right now", not "no such address" —
      // so it isn't cached, and the caller falls back to letting them drop
      // a pin instead.
      console.warn('[alto-people/api] address search failed:', (err as Error).message);
      return [];
    }
    if (searchCache.size >= SEARCH_CACHE_MAX) {
      // Oldest insertion first — Map preserves it, and this runs rarely.
      const oldest = searchCache.keys().next().value;
      if (oldest !== undefined) searchCache.delete(oldest);
    }
    searchCache.set(key, { at: Date.now(), results });
  }
  return unit ? results.map((r) => withUnit(r, unit)) : results;
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
  let point: GeoPoint | null;
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
