import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import type { CandidateEventKind, CandidateStage, Prisma } from '@prisma/client';
import { createApp } from '../../app.js';
import { journeyOf } from '../../lib/recruitingAnalytics.js';
import { closeQuietCandidates } from '../../lib/recruitingCleanup.js';
import { revertCandidateHire } from '../../lib/candidateHire.js';
import { DEFAULT_TEST_PASSWORD, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * "How candidates move" — the recruiting analytics' flow block: of the
 * candidates who applied in the range, how many reached each step, and
 * where and how everyone not hired stopped. Each journey below is seeded
 * through the code that writes it in production where that is practical
 * (the auto-close sweep, the careers page's re-apply, a recruiter's
 * restore, an undone hire), so the events are the real shapes.
 */

const app = () => createApp();
beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const DAY = 86_400_000;
const MIN = 60_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);
const T2 = '22222222-2222-4222-8222-222222222222';

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`loginAs(${email}) failed: ${r.status}`);
  return a;
}

let n = 0;
/** A candidate and their timeline: each move a minute after the last, starting when they applied. */
async function candidate(opts: {
  stage: CandidateStage;
  path?: CandidateStage[];
  createdAt?: Date;
  stageChangedAt?: Date;
  email?: string;
  tenantId?: string;
}) {
  n += 1;
  const createdAt = opts.createdAt ?? ago(20);
  const c = await prisma.candidate.create({
    data: {
      firstName: 'C',
      lastName: String(n),
      email: opts.email ?? `flow${n}-${Math.random().toString(36).slice(2, 7)}@example.com`,
      stage: opts.stage,
      createdAt,
      ...(opts.stageChangedAt ? { stageChangedAt: opts.stageChangedAt } : {}),
      ...(opts.stage === 'HIRED' ? { hiredAt: ago(1) } : {}),
      ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
    },
  });
  const events: Array<{ kind: CandidateEventKind; toStage: CandidateStage }> = (opts.path ?? []).map((s) => ({
    kind: s === 'HIRED' ? 'HIRED' : 'STAGE_CHANGED',
    toStage: s,
  }));
  let i = 0;
  for (const e of events) {
    i += 1;
    await prisma.candidateEvent.create({
      data: {
        candidateId: c.id,
        kind: e.kind,
        toStage: e.toStage,
        createdAt: new Date(createdAt.getTime() + i * MIN),
        ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
      },
    });
  }
  return c;
}

