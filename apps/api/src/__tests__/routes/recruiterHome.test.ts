import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import type { CandidateStage } from '@prisma/client';
import { createApp } from '../../app.js';
import { DEFAULT_TIMEZONE, addDaysInZone, localDateKey, zonedWallTimeToUtcInstant } from '../../lib/timezone.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * The recruiter's dashboard: what's today, what's new, what's waiting on
 * them and what's waiting on someone else — each list with its own rule.
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

/** Instants inside today in the org's zone — safe at any hour the suite runs. */
function todayWindow() {
  const now = new Date();
  const [y, m, d] = localDateKey(now, DEFAULT_TIMEZONE).split('-').map(Number) as [number, number, number];
  const start = zonedWallTimeToUtcInstant(y, m, d, 0, DEFAULT_TIMEZONE);
  const end = addDaysInZone(start, 1, DEFAULT_TIMEZONE);
  return {
    earlier: new Date(start.getTime() + (now.getTime() - start.getTime()) / 3),
    abitEarlier: new Date(start.getTime() + (2 * (now.getTime() - start.getTime())) / 3),
    later: new Date(now.getTime() + (end.getTime() - now.getTime()) / 2),
  };
}

let n = 0;
async function cand(over: { firstName?: string; stage?: CandidateStage; source?: string; createdAt?: Date; stageChangedAt?: Date; jobPostingId?: string; hiredAssociateId?: string; hiredAt?: Date } = {}) {
  n += 1;
  return prisma.candidate.create({
    data: {
      firstName: over.firstName ?? `C${n}`,
      lastName: 'Test',
      email: `c${n}-${Math.random().toString(36).slice(2, 7)}@example.com`,
      stage: over.stage ?? 'APPLIED',
      source: over.source ?? null,
      createdAt: over.createdAt ?? ago(20),
      stageChangedAt: over.stageChangedAt ?? ago(1),
      jobPostingId: over.jobPostingId ?? null,
      hiredAssociateId: over.hiredAssociateId ?? null,
      hiredAt: over.hiredAt ?? null,
    },
  });
}

