import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import ExcelJS from 'exceljs';
import { createApp } from '../../app.js';
import { fieldglassDueAt, normalizeFieldglassStatus, workerKey } from '../../lib/fieldglassDesk.js';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

/**
 * The Fieldglass desk — getting paid for a SOW worker's week: a
 * registration packet with everything the buyer's form asks (and what's
 * missing), the Worker ID kept, unregistered hours called out with the
 * money at risk, each worker's week ticked off as entered, and the buyer's
 * Fieldglass list imported back — approved, rejected, hours that differ.
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

// The Sat 2026-06-13 → Fri 2026-06-19 week; hours on Monday.
const WEEK = '2026-06-15T12:00:00.000Z';
const WEEK_START = '2026-06-13';

async function approved(associateId: string, clientId: string, hours: number) {
  const clockInAt = new Date('2026-06-15T13:00:00.000Z');
  return prisma.timeEntry.create({
    data: { associateId, clientId, clockInAt, clockOutAt: new Date(clockInAt.getTime() + hours * 3600_000), status: 'APPROVED' },
  });
}

async function world() {
  const client = await createClient('Walmart Destin');
  await prisma.client.update({
    where: { id: client.id },
    data: { fieldglassSiteName: '1 - Onsite - FL - Destin', fieldglassBillRate: 20 },
  });
  const ann = await createAssociate({ firstName: 'Ann', lastName: 'Lee' });
  const bo = await createAssociate({ firstName: 'Bo', lastName: 'Ray' });
  await approved(ann.id, client.id, 8);
  await approved(bo.id, client.id, 6);
  const { user: fin } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
  return { client, ann, bo, fin, finance: await loginAs(fin.email) };
}

describe('the registration packet', () => {
  it('has what Fieldglass asks for, in its terms, names what’s missing — and every look is audited', async () => {
    const w = await world();
    await prisma.associate.update({
      where: { id: w.ann.id },
      data: {
        dob: new Date('1994-03-02'),
        ssnLast4: '4321',
        phone: '850-555-0100',
        addressLine1: '9 Harbor Rd',
        city: 'Destin',
        state: 'FL',
        zip: '32541',
      },
    });
    const loc = await prisma.location.findFirstOrThrow({ where: { clientId: w.client.id } });
    await prisma.shift.create({
      data: {
        clientId: w.client.id,
        locationId: loc.id,
        position: 'Overnight Stocker',
        startsAt: new Date(Date.now() + 3 * 86_400_000),
        endsAt: new Date(Date.now() + 3 * 86_400_000 + 8 * 3600_000),
        status: 'ASSIGNED',
        assignedAssociateId: w.ann.id,
        publishedAt: new Date(),
      },
    });
    await prisma.application.create({ data: { associateId: w.ann.id, clientId: w.client.id, onboardingTrack: 'STANDARD', status: 'APPROVED', approvedAt: new Date() } });
    await prisma.backgroundCheck.create({ data: { associateId: w.ann.id, provider: 'Checkr', status: 'PASSED', completedAt: new Date() } });

    const res = await w.finance.get(`/finance/fieldglass/${w.ann.id}/packet`);
    expect(res.status).toBe(200);
    const p = res.body.packet;
    expect(p.worker).toMatchObject({ listName: 'Lee, Ann', dob: '1994-03-02', ssnLast4: '4321', address: { city: 'Destin', zip: '32541' } });
    expect(p.engagement).toMatchObject({ clientName: 'Walmart Destin', site: '1 - Onsite - FL - Destin', billRate: 20, position: 'Overnight Stocker' });
    expect(p.engagement.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(p.screening.backgroundCheck.status).toBe('PASSED');
    expect(p.missing).toEqual(['I-9 Section 2']);

    // Bo has almost nothing yet — the form would stall; the packet says so first.
    const bo = (await w.finance.get(`/finance/fieldglass/${w.bo.id}/packet`)).body.packet;
    expect(bo.missing).toEqual(expect.arrayContaining(['Date of birth', 'Last 4 of SSN', 'Home address', 'Background check']));

    const audit = await prisma.auditLog.findFirst({ where: { action: 'associate.pii_viewed', entityId: w.ann.id } });
    expect(audit).not.toBeNull();
    // Not a supervisor's to see.
    const { user: sup } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: w.client.id });
    expect((await (await loginAs(sup.email)).get(`/finance/fieldglass/${w.ann.id}/packet`)).status).toBe(403);
  });

  it('keeps the Worker ID Fieldglass gave them — on marking added, or later', async () => {
    const w = await world();
    await prisma.application.create({ data: { associateId: w.ann.id, clientId: w.client.id, onboardingTrack: 'STANDARD', status: 'APPROVED', approvedAt: new Date() } });
    const added = await w.finance.post(`/finance/fieldglass/${w.ann.id}/done`).send({ workerId: 'WKR00012345' });
    expect(added.status).toBe(200);
    expect(await prisma.fieldglassRegistration.findUnique({ where: { associateId: w.ann.id } })).toMatchObject({
      clientId: w.client.id,
      workerId: 'WKR00012345',
    });
    // Marked again without an ID: the one on file stays.
    await w.finance.post(`/finance/fieldglass/${w.ann.id}/done`).send({});
    expect((await prisma.fieldglassRegistration.findUniqueOrThrow({ where: { associateId: w.ann.id } })).workerId).toBe('WKR00012345');
    expect((await w.finance.patch(`/finance/fieldglass/${w.ann.id}`).send({ workerId: 'WKR-99' })).body.workerId).toBe('WKR-99');
    expect((await w.finance.patch(`/finance/fieldglass/${w.ann.id}`).send({ workerId: 'no spaces' })).status).toBe(400);
    expect((await w.finance.patch(`/finance/fieldglass/${w.bo.id}`).send({ workerId: 'WKR1' })).status).toBe(409);
  });
});

describe('the worklist', () => {
  it('someone already working without a Fieldglass account is on it — first, with the hours that can’t be billed', async () => {
    const w = await world();
    // Working now: no recent approval, no scheduled shift — a walk-in, an old hire.
    const clockInAt = new Date(Date.now() - 2 * 86_400_000);
    await prisma.timeEntry.create({
      data: { associateId: w.bo.id, clientId: w.client.id, clockInAt, clockOutAt: new Date(clockInAt.getTime() + 7.5 * 3600_000), status: 'APPROVED' },
    });
    const overview = await w.finance.get('/finance/overview');
    expect(overview.status).toBe(200);
    const row = overview.body.fieldglassQueue.find((r: { associateId: string }) => r.associateId === w.bo.id);
    expect(row).toMatchObject({ kind: 'add', clientName: 'Walmart Destin', hoursUnbilled: 7.5 });
    // Registered: off the list.
    await w.finance.post(`/finance/fieldglass/${w.bo.id}/done`).send({ workerId: 'WKR5' });
    const after = await w.finance.get('/finance/overview');
    expect(after.body.fieldglassQueue.find((r: { associateId: string }) => r.associateId === w.bo.id)).toBeUndefined();
  });
});

describe('the week in Fieldglass', () => {
  it('calls out hours that can’t be billed, tracks each worker entered, and prices it', async () => {
    const w = await world();
    await prisma.fieldglassRegistration.create({ data: { associateId: w.ann.id, clientId: w.client.id, workerId: 'WKR1' } });

    const week = await w.finance.post('/time/admin/timesheets').send({ weekStart: WEEK, clientId: w.client.id });
    expect(week.status).toBe(200);
    const ann = week.body.rows.find((r: { associateId: string }) => r.associateId === w.ann.id);
    const bo = week.body.rows.find((r: { associateId: string }) => r.associateId === w.bo.id);
    expect(ann.fieldglass).toMatchObject({ registered: true, workerId: 'WKR1', enteredAt: null, status: null });
    expect(bo.fieldglass).toMatchObject({ registered: false });
    expect(week.body.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'NOT_IN_FIELDGLASS', associateId: w.bo.id })]),
    );
    expect(week.body.fieldglass).toMatchObject({
      dueAt: '2026-06-22T21:00:00.000Z', // Mon 2:00 PM Pacific after the Fri 6/19 week end
      workers: 2,
      entered: 0,
      notRegistered: 1,
      money: { billRate: 20, approved: 0, awaiting: 0, atRisk: 280 },
    });

    // Enter Ann's week: it's awaiting approval now. Bo can't be entered.
    const entered = await w.finance
      .post('/time/admin/timesheets/entered')
      .send({ weekStart: WEEK, associateId: w.ann.id, clientId: w.client.id, entered: true });
    expect(entered.status).toBe(200);
    const refused = await w.finance
      .post('/time/admin/timesheets/entered')
      .send({ weekStart: WEEK, associateId: w.bo.id, clientId: w.client.id, entered: true });
    expect(refused.body.error.code).toBe('not_registered');
    const after = await w.finance.post('/time/admin/timesheets').send({ weekStart: WEEK, clientId: w.client.id });
    expect(after.body.fieldglass).toMatchObject({ entered: 1, money: { approved: 0, awaiting: 160, atRisk: 120 } });
    expect(after.body.rows.find((r: { associateId: string }) => r.associateId === w.ann.id).fieldglass).toMatchObject({
      enteredHours: 8,
      enteredBy: expect.any(String),
    });

    // A store-bound role sees the statuses, never the money.
    const { user: sup } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: w.client.id });
    const theirs = await (await loginAs(sup.email)).post('/time/admin/timesheets').send({ weekStart: WEEK });
    expect(theirs.body.fieldglass.money).toBeNull();
    expect(theirs.body.fieldglass.entered).toBe(1);
  });

  it('imports the buyer’s Fieldglass list: approved and rejected, the timesheet IDs, the hours that differ, the rows that don’t match', async () => {
    const w = await world();
    await prisma.fieldglassRegistration.createMany({
      data: [
        { associateId: w.ann.id, clientId: w.client.id },
        { associateId: w.bo.id, clientId: w.client.id },
      ],
    });
    // The list as Fieldglass exports it: a title, then its columns.
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Timesheets');
    ws.addRow(['Timesheets']);
    ws.addRow([]);
    ws.addRow(['Status', 'ID', 'Revision', 'Worker', 'Worker ID', 'Site', 'End', 'ST', 'OT', 'DT', 'Others', 'NB', 'Total']);
    ws.addRow(['Approved', 'WALTTS00001', 0, 'Lee, Ann', 'WKR777', '1 - Onsite - FL - Destin', '06/19/2026', 0, 0, 0, 8, 0, 8]);
    ws.addRow(['Rejected', 'WALTTS00002', 1, 'Ray, Bo', '', '1 - Onsite - FL - Destin', '06/19/2026', 0, 0, 0, 5.5, 0, 5.5]);
    ws.addRow(['Submitted', 'WALTTS00003', 0, 'Nobody, Here', '', '1 - Onsite - FL - Destin', '06/19/2026', 0, 0, 0, 4, 0, 4]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());

    const res = await w.finance
      .post('/time/admin/timesheets/fieldglass-import')
      .field('clientId', w.client.id)
      .attach('file', buf, { filename: 'Timesheets.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ weeks: [WEEK_START], rows: 3, matched: 2, statuses: { APPROVED: 1, REJECTED: 1 } });
    expect(res.body.unmatched).toEqual([expect.objectContaining({ worker: 'Nobody, Here', hours: 4 })]);
    expect(res.body.variances).toEqual([expect.objectContaining({ associateId: w.bo.id, alto: 6, fieldglass: 5.5 })]);
    // The Worker ID the list names, kept.
    expect((await prisma.fieldglassRegistration.findUniqueOrThrow({ where: { associateId: w.ann.id } })).workerId).toBe('WKR777');

    const week = await w.finance.post('/time/admin/timesheets').send({ weekStart: WEEK, clientId: w.client.id });
    expect(week.body.rows.find((r: { associateId: string }) => r.associateId === w.ann.id).fieldglass).toMatchObject({
      status: 'APPROVED',
      timesheetId: 'WALTTS00001',
      revision: 0,
      hours: 8,
    });
    expect(week.body.fieldglass).toMatchObject({
      approved: 1,
      rejected: 1,
      variances: 1,
      money: { approved: 160, awaiting: 0, atRisk: 120 },
    });

    // A CSV works too, and a file with nothing in it says why.
    const csv = 'Status,Worker,End,Total\nApproved,"Ray, Bo",2026-06-19,6\n';
    const again = await w.finance
      .post('/time/admin/timesheets/fieldglass-import')
      .field('clientId', w.client.id)
      .attach('file', Buffer.from(csv), { filename: 'list.csv', contentType: 'text/csv' });
    expect(again.body).toMatchObject({ matched: 1, variances: [] });
    const empty = await w.finance
      .post('/time/admin/timesheets/fieldglass-import')
      .attach('file', Buffer.from('nothing here'), { filename: 'x.csv', contentType: 'text/csv' });
    expect(empty.body.error.code).toBe('nothing_found');
  });
});

describe('the desk’s rules', () => {
  it('due Monday 2:00 PM Pacific after the week-ending Friday; statuses in Fieldglass’s words; names either way round', () => {
    expect(fieldglassDueAt('2026-09-18').toISOString()).toBe('2026-09-21T21:00:00.000Z');
    expect(fieldglassDueAt('2026-11-27').toISOString()).toBe('2026-11-30T22:00:00.000Z'); // PST
    expect(normalizeFieldglassStatus('Pending Approval')).toBe('SUBMITTED');
    expect(normalizeFieldglassStatus('Approved')).toBe('APPROVED');
    expect(normalizeFieldglassStatus('Invoiced')).toBe('INVOICED');
    expect(normalizeFieldglassStatus('Rejected')).toBe('REJECTED');
    expect(normalizeFieldglassStatus('Draft')).toBe('DRAFT');
    expect(workerKey('Nelson, Aaliyah M.')).toBe(workerKey('Aaliyah Nelson'));
  });
});
