import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

/**
 * Scorecard tile upgrades:
 *   - "Nudge all missing" (onboarding): notifies only associate-fixable
 *     signals, dedupes over 7 days, statutory keys rejected.
 *   - Training signals carry missingIds (uncapped) + published courses so
 *     the UI can bulk-enroll through the existing LMS endpoint.
 *   - Billing tile's live invoice-forfeiture watch (90-day MSA window).
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

const DAY = 24 * 3600 * 1000;

async function activeAssociate(clientId: string) {
  const associate = await createAssociate();
  await prisma.application.create({
    data: {
      associateId: associate.id,
      clientId,
      onboardingTrack: 'STANDARD',
      status: 'APPROVED',
    },
  });
  return associate;
}

describe('onboarding nudge', () => {
  it('notifies missing associates once and dedupes within 7 days', async () => {
    const client = await createClient();
    const assoc = await activeAssociate(client.id);
    // Give the associate a portal account so the nudge lands as an IN_APP
    // notification row we can assert on (and the dedup can see).
    const { user: assocUser } = await createUser({
      role: 'ASSOCIATE',
      associateId: assoc.id,
    });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const first = await a
      .post('/compliance-scorecard/onboarding/nudge')
      .send({ signalKey: 'W4_ON_FILE' });
    expect(first.status).toBe(200);
    expect(first.body.missingCount).toBe(1);
    expect(first.body.nudged).toBe(1);
    expect(first.body.deduped).toBe(0);

    await flushPendingNotifications();
    const row = await prisma.notification.findFirst({
      where: {
        recipientUserId: assocUser.id,
        subject: 'Action needed: complete your W-4',
      },
    });
    expect(row).not.toBeNull();

    // Second click inside the 7-day window: nobody gets double-nagged.
    const second = await a
      .post('/compliance-scorecard/onboarding/nudge')
      .send({ signalKey: 'W4_ON_FILE' });
    expect(second.status).toBe(200);
    expect(second.body.nudged).toBe(0);
    expect(second.body.deduped).toBe(1);
  });

  it('rejects statutory (HR-side) signals and non-managers', async () => {
    const client = await createClient();
    await activeAssociate(client.id);

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const statutory = await a
      .post('/compliance-scorecard/onboarding/nudge')
      .send({ signalKey: 'I9_BOTH_SECTIONS' });
    expect(statutory.status).toBe(400);

    const { user: exec } = await createUser({ role: 'EXECUTIVE_CHAIRMAN' });
    const e = await loginAs(exec.email);
    const forbidden = await e
      .post('/compliance-scorecard/onboarding/nudge')
      .send({ signalKey: 'W4_ON_FILE' });
    expect(forbidden.status).toBe(403);
  });
});

describe('training signals — bulk-enroll plumbing', () => {
  it('carries uncapped missingIds and only PUBLISHED courses as enroll targets', async () => {
    const client = await createClient();
    const assoc = await activeAssociate(client.id);

    await prisma.course.create({
      data: { title: 'EEO draft', complianceTag: 'EEO_HARASSMENT', status: 'DRAFT' },
    });
    const published = await prisma.course.create({
      data: { title: 'EEO live', complianceTag: 'EEO_HARASSMENT', status: 'PUBLISHED' },
    });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);
    const res = await a.get('/compliance-scorecard/training');
    expect(res.status).toBe(200);

    const eeo = res.body.signals.find(
      (s: { tag: string }) => s.tag === 'EEO_HARASSMENT',
    );
    expect(eeo.status).toBe('live');
    expect(eeo.missingIds).toContain(assoc.id);
    // Drafts are invisible to the enroll button; the live course is there.
    expect(eeo.courses).toEqual([{ id: published.id, title: 'EEO live' }]);

    // The full loop: enroll via the EXISTING LMS endpoint, tile turns green.
    const enroll = await a
      .post(`/courses/${published.id}/enroll`)
      .send({ associateIds: eeo.missingIds });
    expect(enroll.status).toBe(201);
    await prisma.courseEnrollment.updateMany({
      where: { courseId: published.id },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });
    const after = await a.get('/compliance-scorecard/training');
    const eeoAfter = after.body.signals.find(
      (s: { tag: string }) => s.tag === 'EEO_HARASSMENT',
    );
    expect(eeoAfter.completedCount).toBe(1);
    expect(eeoAfter.missingIds).toHaveLength(0);
  });
});

describe('billing — invoice forfeiture watch', () => {
  it('lists 60+ day unpaid FINAL statements with the forfeiture countdown', async () => {
    const client = await createClient('Walmart Frontback');
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const mk = (daysOld: number, offset: number) =>
      prisma.clientStatement.create({
        data: {
          clientId: client.id,
          periodStart: new Date(Date.now() - (daysOld + 7 + offset) * DAY),
          periodEnd: new Date(Date.now() - (daysOld + offset) * DAY),
          status: 'FINAL',
          number: 100 + daysOld,
          snapshot: { totals: { amount: 1234.56 } },
          finalizedAt: new Date(Date.now() - daysOld * DAY),
        },
      });
    await mk(87, 0); // 3 days to forfeit → critical fuse
    await mk(65, 1); // at risk
    await mk(20, 2); // young — outstanding but not at risk

    const res = await a.get('/compliance-scorecard/billing');
    expect(res.status).toBe(200);
    expect(res.body.unpaidFinalCount).toBe(3);
    expect(res.body.atRiskStatements).toHaveLength(2);
    // Oldest first, amount extracted from the snapshot.
    expect(res.body.atRiskStatements[0].daysToForfeit).toBe(3);
    expect(res.body.atRiskStatements[0].amount).toBeCloseTo(1234.56, 2);
    expect(res.body.atRiskStatements[1].daysToForfeit).toBe(25);
    // ≤5 days to the window = critical, regardless of attestation state.
    expect(res.body.severity).toBe('critical');
  });

  it('a paid statement leaves the watch', async () => {
    const client = await createClient();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    await prisma.clientStatement.create({
      data: {
        clientId: client.id,
        periodStart: new Date(Date.now() - 90 * DAY),
        periodEnd: new Date(Date.now() - 83 * DAY),
        status: 'FINAL',
        number: 7,
        snapshot: {},
        finalizedAt: new Date(Date.now() - 80 * DAY),
        paidAt: new Date(),
      },
    });

    const res = await a.get('/compliance-scorecard/billing');
    expect(res.body.atRiskStatements).toHaveLength(0);
    expect(res.body.unpaidFinalCount).toBe(0);
  });
});
