/**
 * Verifies the manager-routed notifications added 2026-05-02:
 * time-off submitted, disciplinary action filed, and probation opened
 * fire bell + email to the right targets (associate, their manager,
 * and/or all admins) without spamming the wrong roles.
 *
 * Each test seeds an associate with a manager assignment so notifyManager
 * has somewhere to land. Email writes are stubbed in test env (no Resend
 * creds), so EMAIL Notification rows land with status='SENT'.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
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
  associate: { id: string; email: string };
  associateUser: { id: string; email: string };
  managerAssociate: { id: string };
  managerUser: { id: string; email: string };
  hr: { id: string; email: string };
}

async function seedWithManager(): Promise<World> {
  const managerAssociate = await createAssociate({ firstName: 'Mona', lastName: 'Manager' });
  const { user: managerUser } = await createUser({
    role: 'MANAGER',
    email: managerAssociate.email,
    associateId: managerAssociate.id,
  });
  const associate = await createAssociate({ firstName: 'Aaron', lastName: 'Associate' });
  await prisma.associate.update({
    where: { id: associate.id },
    data: { managerId: managerAssociate.id },
  });
  const { user: associateUser } = await createUser({
    role: 'ASSOCIATE',
    email: associate.email,
    associateId: associate.id,
  });
  const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
  return { associate, associateUser, managerAssociate, managerUser, hr };
}

describe('Manager-routed notification hooks', () => {
  it('time-off request submitted → notifies the manager only (manager-first routing)', async () => {
    const w = await seedWithManager();
    const a = await loginAs(w.associateUser.email);

    const res = await a.post('/time-off/me/requests').send({
      category: 'PTO',
      startDate: '2026-06-01',
      endDate: '2026-06-03',
      hours: 24,
      reason: 'family trip',
    });
    expect(res.status).toBe(201);
    await flushPendingNotifications();

    // Manager gets bell + email — exactly one of each. (Routing is
    // manager-OR-admins, never both, so the MANAGER role doesn't double-fire
    // by also matching notifyAllAdmins.)
    const mgrInApp = await prisma.notification.findMany({
      where: { recipientUserId: w.managerUser.id, category: 'time-off', channel: 'IN_APP' },
    });
    expect(mgrInApp).toHaveLength(1);
    expect(mgrInApp[0].body).toMatch(/PTO/);
    expect(mgrInApp[0].body).toMatch(/24/);
    expect(mgrInApp[0].body).toMatch(/2026-06-01/);
    const mgrEmail = await prisma.notification.findMany({
      where: { recipientUserId: w.managerUser.id, category: 'time-off', channel: 'EMAIL' },
    });
    expect(mgrEmail).toHaveLength(1);

    // HR is NOT notified when a manager exists — they see the request via
    // the HR queue UI without needing a bell ping per request.
    const hrInApp = await prisma.notification.findMany({
      where: { recipientUserId: w.hr.id, category: 'time-off' },
    });
    expect(hrInApp).toHaveLength(0);

    // Requesting associate should NOT be notified about their own request.
    const assocSpam = await prisma.notification.findMany({
      where: { recipientUserId: w.associateUser.id },
    });
    expect(assocSpam).toHaveLength(0);
  });

  it('disciplinary action filed → notifies the disciplined associate AND their manager', async () => {
    const w = await seedWithManager();
    const aH = await loginAs(w.hr.email);

    const res = await aH.post('/disciplinary-actions').send({
      associateId: w.associate.id,
      kind: 'WRITTEN_WARNING',
      incidentDate: '2026-04-25',
      effectiveDate: '2026-05-02',
      description: 'Repeated tardiness — three late arrivals in one week.',
    });
    expect(res.status).toBe(201);
    await flushPendingNotifications();

    const assocInApp = await prisma.notification.findMany({
      where: { recipientUserId: w.associateUser.id, category: 'discipline', channel: 'IN_APP' },
    });
    expect(assocInApp).toHaveLength(1);
    expect(assocInApp[0].body).toMatch(/written warning/i);
    expect(assocInApp[0].body).toMatch(/Repeated tardiness/);

    const mgrInApp = await prisma.notification.findMany({
      where: { recipientUserId: w.managerUser.id, category: 'discipline', channel: 'IN_APP' },
    });
    expect(mgrInApp).toHaveLength(1);
    expect(mgrInApp[0].body).toMatch(/direct report/i);
    expect(mgrInApp[0].body).toMatch(/written warning/i);

    // Both also get an email.
    const assocEmail = await prisma.notification.findMany({
      where: { recipientUserId: w.associateUser.id, category: 'discipline', channel: 'EMAIL' },
    });
    expect(assocEmail).toHaveLength(1);
    const mgrEmail = await prisma.notification.findMany({
      where: { recipientUserId: w.managerUser.id, category: 'discipline', channel: 'EMAIL' },
    });
    expect(mgrEmail).toHaveLength(1);
  });

  it('probation opened → notifies the associate AND their manager', async () => {
    const w = await seedWithManager();
    const aH = await loginAs(w.hr.email);

    const res = await aH.post('/probations').send({
      associateId: w.associate.id,
      startDate: '2026-05-02',
      endDate: '2026-08-02',
    });
    expect(res.status).toBe(201);
    await flushPendingNotifications();

    const assocInApp = await prisma.notification.findMany({
      where: { recipientUserId: w.associateUser.id, category: 'probation', channel: 'IN_APP' },
    });
    expect(assocInApp).toHaveLength(1);
    expect(assocInApp[0].body).toMatch(/probation/i);
    expect(assocInApp[0].body).toMatch(/2026-05-02/);

    const mgrInApp = await prisma.notification.findMany({
      where: { recipientUserId: w.managerUser.id, category: 'probation', channel: 'IN_APP' },
    });
    expect(mgrInApp).toHaveLength(1);
    expect(mgrInApp[0].body).toMatch(/direct report/i);
    expect(mgrInApp[0].body).toMatch(/probationary period/i);
  });

  it('time-off request without a manager assigned still notifies admins', async () => {
    // Associate has NO manager — notifyManager is a no-op, but admins still
    // get the bell so the request doesn't disappear into a black hole.
    const associate = await createAssociate({ firstName: 'Ned', lastName: 'NoBoss' });
    const { user: associateUser } = await createUser({
      role: 'ASSOCIATE',
      email: associate.email,
      associateId: associate.id,
    });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });

    const a = await loginAs(associateUser.email);
    const res = await a.post('/time-off/me/requests').send({
      category: 'SICK',
      startDate: '2026-06-10',
      endDate: '2026-06-10',
      hours: 8,
    });
    expect(res.status).toBe(201);
    await flushPendingNotifications();

    const hrInApp = await prisma.notification.findMany({
      where: { recipientUserId: hr.id, category: 'time-off', channel: 'IN_APP' },
    });
    expect(hrInApp).toHaveLength(1);
  });
});
