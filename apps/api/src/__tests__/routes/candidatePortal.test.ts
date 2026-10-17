import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';

// The link goes out by email and text; capture what was sent.
const sent = vi.hoisted(() => [] as Array<{ channel: string; to: string | null; body: string }>);
vi.mock('../../lib/notifications.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/notifications.js')>();
  return {
    ...real,
    send: vi.fn(async (input: Parameters<typeof real.send>[0]) => {
      sent.push({ channel: input.channel, to: input.recipient.email ?? input.recipient.phone, body: input.body });
      return { externalRef: 'test', status: 'SENT' as const };
    }),
  };
});

import { createApp } from '../../app.js';
import { DEFAULT_TEST_PASSWORD, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * The candidate's own page: a signed link to their stage, interview and the
 * documents we asked for — and the recruiter's calendar feed.
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
  if (r.status !== 200) throw new Error(`login failed: ${r.status}`);
  return a;
}

/** The raw token is only in what was sent; pull it out of the link. */
function tokenFromSent(): string {
  const m = sent.map((s) => s.body).join('\n').match(/\/candidate\/([A-Za-z0-9_-]+)/g);
  if (!m) throw new Error('no link sent');
  return m[m.length - 1]!.split('/candidate/')[1]!;
}

async function setup() {
  const { user: rec } = await createUser({ role: 'INTERNAL_RECRUITER' });
  const a = await loginAs(rec.email);
  const c = await a.post('/recruiting/candidates').send({
    firstName: 'Kim', lastName: 'Phan', email: 'kim.phan@example.com', phone: '+18505550101', position: 'Cashier',
  });
  return { a, rec, candidateId: c.body.id as string };
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);

