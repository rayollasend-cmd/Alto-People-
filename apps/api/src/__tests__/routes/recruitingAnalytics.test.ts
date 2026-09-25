import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import type { CandidateEventKind, CandidateStage } from '@prisma/client';
import { createApp } from '../../app.js';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

/**
 * The recruiting dashboard: funnel, speed, sources and what they cost,
 * offers and fill per client, and 90-day retention by source and by who
 * hired. Seeded directly so every number below is known in advance.
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
async function candidate(opts: {
  stage: CandidateStage;
  source?: string | null;
  createdAt?: Date;
  hiredAt?: Date | null;
  hiredClientId?: string | null;
  hiredAssociateId?: string | null;
  jobPostingId?: string | null;
  /** Timeline stage moves, in order. */
  path?: CandidateStage[];
  hiredBy?: string | null;
}) {
  n += 1;
  const c = await prisma.candidate.create({
    data: {
      firstName: 'C',
      lastName: String(n),
      email: `c${n}-${Math.random().toString(36).slice(2, 7)}@example.com`,
      stage: opts.stage,
      source: opts.source ?? null,
      createdAt: opts.createdAt ?? ago(20),
      hiredAt: opts.hiredAt ?? null,
      hiredClientId: opts.hiredClientId ?? null,
      hiredAssociateId: opts.hiredAssociateId ?? null,
      jobPostingId: opts.jobPostingId ?? null,
    },
  });
  const events: Array<{ kind: CandidateEventKind; toStage?: CandidateStage; actorUserId?: string | null }> = [];
  for (const s of opts.path ?? []) events.push({ kind: 'STAGE_CHANGED', toStage: s });
  if (opts.stage === 'HIRED') events.push({ kind: 'HIRED', toStage: 'HIRED', actorUserId: opts.hiredBy ?? null });
  for (const e of events) {
    await prisma.candidateEvent.create({
      data: { candidateId: c.id, kind: e.kind, toStage: e.toStage ?? null, actorUserId: e.actorUserId ?? null },
    });
  }
  return c;
}

async function setup() {
  const { user: rec } = await createUser({ role: 'INTERNAL_RECRUITER' });
  const a = await loginAs(rec.email);
  return { a, rec };
}

describe('the funnel', () => {
  it('counts how far each applicant got — a rejection after interview still reached interview', async () => {
    const { a } = await setup();
    await candidate({ stage: 'APPLIED' });
    await candidate({ stage: 'REJECTED', path: ['SCREENING', 'INTERVIEW', 'REJECTED'] });
    await candidate({ stage: 'WITHDRAWN', path: ['SCREENING', 'WITHDRAWN'] });
    await candidate({ stage: 'HIRED', path: ['SCREENING', 'INTERVIEW', 'OFFER'], hiredAt: ago(2) });
    // Applied before the range: not in this funnel.
    await candidate({ stage: 'APPLIED', createdAt: ago(200) });

    const r = await a.get('/recruiting/analytics');
    expect(r.status).toBe(200);
    expect(r.body.funnel).toMatchObject({ applicants: 4, rejected: 1, withdrawn: 1, inProgress: 1 });
    expect(r.body.funnel.stages).toEqual([
      { stage: 'APPLIED', reached: 4, toNextPct: 75 },
      { stage: 'SCREENING', reached: 3, toNextPct: 67 },
      { stage: 'INTERVIEW', reached: 2, toNextPct: 50 },
      { stage: 'OFFER', reached: 1, toNextPct: 100 },
      { stage: 'HIRED', reached: 1, toNextPct: null },
    ]);
  });
});

