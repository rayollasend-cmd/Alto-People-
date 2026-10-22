import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * The driver's fuel receipt photo (transport walk 9 follow-up). It used to
 * be written into the service log's note as "receipt photo: <key>", where
 * no screen could show it. It is the entry's own column now: the fuel
 * route stores it there, the van record and the fleet card hand back a URL
 * the photo route serves, and migration 20270128130001 moved the old note
 * keys across (the statement is replayed here against real rows).
 */

const MIGRATION = fileURLToPath(new URL('../../../prisma/migrations/20270128130001_van_service_receipt_photo/migration.sql', import.meta.url));
const KEY = '0b1c2d3e-0000-4000-8000-00000000000a.jpg';

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(createApp());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`loginAs(${email}) failed: ${r.status}`);
  return a;
}

async function world() {
  const { user: director } = await createUser({ role: 'TRANSPORTATION_DIRECTOR' });
  const mike = await createAssociate({ firstName: 'Mike', lastName: 'Chen' });
  const { user: driver } = await createUser({ role: 'DRIVER', associateId: mike.id });
  const van = await prisma.van.create({ data: { name: 'Van 1', capacity: 12, plate: 'ALT 1', driverUserId: driver.id } });
  return { director, driver, van, directorAgent: await loginAs(director.email), driverAgent: await loginAs(driver.email) };
}

describe('fuel receipt photo', () => {
  it('stores the receipt in its own column (not the note) and the record and fleet card show it', async () => {
    const w = await world();
    const res = await w.driverAgent.post(`/transport/driver/vans/${w.van.id}/fuel`).send({ gallons: 12, costCents: 4_800, photoKey: KEY });
    expect(res.status).toBe(201);
    expect(res.body.entry.photoUrl).toBe(`/transport/photos/${KEY}`);
    const entry = await prisma.vanServiceEntry.findUniqueOrThrow({ where: { id: res.body.entry.id } });
    expect(entry.photoS3Key).toBe(KEY);
    expect(entry.notes).toBe('12 gal');

    const record = (await w.directorAgent.get(`/transport/vans/${w.van.id}/record`)).body;
    const line = record.serviceLog.find((e: { id: string }) => e.id === entry.id);
    expect(line.photoUrl).toBe(`/transport/photos/${KEY}`);

    const fleet = (await w.directorAgent.get('/transport/fleet')).body;
    const card = fleet.vans.find((v: { id: string }) => v.id === w.van.id);
    expect(card.lastFuel).toMatchObject({ costCents: 4_800, photoUrl: `/transport/photos/${KEY}` });
  });

  it('a fill-up without a receipt has no photo; a key the photo route could never serve is refused', async () => {
    const w = await world();
    const plain = await w.driverAgent.post(`/transport/driver/vans/${w.van.id}/fuel`).send({ costCents: 3_000 });
    expect(plain.status).toBe(201);
    expect(plain.body.entry.photoUrl).toBeNull();
    expect((await prisma.vanServiceEntry.findUniqueOrThrow({ where: { id: plain.body.entry.id } })).notes).toBeNull();

    const bad = await w.driverAgent.post(`/transport/driver/vans/${w.van.id}/fuel`).send({ costCents: 3_000, photoKey: '../../etc/passwd' });
    expect(bad.status).toBe(400);

    const fleet = (await w.directorAgent.get('/transport/fleet')).body;
    expect(fleet.vans.find((v: { id: string }) => v.id === w.van.id).lastFuel).toMatchObject({ costCents: 3_000, photoUrl: null });
  });

  it('the migration moves a key out of the note into the column and leaves the rest of the note', async () => {
    const w = await world();
    const mk = (notes: string | null) =>
      prisma.vanServiceEntry.create({ data: { vanId: w.van.id, kind: 'FUEL', occurredAt: new Date('2026-10-01T00:00:00Z'), costCents: 100, notes } });
    const both = await mk(`18.4 gal · receipt photo: ${KEY}`);
    const onlyKey = await mk(`receipt photo: ${KEY}`);
    const noKey = await mk('12 gal');
    const empty = await mk(null);
    // The migration's own data step, read from the file and run as written.
    const sql = readFileSync(MIGRATION, 'utf8');
    const update = sql.slice(sql.indexOf('UPDATE "VanServiceEntry"'), sql.lastIndexOf(';'));
    expect(update).toContain('receipt photo:');
    await prisma.$executeRawUnsafe(update);
    const read = async (id: string) => prisma.vanServiceEntry.findUniqueOrThrow({ where: { id }, select: { notes: true, photoS3Key: true } });
    expect(await read(both.id)).toEqual({ notes: '18.4 gal', photoS3Key: KEY });
    expect(await read(onlyKey.id)).toEqual({ notes: null, photoS3Key: KEY });
    expect(await read(noKey.id)).toEqual({ notes: '12 gal', photoS3Key: null });
    expect(await read(empty.id)).toEqual({ notes: null, photoS3Key: null });
  });
});
