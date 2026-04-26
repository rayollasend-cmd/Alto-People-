import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import {
  DEFAULT_TEST_PASSWORD,
  createApplicationWithChecklist,
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

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

describe('GET /analytics/dashboard', () => {
  it('returns zero counts on an empty schema', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const res = await a.get('/analytics/dashboard');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      activeAssociates: 0,
      openShiftsNext30d: 0,
      associatesClockedIn: 0,
      pendingOnboardingApplications: 0,
      pendingI9Section2: 0,
      pendingDocumentReviews: 0,
      netPaidLast30d: 0,
      netPendingDisbursement: 0,
    });
    expect(res.body.applicationStatusCounts).toEqual({});
  });

  it('counts associates, applications, time entries, shifts', async () => {
    const client = await createClient();
    const a1 = await createAssociate();
    const a2 = await createAssociate();
    await createApplicationWithChecklist({ associateId: a1.id, clientId: client.id });
    // Mark second app as APPROVED so only the first counts as pending
    const app2 = await createApplicationWithChecklist({
      associateId: a2.id,
      clientId: client.id,
    });
    await prisma.application.update({
      where: { id: app2.id },
      data: { status: 'APPROVED' },
    });

    // One open shift in the next 30 days, one cancelled.
    await prisma.shift.create({
      data: {
        clientId: client.id,
        position: 'Server',
        startsAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        endsAt: new Date(Date.now() + 32 * 60 * 60 * 1000),
        status: 'OPEN',
      },
    });
    await prisma.shift.create({
      data: {
        clientId: client.id,
        position: 'Server',
        startsAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        endsAt: new Date(Date.now() + 32 * 60 * 60 * 1000),
        status: 'CANCELLED',
      },
    });

    // One ACTIVE time entry (currently clocked in)
    await prisma.timeEntry.create({
      data: {
        associateId: a1.id,
        clientId: client.id,
        clockInAt: new Date(),
        status: 'ACTIVE',
      },
    });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const agent = await loginAs(hr.email);
    const res = await agent.get('/analytics/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.activeAssociates).toBe(2);
    expect(res.body.openShiftsNext30d).toBe(1);
    expect(res.body.associatesClockedIn).toBe(1);
    expect(res.body.pendingOnboardingApplications).toBe(1);
    expect(res.body.applicationStatusCounts).toMatchObject({
      DRAFT: 1,
      APPROVED: 1,
    });
  });

  it('aggregates payroll: paid in last 30d vs pending disbursement', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    await prisma.payrollRun.create({
      data: {
        periodStart: new Date('2026-04-01'),
        periodEnd: new Date('2026-04-15'),
        status: 'DISBURSED',
        totalGross: 1000,
        totalTax: 180,
        totalNet: 820,
        disbursedAt: new Date(),
      },
    });
    await prisma.payrollRun.create({
      data: {
        periodStart: new Date('2026-04-16'),
        periodEnd: new Date('2026-04-30'),
        status: 'FINALIZED',
        totalGross: 500,
        totalTax: 90,
        totalNet: 410,
        finalizedAt: new Date(),
      },
    });
    await prisma.payrollRun.create({
      data: {
        periodStart: new Date('2026-04-16'),
        periodEnd: new Date('2026-04-30'),
        status: 'DRAFT',
        totalGross: 200,
        totalTax: 36,
        totalNet: 164,
      },
    });

    const a = await loginAs(hr.email);
    const res = await a.get('/analytics/dashboard');
    expect(res.body.netPaidLast30d).toBe(820);
    expect(res.body.netPendingDisbursement).toBe(410 + 164);
  });

  it('counts pending I-9 section 2', async () => {
    const a1 = await createAssociate();
    const a2 = await createAssociate();
    await prisma.i9Verification.create({
      data: { associateId: a1.id, section1CompletedAt: new Date() },
    });
    await prisma.i9Verification.create({
      data: {
        associateId: a2.id,
        section1CompletedAt: new Date(),
        section2CompletedAt: new Date(),
        documentList: 'LIST_A',
      },
    });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const agent = await loginAs(hr.email);
    const res = await agent.get('/analytics/dashboard');
    expect(res.body.pendingI9Section2).toBe(1);
  });

  it('returns 401 unauthenticated', async () => {
    const res = await request(app()).get('/analytics/dashboard');
    expect(res.status).toBe(401);
  });

  it('ASSOCIATE has view:dashboard so the request is 200', async () => {
    const associate = await createAssociate();
    const { user } = await createUser({
      role: 'ASSOCIATE',
      email: associate.email,
      associateId: associate.id,
    });
    const a = await loginAs(user.email);
    const res = await a.get('/analytics/dashboard');
    expect(res.status).toBe(200);
  });
});
