import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { DEFAULT_TEST_PASSWORD, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * A shift that ended still OPEN went unfilled — it is not open (ops walk
 * 6, HR walk 19). The KPI strip says so, and close-out cancels the past
 * ones with reason UNFILLED so fill-rate history stays honest.
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
  if (r.status !== 200) throw new Error(`login failed: ${r.status}`);
  return a;
}

const H = 3_600_000;
const openAt = (clientId: string, locationId: string, hoursFromNow: number) =>
  prisma.shift.create({
    data: {
      clientId,
      locationId,
      position: 'Housekeeper',
      startsAt: new Date(Date.now() + hoursFromNow * H),
      endsAt: new Date(Date.now() + (hoursFromNow + 4) * H),
      status: 'OPEN',
      publishedAt: new Date(Date.now() - 7 * 24 * H),
    },
  });

describe('past OPEN shifts are unfilled, not open', () => {
  it('the KPI strip splits upcoming from unfilled, and close-out cancels the past ones as UNFILLED, once', async () => {
    const client = await createClient('The Grand Hotel');
    const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
    const gone1 = await openAt(client.id, site.id, -48);
    const gone2 = await openAt(client.id, site.id, -30);
    const ahead = await openAt(client.id, site.id, 6);
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const window = `from=${new Date(Date.now() - 72 * H).toISOString()}&to=${new Date(Date.now() + 24 * H).toISOString()}`;
    const before = await a.get(`/scheduling/kpis?${window}`);
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ openShifts: 3, openUpcoming: 1, unfilledPast: 2 });

    const closed = await a.post('/scheduling/shifts/close-out-unfilled').send({ clientId: client.id });
    expect(closed.status).toBe(200);
    expect(closed.body.closed).toBe(2);
    expect(new Set(closed.body.shiftIds)).toEqual(new Set([gone1.id, gone2.id]));
    const rows = await prisma.shift.findMany({ where: { id: { in: [gone1.id, gone2.id] } } });
    expect(rows.map((r) => [r.status, r.cancellationReason])).toEqual([
      ['CANCELLED', 'UNFILLED'],
      ['CANCELLED', 'UNFILLED'],
    ]);
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: ahead.id } })).status).toBe('OPEN');

    const after = await a.get(`/scheduling/kpis?${window}`);
    expect(after.body).toMatchObject({ openShifts: 1, openUpcoming: 1, unfilledPast: 0 });

    // Idempotent.
    const again = await a.post('/scheduling/shifts/close-out-unfilled').send({});
    expect(again.body).toEqual({ closed: 0, shiftIds: [] });
  });

  it('a window narrows what closes; a site-bound caller closes only its own client', async () => {
    const client = await createClient('Client A');
    const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
    const other = await createClient('Client B');
    const otherSite = await prisma.site.findFirstOrThrow({ where: { clientId: other.id } });
    const old = await openAt(client.id, site.id, -100);
    const recent = await openAt(client.id, site.id, -30);
    const theirs = await openAt(other.id, otherSite.id, -30);
    const { user: sup } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id });
    const a = await loginAs(sup.email);

    const res = await a.post('/scheduling/shifts/close-out-unfilled').send({ clientId: other.id, from: new Date(Date.now() - 50 * H).toISOString() });
    expect(res.status).toBe(200);
    // The clamp keeps them on their own client; `from` leaves the older one alone.
    expect(res.body.shiftIds).toEqual([recent.id]);
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: old.id } })).status).toBe('OPEN');
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: theirs.id } })).status).toBe('OPEN');
  });
});

describe('GET /scheduling/last-shift', () => {
  it('answers the newest non-cancelled shift at the site, for the new-shift prefill', async () => {
    const client = await createClient('Prefill Co');
    const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
    await openAt(client.id, site.id, 10);
    const second = await prisma.shift.create({
      data: { clientId: client.id, locationId: site.id, position: 'Front desk', startsAt: new Date(Date.now() + 20 * H), endsAt: new Date(Date.now() + 28 * H), status: 'DRAFT', payRate: 19 },
    });
    await prisma.shift.create({
      data: { clientId: client.id, locationId: site.id, position: 'Cancelled', startsAt: new Date(Date.now() + 30 * H), endsAt: new Date(Date.now() + 34 * H), status: 'CANCELLED' },
    });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const res = await a.get(`/scheduling/last-shift?locationId=${site.id}`);
    expect(res.status).toBe(200);
    expect(res.body.shift).toMatchObject({ id: second.id, position: 'Front desk', payRate: 19, locationId: site.id });

    const byClient = await a.get(`/scheduling/last-shift?clientId=${client.id}`);
    expect(byClient.body.shift.id).toBe(second.id);

    const empty = await createClient('Nothing yet');
    expect((await a.get(`/scheduling/last-shift?clientId=${empty.id}`)).body).toEqual({ shift: null });
    expect((await a.get('/scheduling/last-shift')).status).toBe(400);
  });
});
