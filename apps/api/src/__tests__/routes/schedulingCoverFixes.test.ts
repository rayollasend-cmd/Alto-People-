import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { flushPendingNotifications } from '../../lib/notify.js';
import { mergePayPeriods } from '../../lib/payPeriods.js';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';

/**
 * The review of the UX build (time, scheduling, approvals): Build next week
 * stays on the store on screen and can't double a week; it never changes a
 * live shift before Publish; the call-outs desk's one-tap pick comes from
 * the shift's own store and never silently replaces someone; a deny can't
 * overwrite an approval; and "paid" means a finalized run.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** Monday 00:00 UTC, `weeks` from this week. */
function monday(weeks: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + 7 * weeks);
  return d;
}

async function hr() {
  const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
  return { user, http: await loginAs(agent(), user.email) };
}

async function worksAt(clientId: string, name: { firstName: string; lastName: string }) {
  const site = await prisma.site.findFirstOrThrow({ where: { clientId } });
  const a = await createAssociate(name);
  await prisma.associateAssignment.create({ data: { associateId: a.id, locationId: site.id, startedAt: new Date('2026-01-01') } });
  // Free every day, all day.
  await prisma.associateAvailability.createMany({ data: [0, 1, 2, 3, 4, 5, 6].map((d) => ({ associateId: a.id, dayOfWeek: d, startMinute: 0, endMinute: 1440 })) });
  return { associate: a, site };
}

describe('copy-week (Build next week)', () => {
  it('copies only the store named, and a second run never doubles a slot someone has since filled', async () => {
    const { http } = await hr();
    const a = await createClient('Store A');
    const b = await createClient('Store B');
    const src = monday(2);
    const tgt = monday(3);
    const at = (c: string) => ({ clientId: c, position: 'Cashier', startsAt: new Date(src.getTime() + 13 * HOUR), endsAt: new Date(src.getTime() + 21 * HOUR), status: 'OPEN' as const });
    await prisma.shift.create({ data: at(a.id) });
    await prisma.shift.create({ data: at(b.id) });

    const first = await http.post('/scheduling/copy-week').send({ sourceWeekStart: src.toISOString(), targetWeekStart: tgt.toISOString(), clientId: a.id });
    expect(first.status).toBe(200);
    expect(first.body.created).toBe(1);
    const inTarget = () => prisma.shift.findMany({ where: { startsAt: { gte: tgt, lt: new Date(tgt.getTime() + 7 * DAY) } } });
    expect((await inTarget()).map((s) => s.clientId)).toEqual([a.id]);

    // The copied open draft gets filled; building again must see the slot as taken.
    const { associate } = await worksAt(a.id, { firstName: 'Fay', lastName: 'Filled' });
    await prisma.shift.updateMany({ where: { clientId: a.id, startsAt: { gte: tgt } }, data: { assignedAssociateId: associate.id } });
    const again = await http.post('/scheduling/copy-week').send({ sourceWeekStart: src.toISOString(), targetWeekStart: tgt.toISOString(), clientId: a.id });
    expect(again.body).toMatchObject({ created: 0, alreadyThere: 1 });
    expect(await inTarget()).toHaveLength(1);
  });
});

describe('auto-schedule-week', () => {
  it('draftsOnly leaves a live open shift alone; a plain run fills it and tells the person', async () => {
    const { http } = await hr();
    const client = await createClient('Store A');
    const { associate } = await worksAt(client.id, { firstName: 'Pia', lastName: 'Picked' });
    const { user: pia } = await createUser({ role: 'ASSOCIATE', associateId: associate.id });
    const wk = monday(2);
    const live = await prisma.shift.create({
      data: { clientId: client.id, position: 'Cashier', startsAt: new Date(wk.getTime() + 14 * HOUR), endsAt: new Date(wk.getTime() + 20 * HOUR), status: 'OPEN', publishedAt: new Date() },
    });
    const body = { weekStart: wk.toISOString(), weekEnd: new Date(wk.getTime() + 7 * DAY).toISOString(), clientId: client.id };

    const drafts = await http.post('/scheduling/auto-schedule-week').send({ ...body, draftsOnly: true });
    expect(drafts.body.assigned).toBe(0);
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: live.id } })).assignedAssociateId).toBeNull();

    const plain = await http.post('/scheduling/auto-schedule-week').send(body);
    expect(plain.body.assigned).toBe(1);
    await flushPendingNotifications();
    expect(await prisma.notification.count({ where: { recipientUserId: pia.id, channel: 'IN_APP', subject: 'New shift assigned' } })).toBe(1);
  });
});