describe('where hires come from, and what they cost', () => {
  it('divides each source’s spend by the hires it brought in', async () => {
    const { a, rec } = await setup();
    const month = new Date().toISOString().slice(0, 7);
    expect((await a.put('/recruiting/source-spend').send({ source: 'Indeed', month, amount: 300 })).status).toBe(200);
    // Saving the month again replaces it.
    await a.put('/recruiting/source-spend').send({ source: 'indeed', month, amount: 400, note: 'Sponsored posts' });
    await a.put('/recruiting/source-spend').send({ source: 'craigslist', month, amount: 50 });
    expect((await a.put('/recruiting/source-spend').send({ source: 'indeed', month: '2026-13', amount: 1 })).status).toBe(400);

    await candidate({ stage: 'HIRED', source: 'indeed', hiredAt: ago(1), createdAt: ago(11) });
    await candidate({ stage: 'HIRED', source: 'Indeed ', hiredAt: ago(1), createdAt: ago(5) });
    await candidate({ stage: 'REJECTED', source: 'indeed' });
    await candidate({ stage: 'HIRED', source: 'referral', hiredAt: ago(1), createdAt: ago(3) });

    const r = await a.get('/recruiting/analytics');
    const bySource = Object.fromEntries(r.body.sources.map((s: { source: string }) => [s.source, s]));
    expect(bySource.indeed).toMatchObject({ applicants: 3, hires: 2, applicantToHirePct: 67, spend: 400, costPerHire: 200 });
    expect(bySource.referral).toMatchObject({ hires: 1, spend: null, costPerHire: null });
    // Money spent, nobody hired: no cost per hire to show.
    expect(bySource.craigslist).toMatchObject({ applicants: 0, hires: 0, spend: 50, costPerHire: null });
    expect(r.body.spendTotal).toBe(450);
    expect(r.body.costPerHire).toBe(150);
    // Median of 10, 4 and 2 days.
    expect(r.body.speed).toMatchObject({ hires: 3, medianDaysToHire: 4 });

    const list = (await a.get('/recruiting/source-spend')).body.spend;
    expect(list).toHaveLength(2);
    expect(list.find((s: { source: string }) => s.source === 'indeed')).toMatchObject({ month, amount: 400, note: 'Sponsored posts', updatedByEmail: rec.email });
  });

  it('only a recruiting manager records spend', async () => {
    const { user: viewer } = await createUser({ role: 'EXECUTIVE_CHAIRMAN' });
    const v = await loginAs(viewer.email);
    const r = await v.put('/recruiting/source-spend').send({ source: 'indeed', month: '2026-09', amount: 1 });
    expect([401, 403]).toContain(r.status);
  });
});

describe('offers and fill, per client', () => {
  it('acceptance counts declines and lapsed offers; fill is hires against openings', async () => {
    const { a } = await setup();
    const walmart = await createClient('Walmart');
    const target = await createClient('Target');
    const offer = async (clientId: string, status: 'ACCEPTED' | 'DECLINED' | 'SENT', extra: object = {}) => {
      const c = await candidate({ stage: 'OFFER' });
      await prisma.offer.create({
        data: { candidateId: c.id, clientId, jobTitle: 'Cashier', startDate: new Date('2026-10-05'), hourlyRate: 15, status, ...extra },
      });
    };
    await offer(walmart.id, 'ACCEPTED', { decidedAt: ago(3) });
    await offer(walmart.id, 'ACCEPTED', { decidedAt: ago(4) });
    await offer(walmart.id, 'DECLINED', { decidedAt: ago(5) });
    await offer(walmart.id, 'SENT', { expiresAt: ago(1) }); // never answered
    await offer(walmart.id, 'SENT', { expiresAt: new Date(Date.now() + 5 * DAY) }); // still open: not counted
    await offer(target.id, 'ACCEPTED', { decidedAt: ago(2) });

    // Walmart asked for 2 cashiers 10 days ago; one is hired so far.
    const p1 = await prisma.jobPosting.create({
      data: { clientId: walmart.id, title: 'Cashier', description: 'x', slug: 'wm-cashier', status: 'OPEN', openings: 2, openedAt: ago(10) },
    });
    await candidate({ stage: 'HIRED', jobPostingId: p1.id, hiredAt: ago(4), hiredClientId: walmart.id });
    // Target asked for 1 and it was filled 6 days after opening.
    const p2 = await prisma.jobPosting.create({
      data: { clientId: target.id, title: 'Stocker', description: 'x', slug: 'tg-stocker', status: 'OPEN', openings: 1, openedAt: ago(12) },
    });
    await candidate({ stage: 'HIRED', jobPostingId: p2.id, hiredAt: ago(6), hiredClientId: target.id });

    const r = await a.get('/recruiting/analytics');
    expect(r.body.offers).toEqual({ accepted: 3, declined: 1, expired: 1, acceptancePct: 60 });
    expect(r.body.fill).toEqual({ openings: 3, filled: 2, fillRatePct: 67 });
    expect(r.body.speed).toMatchObject({ postingsFilled: 1, medianDaysToFill: 6 });
    const byName = Object.fromEntries(r.body.clients.map((c: { clientName: string }) => [c.clientName, c]));
    expect(byName.Walmart).toMatchObject({
      hires: 1, offersAccepted: 2, offersDecided: 4, offerAcceptancePct: 50, openings: 2, filled: 1, fillRatePct: 50, medianDaysToFill: null,
    });
    expect(byName.Target).toMatchObject({ offerAcceptancePct: 100, fillRatePct: 100, medianDaysToFill: 6 });

    // The postings list says how far along each is.
    const postings = (await a.get('/job-postings')).body.postings;
    expect(postings.find((p: { slug: string }) => p.slug === 'wm-cashier')).toMatchObject({ openings: 2, hired: 1 });
    expect((await a.patch(`/job-postings/${p1.id}`).send({ openings: 3 })).status).toBe(200);
  });
});

