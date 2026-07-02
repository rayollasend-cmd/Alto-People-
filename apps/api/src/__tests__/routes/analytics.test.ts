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

  it('returns weekly trends: 8 buckets + delta of last complete week', async () => {
    const client = await createClient();
    const associate = await createAssociate();

    // Anchor on UTC week starts so fixtures land in deterministic buckets.
    // Bucket 7 = current (partial) week, 6 = last complete week, 5 = prior.
    const thisWeek = new Date();
    thisWeek.setUTCHours(0, 0, 0, 0);
    thisWeek.setUTCDate(thisWeek.getUTCDate() - thisWeek.getUTCDay());
    const weekStart = (weeksAgo: number, dayOffsetHours = 12) =>
      new Date(thisWeek.getTime() - weeksAgo * 7 * 24 * 60 * 60 * 1000 + dayOffsetHours * 60 * 60 * 1000);

    // Shifts: 2 last complete week, 1 the week before → delta +1.
    for (const startsAt of [weekStart(1), weekStart(1, 36), weekStart(2)]) {
      await prisma.shift.create({
        data: {
          clientId: client.id,
          position: 'Server',
          startsAt,
          endsAt: new Date(startsAt.getTime() + 8 * 60 * 60 * 1000),
          status: 'OPEN',
        },
      });
    }
    // Cancelled shifts don't count.
    await prisma.shift.create({
      data: {
        clientId: client.id,
        position: 'Server',
        startsAt: weekStart(1),
        endsAt: new Date(weekStart(1).getTime() + 8 * 60 * 60 * 1000),
        status: 'CANCELLED',
      },
    });

    // Hours worked: one 8h punch last complete week, none the week
    // before → delta +8.
    await prisma.timeEntry.create({
      data: {
        associateId: associate.id,
        clientId: client.id,
        clockInAt: weekStart(1),
        clockOutAt: new Date(weekStart(1).getTime() + 8 * 60 * 60 * 1000),
        status: 'COMPLETED',
      },
    });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const agent = await loginAs(hr.email);
    const res = await agent.get('/analytics/dashboard');
    expect(res.status).toBe(200);

    const trends = res.body.trends;
    expect(trends).toBeDefined();
    for (const key of ['hoursWorked', 'shiftsScheduled', 'applications', 'hires']) {
      expect(trends[key].series).toHaveLength(8);
      expect(trends[key].series.every((n: unknown) => typeof n === 'number')).toBe(true);
      expect(typeof trends[key].delta).toBe('number');
    }

    expect(trends.shiftsScheduled.series[6]).toBe(2);
    expect(trends.shiftsScheduled.series[5]).toBe(1);
    expect(trends.shiftsScheduled.delta).toBe(1);

    expect(trends.hoursWorked.series[6]).toBe(8);
    expect(trends.hoursWorked.delta).toBe(8);

    // Associate created just now lands in the current (partial) bucket,
    // which the delta intentionally ignores.
    expect(trends.hires.series[7]).toBe(1);
    expect(trends.hires.delta).toBe(0);
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
