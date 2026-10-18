import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';

/**
 * The assistant, acting safely: a propose_* tool changes nothing and sets
 * up a card; only the person's Confirm runs it — once, as them, through the
 * product's own route. A token is useless to anyone else, after it expires,
 * or a second time. The model is scripted here (no SDK call).
 */

const script = vi.hoisted(() => ({ steps: [] as Array<{ name: string; args?: Record<string, unknown> }> }));
vi.mock('../../lib/assistantModel.js', async (orig) => {
  const real = await orig<typeof import('../../lib/assistantModel.js')>();
  return {
    ...real,
    modelAvailable: () => true,
    answerWithModel: vi.fn(async ({ tools }: { tools: Array<{ key: string; name: string; run: (a?: Record<string, unknown>) => Promise<{ reply: string; linkUrl: string | null }> }> }) => {
      let reply = '';
      const used: string[] = [];
      for (const step of script.steps) {
        const t = tools.find((x) => x.name === step.name);
        if (!t) {
          reply = `no tool ${step.name}`;
          continue;
        }
        used.push(t.key);
        reply = (await t.run(step.args ?? {})).reply;
      }
      return { reply, linkUrl: null, toolsUsed: used, handoff: null };
    }),
  };
});

import { createApp } from '../../app.js';
import { ensureBuiltInAgents } from '../../lib/agents.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

const app = () => createApp();
const H = 3_600_000;

beforeEach(async () => {
  await truncateAll();
  script.steps = [];
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

async function world() {
  const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'hr@example.com' });
  await ensureBuiltInAgents(prisma, ALTO_TENANT_ID);
  const client = await createClient('Coastal');
  const store = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  const ana = await createAssociate({ firstName: 'Ana', lastName: 'Lopez' });
  await prisma.associateAssignment.create({ data: { associateId: ana.id, locationId: store.id, startedAt: new Date(Date.now() - 30 * 24 * H) } });
  const { user: anaUser } = await createUser({ role: 'ASSOCIATE', associateId: ana.id, email: 'ana@example.com' });
  await prisma.timeOffBalance.create({ data: { associateId: ana.id, category: 'OTHER', balanceMinutes: 2400 } });
  const req = await prisma.timeOffRequest.create({
    data: { associateId: ana.id, category: 'OTHER', startDate: new Date('2026-12-01'), endDate: new Date('2026-12-02'), requestedMinutes: 960, status: 'PENDING' },
  });
  return { hr, client, store, ana, anaUser, req };
}

