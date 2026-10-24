import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { env } from '../../config/env.js';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

/**
 * "Where the money goes" — the labor-cost report's per-position breakdown.
 * Every row's positions add up to the row itself: minutes exactly, costs
 * to the cent, scheduled and worked alike. A punch takes the position of
 * the shift it fulfilled (its overtime share with it, not spread across
 * the day); a punch tied to no shift is position null ("Unscheduled").
 */

const app = () => createApp();
const T2 = '22222222-2222-4222-8222-222222222222';

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`loginAs(${email}) failed: ${r.status} ${JSON.stringify(r.body)}`);
  return a;
}

// One fixed company week in February (Eastern standard time all week, no
// DST edge): Sat Feb 7 – Fri Feb 13, 2026. 14:00 UTC is 09:00 at the store.
const at = (day: number, hourUtc: number, minute = 0) => new Date(Date.UTC(2026, 1, day, hourUtc, minute));
const RANGE = { from: '2026-02-07T05:00:00.000Z', to: '2026-02-14T05:00:00.000Z' };

interface Pos {
  position: string | null;
  scheduledMinutes: number;
  scheduledCost: number;
  workedMinutes: number;
  workedCost: number;
}
interface Row {
  date: string;
  locationId: string | null;
  scheduledMinutes: number;
  scheduledCost: number;
  workedMinutes: number;
  workedCost: number;
  positions?: Pos[];
}

const cents = (v: number) => Math.round(v * 100);

/** Each side of every row's positions adds up to the row — minutes exactly, money to the cent. */
function expectPositionsAddUp(rows: Row[]) {
  for (const r of rows) {
    const ps = r.positions ?? [];
    expect(ps.reduce((s, p) => s + p.scheduledMinutes, 0), `${r.date} scheduled minutes`).toBe(r.scheduledMinutes);
    expect(ps.reduce((s, p) => s + p.workedMinutes, 0), `${r.date} worked minutes`).toBe(r.workedMinutes);
    expect(ps.reduce((s, p) => s + cents(p.scheduledCost), 0), `${r.date} scheduled cost`).toBe(cents(r.scheduledCost));
    expect(ps.reduce((s, p) => s + cents(p.workedCost), 0), `${r.date} worked cost`).toBe(cents(r.workedCost));
    // Empty buckets are left out.
    for (const p of ps) expect(p.scheduledMinutes + p.scheduledCost + p.workedMinutes + p.workedCost).toBeGreaterThan(0);
  }
}

const byPosition = (row: Row | undefined, position: string | null) => row?.positions?.find((p) => p.position === position);

