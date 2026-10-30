import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';

/**
 * Hugo, quick: a tapped suggestion or a worker's plain question about their
 * own records is answered by the registry at once (no model); everyday
 * questions go to the quick model, actions to the strongest; and
 * /hugo/ask/stream shows the answer as it is made — the step, the words,
 * then the same answer /hugo/ask gives. The model is scripted (no SDK call).
 */

const calls = vi.hoisted(() => ({ tiers: [] as string[] }));
vi.mock('../../lib/assistantModel.js', async (orig) => {
  const real = await orig<typeof import('../../lib/assistantModel.js')>();
  return {
    ...real,
    modelAvailable: () => true,
    answerWithModel: vi.fn(
      async ({
        tier,
        tools,
        live,
      }: {
        tier?: string;
        tools: Array<{ key: string; run: (a?: Record<string, unknown>) => Promise<{ reply: string }> }>;
        live?: { onTool?: (k: string) => void; onText?: (d: string) => void; onClear?: () => void };
      }) => {
        calls.tiers.push(tier ?? 'deep');
        live?.onText?.('Let me check.');
        live?.onClear?.();
        const shifts = tools.find((t) => t.key === 'SCHEDULE');
        if (shifts) {
          live?.onTool?.('SCHEDULE');
          await shifts.run();
        }
        live?.onText?.('All ');
        live?.onText?.('set.');
        return { reply: 'All set.', linkUrl: null, toolsUsed: shifts ? ['SCHEDULE'] : [], handoff: null };
      },
    ),
  };
});

import { createApp } from '../../app.js';
import { ensureBuiltInAgents } from '../../lib/agents.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { chargeModelCall } from '../../lib/hugoAllowance.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createUser, prisma, truncateAll } from '../../../test/db.js';

const app = () => createApp();

