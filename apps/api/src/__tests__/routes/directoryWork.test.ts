import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * The People list's "Last shift" and "Hours (14 days)" columns, the pay
 * fields only for those who may read pay, and the person record's Overview
 * numbers (F500 fix-up, G1): each seeded here and asserted exactly, in the
 * caller's reach.
 */

const app = () => createApp();
const DAY = 86_400_000;
const HOUR = 3_600_000;

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

async function as(role: 'HR_ADMINISTRATOR' | 'INTERNAL_RECRUITER' | 'MARKETING_MANAGER' | 'OPERATIONS_MANAGER', email: string, scopeSiteIds?: string[]) {
  const { user } = await createUser({ role, email });
  if (scopeSiteIds) await prisma.user.update({ where: { id: user.id }, data: { scopeSiteIds } });
  return loginAs(email);
}

/**
 * Ana works at store North; one of her shifts was at store South. Her time:
 *   2 days ago   8h with a 30-minute break   → 450 min   (store North)
 *   5 days ago   4h                          → 240 min   (store South)
 *   1 day ago    3h, REJECTED                → not work
 *   20 days ago  6h                          → outside the 14-day window
 * Window minutes: 690 (two entries); last worked: 2 days ago.
 */
async function world() {
  const client = await createClient('Two Stores');
  const north = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  const south = await prisma.site.create({ data: { name: 'South', clientId: client.id, timezone: 'America/Chicago' } });
  const ana = await createAssociate({ firstName: 'Ana', lastName: 'Reyes', email: 'ana@example.com' });
  const bo = await createAssociate({ firstName: 'Bo', lastName: 'Bravo', email: 'bo@example.com' });
  await prisma.application.create({ data: { associateId: ana.id, clientId: client.id, onboardingTrack: 'STANDARD', status: 'APPROVED', approvedAt: new Date(Date.now() - 60 * DAY) } });
  await prisma.associateAssignment.create({ data: { associateId: ana.id, locationId: north.id, startedAt: new Date(Date.now() - 60 * DAY) } });
  await prisma.associateAssignment.create({ data: { associateId: bo.id, locationId: south.id, startedAt: new Date(Date.now() - 60 * DAY) } });
  await prisma.compensationRecord.create({ data: { associateId: ana.id, amount: '18.50', payType: 'HOURLY', currency: 'USD', effectiveFrom: new Date('2026-01-01'), reason: 'HIRE' } });

  const now = Date.now();
  const twoDaysAgo = new Date(now - 2 * DAY);
  const long = await prisma.timeEntry.create({
    data: { associateId: ana.id, clientId: client.id, locationId: north.id, clockInAt: twoDaysAgo, clockOutAt: new Date(twoDaysAgo.getTime() + 8 * HOUR), status: 'APPROVED' },
  });
  await prisma.breakEntry.create({ data: { timeEntryId: long.id, type: 'MEAL', startedAt: new Date(twoDaysAgo.getTime() + 4 * HOUR), endedAt: new Date(twoDaysAgo.getTime() + 4.5 * HOUR) } });
  const fiveDaysAgo = new Date(now - 5 * DAY);
  await prisma.timeEntry.create({
    data: { associateId: ana.id, clientId: client.id, locationId: south.id, clockInAt: fiveDaysAgo, clockOutAt: new Date(fiveDaysAgo.getTime() + 4 * HOUR), status: 'COMPLETED' },
  });
  const oneDayAgo = new Date(now - DAY);
  await prisma.timeEntry.create({
    data: { associateId: ana.id, clientId: client.id, locationId: north.id, clockInAt: oneDayAgo, clockOutAt: new Date(oneDayAgo.getTime() + 3 * HOUR), status: 'REJECTED' },
  });
  const twentyDaysAgo = new Date(now - 20 * DAY);
  await prisma.timeEntry.create({
    data: { associateId: ana.id, clientId: client.id, locationId: north.id, clockInAt: twentyDaysAgo, clockOutAt: new Date(twentyDaysAgo.getTime() + 6 * HOUR), status: 'COMPLETED' },
  });
  return { client, north, south, ana, bo, twoDaysAgo };
}

type Row = { id: string; lastWorkedAt?: string | null; recentMinutes?: number | null; payAmount?: string | null };