describe('GET /scheduling/labor-costs — positions', () => {
  it('adds up to every row: rate-card and org fallbacks, overtime on the hours past 40, unscheduled punches', async () => {
    const client = await createClient('Harbor Resorts');
    const store = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
    // Cashier has a rate card ($12) and no explicit rate on its shifts.
    await prisma.shiftRateDefault.create({
      data: { clientId: client.id, position: 'Cashier', payRate: 12, effectiveFrom: new Date('2026-01-01T00:00:00.000Z') },
    });
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Ruiz' });
    const shift = (position: string, start: Date, end: Date, payRate?: number, assigned = true) =>
      prisma.shift.create({
        data: {
          clientId: client.id,
          locationId: store.id,
          position,
          startsAt: start,
          endsAt: end,
          status: 'ASSIGNED',
          publishedAt: new Date('2026-02-01T00:00:00.000Z'),
          ...(payRate != null ? { payRate } : {}),
          ...(assigned ? { assignedAssociateId: ana.id } : {}),
        },
      });
    const punch = (start: Date, end: Date, shiftId: string | null) =>
      prisma.timeEntry.create({
        data: { associateId: ana.id, clientId: client.id, locationId: store.id, clockInAt: start, clockOutAt: end, status: 'APPROVED', payRate: 20, shiftId },
      });

    // Mon–Wed: ten-hour Cashier shifts, worked in full — 30 straight hours.
    // Scheduled: 10h less the unpaid hour = 9h × $12 card = $108 a day.
    for (const day of [9, 10, 11]) {
      const s = await shift('Cashier', at(day, 14), at(day, 24));
      await punch(at(day, 14), at(day, 24), s.id);
    }
    // Thu: 5h Cashier (hours 30–35, straight) then 6h Server (hours 35–41):
    // the week's first overtime hour is the Server's, not spread across the day.
    const thuCashier = await shift('Cashier', at(12, 14), at(12, 19));
    await punch(at(12, 14), at(12, 19), thuCashier.id);
    const thuServer = await shift('Server', at(12, 20), at(13, 2), 20);
    await punch(at(12, 20), at(13, 2), thuServer.id);
    // Fri: 3h Stocker (explicit $20) and an open 2h Greeter slot priced at the
    // org standard; Ana works the Stocker shift plus 2h on no shift at all —
    // all five hours past 40.
    const friStocker = await shift('Stocker', at(13, 14), at(13, 17), 20);
    await punch(at(13, 14), at(13, 17), friStocker.id);
    await shift('Greeter', at(13, 18), at(13, 20), undefined, false);
    await punch(at(13, 18), at(13, 20), null);
    // Tue: three 20-minute shifts at $10.01 — $3.336̅ each. Rounded one by
    // one they'd read $10.02 against the row's $10.01.
    for (const p of ['Host', 'Busser', 'Runner']) await shift(p, at(10, 15), at(10, 15, 20), 10.01, false);

    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);
    const res = await a.get('/scheduling/labor-costs').query(RANGE);
    expect(res.status).toBe(200);
    const rows = res.body.rows as Row[];
    expect(rows.map((r) => r.date)).toEqual(['2026-02-09', '2026-02-10', '2026-02-11', '2026-02-12', '2026-02-13']);
    expectPositionsAddUp(rows);
    const day = (d: string) => rows.find((r) => r.date === d);

    // Monday: one position, scheduled at the card, worked at the snapshot.
    expect(day('2026-02-09')!.positions).toEqual([
      { position: 'Cashier', scheduledMinutes: 540, scheduledCost: 108, workedMinutes: 600, workedCost: 200 },
    ]);

    // Tuesday: the card's $108 plus $10.01 split 3.34 / 3.34 / 3.33.
    const tue = day('2026-02-10')!;
    expect(tue.scheduledCost).toBe(118.01);
    expect(byPosition(tue, 'Cashier')).toMatchObject({ scheduledCost: 108, workedCost: 200 });
    const prep = ['Host', 'Busser', 'Runner'].map((p) => byPosition(tue, p)!);
    expect(prep.every((p) => p.scheduledMinutes === 20 && p.workedMinutes === 0)).toBe(true);
    expect(prep.map((p) => p.scheduledCost).sort()).toEqual([3.33, 3.34, 3.34]);

    // Thursday: overtime lands on the Server hour past 40 — Cashier 5h × $20,
    // Server 5h × $20 + 1h × $30. Server's scheduled 6h (no unpaid hour at
    // exactly six) is at its own $20.
    const thu = day('2026-02-12')!;
    expect(thu).toMatchObject({ workedMinutes: 660, workedCost: 230 });
    expect(byPosition(thu, 'Cashier')).toEqual({ position: 'Cashier', scheduledMinutes: 300, scheduledCost: 60, workedMinutes: 300, workedCost: 100 });
    expect(byPosition(thu, 'Server')).toEqual({ position: 'Server', scheduledMinutes: 360, scheduledCost: 120, workedMinutes: 360, workedCost: 130 });

    // Friday: everything worked is overtime at $30; the open Greeter slot is
    // planned at the org standard; the shiftless punch is "Unscheduled" (null).
    const fri = day('2026-02-13')!;
    expect(fri).toMatchObject({ scheduledMinutes: 300, workedMinutes: 300, workedCost: 150 });
    expect(byPosition(fri, 'Stocker')).toEqual({ position: 'Stocker', scheduledMinutes: 180, scheduledCost: 60, workedMinutes: 180, workedCost: 90 });
    expect(byPosition(fri, 'Greeter')).toEqual({
      position: 'Greeter',
      scheduledMinutes: 120,
      scheduledCost: 2 * env.DEFAULT_ASSOCIATE_PAY_RATE,
      workedMinutes: 0,
      workedCost: 0,
    });
    expect(byPosition(fri, null)).toEqual({ position: null, scheduledMinutes: 0, scheduledCost: 0, workedMinutes: 120, workedCost: 60 });
    // Costliest first (scheduled + worked); Unscheduled sorts by its money
    // like any other bucket: Stocker $150, Unscheduled $60, Greeter $30.
    expect(fri.positions!.map((p) => p.position)).toEqual(['Stocker', null, 'Greeter']);
  });

  it('keeps the caller’s reach: a store-bound manager sees only their store’s positions; another tenant sees none', async () => {
    const client = await createClient('Two Store Co');
    const north = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
    const south = await prisma.site.create({ data: { name: 'South Store', clientId: client.id, timezone: 'America/New_York' } });
    const ana = await createAssociate();
    for (const [site, position] of [[north, 'North Cashier'], [south, 'South Lifeguard']] as const) {
      const s = await prisma.shift.create({
        data: { clientId: client.id, locationId: site.id, position, startsAt: at(10, 14), endsAt: at(10, 18), status: 'ASSIGNED', payRate: 18, assignedAssociateId: ana.id },
      });
      await prisma.timeEntry.create({
        data: { associateId: ana.id, clientId: client.id, locationId: site.id, clockInAt: at(10, 14), clockOutAt: at(10, 18), status: 'COMPLETED', payRate: 18, shiftId: s.id },
      });
    }

    // Org-wide: both stores, each with its own position.
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const all = await (await loginAs(hr.email)).get('/scheduling/labor-costs').query(RANGE);
    expect(all.status).toBe(200);
    expect((all.body.rows as Row[]).map((r) => byPosition(r, r.locationId === north.id ? 'North Cashier' : 'South Lifeguard')?.workedCost)).toEqual([72, 72]);
    expectPositionsAddUp(all.body.rows);

    // Bound to the north store: the south store's row and position never appear.
    const { user: ops } = await createUser({ role: 'OPERATIONS_MANAGER', email: 'ops.north@positions.example' });
    await prisma.user.update({ where: { id: ops.id }, data: { scopeSiteIds: [north.id] } });
    const scoped = await (await loginAs(ops.email)).get('/scheduling/labor-costs').query(RANGE);
    expect(scoped.status).toBe(200);
    const rows = scoped.body.rows as Row[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.locationId).toBe(north.id);
    expect(rows[0]!.positions!.map((p) => p.position)).toEqual(['North Cashier']);
    expect(JSON.stringify(scoped.body)).not.toContain('South Lifeguard');
    expectPositionsAddUp(rows);

    // Another tenant's administrator: nothing of tenant one's.
    await prisma.tenant.create({ data: { id: T2, slug: 'tenant-two', name: 'Tenant Two' } });
    const { user: other } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'admin@tenant-two.example' });
    await prisma.user.update({ where: { id: other.id }, data: { tenantId: T2 } });
    const foreign = await (await loginAs(other.email)).get('/scheduling/labor-costs').query(RANGE);
    expect(foreign.status).toBe(200);
    expect(foreign.body.rows).toEqual([]);
    expect(JSON.stringify(foreign.body)).not.toMatch(/North Cashier|South Lifeguard/);
  });
});
