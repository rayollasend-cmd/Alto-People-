import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';

// The careers confirmation is fire-and-forget email; capture it instead of
// sending. Everything else in the module stays real.
const sent = vi.hoisted(() => [] as Array<{ subject: string | null; to: string | null; body: string }>);
vi.mock('../../lib/notifications.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/notifications.js')>();
  return {
    ...real,
    send: vi.fn(async (input: Parameters<typeof real.send>[0]) => {
      sent.push({ subject: input.subject, to: input.recipient.email, body: input.body });
      return { externalRef: 'test', status: 'SENT' as const };
    }),
  };
});

import { createApp } from '../../app.js';
import { flushPendingAudits } from '../../lib/audit.js';
import {
  DEFAULT_TEST_PASSWORD,
  createClient,
  createStandardTemplate,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

/**
 * A candidate's history. Recruiting used to keep only the stage someone
 * was in now: no record of when they got there or who moved them, so
 * "days in stage" was really days since applying, time-to-hire could not
 * be computed, and nothing a recruiter did was audited.
 */

const app = () => createApp();
beforeEach(async () => {
  await truncateAll();
  sent.length = 0;
});
afterAll(async () => {
  await prisma.$disconnect();
});

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

async function candidate(a: TestAgent<Test>, email = 'pat@example.com') {
  const r = await a.post('/recruiting/candidates').send({
    firstName: 'Pat', lastName: 'Hopeful', email, position: 'Cashier', source: 'indeed',
  });
  return r.body as { id: string; stageChangedAt: string };
}

describe('the timeline', () => {
  it('records every stage move — from, to, why, and who', async () => {
    const { a } = await recruiter();
    const c = await candidate(a);
    await a.post(`/recruiting/candidates/${c.id}/advance`).send({ stage: 'SCREENING' });
    await a
      .post(`/recruiting/candidates/${c.id}/advance`)
      .send({ stage: 'REJECTED', rejectedReason: 'No transportation to the store' });

    const { body } = await a.get(`/recruiting/candidates/${c.id}/events`);
    // Newest first.
    expect(body.events.map((e: { kind: string }) => e.kind)).toEqual(['STAGE_CHANGED', 'STAGE_CHANGED', 'CREATED']);
    expect(body.events[0]).toMatchObject({
      fromStage: 'SCREENING',
      toStage: 'REJECTED',
      body: 'No transportation to the store',
    });
    expect(body.events[0].actorName).toBeTruthy();
  });

  it('"days in stage" restarts on a real move only', async () => {
    const { a } = await recruiter();
    const c = await candidate(a);
    // A week in Applied.
    await prisma.candidate.update({
      where: { id: c.id },
      data: { stageChangedAt: new Date(Date.now() - 7 * 86_400_000) },
    });
    const moved = await a.post(`/recruiting/candidates/${c.id}/advance`).send({ stage: 'SCREENING' });
    expect(Date.now() - Date.parse(moved.body.stageChangedAt)).toBeLessThan(60_000);

    // Re-saving the stage it is already in must not make it look fresh.
    await prisma.candidate.update({
      where: { id: c.id },
      data: { stageChangedAt: new Date(Date.now() - 3 * 86_400_000) },
    });
    const same = await a.post(`/recruiting/candidates/${c.id}/advance`).send({ stage: 'SCREENING' });
    expect(Date.now() - Date.parse(same.body.stageChangedAt)).toBeGreaterThan(2 * 86_400_000);
    const kinds = (await a.get(`/recruiting/candidates/${c.id}/events`)).body.events.map((e: { kind: string }) => e.kind);
    expect(kinds.filter((k: string) => k === 'STAGE_CHANGED')).toHaveLength(1);
  });

  it('notes are dated entries with an author, not one overwritable field', async () => {
    const { a } = await recruiter();
    const c = await candidate(a);
    expect((await a.post(`/recruiting/candidates/${c.id}/notes`).send({ body: '  ' })).status).toBe(400);
    await a.post(`/recruiting/candidates/${c.id}/notes`).send({ body: 'Can start Monday, needs weekends off.' });
    await a.post(`/recruiting/candidates/${c.id}/notes`).send({ body: 'Called back — confirmed.' });

    const notes = (await a.get(`/recruiting/candidates/${c.id}/events`)).body.events.filter(
      (e: { kind: string }) => e.kind === 'NOTE',
    );
    expect(notes.map((n: { body: string }) => n.body)).toEqual([
      'Called back — confirmed.',
      'Can start Monday, needs weekends off.',
    ]);
  });

  it('an edit says what changed', async () => {
    const { a } = await recruiter();
    const c = await candidate(a);
    const r = await a.patch(`/recruiting/candidates/${c.id}`).send({ phone: '850-555-0100', position: 'Stocker' });
    expect(r.body.position).toBe('Stocker');
    // Saving the same values again is not an edit.
    await a.patch(`/recruiting/candidates/${c.id}`).send({ phone: '850-555-0100' });
    const edits = (await a.get(`/recruiting/candidates/${c.id}/events`)).body.events.filter(
      (e: { kind: string }) => e.kind === 'EDITED',
    );
    expect(edits).toHaveLength(1);
    expect(edits[0].body).toBe('Updated phone, position');
  });

  it('interviews and offers land on the timeline too', async () => {
    const { a } = await recruiter();
    const client = await createClient();
    const c = await candidate(a);
    const iv = await a.post('/interviews').send({ candidateId: c.id, scheduledFor: new Date(Date.now() + 86_400_000).toISOString() });
    await a.post(`/interviews/${iv.body.id}/score`).send({ scorecard: { notes: 'Great' }, rating: 2 });
    const offer = await a.post('/offers').send({
      candidateId: c.id, clientId: client.id, jobTitle: 'Cashier', startDate: '2026-10-05', hourlyRate: 15,
    });
    await a.post(`/offers/${offer.body.id}/send`);
    await a.post(`/offers/${offer.body.id}/decision`).send({ decision: 'ACCEPTED' });

    const events = (await a.get(`/recruiting/candidates/${c.id}/events`)).body.events;
    const byKind = Object.fromEntries(events.map((e: { kind: string; body: string }) => [e.kind, e.body]));
    expect(byKind.INTERVIEW_SCHEDULED).toBeTruthy();
    expect(byKind.INTERVIEW_SCORED).toBe('Recommendation: Strong yes');
    expect(byKind.OFFER_CREATED).toContain('Cashier');
    expect(byKind.OFFER_SENT).toBe('Cashier');
    expect(byKind.OFFER_DECIDED).toBe('Accepted: Cashier');
  });

  it('scoring an interview that does not exist is a 404, not a 500', async () => {
    const { a } = await recruiter();
    const r = await a
      .post('/interviews/00000000-0000-4000-8000-000000000000/score')
      .send({ scorecard: null, rating: 1 });
    expect(r.status).toBe(404);
  });

  it('an offer for a candidate that does not exist is refused', async () => {
    const { a } = await recruiter();
    const client = await createClient();
    const r = await a.post('/offers').send({
      candidateId: '00000000-0000-4000-8000-000000000000', clientId: client.id, jobTitle: 'X', startDate: '2026-10-05', hourlyRate: 15,
    });
    expect(r.status).toBe(404);
  });

  it('every recruiter action is in the audit log', async () => {
    const { a, user } = await recruiter();
    const c = await candidate(a);
    await a.post(`/recruiting/candidates/${c.id}/advance`).send({ stage: 'SCREENING' });
    await a.post(`/recruiting/candidates/${c.id}/notes`).send({ body: 'hi' });
    const hire = await a
      .post(`/recruiting/candidates/${c.id}/hire`)
      .send({ clientId: (await createClient()).id, templateId: (await createStandardTemplate()).id });
    expect(hire.status).toBe(200);

    await flushPendingAudits();
    const actions = (
      await prisma.auditLog.findMany({
        where: { entityType: 'Candidate', entityId: c.id },
        orderBy: { createdAt: 'asc' },
      })
    ).map((l) => [l.action, l.actorUserId]);
    expect(actions).toEqual([
      ['recruiting.candidate_created', user.id],
      ['recruiting.stage_changed', user.id],
      ['recruiting.note_added', user.id],
      ['recruiting.candidate_hired', user.id],
    ]);
  });
});

describe('GET /recruiting/summary — the recruiter\'s dashboard', () => {
  it('counts the pipeline and names what is waiting', async () => {
    const { a } = await recruiter();
    const fresh = await candidate(a, 'fresh@example.com');
    const stuck = await candidate(a, 'stuck@example.com');
    await a.post(`/recruiting/candidates/${stuck.id}/advance`).send({ stage: 'SCREENING' });
    await prisma.candidate.update({
      where: { id: stuck.id },
      data: { stageChangedAt: new Date(Date.now() - 9 * 86_400_000) },
    });
    // An interview that already happened and was never scored.
    await a.post('/interviews').send({ candidateId: fresh.id, scheduledFor: new Date(Date.now() - 3_600_000).toISOString() });
    // A hire this month, 6 days after they applied.
    const hired = await candidate(a, 'hired@example.com');
    await prisma.candidate.update({
      where: { id: hired.id },
      data: { createdAt: new Date(Date.now() - 6 * 86_400_000) },
    });
    await a
      .post(`/recruiting/candidates/${hired.id}/hire`)
      .send({ clientId: (await createClient()).id, templateId: (await createStandardTemplate()).id });

    const { body, status } = await a.get('/recruiting/summary');
    expect(status).toBe(200);
    expect(body.byStage).toEqual({ APPLIED: 1, SCREENING: 1, INTERVIEW: 0, OFFER: 0 });
    expect(body.stuckCount).toBe(1);
    expect(body.stuck[0]).toMatchObject({ id: stuck.id, stage: 'SCREENING', daysInStage: 9 });
    expect(body.unscoredInterviews).toBe(1);
    expect(body.hiredThisMonth).toBe(1);
    expect(body.medianDaysToHire).toBeCloseTo(6, 0);
  });

  it('is for people who can see recruiting', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    const a = await loginAs(user.email);
    expect((await a.get('/recruiting/summary')).status).toBe(403);
  });
});

