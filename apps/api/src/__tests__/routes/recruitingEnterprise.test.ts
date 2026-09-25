import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import type { CandidateStage } from '@prisma/client';
import { createApp } from '../../app.js';
import { DEFAULT_TEST_PASSWORD, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * The candidate pipeline at scale: searched, filtered and paged on the
 * server (it used to load the newest 200 and filter those in the browser),
 * saved views, and the job-board feed.
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

async function recruiter() {
  const { user } = await createUser({ role: 'INTERNAL_RECRUITER' });
  return { user, a: await loginAs(user.email) };
}

let n = 0;
function cand(over: Partial<{ firstName: string; lastName: string; position: string; source: string; stage: CandidateStage; createdAt: Date; stageChangedAt: Date }> = {}) {
  n += 1;
  return {
    firstName: over.firstName ?? `First${n}`,
    lastName: over.lastName ?? `Last${n}`,
    email: `c${n}-${Math.random().toString(36).slice(2, 7)}@example.com`,
    position: over.position ?? null,
    source: over.source ?? null,
    stage: over.stage ?? ('APPLIED' as CandidateStage),
    createdAt: over.createdAt ?? ago(1),
    stageChangedAt: over.stageChangedAt ?? over.createdAt ?? ago(1),
  };
}

describe('search, filters and paging on the server', () => {
  it('counts and pages past 200 — nobody falls off the end', async () => {
    const { a } = await recruiter();
    await prisma.candidate.createMany({ data: Array.from({ length: 205 }, (_, i) => cand({ createdAt: ago(300 - i) })) });
    const first = await a.get('/recruiting/candidates?limit=100');
    expect(first.body).toMatchObject({ total: 205, offset: 0, limit: 100 });
    expect(first.body.candidates).toHaveLength(100);
    const last = await a.get('/recruiting/candidates?limit=100&offset=200');
    expect(last.body.candidates).toHaveLength(5);
    // Newest first by default; pages don't overlap.
    const ids = new Set([...first.body.candidates, ...last.body.candidates].map((c: { id: string }) => c.id));
    expect(ids.size).toBe(105);
    // A page is capped.
    expect((await a.get('/recruiting/candidates?limit=5000')).body.limit).toBe(200);
  });

  it('matches every word against name, email, phone and position', async () => {
    const { a } = await recruiter();
    await prisma.candidate.createMany({
      data: [
        cand({ firstName: 'Kim', lastName: 'Phan', position: 'Cashier' }),
        cand({ firstName: 'Kim', lastName: 'Lee', position: 'Stocker' }),
        cand({ firstName: 'Ana', lastName: 'Diaz', position: 'Cashier' }),
      ],
    });
    const names = async (q: string) =>
      (await a.get(`/recruiting/candidates?q=${encodeURIComponent(q)}`)).body.candidates
        .map((c: { firstName: string; lastName: string }) => `${c.firstName} ${c.lastName}`)
        .sort();
    expect(await names('kim')).toEqual(['Kim Lee', 'Kim Phan']);
    expect(await names('kim cashier')).toEqual(['Kim Phan']);
    expect(await names('CASH')).toEqual(['Ana Diaz', 'Kim Phan']);
  });

  it('filters by stage, source and who has gone cold, and sorts', async () => {
    const { a } = await recruiter();
    await prisma.candidate.createMany({
      data: [
        cand({ firstName: 'Stale', stage: 'SCREENING', source: 'Indeed', stageChangedAt: ago(10) }),
        cand({ firstName: 'Fresh', stage: 'SCREENING', source: 'indeed', stageChangedAt: ago(1) }),
        cand({ firstName: 'Offer', stage: 'OFFER', source: 'referral', stageChangedAt: ago(20) }),
        cand({ firstName: 'Gone', stage: 'REJECTED', source: 'indeed', stageChangedAt: ago(30) }),
      ],
    });
    const first = async (qs: string) =>
      (await a.get(`/recruiting/candidates?${qs}`)).body.candidates.map((c: { firstName: string }) => c.firstName);
    expect((await first('stage=SCREENING,OFFER&sort=name')).sort()).toEqual(['Fresh', 'Offer', 'Stale']);
    expect((await first('source=indeed')).sort()).toEqual(['Fresh', 'Gone', 'Stale']);
    // Stuck: open stage, a week or more — the rejected one isn't "stuck".
    expect((await first('stuck=1&sort=waiting'))).toEqual(['Offer', 'Stale']);
    expect((await a.get('/recruiting/candidates?sort=sideways')).status).toBe(400);
  });
});

describe('the board', () => {
  it('counts every column and sends the first page of each', async () => {
    const { a } = await recruiter();
    await prisma.candidate.createMany({
      data: [
        ...Array.from({ length: 30 }, () => cand({ stage: 'APPLIED' })),
        cand({ firstName: 'Hired-old', stage: 'HIRED', stageChangedAt: ago(40) }),
        cand({ firstName: 'Hired-new', stage: 'HIRED', stageChangedAt: ago(2) }),
        cand({ firstName: 'Kim', lastName: 'Phan', stage: 'INTERVIEW' }),
      ],
    });
    const r = await a.get('/recruiting/candidates/board?perStage=10');
    expect(r.status).toBe(200);
    const col = Object.fromEntries(r.body.columns.map((c: { stage: string }) => [c.stage, c]));
    expect(r.body.columns.map((c: { stage: string }) => c.stage)).toEqual([
      'APPLIED', 'SCREENING', 'INTERVIEW', 'OFFER', 'HIRED', 'WITHDRAWN', 'REJECTED',
    ]);
    expect(col.APPLIED.total).toBe(30);
    expect(col.APPLIED.candidates).toHaveLength(10);
    // Outcomes: most recent first.
    expect(col.HIRED.candidates.map((c: { firstName: string }) => c.firstName)).toEqual(['Hired-new', 'Hired-old']);
    // Search narrows every column.
    const kim = await a.get('/recruiting/candidates/board?q=phan');
    const totals = Object.fromEntries(kim.body.columns.map((c: { stage: string; total: number }) => [c.stage, c.total]));
    expect(totals).toMatchObject({ APPLIED: 0, INTERVIEW: 1, HIRED: 0 });
  });
});

describe('saved views', () => {
  it('mine, and the team’s shared ones — never someone else’s private one', async () => {
    const { a, user } = await recruiter();
    const { a: b } = await recruiter();
    const mine = await a.post('/saved-views').send({
      scope: 'recruiting.candidates',
      name: 'Stuck in screening',
      query: { stage: 'SCREENING', stuck: '1' },
    });
    expect(mine.status).toBe(201);
    expect(mine.body).toMatchObject({ mine: true, shared: false, query: { stage: 'SCREENING', stuck: '1' } });
    await b.post('/saved-views').send({ scope: 'recruiting.candidates', name: 'B private', query: { q: 'x' } });
    await b.post('/saved-views').send({ scope: 'recruiting.candidates', name: 'Walmart cashiers', query: { q: 'cashier' }, shared: true });

    const list = (await a.get('/saved-views?scope=recruiting.candidates')).body.views;
    expect(list.map((v: { name: string }) => v.name)).toEqual(['Stuck in screening', 'Walmart cashiers']);
    expect(list[1]).toMatchObject({ mine: false, shared: true });

    // Someone else's shared view is theirs to change.
    expect((await a.patch(`/saved-views/${list[1].id}`).send({ name: 'Mine now' })).status).toBe(403);
    expect((await a.delete(`/saved-views/${list[1].id}`)).status).toBe(403);

    const renamed = await a.patch(`/saved-views/${mine.body.id}`).send({ name: 'Cold in screening', shared: true });
    expect(renamed.body).toMatchObject({ name: 'Cold in screening', shared: true });
    const bSees = (await b.get('/saved-views?scope=recruiting.candidates')).body.views;
    expect(bSees.find((v: { id: string }) => v.id === mine.body.id)).toMatchObject({ mine: false });
    expect(bSees.find((v: { id: string }) => v.id === mine.body.id).ownerName).toBe(user.email);

    expect((await a.delete(`/saved-views/${mine.body.id}`)).status).toBe(204);
  });

  it('only for people who can see the list, and only short string filters', async () => {
    const client = await createClient('Walmart');
    const { user: portal } = await createUser({ role: 'CLIENT_PORTAL', clientId: client.id });
    const p = await loginAs(portal.email);
    expect((await p.get('/saved-views?scope=recruiting.candidates')).status).toBe(403);
    const { a } = await recruiter();
    expect((await a.get('/saved-views?scope=payroll.runs')).status).toBe(400);
    const bad = await a.post('/saved-views').send({ scope: 'recruiting.candidates', name: 'x', query: { q: { $gt: '' } } });
    expect(bad.status).toBe(400);
  });
});

describe('job-board syndication', () => {
  async function posting(over: Record<string, unknown> = {}) {
    return prisma.jobPosting.create({
      data: {
        title: 'Cashier',
        description: 'Ring up customers.\n\nNights & weekends — must be 18+ <no html>.',
        slug: `cashier-${Math.random().toString(36).slice(2, 7)}`,
        status: 'OPEN',
        openedAt: ago(2),
        location: 'Destin, FL 32541',
        minSalary: 14,
        maxSalary: 17,
        payUnit: 'HOUR',
        schedule: 'PART_TIME',
        ...over,
      },
    });
  }

  it('lists open, syndicated postings with links that credit the board', async () => {
    const p = await posting();
    await posting({ title: 'Internal only', syndicate: false });
    await posting({ title: 'Draft', status: 'DRAFT' });
    const r = await request(app()).get('/careers/feed.xml?board=indeed');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/application\/xml/);
    const xml = r.text;
    expect(xml).toContain('<source>');
    expect((xml.match(/<job>/g) ?? []).length).toBe(1);
    expect(xml).toContain('<title><![CDATA[Cashier]]></title>');
    expect(xml).toContain(`<referencenumber><![CDATA[${p.id}]]></referencenumber>`);
    expect(xml).toMatch(new RegExp(`<url><!\\[CDATA\\[http[^\\]]*/careers/${p.slug}\\?source=indeed\\]\\]></url>`));
    expect(xml).toContain('<city><![CDATA[Destin]]></city>');
    expect(xml).toContain('<state><![CDATA[FL]]></state>');
    expect(xml).toContain('<postalcode><![CDATA[32541]]></postalcode>');
    expect(xml).toContain('<salary><![CDATA[$14.00 - $17.00 per hour]]></salary>');
    expect(xml).toContain('<jobtype><![CDATA[parttime]]></jobtype>');
    // The description is escaped HTML paragraphs.
    expect(xml).toContain('<p>Ring up customers.</p><p>Nights &amp; weekends — must be 18+ &lt;no html&gt;.</p>');
  });

  it('a board name is sanitized, and an applicant from the link is credited to it', async () => {
    const p = await posting();
    const r = await request(app()).get('/careers/feed.xml?board=<script>');
    expect(r.text).toContain('?source=job-board');
    await request(app()).post(`/careers/${p.slug}/apply`).send({ firstName: 'Kim', lastName: 'Phan', email: 'kim@example.com', source: 'indeed' });
    const c = await prisma.candidate.findUniqueOrThrow({ where: { email: 'kim@example.com' } });
    expect(c).toMatchObject({ source: 'indeed', jobPostingId: p.id });
  });

  it('the posting page carries what Google for Jobs needs', async () => {
    const p = await posting();
    const r = await request(app()).get(`/careers/${p.slug}`);
    expect(r.body).toMatchObject({ schedule: 'PART_TIME', payUnit: 'HOUR', orgName: expect.any(String) });
  });

  it('a recruiter can take a posting out of the feeds', async () => {
    const { a } = await recruiter();
    const p = await posting();
    expect((await a.patch(`/job-postings/${p.id}`).send({ syndicate: false })).status).toBe(200);
    expect((await request(app()).get('/careers/feed.xml')).text).not.toContain('<job>');
    const row = (await a.get('/job-postings')).body.postings[0];
    expect(row).toMatchObject({ syndicate: false, schedule: 'PART_TIME', payUnit: 'HOUR' });
  });
});