describe('how candidates move', () => {
  it('counts each applicant once — hired, or where and how they stopped', async () => {
    const { user: rec } = await createUser({ role: 'INTERNAL_RECRUITER' });
    const a = await loginAs(rec.email);

    // Auto-closed: quiet at Screening for 40 days; the sweep withdraws them.
    // Seeded and swept first, so the sweep sees nobody else.
    const quiet = await candidate({ stage: 'SCREENING', path: ['SCREENING'], createdAt: ago(45), stageChangedAt: ago(44) });
    expect(await closeQuietCandidates()).toBe(1);
    expect((await prisma.candidate.findUniqueOrThrow({ where: { id: quiet.id } })).stage).toBe('WITHDRAWN');

    // Hired, the whole way.
    await candidate({ stage: 'HIRED', path: ['SCREENING', 'INTERVIEW', 'OFFER', 'HIRED'] });
    // Rejected at screening.
    await candidate({ stage: 'REJECTED', path: ['SCREENING', 'REJECTED'] });
    // Withdrew at offer, by hand.
    await candidate({ stage: 'WITHDRAWN', path: ['SCREENING', 'INTERVIEW', 'OFFER', 'WITHDRAWN'] });
    // Still open at interview.
    await candidate({ stage: 'INTERVIEW', path: ['SCREENING', 'INTERVIEW'] });
    // Skipped a step: Applied straight to Interview, then rejected — passed through Screening.
    await candidate({ stage: 'REJECTED', path: ['INTERVIEW', 'REJECTED'] });

    // RESTORED, a re-application: got to Offer, was rejected, was removed,
    // and applied again on the careers page — a new journey, back at Applied.
    const posting = await prisma.jobPosting.create({
      data: { title: 'Cashier', description: 'x', slug: 'flow-cashier', status: 'OPEN', openedAt: ago(30) },
    });
    const again = await candidate({ stage: 'REJECTED', path: ['SCREENING', 'INTERVIEW', 'OFFER', 'REJECTED'], email: 'again@example.com' });
    await prisma.candidate.update({ where: { id: again.id }, data: { deletedAt: ago(2), jobPostingId: posting.id } });
    const apply = await request(app())
      .post(`/careers/${posting.slug}/apply`)
      .send({ firstName: 'Again', lastName: 'Applicant', email: 'again@example.com' });
    expect(apply.status).toBe(201);
    expect(apply.body.id).toBe(again.id);

    // RESTORED by a recruiter: removed by mistake and put back — their history stands.
    const back = await candidate({ stage: 'INTERVIEW', path: ['SCREENING', 'INTERVIEW'] });
    await prisma.candidate.update({ where: { id: back.id }, data: { deletedAt: ago(1) } });
    expect((await a.post(`/recruiting/candidates/${back.id}/restore`)).status).toBe(200);

    // HIRE_UNDONE: hired, then the hire was taken back — at Offer again, not hired.
    const undone = await candidate({ stage: 'HIRED', path: ['SCREENING', 'INTERVIEW', 'OFFER', 'HIRED'] });
    await prisma.$transaction((tx) => revertCandidateHire(tx, { candidateId: undone.id }, { reason: 'Changed their mind', actorUserId: rec.id }));

    // Not in this cohort: applied before the range, removed, or another tenant's.
    await candidate({ stage: 'HIRED', path: ['SCREENING', 'INTERVIEW', 'OFFER', 'HIRED'], createdAt: ago(200) });
    const removed = await candidate({ stage: 'REJECTED', path: ['REJECTED'] });
    await prisma.candidate.update({ where: { id: removed.id }, data: { deletedAt: ago(1) } });
    await prisma.tenant.create({ data: { id: T2, slug: 'tenant-two', name: 'Tenant Two' } });
    await candidate({ stage: 'HIRED', path: ['SCREENING', 'INTERVIEW', 'OFFER', 'HIRED'], tenantId: T2 });
    await candidate({ stage: 'REJECTED', path: ['SCREENING', 'REJECTED'], tenantId: T2 });

    const r = await a.get('/recruiting/analytics');
    expect(r.status).toBe(200);
    const { flow, funnel } = r.body;

    expect(flow.reached).toEqual({ APPLIED: 9, SCREENING: 8, INTERVIEW: 6, OFFER: 3, HIRED: 1 });
    // Every step and outcome, in pipeline order, zeros included.
    expect(flow.exits).toEqual([
      { stage: 'APPLIED', outcome: 'REJECTED', count: 0, autoClosed: 0 },
      { stage: 'APPLIED', outcome: 'WITHDRAWN', count: 0, autoClosed: 0 },
      { stage: 'APPLIED', outcome: 'OPEN', count: 1, autoClosed: 0 }, // re-applied
      { stage: 'SCREENING', outcome: 'REJECTED', count: 1, autoClosed: 0 },
      { stage: 'SCREENING', outcome: 'WITHDRAWN', count: 1, autoClosed: 1 }, // the sweep
      { stage: 'SCREENING', outcome: 'OPEN', count: 0, autoClosed: 0 },
      { stage: 'INTERVIEW', outcome: 'REJECTED', count: 1, autoClosed: 0 }, // skipped screening
      { stage: 'INTERVIEW', outcome: 'WITHDRAWN', count: 0, autoClosed: 0 },
      { stage: 'INTERVIEW', outcome: 'OPEN', count: 2, autoClosed: 0 }, // open, and restored by a recruiter
      { stage: 'OFFER', outcome: 'REJECTED', count: 0, autoClosed: 0 },
      { stage: 'OFFER', outcome: 'WITHDRAWN', count: 1, autoClosed: 0 },
      { stage: 'OFFER', outcome: 'OPEN', count: 1, autoClosed: 0 }, // hire undone
    ]);

    // The flow balances at every step: those who reached it either moved on or stopped there.
    const steps = ['APPLIED', 'SCREENING', 'INTERVIEW', 'OFFER', 'HIRED'] as const;
    for (let i = 0; i < 4; i++) {
      const stopped = flow.exits.filter((e: { stage: string }) => e.stage === steps[i]).reduce((s: number, e: { count: number }) => s + e.count, 0);
      expect(flow.reached[steps[i]!]).toBe(flow.reached[steps[i + 1]!] + stopped);
    }

    // The funnel beside it counts the same journeys, so the two cards always
    // agree: the re-applicant is back at Applied, not at Offer, and the undone
    // hire reached Offer, not Hired. Its outcome totals agree with the flow too.
    expect(funnel).toMatchObject({ applicants: 9, rejected: 2, withdrawn: 2, inProgress: 4 });
    for (const s of funnel.stages as Array<{ stage: (typeof steps)[number]; reached: number }>) {
      expect(s.reached, s.stage).toBe(flow.reached[s.stage]);
    }
    expect(funnel.stages.map((s: { reached: number }) => s.reached)).toEqual([9, 8, 6, 3, 1]);
  });

  it('is all zeros when no one applied in the range', async () => {
    const { user: rec } = await createUser({ role: 'INTERNAL_RECRUITER' });
    const a = await loginAs(rec.email);
    await candidate({ stage: 'HIRED', path: ['HIRED'], createdAt: ago(200) });
    const r = await a.get('/recruiting/analytics?from=2026-01-01&to=2026-01-31');
    expect(r.status).toBe(200);
    expect(r.body.flow.reached).toEqual({ APPLIED: 0, SCREENING: 0, INTERVIEW: 0, OFFER: 0, HIRED: 0 });
    expect(r.body.flow.exits).toHaveLength(12);
    expect(r.body.flow.exits.every((e: { count: number }) => e.count === 0)).toBe(true);
  });
});

