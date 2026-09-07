import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

/**
 * The handoff spine's newest seams, end to end through the routes:
 *   - the company clock every department head reads
 *   - the chairman's batons-in-flight counts
 *   - separation completion → the Fieldglass close-out bell
 *   - manager-approved reimbursement → the settlement bell
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
  if (r.status !== 200) throw new Error(`loginAs failed: ${r.status}`);
  return a;
}

const HOUR = 3600_000;

describe('GET /company/clock', () => {
  it('serves the shared rhythm to staff, and refuses associates', async () => {
    await prisma.payrollSchedule.create({
      data: {
        name: 'Weekly — associates',
        frequency: 'WEEKLY',
        anchorDate: new Date(Date.now() - 10 * 24 * HOUR),
        payDateOffsetDays: 5,
      },
    });
    const { user: wfm } = await createUser({ role: 'WORKFORCE_MANAGER' });
    const res = await (await loginAs(wfm.email)).get('/company/clock');
    expect(res.status).toBe(200);
    expect(res.body.weekEndsOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(res.body.closeOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(res.body.payday).not.toBeNull();
    // The close is a Tuesday, org-local.
    const closeDay = new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      timeZone: 'America/New_York',
    }).format(new Date(`${res.body.closeOn}T12:00:00Z`));
    expect(closeDay).toBe('Tue');

    const associate = await createAssociate();
    const { user } = await createUser({
      role: 'ASSOCIATE',
      email: associate.email,
      associateId: associate.id,
    });
    expect((await (await loginAs(user.email)).get('/company/clock')).status).toBe(403);
  });
});

describe('GET /executive/batons', () => {
  it('counts the work in motion between departments', async () => {
    const client = await createClient('Front Beach 218');
    // A dead Fieldglass account (separated, still registered).
    const gone = await createAssociate({ firstName: 'Gone', lastName: 'Worker' });
    await prisma.fieldglassRegistration.create({
      data: { associateId: gone.id, clientId: client.id },
    });
    await prisma.associate.update({
      where: { id: gone.id },
      data: { separatedAt: new Date() },
    });
    // A ready-to-schedule approval (no upcoming shift).
    const waiting = await createAssociate({ firstName: 'Ben', lastName: 'Waiting' });
    await prisma.application.create({
      data: {
        associateId: waiting.id,
        clientId: client.id,
        onboardingTrack: 'STANDARD',
        status: 'APPROVED',
        approvedAt: new Date(),
      },
    });
    // One unapproved timesheet, one open payroll case, one open incident.
    await prisma.timeEntry.create({
      data: {
        associateId: waiting.id,
        clientId: client.id,
        clockInAt: new Date(Date.now() - 30 * HOUR),
        clockOutAt: new Date(Date.now() - 22 * HOUR),
        status: 'COMPLETED',
      },
    });
    await prisma.hrCase.create({
      data: {
        associateId: waiting.id,
        category: 'PAYROLL',
        subject: 'Short check',
        description: 'Missing hours.',
      },
    });
    await prisma.oshaIncident.create({
      data: {
        clientId: client.id,
        occurredAt: new Date(),
        description: 'Slip in receiving.',
        severity: 'FIRST_AID',
        isRecordable: false,
      },
    });

    const { user: exec } = await createUser({ role: 'EXECUTIVE_CHAIRMAN' });
    const res = await (await loginAs(exec.email)).get('/executive/batons');
    expect(res.status).toBe(200);
    expect(res.body.batons.fieldglass.closeOuts).toBe(1);
    expect(res.body.batons.readyToSchedule).toBe(1);
    expect(res.body.batons.unapprovedTimesheets).toBe(1);
    expect(res.body.batons.payrollCasesOpen).toBe(1);
    expect(res.body.batons.incidentsOpen).toBe(1);
  });
});

describe('separation completion → Fieldglass close-out bell', () => {
  it('completing a separation notifies Finance about the registered account', async () => {
    const client = await createClient('Front Beach 218');
    const associate = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
    await prisma.fieldglassRegistration.create({
      data: { associateId: associate.id, clientId: client.id },
    });
    const { user: fin } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const agent = await loginAs(hr.email);

    const created = await agent.post('/separations').send({
      associateId: associate.id,
      reason: 'VOLUNTARY_PERSONAL',
      lastDayWorked: new Date().toISOString().slice(0, 10),
    });
    expect(created.status).toBe(201);
    // PLANNED → IN_PROGRESS → COMPLETE.
    await agent.post(`/separations/${created.body.id}/advance`);
    const complete = await agent.post(`/separations/${created.body.id}/advance`);
    expect(complete.status).toBe(200);
    await flushPendingNotifications();

    const note = await prisma.notification.findFirst({
      where: { category: 'finance.fieldglass_close', recipientUserId: fin.id },
    });
    expect(note).not.toBeNull();
    expect(note?.subject).toContain('Maria Lopez');
    expect(note?.body).toContain('final pay');
    expect(note?.linkUrl).toContain(associate.id);
  });
});

describe('manager-approved reimbursement → settlement bell', () => {
  it('manager approval lands one notification on the Finance desk', async () => {
    const associate = await createAssociate({ firstName: 'Ana', lastName: 'Reyes' });
    await createUser({
      role: 'ASSOCIATE',
      email: associate.email,
      associateId: associate.id,
    });
    const { user: fin } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const { user: mgr } = await createUser({ role: 'OPERATIONS_MANAGER' });
    const r = await prisma.reimbursement.create({
      data: {
        associateId: associate.id,
        title: 'Steel-toe boots',
        totalAmount: 84.5,
        status: 'SUBMITTED',
        submittedAt: new Date(),
      },
    });
    const res = await (await loginAs(mgr.email))
      .post(`/reimbursements/${r.id}/manager-approve`)
      .send({});
    expect(res.status).toBe(200);
    await flushPendingNotifications();

    const note = await prisma.notification.findFirst({
      where: { category: 'finance.reimbursement', recipientUserId: fin.id },
    });
    expect(note).not.toBeNull();
    expect(note?.subject).toContain('Ana Reyes');
    expect(note?.subject).toContain('84.50');
    expect(note?.linkUrl).toBe('/reimbursements');
  });
});
