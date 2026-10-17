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

    expect(body.sources).toEqual([]);
    expect(body.total).toBe(0);
  });
});
