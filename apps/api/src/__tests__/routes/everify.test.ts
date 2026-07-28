import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { encryptString } from '../../lib/crypto.js';
import { flushPendingAudits } from '../../lib/audit.js';
import {
  DEFAULT_TEST_PASSWORD,
  createApplicationWithChecklist,
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

/**
 * E-Verify directorate.
 *
 * The feature exists because gathering these fields took ~20 minutes per case
 * across five screens. What these tests protect: that the roster surfaces the
 * people who still need action (including those with no I-9 yet), and that the
 * aggregation payload — which carries a decrypted SSN — stays behind
 * manage:compliance and leaves an audit trail.
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
  if (r.status !== 200) {
    throw new Error(`loginAs(${email}) failed: ${r.status} ${JSON.stringify(r.body)}`);
  }
  return a;
}

/** An onboarding associate with an application but nothing else done. */
async function onboardingAssociate(clientId: string, name = 'Fresh') {
  const associate = await createAssociate({ firstName: name, lastName: 'Start' });
  await createApplicationWithChecklist({ associateId: associate.id, clientId });
  return associate;
}

/** An associate ready to run: I-9 both sections, SSN, DOB, hire date. */
async function readyAssociate(clientId: string, name = 'Ready') {
  const associate = await createAssociate({ firstName: name, lastName: 'ToRun' });
  await createApplicationWithChecklist({ associateId: associate.id, clientId });
  await prisma.associate.update({
    where: { id: associate.id },
    data: { dob: new Date('1990-03-04'), hireDate: new Date('2026-06-04') },
  });
  await prisma.w4Submission.create({
    data: {
      associateId: associate.id,
      filingStatus: 'SINGLE',
      ssnEncrypted: encryptString('012-34-5678'),
    },
  });
  await prisma.i9Verification.create({
    data: {
      associateId: associate.id,
      section1CompletedAt: new Date('2026-06-01T00:00:00.000Z'),
      section2CompletedAt: new Date('2026-06-02T00:00:00.000Z'),
      citizenshipStatus: 'US_CITIZEN',
      documentList: 'LIST_A',
    },
  });
  return associate;
}

describe('GET /compliance/everify — roster', () => {
  // The existing /compliance/i9 list is driven by I9Verification rows, so it
  // cannot show anyone who hasn't started an I-9 — exactly the people this
  // queue is for. This is the reason the roster is Associate-driven.
  it('includes an associate with no I-9 row at all', async () => {
    const client = await createClient();
    const fresh = await onboardingAssociate(client.id);
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);

    const res = await a.get('/compliance/everify');
    expect(res.status).toBe(200);

    const row = res.body.rows.find(
      (r: { associateId: string }) => r.associateId === fresh.id,
    );
    expect(row).toBeTruthy();
    expect(row.blockers).toContain('NO_I9');
    expect(row.ready).toBe(false);
    expect(row.status).toBeNull();
  });

  it('marks a fully-prepared associate ready with a deadline', async () => {
    const client = await createClient();
    const ready = await readyAssociate(client.id);
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);

    const res = await a.get('/compliance/everify');
    const row = res.body.rows.find(
      (r: { associateId: string }) => r.associateId === ready.id,
    );
    expect(row.ready).toBe(true);
    expect(row.blockers).toEqual([]);
    // Thursday 2026-06-04 + 3 business days.
    expect(row.dueBy).toBe('2026-06-09');
  });

  it('excludes associates whose only application was rejected', async () => {
    const client = await createClient();
    const declined = await createAssociate({ firstName: 'Nope', lastName: 'Declined' });
    const appRow = await createApplicationWithChecklist({
      associateId: declined.id,
      clientId: client.id,
    });
    await prisma.application.update({
      where: { id: appRow.id },
      data: { status: 'REJECTED' },
    });

    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);
    const res = await a.get('/compliance/everify');

    expect(
      res.body.rows.find((r: { associateId: string }) => r.associateId === declined.id),
    ).toBeUndefined();
  });

  it('counts the snapshot buckets', async () => {
    const client = await createClient();
    await onboardingAssociate(client.id, 'Blocked');
    const ready = await readyAssociate(client.id, 'Authorized');
    await prisma.i9Verification.update({
      where: { associateId: ready.id },
      data: {
        eVerifyStatus: 'EMPLOYMENT_AUTHORIZED',
        eVerifyCaseNumber: '2026-123-456',
        eVerifyCaseOpenedAt: new Date('2026-06-05T00:00:00.000Z'),
      },
    });

    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);
    const res = await a.get('/compliance/everify');

    expect(res.body.counts.total).toBe(2);
    expect(res.body.counts.authorized).toBe(1);
    expect(res.body.counts.notRun).toBe(1);
    expect(res.body.counts.blocked).toBe(1);
  });
});

