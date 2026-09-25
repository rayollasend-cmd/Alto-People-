import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import type { CandidateStage } from '@prisma/client';
import { createApp } from '../../app.js';
import { AUTO_CLOSE_REASON, GRACE_DAYS, closeQuietCandidates, runRecruitingCleanup } from '../../lib/recruitingCleanup.js';
import { DEFAULT_TEST_PASSWORD, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * Keeping the pipeline clean: quiet candidates close on their own (after a
 * warning), and a candidate can be removed and restored.
 */

const app = () => createApp();
beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`loginAs(${email}) failed: ${r.status}`);
  return a;
}

let n = 0;
async function cand(firstName: string, stage: CandidateStage, quietDays: number) {
  n += 1;
  return prisma.candidate.create({
    data: {
      firstName,
      lastName: 'Test',
      email: `${firstName.toLowerCase()}${n}@example.com`,
      stage,
      stageChangedAt: ago(quietDays),
      createdAt: ago(quietDays + 5),
    },
  });
}

describe('quiet candidates close on their own', () => {
  it('closes a candidate with nothing happening for 30 days, as No response, on their timeline', async () => {
    const quiet = await cand('Quiet', 'SCREENING', 40);
    const fresh = await cand('Fresh', 'SCREENING', 10);
    expect(await closeQuietCandidates()).toBe(1);
    const q = await prisma.candidate.findUniqueOrThrow({ where: { id: quiet.id } });
    expect(q).toMatchObject({ stage: 'WITHDRAWN', withdrawnReason: AUTO_CLOSE_REASON });
    const ev = await prisma.candidateEvent.findFirstOrThrow({ where: { candidateId: quiet.id } });
    expect(ev).toMatchObject({ kind: 'STAGE_CHANGED', fromStage: 'SCREENING', toStage: 'WITHDRAWN', actorUserId: null });
    expect((await prisma.candidate.findUniqueOrThrow({ where: { id: fresh.id } })).stage).toBe('SCREENING');
    // Running again changes nothing.
    expect(await closeQuietCandidates()).toBe(0);
  });

  it('anything recent on the timeline, or anything pending, keeps them open', async () => {
    const client = await createClient('Walmart');
    const noted = await cand('Noted', 'APPLIED', 40);
    await prisma.candidateEvent.create({ data: { candidateId: noted.id, kind: 'NOTE', body: 'Called, will call back.', createdAt: ago(3) } });
    const booked = await cand('Booked', 'INTERVIEW', 40);
    await prisma.interview.create({ data: { candidateId: booked.id, scheduledFor: new Date(Date.now() + 2 * DAY) } });
    const offered = await cand('Offered', 'OFFER', 40);
    await prisma.offer.create({ data: { candidateId: offered.id, clientId: client.id, jobTitle: 'Cashier', startDate: new Date('2026-10-05'), hourlyRate: 15, status: 'SENT' } });
    const withClient = await cand('WithClient', 'INTERVIEW', 40);
    await prisma.candidateSubmittal.create({ data: { candidateId: withClient.id, clientId: client.id } });
    expect(await closeQuietCandidates()).toBe(0);
  });

  it('warns on the dashboard a few days first, and reopening is moving them back', async () => {
    // Long past the first sweep's grace period.
    await prisma.orgSetting.create({ data: { id: 'singleton', recruitingCleanupSince: ago(60) } });
    const { user } = await createUser({ role: 'INTERNAL_RECRUITER' });
    const a = await loginAs(user.email);
    const soon = await cand('Soon', 'SCREENING', 27);
    await cand('NotYet', 'SCREENING', 12);
    const home = (await a.get('/recruiting/home')).body;
    expect(home.waitingOnYou.closingSoon.total).toBe(1);
    expect(home.waitingOnYou.closingSoon.items[0]).toMatchObject({ candidateId: soon.id, stage: 'SCREENING' });
    const closesIn = (Date.parse(home.waitingOnYou.closingSoon.items[0].closesAt) - Date.now()) / DAY;
    expect(Math.round(closesIn)).toBe(3);

    const gone = await cand('Gone', 'APPLIED', 45);
    await closeQuietCandidates();
    const back = await a.post(`/recruiting/candidates/${gone.id}/advance`).send({ stage: 'APPLIED' });
    expect(back.status).toBe(200);
    expect(back.body.stage).toBe('APPLIED');
  });
});