describe('GET /people/directory — last shift and hours in the window', () => {
  it('counts net minutes of the clock-ins in the 14-day window, rejected ones out, and the latest clock-in', async () => {
    const w = await world();
    const hr = await as('HR_ADMINISTRATOR', 'hr@example.com');
    const res = await hr.get('/people/directory');
    expect(res.status).toBe(200);
    const ana = (res.body.associates as Row[]).find((r) => r.id === w.ana.id)!;
    expect(ana.recentMinutes).toBe(690);
    expect(ana.lastWorkedAt).toBe(w.twoDaysAgo.toISOString());
    const bo = (res.body.associates as Row[]).find((r) => r.id === w.bo.id)!;
    expect(bo.recentMinutes).toBe(0);
    expect(bo.lastWorkedAt).toBeNull();
    // The by-id read is the same row.
    const one = await hr.get(`/people/directory/${w.ana.id}`);
    expect(one.body).toEqual(ana);
  });

  it('a store-bound account counts only the time worked at its own store', async () => {
    const w = await world();
    const ops = await as('OPERATIONS_MANAGER', 'ops@example.com', [w.north.id]);
    const res = await ops.get('/people/directory');
    expect(res.status).toBe(200);
    const rows = res.body.associates as Row[];
    expect(rows.map((r) => r.id)).toEqual([w.ana.id]);
    // 450 at North; the 240 at South is outside its reach.
    expect(rows[0]!.recentMinutes).toBe(450);
  });

  it('pay goes to those who may read pay; for the rest the fields are left out, not null', async () => {
    const w = await world();
    const hr = await as('HR_ADMINISTRATOR', 'hr@example.com');
    const hrAna = ((await hr.get('/people/directory')).body.associates as Row[]).find((r) => r.id === w.ana.id)!;
    expect(hrAna.payAmount).toBe('18.5');
    const recruiter = await as('INTERNAL_RECRUITER', 'rec@example.com');
    const recAna = ((await recruiter.get('/people/directory')).body.associates as Row[]).find((r) => r.id === w.ana.id)!;
    expect(recAna).toBeDefined();
    expect('payAmount' in recAna).toBe(false);
    expect('payType' in recAna).toBe(false);
    const one = await recruiter.get(`/people/directory/${w.ana.id}`);
    expect('payAmount' in one.body).toBe(false);
  });
});

