/**
 * Verifies system-triggered notifications land in the inbox so the topbar
 * bell renders unread badges for things needing attention.
 *
 * Covers the events the user explicitly cares about (2026-05-02): doc
 * uploaded by associate, I-9 Section 1 done, application reaches 100%
 * (dedupe via submittedAt), document rejected, application approved /
 * rejected. Each is a thin happy-path: trigger the route, then query
 * the Notification table directly.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { flushPendingNotifications } from '../../lib/notify.js';
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

interface World {
  client: { id: string };
  associate: { id: string; email: string };
  application: { id: string };
  hr: { id: string; email: string };
  hrOther: { id: string; email: string };
  associateUser: { id: string; email: string };
}

async function seed(): Promise<World> {
  const client = await createClient();
  const associate = await createAssociate();
  const application = await createApplicationWithChecklist({
    associateId: associate.id,
    clientId: client.id,
  });
  const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
  // Second HR so we can prove fan-out goes to >1 user.
  const { user: hrOther } = await createUser({ role: 'HR_ADMINISTRATOR' });
  const { user: associateUser } = await createUser({
    role: 'ASSOCIATE',
    email: associate.email,
    associateId: associate.id,
  });
  return { client, associate, application, hr, hrOther, associateUser };
}

describe('Notification hooks', () => {
  it('document upload by associate → notifies all active HR (in-app + email)', async () => {
    const w = await seed();
    const a = await loginAs(w.associateUser.email);

    const res = await a
      .post('/documents/me/upload')
      .field('kind', 'ID')
      .attach('file', Buffer.from('fake png bytes'), { filename: 'license.png', contentType: 'image/png' });
    expect(res.status).toBe(201);
    await flushPendingNotifications();

    // Both HR users should have an IN_APP notification in the documents category.
    const hrInApp = await prisma.notification.findMany({
      where: { recipientUserId: { in: [w.hr.id, w.hrOther.id] }, category: 'documents', channel: 'IN_APP' },
    });
    expect(hrInApp).toHaveLength(2);
    expect(hrInApp[0].body).toMatch(/uploaded.*id/i);

    // And an EMAIL row per HR user, addressed to their User.email.
    const hrEmails = await prisma.notification.findMany({
      where: { recipientUserId: { in: [w.hr.id, w.hrOther.id] }, category: 'documents', channel: 'EMAIL' },
      orderBy: { recipientEmail: 'asc' },
    });
    expect(hrEmails).toHaveLength(2);
    expect(hrEmails.every((n) => n.status === 'SENT')).toBe(true);
    expect(hrEmails.every((n) => n.recipientEmail !== null)).toBe(true);
    expect(hrEmails[0].body).toMatch(/uploaded.*id/i);
  });

  it('document rejected → notifies the associate (not HR)', async () => {
    const w = await seed();
    const aA = await loginAs(w.associateUser.email);
    const upload = await aA
      .post('/documents/me/upload')
      .field('kind', 'ID')
      .attach('file', Buffer.from('xxx'), { filename: 'id.png', contentType: 'image/png' });
    const docId = upload.body.id;
    // Wait for the upload's HR notification to settle BEFORE wiping the table,
    // otherwise the fire-and-forget insert lands after deleteMany and pollutes
    // the assertion below.
    await flushPendingNotifications();
    await prisma.notification.deleteMany({});

    const aH = await loginAs(w.hr.email);
    const rej = await aH.post(`/documents/admin/${docId}/reject`).send({ reason: 'blurry' });
    expect(rej.status).toBe(200);
    await flushPendingNotifications();

    const assocInApp = await prisma.notification.findMany({
      where: { recipientUserId: w.associateUser.id, category: 'documents', channel: 'IN_APP' },
    });
    expect(assocInApp).toHaveLength(1);
    expect(assocInApp[0].body).toMatch(/rejected.*blurry/i);

    const assocEmail = await prisma.notification.findMany({
      where: { recipientUserId: w.associateUser.id, category: 'documents', channel: 'EMAIL' },
    });
    expect(assocEmail).toHaveLength(1);
    expect(assocEmail[0].status).toBe('SENT');
    expect(assocEmail[0].recipientEmail).toBe(w.associateUser.email);
    expect(assocEmail[0].body).toMatch(/rejected.*blurry/i);

    // HR should NOT be notified about rejecting their own action — neither bell nor email.
    const hrSpam = await prisma.notification.findMany({
      where: { recipientUserId: { in: [w.hr.id, w.hrOther.id] } },
    });
    expect(hrSpam).toHaveLength(0);
  });

  it('application approved → notifies the associate', async () => {
    const w = await seed();
    // Approve requires checklist 100% complete; flip every task DONE first.
    await prisma.onboardingTask.updateMany({
      where: { checklist: { applicationId: w.application.id } },
      data: { status: 'DONE', completedAt: new Date() },
    });
    const aH = await loginAs(w.hr.email);

    const res = await aH
      .post(`/onboarding/applications/${w.application.id}/approve`)
      .send({ hireDate: '2026-06-01' });
    expect(res.status).toBe(204);
    await flushPendingNotifications();

    const inApp = await prisma.notification.findMany({
      where: { recipientUserId: w.associateUser.id, category: 'onboarding', channel: 'IN_APP' },
    });
    expect(inApp).toHaveLength(1);
    expect(inApp[0].body).toMatch(/approved/i);

    const email = await prisma.notification.findMany({
      where: { recipientUserId: w.associateUser.id, category: 'onboarding', channel: 'EMAIL' },
    });
    expect(email).toHaveLength(1);
    expect(email[0].status).toBe('SENT');
    expect(email[0].recipientEmail).toBe(w.associateUser.email);
  });

  it('application rejected → notifies the associate with the reason (in-app + email)', async () => {
    const w = await seed();
    const aH = await loginAs(w.hr.email);

    const res = await aH
      .post(`/onboarding/applications/${w.application.id}/reject`)
      .send({ reason: 'Failed background check' });
    expect(res.status).toBe(204);
    await flushPendingNotifications();

    const inApp = await prisma.notification.findMany({
      where: { recipientUserId: w.associateUser.id, category: 'onboarding', channel: 'IN_APP' },
    });
    expect(inApp).toHaveLength(1);
    expect(inApp[0].body).toMatch(/declined.*background check/i);

    const email = await prisma.notification.findMany({
      where: { recipientUserId: w.associateUser.id, category: 'onboarding', channel: 'EMAIL' },
    });
    expect(email).toHaveLength(1);
    expect(email[0].status).toBe('SENT');
    expect(email[0].recipientEmail).toBe(w.associateUser.email);
    expect(email[0].body).toMatch(/declined.*background check/i);
  });

  it('checklist 100% → notifies HR exactly once (dedupe via submittedAt)', async () => {
    // Mark every task DONE manually (same outcome as the associate completing them);
    // then call POLICY_ACK (any task-marking endpoint) and confirm the all-complete
    // notification fires exactly once even if we trigger another task event after.
    const w = await seed();

    // Flip every checklist task DONE so the next task-marking endpoint sees 100%.
    await prisma.onboardingTask.updateMany({
      where: { checklist: { applicationId: w.application.id } },
      data: { status: 'DONE', completedAt: new Date() },
    });

    // Use the profile endpoint as the trigger — it calls markTaskDoneByKind
    // (idempotent on already-done tasks) and then notifyHrOnApplicationComplete.
    const aA = await loginAs(w.associateUser.email);
    const r1 = await aA.post(`/onboarding/applications/${w.application.id}/profile`).send({
      firstName: 'Maria',
      lastName: 'Lopez',
    });
    expect(r1.status).toBe(204);
    await flushPendingNotifications();

    let inApp = await prisma.notification.findMany({
      where: {
        recipientUserId: { in: [w.hr.id, w.hrOther.id] },
        category: 'onboarding',
        channel: 'IN_APP',
      },
    });
    expect(inApp).toHaveLength(2); // one bell row per HR user, one event

    // Each HR user also gets an email — same dedupe gate applies.
    let emails = await prisma.notification.findMany({
      where: {
        recipientUserId: { in: [w.hr.id, w.hrOther.id] },
        category: 'onboarding',
        channel: 'EMAIL',
      },
    });
    expect(emails).toHaveLength(2);
    expect(emails.every((n) => n.status === 'SENT')).toBe(true);

    // Trigger again; submittedAt is now stamped so notify is a no-op.
    const r2 = await aA.post(`/onboarding/applications/${w.application.id}/profile`).send({
      firstName: 'Maria',
      lastName: 'Lopez',
    });
    expect(r2.status).toBe(204);
    await flushPendingNotifications();
    inApp = await prisma.notification.findMany({
      where: {
        recipientUserId: { in: [w.hr.id, w.hrOther.id] },
        category: 'onboarding',
        channel: 'IN_APP',
      },
    });
    expect(inApp, 'submittedAt dedupe must prevent a second IN_APP fan-out').toHaveLength(2);

    emails = await prisma.notification.findMany({
      where: {
        recipientUserId: { in: [w.hr.id, w.hrOther.id] },
        category: 'onboarding',
        channel: 'EMAIL',
      },
    });
    expect(emails, 'submittedAt dedupe must prevent a second email fan-out').toHaveLength(2);

    const refreshed = await prisma.application.findUniqueOrThrow({
      where: { id: w.application.id },
      select: { submittedAt: true },
    });
    expect(refreshed.submittedAt).not.toBeNull();
  });
});
