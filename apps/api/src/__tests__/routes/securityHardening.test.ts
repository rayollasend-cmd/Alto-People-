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
import { _resetKioskRateLimit } from '../../lib/kioskRateLimit.js';

// Regression tests for the security review. Each block names the class of
// bug it locks down, so a future refactor that reopens one fails loudly.

const app = () => createApp();

beforeEach(async () => {
  await truncateAll();
  _resetKioskRateLimit();
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

describe('report builder is tenant-scoped', () => {
  it('CLIENT_PORTAL cannot read associates outside its own client', async () => {
    const mine = await createClient('My Client');
    const other = await createClient('Other Client');
    // An associate who belongs to the OTHER client via an approved app.
    const stranger = await createAssociate({
      firstName: 'Stranger',
      lastName: 'Danger',
    });
    await prisma.application.create({
      data: {
        associateId: stranger.id,
        clientId: other.id,
        status: 'APPROVED',
        onboardingTrack: 'STANDARD',
      },
    });
    const { user: portal } = await createUser({
      role: 'CLIENT_PORTAL',
      clientId: mine.id,
    });
    const a = await loginAs(portal.email);

    const res = await a.post('/reports/preview').send({
      name: 'probe',
      entity: 'ASSOCIATE',
      spec: { columns: ['id', 'firstName', 'lastName', 'email'], limit: 1000 },
    });

    expect(res.status).toBe(200);
    const ids = (res.body.rows as Array<{ id: string }>).map((r) => r.id);
    expect(ids).not.toContain(stranger.id);
  });

  it('CLIENT_PORTAL cannot read payroll items from another tenant', async () => {
    const mine = await createClient('Mine');
    const other = await createClient('Theirs');
    const assoc = await createAssociate({ firstName: 'Pay', lastName: 'Roll' });
    const run = await prisma.payrollRun.create({
      data: {
        clientId: other.id,
        periodStart: new Date('2026-01-01'),
        periodEnd: new Date('2026-01-14'),
        status: 'DRAFT',
      },
    });
    await prisma.payrollItem.create({
      data: {
        payrollRunId: run.id,
        associateId: assoc.id,
        hoursWorked: 40,
        hourlyRate: 20,
        grossPay: 800,
        federalWithholding: 80,
        netPay: 640,
      },
    });
    const { user: portal } = await createUser({
      role: 'CLIENT_PORTAL',
      clientId: mine.id,
    });
    const a = await loginAs(portal.email);

    const res = await a.post('/reports/preview').send({
      name: 'probe',
      entity: 'PAYROLL_ITEM',
      spec: { columns: ['id', 'grossAmount', 'netAmount'], limit: 1000 },
    });
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(0);
  });

  it('HR still sees org-wide data (the scope must not break the real user)', async () => {
    const client = await createClient();
    const assoc = await createAssociate({ firstName: 'Visible', lastName: 'Person' });
    await prisma.application.create({
      data: {
        associateId: assoc.id,
        clientId: client.id,
        status: 'APPROVED',
        onboardingTrack: 'STANDARD',
      },
    });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const res = await a.post('/reports/preview').send({
      name: 'probe',
      entity: 'ASSOCIATE',
      spec: { columns: ['id', 'firstName'], limit: 1000 },
    });
    expect(res.status).toBe(200);
    const ids = (res.body.rows as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toContain(assoc.id);
  });
});

describe('role assignment cannot escalate privilege', () => {
  it('a FULL_ADMIN-tier role cannot promote anyone to HR_ADMINISTRATOR', async () => {
    // OPERATIONS_MANAGER holds view:hr-admin but NOT export:payroll-pii.
    const { user: ops } = await createUser({ role: 'OPERATIONS_MANAGER' });
    const { user: target } = await createUser({ role: 'ASSOCIATE' });
    const a = await loginAs(ops.email);

    const res = await a
      .patch(`/admin/users/${target.id}`)
      .send({ role: 'HR_ADMINISTRATOR' });

    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('role_escalation_forbidden');
    const after = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(after.role).toBe('ASSOCIATE');
  });

  it('HR_ADMINISTRATOR can still grant HR_ADMINISTRATOR', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const { user: target } = await createUser({ role: 'ASSOCIATE' });
    const a = await loginAs(hr.email);

    const res = await a
      .patch(`/admin/users/${target.id}`)
      .send({ role: 'HR_ADMINISTRATOR' });
    expect(res.status).toBe(200);
  });

  it('demotions are unaffected', async () => {
    const { user: ops } = await createUser({ role: 'OPERATIONS_MANAGER' });
    const { user: target } = await createUser({ role: 'INTERNAL_RECRUITER' });
    const a = await loginAs(ops.email);

    const res = await a.patch(`/admin/users/${target.id}`).send({ role: 'ASSOCIATE' });
    expect(res.status).toBe(200);
  });
});

describe('bare-mounted handlers require authentication', () => {
  it('W-2 PDF (full SSN) returns 401 without a session, not a 500', async () => {
    const res = await request(app()).get(
      '/tax-forms/00000000-0000-4000-8000-000000000000/pdf',
    );
    expect(res.status).toBe(401);
  });

  it('referral submission returns 401 without a session', async () => {
    const res = await request(app())
      .post('/referrals')
      .send({ candidateName: 'X', candidateEmail: 'x@example.com' });
    expect(res.status).toBe(401);
  });
});

describe('outbound webhook SSRF guard', () => {
  it('refuses a loopback URL', async () => {
    const { user: admin } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(admin.email);
    const res = await a
      .post('/webhooks')
      .send({ name: 'evil', url: 'https://127.0.0.1/hook', eventTypes: [] });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('private_url');
  });

  it('refuses the cloud metadata address', async () => {
    const { user: admin } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(admin.email);
    const res = await a.post('/webhooks').send({
      name: 'metadata',
      url: 'https://169.254.169.254/latest/meta-data/',
      eventTypes: [],
    });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('private_url');
  });

  it('refuses plain http', async () => {
    const { user: admin } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(admin.email);
    const res = await a
      .post('/webhooks')
      .send({ name: 'insecure', url: 'http://example.com/hook', eventTypes: [] });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('insecure_url');
  });
});

describe('user-supplied URLs must be http(s)', () => {
  it('rejects a javascript: resume URL on the PUBLIC careers form', async () => {
    const client = await createClient();
    const posting = await prisma.jobPosting.create({
      data: {
        clientId: client.id,
        title: 'Cook',
        description: 'Line cook',
        slug: `cook-${Math.random().toString(36).slice(2, 8)}`,
        status: 'OPEN',
      },
    });
    const res = await request(app())
      .post(`/careers/${posting.slug}/apply`)
      .send({
        firstName: 'Mal',
        lastName: 'Actor',
        email: `mal-${Math.random().toString(36).slice(2, 8)}@example.com`,
        resumeUrl: 'javascript:alert(document.cookie)',
      });
    expect(res.status).toBe(400);
    // Nothing stored.
    const candidates = await prisma.candidate.findMany({
      where: { resumeUrl: { startsWith: 'javascript:' } },
    });
    expect(candidates).toHaveLength(0);
  });
});
