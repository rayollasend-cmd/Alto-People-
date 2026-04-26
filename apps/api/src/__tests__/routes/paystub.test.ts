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

async function seedRunWithItem(opts: { associateState?: string | null } = {}) {
  const client = await createClient();
  const associate = await createAssociate({
    firstName: 'Pat',
    lastName: 'Earner',
    email: `pat-${Math.random().toString(36).slice(2, 8)}@example.com`,
  });
  if (opts.associateState !== undefined) {
    await prisma.associate.update({
      where: { id: associate.id },
      data: { state: opts.associateState },
    });
  }
  // Need a User record for the associate so they can log in.
  const { user: assocUser } = await createUser({
    role: 'ASSOCIATE',
    email: associate.email,
    associateId: associate.id,
  });

  // Approved time entry: 80 hours.
  const start = new Date('2026-04-01T13:00:00Z');
  const end = new Date('2026-04-15T00:00:00Z');
  await prisma.timeEntry.create({
    data: {
      associateId: associate.id,
      clientId: client.id,
      clockInAt: start,
      clockOutAt: new Date(start.getTime() + 80 * 60 * 60 * 1000),
      status: 'APPROVED',
      approvedAt: new Date(),
    },
  });
  // Use a real W-4 so the new tax engine has something to bite on.
  await prisma.w4Submission.create({
    data: {
      associateId: associate.id,
      filingStatus: 'SINGLE',
      multipleJobs: false,
      dependentsAmount: 0,
      otherIncome: 0,
      deductions: 0,
      extraWithholding: 0,
    },
  });

  const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
  const a = await loginAs(hr.email);
  const create = await a.post('/payroll/runs').send({
    periodStart: '2026-04-01',
    periodEnd: end.toISOString().slice(0, 10),
    defaultHourlyRate: 25,
  });
  if (create.status !== 201) {
    throw new Error(`run create failed ${create.status} ${JSON.stringify(create.body)}`);
  }
  const runId = create.body.id as string;
  const item = create.body.items[0];
  return { hrAgent: a, runId, item, associate, assocUserEmail: assocUser.email };
}

describe('POST /payroll/runs aggregation with new tax engine', () => {
  it('item carries the full Phase 18 tax breakdown (FIT/FICA/Medicare/SIT) and YTD snapshots', async () => {
    const { item } = await seedRunWithItem({ associateState: 'CA' });
    expect(item.hoursWorked).toBe(80);
    expect(item.hourlyRate).toBe(25);
    expect(item.grossPay).toBe(2000);
    expect(item.federalWithholding).toBeGreaterThan(0);
    expect(item.fica).toBeGreaterThan(0);
    expect(item.medicare).toBeGreaterThan(0);
    expect(item.stateWithholding).toBeGreaterThan(0);
    expect(item.taxState).toBe('CA');
    expect(item.ytdWages).toBe(0);
    expect(item.ytdMedicareWages).toBe(0);
    // Net = gross - (fed+fica+med+sit). Allow rounding fuzz.
    const sum = item.federalWithholding + item.fica + item.medicare + item.stateWithholding;
    expect(Math.abs(item.grossPay - sum - item.netPay)).toBeLessThan(0.05);
    // Employer side present.
    expect(item.employerFica).toBeGreaterThan(0);
    expect(item.employerMedicare).toBeGreaterThan(0);
    expect(item.employerFuta).toBeGreaterThan(0);
    expect(item.employerSuta).toBeGreaterThan(0);
  });

  it('Florida associate has zero state withholding', async () => {
    const { item } = await seedRunWithItem({ associateState: 'FL' });
    expect(item.stateWithholding).toBe(0);
    expect(item.taxState).toBe('FL');
  });
});

describe('GET /payroll/items/:itemId/paystub.pdf', () => {
  it('streams a PDF, sets X-Paystub-Hash, and stamps paystubHash on first download', async () => {
    const { hrAgent, item } = await seedRunWithItem({ associateState: 'CA' });

    const res = await hrAgent.get(`/payroll/items/${item.id}/paystub.pdf`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    const hash = res.headers['x-paystub-hash'];
    expect(hash).toMatch(/^[0-9a-f]{64}$/);

    // PDF magic bytes.
    expect(res.body.slice(0, 5).toString()).toBe('%PDF-');

    const stamped = await prisma.payrollItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(stamped.paystubHash).toBe(hash);
  });

  it('associate can fetch their own paystub but not someone else’s', async () => {
    const { item, assocUserEmail } = await seedRunWithItem();
    const a = await loginAs(assocUserEmail);
    const ok = await a.get(`/payroll/items/${item.id}/paystub.pdf`);
    expect(ok.status).toBe(200);

    // Make a second associate; they should 404 on the first associate's item.
    const { user: other } = await createUser({
      role: 'ASSOCIATE',
      email: `other-${Math.random().toString(36).slice(2, 8)}@example.com`,
    });
    const b = await loginAs(other.email);
    const denied = await b.get(`/payroll/items/${item.id}/paystub.pdf`);
    expect(denied.status).toBe(404);
  });

  it('returns 404 for an unknown itemId', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const res = await a.get('/payroll/items/00000000-0000-0000-0000-000000000000/paystub.pdf');
    expect(res.status).toBe(404);
  });
});
