import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { flushPendingAudits } from '../../lib/audit.js';
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

describe('I-9 endpoints', () => {
  it('upserts a section 1 record', async () => {
    const associate = await createAssociate();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const res = await a
      .post(`/compliance/i9/${associate.id}`)
      .send({ section1CompletedAt: new Date().toISOString() });
    expect(res.status).toBe(200);
    expect(res.body.section1CompletedAt).not.toBeNull();
    expect(res.body.section2CompletedAt).toBeNull();
  });

  it('records section 2 with verifier and document list', async () => {
    const associate = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const res = await a.post(`/compliance/i9/${associate.id}`).send({
      section1CompletedAt: new Date().toISOString(),
      section2CompletedAt: new Date().toISOString(),
      documentList: 'LIST_A',
    });
    expect(res.status).toBe(200);
    expect(res.body.section2CompletedAt).not.toBeNull();
    expect(res.body.documentList).toBe('LIST_A');
    expect(res.body.section2VerifierUserId).toBe(hr.id);
    expect(res.body.section2VerifierEmail).toBe(hr.email);

    await flushPendingAudits();
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'compliance.i9_updated', entityId: res.body.id },
    });
    expect(audit).not.toBeNull();
  });

  it('rejects section 2 record without documentList → 400', async () => {
    const associate = await createAssociate();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const res = await a
      .post(`/compliance/i9/${associate.id}`)
      .send({ section2CompletedAt: new Date().toISOString() });
    expect(res.status).toBe(400);
  });

  it('GET /compliance/i9 supports pending/complete filter', async () => {
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

    const pending = await agent.get('/compliance/i9?status=pending');
    expect(pending.body.i9s.map((r: { associateId: string }) => r.associateId)).toEqual([a1.id]);

    const complete = await agent.get('/compliance/i9?status=complete');
    expect(complete.body.i9s.map((r: { associateId: string }) => r.associateId)).toEqual([a2.id]);

    const all = await agent.get('/compliance/i9');
    expect(all.body.i9s).toHaveLength(2);
  });

  it('ASSOCIATE cannot upsert (no manage:compliance) but can GET', async () => {
    const associate = await createAssociate();
    const { user } = await createUser({
      role: 'ASSOCIATE',
      email: associate.email,
      associateId: associate.id,
    });
    const a = await loginAs(user.email);

    const get = await a.get('/compliance/i9');
    // ASSOCIATE doesn't have view:compliance either, so this is 403.
    expect(get.status).toBe(403);

    const post = await a
      .post(`/compliance/i9/${associate.id}`)
      .send({ section1CompletedAt: new Date().toISOString() });
    expect(post.status).toBe(403);
  });
});

