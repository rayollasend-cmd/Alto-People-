import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { saturdayWeek } from '../../lib/timesheetWeek.js';
import { fieldglassDueAt } from '../../lib/fieldglassDesk.js';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

/** The Finance cockpit endpoint: capability gate + the operating counts. */

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
  if (r.status !== 200) throw new Error(`loginAs failed: ${r.status}`);
  return a;
}

const HOUR = 3600_000;
const DAY = 24 * HOUR;

describe('GET /finance/overview', () => {
  it('is gated on process:payroll', async () => {
    const associate = await createAssociate();
    const { user } = await createUser({
      role: 'ASSOCIATE',
      email: associate.email,
      associateId: associate.id,
    });
    const res = await (await loginAs(user.email)).get('/finance/overview');
    expect(res.status).toBe(403);
  });

  it('answers the operating loop: payday, chase, settlements, receivables', async () => {
    const now = new Date();
    const client = await createClient('Front Beach 218');
    const a1 = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });

    // Biweekly schedule anchored 10 days back → a computable next payday.
    await prisma.payrollSchedule.create({
      data: {
        name: 'Biweekly — associates',
        frequency: 'BIWEEKLY',
        anchorDate: new Date(now.getTime() - 10 * DAY),
        payDateOffsetDays: 5,
      },
    });

    // One worked-but-unapproved entry (blocks the close): 8h, no breaks.
    await prisma.timeEntry.create({
      data: {
        associateId: a1.id,
        clientId: client.id,
        clockInAt: new Date(now.getTime() - 30 * HOUR),
        clockOutAt: new Date(now.getTime() - 22 * HOUR),
        status: 'COMPLETED',
      },
    });
    // An APPROVED entry must NOT count toward the chase.
    await prisma.timeEntry.create({
      data: {
        associateId: a1.id,
        clientId: client.id,
        clockInAt: new Date(now.getTime() - 54 * HOUR),
        clockOutAt: new Date(now.getTime() - 46 * HOUR),
        status: 'APPROVED',
      },
    });

    // MANAGER_APPROVED requires the approval stamp (DB check constraint
    // Reimbursement_manager_approved_chk) — mirror the real flow.
    const { user: mgr } = await createUser({ role: 'OPERATIONS_MANAGER' });
    await prisma.reimbursement.create({
      data: {
        associateId: a1.id,
        title: 'Steel-toe boots',
        totalAmount: 84.5,
        status: 'MANAGER_APPROVED',
        managerApprovedById: mgr.id,
        managerApprovedAt: now,
      },
    });

    await prisma.clientStatement.create({
      data: {
        clientId: client.id,
        periodStart: new Date(now.getTime() - 21 * DAY),
        periodEnd: new Date(now.getTime() - 15 * DAY),
        number: 7,
        status: 'FINAL',
        finalizedAt: new Date(now.getTime() - 14 * DAY),
        snapshot: { totals: { amount: 5000, hours: 236, regularHours: 236, otHours: 0 } },
      },
    });

    const { user } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const res = await (await loginAs(user.email)).get('/finance/overview');
    expect(res.status).toBe(200);

    // Payday computed from the schedule, in the future.
    expect(res.body.payday.next).not.toBeNull();
    expect(new Date(res.body.payday.next.date).getTime()).toBeGreaterThan(now.getTime());
    expect(res.body.payday.next.schedule).toBe('Biweekly — associates');

    // The chase: exactly the unapproved 8h, attributed to the client.
    expect(res.body.close.pendingEntries).toBe(1);
    expect(res.body.close.pendingHours).toBeGreaterThan(6);
    expect(res.body.close.pendingHours).toBeLessThanOrEqual(8);
    expect(res.body.close.byClient[0].clientName).toBe('Front Beach 218');

    // Settlement queue.
    expect(res.body.settlements).toEqual({ count: 1, total: 84.5 });

    // Receivables: the unpaid FINAL statement, aged ~14 days.
    expect(res.body.receivables.outstandingCount).toBe(1);
    expect(res.body.receivables.outstandingTotal).toBe(5000);
    expect(res.body.receivables.oldestDays).toBeGreaterThanOrEqual(13);
  });

  it('runs the Fieldglass queue: lists approved+scheduled workers, mark clears, undo restores', async () => {
    const now = new Date();
    const client = await createClient('Front Beach 218');
    const a1 = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
    await prisma.application.create({
      data: {
        associateId: a1.id,
        clientId: client.id,
        onboardingTrack: 'STANDARD',
        status: 'APPROVED',
        approvedAt: now,
      },
    });
    await prisma.shift.create({
      data: {
        clientId: client.id,
        assignedAssociateId: a1.id,
        position: 'Stocker',
        startsAt: new Date(now.getTime() + 24 * HOUR),
        endsAt: new Date(now.getTime() + 32 * HOUR),
        status: 'ASSIGNED',
        publishedAt: now,
      },
    });
    // Approved but UNSCHEDULED — must not appear.
    const a2 = await createAssociate({ firstName: 'Noah', lastName: 'Unscheduled' });
    await prisma.application.create({
      data: {
        associateId: a2.id,
        clientId: client.id,
        onboardingTrack: 'STANDARD',
        status: 'APPROVED',
        approvedAt: now,
      },
    });

    const { user } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const agent = await loginAs(user.email);

    const before = await agent.get('/finance/overview');
    expect(before.status).toBe(200);
    expect(before.body.fieldglassQueue).toHaveLength(1);
    expect(before.body.fieldglassQueue[0].name).toBe('Maria Lopez');
    expect(before.body.fieldglassQueue[0].clientName).toBe('Front Beach 218');

    // Mark added → row leaves the queue, attributed to the marker.
    const mark = await agent.post(`/finance/fieldglass/${a1.id}/done`);
    expect(mark.status).toBe(200);
    const after = await agent.get('/finance/overview');
    expect(after.body.fieldglassQueue).toHaveLength(0);
    const reg = await prisma.fieldglassRegistration.findUnique({
      where: { associateId: a1.id },
    });
    expect(reg?.addedById).toBe(user.id);

    // Undo → back on the queue.
    const undo = await agent.delete(`/finance/fieldglass/${a1.id}/done`);
    expect(undo.status).toBe(200);
    const restored = await agent.get('/finance/overview');
    expect(restored.body.fieldglassQueue).toHaveLength(1);
  });

  it('detects a cross-client transfer: close old account, open new, mark re-stamps', async () => {
    const now = new Date();
    const clientA = await createClient('Front Beach 218');
    const clientB = await createClient('Destin 4411');
    const a1 = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
    // Registered in Fieldglass under A…
    await prisma.fieldglassRegistration.create({
      data: { associateId: a1.id, clientId: clientA.id },
    });
    // …but now OPEN-assigned at B (the org transfer flow's end state).
    const locB = await prisma.location.findFirst({
      where: { clientId: clientB.id },
      select: { id: true },
    });
    await prisma.associateAssignment.create({
      data: { associateId: a1.id, locationId: locB!.id, startedAt: now },
    });
    // Upcoming shift at B — the transfer deadline.
    await prisma.shift.create({
      data: {
        clientId: clientB.id,
        assignedAssociateId: a1.id,
        position: 'Stocker',
        startsAt: new Date(now.getTime() + 24 * HOUR),
        endsAt: new Date(now.getTime() + 32 * HOUR),
        status: 'ASSIGNED',
        publishedAt: now,
      },
    });

    const { user } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const agent = await loginAs(user.email);

    const res = await agent.get('/finance/overview');
    expect(res.status).toBe(200);
    const row = res.body.fieldglassQueue.find(
      (r: { associateId: string }) => r.associateId === a1.id,
    );
    expect(row).toBeDefined();
    expect(row.kind).toBe('transfer');
    expect(row.fromClientName).toBe('Front Beach 218');
    expect(row.clientName).toBe('Destin 4411');
    expect(row.firstShiftAt).not.toBeNull();

    // Mark done → registration re-stamps to B → transfer row clears.
    const mark = await agent.post(`/finance/fieldglass/${a1.id}/done`);
    expect(mark.status).toBe(200);
    const reg = await prisma.fieldglassRegistration.findUnique({
      where: { associateId: a1.id },
    });
    expect(reg?.clientId).toBe(clientB.id);
    const after = await agent.get('/finance/overview');
    expect(
      after.body.fieldglassQueue.filter(
        (r: { associateId: string }) => r.associateId === a1.id,
      ),
    ).toHaveLength(0);
  });

  it('gates the Fieldglass mark on process:payroll', async () => {
    const associate = await createAssociate();
    const { user } = await createUser({
      role: 'ASSOCIATE',
      email: associate.email,
      associateId: associate.id,
    });
    const res = await (await loginAs(user.email)).post(
      `/finance/fieldglass/${associate.id}/done`,
    );
    expect(res.status).toBe(403);
  });

  it('queues a CLOSE-OUT for a separated registered worker, outranking everything', async () => {
    const now = new Date();
    const client = await createClient('Front Beach 218');
    // A separated worker still registered in Fieldglass — the dead account.
    const gone = await createAssociate({ firstName: 'Gone', lastName: 'Worker' });
    await prisma.fieldglassRegistration.create({
      data: { associateId: gone.id, clientId: client.id },
    });
    await prisma.associate.update({
      where: { id: gone.id },
      data: { separatedAt: now },
    });
    // A separated-but-unregistered recent approval must NOT appear as an add.
    const goneToo = await createAssociate({ firstName: 'Also', lastName: 'Gone' });
    await prisma.application.create({
      data: {
        associateId: goneToo.id,
        clientId: client.id,
        onboardingTrack: 'STANDARD',
        status: 'APPROVED',
        approvedAt: now,
      },
    });
    await prisma.shift.create({
      data: {
        clientId: client.id,
        assignedAssociateId: goneToo.id,
        position: 'Stocker',
        startsAt: new Date(now.getTime() + 24 * HOUR),
        endsAt: new Date(now.getTime() + 32 * HOUR),
        status: 'ASSIGNED',
        publishedAt: now,
      },
    });
    await prisma.associate.update({
      where: { id: goneToo.id },
      data: { separatedAt: now },
    });
    // A DEACTIVATED (paused) registered worker must NOT be a close-out.
    const paused = await createAssociate({ firstName: 'Just', lastName: 'Paused' });
    await prisma.fieldglassRegistration.create({
      data: { associateId: paused.id, clientId: client.id },
    });
    await prisma.associate.update({
      where: { id: paused.id },
      data: { deactivatedAt: now },
    });

    const { user } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const agent = await loginAs(user.email);
    const res = await agent.get('/finance/overview');
    expect(res.status).toBe(200);
    const kinds = res.body.fieldglassQueue.map((r: { kind: string }) => r.kind);
    expect(kinds).toEqual(['close']);
    expect(res.body.fieldglassQueue[0].name).toBe('Gone Worker');
    expect(res.body.fieldglassQueue[0].clientName).toBe('Front Beach 218');

    // Mark closed = the registration is removed; the row clears.
    const done = await agent.delete(`/finance/fieldglass/${gone.id}/done`);
    expect(done.status).toBe(200);
    const after = await agent.get('/finance/overview');
    expect(after.body.fieldglassQueue).toHaveLength(0);
  });

  it('counts the payroll case desk and stamps clientId on chase rows', async () => {
    const now = new Date();
    const client = await createClient('Front Beach 218');
    const a1 = await createAssociate();
    await prisma.timeEntry.create({
      data: {
        associateId: a1.id,
        clientId: client.id,
        clockInAt: new Date(now.getTime() - 30 * HOUR),
        clockOutAt: new Date(now.getTime() - 22 * HOUR),
        status: 'COMPLETED',
      },
    });
    const { user } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    // One open PAYROLL case routed to this accountant, one HR-side case
    // that must NOT count toward the payroll desk.
    await prisma.hrCase.create({
      data: {
        associateId: a1.id,
        category: 'PAYROLL',
        subject: 'Missing overtime on my last check',
        description: 'Week of the 12th shows 40h, I worked 46.',
        assignedToId: user.id,
      },
    });
    await prisma.hrCase.create({
      data: {
        associateId: a1.id,
        category: 'BENEFITS',
        subject: 'Dental question',
        description: 'Coverage start date?',
      },
    });

    const res = await (await loginAs(user.email)).get('/finance/overview');
    expect(res.status).toBe(200);
    expect(res.body.payrollCases).toEqual({ open: 1, assignedToMe: 1 });
    expect(res.body.close.byClient[0].clientId).toBe(client.id);
  });
});