describe('the candidate page', () => {
  it('a link by email and text opens their stage and interview; they confirm; a stale link is refused', async () => {
    const { a, rec, candidateId } = await setup();
    const at = new Date(Date.now() + 2 * 86_400_000);
    const iv = await a.post('/interviews').send({ candidateId, interviewerUserId: rec.id, scheduledFor: at.toISOString(), location: 'Destin #1234', notify: false });
    expect(iv.status).toBe(201);

    const link = await a.post(`/recruiting/candidates/${candidateId}/portal-link`);
    expect(link.status).toBe(200);
    expect(link.body).toMatchObject({ emailed: true, texted: true });
    expect(sent.some((s) => s.channel === 'SMS')).toBe(true);
    const token = tokenFromSent();
    // Only the hash is stored.
    const row = await prisma.candidate.findUniqueOrThrow({ where: { id: candidateId } });
    expect(row.portalTokenHash).not.toBe(token);

    const page = await request(app()).get(`/candidate-portal/${token}`);
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ firstName: 'Kim', position: 'Cashier', stage: 'APPLIED', stageLabel: 'Application received' });
    expect(page.body.interviews).toHaveLength(1);
    expect(page.body.interviews[0].location).toBe('Destin #1234');

    const ok = await request(app()).post(`/candidate-portal/${token}/interviews/${iv.body.id}/confirm`);
    expect(ok.status).toBe(200);
    expect((await prisma.interview.findUniqueOrThrow({ where: { id: iv.body.id } })).candidateConfirmedAt).not.toBeNull();
    expect(await prisma.candidateEvent.count({ where: { candidateId, kind: 'INTERVIEW_CONFIRMED' } })).toBe(1);

    // A new link retires the old one.
    await a.post(`/recruiting/candidates/${candidateId}/portal-link`);
    expect((await request(app()).get(`/candidate-portal/${token}`)).status).toBe(404);
    expect((await request(app()).get('/candidate-portal/not-a-real-token')).status).toBe(404);
  });

  it('a document asked for is uploaded on the page and reviewed by the recruiter; a rejection asks again', async () => {
    const { a, candidateId } = await setup();
    const asked = await a.post(`/recruiting/candidates/${candidateId}/document-requests`).send({ label: "Driver's licence" });
    expect(asked.status).toBe(201);
    const requestId = asked.body.request.id as string;
    const token = tokenFromSent();

    const before = await request(app()).get(`/candidate-portal/${token}`);
    expect(before.body.documents).toEqual([expect.objectContaining({ label: "Driver's licence", status: 'REQUESTED' })]);

    // Nothing to review before an upload.
    expect((await a.post(`/recruiting/document-requests/${requestId}/review`).send({ decision: 'ACCEPT' })).status).toBe(409);

    const up = await request(app()).post(`/candidate-portal/${token}/documents/${requestId}`).attach('file', PNG, { filename: 'licence.png', contentType: 'image/png' });
    expect(up.status).toBe(201);
    expect(up.body.status).toBe('UPLOADED');
    // A file that lies about its type is refused.
    const fake = await request(app()).post(`/candidate-portal/${token}/documents/${requestId}`).attach('file', Buffer.from('not a png at all'), { filename: 'x.png', contentType: 'image/png' });
    expect(fake.status).toBe(400);

    const file = await a.get(`/recruiting/document-requests/${requestId}/file`);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toContain('image/png');

    sent.length = 0;
    const rej = await a.post(`/recruiting/document-requests/${requestId}/review`).send({ decision: 'REJECT', note: 'Blurry — retake it.' });
    expect(rej.status).toBe(200);
    expect(rej.body.request.status).toBe('REJECTED');
    // Asked again, on a fresh link, with the reason on their page.
    const again = tokenFromSent();
    const page = await request(app()).get(`/candidate-portal/${again}`);
    expect(page.body.documents[0]).toMatchObject({ status: 'REJECTED', reviewNote: 'Blurry — retake it.' });

    await request(app()).post(`/candidate-portal/${again}/documents/${requestId}`).attach('file', PNG, { filename: 'licence2.png', contentType: 'image/png' });
    const acc = await a.post(`/recruiting/document-requests/${requestId}/review`).send({ decision: 'ACCEPT' });
    expect(acc.body.request.status).toBe('ACCEPTED');
    expect(await prisma.candidateEvent.count({ where: { candidateId, kind: { in: ['DOCUMENT_REQUESTED', 'DOCUMENT_UPLOADED', 'DOCUMENT_REVIEWED'] } } })).toBeGreaterThanOrEqual(5);
  });

  it('only recruiting can send links or ask for documents', async () => {
    const { candidateId } = await setup();
    const { user } = await createUser({ role: 'ASSOCIATE' });
    const assoc = await loginAs(user.email);
    expect((await assoc.post(`/recruiting/candidates/${candidateId}/portal-link`)).status).toBe(403);
    expect((await assoc.post(`/recruiting/candidates/${candidateId}/document-requests`).send({ label: 'X' })).status).toBe(403);
  });
});

describe("the recruiter's calendar feed", () => {
  it('a feed URL any calendar subscribes to, with every interview; rotating retires the old one', async () => {
    const { a, rec, candidateId } = await setup();
    await a.post('/interviews').send({ candidateId, interviewerUserId: rec.id, scheduledFor: new Date(Date.now() + 86_400_000).toISOString(), notify: false });
    const r = await a.get('/recruiting/me/calendar-url');
    expect(r.status).toBe(200);
    expect(r.body.webcalUrl).toMatch(/^webcal:\/\//);
    const path = new URL(r.body.url).pathname.replace(/^\/api/, '');
    const ics = await request(app()).get(path);
    expect(ics.status).toBe(200);
    expect(ics.headers['content-type']).toContain('text/calendar');
    expect(ics.text).toContain('Interview: Kim Phan (Cashier)');
    // The same UID the emailed invite carries.
    expect(ics.text).toMatch(/UID:interview-[0-9a-f-]+@alto-people/);

    await a.post('/recruiting/me/calendar-url/rotate');
    expect((await request(app()).get(path)).status).toBe(404);
  });
});