describe('Background check endpoints', () => {
  it('HR initiates a check (stubbed) and updates status to PASSED', async () => {
    const client = await createClient();
    const associate = await createAssociate();
    // Need an Application so the route can derive clientId.
    await prisma.application.create({
      data: {
        associateId: associate.id,
        clientId: client.id,
        onboardingTrack: 'STANDARD',
        status: 'DRAFT',
      },
    });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const initiate = await a.post('/compliance/background').send({
      associateId: associate.id,
      provider: 'alto-stub',
    });
    expect(initiate.status).toBe(201);
    expect(initiate.body.status).toBe('INITIATED');
    expect(initiate.body.clientId).toBe(client.id);

    const update = await a
      .post(`/compliance/background/${initiate.body.id}/update`)
      .send({ status: 'PASSED', externalId: 'ext-12345' });
    expect(update.status).toBe(200);
    expect(update.body.status).toBe('PASSED');
    expect(update.body.completedAt).not.toBeNull();
    expect(update.body.externalId).toBe('ext-12345');
  });

  it('initiate with unknown associateId → 404', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const res = await a.post('/compliance/background').send({
      associateId: '00000000-0000-4000-8000-000000000000',
      provider: 'alto-stub',
    });
    expect(res.status).toBe(404);
  });

  it('non-terminal status updates do not set completedAt', async () => {
    const associate = await createAssociate();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const initiate = await a.post('/compliance/background').send({
      associateId: associate.id,
      provider: 'alto-stub',
    });
    const update = await a
      .post(`/compliance/background/${initiate.body.id}/update`)
      .send({ status: 'IN_PROGRESS' });
    expect(update.body.status).toBe('IN_PROGRESS');
    expect(update.body.completedAt).toBeNull();
  });

  it('list carries reportCount; detail returns the report docs and audits the view', async () => {
    const associate = await createAssociate();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const initiate = await a.post('/compliance/background').send({
      associateId: associate.id,
      provider: 'alto-stub',
    });
    expect(initiate.status).toBe(201);
    const checkId = initiate.body.id as string;

    // Two report docs on the associate; a deleted one must not count.
    const mkDoc = (filename: string, deletedAt: Date | null = null) =>
      prisma.documentRecord.create({
        data: {
          associateId: associate.id,
          kind: 'BACKGROUND_CHECK_RESULT',
          s3Key: null, // no file on disk → fileAvailable must come back false
          filename,
          mimeType: 'application/pdf',
          size: 1234,
          deletedAt,
        },
      });
    await mkDoc('checkr-report.pdf');
    await mkDoc('checkr-supplement.pdf');
    await mkDoc('old-deleted.pdf', new Date());

    const list = await a.get('/compliance/background');
    expect(list.status).toBe(200);
    const row = list.body.checks.find((c: { id: string }) => c.id === checkId);
    expect(row.reportCount).toBe(2);

    const detail = await a.get(`/compliance/background/${checkId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.check.id).toBe(checkId);
    expect(detail.body.check.reportCount).toBe(2);
    expect(detail.body.reports).toHaveLength(2);
    expect(detail.body.reports.map((r: { filename: string }) => r.filename)).toEqual([
      'checkr-report.pdf',
      'checkr-supplement.pdf',
    ]);
    // s3Key null → the record exists but the file doesn't; UI disables preview.
    expect(detail.body.reports.every((r: { fileAvailable: boolean }) => !r.fileAvailable)).toBe(
      true,
    );

    // FCRA: reading the report list is a recorded disclosure.
    await flushPendingAudits();
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'compliance.background_report_viewed', entityId: checkId },
    });
    expect(audit).toBeTruthy();
  });

  it('pending lists never-screened associates tagged with directory status', async () => {
    const client = await createClient();
    const mkApplicant = async (
      firstName: string,
      lastName: string,
      status: 'DRAFT' | 'APPROVED' | 'REJECTED' = 'DRAFT',
    ) => {
      const a = await createAssociate({ firstName, lastName });
      await prisma.application.create({
        data: {
          associateId: a.id,
          clientId: client.id,
          onboardingTrack: 'STANDARD',
          status,
        },
      });
      return a;
    };

    const working = await mkApplicant('Now', 'Working', 'APPROVED');
    const onboarding = await mkApplicant('Still', 'Onboarding');
    const checked = await mkApplicant('Already', 'Checked');
    await prisma.backgroundCheck.create({
      data: { associateId: checked.id, provider: 'alto-stub', status: 'FAILED' },
    });
    const declined = await mkApplicant('Was', 'Rejected', 'REJECTED');
    const noApp = await createAssociate({ firstName: 'No', lastName: 'Application' });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const res = await a.get('/compliance/background/pending');
    expect(res.status).toBe(200);
    // A FAILED check still counts as screened — everyone else appears,
    // tagged with the same status rule the People directory uses.
    const byId = new Map(
      (res.body.rows as { associateId: string; status: string }[]).map((r) => [
        r.associateId,
        r.status,
      ]),
    );
    expect(byId.size).toBe(4);
    expect(byId.has(checked.id)).toBe(false);
    expect(byId.get(working.id)).toBe('ACTIVE');
    expect(byId.get(onboarding.id)).toBe('PENDING');
    expect(byId.get(declined.id)).toBe('INACTIVE');
    expect(byId.get(noApp.id)).toBe('INACTIVE');
    expect(res.body.truncated).toBe(false);

    // The export read is audited.
    await flushPendingAudits();
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'compliance.background_pending_exported' },
    });
    expect(audit).toBeTruthy();
  });

  it('bulk-initiate creates INITIATED rows and skips associates who raced into a check', async () => {
    const client = await createClient();
    const fresh = await createAssociate({ firstName: 'Fresh', lastName: 'Hire' });
    await prisma.application.create({
      data: {
        associateId: fresh.id,
        clientId: client.id,
        onboardingTrack: 'STANDARD',
        status: 'DRAFT',
      },
    });
    const raced = await createAssociate({ firstName: 'Raced', lastName: 'Ahead' });
    await prisma.backgroundCheck.create({
      data: { associateId: raced.id, provider: 'alto-stub', status: 'IN_PROGRESS' },
    });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const res = await a.post('/compliance/background/bulk-initiate').send({
      associateIds: [fresh.id, raced.id],
      provider: 'checkr',
    });
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(1);
    expect(res.body.skipped).toBe(1);

    const created = await prisma.backgroundCheck.findFirst({
      where: { associateId: fresh.id },
    });
    expect(created).toBeTruthy();
    expect(created!.status).toBe('INITIATED');
    expect(created!.provider).toBe('checkr');
    expect(created!.clientId).toBe(client.id);
    // The raced associate still has exactly one check — no duplicate.
    const racedCount = await prisma.backgroundCheck.count({
      where: { associateId: raced.id },
    });
    expect(racedCount).toBe(1);
  });

  it('detail: unknown id → 404; CLIENT_PORTAL blocked at the router guard', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const missing = await a.get(
      '/compliance/background/00000000-0000-4000-8000-000000000000',
    );
    expect(missing.status).toBe(404);

    // CLIENT_PORTAL lacks view:compliance, so the /compliance mount 403s
    // before scopeBackgroundChecks even runs — the scope clamp is a second
    // fence behind this one.
    const client = await createClient();
    const { user: portal } = await createUser({
      role: 'CLIENT_PORTAL',
      clientId: client.id,
    });
    const p = await loginAs(portal.email);
    const res = await p.get('/compliance/background/00000000-0000-4000-8000-000000000000');
    expect(res.status).toBe(403);
  });
});

describe('Drug test endpoints', () => {
  const resultDoc = (associateId: string, createdAt: Date) =>
    prisma.documentRecord.create({
      data: {
        associateId,
        kind: 'DRUG_TEST_RESULT',
        s3Key: null,
        filename: 'lab-result.pdf',
        mimeType: 'application/pdf',
        size: 1234,
        createdAt,
      },
    });

  it('order + update lifecycle mirrors background checks', async () => {
    const client = await createClient();
    const associate = await createAssociate();
    await prisma.application.create({
      data: {
        associateId: associate.id,
        clientId: client.id,
        onboardingTrack: 'STANDARD',
        status: 'APPROVED',
      },
    });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const order = await a.post('/compliance/drug-tests').send({
      associateId: associate.id,
      provider: 'checkr',
    });
    expect(order.status).toBe(201);
    expect(order.body.status).toBe('INITIATED');
    expect(order.body.clientId).toBe(client.id);

    const update = await a
      .post(`/compliance/drug-tests/${order.body.id}/update`)
      .send({ status: 'PASSED', externalId: 'scr-777' });
    expect(update.status).toBe(200);
    expect(update.body.status).toBe('PASSED');
    expect(update.body.completedAt).not.toBeNull();
  });

  it('pending is driven by the 60-day result window, not by row existence', async () => {
    const dayMs = 86_400_000;
    const fresh = await createAssociate({ firstName: 'Fresh', lastName: 'Result' });
    await resultDoc(fresh.id, new Date(Date.now() - 10 * dayMs)); // inside window

    const stale = await createAssociate({ firstName: 'Stale', lastName: 'Result' });
    const staleDate = new Date(Date.now() - 61 * dayMs); // aged out
    await resultDoc(stale.id, staleDate);
    // A long-closed PASSED row must NOT exempt them — recurrence is the point.
    await prisma.drugTest.create({
      data: {
        associateId: stale.id,
        provider: 'checkr',
        status: 'PASSED',
        completedAt: staleDate,
      },
    });

    const never = await createAssociate({ firstName: 'Never', lastName: 'Tested' });

    const ordered = await createAssociate({ firstName: 'Order', lastName: 'InFlight' });
    await prisma.drugTest.create({
      data: { associateId: ordered.id, provider: 'checkr', status: 'INITIATED' },
    });

    const recentPass = await createAssociate({ firstName: 'Recent', lastName: 'Pass' });
    await prisma.drugTest.create({
      data: {
        associateId: recentPass.id,
        provider: 'checkr',
        status: 'PASSED',
        completedAt: new Date(Date.now() - 5 * dayMs), // paperwork pending
      },
    });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const res = await a.get('/compliance/drug-tests/pending');
    expect(res.status).toBe(200);
    const rows = res.body.rows as { associateId: string; lastResultAt: string | null }[];
    const ids = rows.map((r) => r.associateId);
    // Due: stale result and never tested. Not due: fresh result, order in
    // flight, recent pass awaiting paperwork.
    expect(ids).toContain(stale.id);
    expect(ids).toContain(never.id);
    expect(ids).not.toContain(fresh.id);
    expect(ids).not.toContain(ordered.id);
    expect(ids).not.toContain(recentPass.id);
    // lastResultAt distinguishes expired from never-tested.
    expect(rows.find((r) => r.associateId === stale.id)!.lastResultAt).toBe(
      staleDate.toISOString(),
    );
    expect(rows.find((r) => r.associateId === never.id)!.lastResultAt).toBeNull();
  });

  it('bulk-initiate creates orders and skips open ones — closed history does not block', async () => {
    const retest = await createAssociate({ firstName: 'Re', lastName: 'Test' });
    await prisma.drugTest.create({
      data: {
        associateId: retest.id,
        provider: 'checkr',
        status: 'PASSED',
        completedAt: new Date('2026-01-01T00:00:00Z'), // old, closed
      },
    });
    const open = await createAssociate({ firstName: 'Open', lastName: 'Order' });
    await prisma.drugTest.create({
      data: { associateId: open.id, provider: 'checkr', status: 'IN_PROGRESS' },
    });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const res = await a.post('/compliance/drug-tests/bulk-initiate').send({
      associateIds: [retest.id, open.id],
      provider: 'checkr',
    });
    expect(res.status).toBe(200);
    // Re-test allowed despite closed history; open order not duplicated.
    expect(res.body.created).toBe(1);
    expect(res.body.skipped).toBe(1);
    const retestCount = await prisma.drugTest.count({ where: { associateId: retest.id } });
    expect(retestCount).toBe(2);
    const openCount = await prisma.drugTest.count({ where: { associateId: open.id } });
    expect(openCount).toBe(1);
  });

  it('detail returns result docs and audits the view', async () => {
    const associate = await createAssociate();
    const test = await prisma.drugTest.create({
      data: { associateId: associate.id, provider: 'checkr', status: 'PASSED' },
    });
    await resultDoc(associate.id, new Date());

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const res = await a.get(`/compliance/drug-tests/${test.id}`);
    expect(res.status).toBe(200);
    expect(res.body.test.id).toBe(test.id);
    expect(res.body.reports).toHaveLength(1);
    expect(res.body.reports[0].fileAvailable).toBe(false); // s3Key null

    await flushPendingAudits();
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'compliance.drug_test_report_viewed', entityId: test.id },
    });
    expect(audit).toBeTruthy();
  });
});

describe('J-1 endpoints', () => {
  it('upserts a J-1 profile and flips Associate.j1Status to true', async () => {
    const associate = await createAssociate();
    expect(associate.j1Status).toBe(false);

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const res = await a.post(`/compliance/j1/${associate.id}`).send({
      programStartDate: '2026-05-01',
      programEndDate: '2026-09-30',
      ds2019Number: 'N1234567890',
      sponsorAgency: 'Council on International Educational Exchange',
      country: 'Spain',
    });
    expect(res.status).toBe(200);
    expect(res.body.programStartDate).toBe('2026-05-01');
    expect(res.body.programEndDate).toBe('2026-09-30');
    expect(typeof res.body.daysUntilEnd).toBe('number');

    const refreshed = await prisma.associate.findUniqueOrThrow({ where: { id: associate.id } });
    expect(refreshed.j1Status).toBe(true);
  });

  it('upsert is idempotent — second call updates in place', async () => {
    const associate = await createAssociate();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const first = await a.post(`/compliance/j1/${associate.id}`).send({
      programStartDate: '2026-05-01',
      programEndDate: '2026-09-30',
      ds2019Number: 'N1234567890',
      sponsorAgency: 'CIEE',
      country: 'Spain',
    });
    const second = await a.post(`/compliance/j1/${associate.id}`).send({
      programStartDate: '2026-05-01',
      programEndDate: '2026-10-31',
      ds2019Number: 'N1234567890',
      sponsorAgency: 'CIEE',
      country: 'Spain',
    });
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.programEndDate).toBe('2026-10-31');
  });

  it('rejects programEndDate before programStartDate → 400', async () => {
    const associate = await createAssociate();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const res = await a.post(`/compliance/j1/${associate.id}`).send({
      programStartDate: '2026-09-30',
      programEndDate: '2026-05-01',
      ds2019Number: 'X',
      sponsorAgency: 'X',
      country: 'X',
    });
    expect(res.status).toBe(400);
  });

  it('GET /compliance/j1 supports expiringWithin filter', async () => {
    const a1 = await createAssociate();
    const a2 = await createAssociate();
    const soon = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    const farLater = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    await prisma.j1Profile.create({
      data: {
        associateId: a1.id,
        programStartDate: new Date('2026-01-01'),
        programEndDate: soon,
        ds2019Number: 'A',
        sponsorAgency: 'X',
        country: 'Spain',
      },
    });
    await prisma.j1Profile.create({
      data: {
        associateId: a2.id,
        programStartDate: new Date('2026-01-01'),
        programEndDate: farLater,
        ds2019Number: 'B',
        sponsorAgency: 'X',
        country: 'Brazil',
      },
    });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const agent = await loginAs(hr.email);
    const res = await agent.get('/compliance/j1?expiringWithin=30');
    expect(res.body.profiles.map((p: { associateId: string }) => p.associateId)).toEqual([a1.id]);
  });
});