describe('the money questions on /finance/overview', () => {
  const addDays = (ymd: string, n: number) => {
    const d = new Date(`${ymd}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };

  it('the pay cycle, last week in Fieldglass, revenue against wages week by week, and receivables by age', async () => {
    const now = new Date();
    const thisWeek = saturdayWeek(now, 'America/New_York').weekStart;
    const LW = addDays(thisWeek, -7); // last week — the one due in Fieldglass
    const PW = addDays(thisWeek, -14); // the week before
    await prisma.payrollSchedule.create({
      data: { name: 'Alto biweekly', frequency: 'BIWEEKLY', anchorDate: new Date(`${LW}T00:00:00Z`), payDateOffsetDays: 7 },
    });
    const client = await createClient('Walmart Destin');
    await prisma.client.update({ where: { id: client.id }, data: { fieldglassBillRate: 20, fieldglassSiteName: '1 - Onsite - FL - Destin' } });
    const ann = await createAssociate({ firstName: 'Ann', lastName: 'Lee' });
    const bo = await createAssociate({ firstName: 'Bo', lastName: 'Ray' });
    // Ann is paid $15/hr; Bo has no hourly pay on file — payroll's $15 fallback.
    await prisma.compensationRecord.create({
      data: { associateId: ann.id, payType: 'HOURLY', amount: 15, effectiveFrom: new Date('2026-01-01'), reason: 'HIRE' },
    });
    await prisma.fieldglassRegistration.create({ data: { associateId: ann.id, clientId: client.id, workerId: 'WKR1' } });
    const work = (associateId: string, day: string, hours: number, status: 'APPROVED' | 'COMPLETED' = 'APPROVED') => {
      const clockInAt = new Date(`${day}T13:00:00.000Z`);
      return prisma.timeEntry.create({
        data: { associateId, clientId: client.id, clockInAt, clockOutAt: new Date(clockInAt.getTime() + hours * HOUR), status },
      });
    };
    // Last week: Ann 8h, Bo 6h approved; Ann 3h more still awaiting approval.
    await work(ann.id, addDays(LW, 2), 8);
    await work(bo.id, addDays(LW, 2), 6);
    await work(ann.id, addDays(LW, 3), 3, 'COMPLETED');
    // The week before: Ann 45h — five hours of overtime.
    for (let d = 1; d <= 5; d++) await work(ann.id, addDays(PW, d), 9);
    // …and that week came back rejected from the buyer, not resubmitted yet.
    await prisma.fieldglassTimesheet.create({
      data: { weekStart: new Date(`${PW}T00:00:00Z`), associateId: ann.id, clientId: client.id, enteredAt: now, enteredHours: 45, fgStatus: 'REJECTED' },
    });
    // A statement finalized 45 days ago, unpaid.
    await prisma.clientStatement.create({
      data: {
        clientId: client.id,
        periodStart: new Date(now.getTime() - 52 * DAY),
        periodEnd: new Date(now.getTime() - 46 * DAY),
        number: 3,
        status: 'FINAL',
        finalizedAt: new Date(now.getTime() - 45 * DAY),
        snapshot: { totals: { amount: 1000, hours: 50, regularHours: 50, otHours: 0 } },
      },
    });

    const { user } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const res = await (await loginAs(user.email)).get('/finance/overview');
    expect(res.status).toBe(200);

    // The period this payday pays for: last week and this one.
    expect(res.body.payCycle).toEqual({
      periodStart: LW,
      periodEnd: addDays(LW, 13),
      payDate: addDays(LW, 20),
      schedule: 'Alto biweekly',
      hours: { approved: 14, pending: 3 },
      run: null,
    });

    // Last week in Fieldglass: Ann to enter, Bo not registered — all of it at risk.
    expect(res.body.billing).toMatchObject({
      weekStart: LW,
      weekEnd: addDays(LW, 6),
      dueAt: fieldglassDueAt(addDays(LW, 6)).toISOString(),
      workers: 2,
      registered: 1,
      notRegistered: 1,
      entered: 0,
      toEnter: 1,
      hours: 14,
      money: { approved: 0, awaiting: 0, atRisk: 280 },
      rejectedOpen: { count: 1, amount: 900 },
    });

    // Revenue at $20/hr against wages: straight time for last week…
    const weeks = res.body.margin.weeks as Array<{ weekStart: string; [k: string]: unknown }>;
    expect(weeks).toHaveLength(8);
    expect(weeks.at(-1)).toMatchObject({ weekStart: thisWeek, inProgress: true });
    expect(weeks.find((w) => w.weekStart === LW)).toMatchObject({ hours: 14, revenue: 280, wages: 210, margin: 70, marginPct: 0.25 });
    // …and time and a half past 40 for the week before: 40×15 + 5×22.50.
    expect(weeks.find((w) => w.weekStart === PW)).toMatchObject({ hours: 45, revenue: 900, wages: 712.5, margin: 187.5, marginPct: 0.208 });
    expect(res.body.margin).toMatchObject({ defaultRate: 15, defaultRateAssociates: 1 });

    // Receivables by age, and who owes it.
    expect(res.body.receivables.aging).toEqual({ current: 0, d31: 1000, d61: 0, d91: 0 });
    expect(res.body.receivables.byClient).toEqual([
      { clientId: client.id, clientName: 'Walmart Destin', amount: 1000, oldestDays: expect.any(Number) },
    ]);
    expect(res.body.receivables.byClient[0].oldestDays).toBeGreaterThanOrEqual(44);

    // A draft run for the period shows on the cycle.
    await prisma.payrollRun.create({
      data: { periodStart: new Date(`${LW}T00:00:00Z`), periodEnd: new Date(`${addDays(LW, 13)}T00:00:00Z`), status: 'DRAFT', totalGross: 3150 },
    });
    const again = await (await loginAs(user.email)).get('/finance/overview');
    expect(again.body.payCycle.run).toMatchObject({ status: 'DRAFT', totalGross: 3150 });
  });
});

describe('POST /finance/close/nudge', () => {
  it('pings the field leaders who own the approvals, deduped per client per day', async () => {
    const now = new Date();
    const client = await createClient('Front Beach 218');
    const other = await createClient('Destin 4411');
    const a1 = await createAssociate();
    await prisma.timeEntry.create({
      data: {
        associateId: a1.id,
        clientId: client.id,
        clockInAt: new Date(now.getTime() - 30 * HOUR),
        clockOutAt: new Date(now.getTime() - 22 * HOUR),
        status: 'COMPLETED',
      },
    });
    const { user: wfm } = await createUser({ role: 'WORKFORCE_MANAGER' });
    const { user: supHere } = await createUser({
      role: 'SHIFT_SUPERVISOR',
      clientId: client.id,
    });
    const { user: supElsewhere } = await createUser({
      role: 'SHIFT_SUPERVISOR',
      clientId: other.id,
    });
    const { user } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const agent = await loginAs(user.email);

    const first = await agent
      .post('/finance/close/nudge')
      .send({ clientId: client.id });
    expect(first.status).toBe(200);
    expect(first.body.deduped).toBe(false);
    // The WFM (field-wide) and THIS client's supervisor — never the
    // other store's.
    expect(first.body.notified).toBe(2);
    // notifyUser writes an IN_APP row AND an EMAIL row — assert on the
    // bell rows only.
    const rows = await prisma.notification.findMany({
      where: { category: 'finance.close_nudge', channel: 'IN_APP' },
      select: { recipientUserId: true, body: true, linkUrl: true },
    });
    const recipients = rows.map((r) => r.recipientUserId).sort();
    expect(recipients).toEqual([wfm.id, supHere.id].sort());
    expect(rows.every((r) => r.recipientUserId !== supElsewhere.id)).toBe(true);
    expect(rows[0]!.body).toContain('Front Beach 218');
    expect(rows[0]!.linkUrl).toContain('/time-attendance');

    // Same client, same day → deduped, no second blast.
    const second = await agent
      .post('/finance/close/nudge')
      .send({ clientId: client.id });
    expect(second.status).toBe(200);
    expect(second.body.deduped).toBe(true);
    expect(second.body.notified).toBe(0);
    expect(
      await prisma.notification.count({
        where: { category: 'finance.close_nudge', channel: 'IN_APP' },
      }),
    ).toBe(2);
  });

  it('sends nothing when there is nothing to approve, and is finance-gated', async () => {
    const client = await createClient('Front Beach 218');
    await createUser({ role: 'WORKFORCE_MANAGER' });
    const { user } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const res = await (await loginAs(user.email))
      .post('/finance/close/nudge')
      .send({ clientId: client.id });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ notified: 0, pendingEntries: 0 });

    const { user: wfm } = await createUser({ role: 'WORKFORCE_MANAGER' });
    const denied = await (await loginAs(wfm.email))
      .post('/finance/close/nudge')
      .send({});
    expect(denied.status).toBe(403);
  });
});
