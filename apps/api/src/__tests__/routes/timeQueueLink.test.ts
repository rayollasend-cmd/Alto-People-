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
 * The timesheet count opens the queue on the rows it counted (audit Tier 1
 * #6; role walk ops 1, floor 1, HR 1). Three roles used to read "6
 * timesheets to approve" and land on "Nothing to review": the count had
 * no window and the queue opened on the current pay period while the six
 * pending rows sat in an older, already-paid one.
 *
 * One predicate (lib/pendingTime): the count, the Inbox link's window, the
 * per-period breakdown and the list agree on the same rows.
 */

const app = () => createApp();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`loginAs failed: ${r.status}`);
  return a;
}

const ymdUTC = (d: Date) => d.toISOString().slice(0, 10);

/** A biweekly schedule anchored so that `daysAgo` falls in a closed period, not the current one. */
async function biweeklySchedule() {
  // Anchor 28 days ago: periods [-28,-15], [-14,-1], [0,13] — the 30-day-old
  // punches land in the period before the anchor, which the schedule's
  // recent-periods list still carries.
  const anchor = new Date(Date.now() - 28 * DAY);
  await prisma.payrollSchedule.create({
    data: { name: 'Biweekly', frequency: 'BIWEEKLY', anchorDate: new Date(`${ymdUTC(anchor)}T00:00:00Z`), payDateOffsetDays: 7 },
  });
}

describe('timesheet queue link', () => {
  it('count, inbox path, per-period breakdown and list agree on the pending rows', async () => {
    await biweeklySchedule();
    const client = await createClient();
    const worker = await createAssociate({ firstName: 'Sep', lastName: 'Pending' });
    // Six finished punches 30 days ago (an older, closed period); nothing
    // pending in the current period; one older than the 90-day window.
    const oldestIn = new Date(Date.now() - 30 * DAY);
    for (let i = 0; i < 6; i += 1) {
      const clockInAt = new Date(oldestIn.getTime() + i * HOUR * 2);
      await prisma.timeEntry.create({
        data: { associateId: worker.id, clientId: client.id, clockInAt, clockOutAt: new Date(clockInAt.getTime() + HOUR), status: 'COMPLETED', anomalies: [] },
      });
    }
    await prisma.timeEntry.create({
      data: { associateId: worker.id, clientId: client.id, clockInAt: new Date(Date.now() - 2 * HOUR), clockOutAt: new Date(Date.now() - HOUR), status: 'APPROVED', anomalies: [] },
    });
    await prisma.timeEntry.create({
      data: { associateId: worker.id, clientId: client.id, clockInAt: new Date(Date.now() - 120 * DAY), clockOutAt: new Date(Date.now() - 120 * DAY + HOUR), status: 'COMPLETED', anomalies: [] },
    });

    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);

    // The count: windowed, with the oldest pending instant.
    const count = await a.get('/time/admin/entries/count?status=COMPLETED&groupBy=payPeriod');
    expect(count.status).toBe(200);
    expect(count.body.count).toBe(6);
    expect(count.body.oldestPendingAt).toBe(oldestIn.toISOString());
    const byPeriod = count.body.byPeriod as Array<{ start: string; end: string; count: number; hasRun: boolean }>;
    expect(byPeriod.reduce((s, p) => s + p.count, 0)).toBe(6);
    const oldestPeriod = byPeriod[0]!;
    expect(oldestPeriod.start <= ymdUTC(oldestIn) && ymdUTC(oldestIn) <= oldestPeriod.end).toBe(true);
    // The period is a real pay period, not a one-day bucket.
    expect(oldestPeriod.start).not.toBe(oldestPeriod.end);

    // The badge and the Inbox say the same number.
    const approvals = await a.get('/approvals/count');
    expect(approvals.body.timesheets).toBe(6);
    const inbox = await a.get('/me/inbox');
    const source = (inbox.body.sources as Array<{ key: string; count: number; path: string }>).find((s) => s.key === 'timesheets');
    expect(source?.count).toBe(6);
    expect(source?.path).toMatch(/^\/time-attendance\?tab=queue&status=COMPLETED&from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}$/);

    // The link's window lists every row the count counted.
    const params = new URL(`http://x${source!.path}`).searchParams;
    expect(params.get('from')! <= ymdUTC(oldestIn)).toBe(true);
    const to = new Date(`${params.get('to')}T00:00:00Z`);
    to.setUTCDate(to.getUTCDate() + 2);
    const list = await a.get(`/time/admin/entries?status=COMPLETED&from=${params.get('from')}T00:00:00.000Z&to=${to.toISOString()}`);
    expect(list.status).toBe(200);
    expect(list.body.entries).toHaveLength(6);

    // The pending list without a window reads the same 90 days the count does.
    const bare = await a.get('/time/admin/entries?status=COMPLETED&order=asc');
    expect(bare.body.entries).toHaveLength(6);
    expect(bare.body.entries[0].clockInAt).toBe(oldestIn.toISOString());
  });

  it('a bounded supervisor counts and lists only their own client', async () => {
    const mine = await createClient('Mine');
    const other = await createClient('Other');
    const w1 = await createAssociate({ firstName: 'A', lastName: 'One' });
    const w2 = await createAssociate({ firstName: 'B', lastName: 'Two' });
    const at = new Date(Date.now() - 3 * DAY);
    await prisma.timeEntry.create({ data: { associateId: w1.id, clientId: mine.id, clockInAt: at, clockOutAt: new Date(at.getTime() + HOUR), status: 'COMPLETED', anomalies: [] } });
    await prisma.timeEntry.create({ data: { associateId: w2.id, clientId: other.id, clockInAt: at, clockOutAt: new Date(at.getTime() + HOUR), status: 'COMPLETED', anomalies: [] } });
    const { user } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: mine.id });
    const a = await loginAs(user.email);
    const count = await a.get('/time/admin/entries/count?status=COMPLETED');
    expect(count.body.count).toBe(1);
    const list = await a.get('/time/admin/entries?status=COMPLETED');
    expect(list.body.entries).toHaveLength(1);
    expect(list.body.entries[0].clientId).toBe(mine.id);
  });

  it('a count for another status stays all-time and carries no oldest pending', async () => {
    const client = await createClient();
    const worker = await createAssociate();
    const at = new Date(Date.now() - 200 * DAY);
    await prisma.timeEntry.create({ data: { associateId: worker.id, clientId: client.id, clockInAt: at, clockOutAt: new Date(at.getTime() + HOUR), status: 'APPROVED', anomalies: [] } });
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);
    const count = await a.get('/time/admin/entries/count?status=APPROVED');
    expect(count.body).toEqual({ count: 1, oldestPendingAt: null });
  });
});