describe('the public careers page', () => {
  async function openPosting(a: TestAgent<Test>) {
    const p = await a.post('/job-postings').send({
      title: 'Overnight Stocker', description: 'Stock shelves overnight.', slug: 'overnight-stocker',
    });
    await a.post(`/job-postings/${p.body.id}/open`);
    return 'overnight-stocker';
  }

  it('confirms the application by email, and starts their timeline', async () => {
    const { a } = await recruiter();
    const slug = await openPosting(a);
    const r = await request(app()).post(`/careers/${slug}/apply`).send({
      firstName: 'Jasmine', lastName: 'Reed', email: 'Jasmine@Example.com',
    });
    expect(r.status).toBe(201);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ to: 'jasmine@example.com', subject: 'We received your application: Overnight Stocker' });

    const c = await prisma.candidate.findUniqueOrThrow({ where: { email: 'jasmine@example.com' } });
    // The label the recruiter UI already knows, not a raw constant.
    expect(c.source).toBe('careers-page');
    const events = (await a.get(`/recruiting/candidates/${c.id}/events`)).body.events;
    expect(events[0]).toMatchObject({ kind: 'CREATED', body: 'Applied on the careers page: Overnight Stocker', actorName: null });
  });

  it('someone already on file who applies again is no longer dropped silently', async () => {
    const { a } = await recruiter();
    const slug = await openPosting(a);
    const c = await candidate(a, 'pat@example.com');
    const r = await request(app()).post(`/careers/${slug}/apply`).send({
      firstName: 'Pat', lastName: 'Hopeful', email: 'pat@example.com',
    });
    expect(r.body.alreadyApplied).toBe(true);
    const events = (await a.get(`/recruiting/candidates/${c.id}/events`)).body.events;
    expect(events[0]).toMatchObject({ kind: 'APPLIED_AGAIN', body: 'Overnight Stocker' });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
  });

  it('a bot tripping the honeypot gets no email', async () => {
    const { a } = await recruiter();
    const slug = await openPosting(a);
    await request(app()).post(`/careers/${slug}/apply`).send({
      firstName: 'B', lastName: 'Ot', email: 'bot@example.com', website: 'http://spam.example',
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(sent).toHaveLength(0);
  });
});
