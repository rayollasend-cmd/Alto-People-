import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';

/**
 * GET /me/inbox — every decision waiting on the signed-in person, as
 * counts with deep links, filtered to the sources they may see.
 */

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

interface Source {
  key: string;
  label: string;
  description: string;
  count: number;
  path: string;
}

async function inboxFor(email: string) {
  const a = agent();
  await loginAs(a, email, DEFAULT_TEST_PASSWORD);
  const res = await a.get('/me/inbox');
  expect(res.status).toBe(200);
  return res.body as { total: number; sources: Source[] };
}

/** One application awaiting HR review and one kiosk punch awaiting review. */
async function seedPendingWork() {
  const client = await createClient();
  const location = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  const applicant = await createAssociate({ firstName: 'Sub', lastName: 'Mitted' });
  await prisma.application.create({
    data: {
      associateId: applicant.id,
      clientId: client.id,
      onboardingTrack: 'STANDARD',
      status: 'SUBMITTED',
      submittedAt: new Date(),
    },
  });
  const device = await prisma.kioskDevice.create({
    data: { clientId: client.id, locationId: location.id, name: 'Front door', tokenHash: 'x' },
  });
  const puncher = await createAssociate({ firstName: 'Face', lastName: 'Mismatch' });
  await prisma.kioskPunch.create({
    data: {
      kioskDeviceId: device.id,
      associateId: puncher.id,
      action: 'CLOCK_IN',
      reviewStatus: 'PENDING',
      anomalyKind: 'FACE_MISMATCH',
    },
  });
  return { client, applicant, puncher };
}

