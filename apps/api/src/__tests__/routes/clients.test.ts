import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import {
  DEFAULT_TEST_PASSWORD,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

const app = () => createApp();

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function loginAndGetClients(email: string) {
  const a = request.agent(app());
  const login = await a
    .post('/auth/login')
    .send({ email, password: DEFAULT_TEST_PASSWORD });
  if (login.status !== 200) {
    throw new Error(`login failed: ${login.status} ${JSON.stringify(login.body)}`);
  }
  return a.get('/clients');
}

describe('GET /clients', () => {
  it('returns 401 without a session', async () => {
    const res = await request(app()).get('/clients');
    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('unauthenticated');
  });

  it('HR_ADMINISTRATOR sees every client', async () => {
    const a = await createClient('Aurora Resorts');
    const b = await createClient('Bayside Hotels');
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });

    const res = await loginAndGetClients(user.email);
    expect(res.status).toBe(200);
    const ids = res.body.clients.map((c: { id: string }) => c.id).sort();
    expect(ids).toEqual([a.id, b.id].sort());
  });

  it('CLIENT_PORTAL is denied (does not have view:clients capability)', async () => {
    // The capability matrix in @alto-people/shared/roles.ts intentionally
    // does NOT grant view:clients to CLIENT_PORTAL — they're scoped to
    // their own client through every domain route, not the clients list.
    // The scopeClients() helper still defends in depth.
    const a = await createClient('Aurora Resorts');
    await createClient('Bayside Hotels');
    const { user } = await createUser({ role: 'CLIENT_PORTAL', clientId: a.id });

    const res = await loginAndGetClients(user.email);
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('forbidden');
  });

  it('ASSOCIATE is denied (no view:clients capability)', async () => {
    await createClient('Aurora Resorts');
    const { user } = await createUser({ role: 'ASSOCIATE' });

    const res = await loginAndGetClients(user.email);
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('forbidden');
  });
});

describe('Location timezone', () => {
  it('defaults to Eastern, accepts an explicit zone on create/update, rejects unknown', async () => {
    const client = await createClient('Beachside Co');
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = request.agent(app());
    await a
      .post('/auth/login')
      .send({ email: hr.email, password: DEFAULT_TEST_PASSWORD });

    // Omitted → DB default (Eastern). This is exactly what left the Panhandle
    // sites mis-zoned before the picker existed.
    const def = await a.post(`/clients/${client.id}/locations`).send({ name: 'HQ' });
    expect(def.status).toBe(201);
    expect(def.body.timezone).toBe('America/New_York');

    // Explicit Central (Panama City Beach et al. are Central, not Eastern).
    const central = await a.post(`/clients/${client.id}/locations`).send({
      name: 'Panama City Beach',
      city: 'Panama City Beach',
      state: 'FL',
      timezone: 'America/Chicago',
    });
    expect(central.status).toBe(201);
    expect(central.body.timezone).toBe('America/Chicago');

    // Update can re-zone an existing (mis-defaulted) site.
    const updated = await a
      .patch(`/clients/${client.id}/locations/${def.body.id}`)
      .send({ name: 'HQ', timezone: 'America/Chicago' });
    expect(updated.status).toBe(200);
    expect(updated.body.timezone).toBe('America/Chicago');

    // List reflects the new zones (the client may also have an auto-created
    // default location, so check our two by id rather than the whole set).
    const list = await a.get(`/clients/${client.id}/locations`);
    const byId: Record<string, string> = Object.fromEntries(
      list.body.locations.map((l: { id: string; timezone: string }) => [
        l.id,
        l.timezone,
      ]),
    );
    expect(byId[def.body.id]).toBe('America/Chicago');
    expect(byId[central.body.id]).toBe('America/Chicago');

    // Unknown zone is rejected by the enum.
    const bad = await a
      .post(`/clients/${client.id}/locations`)
      .send({ name: 'Bad', timezone: 'Mars/Phobos' });
    expect(bad.status).toBe(400);
  });
});
