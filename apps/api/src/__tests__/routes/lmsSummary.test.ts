import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { agent, loginAs } from '../../../test/http.js';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * GET /lms/summary (F500 2026-10-22): the Learning desk's numbers — lapsed
 * training, training expiring in 30 and 14 days, open assignments (and the
 * stale ones), and the completion rate of the last 30 days' assignments —
 * for active people in the caller's reach. Also: GET /enrollments lists
 * only the caller's tenant and reach.
 */

const DAY = 86_400_000;

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('GET /lms/summary', () => {
  it('counts lapsed, expiring, open and the 30-day completion rate', async () => {
    const now = Date.now();
    const at = (days: number) => new Date(now + days * DAY);
    const coastal = await createClient('Coastal Resort');
    const north = await prisma.site.findFirstOrThrow({ where: { clientId: coastal.id } });
    const south = await prisma.site.create({ data: { clientId: coastal.id, name: 'South store' } });
    const course = await prisma.course.create({ data: { title: 'Food safety', isRequired: true, validityDays: 365, status: 'PUBLISHED' } });
    const [ana, ben, cy, dee, gone] = await Promise.all(['Ana', 'Ben', 'Cy', 'Dee', 'Gone'].map((f) => createAssociate({ firstName: f, lastName: 'Test' })));
    for (const a of [ana, ben, cy, gone]) await prisma.associateAssignment.create({ data: { associateId: a.id, locationId: north.id, startedAt: new Date('2026-01-01') } });
    await prisma.associateAssignment.create({ data: { associateId: dee.id, locationId: south.id, startedAt: new Date('2026-01-01') } });
    await prisma.associate.update({ where: { id: gone.id }, data: { deactivatedAt: new Date() } });
    const enroll = (associateId: string, data: { status: 'ASSIGNED' | 'IN_PROGRESS' | 'COMPLETED' | 'EXPIRED' | 'WAIVED'; assignedAt: Date; completedAt?: Date; expiresAt?: Date }) =>
      prisma.courseEnrollment.create({ data: { courseId: course.id, associateId, ...data } });

    // Lapsed: Ana's completed one expired 3 days ago; Ben's re-flagged EXPIRED.
    await enroll(ana.id, { status: 'COMPLETED', assignedAt: at(-400), completedAt: at(-368), expiresAt: at(-3) });
    await enroll(ben.id, { status: 'EXPIRED', assignedAt: at(-500), completedAt: at(-470), expiresAt: at(-105) });
    // Expiring: Cy in 10 days (inside 14), Dee in 20 days (inside 30, south store).
    await enroll(cy.id, { status: 'COMPLETED', assignedAt: at(-360), completedAt: at(-355), expiresAt: at(10) });
    await enroll(dee.id, { status: 'COMPLETED', assignedAt: at(-345), completedAt: at(-345), expiresAt: at(20) });
    // Open: Ana assigned 40 days ago (stale), Ben in progress since 5 days ago.
    await enroll(ana.id, { status: 'ASSIGNED', assignedAt: at(-40) });
    await enroll(ben.id, { status: 'IN_PROGRESS', assignedAt: at(-5) });
    // The last 30 days: Ben's in-progress one, Cy completed one, Dee waived (not counted) → 1 of 2.
    await enroll(cy.id, { status: 'COMPLETED', assignedAt: at(-10), completedAt: at(-2) });
    await enroll(dee.id, { status: 'WAIVED', assignedAt: at(-3) });
    // A deactivated person counts nowhere.
    await enroll(gone.id, { status: 'COMPLETED', assignedAt: at(-400), completedAt: at(-370), expiresAt: at(-5) });
    await enroll(gone.id, { status: 'ASSIGNED', assignedAt: at(-2) });

    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const http = await loginAs(agent(), user.email);
    const res = await http.get('/lms/summary');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ lapsed: 2, expiring30: 2, expiring14: 1, open: 2, openStale: 1, assigned30: 2, completed30: 1, completionRate30: 50 });

    // A store-bound office account sees its own store's people only.
    const { user: ops } = await createUser({ role: 'OPERATIONS_MANAGER' });
    await prisma.user.update({ where: { id: ops.id }, data: { scopeSiteIds: [south.id] } });
    const bound = await loginAs(agent(), ops.email);
    expect((await bound.get('/lms/summary')).body).toEqual({ lapsed: 0, expiring30: 1, expiring14: 0, open: 0, openStale: 0, assigned30: 0, completed30: 0, completionRate30: null });
    const list = await bound.get('/enrollments');
    expect(list.body.enrollments.map((e: { associateName: string }) => e.associateName)).toEqual(['Dee Test', 'Dee Test']);
  });
});
