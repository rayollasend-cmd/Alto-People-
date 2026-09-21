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
    expect(res.status).toBe(204);
  });

  it('demotions are unaffected', async () => {
    const { user: ops } = await createUser({ role: 'OPERATIONS_MANAGER' });
    const { user: target } = await createUser({ role: 'INTERNAL_RECRUITER' });
    const a = await loginAs(ops.email);

    const res = await a.patch(`/admin/users/${target.id}`).send({ role: 'ASSOCIATE' });
    expect(res.status).toBe(204);
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

describe('a report schedule runs as the report owner, so scheduling is borrowing their reach', () => {
  /**
   * /reports/:id/run checked `isPublic || createdById`. The schedule
   * routes did not — and lib/reportScheduleRunner resolves the session
   * from report.createdById and emails the CSV to the recipients. So
   * anyone who could SEE a public report could schedule it, have it
   * execute with ITS AUTHOR's scope, and be sent the rows on a timer.
   *
   * These routes are guarded by view:analytics, which CLIENT_PORTAL
   * holds: a customer's store manager could have HR's associate and
   * payroll reports mailed to them, for every client, indefinitely.
   */
  async function hrReportAndPortalUser() {
    const mine = await createClient('Mine');
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hrAgent = await loginAs(hr.email);
    const made = await hrAgent.post('/reports').send({
      name: 'Everyone, everywhere',
      entity: 'ASSOCIATE',
      spec: { columns: ['id', 'firstName', 'lastName', 'email'], limit: 1000 },
      isPublic: true,
    });
    expect(made.status).toBe(201);
    const { user: portal } = await createUser({ role: 'CLIENT_PORTAL', clientId: mine.id });
    return { reportId: made.body.id as string, portal, hr, hrAgent };
  }

  it('refuses to let a portal account schedule somebody else’s report', async () => {
    const { reportId, portal } = await hrReportAndPortalUser();
    const a = await loginAs(portal.email);

    // Visible in the list — public reports are meant to be readable.
    const listed = await a.get('/reports');
    expect(listed.status).toBe(200);

    const res = await a.post(`/reports/${reportId}/schedules`).send({
      cadence: 'DAILY',
      recipients: portal.email,
    });
    // 404, not 403: whether a report exists is not something to confirm.
    expect(res.status).toBe(404);
    expect(await prisma.reportSchedule.count({ where: { reportId } })).toBe(0);
  });

  it('refuses to hand over the recipient list of somebody else’s report', async () => {
    const { reportId, portal } = await hrReportAndPortalUser();
    const a = await loginAs(portal.email);
    expect((await a.get(`/reports/${reportId}/schedules`)).status).toBe(404);
  });

  it('refuses to let one user delete another user’s schedule', async () => {
    const { reportId, portal, hr, hrAgent } = await hrReportAndPortalUser();
    const made = await hrAgent
      .post(`/reports/${reportId}/schedules`)
      .send({ cadence: 'DAILY', recipients: hr.email });
    expect(made.status).toBe(201);
    const scheduleId = made.body.id as string;

    const a = await loginAs(portal.email);
    expect((await a.delete(`/report-schedules/${scheduleId}`)).status).toBe(404);
    // Still there — a bare id was enough to delete it before.
    expect(await prisma.reportSchedule.count({ where: { id: scheduleId } })).toBe(1);
  });

  it('still lets the owner schedule their own report', async () => {
    const { reportId, hr, hrAgent } = await hrReportAndPortalUser();
    const res = await hrAgent
      .post(`/reports/${reportId}/schedules`)
      .send({ cadence: 'WEEKLY', recipients: hr.email });
    expect(res.status).toBe(201);
  });
});

describe('bulk PII exports are gated on the capability built for them', () => {
  /**
   * Three artifacts carry the company's worst data in one file: the
   * payroll census (full SSN, bank routing + account, DOB, home address
   * for EVERY associate), the new-hire report (SSNs and addresses), and
   * the audit packet (I-9 images and SSN cards for a whole roster).
   *
   * The first two sat on process:payroll and the third on view:hr-admin —
   * six roles each, including MARKETING_MANAGER and INTERNAL_RECRUITER.
   * roles.ts already defined export:payroll-pii for exactly this and
   * reserved it; the exports simply never used it.
   */
  const census = (a: TestAgent<Test>) =>
    a.post('/org/associates/payroll-census-export').send({ reason: 'Quarterly payroll reconciliation' });

  it('refuses the census to roles with no business holding it', async () => {
    for (const role of ['MARKETING_MANAGER', 'INTERNAL_RECRUITER', 'MANAGER', 'OPERATIONS_MANAGER'] as const) {
      const { user } = await createUser({ role });
      const a = await loginAs(user.email);
      const res = await census(a);
      expect(res.status, `${role} should not export the census`).toBe(403);
    }
  });

  it('keeps it open to the two roles that run payroll', async () => {
    // Finance IS the payroll admin here — locking them out would break the
    // pay cycle, which is why the capability widened by exactly one role
    // rather than the export staying open to four.
    for (const role of ['HR_ADMINISTRATOR', 'FINANCE_ACCOUNTANT'] as const) {
      const { user } = await createUser({ role });
      const a = await loginAs(user.email);
      expect((await census(a)).status, `${role} should keep the census`).not.toBe(403);
    }
  });

  it('holds the new-hire report to the same bar — it is the same data', async () => {
    const { user: marketing } = await createUser({ role: 'MARKETING_MANAGER' });
    const m = await loginAs(marketing.email);
    expect((await m.get('/payroll/new-hire-report.csv')).status).toBe(403);

    const { user: fin } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const f = await loginAs(fin.email);
    expect((await f.get('/payroll/new-hire-report.csv')).status).not.toBe(403);
  });

  it('keeps the audit packet to the owner and HR, not everyone who can read HR pages', async () => {
    const body = { scope: 'ALL_WORKFORCE', reason: 'DOL audit preparation' };
    for (const role of ['MARKETING_MANAGER', 'INTERNAL_RECRUITER', 'MANAGER'] as const) {
      const { user } = await createUser({ role });
      const a = await loginAs(user.email);
      expect((await a.post('/audit-packets/generate').send(body)).status, role).toBe(403);
    }
    // The chairman keeps it — the one export capability a read-only role
    // holds, deliberately — and so does HR, who hand it to the auditor.
    for (const role of ['EXECUTIVE_CHAIRMAN', 'HR_ADMINISTRATOR'] as const) {
      const { user } = await createUser({ role });
      const a = await loginAs(user.email);
      expect((await a.post('/audit-packets/generate').send(body)).status, role).not.toBe(403);
    }
  });
});