describe('auto-fill ranking (the call-outs desk pick)', () => {
  it("ranks only the shift's own store, counts scheduled hours toward 40, and batches", async () => {
    const { http } = await hr();
    const a = await createClient('Store A');
    const b = await createClient('Store B');
    const { associate: ours } = await worksAt(a.id, { firstName: 'Ann', lastName: 'Ours' });
    const { associate: busy } = await worksAt(a.id, { firstName: 'Ben', lastName: 'Booked' });
    await worksAt(b.id, { firstName: 'Bea', lastName: 'Elsewhere' });
    const wk = monday(2);
    const shift = await prisma.shift.create({
      data: { clientId: a.id, position: 'Cashier', startsAt: new Date(wk.getTime() + 3 * DAY + 14 * HOUR), endsAt: new Date(wk.getTime() + 3 * DAY + 22 * HOUR), status: 'OPEN', publishedAt: new Date() },
    });
    // Ben is already scheduled 44 paid hours that week (not worked yet).
    for (const d of [0, 1, 2, 4]) {
      await prisma.shift.create({
        data: { clientId: a.id, position: 'Cashier', startsAt: new Date(wk.getTime() + d * DAY + 8 * HOUR), endsAt: new Date(wk.getTime() + d * DAY + 20 * HOUR), status: 'ASSIGNED', assignedAssociateId: busy.id, publishedAt: new Date() },
      });
    }

    const one = await http.get(`/scheduling/shifts/${shift.id}/auto-fill`);
    expect(one.status).toBe(200);
    const names = one.body.candidates.map((c: { associateName: string }) => c.associateName);
    expect(names).toContain('Ann Ours');
    expect(names).not.toContain('Bea Elsewhere');
    const ben = one.body.candidates.find((c: { associateId: string }) => c.associateId === busy.id);
    expect(ben.score).toBeLessThan(1); // would cross 40 scheduled hours
    expect(one.body.candidates[0].associateId).toBe(ours.id);

    const batch = await http.post('/scheduling/auto-fill/batch').send({ shiftIds: [shift.id] });
    expect(batch.status).toBe(200);
    expect(batch.body.byShift[shift.id][0].associateId).toBe(ours.id);
  });

  it('a pick made with expectUnassigned never replaces someone who got there first', async () => {
    const { http } = await hr();
    const client = await createClient('Store A');
    const { associate: first } = await worksAt(client.id, { firstName: 'Fran', lastName: 'First' });
    const { associate: second } = await worksAt(client.id, { firstName: 'Sam', lastName: 'Second' });
    const wk = monday(2);
    const shift = await prisma.shift.create({
      data: { clientId: client.id, position: 'Cashier', startsAt: new Date(wk.getTime() + 14 * HOUR), endsAt: new Date(wk.getTime() + 20 * HOUR), status: 'OPEN', publishedAt: new Date() },
    });
    const ok = await http.post(`/scheduling/shifts/${shift.id}/assign`).send({ associateId: first.id, expectUnassigned: true });
    expect(ok.status).toBe(200);
    const late = await http.post(`/scheduling/shifts/${shift.id}/assign`).send({ associateId: second.id, expectUnassigned: true });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('shift_taken');
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: shift.id } })).assignedAssociateId).toBe(first.id);
  });
});

describe('time off — approve and deny at the same moment', () => {
  it('exactly one wins, and the balance matches the outcome', async () => {
    const { http } = await hr();
    const a = await createAssociate({ firstName: 'Tia', lastName: 'Timeoff' });
    await prisma.timeOffBalance.create({ data: { associateId: a.id, category: 'VACATION', balanceMinutes: 960 } });
    const req = await prisma.timeOffRequest.create({
      data: { associateId: a.id, category: 'VACATION', startDate: new Date('2026-12-01'), endDate: new Date('2026-12-01'), requestedMinutes: 480, status: 'PENDING' },
    });
    const [approve, deny] = await Promise.all([
      http.post(`/time-off/admin/requests/${req.id}/approve`).send({}),
      http.post(`/time-off/admin/requests/${req.id}/deny`).send({ note: 'Coverage gap' }),
    ]);
    expect([approve.status, deny.status].filter((s) => s === 200)).toHaveLength(1);
    const after = await prisma.timeOffRequest.findUniqueOrThrow({ where: { id: req.id } });
    const bal = await prisma.timeOffBalance.findUniqueOrThrow({ where: { associateId_category: { associateId: a.id, category: 'VACATION' } } });
    if (after.status === 'APPROVED') expect(bal.balanceMinutes).toBe(480);
    else {
      expect(after.status).toBe('DENIED');
      expect(bal.balanceMinutes).toBe(960);
    }
  });
});

describe('pay periods', () => {
  it('a draft run does not mark its period paid', () => {
    const merged = mergePayPeriods(
      [{ periodStart: '2026-10-03', periodEnd: '2026-10-16' } as never],
      [{ start: '2026-10-03', end: '2026-10-16', finalized: false }],
      new Date('2026-10-20T12:00:00Z'),
    );
    expect(merged[0]).toMatchObject({ start: '2026-10-03', hasRun: false });
  });
});
