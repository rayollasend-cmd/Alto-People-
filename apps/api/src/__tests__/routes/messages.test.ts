import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

/**
 * The messenger: who may message whom is a rule; every store gets a
 * channel; messages are immutable and reach people; nothing crosses a
 * tenant; associates are never in it.
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
  if (r.status !== 200) throw new Error(`loginAs failed: ${r.status}`);
  return a;
}

async function seed() {
  const clientA = await createClient('Walmart 218');
  const clientB = await createClient('Target 9');
  const dana = await createAssociate({ firstName: 'Dana', lastName: 'Reyes' });
  const { user: manager } = await createUser({ role: 'CLIENT_PORTAL', clientId: clientA.id });
  const { user: supervisor } = await createUser({
    role: 'SHIFT_SUPERVISOR',
    clientId: clientA.id,
    associateId: dana.id,
  });
  const { user: otherSupervisor } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: clientB.id });
  const { user: otherManager } = await createUser({ role: 'CLIENT_PORTAL', clientId: clientB.id });
  const { user: wfm } = await createUser({ role: 'WORKFORCE_MANAGER' });
  const assoc = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
  const { user: associate } = await createUser({ role: 'ASSOCIATE', associateId: assoc.id, email: assoc.email });
  return { clientA, clientB, manager, supervisor, otherSupervisor, otherManager, wfm, associate };
}

describe('store channel membership', () => {
  it('reaches a manager invited after the channel existed and drops one who moved', async () => {
    const s = await seed();
    const manager = await loginAs(s.manager.email);
    const inbox = await manager.get('/messages/conversations');
    const channel = inbox.body.conversations.find((c: { kind: string }) => c.kind === 'STORE_CHANNEL');
    expect(channel).toBeTruthy();

    // A second manager is added; they have never opened Messages.
    const { user: newManager } = await createUser({ role: 'CLIENT_PORTAL', clientId: s.clientA.id });
    const sup = await loginAs(s.supervisor.email);
    expect((await sup.post(`/messages/conversations/${channel.id}/messages`).send({ body: 'Truck at 5am.' })).status).toBe(201);
    await flushPendingNotifications();
    expect(await prisma.notification.count({ where: { recipientUserId: newManager.id, category: 'message', channel: 'IN_APP' } })).toBe(1);

    // The first manager moves to another client: the next message skips
    // them and they are no longer in the channel.
    await prisma.user.update({ where: { id: s.manager.id }, data: { clientId: s.clientB.id } });
    const before = await prisma.notification.count({ where: { recipientUserId: s.manager.id, category: 'message', channel: 'IN_APP' } });
    expect((await sup.post(`/messages/conversations/${channel.id}/messages`).send({ body: 'Truck moved to 6am.' })).status).toBe(201);
    await flushPendingNotifications();
    expect(await prisma.notification.count({ where: { recipientUserId: s.manager.id, category: 'message', channel: 'IN_APP' } })).toBe(before);
    expect(await prisma.conversationParticipant.count({ where: { conversationId: channel.id, userId: s.manager.id } })).toBe(0);
  });
});

describe('messages', () => {
  it('lets the store manager text their supervisor, keeps the record, and reaches the desk', async () => {
    const s = await seed();
    const manager = await loginAs(s.manager.email);

    // The directory offers only people the manager may reach: their own
    // supervisor and the desks — never the other client's people, never
    // an associate.
    const dir = await manager.get('/messages/directory');
    expect(dir.status).toBe(200);
    const ids = dir.body.people.map((p: { id: string }) => p.id);
    expect(ids).toContain(s.supervisor.id);
    expect(ids).toContain(s.wfm.id);
    expect(ids).not.toContain(s.otherSupervisor.id);
    expect(ids).not.toContain(s.otherManager.id);
    expect(ids).not.toContain(s.associate.id);
    expect(dir.body.people.find((p: { id: string }) => p.id === s.supervisor.id).name).toBe('Dana Reyes');

    // Opening the inbox creates the store channel with both of them in it.
    const inbox = await manager.get('/messages/conversations');
    expect(inbox.status).toBe(200);
    const channel = inbox.body.conversations.find((c: { kind: string }) => c.kind === 'STORE_CHANNEL');
    expect(channel).toBeTruthy();
    expect(channel.title).toBe('Walmart 218');
    expect(channel.participants.map((p: { id: string }) => p.id).sort()).toEqual(
      [s.manager.id, s.supervisor.id].sort(),
    );

    // A direct thread, with the first message in the same call.
    const started = await manager
      .post('/messages/conversations')
      .send({ participantIds: [s.supervisor.id], body: 'Can you cover the 6am wave tomorrow?' });
    expect(started.status).toBe(201);
    const threadId = started.body.id as string;
    // Starting it again reuses the same thread.
    const again = await manager.post('/messages/conversations').send({ participantIds: [s.supervisor.id] });
    expect(again.body.id).toBe(threadId);

    // The supervisor is told (bell + email) and sees it unread.
    await flushPendingNotifications();
    const bell = await prisma.notification.findFirst({
      where: { recipientUserId: s.supervisor.id, category: 'message', channel: 'IN_APP' },
    });
    expect(bell?.linkUrl).toBe(`/messages/${threadId}`);
    expect(bell?.body).toContain('Can you cover');
    const sup = await loginAs(s.supervisor.email);
    expect((await sup.get('/messages/unread')).body.unread).toBe(1);

    // Reading it clears the count; replying appends to the record.
    const thread = await sup.get(`/messages/conversations/${threadId}`);
    expect(thread.status).toBe(200);
    expect(thread.body.kind).toBe('DIRECT');
    expect(thread.body.messages).toHaveLength(1);
    expect(thread.body.messages[0].mine).toBe(false);
    expect((await sup.get('/messages/unread')).body.unread).toBe(0);
    const reply = await sup.post(`/messages/conversations/${threadId}/messages`).send({ body: 'Yes — Ben and I will be there at 5:45.' });
    expect(reply.status).toBe(201);
    expect((await manager.get('/messages/unread')).body.unread).toBe(1);

    // The manager sees "Seen" up to their message once the supervisor read it.
    const mine = await manager.get(`/messages/conversations/${threadId}`);
    expect(mine.body.messages).toHaveLength(2);
    expect(mine.body.seenUpTo).toBeTruthy();

    // Search and the transcript cover the whole thread.
    const found = await manager.get('/messages/search?q=6am');
    expect(found.body.results.map((r: { conversationId: string }) => r.conversationId)).toContain(threadId);
    const csv = await manager.get(`/messages/conversations/${threadId}/transcript.csv`);
    expect(csv.status).toBe(200);
    expect(csv.text).toContain('Can you cover the 6am wave tomorrow?');
    expect(csv.text).toContain('Dana Reyes');
    expect(csv.text).toContain('Shift Supervisor');

    // Immutable: there is no edit or delete route.
    expect((await manager.patch(`/messages/conversations/${threadId}/messages/x`).send({ body: 'edited' })).status).toBe(404);
    expect((await manager.delete(`/messages/conversations/${threadId}`)).status).toBe(404);
  });

  it('never crosses a tenant and never reaches an associate', async () => {
    const s = await seed();
    const manager = await loginAs(s.manager.email);

    // Another client's supervisor and portal account are unreachable.
    expect(
      (await manager.post('/messages/conversations').send({ participantIds: [s.otherSupervisor.id] })).status,
    ).toBe(403);
    expect(
      (await manager.post('/messages/conversations').send({ participantIds: [s.otherManager.id] })).status,
    ).toBe(403);
    // An associate is unreachable, and can't use the messenger at all.
    expect((await manager.post('/messages/conversations').send({ participantIds: [s.associate.id] })).status).toBe(403);
    const assoc = await loginAs(s.associate.email);
    expect((await assoc.get('/messages/conversations')).status).toBe(403);
    expect((await assoc.get('/messages/directory')).status).toBe(403);

    // A thread from another tenant is simply not found — read, post, transcript.
    const other = await loginAs(s.otherManager.email);
    const theirs = await other
      .post('/messages/conversations')
      .send({ participantIds: [s.otherSupervisor.id], body: 'private' });
    const theirId = theirs.body.id as string;
    expect((await manager.get(`/messages/conversations/${theirId}`)).status).toBe(404);
    expect((await manager.post(`/messages/conversations/${theirId}/messages`).send({ body: 'hi' })).status).toBe(404);
    expect((await manager.get(`/messages/conversations/${theirId}/transcript.csv`)).status).toBe(404);
    expect((await manager.get('/messages/search?q=private')).body.results).toHaveLength(0);
    // Their store channel is theirs alone.
    const inbox = await manager.get('/messages/conversations');
    expect(JSON.stringify(inbox.body)).not.toContain('Target 9');

    // The Workforce desk reaches everyone; a supervisor reaches their own
    // store's manager but not the other client's.
    const wfm = await loginAs(s.wfm.email);
    expect((await wfm.post('/messages/conversations').send({ participantIds: [s.manager.id, s.supervisor.id], title: 'Friday plan' })).status).toBe(201);
    const sup = await loginAs(s.supervisor.email);
    expect((await sup.post('/messages/conversations').send({ participantIds: [s.manager.id] })).status).toBe(201);
    expect((await sup.post('/messages/conversations').send({ participantIds: [s.otherManager.id] })).status).toBe(403);
  });
});


describe('long messages', () => {
  // Every message over ~150 characters — two or three sentences — failed
  // with a 500: the inbox preview is the sender's name and the text in a
  // 160-character column, and only the text was cut to 160.
  it('sends two or three sentences, and a full 4,000 characters', async () => {
    const s = await seed();
    const { user: longName } = await createUser({ role: 'WORKFORCE_MANAGER', email: 'maximiliana.featherstonehaugh-montgomery@example.com' });
    const sup = await loginAs(s.supervisor.email);
    const wfm = await loginAs(longName.email);
    const start = await wfm.post('/messages/conversations').send({ participantIds: [s.supervisor.id] });
    expect(start.status).toBe(201);
    const id = start.body.id as string;

    const three =
      'Good morning. The deli cooler was reading 44 degrees when I opened, so I moved the milk to the back cooler. ' +
      'Can someone from maintenance check it before the afternoon delivery arrives?';
    expect(three.length).toBeGreaterThan(160);
    expect((await wfm.post(`/messages/conversations/${id}/messages`).send({ body: three })).status).toBe(201);
    const max = 'All good here. '.repeat(267).slice(0, 4000);
    expect((await sup.post(`/messages/conversations/${id}/messages`).send({ body: max })).status).toBe(201);
    // Past the limit is a clear 400, not a crash.
    expect((await sup.post(`/messages/conversations/${id}/messages`).send({ body: `${max}!` })).status).toBe(400);

    const thread = (await sup.get(`/messages/conversations/${id}`)).body;
    expect(thread.messages.map((m: { body: string }) => m.body)).toEqual([three, max]);
    // The inbox preview is cut to fit, and says so.
    const row = await prisma.conversation.findUniqueOrThrow({ where: { id } });
    expect(Array.from(row.lastPreview!).length).toBeLessThanOrEqual(160);
    expect(row.lastPreview!.endsWith('…')).toBe(true);
  });

  it('never splits an emoji when cutting the preview', async () => {
    const s = await seed();
    const sup = await loginAs(s.supervisor.email);
    const start = await sup.post('/messages/conversations').send({ participantIds: [s.manager.id], body: '🙂'.repeat(300) });
    expect(start.status).toBe(201);
    const row = await prisma.conversation.findUniqueOrThrow({ where: { id: start.body.id } });
    expect(row.lastPreview).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it('a group whose first message fails is not left behind', async () => {
    const s = await seed();
    const wfm = await loginAs(s.wfm.email);
    // A first message over the limit is refused before anything is made.
    const r = await wfm.post('/messages/conversations').send({ participantIds: [s.supervisor.id, s.manager.id], body: 'x'.repeat(4001) });
    expect(r.status).toBe(400);
    expect(await prisma.conversation.count({ where: { kind: 'GROUP' } })).toBe(0);
    // And a long one that fits goes through, once.
    const ok = await wfm.post('/messages/conversations').send({ participantIds: [s.supervisor.id, s.manager.id], title: 'Weekend', body: 'Three sentences here. '.repeat(10) });
    expect(ok.status).toBe(201);
    expect(await prisma.conversation.count({ where: { kind: 'GROUP' } })).toBe(1);
  });
});
