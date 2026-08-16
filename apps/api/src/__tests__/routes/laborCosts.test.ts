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

// Midday-UTC instants so the site-local (America/New_York default) calendar
// day matches the UTC date and assertions stay zone-stable.
const DAY = '2026-03-03';
const at = (hourUtc: number, minute = 0) =>
  new Date(`${DAY}T${String(hourUtc).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`);
const RANGE = {
  from: `${DAY}T00:00:00.000Z`,
  to: '2026-03-05T00:00:00.000Z',
};

describe('GET /scheduling/labor-costs', () => {
  it('prices shifts (explicit rate else default), punches (snapshot), and flags no-rate rows', async () => {
    const client = await createClient('Costed LLC');
    const loc = await prisma.location.findFirstOrThrow({ where: { clientId: client.id } });
    await prisma.shiftRateDefault.create({
      data: { clientId: client.id, position: 'Cashier', payRate: 10 },
    });

    // Explicit rate: 4h × $20 = $80.
    await prisma.shift.create({
      data: {
        clientId: client.id,
        locationId: loc.id,
        position: 'Server',
        startsAt: at(14),
        endsAt: at(18),
        status: 'OPEN',
        publishedAt: new Date(),
        payRate: 20,
      },
    });
    // Default rate (and DRAFT — planned cost counts): 6h × $10 = $60.
    await prisma.shift.create({
      data: {
        clientId: client.id,
        locationId: loc.id,
        position: 'Cashier',
        startsAt: at(12),
        endsAt: at(18),
        status: 'DRAFT',
      },
    });
    // No rate anywhere: 2h, contributes $0 and a warning count.
    await prisma.shift.create({
      data: {
        clientId: client.id,
        locationId: loc.id,
        position: 'Greeter',
        startsAt: at(14),
        endsAt: at(16),
        status: 'OPEN',
        publishedAt: new Date(),
      },
    });
    // Cancelled: invisible to cost.
    await prisma.shift.create({
      data: {
        clientId: client.id,
        locationId: loc.id,
        position: 'Server',
        startsAt: at(14),
        endsAt: at(18),
        status: 'CANCELLED',
        payRate: 99,
      },
    });
    // Worked punch: 5h minus 30m break = 4.5h × $15 = $67.50 (COMPLETED,
    // never approved — recorded time still costs money).
    const assoc = await createAssociate();
    await prisma.timeEntry.create({
      data: {
        associateId: assoc.id,
        clientId: client.id,
        locationId: loc.id,
        clockInAt: at(14),
        clockOutAt: at(19),
        status: 'COMPLETED',
        payRate: 15,
        breaks: { create: { startedAt: at(16), endedAt: at(16, 30) } },
      },
    });

    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);
    const res = await a.get(
      `/scheduling/labor-costs?from=${RANGE.from}&to=${RANGE.to}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.truncated).toBe(false);
    expect(res.body.rows).toHaveLength(1);
    const row = res.body.rows[0];
    expect(row.date).toBe(DAY);
    expect(row.clientName).toBe('Costed LLC');
    expect(row.locationId).toBe(loc.id);
    expect(row.scheduledShifts).toBe(3);
    expect(row.scheduledMinutes).toBe(720);
    expect(row.scheduledCost).toBe(140);
    expect(row.scheduledNoRate).toBe(1);
    expect(row.workedPunches).toBe(1);
    expect(row.workedMinutes).toBe(270);
    expect(row.workedCost).toBe(67.5);
    expect(row.workedNoRate).toBe(0);
  });

  it('clamps a supervisor to their own client, whatever clientId they request', async () => {
    const mine = await createClient('Mine LLC');
    const other = await createClient('Other Corp');
    const mineLoc = await prisma.location.findFirstOrThrow({ where: { clientId: mine.id } });
    const otherLoc = await prisma.location.findFirstOrThrow({ where: { clientId: other.id } });
    await prisma.shift.create({
      data: {
        clientId: mine.id,
        locationId: mineLoc.id,
        position: 'Server',
        startsAt: at(14),
        endsAt: at(18),
        status: 'OPEN',
        publishedAt: new Date(),
        payRate: 20,
      },
    });
    await prisma.shift.create({
      data: {
        clientId: other.id,
        locationId: otherLoc.id,
        position: 'Server',
        startsAt: at(14),
        endsAt: at(18),
        status: 'OPEN',
        publishedAt: new Date(),
        payRate: 50,
      },
    });

    const { user: sup } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: mine.id });
    const a = await loginAs(sup.email);
    const res = await a.get(
      `/scheduling/labor-costs?from=${RANGE.from}&to=${RANGE.to}&clientId=${other.id}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].clientId).toBe(mine.id);
    expect(res.body.rows[0].scheduledCost).toBe(80);
  });
});
