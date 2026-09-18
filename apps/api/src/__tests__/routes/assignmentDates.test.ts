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
 * Regression: closing an AssociateAssignment with a date earlier than its
 * start violated the `AssociateAssignment_dates_chk` CHECK constraint and
 * surfaced as a raw Postgres 23514 — a 500 with nothing in it to act on.
 *
 * Production shape: assignment started 2026-09-07, separation completed
 * with a last day worked of 2026-08-24.
 *
 * Every flow that closes an open assignment now validates first and
 * answers 400 `assignment_date_conflict`, naming both dates.
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
  if (r.status !== 200) {
    throw new Error(`loginAs(${email}) failed: ${r.status}`);
  }
  return a;
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** Associate with one open assignment starting on `startedAt`. */
async function placedAssociate(startedAt: Date) {
  const client = await createClient();
  const location = await prisma.location.findFirstOrThrow({
    where: { clientId: client.id },
  });
  const associate = await createAssociate();
  await prisma.associateAssignment.create({
    data: { associateId: associate.id, locationId: location.id, startedAt },
  });
  return { associate, location, client };
}

describe('assignment date guards', () => {
  it('refuses a separation whose last day worked precedes the assignment start', async () => {
    // Assignment opens two weeks out; last day worked a week ago.
    const start = new Date(Date.now() + 14 * 86_400_000);
    const { associate } = await placedAssociate(start);
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const res = await a.post('/separations').send({
      associateId: associate.id,
      reason: 'VOLUNTARY_OTHER_OPPORTUNITY',
      lastDayWorked: ymd(new Date(Date.now() - 7 * 86_400_000)),
    });

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('assignment_date_conflict');
    expect(res.body.error?.message).toMatch(/after the last day worked/);
    // Nothing was written.
    expect(await prisma.separation.count()).toBe(0);
    const open = await prisma.associateAssignment.findFirst({
      where: { associateId: associate.id, endedAt: null },
    });
    expect(open).not.toBeNull();
  });

  it('refuses reversed notice / last day / final paycheck dates', async () => {
    const { associate } = await placedAssociate(
      new Date(Date.now() - 60 * 86_400_000),
    );
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const backwards = await a.post('/separations').send({
      associateId: associate.id,
      reason: 'VOLUNTARY_OTHER_OPPORTUNITY',
      noticeDate: ymd(new Date(Date.now() + 10 * 86_400_000)),
      lastDayWorked: ymd(new Date(Date.now() + 2 * 86_400_000)),
    });
    expect(backwards.status).toBe(400);
    expect(backwards.body.error?.code).toBe('invalid_date_range');

    const earlyCheck = await a.post('/separations').send({
      associateId: associate.id,
      reason: 'VOLUNTARY_OTHER_OPPORTUNITY',
      lastDayWorked: ymd(new Date(Date.now() + 10 * 86_400_000)),
      finalPaycheckDate: ymd(new Date(Date.now() + 2 * 86_400_000)),
    });
    expect(earlyCheck.status).toBe(400);
    expect(earlyCheck.body.error?.code).toBe('invalid_date_range');
  });

  it('closes the assignment normally when the dates run forward', async () => {
    const { associate } = await placedAssociate(
      new Date(Date.now() - 60 * 86_400_000),
    );
    const lastDay = ymd(new Date(Date.now() - 1 * 86_400_000));
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const created = await a.post('/separations').send({
      associateId: associate.id,
      reason: 'VOLUNTARY_OTHER_OPPORTUNITY',
      lastDayWorked: lastDay,
    });
    expect(created.status).toBe(201);

    // PLANNED → IN_PROGRESS → COMPLETE; the close happens on COMPLETE.
    await a.post(`/separations/${created.body.id}/advance`).send({});
    const done = await a
      .post(`/separations/${created.body.id}/advance`)
      .send({});
    expect(done.status).toBe(200);

    const row = await prisma.associateAssignment.findFirstOrThrow({
      where: { associateId: associate.id },
    });
    expect(row.endedAt).not.toBeNull();
    expect(ymd(row.endedAt!)).toBe(lastDay);
  });

  it('refuses a transfer dated before the current assignment started', async () => {
    const { associate, client } = await placedAssociate(
      new Date(Date.now() + 14 * 86_400_000),
    );
    const second = await prisma.location.create({
      data: { clientId: client.id, name: 'Back of House' },
    });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const res = await a.post(`/org/associates/${associate.id}/transfer`).send({
      locationId: second.id,
      startedAt: ymd(new Date(Date.now() - 7 * 86_400_000)),
    });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('assignment_date_conflict');
    expect(res.body.error?.message).toMatch(/after the transfer date/);
    expect(
      await prisma.associateAssignment.count({
        where: { associateId: associate.id },
      }),
    ).toBe(1);
  });
});
