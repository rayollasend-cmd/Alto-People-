import { randomBytes } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { encryptString } from '../../lib/crypto.js';
import { flushPendingNotifications } from '../../lib/notify.js';
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

/** Correctly-shaped v1 blob that cannot decrypt under the current key —
 *  what a pre-key-rotation row looks like to the running system. */
function unreadableBlob(): Buffer {
  return Buffer.concat([Buffer.from([1]), randomBytes(12), randomBytes(24), randomBytes(16)]);
}

/** Associate + application + W4 row, optionally with an ACTIVE login. */
async function seedAssociate(opts: {
  clientId: string;
  ssnBlob: Buffer | null;
  withAccount?: boolean;
  firstName?: string;
}) {
  const associate = await createAssociate({ firstName: opts.firstName ?? 'Test' });
  const application = await createApplicationWithChecklist({
    associateId: associate.id,
    clientId: opts.clientId,
  });
  await prisma.w4Submission.create({
    data: {
      associateId: associate.id,
      filingStatus: 'SINGLE',
      ssnEncrypted: opts.ssnBlob,
      signedAt: new Date(),
    },
  });
  let user = null;
  if (opts.withAccount !== false) {
    ({ user } = await createUser({ role: 'ASSOCIATE', associateId: associate.id }));
  }
  return { associate, application, user };
}

describe('GET /w4-recollection', () => {
  it('lists only associates whose stored SSN does not decrypt', async () => {
    const client = await createClient();
    const broken = await seedAssociate({ clientId: client.id, ssnBlob: unreadableBlob() });
    await seedAssociate({ clientId: client.id, ssnBlob: encryptString('123456789') });

    const { user: admin } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(admin.email);

    const res = await a.get('/w4-recollection');
    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({ outstanding: 1, notified: 0, resolved: 0 });
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0]).toMatchObject({
      associateId: broken.associate.id,
      hasAccount: true,
      applicationId: broken.application.id,
      emailCount: 0,
      lastEmailedAt: null,
    });
  });

  it('is forbidden without process:payroll', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    const a = await loginAs(user.email);
    const res = await a.get('/w4-recollection');
    expect(res.status).toBe(403);
  });
});

describe('POST /w4-recollection/email', () => {
  it('emails affected associates, skips resolved and account-less ones, audits the send', async () => {
    const client = await createClient();
    const broken = await seedAssociate({
      clientId: client.id,
      ssnBlob: unreadableBlob(),
      firstName: 'Brooke',
    });
    const readable = await seedAssociate({
      clientId: client.id,
      ssnBlob: encryptString('123456789'),
    });
    const noAccount = await seedAssociate({
      clientId: client.id,
      ssnBlob: unreadableBlob(),
      withAccount: false,
    });

    const { user: admin } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(admin.email);

    const res = await a.post('/w4-recollection/email').send({
      associateIds: [broken.associate.id, readable.associate.id, noAccount.associate.id],
    });
    expect(res.status).toBe(200);
    expect(res.body.queued).toBe(1);
    expect(res.body.skipped).toEqual(
      expect.arrayContaining([
        { associateId: readable.associate.id, reason: 'not_affected' },
        { associateId: noAccount.associate.id, reason: 'no_account' },
      ]),
    );

    await flushPendingNotifications();
    const notif = await prisma.notification.findFirstOrThrow({
      where: {
        channel: 'EMAIL',
        category: 'w4.ssn_recollection',
        recipientUserId: broken.user!.id,
      },
    });
    expect(notif.status).toBe('SENT');
    expect(notif.subject).toContain('Social Security number');
    // The CTA must point at the associate's own W-4 task.
    expect(notif.body).toContain(`/onboarding/me/${broken.application.id}/tasks/w4`);

    await flushPendingAudits();
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'w4.recollection_emailed' },
    });
    expect(audit.actorUserId).toBe(admin.id);

    // Roster now reflects the send.
    const roster = await a.get('/w4-recollection');
    const row = roster.body.rows.find(
      (r: { associateId: string }) => r.associateId === broken.associate.id,
    );
    expect(row.emailCount).toBe(1);
    expect(row.lastEmailedAt).not.toBeNull();
  });

  it('400s when nothing in the selection can be sent', async () => {
    const client = await createClient();
    const readable = await seedAssociate({
      clientId: client.id,
      ssnBlob: encryptString('123456789'),
    });
    const { user: admin } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(admin.email);

    const res = await a
      .post('/w4-recollection/email')
      .send({ associateIds: [readable.associate.id] });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('nothing_to_send');
  });

  it('counts a notified associate as resolved once their SSN decrypts again', async () => {
    const client = await createClient();
    const broken = await seedAssociate({ clientId: client.id, ssnBlob: unreadableBlob() });
    const { user: admin } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(admin.email);

    await a.post('/w4-recollection/email').send({ associateIds: [broken.associate.id] });
    await flushPendingNotifications();

    // Simulate the associate resubmitting: blob becomes readable.
    await prisma.w4Submission.update({
      where: { associateId: broken.associate.id },
      data: { ssnEncrypted: encryptString('987654321') },
    });

    const res = await a.get('/w4-recollection');
    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({ outstanding: 0, resolved: 1 });

    const summary = await a.get('/w4-recollection/summary');
    expect(summary.body).toMatchObject({ outstanding: 0, resolved: 1 });
  });
});

