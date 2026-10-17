import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * Calibration: ratings side by side before reviews go out, a reviewer who
 * rates far from everyone called out, and a draft's rating moved by someone
 * other than its reviewer — with the reason, and the reviewer's own rating kept.
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
  if (r.status !== 200) throw new Error(`login failed: ${r.status}`);
  return a;
}

async function review(reviewerUserId: string, rating: number, status: 'DRAFT' | 'SUBMITTED' = 'DRAFT') {
  const a = await createAssociate();
  return prisma.performanceReview.create({
    data: {
      associateId: a.id,
      reviewerUserId,
      periodStart: new Date('2026-07-01'),
      periodEnd: new Date('2026-09-30'),
      overallRating: rating,
      summary: 'Quarter.',
      status,
    },
  });
}

describe('review calibration', () => {
  it('lays ratings side by side and calls out a reviewer far from everyone', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'hr@example.com' });
    const { user: kind } = await createUser({ role: 'MANAGER', email: 'kind@example.com' });
    const { user: firm } = await createUser({ role: 'MANAGER', email: 'firm@example.com' });
    for (const r of [5, 5, 5, 5]) await review(kind.id, r);
    for (const r of [2, 3, 2, 3]) await review(firm.id, r);

    const a = await loginAs(hr.email);
    const res = await a.get('/performance/calibration').query({ from: '2026-07-01', to: '2026-09-30' });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(8);
    expect(res.body.distribution).toEqual([0, 2, 2, 0, 4]);
    const byId = new Map(res.body.reviewers.map((r: { reviewerUserId: string }) => [r.reviewerUserId, r]));
    expect((byId.get(kind.id) as { lean: string }).lean).toBe('generous');
    expect((byId.get(firm.id) as { lean: string }).lean).toBe('strict');
  });

  it('moves a draft rating with a reason, keeps the reviewer rating, and audits it', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'hr@example.com' });
    const { user: mgr } = await createUser({ role: 'MANAGER', email: 'mgr@example.com' });
    const r = await review(mgr.id, 5);
    const a = await loginAs(hr.email);

    expect((await a.post(`/performance/reviews/${r.id}/calibrate`).send({ rating: 4 })).status).toBe(400);
    const ok = await a.post(`/performance/reviews/${r.id}/calibrate`).send({ rating: 4, note: 'In line with peers this quarter.' });
    expect(ok.status).toBe(200);
    expect(ok.body.overallRating).toBe(4);

    // A second move keeps the reviewer's original, not the first calibration.
    await a.post(`/performance/reviews/${r.id}/calibrate`).send({ rating: 3, note: 'Second pass.' });
    const row = await prisma.performanceReview.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.overallRating).toBe(3);
    expect(row.originalRating).toBe(5);
    expect(row.calibratedById).toBe(hr.id);

    await flushPendingAudits();
    const audit = await prisma.auditLog.findFirst({ where: { action: 'performance.review.calibrated', entityId: r.id } });
    expect(audit).not.toBeNull();
  });

  it('refuses the reviewer calibrating their own review, and a review already shared', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'hr@example.com' });
    const own = await review(hr.id, 5);
    const shared = await review(hr.id, 4, 'SUBMITTED');
    const a = await loginAs(hr.email);
    expect((await a.post(`/performance/reviews/${own.id}/calibrate`).send({ rating: 3, note: 'Too high.' })).status).toBe(403);
    expect((await a.post(`/performance/reviews/${shared.id}/calibrate`).send({ rating: 3, note: 'Too high.' })).status).toBe(409);
  });

  it('is closed to people without manage:performance', async () => {
    const { user } = await createUser({ role: 'SHIFT_SUPERVISOR', email: 'sup@example.com' });
    const a = await loginAs(user.email);
    expect([403, 404]).toContain((await a.get('/performance/calibration')).status);
  });
});