describe('GET /me/inbox', () => {
  it('requires a session', async () => {
    const res = await agent().get('/me/inbox');
    expect(res.status).toBe(401);
  });

  it('an HR admin sees the pending application and the pending kiosk punch, and the total is the sum', async () => {
    await seedPendingWork();
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });

    const body = await inboxFor(user.email);

    const byKey = new Map(body.sources.map((s) => [s.key, s]));
    expect(byKey.get('onboarding-review')).toMatchObject({
      count: 1,
      path: '/onboarding',
    });
    expect(byKey.get('kiosk-review')).toMatchObject({
      count: 1,
      path: '/time-attendance/kiosk?tab=review',
    });
    // Every source carries the contract's shape, in plain English.
    for (const s of body.sources) {
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.description.length).toBeGreaterThan(0);
      expect(s.path.startsWith('/')).toBe(true);
      expect(s.count).toBeGreaterThanOrEqual(0);
    }
    expect(body.total).toBe(body.sources.reduce((sum, s) => sum + s.count, 0));
    expect(body.total).toBeGreaterThanOrEqual(2);
  });

  it('matches the queues’ own routes', async () => {
    await seedPendingWork();
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = agent();
    await loginAs(a, user.email, DEFAULT_TEST_PASSWORD);

    const [inbox, approvals, punches] = await Promise.all([
      a.get('/me/inbox'),
      a.get('/approvals/count'),
      a.get('/kiosk-punches?reviewStatus=PENDING'),
    ]);
    const byKey = new Map((inbox.body.sources as Source[]).map((s) => [s.key, s]));
    expect(byKey.get('approvals')?.count).toBe(approvals.body.total);
    expect(byKey.get('kiosk-review')?.count).toBe(punches.body.punches.length);
  });

  it('a role without the capability does not get that source', async () => {
    await seedPendingWork();
    // The shift supervisor manages time at their store but never reviews
    // applications (no manage:onboarding) and never works the hotline.
    const client = await createClient();
    const { user } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id });

    const body = await inboxFor(user.email);
    const keys = body.sources.map((s) => s.key);

    expect(keys).not.toContain('onboarding-review');
    expect(keys).not.toContain('hotline');
    expect(keys).not.toContain('fieldglass-setup');
    // Bounded to their own client: the other store's pending punch is not theirs.
    expect(body.sources.find((s) => s.key === 'kiosk-review')).toMatchObject({ count: 0 });
  });

  it('an associate gets only what they may see — nothing is a manager’s decision', async () => {
    await seedPendingWork();
    const associate = await createAssociate();
    const { user } = await createUser({
      role: 'ASSOCIATE',
      email: associate.email,
      associateId: associate.id,
    });

    const body = await inboxFor(user.email);

    // Whatever an associate's own rows are (policies to sign, access to
    // certify), none of the desks' queues are theirs, and nothing seeded
    // above reaches them.
    const keys = body.sources.map((s) => s.key);
    for (const desk of ['approvals', 'kiosk-review', 'onboarding-review', 'hr-cases', 'reimbursements', 'i9-section2', 'everify', 'client-requests']) {
      expect(keys).not.toContain(desk);
    }
    expect(body.total).toBe(0);
  });

  it('reimbursements: the manager counts the claims to approve, Finance counts the ones to settle', async () => {
    const worker = await createAssociate({ firstName: 'Exp', lastName: 'Ense' });
    const { user: manager } = await createUser({ role: 'MANAGER' });
    const { user: finance } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    await prisma.reimbursement.createMany({
      data: [
        { associateId: worker.id, title: 'Parking', status: 'SUBMITTED', submittedAt: new Date() },
        { associateId: worker.id, title: 'Mileage', status: 'SUBMITTED', submittedAt: new Date() },
        // The manager step is audited: the DB refuses MANAGER_APPROVED without it.
        { associateId: worker.id, title: 'Boots', status: 'MANAGER_APPROVED', submittedAt: new Date(), managerApprovedAt: new Date(), managerApprovedById: manager.id },
        { associateId: worker.id, title: 'Old', status: 'DRAFT' },
      ],
    });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const m = await inboxFor(manager.email);
    const f = await inboxFor(finance.email);
    const h = await inboxFor(hr.email);
    // The manager approves (the two submitted), Finance settles (the one
    // approved), HR holds both steps and sees all three. The draft is nobody's.
    expect(m.sources.find((s) => s.key === 'reimbursements')).toMatchObject({ count: 2, path: '/reimbursements' });
    expect(f.sources.find((s) => s.key === 'reimbursements')).toMatchObject({ count: 1 });
    expect(h.sources.find((s) => s.key === 'reimbursements')).toMatchObject({ count: 3 });
  });

  it('I-9 Section 2 and E-Verify: what HR still owes on each new hire, in two rows that point at their tabs', async () => {
    const client = await createClient();
    const signed = await createAssociate({ firstName: 'Sec', lastName: 'One' });
    const examined = await createAssociate({ firstName: 'Sec', lastName: 'Two' });
    const done = await createAssociate({ firstName: 'All', lastName: 'Done' });
    for (const a of [signed, examined, done]) {
      await prisma.application.create({
        data: { associateId: a.id, clientId: client.id, onboardingTrack: 'STANDARD', status: 'APPROVED', approvedAt: new Date() },
      });
    }
    await prisma.i9Verification.createMany({
      data: [
        { associateId: signed.id, section1CompletedAt: new Date(), documentsSubmittedAt: new Date() },
        { associateId: examined.id, section1CompletedAt: new Date(), documentsSubmittedAt: new Date(), section2CompletedAt: new Date() },
        {
          associateId: done.id,
          section1CompletedAt: new Date(),
          documentsSubmittedAt: new Date(),
          section2CompletedAt: new Date(),
          eVerifyCaseNumber: 'X1',
          eVerifyStatus: 'EMPLOYMENT_AUTHORIZED',
        },
      ],
    });
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const body = await inboxFor(user.email);
    expect(body.sources.find((s) => s.key === 'i9-section2')).toMatchObject({ count: 1, path: '/compliance?tab=i9' });
    expect(body.sources.find((s) => s.key === 'everify')).toMatchObject({ count: 1, path: '/compliance?tab=everify' });

    // The shift supervisor has no compliance desk.
    const { user: sup } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id });
    const keys = (await inboxFor(sup.email)).sources.map((s) => s.key);
    expect(keys).not.toContain('i9-section2');
    expect(keys).not.toContain('everify');
  });

  it('client requests: the internal owners count the open ones; a supervisor has no org view and no row', async () => {
    const mine = await createClient('Store A');
    const other = await createClient('Store B');
    await prisma.clientRequest.createMany({
      data: [
        { clientId: mine.id, kind: 'STAFFING', subject: 'Six stockers', body: 'Fri–Sun', status: 'RECEIVED' },
        { clientId: other.id, kind: 'ISSUE', subject: 'Late van', body: 'Twice', status: 'IN_PROGRESS' },
        { clientId: other.id, kind: 'BILLING', subject: 'Resolved', body: 'ok', status: 'RESOLVED' },
      ],
    });
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const { user: sup } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: mine.id });

    expect((await inboxFor(hr.email)).sources.find((s) => s.key === 'client-requests')).toMatchObject({
      count: 2,
      path: '/relay?tab=requests',
    });
    // GET /client-requests is view:org — the supervisor cannot open the queue, so no row.
    expect((await inboxFor(sup.email)).sources.map((s) => s.key)).not.toContain('client-requests');
  });
});