describe('GET /recruiting/home', () => {
  it('sorts the day into today, new, waiting on you and waiting on others', async () => {
    const { user: rec } = await createUser({ role: 'INTERNAL_RECRUITER' });
    const { user: other } = await createUser({ role: 'INTERNAL_RECRUITER' });
    const client = await createClient('Walmart');
    const a = await loginAs(rec.email);
    const t = todayWindow();

    // Today: one scored, one past with no score (mine), one still to come.
    const kim = await cand({ firstName: 'Kim', stage: 'INTERVIEW' });
    await prisma.interview.create({ data: { candidateId: kim.id, scheduledFor: t.earlier, completedAt: t.abitEarlier, rating: 1 } });
    await prisma.interview.create({ data: { candidateId: kim.id, scheduledFor: t.abitEarlier, interviewerUserId: rec.id } });
    await prisma.interview.create({ data: { candidateId: kim.id, scheduledFor: t.later, interviewerUserId: other.id } });
    // Someone else's unscored interview from last week.
    const lee = await cand({ firstName: 'Lee', stage: 'INTERVIEW' });
    await prisma.interview.create({ data: { candidateId: lee.id, scheduledFor: ago(5), interviewerUserId: other.id } });

    // New applicants.
    const posting = await prisma.jobPosting.create({
      data: { clientId: client.id, title: 'Cashier', description: 'x', slug: 'cashier', status: 'OPEN', openedAt: ago(12), openings: 2 },
    });
    await cand({ firstName: 'Fresh', source: 'indeed', createdAt: new Date(Date.now() - 2 * 3_600_000), jobPostingId: posting.id });
    await cand({ firstName: 'Week', source: 'referral', createdAt: ago(3) });
    await cand({ firstName: 'Old', createdAt: ago(10) });

    // Gone quiet.
    await cand({ firstName: 'Stale', stage: 'SCREENING', stageChangedAt: ago(10) });

    // A client said yes — no offer since (listed); another yes already has an offer out (not).
    const yes = await cand({ firstName: 'Yes', stage: 'INTERVIEW' });
    await prisma.candidateSubmittal.create({ data: { candidateId: yes.id, clientId: client.id, status: 'APPROVED', decidedAt: ago(1), feedback: 'Send her Monday.' } });
    const yesOffered = await cand({ firstName: 'YesOffered', stage: 'OFFER' });
    await prisma.candidateSubmittal.create({ data: { candidateId: yesOffered.id, clientId: client.id, status: 'APPROVED', decidedAt: ago(2) } });
    const offer = (candidateId: string, status: 'ACCEPTED' | 'SENT' | 'PENDING_APPROVAL', extra: object = {}) =>
      prisma.offer.create({ data: { candidateId, clientId: client.id, jobTitle: 'Cashier', startDate: new Date('2026-10-05'), hourlyRate: 15, status, ...extra } });
    await offer(yesOffered.id, 'SENT', { sentAt: ago(1), expiresAt: new Date(Date.now() + DAY) });

    // Signed, not hired (listed); signed and hired (not).
    const signed = await cand({ firstName: 'Signed', stage: 'OFFER' });
    await offer(signed.id, 'ACCEPTED', { decidedAt: ago(1), signedAt: ago(1) });
    const done = await cand({ firstName: 'Done', stage: 'HIRED', hiredAt: ago(2) });
    await offer(done.id, 'ACCEPTED', { decidedAt: ago(3) });

    // Pay approvals: someone else's is mine to approve; my own isn't.
    const held = await cand({ firstName: 'Held', stage: 'OFFER' });
    await offer(held.id, 'PENDING_APPROVAL', { createdById: other.id, approvalNote: '$19.00/hr is above the band.' });
    const heldMine = await cand({ firstName: 'HeldMine', stage: 'OFFER' });
    await offer(heldMine.id, 'PENDING_APPROVAL', { createdById: rec.id });

    // With the client.
    const waiting = await cand({ firstName: 'Waiting', stage: 'INTERVIEW' });
    await prisma.candidateSubmittal.create({ data: { candidateId: waiting.id, clientId: client.id, createdAt: ago(3) } });

    // Hired: one hasn't started onboarding (listed), one has (not).
    const idle = await createAssociate({ firstName: 'Idle', lastName: 'Hire' });
    await cand({ firstName: 'Idle', stage: 'HIRED', hiredAssociateId: idle.id, hiredAt: ago(4), jobPostingId: posting.id });
    const draft = await prisma.application.create({ data: { associateId: idle.id, clientId: client.id, onboardingTrack: 'STANDARD', invitedAt: ago(4) } });
    const busy = await createAssociate({ firstName: 'Busy', lastName: 'Hire' });
    await cand({ firstName: 'Busy', stage: 'HIRED', hiredAssociateId: busy.id, hiredAt: ago(4) });
    await prisma.application.create({ data: { associateId: busy.id, clientId: client.id, onboardingTrack: 'STANDARD', status: 'SUBMITTED' } });

    await prisma.candidateEvent.create({ data: { candidateId: kim.id, kind: 'STAGE_CHANGED', fromStage: 'SCREENING', toStage: 'INTERVIEW', actorUserId: rec.id } });

    const r = await a.get('/recruiting/home');
    expect(r.status).toBe(200);
    const h = r.body;

    expect(h.interviewsToday.map((i: { state: string; mine: boolean }) => [i.state, i.mine])).toEqual([
      ['done', false],
      ['needs_score', true],
      ['upcoming', false],
    ]);

    expect(h.newApplicants).toMatchObject({ last24h: 1, last7d: 2 });
    expect(h.newApplicants.recent.map((c: { candidateName: string }) => c.candidateName)).toEqual(['Fresh Test', 'Week Test']);
    expect(h.newApplicants.recent[0]).toMatchObject({ source: 'indeed', postingTitle: 'Cashier' });

    // Mine first, and the counts say how many are mine.
    expect(h.waitingOnYou.toScore).toMatchObject({ total: 2, mine: 1 });
    expect(h.waitingOnYou.toScore.items.map((i: { candidateName: string; mine: boolean }) => [i.candidateName, i.mine])).toEqual([
      ['Kim Test', true],
      ['Lee Test', false],
    ]);
    expect(h.waitingOnYou.stuck.items.map((c: { candidateName: string }) => c.candidateName)).toEqual(['Stale Test']);
    expect(h.waitingOnYou.clientApproved).toEqual([
      expect.objectContaining({ candidateName: 'Yes Test', clientName: 'Walmart', feedback: 'Send her Monday.' }),
    ]);
    expect(h.waitingOnYou.readyToHire.map((o: { candidateName: string }) => o.candidateName)).toEqual(['Signed Test']);
    expect(h.waitingOnYou.offersToApprove).toEqual([
      expect.objectContaining({ candidateName: 'Held Test', approvalNote: '$19.00/hr is above the band.' }),
    ]);

    expect(h.waitingOnOthers.withClients).toMatchObject({ total: 1, items: [{ candidateName: 'Waiting Test', days: 3 }] });
    expect(h.waitingOnOthers.awaitingSignature.items).toEqual([
      expect.objectContaining({ candidateName: 'YesOffered Test', expiringSoon: true }),
    ]);
    expect(h.waitingOnOthers.onboardingNotStarted).toMatchObject({
      total: 1,
      items: [{ applicationId: draft.id, candidateName: 'Idle Test', clientName: 'Walmart', days: 4 }],
    });

    expect(h.pipeline).toMatchObject({ SCREENING: 1 });
    expect(h.postings.items).toEqual([
      expect.objectContaining({ title: 'Cashier', openings: 2, hired: 1, applicants: 2, applicants7d: 1, daysOpen: 12 }),
    ]);
    expect(h.numbers.hiresThisMonth + h.numbers.hiresLastMonth).toBeGreaterThanOrEqual(1);
    expect(h.activity[0]).toMatchObject({ kind: 'STAGE_CHANGED', candidateName: 'Kim Test', toStage: 'INTERVIEW' });
  });

  it('is empty-handed, not wrong, on an empty pipeline', async () => {
    const { user: rec } = await createUser({ role: 'INTERNAL_RECRUITER' });
    const r = await (await loginAs(rec.email)).get('/recruiting/home');
    expect(r.status).toBe(200);
    expect(r.body.waitingOnYou.toScore).toEqual({ total: 0, mine: 0, items: [] });
    expect(r.body.numbers).toMatchObject({ hiresThisMonth: 0, medianDaysToHire: null, offerAcceptancePct: null });
  });

  it('is for people who can see recruiting', async () => {
    const client = await createClient('Walmart');
    const { user: portal } = await createUser({ role: 'CLIENT_PORTAL', clientId: client.id });
    expect((await (await loginAs(portal.email)).get('/recruiting/home')).status).toBe(403);
  });
});
