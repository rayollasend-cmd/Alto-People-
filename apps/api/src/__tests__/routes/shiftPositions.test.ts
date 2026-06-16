import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_TEST_PASSWORD,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';
import { DEFAULT_SHIFT_POSITIONS } from '../../lib/shiftPositions.js';

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function hrAgent() {
  const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
  const a = agent();
  await loginAs(a, user.email, DEFAULT_TEST_PASSWORD);
  return a;
}

describe('POST /clients auto-seed', () => {
  it('seeds the default shift-position catalog for a new client', async () => {
    const a = await hrAgent();
    const created = await a.post('/clients').send({ name: 'Fresh Grocer' });
    expect(created.status).toBe(201);

    const list = await a.get(`/org/shift-positions?clientId=${created.body.id}`);
    expect(list.status).toBe(200);
    expect(list.body.shiftPositions).toHaveLength(DEFAULT_SHIFT_POSITIONS.length);
    expect(list.body.shiftPositions.map((p: { name: string }) => p.name)).toEqual([
      ...DEFAULT_SHIFT_POSITIONS,
    ]);
    // Returned in sortOrder, ascending and contiguous from 0.
    expect(list.body.shiftPositions.map((p: { sortOrder: number }) => p.sortOrder)).toEqual(
      DEFAULT_SHIFT_POSITIONS.map((_, i) => i),
    );
  });
});

describe('Shift position CRUD', () => {
  it('creates, lists (client-scoped), updates, and soft-deletes', async () => {
    const a = await hrAgent();
    // createClient() inserts directly (no route), so no auto-seed — clean slate.
    const clientA = await createClient('Store A');
    const clientB = await createClient('Store B');

    const created = await a
      .post('/org/shift-positions')
      .send({ clientId: clientA.id, name: 'F&D Morning Shift' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      clientId: clientA.id,
      name: 'F&D Morning Shift',
      sortOrder: 0,
    });

    // Scoped to the requested client only.
    await a.post('/org/shift-positions').send({ clientId: clientB.id, name: 'GM Overnight Shift' });
    const listA = await a.get(`/org/shift-positions?clientId=${clientA.id}`);
    expect(listA.body.shiftPositions).toHaveLength(1);
    expect(listA.body.shiftPositions[0].name).toBe('F&D Morning Shift');

    // Rename.
    const updated = await a
      .put(`/org/shift-positions/${created.body.id}`)
      .send({ name: 'F&D Early Shift' });
    expect(updated.status).toBe(200);
    expect(updated.body.name).toBe('F&D Early Shift');

    // Soft-delete drops it from the list.
    const del = await a.delete(`/org/shift-positions/${created.body.id}`);
    expect(del.status).toBe(204);
    const afterDelete = await a.get(`/org/shift-positions?clientId=${clientA.id}`);
    expect(afterDelete.body.shiftPositions).toHaveLength(0);
  });

  it('rejects a duplicate name within the same client', async () => {
    const a = await hrAgent();
    const client = await createClient('Store C');
    await a.post('/org/shift-positions').send({ clientId: client.id, name: 'Deli Morning Shift' });
    const dup = await a
      .post('/org/shift-positions')
      .send({ clientId: client.id, name: 'Deli Morning Shift' });
    expect(dup.status).toBe(409);
  });

  it('auto-increments sortOrder so new rows land at the end', async () => {
    const a = await hrAgent();
    const client = await createClient('Store D');
    const first = await a
      .post('/org/shift-positions')
      .send({ clientId: client.id, name: 'A' });
    const second = await a
      .post('/org/shift-positions')
      .send({ clientId: client.id, name: 'B' });
    expect(first.body.sortOrder).toBe(0);
    expect(second.body.sortOrder).toBe(1);
  });

  it('denies an ASSOCIATE from managing positions', async () => {
    const client = await createClient('Store E');
    const { user } = await createUser({ role: 'ASSOCIATE' });
    const a = agent();
    await loginAs(a, user.email, DEFAULT_TEST_PASSWORD);
    const res = await a
      .post('/org/shift-positions')
      .send({ clientId: client.id, name: 'X' });
    expect(res.status).toBe(403);
  });
});
