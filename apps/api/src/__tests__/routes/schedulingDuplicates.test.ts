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
 * The duplicate-draft plague (reported 2026-08-14): copy-week's docstring
 * said "idempotency is on the user; calling twice produces duplicates" —
 * and re-clicks, timeout retries, and two-admin races obliged, doubling
 * whole weeks of DRAFTs. These tests pin the three-part fix: copy-week is
 * idempotent by content, template-apply 409s on an accidental twin, and
 * the dedupe endpoint cleans up what the old behavior left behind.
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
  if (r.status !== 200) {
    throw new Error(`loginAs(${email}) failed: ${r.status} ${JSON.stringify(r.body)}`);
  }
  return a;
}

async function loginHr(): Promise<TestAgent<Test>> {
  const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
  return loginAs(user.email);
}

const WEEK = new Date('2026-09-06T00:00:00.000Z'); // a Sunday
const NEXT_WEEK = new Date(WEEK.getTime() + 7 * 86_400_000);
const at = (base: Date, dayOffset: number, hour: number) =>
  new Date(base.getTime() + (dayOffset * 24 + hour) * 3_600_000);

function mkShift(over: Record<string, unknown>) {
  return prisma.shift.create({
    data: {
      position: 'Server',
      startsAt: at(WEEK, 1, 9),
      endsAt: at(WEEK, 1, 17),
      status: 'DRAFT',
      ...over,
    } as never,
  });
}

describe('copy-week is idempotent by content', () => {
  it('a second identical copy creates nothing and reports alreadyThere', async () => {
    const client = await createClient();
    const assoc = await createAssociate();
    // One assigned shift + TWO deliberately-identical open slots — the
    // multiset matcher must copy both, then skip both on the retry.
    await mkShift({ clientId: client.id, status: 'OPEN', publishedAt: new Date(), assignedAssociateId: assoc.id });
    await mkShift({ clientId: client.id, status: 'OPEN', publishedAt: new Date(), startsAt: at(WEEK, 2, 9), endsAt: at(WEEK, 2, 17) });
    await mkShift({ clientId: client.id, status: 'OPEN', publishedAt: new Date(), startsAt: at(WEEK, 2, 9), endsAt: at(WEEK, 2, 17) });

    const a = await loginHr();
    const body = {
      sourceWeekStart: WEEK.toISOString(),
      targetWeekStart: NEXT_WEEK.toISOString(),
    };

    const first = await a.post('/scheduling/copy-week').send(body);
    expect(first.status).toBe(200);
    expect(first.body.created).toBe(3);
    expect(first.body.alreadyThere ?? 0).toBe(0);

    // The re-click / timeout-retry / second-admin scenario.
    const second = await a.post('/scheduling/copy-week').send(body);
    expect(second.status).toBe(200);
    expect(second.body.created).toBe(0);
    expect(second.body.alreadyThere).toBe(3);

    // Target week holds exactly one copy of each source shift.
    const targetCount = await prisma.shift.count({
      where: { startsAt: { gte: NEXT_WEEK, lt: new Date(NEXT_WEEK.getTime() + 7 * 86_400_000) } },
    });
    expect(targetCount).toBe(3);
    // Both identical open slots made it across (multiset, not set).
    const openSlots = await prisma.shift.count({
      where: { startsAt: at(NEXT_WEEK, 2, 9), status: 'DRAFT' },
    });
    expect(openSlots).toBe(2);
  });
});

describe('template-apply twin guard', () => {
  it('409s on an accidental twin; allowDuplicate adds a second slot on purpose', async () => {
    const client = await createClient();
    const tpl = await prisma.shiftTemplate.create({
      data: {
        clientId: client.id,
        name: 'Morning server',
        position: 'Server',
        dayOfWeek: 2,
        startMinute: 9 * 60,
        endMinute: 17 * 60,
      },
    });
    const a = await loginHr();
    const body = { weekStart: WEEK.toISOString() };

    const first = await a.post(`/scheduling/templates/${tpl.id}/apply`).send(body);
    expect(first.status).toBe(201);

    const dup = await a.post(`/scheduling/templates/${tpl.id}/apply`).send(body);
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('duplicate_shift');

    const forced = await a
      .post(`/scheduling/templates/${tpl.id}/apply`)
      .send({ ...body, allowDuplicate: true });
    expect(forced.status).toBe(201);

    expect(
      await prisma.shift.count({ where: { position: 'Server', status: 'DRAFT' } }),
    ).toBe(2);
  });
});

describe('POST /scheduling/drafts/dedupe', () => {
  it('removes all but the oldest of each twin group; published shifts untouched', async () => {
    const client = await createClient();
    // Three identical DRAFT twins (staggered createdAt via sequential
    // inserts), one distinct draft, and one PUBLISHED shift at the same
    // slot that must survive.
    const keeper = await mkShift({ clientId: client.id });
    await mkShift({ clientId: client.id });
    await mkShift({ clientId: client.id });
    const distinct = await mkShift({ clientId: client.id, position: 'Cashier' });
    const published = await mkShift({
      clientId: client.id,
      status: 'OPEN',
      publishedAt: new Date(),
    });

    const a = await loginHr();
    const res = await a.post('/scheduling/drafts/dedupe').send({
      from: WEEK.toISOString(),
      to: NEXT_WEEK.toISOString(),
    });
    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(2);
    expect(res.body.groups).toBe(1);

    const remaining = await prisma.shift.findMany({ select: { id: true } });
    const ids = remaining.map((s) => s.id);
    expect(ids).toContain(keeper.id);
    expect(ids).toContain(distinct.id);
    expect(ids).toContain(published.id);
    expect(ids).toHaveLength(3);

    // Idempotent: nothing left to remove.
    const again = await a.post('/scheduling/drafts/dedupe').send({
      from: WEEK.toISOString(),
      to: NEXT_WEEK.toISOString(),
    });
    expect(again.body.removed).toBe(0);
  });

  it('clamps a supervisor to their own client', async () => {
    const mine = await createClient();
    const other = await createClient();
    await mkShift({ clientId: other.id });
    await mkShift({ clientId: other.id });
    const { user: sup } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: mine.id });
    const a = await loginAs(sup.email);

    // Asking for the other tenant is clamped — their duplicates survive.
    const res = await a.post('/scheduling/drafts/dedupe').send({
      from: WEEK.toISOString(),
      to: NEXT_WEEK.toISOString(),
      clientId: other.id,
    });
    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(0);
    expect(await prisma.shift.count({ where: { clientId: other.id } })).toBe(2);
  });
});
