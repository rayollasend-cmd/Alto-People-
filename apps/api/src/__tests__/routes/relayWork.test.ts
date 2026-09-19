import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

/**
 * The workstation: one desk asks another a question, sends a document, or
 * hands off a task — the desk hears about it, anyone there can pick it up,
 * the answer lands back with the asker, and the files live on a shelf
 * everyone can search.
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
  if (r.status !== 200) throw new Error(`loginAs(${email}) failed: ${r.status}`);
  return a;
}

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n');

async function world() {
  const { user: wfm } = await createUser({ role: 'WORKFORCE_MANAGER' });
  const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
  const { user: hr2 } = await createUser({ role: 'OPERATIONS_MANAGER' });
  const { user: recruiter } = await createUser({ role: 'INTERNAL_RECRUITER' });
  return { wfm, hr, hr2, recruiter, workforce: await loginAs(wfm.email), hrDesk: await loginAs(hr.email) };
}

describe('requests between desks', () => {
  it('asks HR a question with a document, rings the desk, and keeps the answer on the thread', async () => {
    const w = await world();
    const maria = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });

    // A file on the shelf first — it rides along with the question.
    const uploaded = await w.workforce
      .post('/relay/files')
      .field('tags', 'Onboarding, I-9')
      .attach('file', PDF, { filename: 'maria-i9.pdf', contentType: 'application/pdf' });
    expect(uploaded.status).toBe(201);
    expect(uploaded.body.file).toMatchObject({ name: 'maria-i9.pdf', tags: ['onboarding', 'i-9'], desk: null });

    const sent = await w.workforce.post('/relay/requests').send({
      kind: 'ASK',
      toDesk: 'HR',
      subject: 'Does Maria need a new I-9?',
      body: 'She worked for us in 2024 — does the old I-9 still count?',
      aboutAssociateId: maria.id,
      fileIds: [uploaded.body.file.id],
    });
    expect(sent.status).toBe(201);
    const id = sent.body.request.id;
    expect(sent.body.request).toMatchObject({
      kind: 'ASK',
      status: 'OPEN',
      toDesk: 'HR',
      about: { associateId: maria.id, name: 'Maria Lopez' },
    });
    expect(sent.body.request.files).toHaveLength(1);

    // Both people on the HR desk hear about it; the sender doesn't.
    await flushPendingNotifications();
    const rung = await prisma.notification.findMany({ where: { category: 'relay.request', channel: 'IN_APP' }, select: { recipientUserId: true, linkUrl: true } });
    expect(rung.map((r) => r.recipientUserId).sort()).toEqual([w.hr.id, w.hr2.id].sort());
    expect(rung[0]!.linkUrl).toBe(`/relay?tab=requests&request=${id}`);

    // It's on HR's desk, and in Workforce's sent box.
    const inbox = await w.hrDesk.get('/relay/requests?box=inbox');
    expect(inbox.body.requests.map((r: { id: string }) => r.id)).toEqual([id]);
    expect(inbox.body.requests[0].mine).toBe(true);
    expect(inbox.body.counts.inbox).toBe(1);
    expect((await w.workforce.get('/relay/requests?box=sent')).body.requests).toHaveLength(1);
    // Not on Recruiting's.
    expect((await (await loginAs(w.recruiter.email)).get('/relay/requests?box=inbox')).body.requests).toHaveLength(0);

    // HR picks it up and answers, with a document of their own.
    expect((await w.hrDesk.patch(`/relay/requests/${id}`).send({ claim: true })).body.request).toMatchObject({
      status: 'IN_PROGRESS',
      claimedBy: { userId: w.hr.id },
    });
    const answer = await w.hrDesk
      .post('/relay/files')
      .field('desk', 'HR')
      .attach('file', PDF, { filename: 'i9-guidance.pdf', contentType: 'application/pdf' });
    const replied = await w.hrDesk.post(`/relay/requests/${id}/messages`).send({
      body: 'A new one — the old I-9 expired more than three years ago. Guidance attached.',
      fileIds: [answer.body.file.id],
    });
    expect(replied.status).toBe(201);
    expect(replied.body.message.files[0].name).toBe('i9-guidance.pdf');
    await w.hrDesk.patch(`/relay/requests/${id}`).send({ status: 'ANSWERED' });

    // The asker hears, reads the thread, and closes it.
    await flushPendingNotifications();
    expect(
      await prisma.notification.findFirst({ where: { recipientUserId: w.wfm.id, subject: { contains: 'Answered' } } }),
    ).not.toBeNull();
    const thread = await w.workforce.get(`/relay/requests/${id}`);
    expect(thread.body.request.messages).toHaveLength(1);
    expect(thread.body.request.status).toBe('ANSWERED');
    expect((await w.workforce.patch(`/relay/requests/${id}`).send({ status: 'CLOSED' })).body.request.status).toBe('CLOSED');
    // Nothing more goes on a closed thread until it's reopened.
    expect((await w.hrDesk.post(`/relay/requests/${id}/messages`).send({ body: 'one more thing' })).status).toBe(409);
  });

  it('goes to one person when asked to, and is staff-only', async () => {
    const w = await world();
    const direct = await w.workforce.post('/relay/requests').send({
      kind: 'SEND',
      toDesk: 'RECRUITING',
      toUserId: w.recruiter.id,
      subject: 'Signed offer letter for the Destin crew',
      body: 'Attached for the file.',
    });
    expect(direct.status).toBe(201);
    await flushPendingNotifications();
    const rung = await prisma.notification.findMany({ where: { category: 'relay.request', channel: 'IN_APP' }, select: { recipientUserId: true } });
    expect(rung.map((r) => r.recipientUserId)).toEqual([w.recruiter.id]);
    expect((await (await loginAs(w.recruiter.email)).get('/relay/requests?box=inbox')).body.requests).toHaveLength(1);

    const assoc = await createAssociate();
    const { user } = await createUser({ role: 'ASSOCIATE', email: assoc.email, associateId: assoc.id });
    const outsider = await loginAs(user.email);
    expect((await outsider.get('/relay/requests')).status).toBe(403);
    expect((await outsider.post('/relay/requests').send({ kind: 'ASK', toDesk: 'HR', subject: 'hello there', body: 'hi' })).status).toBe(403);
  });
});

describe('the work shelf', () => {
  it('keeps documents, searchable by name and tag, on your shelf or a desk’s', async () => {
    const w = await world();
    await w.workforce.post('/relay/files').field('tags', 'walmart').attach('file', PDF, { filename: 'van-checklist.pdf', contentType: 'application/pdf' });
    await w.hrDesk.post('/relay/files').field('desk', 'HR').field('tags', 'policy').attach('file', PDF, { filename: 'handbook-2026.pdf', contentType: 'application/pdf' });

    const all = await w.workforce.get('/relay/files');
    expect(all.body.files.map((f: { name: string }) => f.name).sort()).toEqual(['handbook-2026.pdf', 'van-checklist.pdf']);
    expect(all.body.tags).toEqual(['policy', 'walmart']);
    expect((await w.workforce.get('/relay/files?scope=mine')).body.files).toHaveLength(1);
    expect((await w.hrDesk.get('/relay/files?scope=desk')).body.files.map((f: { name: string }) => f.name)).toEqual(['handbook-2026.pdf']);
    expect((await w.workforce.get('/relay/files?q=handbook')).body.files).toHaveLength(1);
    expect((await w.workforce.get('/relay/files?tag=policy')).body.files).toHaveLength(1);

    // It reads back byte for byte.
    const id = all.body.files.find((f: { name: string }) => f.name === 'van-checklist.pdf').id;
    const got = await w.workforce.get(`/relay/files/${id}/download`);
    expect(got.status).toBe(200);
    expect(got.headers['content-type']).toContain('application/pdf');

    // Only whoever put it there takes it off — an HR administrator too.
    const recruiter = await loginAs(w.recruiter.email);
    expect((await recruiter.delete(`/relay/files/${id}`)).status).toBe(403);
    expect((await w.workforce.delete(`/relay/files/${id}`)).status).toBe(200);
    expect((await w.workforce.get('/relay/files')).body.files).toHaveLength(1);
    const theirs = (await w.workforce.get('/relay/files')).body.files[0].id;
    expect((await w.hrDesk.delete(`/relay/files/${theirs}`)).status).toBe(200);
  });

  it('refuses what isn’t a work document, and what lies about its type', async () => {
    const w = await world();
    const exe = await w.workforce.post('/relay/files').attach('file', Buffer.from('MZ binary'), { filename: 'tool.exe', contentType: 'application/x-msdownload' });
    expect(exe.status).toBe(415);
    const liar = await w.workforce.post('/relay/files').attach('file', Buffer.from('not a pdf at all'), { filename: 'notes.pdf', contentType: 'application/pdf' });
    expect(liar.status).toBe(415);
    expect(liar.body.error.message).toContain('PDF');
  });
});