describe('GET /people/directory/:id/overview', () => {
  it('gives the record its numbers: hours, waiting approval, last and next shift, no-shows, documents and pay schedule', async () => {
    const w = await world();
    const now = Date.now();
    // Shifts ahead: the sooner one is the next shift; a cancelled one doesn't count.
    await prisma.shift.create({ data: { clientId: w.client.id, locationId: w.north.id, position: 'Cashier', startsAt: new Date(now + 3 * DAY), endsAt: new Date(now + 3 * DAY + 8 * HOUR), status: 'ASSIGNED', assignedAssociateId: w.ana.id } });
    const next = await prisma.shift.create({ data: { clientId: w.client.id, locationId: w.north.id, position: 'Stocker', startsAt: new Date(now + DAY), endsAt: new Date(now + DAY + 6 * HOUR), status: 'ASSIGNED', assignedAssociateId: w.ana.id } });
    await prisma.shift.create({ data: { clientId: w.client.id, locationId: w.north.id, position: 'Cashier', startsAt: new Date(now + 2 * HOUR), endsAt: new Date(now + 8 * HOUR), status: 'CANCELLED', assignedAssociateId: w.ana.id } });
    // No-shows: one 10 days ago counts; an excused one and one 40 days ago don't.
    const day = (ms: number) => new Date(new Date(ms).toISOString().slice(0, 10));
    await prisma.attendanceEvent.create({ data: { associateId: w.ana.id, kind: 'NO_CALL_NO_SHOW', points: '2', occurredOn: day(now - 10 * DAY) } });
    await prisma.attendanceEvent.create({ data: { associateId: w.ana.id, kind: 'NO_CALL_NO_SHOW', points: '2', occurredOn: day(now - 12 * DAY), excusedAt: new Date() } });
    await prisma.attendanceEvent.create({ data: { associateId: w.ana.id, kind: 'NO_CALL_NO_SHOW', points: '2', occurredOn: day(now - 40 * DAY) } });
    await prisma.attendanceEvent.create({ data: { associateId: w.ana.id, kind: 'LATE', points: '0.5', occurredOn: day(now - 3 * DAY) } });
    // Documents: an old ID expired but a newer one is good (not expired); a
    // visa runs out in 10 days (expiring); a DS-2019 expired with no renewal.
    const doc = (kind: 'ID' | 'J1_VISA' | 'J1_DS2019', expiresAt: Date, createdAt: Date) =>
      prisma.documentRecord.create({ data: { associateId: w.ana.id, kind, filename: `${kind}.pdf`, mimeType: 'application/pdf', size: 10, expiresAt, createdAt } });
    await doc('ID', new Date(now - 30 * DAY), new Date(now - 400 * DAY));
    await doc('ID', new Date(now + 900 * DAY), new Date(now - 20 * DAY));
    await doc('J1_VISA', new Date(now + 10 * DAY), new Date(now - 100 * DAY));
    await doc('J1_DS2019', new Date(now - 5 * DAY), new Date(now - 300 * DAY));
    // Pay schedule.
    const schedule = await prisma.payrollSchedule.create({ data: { name: 'Biweekly', frequency: 'BIWEEKLY', anchorDate: new Date('2026-09-12'), payDateOffsetDays: 7 } });
    await prisma.payrollScheduleAssignment.create({ data: { associateId: w.ana.id, scheduleId: schedule.id, effectiveFrom: new Date(now - 60 * DAY), source: 'DEFAULT' } });

    const hr = await as('HR_ADMINISTRATOR', 'hr@example.com');
    const res = await hr.get(`/people/directory/${w.ana.id}/overview`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      windowDays: 14,
      work: {
        minutes: 690,
        entries: 2,
        // The 5-days-ago and 20-days-ago clock-ins are clocked out and not approved.
        awaitingReview: 2,
        lastWorkedAt: w.twoDaysAgo.toISOString(),
        nextShift: {
          id: next.id,
          startsAt: next.startsAt.toISOString(),
          endsAt: next.endsAt.toISOString(),
          position: 'Stocker',
          locationName: 'Two Stores',
          timezone: 'America/New_York',
        },
        noShows30d: 1,
      },
      documents: { expiringSoon: 1, expired: 1 },
      pay: { scheduleId: schedule.id, scheduleName: 'Biweekly' },
    });
  });

  it('leaves out what the caller may not read, instead of zeros', async () => {
    const w = await world();
    // The recruiter reads documents but not pay; marketing reads neither.
    const recruiter = await as('INTERNAL_RECRUITER', 'rec@example.com');
    const rec = await recruiter.get(`/people/directory/${w.ana.id}/overview`);
    expect(rec.status).toBe(200);
    expect(rec.body.documents).toEqual({ expiringSoon: 0, expired: 0 });
    expect(rec.body.pay).toBeUndefined();
    const marketing = await as('MARKETING_MANAGER', 'mkt@example.com');
    const mkt = await marketing.get(`/people/directory/${w.ana.id}/overview`);
    expect(mkt.status).toBe(200);
    expect(mkt.body.documents).toBeUndefined();
    expect(mkt.body.pay).toBeUndefined();
    expect(mkt.body.work.minutes).toBe(690);
  });

  it('stays in the caller’s reach: a store-bound account sees its store’s time, and nobody at another store', async () => {
    const w = await world();
    const ops = await as('OPERATIONS_MANAGER', 'ops@example.com', [w.north.id]);
    const res = await ops.get(`/people/directory/${w.ana.id}/overview`);
    expect(res.status).toBe(200);
    expect(res.body.work.minutes).toBe(450);
    expect(res.body.work.entries).toBe(1);
    // Bo works at South only.
    expect((await ops.get(`/people/directory/${w.bo.id}/overview`)).status).toBe(404);
    expect((await ops.get('/people/directory/not-a-uuid/overview')).status).toBe(404);
  });

  it('is gated like the list: an associate cannot read anyone’s overview', async () => {
    const w = await world();
    const { user } = await createUser({ role: 'ASSOCIATE', email: 'assoc@example.com' });
    const a = await loginAs(user.email);
    expect((await a.get(`/people/directory/${w.ana.id}/overview`)).status).toBe(403);
  });
});