describe('W-4 resubmission gate (key-rotation aware)', () => {
  it('reports ssnNeedsResubmit and refuses an SSN-less resubmit when the blob is unreadable', async () => {
    const client = await createClient();
    const broken = await seedAssociate({ clientId: client.id, ssnBlob: unreadableBlob() });
    const { user: admin } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(admin.email);

    const status = await a.get(`/onboarding/applications/${broken.application.id}/w4`);
    expect(status.status).toBe(200);
    expect(status.body.hasSsnOnFile).toBe(false);
    expect(status.body.ssnNeedsResubmit).toBe(true);

    // Without an SSN the resubmit must be rejected — accepting it would
    // keep the unreadable blob while marking the task done.
    const noSsn = await a.post(`/onboarding/applications/${broken.application.id}/w4`).send({
      filingStatus: 'SINGLE',
      multipleJobs: false,
      dependentsAmount: 0,
      otherIncome: 0,
      deductions: 0,
      extraWithholding: 0,
    });
    expect(noSsn.status).toBe(400);
    expect(noSsn.body.error?.code).toBe('ssn_required');

    // With the SSN retyped, the resubmit lands and the roster drains.
    const withSsn = await a.post(`/onboarding/applications/${broken.application.id}/w4`).send({
      filingStatus: 'SINGLE',
      multipleJobs: false,
      dependentsAmount: 0,
      otherIncome: 0,
      deductions: 0,
      extraWithholding: 0,
      ssn: '123-45-6789',
    });
    expect(withSsn.status).toBe(204);

    const roster = await a.get('/w4-recollection');
    expect(roster.body.summary.outstanding).toBe(0);

    const after = await a.get(`/onboarding/applications/${broken.application.id}/w4`);
    expect(after.body.hasSsnOnFile).toBe(true);
    expect(after.body.ssnNeedsResubmit).toBe(false);
  });

  it('still allows an SSN-less resubmit when the stored blob is readable', async () => {
    const client = await createClient();
    const readable = await seedAssociate({
      clientId: client.id,
      ssnBlob: encryptString('123456789'),
    });
    const { user: admin } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(admin.email);

    const res = await a.post(`/onboarding/applications/${readable.application.id}/w4`).send({
      filingStatus: 'MARRIED_FILING_JOINTLY',
      multipleJobs: false,
      dependentsAmount: 0,
      otherIncome: 0,
      deductions: 0,
      extraWithholding: 0,
    });
    expect(res.status).toBe(204);
  });
});