describe('GET /compliance/everify/:associateId — aggregation', () => {
  it('returns every portal field in one payload', async () => {
    const client = await createClient();
    const ready = await readyAssociate(client.id);
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);

    const res = await a.get(`/compliance/everify/${ready.id}`);
    expect(res.status).toBe(200);
    expect(res.body.lastName).toBe('ToRun');
    expect(res.body.dob).toBe('1990-03-04');
    // The point of the screen: the SSN is here, not three pages away.
    expect(res.body.ssn).toBe('012-34-5678');
    expect(res.body.citizenshipStatus).toBe('US_CITIZEN');
    expect(res.body.documentList).toBe('LIST_A');
    expect(res.body.hireDate).toBe('2026-06-04');
    expect(res.body.ready).toBe(true);
  });

  // view:compliance includes EXECUTIVE_CHAIRMAN, a read-only role that has no
  // business seeing an SSN — which is why the detail route adds MANAGE rather
  // than relying on the router-level guard.
  it('is forbidden to EXECUTIVE_CHAIRMAN despite view:compliance', async () => {
    const client = await createClient();
    const ready = await readyAssociate(client.id);
    const { user } = await createUser({ role: 'EXECUTIVE_CHAIRMAN' });
    const a = await loginAs(user.email);

    await a.get(`/compliance/everify/${ready.id}`).expect(403);
  });

  it('reports an unreadable SSN as a blocker rather than failing', async () => {
    const client = await createClient();
    const ready = await readyAssociate(client.id);
    // Ciphertext that won't decrypt under the current key — the shape a row
    // left behind by the 2026-06-11 key rotation has.
    await prisma.w4Submission.update({
      where: { associateId: ready.id },
      data: { ssnEncrypted: Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]) },
    });

    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);
    const res = await a.get(`/compliance/everify/${ready.id}`);

    expect(res.status).toBe(200);
    expect(res.body.ssn).toBeNull();
    expect(res.body.blockers).toContain('NO_SSN');
  });

  it('audits the disclosure', async () => {
    const client = await createClient();
    const ready = await readyAssociate(client.id);
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);

    await a.get(`/compliance/everify/${ready.id}`).expect(200);
    await flushPendingAudits();

    const entry = await prisma.auditLog.findFirst({
      where: { action: 'compliance.everify_case_viewed' },
      orderBy: { createdAt: 'desc' },
    });
    expect(entry).toBeTruthy();
    expect(entry!.actorUserId).toBe(user.id);
    expect((entry!.metadata as Record<string, unknown>).ssnDisclosed).toBe(true);
  });
});

describe('POST /compliance/everify/:associateId/case', () => {
  it('records the outcome and moves the roster status', async () => {
    const client = await createClient();
    const ready = await readyAssociate(client.id);
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);

    const res = await a
      .post(`/compliance/everify/${ready.id}/case`)
      .send({
        caseNumber: '2026-123-456',
        status: 'EMPLOYMENT_AUTHORIZED',
        caseOpenedAt: '2026-06-05T00:00:00.000Z',
      });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('EMPLOYMENT_AUTHORIZED');

    const roster = await a.get('/compliance/everify');
    const row = roster.body.rows.find(
      (r: { associateId: string }) => r.associateId === ready.id,
    );
    expect(row.status).toBe('EMPLOYMENT_AUTHORIZED');
    expect(row.caseNumber).toBe('2026-123-456');
    // A case exists now, so the deadline no longer flags.
    expect(row.overdue).toBe(false);
  });

  it('rejects an outcome with no case number', async () => {
    const client = await createClient();
    const ready = await readyAssociate(client.id);
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);

    await a
      .post(`/compliance/everify/${ready.id}/case`)
      .send({ status: 'EMPLOYMENT_AUTHORIZED' })
      .expect(400);
  });

  // E-Verify is downstream of Form I-9 by law.
  it('409s when the associate has no I-9', async () => {
    const client = await createClient();
    const fresh = await onboardingAssociate(client.id);
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);

    await a
      .post(`/compliance/everify/${fresh.id}/case`)
      .send({ caseNumber: '2026-1', status: 'PENDING' })
      .expect(409);
  });
});

describe('PATCH /compliance/everify/:associateId/identity', () => {
  it('backfills middle initial and other last names', async () => {
    const client = await createClient();
    const ready = await readyAssociate(client.id);
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);

    const res = await a
      .patch(`/compliance/everify/${ready.id}/identity`)
      .send({ middleInitial: 'Q', otherLastNames: ['Maiden', 'Prior'] });

    expect(res.status).toBe(200);
    expect(res.body.middleInitial).toBe('Q');
    expect(res.body.otherLastNames).toEqual(['Maiden', 'Prior']);
  });

  // This screen labels an identity; it must not be able to rewrite one.
  it('cannot alter legal name, DOB or SSN', async () => {
    const client = await createClient();
    const ready = await readyAssociate(client.id);
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(user.email);

    await a
      .patch(`/compliance/everify/${ready.id}/identity`)
      .send({
        middleInitial: 'Q',
        firstName: 'Hacked',
        lastName: 'Hacked',
        dob: '2000-01-01T00:00:00.000Z',
      })
      .expect(200);

    const after = await prisma.associate.findUniqueOrThrow({
      where: { id: ready.id },
    });
    expect(after.firstName).toBe('Ready');
    expect(after.lastName).toBe('ToRun');
    expect(after.dob?.toISOString().slice(0, 10)).toBe('1990-03-04');
  });
});