describe('the first sweep closes nothing without warning', () => {
  it('starts a grace period: the overdue show as closing when it ends, and close after', async () => {
    const { user } = await createUser({ role: 'INTERNAL_RECRUITER' });
    const a = await loginAs(user.email);
    const overdue = await cand('Overdue', 'APPLIED', 90);
    const soon = await cand('Soon', 'SCREENING', 27);

    // Day one: the clock starts, nothing closes.
    const first = await runRecruitingCleanup();
    expect(first).toMatchObject({ candidatesClosed: 0, invitesExpired: 0 });
    expect(first.graceUntil).not.toBeNull();
    expect((await prisma.candidate.findUniqueOrThrow({ where: { id: overdue.id } })).stage).toBe('APPLIED');
    const since = (await prisma.orgSetting.findUniqueOrThrow({ where: { id: 'singleton' } })).recruitingCleanupSince!;

    // Both are on the dashboard, and neither closes before the grace ends.
    const home = (await a.get('/recruiting/home')).body;
    expect(home.waitingOnYou.closingSoon.total).toBe(2);
    const graceEnds = since.getTime() + GRACE_DAYS * DAY;
    for (const item of home.waitingOnYou.closingSoon.items) {
      expect(Date.parse(item.closesAt)).toBe(graceEnds);
    }

    // A later sweep doesn't restart the clock.
    await runRecruitingCleanup(new Date(Date.now() + 2 * DAY));
    expect((await prisma.orgSetting.findUniqueOrThrow({ where: { id: 'singleton' } })).recruitingCleanupSince).toEqual(since);
    expect((await prisma.candidate.findUniqueOrThrow({ where: { id: overdue.id } })).stage).toBe('APPLIED');

    // Once it's over, both close.
    const after = await runRecruitingCleanup(new Date(graceEnds + 60_000));
    expect(after.candidatesClosed).toBe(2);
    expect((await prisma.candidate.findUniqueOrThrow({ where: { id: soon.id } })).stage).toBe('WITHDRAWN');
  });
});

describe('remove and restore', () => {
  it('removes with a reason, lists it for 30 days, and restores it', async () => {
    const { user } = await createUser({ role: 'INTERNAL_RECRUITER' });
    const a = await loginAs(user.email);
    const dup = await cand('Dup', 'APPLIED', 1);
    expect((await a.post(`/recruiting/candidates/${dup.id}/remove`).send({ reason: 'Duplicate of Kim Phan' })).status).toBe(204);
    expect((await a.get('/recruiting/candidates')).body.candidates).toEqual([]);
    const [row] = (await a.get('/recruiting/removed')).body.removed;
    expect(row).toMatchObject({ id: dup.id, name: 'Dup Test', reason: 'Duplicate of Kim Phan', removedBy: user.email });

    const r = await a.post(`/recruiting/candidates/${dup.id}/restore`);
    expect(r.status).toBe(200);
    expect((await a.get('/recruiting/candidates')).body.total).toBe(1);
    const kinds = (await a.get(`/recruiting/candidates/${dup.id}/events`)).body.events.map((e: { kind: string }) => e.kind);
    expect(kinds).toEqual(['RESTORED', 'REMOVED']);
  });

  it('a removal older than 30 days can’t be restored, and a hire can’t be removed', async () => {
    const { user } = await createUser({ role: 'INTERNAL_RECRUITER' });
    const a = await loginAs(user.email);
    const old = await cand('Old', 'APPLIED', 1);
    await prisma.candidate.update({ where: { id: old.id }, data: { deletedAt: ago(31) } });
    expect((await a.post(`/recruiting/candidates/${old.id}/restore`)).status).toBe(409);
    expect((await a.get('/recruiting/removed')).body.removed).toEqual([]);
    const hired = await cand('Hired', 'HIRED', 1);
    const r = await a.post(`/recruiting/candidates/${hired.id}/remove`).send({});
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/undo the hire first/);
  });

  it('someone removed who applies again on the careers page is back as a new applicant', async () => {
    const { user } = await createUser({ role: 'INTERNAL_RECRUITER' });
    const a = await loginAs(user.email);
    const posting = await prisma.jobPosting.create({ data: { title: 'Cashier', description: 'x', slug: 'cashier', status: 'OPEN', openedAt: ago(1) } });
    const kim = await prisma.candidate.create({ data: { firstName: 'Kim', lastName: 'Phan', email: 'kim@example.com', stage: 'REJECTED', deletedAt: ago(2) } });
    const r = await request(app()).post('/careers/cashier/apply').send({ firstName: 'Kim', lastName: 'Phan', email: 'Kim@Example.com' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ id: kim.id, alreadyApplied: false });
    const back = await prisma.candidate.findUniqueOrThrow({ where: { id: kim.id } });
    expect(back).toMatchObject({ deletedAt: null, stage: 'APPLIED', jobPostingId: posting.id });

    // Adding them by hand points to Recently removed instead of a bare "exists".
    await prisma.candidate.update({ where: { id: kim.id }, data: { deletedAt: new Date() } });
    const add = await a.post('/recruiting/candidates').send({ firstName: 'Kim', lastName: 'Phan', email: 'kim@example.com' });
    expect(add.status).toBe(409);
    expect(add.body.error.code).toBe('candidate_removed');
  });
});
