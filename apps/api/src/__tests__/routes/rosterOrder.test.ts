import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

/**
 * Scheduling grid row order — the supervisor's whiteboard order, saved
 * per client and applied to /scheduling/associates: positioned rows
 * first, unpositioned people keep the alphabetical tail.
 */

const app = () => createApp();

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app());
  const r = await a
    .post('/auth/login')
    .send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`loginAs failed: ${r.status}`);
  return a;
}

async function hire(clientId: string, firstName: string, lastName: string) {
  const a = await createAssociate({ firstName, lastName });
  await prisma.application.create({
    data: {
      associateId: a.id,
      clientId,
      onboardingTrack: 'STANDARD',
      status: 'APPROVED',
    },
  });
  return a;
}

describe('scheduling roster order', () => {
  it('saved order leads the roster; unpositioned people keep the alphabetical tail', async () => {
    const client = await createClient();
    const alice = await hire(client.id, 'Alice', 'Anders');
    const bob = await hire(client.id, 'Bob', 'Baker');
    const cara = await hire(client.id, 'Cara', 'Cruz');

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const agent = await loginAs(hr.email);

    // Default: alphabetical.
    const before = await agent.get(`/scheduling/associates?clientId=${client.id}`);
    expect(before.body.associates.map((a: { id: string }) => a.id)).toEqual([
      alice.id,
      bob.id,
      cara.id,
    ]);

    // Supervisor's order: Cara first, then Alice — Bob left unpositioned.
    expect(
      (
        await agent
          .post('/scheduling/roster-order')
          .send({ clientId: client.id, orderedIds: [cara.id, alice.id] })
      ).status,
    ).toBe(200);
    const after = await agent.get(`/scheduling/associates?clientId=${client.id}`);
    expect(after.body.associates.map((a: { id: string }) => a.id)).toEqual([
      cara.id,
      alice.id,
      bob.id, // unpositioned → alphabetical tail
    ]);
  });

  it('anchor move repositions one person and leaves everyone else in place', async () => {
    const client = await createClient();
    const alice = await hire(client.id, 'Alice', 'Anders');
    const bob = await hire(client.id, 'Bob', 'Baker');
    const cara = await hire(client.id, 'Cara', 'Cruz');
    const dana = await hire(client.id, 'Dana', 'Diaz');

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const agent = await loginAs(hr.email);

    // From plain alphabetical order, move Cara above Alice — as if the
    // scheduler only had a filtered view showing those two.
    expect(
      (
        await agent
          .post('/scheduling/roster-order')
          .send({ clientId: client.id, moveId: cara.id, beforeId: alice.id })
      ).status,
    ).toBe(200);
    let r = await agent.get(`/scheduling/associates?clientId=${client.id}`);
    expect(r.body.associates.map((a: { id: string }) => a.id)).toEqual([
      cara.id,
      alice.id,
      bob.id,
      dana.id, // untouched tail keeps its place
    ]);

    // Now move Bob below Dana; the Cara/Alice order must survive.
    expect(
      (
        await agent
          .post('/scheduling/roster-order')
          .send({ clientId: client.id, moveId: bob.id, afterId: dana.id })
      ).status,
    ).toBe(200);
    r = await agent.get(`/scheduling/associates?clientId=${client.id}`);
    expect(r.body.associates.map((a: { id: string }) => a.id)).toEqual([
      cara.id,
      alice.id,
      dana.id,
      bob.id,
    ]);
  });

  it('anchor move rejects people who are not on the roster', async () => {
    const client = await createClient();
    const other = await createClient();
    const here = await hire(client.id, 'On', 'Roster');
    const elsewhere = await hire(other.id, 'Not', 'Here');
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const agent = await loginAs(hr.email);
    expect(
      (
        await agent
          .post('/scheduling/roster-order')
          .send({ clientId: client.id, moveId: elsewhere.id, beforeId: here.id })
      ).status,
    ).toBe(404);
  });

  it('a bounded supervisor cannot reorder another client', async () => {
    const mine = await createClient();
    const other = await createClient();
    const a = await hire(other.id, 'Not', 'Mine');
    const { user: sup } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: mine.id });
    const agent = await loginAs(sup.email);
    expect(
      (
        await agent
          .post('/scheduling/roster-order')
          .send({ clientId: other.id, orderedIds: [a.id] })
      ).status,
    ).toBe(403);
  });
});
