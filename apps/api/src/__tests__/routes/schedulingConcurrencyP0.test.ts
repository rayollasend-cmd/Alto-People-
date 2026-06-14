/**
 * Audit P0 fixes (2026-06-14): /assign refuses to double-book an associate
 * into overlapping shifts, and PATCH can't move a PUBLISHED shift inside the
 * 14-day fair-workweek window without a late-notice reason.
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

const at = (d: Date) => d.toISOString();

describe('audit P0 — double-booking + fair-workweek bypass', () => {
  it('refuses to assign an associate to a shift overlapping one they already have', async () => {
    const client = await createClient();
    const assoc = await createAssociate({ firstName: 'Booked', lastName: 'Twice' });
    const start = new Date(Date.now() + 60 * 60_000);
    const end = new Date(start.getTime() + 8 * 60 * 60_000);
    const mk = () =>
      prisma.shift.create({
        data: {
          clientId: client.id,
          position: 'Server',
          startsAt: start,
          endsAt: end,
          status: 'OPEN',
          publishedAt: new Date(),
        },
      });
    const shiftA = await mk();
    const shiftB = await mk(); // same window

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const agent = await loginAs(hr.email);

    const a = await agent.post(`/scheduling/shifts/${shiftA.id}/assign`).send({ associateId: assoc.id });
    expect(a.status).toBe(200);

    const b = await agent.post(`/scheduling/shifts/${shiftB.id}/assign`).send({ associateId: assoc.id });
    expect(b.status).toBe(409);
    expect(b.body.error?.code).toBe('associate_double_booked');

    // shiftB stays unassigned.
    const after = await prisma.shift.findUniqueOrThrow({ where: { id: shiftB.id } });
    expect(after.assignedAssociateId).toBeNull();
  });

  it('blocks moving a published shift into the 14-day window without a reason', async () => {
    // NY is a covered fair-workweek state.
    const client = await prisma.client.create({
      data: { name: 'NY Co', industry: 'hospitality', status: 'ACTIVE', state: 'NY' },
    });
    const farOut = new Date(Date.now() + 20 * 24 * 60 * 60_000);
    const shift = await prisma.shift.create({
      data: {
        clientId: client.id,
        position: 'Server',
        startsAt: farOut,
        endsAt: new Date(farOut.getTime() + 8 * 60 * 60_000),
        status: 'OPEN',
        publishedAt: new Date(),
      },
    });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const agent = await loginAs(hr.email);

    // Pull the start to 3 days out (inside the window) with no reason → 400.
    const soon = new Date(Date.now() + 3 * 24 * 60 * 60_000);
    const res = await agent.patch(`/scheduling/shifts/${shift.id}`).send({
      startsAt: at(soon),
      endsAt: at(new Date(soon.getTime() + 8 * 60 * 60_000)),
    });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('late_notice_reason_required');

    // With a reason it goes through.
    const ok = await agent.patch(`/scheduling/shifts/${shift.id}`).send({
      startsAt: at(soon),
      endsAt: at(new Date(soon.getTime() + 8 * 60 * 60_000)),
      lateNoticeReason: 'Associate volunteered to cover a sick call.',
    });
    expect(ok.status).toBe(200);
  });
});
