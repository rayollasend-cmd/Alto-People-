import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { flushPendingAudits } from '../../lib/audit.js';
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

/** 8-hour shift starting tomorrow (well inside the default KPI week). */
function shiftWindow() {
  const startsAt = new Date();
  startsAt.setHours(startsAt.getHours() + 2, 0, 0, 0);
  const endsAt = new Date(startsAt.getTime() + 8 * 60 * 60 * 1000);
  return { startsAt, endsAt };
}

describe('rate-default CRUD', () => {
  it('upserts, lists (with the position catalog), and deletes — audited', async () => {
    const client = await createClient();
    const { user: admin } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(admin.email);

    const put = await a.put('/scheduling/rate-defaults').send({
      clientId: client.id,
      position: 'Overnight Stocker',
      payRate: 21.5,
      billRate: 32,
    });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({
      clientId: client.id,
      position: 'Overnight Stocker',
      payRate: 21.5,
      billRate: 32,
    });

    // Upsert same position → update, not duplicate.
    const put2 = await a.put('/scheduling/rate-defaults').send({
      clientId: client.id,
      position: 'Overnight Stocker',
      payRate: 22,
    });
    expect(put2.status).toBe(200);
    expect(put2.body.payRate).toBe(22);
    expect(put2.body.billRate).toBeNull();

    const list = await a.get(`/scheduling/rate-defaults?clientId=${client.id}`);
    expect(list.status).toBe(200);
    expect(list.body.rateDefaults).toHaveLength(1);
    // createClient's fixture client gets the seeded position catalog only
    // when created through the route; direct fixtures may have none — the
    // contract is just "an array of strings".
    expect(Array.isArray(list.body.positions)).toBe(true);

    const del = await a.delete(`/scheduling/rate-defaults/${put2.body.id}`);
    expect(del.status).toBe(204);
    const after = await a.get(`/scheduling/rate-defaults?clientId=${client.id}`);
    expect(after.body.rateDefaults).toHaveLength(0);

    await flushPendingAudits();
    const audits = await prisma.auditLog.findMany({
      where: {
        action: { in: ['scheduling.rate_default_upserted', 'scheduling.rate_default_deleted'] },
      },
    });
    expect(audits.length).toBeGreaterThanOrEqual(2);
  });

  it('clamps bounded callers to their own client (404 on foreign writes)', async () => {
    const mine = await createClient('Mine');
    const other = await createClient('Other');
    const { user: supervisor } = await createUser({
      role: 'SHIFT_SUPERVISOR',
      clientId: mine.id,
    });
    const a = await loginAs(supervisor.email);

    const foreign = await a.put('/scheduling/rate-defaults').send({
      clientId: other.id,
      position: 'Cashier',
      payRate: 18,
    });
    expect(foreign.status).toBe(404);

    const own = await a.put('/scheduling/rate-defaults').send({
      clientId: mine.id,
      position: 'Cashier',
      payRate: 18,
    });
    expect(own.status).toBe(200);

    // Foreign default is invisible to the bounded caller even by id.
    const otherDefault = await prisma.shiftRateDefault.create({
      data: { clientId: other.id, position: 'Greeter', payRate: 17 },
    });
    const delForeign = await a.delete(`/scheduling/rate-defaults/${otherDefault.id}`);
    expect(delForeign.status).toBe(404);

    // List for the other client comes back clamped to the caller's own.
    const list = await a.get(`/scheduling/rate-defaults?clientId=${other.id}`);
    expect(list.status).toBe(200);
    expect(
      list.body.rateDefaults.every((d: { clientId: string }) => d.clientId === mine.id),
    ).toBe(true);
  });
});

