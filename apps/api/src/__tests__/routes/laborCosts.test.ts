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
      data: { clientId: client.id, position: 'Cashier', payRate: 10, billRate: 21 },
    });
    // Server is a LEAD position — drives the lead/associate split.
    await prisma.shiftPosition.create({
      data: { clientId: client.id, name: 'Server', sortOrder: 1, isLead: true },
    });
    // Floor target: 1 expected head, effective before the day under test.
    await prisma.staffingTarget.create({
      data: {
        locationId: loc.id,
        targetCount: 1,
        effectiveFrom: new Date('2026-03-01T00:00:00.000Z'),
      },
    });
    const lead = await createAssociate({ firstName: 'Lead', lastName: 'Head' });
    const worker = await createAssociate({ firstName: 'Reg', lastName: 'Head' });

    // Explicit rates: 4h × $20 pay = $80; 4h × $30 bill = $120. Assigned →
    // one lead head.
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
        hourlyRate: 30,
        assignedAssociateId: lead.id,
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
    // No explicit or default rates: a NON-lead position falls back to the
    // org-wide $15 associate pay and $21.21 SOW bill rate (2h → $30 pay,
    // $42.42 bill). Assigned → one regular-associate head; heads 2 vs
    // target 1 = over by 1.
    await prisma.shift.create({
      data: {
        clientId: client.id,
        locationId: loc.id,
        position: 'Greeter',
        startsAt: at(14),
        endsAt: at(16),
        status: 'OPEN',
        publishedAt: new Date(),
        assignedAssociateId: worker.id,
      },
    });
    // A LEAD position without rates: pay stays UNPRICED (no fallback —
    // supervisors must never be silently costed at the associate rate),
    // but billing falls back to the SOW lead rate ($24.24 × 3h = $72.72).
    await prisma.shiftPosition.create({
      data: { clientId: client.id, name: 'Shift Lead', sortOrder: 2, isLead: true },
    });
    await prisma.shift.create({
      data: {
        clientId: client.id,
        locationId: loc.id,
        position: 'Shift Lead',
        startsAt: at(14),
        endsAt: at(17),
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
    expect(row.scheduledShifts).toBe(4);
    expect(row.scheduledMinutes).toBe(900);
    // Server $80 + Cashier $60 + Greeter $30 (org fallback); the rate-less
    // LEAD shift contributes $0 and the only no-rate flag.
    expect(row.scheduledCost).toBe(170);
    expect(row.scheduledNoRate).toBe(1);
    expect(row.workedPunches).toBe(1);
    expect(row.workedMinutes).toBe(270);
    expect(row.workedCost).toBe(67.5);
    expect(row.workedNoRate).toBe(0);
    // Heads vs the store's effective-dated target.
    expect(row.scheduledHeads).toBe(2);
    expect(row.targetHeads).toBe(1);
    // Lead/associate split by position flag: Server + Shift Lead (4h+3h,
    // $80 costed) vs Cashier + Greeter (6h/$60 + 2h/$30).
    expect(row.leadHeads).toBe(1);
    expect(row.associateHeads).toBe(1);
    expect(row.leadMinutes).toBe(420);
    expect(row.leadCost).toBe(80);
    expect(row.associateMinutes).toBe(480);
    expect(row.associateCost).toBe(90);
    // Revenue: Server 4h × $30 (own bill rate) + Cashier 6h × $21 (default
    // billRate) + Greeter 2h × $21.21 (SOW associate fallback) + Shift
    // Lead 3h × $24.24 (SOW lead fallback).
    expect(row.scheduledRevenue).toBe(361.14);
    expect(row.revenueNoRate).toBe(0);
  });

  it('staffing targets: set + read current, effective-dated per day', async () => {
    const client = await createClient('Targeted LLC');
    const loc = await prisma.location.findFirstOrThrow({ where: { clientId: client.id } });
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);

    // Set 6 effective the day under test; then 4 effective the day after.
    await a
      .post('/scheduling/staffing-targets')
      .send({ locationId: loc.id, targetCount: 6, effectiveFrom: DAY })
      .expect(201);
    await a
      .post('/scheduling/staffing-targets')
      .send({ locationId: loc.id, targetCount: 4, effectiveFrom: '2026-03-04' })
      .expect(201);

    // A per-shift window rides alongside the totals.
    await a
      .post('/scheduling/staffing-targets')
      .send({
        locationId: loc.id,
        targetCount: 2,
        label: 'Morning',
        startMinute: 360,
        endMinute: 840,
      })
      .expect(201);

    // The listing shows the CURRENT target (both are in the past → 4 wins)
    // plus the window.
    const list = await a.get('/scheduling/staffing-targets');
    expect(list.status).toBe(200);
    const row = list.body.locations.find(
      (l: { locationId: string }) => l.locationId === loc.id,
    );
    expect(row.targetCount).toBe(4);
    expect(row.effectiveFrom).toBe('2026-03-04');
    expect(row.windows).toHaveLength(1);
    expect(row.windows[0]).toMatchObject({
      label: 'Morning',
      startMinute: 360,
      endMinute: 840,
      targetCount: 2,
    });

    // But the report judges 2026-03-03 by the target that applied THEN.
    const assoc = await createAssociate();
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
        assignedAssociateId: assoc.id,
      },
    });
    const report = await a.get(
      `/scheduling/labor-costs?from=${RANGE.from}&to=${RANGE.to}`,
    );
    expect(report.body.rows[0].targetHeads).toBe(6);
  });

  it('floor-now compares clocked-in against the current shift window, else the total', async () => {
    const client = await createClient('LiveCo');
    const loc = await prisma.location.findFirstOrThrow({ where: { clientId: client.id } });
    await prisma.staffingTarget.create({
      data: { locationId: loc.id, targetCount: 5, effectiveFrom: new Date('2026-01-01T00:00:00Z') },
    });
    // A window straddling the store's local time RIGHT NOW (±60 min, wrap-
    // safe) so the live board must pick it over the total.
    const tz = loc.timezone ?? 'America/New_York';
    const hm = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date());
    const [hh, mm] = hm.split(':').map(Number);
    const cur = hh * 60 + mm;
    await prisma.staffingTarget.create({
      data: {
        locationId: loc.id,
        targetCount: 2,
        effectiveFrom: new Date('2026-01-02T00:00:00Z'),
        label: 'Now',
        startMinute: (cur - 60 + 1440) % 1440,
        endMinute: (cur + 60) % 1440,
      },
    });
    const a1 = await createAssociate();
    const a2 = await createAssociate();
    for (const assoc of [a1, a2]) {
      await prisma.timeEntry.create({
        data: {
          associateId: assoc.id,
          clientId: client.id,
          locationId: loc.id,
          clockInAt: new Date(),
          status: 'ACTIVE',
        },
      });
    }

    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);
    const res = await a.get('/scheduling/floor-now');
    expect(res.status).toBe(200);
    const row = res.body.rows.find(
      (r: { locationId: string }) => r.locationId === loc.id,
    );
    expect(row.clockedIn).toBe(2);
    expect(row.windowLabel).toBe('Now');
    expect(row.expected).toBe(2);
    expect(row.totalTarget).toBe(5);
  });

  it('staffing targets clamp: a supervisor sees and sets only their own client', async () => {
    const mine = await createClient('Mine LLC');
    const other = await createClient('Other Corp');
    const otherLoc = await prisma.location.findFirstOrThrow({ where: { clientId: other.id } });
    const { user: sup } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: mine.id });
    const a = await loginAs(sup.email);

    const list = await a.get('/scheduling/staffing-targets');
    expect(list.status).toBe(200);
    expect(
      list.body.locations.every((l: { clientId: string }) => l.clientId === mine.id),
    ).toBe(true);

    await a
      .post('/scheduling/staffing-targets')
      .send({ locationId: otherLoc.id, targetCount: 3 })
      .expect(404);
    expect(await prisma.staffingTarget.count()).toBe(0);
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
