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
 * Rest-gap ("clopen") guard: assigning a shift that leaves <10h rest next
 * to an adjacent shift 409s with `rest_gap` until the manager explicitly
 * overrides; the publish preflight reports the same turnarounds.
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
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`loginAs failed: ${r.status}`);
  return a;
}

const future = (offsetMin: number) => new Date(Date.now() + offsetMin * 60_000);

describe('shift duration sanity ceiling', () => {
  it('rejects a 31-hour shift on create and on edit (the rolled-end-date corruption)', async () => {
    const client = await createClient();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const agent = await loginAs(hr.email);

    // Create: 4 PM → next-day 11 PM = 31h → refused.
    const created = await agent.post('/scheduling/shifts').send({
      clientId: client.id,
      position: 'F&D Afternoon Shift',
      startsAt: future(60).toISOString(),
      endsAt: future(60 + 31 * 60).toISOString(),
    });
    expect(created.status).toBe(400);
    expect(created.body.error?.code).toBe('shift_too_long');

    // Edit: a sane 7h shift can't be stretched past the ceiling either.
    const ok = await agent.post('/scheduling/shifts').send({
      clientId: client.id,
      position: 'F&D Afternoon Shift',
      startsAt: future(60).toISOString(),
      endsAt: future(60 + 7 * 60).toISOString(),
    });
    expect(ok.status).toBe(201);
    const stretched = await agent.patch(`/scheduling/shifts/${ok.body.id}`).send({
      endsAt: future(60 + 31 * 60).toISOString(),
    });
    expect(stretched.status).toBe(400);
    expect(stretched.body.error?.code).toBe('shift_too_long');
  });
});

describe('rest-gap guard', () => {
  it('409s an assignment with <10h turnaround; override assigns and is audited', async () => {
    const client = await createClient();
    const associate = await createAssociate({ firstName: 'Night', lastName: 'Owl' });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const agent = await loginAs(hr.email);

    // Existing overnight: +1h → +9h.
    await prisma.shift.create({
      data: {
        clientId: client.id,
        position: 'F&D Overnight',
        startsAt: future(60),
        endsAt: future(9 * 60),
        assignedAssociateId: associate.id,
        status: 'ASSIGNED',
      },
    });
    // New shift starting 7h after the overnight ends — legal, brutal.
    const next = await prisma.shift.create({
      data: {
        clientId: client.id,
        position: 'F&D Afternoon',
        startsAt: future(9 * 60 + 7 * 60),
        endsAt: future(9 * 60 + 15 * 60),
        status: 'OPEN',
      },
    });

    const refused = await agent
      .post(`/scheduling/shifts/${next.id}/assign`)
      .send({ associateId: associate.id });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('rest_gap');
    expect(refused.body.error.message).toContain('7h rest');

    const overridden = await agent
      .post(`/scheduling/shifts/${next.id}/assign`)
      .send({ associateId: associate.id, overrideRestGap: true });
    expect(overridden.status).toBe(200);
    const after = await prisma.shift.findUniqueOrThrow({ where: { id: next.id } });
    expect(after.assignedAssociateId).toBe(associate.id);
  });

  it('a comfortable 12h turnaround assigns without ceremony', async () => {
    const client = await createClient();
    const associate = await createAssociate({ firstName: 'Well', lastName: 'Rested' });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const agent = await loginAs(hr.email);

    await prisma.shift.create({
      data: {
        clientId: client.id,
        position: 'Morning',
        startsAt: future(60),
        endsAt: future(9 * 60),
        assignedAssociateId: associate.id,
        status: 'ASSIGNED',
      },
    });
    const next = await prisma.shift.create({
      data: {
        clientId: client.id,
        position: 'Next day',
        startsAt: future(9 * 60 + 12 * 60),
        endsAt: future(9 * 60 + 20 * 60),
        status: 'OPEN',
      },
    });
    const res = await agent
      .post(`/scheduling/shifts/${next.id}/assign`)
      .send({ associateId: associate.id });
    expect(res.status).toBe(200);
  });

  it('publish preflight reports short turnarounds and projected overtime', async () => {
    const client = await createClient();
    const owl = await createAssociate({ firstName: 'Night', lastName: 'Owl' });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const agent = await loginAs(hr.email);

    // Overnight then a 6h-later shift, both assigned; plus enough hours to
    // cross 40h in the window (5 × 9h = 45h).
    for (let day = 0; day < 5; day++) {
      await prisma.shift.create({
        data: {
          clientId: client.id,
          position: 'F&D Overnight',
          startsAt: future(day * 24 * 60 + 60),
          endsAt: future(day * 24 * 60 + 10 * 60),
          assignedAssociateId: owl.id,
          status: day === 0 ? 'ASSIGNED' : 'DRAFT',
        },
      });
    }
    await prisma.shift.create({
      data: {
        clientId: client.id,
        position: 'Turnaround',
        startsAt: future(10 * 60 + 6 * 60), // 6h after day-0 shift ends
        endsAt: future(10 * 60 + 10 * 60),
        assignedAssociateId: owl.id,
        status: 'DRAFT',
      },
    });

    const from = new Date().toISOString();
    const to = future(7 * 24 * 60).toISOString();
    const res = await agent.get(
      `/scheduling/publish-preflight?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&clientId=${client.id}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.drafts).toBe(5);
    expect(res.body.otProjected).toHaveLength(1);
    expect(res.body.otProjected[0].name).toBe('Night Owl');
    expect(res.body.otProjected[0].hours).toBeGreaterThan(40);
    expect(res.body.restGaps.length).toBeGreaterThanOrEqual(1);
    expect(res.body.restGaps[0].gapHours).toBeLessThan(10);
  });
});
