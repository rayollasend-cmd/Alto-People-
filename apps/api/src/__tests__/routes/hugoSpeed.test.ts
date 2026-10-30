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

async function world() {
  // The built-in agents take the first admin as their owner: an agent with no owner is off.
  const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'hr@example.com' });
  await ensureBuiltInAgents(prisma, ALTO_TENANT_ID);
  const ana = await createAssociate({ firstName: 'Ana', lastName: 'Lopez' });
  const { user: anaUser } = await createUser({ role: 'ASSOCIATE', associateId: ana.id, email: 'ana@example.com' });
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