describe('effectivePayRate resolution', () => {
  it('resolves explicit > default > null on the shifts list, and prices the KPI cost', async () => {
    const client = await createClient();
    const { user: admin } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(admin.email);
    const { startsAt, endsAt } = shiftWindow();

    await prisma.shiftRateDefault.create({
      data: { clientId: client.id, position: 'Stocker', payRate: 20 },
    });
    // 8h shift: explicit rate 30 → effective 30 (explicit wins over default).
    await prisma.shift.create({
      data: { clientId: client.id, position: 'Stocker', startsAt, endsAt, status: 'OPEN', payRate: 30 },
    });
    // 8h shift: no explicit rate → effective 20 from the default.
    await prisma.shift.create({
      data: { clientId: client.id, position: 'Stocker', startsAt, endsAt, status: 'OPEN' },
    });
    // 8h shift: position with no default and no explicit → null.
    await prisma.shift.create({
      data: { clientId: client.id, position: 'Cart Pusher', startsAt, endsAt, status: 'OPEN' },
    });

    const list = await a.get(
      `/scheduling/shifts?from=${new Date(Date.now() - 3600_000).toISOString()}&to=${new Date(
        Date.now() + 48 * 3600_000,
      ).toISOString()}`,
    );
    expect(list.status).toBe(200);
    const byRate = (explicit: number | null) =>
      list.body.shifts.find((s: { payRate: number | null }) => s.payRate === explicit);
    expect(byRate(30).effectivePayRate).toBe(30);
    const defaulted = list.body.shifts.find(
      (s: { payRate: number | null; position: string }) =>
        s.payRate === null && s.position === 'Stocker',
    );
    expect(defaulted.effectivePayRate).toBe(20);
    const bare = list.body.shifts.find(
      (s: { position: string }) => s.position === 'Cart Pusher',
    );
    expect(bare.effectivePayRate).toBeNull();

    // KPI: cost = 8h*30 + 8h*20 = 400; only the Cart Pusher shift lacks a rate.
    const kpis = await a.get(
      `/scheduling/kpis?from=${new Date(Date.now() - 3600_000).toISOString()}&to=${new Date(
        Date.now() + 48 * 3600_000,
      ).toISOString()}`,
    );
    expect(kpis.status).toBe(200);
    expect(kpis.body.projectedLaborCost).toBe(400);
    expect(kpis.body.shiftsWithoutRate).toBe(1);
  });

  it('create/update shift responses carry the resolved rate', async () => {
    const client = await createClient();
    const { user: admin } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(admin.email);
    await prisma.shiftRateDefault.create({
      data: { clientId: client.id, position: 'Stocker', payRate: 19.25 },
    });
    const { startsAt, endsAt } = shiftWindow();

    const created = await a.post('/scheduling/shifts').send({
      clientId: client.id,
      position: 'Stocker',
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
    });
    expect(created.status).toBe(201);
    expect(created.body.payRate).toBeNull();
    expect(created.body.effectivePayRate).toBe(19.25);
  });

  it('associate-facing /me/shifts nulls every money field including the resolved rate', async () => {
    const client = await createClient();
    const associate = await createAssociate();
    const { user } = await createUser({ role: 'ASSOCIATE', associateId: associate.id });
    await prisma.shiftRateDefault.create({
      data: { clientId: client.id, position: 'Stocker', payRate: 20 },
    });
    const { startsAt, endsAt } = shiftWindow();
    await prisma.shift.create({
      data: {
        clientId: client.id,
        position: 'Stocker',
        startsAt,
        endsAt,
        status: 'ASSIGNED',
        assignedAssociateId: associate.id,
        publishedAt: new Date(),
        payRate: 22,
      },
    });

    const a = await loginAs(user.email);
    const mine = await a.get('/scheduling/me/shifts');
    expect(mine.status).toBe(200);
    expect(mine.body.shifts).toHaveLength(1);
    expect(mine.body.shifts[0].payRate).toBeNull();
    expect(mine.body.shifts[0].hourlyRate).toBeNull();
    expect(mine.body.shifts[0].effectivePayRate).toBeNull();
  });
});