beforeEach(async () => {
  await truncateAll();
  calls.tiers = [];
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

// A fresh pair of emails per test: the per-email sign-in limit (5 in 15 minutes) holds across a file.
let worlds = 0;
async function world() {
  const n = ++worlds;
  // The built-in agents take the first admin as their owner: an agent with no owner is off.
  const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR', email: `hr${n}@example.com` });
  await ensureBuiltInAgents(prisma, ALTO_TENANT_ID);
  const ana = await createAssociate({ firstName: 'Ana', lastName: 'Lopez' });
  const { user: anaUser } = await createUser({ role: 'ASSOCIATE', associateId: ana.id, email: `ana${n}@example.com` });
  return { hr, anaUser };
}

/** The stream's lines, parsed. */
const lines = (body: string) =>
  body
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { t: string; step?: string; d?: string; answer?: Record<string, unknown> });
/** The raw body, unparsed: supertest knows no NDJSON parser (the response is a readable stream). */
const raw = ((res: NodeJS.ReadableStream, cb: (err: Error | null, body: string) => void) => {
  let data = '';
  res.on('data', (c: Buffer) => (data += c.toString()));
  res.on('end', () => cb(null, data));
}) as unknown as Parameters<Test['parse']>[0];

describe('the quickest way that answers well', () => {
  it('a worker’s plain question about their own payday: the registry, at once — no model', async () => {
    const w = await world();
    const ana = await loginAs(w.anaUser.email);
    const r = await ana.post('/hugo/ask').send({ text: 'When is payday?' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ intent: 'PAYDAY', source: 'rules', tier: 'instant' });
    expect(calls.tiers).toEqual([]);
  });

  it('a question with judgment in it goes to the quick model; an action to set up, to the strongest', async () => {
    const w = await world();
    const ana = await loginAs(w.anaUser.email);
    const why = await ana.post('/hugo/ask').send({ text: 'Why was my check short?' });
    expect(why.body).toMatchObject({ source: 'model', tier: 'fast', reply: 'All set.' });
    const hr = await loginAs(w.hr.email);
    const act = await hr.post('/hugo/ask').send({ text: 'approve Ana’s time off' });
    expect(act.body).toMatchObject({ source: 'model', tier: 'deep' });
    expect(calls.tiers).toEqual(['fast', 'deep']);
    // The trail says which way it went (never the words).
    await flushPendingAudits();
    const trail = await prisma.auditLog.findMany({ where: { action: 'hugo.asked' }, select: { metadata: true } });
    expect(trail.map((t) => (t.metadata as { tier?: string }).tier).sort()).toEqual(['deep', 'fast']);
  });
});

describe('POST /hugo/ask/stream', () => {
  it('shows the answer as it is made: the lead-in dropped, the step, the words, then the whole answer', async () => {
    const w = await world();
    const ana = await loginAs(w.anaUser.email);
    const r = await ana.post('/hugo/ask/stream').send({ text: 'Why is my schedule like this?' }).buffer(true).parse(raw);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('application/x-ndjson');
    const events = lines(r.body as string);
    expect(events.map((e) => (e.t === 'text' ? `text:${e.d}` : e.t === 'step' ? `step:${e.step}` : e.t))).toEqual(['text:Let me check.', 'clear', 'step:schedule', 'text:All ', 'text:set.', 'done']);
    expect(events.at(-1)!.answer).toMatchObject({ reply: 'All set.', source: 'model', tier: 'fast', intent: 'MODEL' });
  });

  it('an instant answer is one step and the answer', async () => {
    const w = await world();
    const ana = await loginAs(w.anaUser.email);
    const r = await ana.post('/hugo/ask/stream').send({ text: '¿Cuándo me pagan?' }).buffer(true).parse(raw);
    const events = lines(r.body as string);
    expect(events.map((e) => e.t)).toEqual(['step', 'done']);
    expect(events[0]!.step).toBe('pay');
    expect(events[1]!.answer).toMatchObject({ intent: 'PAYDAY', tier: 'instant' });
    expect(calls.tiers).toEqual([]);
  });

  it('a refusal before anything is said is an ordinary JSON error', async () => {
    const w = await world();
    const ana = await loginAs(w.anaUser.email);
    const r = await ana.post('/hugo/ask/stream').send({ text: '' });
    expect(r.status).toBe(400);
    expect(r.headers['content-type']).toContain('application/json');
  });
});

describe('each person’s allowance', () => {
  it('used up: the question is answered from the records, says until when — and the model is never called', async () => {
    const w = await world();
    // Ana's dollar for this cycle is spent.
    await chargeModelCall({ userId: w.anaUser.id, purpose: 'chat' }, { tier: 'fast', model: 'deepseek-flash', inputTokens: 4_000_000, cachedTokens: 0, outputTokens: 0 });
    const ana = await loginAs(w.anaUser.email);
    const r = await ana.post('/hugo/ask').send({ text: 'Why was my check short?' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ source: 'rules', tier: 'instant', allowance: { exhausted: true } });
    expect(r.body.reply).toMatch(/I can only answer the basics/);
    expect(calls.tiers).toEqual([]);
    // A plain question still gets its instant answer, with no note.
    const payday = await ana.post('/hugo/ask').send({ text: 'When is payday?' });
    expect(payday.body).toMatchObject({ intent: 'PAYDAY', tier: 'instant', allowance: null });
    // HR's allowance is untouched by Ana's.
    const hr = await loginAs(w.hr.email);
    expect((await hr.post('/hugo/ask').send({ text: 'who is on tonight?' })).body.source).toBe('model');
  });

  it('GET /hugo/allowance: a worker sees the share used and the renewal day; the office also sees dollars', async () => {
    const w = await world();
    await chargeModelCall({ userId: w.anaUser.id, purpose: 'chat' }, { tier: 'fast', model: 'deepseek-flash', inputTokens: 1_000_000, cachedTokens: 0, outputTokens: 0 });
    const ana = await loginAs(w.anaUser.email);
    const mine = (await ana.get('/hugo/allowance')).body;
    expect(mine).toMatchObject({ on: true, allowanceClass: 'floor', usedPercent: 30, exhausted: false });
    expect(mine.spentUsd).toBeUndefined();
    expect(new Date(mine.renewsAt).getTime() - new Date(mine.periodStart).getTime()).toBe(30 * 86_400_000);
    const hr = await loginAs(w.hr.email);
    expect((await hr.get('/hugo/allowance')).body).toMatchObject({ allowanceClass: 'staff', spentUsd: 0, capUsd: 10, usedPercent: 0 });
  });
});