describe('journeyOf — one candidate’s current journey', () => {
  const ev = (kind: CandidateEventKind, toStage: CandidateStage | null = null, metadata: Prisma.JsonValue = null) => ({ kind, toStage, metadata });

  it('a skipped step is passed through, and the current stage counts', () => {
    expect(journeyOf('OFFER', [ev('STAGE_CHANGED', 'OFFER')])).toEqual({ furthest: 3, outcome: 'OPEN', autoClosed: false });
    // No timeline at all (an imported candidate): the stage they are at.
    expect(journeyOf('INTERVIEW', [])).toEqual({ furthest: 2, outcome: 'OPEN', autoClosed: false });
    expect(journeyOf('REJECTED', [])).toEqual({ furthest: 0, outcome: 'REJECTED', autoClosed: false });
  });

  it('an undone hire falls back to before the hire, or where the undo put them', () => {
    // Hired straight from Applied, undone to Offer: at Offer now.
    expect(journeyOf('OFFER', [ev('HIRED', 'HIRED'), ev('HIRE_UNDONE', 'OFFER')]).furthest).toBe(3);
    // Undone to Screening after reaching Interview: Interview still stands.
    expect(journeyOf('SCREENING', [ev('STAGE_CHANGED', 'INTERVIEW'), ev('HIRED', 'HIRED'), ev('HIRE_UNDONE', 'SCREENING')]).furthest).toBe(2);
    // Undone, then rejected at the offer.
    expect(journeyOf('REJECTED', [ev('STAGE_CHANGED', 'OFFER'), ev('HIRED', 'HIRED'), ev('HIRE_UNDONE', 'OFFER'), ev('STAGE_CHANGED', 'REJECTED')])).toEqual({
      furthest: 3,
      outcome: 'REJECTED',
      autoClosed: false,
    });
    // Hired, undone, hired again: hired.
    expect(journeyOf('HIRED', [ev('HIRED', 'HIRED'), ev('HIRE_UNDONE', 'OFFER'), ev('HIRED', 'HIRED')])).toEqual({ furthest: 4, outcome: 'HIRED', autoClosed: false });
    // An undo with no hire before it never lowers the journey.
    expect(journeyOf('INTERVIEW', [ev('STAGE_CHANGED', 'INTERVIEW'), ev('HIRE_UNDONE', 'APPLIED')]).furthest).toBe(2);
  });

  it('a re-application starts over; a recruiter’s restore does not', () => {
    const before = [ev('STAGE_CHANGED', 'OFFER'), ev('STAGE_CHANGED', 'REJECTED')];
    expect(journeyOf('SCREENING', [...before, ev('RESTORED', 'APPLIED'), ev('STAGE_CHANGED', 'SCREENING')]).furthest).toBe(1);
    expect(journeyOf('REJECTED', [...before, ev('RESTORED')]).furthest).toBe(3);
    // A hire before the re-application is gone with the rest.
    expect(journeyOf('APPLIED', [ev('HIRED', 'HIRED'), ev('RESTORED', 'APPLIED')]).furthest).toBe(0);
  });

  it('auto-closed only when the move that withdrew them was the sweep’s', () => {
    const swept = ev('STAGE_CHANGED', 'WITHDRAWN', { automatic: true });
    expect(journeyOf('WITHDRAWN', [ev('STAGE_CHANGED', 'SCREENING'), swept])).toEqual({ furthest: 1, outcome: 'WITHDRAWN', autoClosed: true });
    // Reopened, then withdrawn by hand: not auto-closed.
    expect(journeyOf('WITHDRAWN', [swept, ev('STAGE_CHANGED', 'APPLIED'), ev('STAGE_CHANGED', 'WITHDRAWN')]).autoClosed).toBe(false);
    // Swept, then reopened and still open: open.
    expect(journeyOf('APPLIED', [swept, ev('STAGE_CHANGED', 'APPLIED')])).toEqual({ furthest: 0, outcome: 'OPEN', autoClosed: false });
  });

  it('nobody but a hire ends at Hired', () => {
    // A hire event with no undo on a candidate who is not hired (old data): stops at Offer.
    expect(journeyOf('REJECTED', [ev('HIRED', 'HIRED')]).furthest).toBe(3);
  });
});
