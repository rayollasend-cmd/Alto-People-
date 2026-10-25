import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { ensureBuiltInAgents } from '../../lib/agents.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

/**
 * Without a model key the registry answers alone — and even then, a
 * question it cannot answer is never passed to a person behind the
 * associate's back: it is OFFERED, and sent only on their confirmation.
 */

const app = () => createApp();

beforeEach(async () => {
  await truncateAll();
  // The assistant is an agent too: its registry record must exist (owned by
  // the tenant's oldest admin, so an admin comes first), or it is "switched off".
  await createUser({ role: 'HR_ADMINISTRATOR', email: 'owner@example.com' });
  await ensureBuiltInAgents(prisma, ALTO_TENANT_ID);
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

describe('the assistant without a model', () => {
  it('says it answers from the registry, takes the page along, and offers — not performs — a hand-off', async () => {
    const client = await createClient('Walmart 1234');
    const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Lopez' });
    await prisma.application.create({ data: { associateId: ana.id, clientId: client.id, onboardingTrack: 'STANDARD', status: 'APPROVED', approvedAt: new Date() } });
    await prisma.associateAssignment.create({ data: { associateId: ana.id, locationId: site.id, startedAt: new Date() } });
    const dana = await createAssociate({ firstName: 'Dana', lastName: 'Reyes' });
    await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id, associateId: dana.id });
    const { user } = await createUser({ role: 'ASSOCIATE', associateId: ana.id });
    const agent = await loginAs(user.email);

    const me = await agent.get('/hugo');
    expect(me.status).toBe(200);
    expect(me.body.model).toBe(false);

    const asked = await agent
      .post('/hugo/ask')
      .send({ text: 'my badge broke', page: { path: '/me', title: 'Me' }, history: [{ role: 'user', text: 'hi' }] });
    expect(asked.status).toBe(200);
    expect(asked.body.intent).toBe('HANDOFF');
    expect(asked.body.source).toBe('rules');
    expect(asked.body.reply).toContain('Dana Reyes');
    expect(asked.body.handoff).toEqual({ summary: 'my badge broke', who: 'Dana Reyes' });
    // Nothing was sent.
    expect(await prisma.conversation.count()).toBe(0);

    const sent = await agent.post('/hugo/handoff').send({ text: 'my badge broke' });
    expect(sent.status).toBe(200);
    expect(sent.body.sent).toBe(true);
    expect(await prisma.conversation.count()).toBe(1);
  });

  it('someone on no pay schedule is told so and offered a person — not told it was "passed on"', async () => {
    const client = await createClient('Walmart 1234');
    const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Lopez' });
    await prisma.application.create({ data: { associateId: ana.id, clientId: client.id, onboardingTrack: 'STANDARD', status: 'APPROVED', approvedAt: new Date() } });
    await prisma.associateAssignment.create({ data: { associateId: ana.id, locationId: site.id, startedAt: new Date() } });
    const dana = await createAssociate({ firstName: 'Dana', lastName: 'Reyes' });
    await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id, associateId: dana.id });
    const { user } = await createUser({ role: 'ASSOCIATE', associateId: ana.id });
    const agent = await loginAs(user.email);

    const asked = await agent.post('/hugo/ask').send({ text: 'when is my next payday?' });
    expect(asked.status).toBe(200);
    expect(asked.body.intent).toBe('PAYDAY');
    expect(asked.body.reply).toBe('There is no pay schedule on your record yet. Want me to pass it to Dana Reyes?');
    expect(asked.body.reply).not.toMatch(/passed/i);
    expect(asked.body.handoff).toEqual({ summary: 'There is no pay schedule on my record. When is my next payday?', who: 'Dana Reyes' });
    expect(await prisma.conversation.count()).toBe(0);
  });

  it('a hand-off that reaches nobody says so instead of "I have passed this"', async () => {
    // Placed nowhere: there is no supervisor to pass it to.
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Lopez' });
    const { user } = await createUser({ role: 'ASSOCIATE', associateId: ana.id });
    const agent = await loginAs(user.email);
    const sent = await agent.post('/hugo/handoff').send({ text: 'my badge broke' });
    expect(sent.status).toBe(200);
    expect(sent.body.sent).toBe(false);
    expect(sent.body.reply).toMatch(/^I couldn't reach your .+ from here\. Please ask them in person\.$/);
    expect(sent.body.reply).not.toMatch(/passed/i);
    expect(await prisma.conversation.count()).toBe(0);
  });

  it('a staff account gets no hand-off offer', async () => {
    const agent = await loginAs('owner@example.com');
    const asked = await agent.post('/hugo/ask').send({ text: 'tell me a joke' });
    expect(asked.status).toBe(200);
    expect(asked.body.handoff).toBeNull();
    expect((await agent.post('/hugo/handoff').send({ text: 'x' })).status).toBe(403);
  });
});