describe('90-day retention', () => {
  it('by the source they came from and by who hired them', async () => {
    const { a, rec } = await setup();
    const { user: other } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hire = async (source: string, hiredBy: string, separatedAfterDays: number | null, hiredDaysAgo = 200) => {
      const assoc = await createAssociate();
      const hireDate = ago(hiredDaysAgo);
      await prisma.associate.update({
        where: { id: assoc.id },
        data: {
          hireDate,
          separatedAt: separatedAfterDays === null ? null : new Date(hireDate.getTime() + separatedAfterDays * DAY),
        },
      });
      await candidate({ stage: 'HIRED', source, hiredAt: hireDate, hiredAssociateId: assoc.id, hiredBy, createdAt: ago(hiredDaysAgo + 10) });
    };
    await hire('indeed', rec.id, null); // stayed
    await hire('indeed', rec.id, 30); // left in a month
    await hire('referral', other.id, null); // stayed
    await hire('referral', other.id, 120); // left after 90 days: counts as stayed
    await hire('indeed', rec.id, 10, 40); // too recent to measure

    const r = await a.get('/recruiting/analytics');
    const ret = r.body.retention;
    expect(ret.overall).toMatchObject({ hires: 4, stayed: 3, stayedPct: 75 });
    expect(ret.bySource).toEqual([
      { key: 'indeed', label: 'indeed', hires: 2, stayed: 1, stayedPct: 50 },
      { key: 'referral', label: 'referral', hires: 2, stayed: 2, stayedPct: 100 },
    ]);
    const byRec = Object.fromEntries(ret.byRecruiter.map((x: { key: string }) => [x.key, x]));
    expect(byRec[rec.id]).toMatchObject({ label: rec.email, hires: 2, stayedPct: 50 });
    expect(byRec[other.id]).toMatchObject({ label: other.email, hires: 2, stayedPct: 100 });
  });
});

describe('the range', () => {
  it('takes a from and to, and refuses one that runs backwards', async () => {
    const { a } = await setup();
    const ok = await a.get('/recruiting/analytics?from=2026-01-01&to=2026-03-31');
    expect(ok.body.range).toEqual({ from: '2026-01-01', to: '2026-03-31' });
    expect((await a.get('/recruiting/analytics?from=2026-03-01&to=2026-01-01')).status).toBe(400);
    expect((await a.get('/recruiting/analytics?from=2020-01-01&to=2026-01-01')).status).toBe(400);
  });

  it('a careers-page applicant is tied to the posting they applied to', async () => {
    const { a } = await setup();
    const p = await prisma.jobPosting.create({
      data: { title: 'Cashier', description: 'x', slug: 'cashier-destin', status: 'OPEN', openedAt: ago(1) },
    });
    const r = await request(app())
      .post('/careers/cashier-destin/apply')
      .send({ firstName: 'Kim', lastName: 'Phan', email: 'kim@example.com' });
    expect(r.status).toBe(201);
    const [c] = (await a.get('/recruiting/candidates')).body.candidates;
    expect(c.jobPostingId).toBe(p.id);
  });
});
