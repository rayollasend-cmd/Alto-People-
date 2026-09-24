import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { saturdayWeek } from '../../lib/timesheetWeek.js';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

/**
 * An associate's whole timesheet, across pay periods: every week worked,
 * grouped into the pay periods that paid it, each with its day grid and
 * where it stands in Fieldglass — approved, rejected and why, resubmitted,
 * not entered and past due — plus finance's note, a CSV of every worked
 * day, and the Security ID for finance alone.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(createApp());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`loginAs(${email}) failed: ${r.status}`);
  return a;
}

const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

async function world() {
  // Three weeks, well in the past: W1 and W2 are one biweekly pay period,
  // W3 opens the next.
  const W1 = saturdayWeek(new Date(Date.now() - 49 * 86_400_000), 'America/New_York').weekStart;
  const W2 = addDays(W1, 7);
  const W3 = addDays(W1, 14);
  await prisma.payrollSchedule.create({
    data: { name: 'Alto biweekly', frequency: 'BIWEEKLY', anchorDate: new Date(`${W1}T00:00:00Z`), payDateOffsetDays: 7 },
  });
  const client = await createClient('Walmart Destin');
  await prisma.client.update({
    where: { id: client.id },
    data: { fieldglassSiteName: '1 - Onsite - FL - Destin', fieldglassBillRate: 20 },
  });
  const ann = await createAssociate({ firstName: 'Ann', lastName: 'Lee' });
  await prisma.associate.update({ where: { id: ann.id }, data: { dob: new Date('1994-03-02'), ssnLast4: '4321' } });
  await prisma.fieldglassRegistration.create({ data: { associateId: ann.id, clientId: client.id, workerId: 'WKR1' } });
  // Monday of each week, 9 AM Eastern; W3 also has Tuesday, not approved yet.
  const shift = async (weekStart: string, dayOffset: number, hours: number, status: 'APPROVED' | 'COMPLETED') => {
    const clockInAt = new Date(`${addDays(weekStart, dayOffset)}T13:00:00.000Z`);
    await prisma.timeEntry.create({
      data: { associateId: ann.id, clientId: client.id, clockInAt, clockOutAt: new Date(clockInAt.getTime() + hours * 3600_000), status },
    });
  };
  await shift(W1, 2, 8, 'APPROVED');
  await shift(W2, 2, 6, 'APPROVED');
  await shift(W3, 2, 7, 'APPROVED');
  await shift(W3, 3, 4, 'COMPLETED');
  await prisma.fieldglassTimesheet.createMany({
    data: [
      { weekStart: new Date(`${W1}T00:00:00Z`), associateId: ann.id, clientId: client.id, enteredAt: new Date(), enteredHours: 8, fgStatus: 'APPROVED', fgTimesheetId: 'WALTTS1', fgRevision: 0, fgHours: 8, fgSyncedAt: new Date() },
      { weekStart: new Date(`${W2}T00:00:00Z`), associateId: ann.id, clientId: client.id, enteredAt: new Date(), enteredHours: 6, fgStatus: 'REJECTED', fgTimesheetId: 'WALTTS2', fgRevision: 1, fgHours: 6, fgComment: 'Missing Sunday', fgSyncedAt: new Date() },
    ],
  });
  const { user: fin } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
  return { W1, W2, W3, client, ann, finance: await loginAs(fin.email) };
}

type Week = { weekStart: string; total: number; pendingHours: number; overdue: boolean; amount: number | null; fieldglass: Record<string, unknown> };
type Period = { periodStart: string; periodEnd: string; payDate: string; total: number; amount: number | null; weeks: Week[] };

describe('an associate’s timesheet history', () => {
  it('every week, by the pay period that paid it, with where each stands in Fieldglass', async () => {
    const w = await world();
    const res = await w.finance.get(`/time/admin/timesheets/history/${w.ann.id}`);
    expect(res.status).toBe(200);
    const h = res.body;
    expect(h.associate).toMatchObject({
      name: 'Ann Lee',
      worker: 'Lee, Ann',
      clientName: 'Walmart Destin',
      workerId: 'WKR1',
      securityId: '0302LE321',
      firstClockIn: { date: addDays(w.W1, 2), time: '9:00 AM' },
    });
    expect(h.schedule).toEqual({ name: 'Alto biweekly', frequency: 'BIWEEKLY' });

    const periods = h.periods as Period[];
    expect(periods.map((p) => p.periodStart)).toEqual([w.W3, w.W1]);
    const [next, first] = periods as [Period, Period];
    expect(first).toMatchObject({ periodEnd: addDays(w.W1, 13), payDate: addDays(w.W1, 20), total: 14, amount: 280 });
    expect(first.weeks.map((x) => x.weekStart)).toEqual([w.W2, w.W1]);
    const [w2, w1] = first.weeks as [Week, Week];
    expect(w1.fieldglass).toMatchObject({ status: 'APPROVED', timesheetId: 'WALTTS1', revision: 0, hours: 8 });
    expect(w2.fieldglass).toMatchObject({ status: 'REJECTED', comment: 'Missing Sunday' });
    const w3 = next.weeks[0]!;
    expect(w3).toMatchObject({ total: 7, pendingHours: 4, overdue: true, amount: 140 });
    expect(w3.fieldglass).toMatchObject({ registered: true, enteredAt: null, status: null });

    expect(h.totals).toMatchObject({
      hours: 21,
      weeks: 3,
      avgWeekHours: 7,
      pendingHours: 4,
      fieldglass: { approved: 1, rejected: 1, toEnter: 1, overdue: 1, awaiting: 0, notRegistered: 0 },
      // Approved 8h; the rejected 6h and the unentered 7h are at risk.
      money: { approved: 160, awaiting: 0, atRisk: 260 },
    });
    await flushPendingAudits();
    const audit = await prisma.auditLog.findFirst({ where: { action: 'associate.pii_viewed', entityId: w.ann.id } });
    expect(audit?.metadata).toMatchObject({ purpose: 'timesheet_history', fields: ['securityId'] });
  });

  it('as a spreadsheet: one row per worked day, with its pay period and Fieldglass standing', async () => {
    const w = await world();
    const res = await w.finance.get(`/time/admin/timesheets/history/${w.ann.id}?format=csv`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toContain('timesheet-history-lee-ann.csv');
    const lines = res.text.replace(/^\uFEFF/, '').split('\r\n');
    expect(lines[0]).toContain('Pay period,Pay date,Week ending');
    expect(lines[0]).toContain('Week amount');
    expect(lines).toHaveLength(4); // header + the three approved days
    expect(lines.find((l) => l.includes('Rejected'))).toBeDefined();
    expect(lines.find((l) => l.includes('Not entered — past due'))).toBeDefined();
  });

  it('a store-bound viewer: only their client’s weeks, never the money or the Security ID', async () => {
    const w = await world();
    const { user: sup } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: w.client.id });
    const theirs = (await (await loginAs(sup.email)).get(`/time/admin/timesheets/history/${w.ann.id}`)).body;
    expect(theirs.totals.hours).toBe(21);
    expect(theirs.totals.money).toBeNull();
    expect(theirs.periods[0].amount).toBeNull();
    expect(theirs.periods[0].weeks[0].amount).toBeNull();
    expect(theirs.associate.securityId).toBeNull();
    // Another client's supervisor: no such associate, as far as they know.
    const other = await createClient('Elsewhere');
    const { user: stranger } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: other.id });
    expect((await (await loginAs(stranger.email)).get(`/time/admin/timesheets/history/${w.ann.id}`)).status).toBe(404);
  });

  it('a rejected week, fixed and resubmitted — and finance’s note on a week', async () => {
    const w = await world();
    const weekIso = `${w.W2}T12:00:00.000Z`;
    const sent = await w.finance
      .post('/time/admin/timesheets/entered')
      .send({ weekStart: weekIso, associateId: w.ann.id, clientId: w.client.id, entered: true });
    expect(sent.status).toBe(200);
    let h = (await w.finance.get(`/time/admin/timesheets/history/${w.ann.id}`)).body;
    let w2 = (h.periods as Period[])[1]!.weeks[0]!;
    expect(w2.fieldglass).toMatchObject({ status: 'SUBMITTED', resubmittedAt: expect.any(String), comment: 'Missing Sunday' });
    expect(h.totals.fieldglass).toMatchObject({ rejected: 0, awaiting: 1 });
    await flushPendingAudits();
    expect(await prisma.auditLog.findFirst({ where: { action: 'timesheet.fieldglass_resubmitted', entityId: w.ann.id } })).not.toBeNull();
    // Undo: rejected again.
    await w.finance
      .post('/time/admin/timesheets/entered')
      .send({ weekStart: weekIso, associateId: w.ann.id, clientId: w.client.id, entered: false });
    h = (await w.finance.get(`/time/admin/timesheets/history/${w.ann.id}`)).body;
    w2 = (h.periods as Period[])[1]!.weeks[0]!;
    expect(w2.fieldglass).toMatchObject({ status: 'REJECTED', resubmittedAt: null });

    const noted = await w.finance
      .put('/time/admin/timesheets/note')
      .send({ weekStart: `${w.W3}T12:00:00.000Z`, associateId: w.ann.id, clientId: w.client.id, note: 'Buyer asked for the Tuesday split' });
    expect(noted.status).toBe(200);
    h = (await w.finance.get(`/time/admin/timesheets/history/${w.ann.id}`)).body;
    expect((h.periods as Period[])[0]!.weeks[0]!.fieldglass.note).toBe('Buyer asked for the Tuesday split');
    // No week there, no note.
    const nowhere = await w.finance
      .put('/time/admin/timesheets/note')
      .send({ weekStart: `${addDays(w.W1, -70)}T12:00:00.000Z`, associateId: w.ann.id, clientId: w.client.id, note: 'x' });
    expect(nowhere.status).toBe(404);
  });
});