describe('proposing, then confirming', () => {
  it('a proposal changes nothing; Confirm runs it once, as the person', async () => {
    const w = await world();
    const hr = await loginAs(w.hr.email);
    script.steps = [{ name: 'find_pending_time_off' }, { name: 'propose_time_off_decision', args: { requestId: w.req.id, decision: 'approve', note: 'Enjoy' } }];
    const asked = await hr.post('/hugo/ask').send({ text: 'approve Ana’s time off' });
    expect(asked.status).toBe(200);
    expect(asked.body.actions).toHaveLength(1);
    const card = asked.body.actions[0];
    expect(card).toMatchObject({ kind: 'time_off.decide', confirmLabel: 'Approve' });
    expect(card.title).toMatch(/Approve Ana Lopez’s time off, Dec 1 – Dec 2/);
    expect((await prisma.timeOffRequest.findUniqueOrThrow({ where: { id: w.req.id } })).status).toBe('PENDING');

    // Someone else holding the token gets nothing.
    const { user: other } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'other@example.com' });
    expect((await (await loginAs(other.email)).post('/hugo/confirm').send({ token: card.token })).status).toBe(404);

    const done = await hr.post('/hugo/confirm').send({ token: card.token });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: 'done', linkUrl: '/time-off' });
    expect((await prisma.timeOffRequest.findUniqueOrThrow({ where: { id: w.req.id } })).status).toBe('APPROVED');
    // The route's own decision is the person's; the assistant adds its own trail.
    expect((await prisma.timeOffRequest.findUniqueOrThrow({ where: { id: w.req.id } })).reviewerUserId).toBe(w.hr.id);

    // Once only.
    expect((await hr.post('/hugo/confirm').send({ token: card.token })).status).toBe(409);
  });

  it('cancel, expiry and a tampered token all leave things as they were', async () => {
    const w = await world();
    const hr = await loginAs(w.hr.email);
    script.steps = [{ name: 'propose_time_off_decision', args: { requestId: w.req.id, decision: 'deny' } }];
    const a = (await hr.post('/hugo/ask').send({ text: 'deny it' })).body.actions[0];
    expect((await hr.post('/hugo/confirm').send({ token: a.token, decision: 'cancel' })).body.status).toBe('cancelled');
    expect((await hr.post('/hugo/confirm').send({ token: a.token })).status).toBe(409);

    const b = (await hr.post('/hugo/ask').send({ text: 'deny it' })).body.actions[0];
    expect((await hr.post('/hugo/confirm').send({ token: `${b.token.split('.')[0]}.forged` })).status).toBe(400);
    await prisma.assistantAction.update({ where: { id: b.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    // The signature covers the expiry: an edited expiry no longer verifies either way.
    expect([400, 409]).toContain((await hr.post('/hugo/confirm').send({ token: b.token })).status);
    expect((await prisma.timeOffRequest.findUniqueOrThrow({ where: { id: w.req.id } })).status).toBe('PENDING');
  });

  it('can only name what is in the person’s own list', async () => {
    const w = await world();
    const hr = await loginAs(w.hr.email);
    script.steps = [{ name: 'propose_time_off_decision', args: { requestId: '00000000-0000-4000-8000-0000000000aa', decision: 'approve' } }];
    const r = await hr.post('/hugo/ask').send({ text: 'approve that one' });
    expect(r.body.actions).toEqual([]);
    expect(r.body.reply).toMatch(/isn’t in their pending list/);
    expect(w.req.status).toBe('PENDING');
  });
});

describe('when the route says no', () => {
  it('the route’s own refusal comes back as the card’s result, and nothing changes', async () => {
    const w = await world();
    await prisma.timeOffBalance.updateMany({ where: { associateId: w.ana.id }, data: { balanceMinutes: 0 } });
    const hr = await loginAs(w.hr.email);
    script.steps = [{ name: 'propose_time_off_decision', args: { requestId: w.req.id, decision: 'approve' } }];
    const card = (await hr.post('/hugo/ask').send({ text: 'approve it' })).body.actions[0];
    const r = await hr.post('/hugo/confirm').send({ token: card.token });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('failed');
    expect(r.body.message).toMatch(/don’t have enough leave for this \(16 h asked, 0 h available\)/);
    expect((await prisma.timeOffRequest.findUniqueOrThrow({ where: { id: w.req.id } })).status).toBe('PENDING');
    expect((await prisma.assistantAction.findUniqueOrThrow({ where: { id: card.id } })).status).toBe('FAILED');
  });
});

describe('a worker’s own actions', () => {
  it('has no desk tools; can call out of their own shift, confirmed', async () => {
    const w = await world();
    const startsAt = new Date(Date.now() + 20 * H);
    const shift = await prisma.shift.create({ data: { clientId: w.client.id, locationId: w.store.id, position: 'Cashier', startsAt, endsAt: new Date(startsAt.getTime() + 8 * H), status: 'ASSIGNED', assignedAssociateId: w.ana.id } });
    const ana = await loginAs(w.anaUser.email);
    script.steps = [{ name: 'propose_time_off_decision', args: { requestId: w.req.id, decision: 'approve' } }];
    expect((await ana.post('/hugo/ask').send({ text: 'approve my time off' })).body.actions).toEqual([]);

    script.steps = [{ name: 'propose_call_out', args: { reason: 'SICK' } }];
    const card = (await ana.post('/hugo/ask').send({ text: 'I’m sick, can’t come tomorrow' })).body.actions[0];
    expect(card).toMatchObject({ kind: 'call_out', confirmLabel: 'Call out' });
    const done = await ana.post('/hugo/confirm').send({ token: card.token });
    expect(done.body.status).toBe('done');
    expect(await prisma.callOut.findFirstOrThrow({ where: { shiftId: shift.id } })).toMatchObject({ channel: 'APP', reason: 'SICK', status: 'CONFIRMED' });
  });
});

describe('plain-English numbers', () => {
  it('runs a report within the person’s reach and hands back a table and a builder link', async () => {
    const w = await world();
    const hr = await loginAs(w.hr.email);
    script.steps = [{ name: 'run_report', args: { title: 'People by state', entity: 'ASSOCIATE', groupBy: ['state'], aggregates: [{ fn: 'count' }] } }];
    const r = await hr.post('/hugo/ask').send({ text: 'how many people by state?' });
    expect(r.status).toBe(200);
    expect(r.body.tables).toHaveLength(1);
    expect(r.body.tables[0]).toMatchObject({ title: 'People by state', columns: ['state', 'count'] });
    expect(r.body.tables[0].linkUrl).toMatch(/^\/reports\?draft=/);
    void w;
  });
});
