import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { parseAddressLine, setGeocoderForTests, stateCode, type AddressSuggestion, type GeoPoint } from '../../lib/geocode.js';
import { setAddressSuggestLimitForTests } from '../../routes/geo.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * Address search wherever an address is typed (GET /geo/address-suggest).
 *
 * Type-ahead only from a provider built for it (Mapbox in production); an
 * honest { available: false, reason } otherwise, so the form stays plain
 * fields. Staff and associates only, held to a per-user budget, and the
 * query — someone's home address — never reaches the logs. A site's
 * address picked from a suggestion brings its point with it.
 */

const app = () => createApp();

beforeEach(async () => {
  await truncateAll();
  setGeocoderForTests(null);
  setAddressSuggestLimitForTests(null);
});
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  setGeocoderForTests(null);
  setAddressSuggestLimitForTests(null);
  await prisma.$disconnect();
});

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`loginAs(${email}) failed: ${r.status}`);
  return a;
}

async function staff(role: 'HR_ADMINISTRATOR' | 'OPERATIONS_MANAGER' = 'HR_ADMINISTRATOR') {
  const { user } = await createUser({ role });
  return loginAs(user.email);
}

/** Mapbox-shaped: the provider names every part. */
const FLAMINGO: AddressSuggestion = {
  label: '382 Flamingo Drive',
  address: '382 Flamingo Drive, Destin, Florida 32541, United States',
  lat: 30.4012,
  lng: -86.5003,
  precision: 'exact',
  parts: { line1: '382 Flamingo Drive', line2: null, city: 'Destin', state: 'FL', zip: '32541', county: 'Okaloosa County' },
};
/** A row with only the one-line address: the parts are read off it. */
const THOMAS: AddressSuggestion = {
  label: '7209 Thomas Drive',
  address: '7209 Thomas Drive, Panama City Beach, FL 32408',
  lat: 30.1766,
  lng: -85.8055,
  precision: 'approximate',
};

