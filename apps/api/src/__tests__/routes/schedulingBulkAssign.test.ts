/**
 * Bulk create-and-assign: POST /scheduling/shifts/bulk stamps one copy of a
 * shift onto each chosen employee (their own row) plus optional open slots,
 * in a single transaction, skipping anyone already scheduled at that time.
 * Reported 2026-06-14.
 */
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
  if (r.status !== 200) {
    throw new Error(`loginAs(${email}) failed: ${r.status} ${JSON.stringify(r.body)}`);
  }
  return a;
}

const future = (offsetMin: number) =>
  new Date(Date.now() + offsetMin * 60_000).toISOString();

describe('POST /scheduling/shifts/bulk — multi-assign', () => {
  it('creates one shift per employee plus open slots, and surfaces them in their rows', async () => {
    const client = await createClient('Walmart Front Beach');
    const a1 = await createAssociate({ firstName: 'Eric', lastName: 'Darkwah' });
    const a2 = await createAssociate({ firstName: 'Barbara', lastName: 'Soto' });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const agent = await loginAs(hr.email);

    const res = await agent.post('/scheduling/shifts/bulk').send({
      clientId: client.id,
      position: 'F&D OVERNIGHT',
      startsAt: future(60),
      endsAt: future(60 * 9),
      associateIds: [a1.id, a2.id],
      openCount: 2,
      status: 'OPEN',
    });
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(4); // 2 assigned + 2 open
    expect(res.body.skipped).toHaveLength(0);

    const a1Shifts = await prisma.shift.count({ where: { assignedAssociateId: a1.id } });
    const a2Shifts = await prisma.shift.count({ where: { assignedAssociateId: a2.id } });
    const open = await prisma.shift.count({ where: { assignedAssociateId: null } });
    expect(a1Shifts).toBe(1);
    expect(a2Shifts).toBe(1);
    expect(open).toBe(2);
  });

  it('skips an employee who already has an overlapping shift instead of double-booking', async () => {
    const client = await createClient('Acme');
    const busy = await createAssociate({ firstName: 'Busy', lastName: 'Bee' });
    const free = await createAssociate({ firstName: 'Free', lastName: 'Bird' });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const agent = await loginAs(hr.email);

    // Pre-existing shift for `busy` that overlaps the bulk window.
    await prisma.shift.create({
      data: {
        clientId: client.id,
        position: 'Cashier',
        startsAt: new Date(future(120)),
        endsAt: new Date(future(60 * 6)),
        assignedAssociateId: busy.id,
        status: 'ASSIGNED',
      },
    });

    const res = await agent.post('/scheduling/shifts/bulk').send({
      clientId: client.id,
      position: 'Cashier',
      startsAt: future(60),
      endsAt: future(60 * 8),
      associateIds: [busy.id, free.id],
      status: 'OPEN',
    });
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(1); // only `free` got one
    expect(res.body.skipped).toHaveLength(1);
    expect(res.body.skipped[0].associateId).toBe(busy.id);
    expect(res.body.skipped[0].reason).toBe('already_scheduled');

    // `busy` still has exactly the one original shift (not double-booked).
    expect(await prisma.shift.count({ where: { assignedAssociateId: busy.id } })).toBe(1);
    expect(await prisma.shift.count({ where: { assignedAssociateId: free.id } })).toBe(1);
  });

  it('rejects a bulk create with no employees and no open slots', async () => {
    const client = await createClient('Acme');
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const agent = await loginAs(hr.email);
    const res = await agent.post('/scheduling/shifts/bulk').send({
      clientId: client.id,
      position: 'Cashier',
      startsAt: future(60),
      endsAt: future(60 * 8),
      associateIds: [],
      openCount: 0,
    });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('invalid_body');
  });
});