describe('which provider answers', () => {
  it('with no geocoder at all (dev without a key, the tests) it says so and offers nothing', async () => {
    const a = await staff();
    const res = await a.get('/geo/address-suggest?q=382 Flamingo');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: false, reason: 'not_configured', results: [] });
  });

  it('a provider that may not be asked per keystroke (Nominatim) is never asked: no_typeahead', async () => {
    const search = vi.fn(async () => [FLAMINGO]);
    setGeocoderForTests(null, null, search, { typeahead: false });
    const a = await staff();
    const res = await a.get('/geo/address-suggest?q=382 Flamingo');
    expect(res.body).toEqual({ available: false, reason: 'no_typeahead', results: [] });
    expect(search).not.toHaveBeenCalled();
  });

  it('a type-ahead provider (Mapbox) answers, taken apart into line 1, city, state, ZIP and county', async () => {
    const seen: Array<{ q: string; near: GeoPoint | null }> = [];
    setGeocoderForTests(null, null, async (q, near) => {
      seen.push({ q, near });
      return [FLAMINGO, THOMAS];
    });
    const a = await staff();
    const res = await a.get('/geo/address-suggest?q=382 Flamingo&near=30.39,-86.41');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ available: true, provider: 'test', outage: false });
    expect(res.body.results).toEqual([
      {
        label: '382 Flamingo Drive',
        // The country on the end is dropped: every suggestion is in the US.
        address: '382 Flamingo Drive, Destin, Florida 32541',
        line1: '382 Flamingo Drive',
        line2: null,
        city: 'Destin',
        state: 'FL',
        zip: '32541',
        county: 'Okaloosa County',
        lat: 30.4012,
        lng: -86.5003,
        precision: 'exact',
      },
      {
        label: '7209 Thomas Drive',
        address: '7209 Thomas Drive, Panama City Beach, FL 32408',
        line1: '7209 Thomas Drive',
        line2: null,
        city: 'Panama City Beach',
        state: 'FL',
        zip: '32408',
        county: null,
        lat: 30.1766,
        lng: -85.8055,
        precision: 'approximate',
      },
    ]);
    expect(seen).toEqual([{ q: '382 Flamingo', near: { lat: 30.39, lng: -86.41 } }]);
  });

  it('the apartment typed with the street goes to line 2; the building is what gets looked up', async () => {
    const seen: string[] = [];
    setGeocoderForTests(null, null, async (q) => {
      seen.push(q);
      return [FLAMINGO];
    });
    const a = await staff();
    const res = await a.get(`/geo/address-suggest?q=${encodeURIComponent('382 Flamingo Dr Apt 2')}`);
    expect(seen).toEqual(['382 Flamingo Dr']);
    expect(res.body.results[0]).toMatchObject({ line1: '382 Flamingo Drive', line2: 'Apt 2', city: 'Destin', state: 'FL', zip: '32541' });
  });

  it('too short to mean anything: no lookup, no results', async () => {
    const search = vi.fn(async () => [FLAMINGO]);
    setGeocoderForTests(null, null, search);
    const a = await staff();
    const res = await a.get('/geo/address-suggest?q=382');
    expect(res.body).toMatchObject({ available: true, results: [] });
    expect(search).not.toHaveBeenCalled();
  });

  it('a provider outage is "no suggestions right now", and the address typed is not in the log line', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    setGeocoderForTests(null, null, async () => {
      throw new Error('geocoder 503');
    });
    const a = await staff();
    const res = await a.get(`/geo/address-suggest?q=${encodeURIComponent('1500 Secret Lane')}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true, provider: 'test', outage: true, results: [] });
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/secret lane/i);
  });

  it('refuses a malformed query or point', async () => {
    setGeocoderForTests(null, null, async () => [FLAMINGO]);
    const a = await staff();
    expect((await a.get('/geo/address-suggest')).status).toBe(400);
    expect((await a.get('/geo/address-suggest?q=382 Flamingo&near=north')).status).toBe(400);
    expect((await a.get('/geo/address-suggest?q=382 Flamingo&near=95,-86.4')).status).toBe(400);
  });
});

describe('who may ask', () => {
  beforeEach(() => {
    setGeocoderForTests(null, null, async () => [FLAMINGO]);
  });

  it('signed out: 401', async () => {
    expect((await request(app()).get('/geo/address-suggest?q=382 Flamingo')).status).toBe(401);
  });

  it('staff and associates may; a client-portal account (the customer’s, not ours) may not', async () => {
    const client = await createClient('Coastal');
    const kim = await createAssociate({ firstName: 'Kim' });
    const { user: assoc } = await createUser({ role: 'ASSOCIATE', associateId: kim.id });
    const { user: portal } = await createUser({ role: 'CLIENT_PORTAL', clientId: client.id });

    expect((await (await staff('OPERATIONS_MANAGER')).get('/geo/address-suggest?q=382 Flamingo')).status).toBe(200);
    expect((await (await loginAs(assoc.email)).get('/geo/address-suggest?q=382 Flamingo')).status).toBe(200);
    const refused = await (await loginAs(portal.email)).get('/geo/address-suggest?q=382 Flamingo');
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('forbidden');
  });

  it('an associate’s search leans toward the store they work at — their own, not anyone else’s', async () => {
    const seen: Array<GeoPoint | null> = [];
    setGeocoderForTests(null, null, async (_q, near) => {
      seen.push(near);
      return [FLAMINGO];
    });
    const client = await createClient('Coastal');
    const mine = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
    await prisma.site.update({ where: { id: mine.id }, data: { latitude: 30.3925, longitude: -86.4128 } });
    const theirs = await prisma.site.create({ data: { name: 'Far Store', clientId: client.id, latitude: 41.88, longitude: -87.63 } });
    const kim = await createAssociate({ firstName: 'Kim' });
    const lee = await createAssociate({ firstName: 'Lee' });
    await prisma.associateAssignment.create({ data: { associateId: kim.id, locationId: mine.id, startedAt: new Date('2026-01-05') } });
    await prisma.associateAssignment.create({ data: { associateId: lee.id, locationId: theirs.id, startedAt: new Date('2026-01-05') } });
    const { user: kimUser } = await createUser({ role: 'ASSOCIATE', associateId: kim.id });

    await (await loginAs(kimUser.email)).get('/geo/address-suggest?q=382 Flamingo');
    expect(seen).toEqual([{ lat: 30.3925, lng: -86.4128 }]);
    // Staff get no default: their forms say where, when they know.
    await (await staff()).get('/geo/address-suggest?q=382 Flamingo Drive');
    expect(seen[1]).toBeNull();
  });

  it('holds each person to their own budget a minute', async () => {
    setAddressSuggestLimitForTests(3);
    const a = await staff();
    for (let i = 0; i < 3; i += 1) expect((await a.get(`/geo/address-suggest?q=382 Flamingo ${i}`)).status).toBe(200);
    const over = await a.get('/geo/address-suggest?q=382 Flamingo 4');
    expect(over.status).toBe(429);
    expect(over.body.error.code).toBe('rate_limited');
    // Someone else at the same desk is unaffected.
    expect((await (await staff('OPERATIONS_MANAGER')).get('/geo/address-suggest?q=382 Flamingo')).status).toBe(200);
  });
});

describe('a site’s address picked from a suggestion brings its point', () => {
  it('Sites admin: added and edited with the point; half a point is refused; a client’s store still edits on the client', async () => {
    const admin = await staff();
    const made = await admin.post('/admin/sites').send({ name: 'Grand Hotel', addressLine1: '382 Flamingo Drive', city: 'Destin', state: 'FL', zip: '32541', latitude: 30.4012, longitude: -86.5003, timezone: 'America/Chicago' });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const row = await prisma.site.findUniqueOrThrow({ where: { id: made.body.site.id } });
    expect([Number(row.latitude), Number(row.longitude), row.timezone]).toEqual([30.4012, -86.5003, 'America/Chicago']);

    const moved = await admin.patch(`/admin/sites/${row.id}`).send({ addressLine1: '7209 Thomas Drive', city: 'Panama City Beach', zip: '32408', latitude: 30.1766, longitude: -85.8055 });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    const after = await prisma.site.findUniqueOrThrow({ where: { id: row.id } });
    expect([after.addressLine1, Number(after.latitude), Number(after.longitude)]).toEqual(['7209 Thomas Drive', 30.1766, -85.8055]);

    // A typed edit leaves the point alone.
    await admin.patch(`/admin/sites/${row.id}`).send({ name: 'The Grand Hotel' });
    expect(Number((await prisma.site.findUniqueOrThrow({ where: { id: row.id } })).latitude)).toBe(30.1766);

    const half = await admin.patch(`/admin/sites/${row.id}`).send({ latitude: 30.2 });
    expect(half.status).toBe(400);
    expect(half.body.error.code).toBe('invalid_point');

    const client = await createClient('Coastal');
    const store = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
    expect((await admin.patch(`/admin/sites/${store.id}`).send({ latitude: 30.2, longitude: -86.1 })).status).toBe(409);
  });

  it('Org chart: a new store added with a picked address is placed', async () => {
    const admin = await staff();
    const made = await admin.post('/org/structure/sites').send({ name: 'Destin', addressLine1: '382 Flamingo Drive', city: 'Destin', state: 'FL', zip: '32541', latitude: 30.4012, longitude: -86.5003 });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const row = await prisma.site.findUniqueOrThrow({ where: { id: made.body.site.id } });
    expect([Number(row.latitude), Number(row.longitude)]).toEqual([30.4012, -86.5003]);

    // Typed by hand: no point invented.
    const typed = await admin.post('/org/structure/sites').send({ name: 'Typed', addressLine1: '1 Main St', state: 'FL' });
    const t = await prisma.site.findUniqueOrThrow({ where: { id: typed.body.site.id } });
    expect([t.latitude, t.longitude]).toEqual([null, null]);
    expect((await admin.post('/org/structure/sites').send({ name: 'Half', latitude: 30.4 })).status).toBe(400);
  });
});

describe('reading an address apart', () => {
  it('states by code or name; street, city, state and ZIP off one line', () => {
    expect([stateCode('fl'), stateCode('Florida'), stateCode('US-TX'), stateCode('Atlantis'), stateCode(null)]).toEqual(['FL', 'FL', 'TX', null, null]);
    expect(parseAddressLine('382 Flamingo Drive, Destin, Florida 32541, United States')).toEqual({
      line1: '382 Flamingo Drive', line2: null, city: 'Destin', state: 'FL', zip: '32541', county: null,
    });
    expect(parseAddressLine('1500 NW 7th Ave, Miami, FL 33136-1234')).toMatchObject({ line1: '1500 NW 7th Ave', city: 'Miami', state: 'FL', zip: '33136-1234' });
    // No state or ZIP on the end: the street is still the street.
    expect(parseAddressLine('Thomas Drive, Panama City Beach')).toMatchObject({ line1: 'Thomas Drive', city: 'Panama City Beach', state: null, zip: null });
  });
});
