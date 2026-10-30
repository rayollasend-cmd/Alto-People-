import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';

/**
 * What Hugo knows (lib/hugoMemory, routes/hugoMemory): memory the person can
 * see and edit. Hugo keeps a fact only through his remember tool, when told;
 * the guard refuses what must never be kept; 50 at most; memory off keeps
 * the facts out of the prompt and nothing is saved; each person reads and
 * changes only their own; forget everything; the data export carries the
 * facts and erasure deletes them; the audit log never holds the words.
 * The model is scripted (no SDK call): it calls remember_fact / forget_fact
 * when the question says so, and records what it was given.
 */

type Tool = { key: string; name: string; run: (a?: Record<string, unknown>) => Promise<{ reply: string }> };
const calls = vi.hoisted(() => ({
  inputs: [] as Array<{ memory?: string[]; tools: string[] }>,
  replies: [] as string[],
  remember: null as null | { text: string; kind: string },
  forget: null as null | string,
}));
vi.mock('../../lib/assistantModel.js', async (orig) => {
  const real = await orig<typeof import('../../lib/assistantModel.js')>();
  return {
    ...real,
    modelAvailable: () => true,
    answerWithModel: vi.fn(async ({ tools, memory, live }: { tools: Tool[]; memory?: string[]; live?: { onTool?: (k: string) => void } }) => {
      calls.inputs.push({ memory, tools: tools.map((t) => t.name) });
      if (calls.remember) {
        const tool = tools.find((t) => t.name === 'remember_fact');
        if (tool) {
          live?.onTool?.(tool.key);
          calls.replies.push((await tool.run(calls.remember)).reply);
        }
      }
      if (calls.forget) {
        const tool = tools.find((t) => t.name === 'forget_fact');
        if (tool) {
          live?.onTool?.(tool.key);
          calls.replies.push((await tool.run({ fact: calls.forget })).reply);
        }
      }
      return { reply: 'Got it.', linkUrl: null, toolsUsed: [], handoff: null };
    }),
  };
});
// The allowance is tested on its own (hugoAllowance.test.ts): here there is always room.
vi.mock('../../lib/hugoAllowance.js', async (orig) => {
  const real = await orig<typeof import('../../lib/hugoAllowance.js')>();
  return { ...real, allowanceStatus: vi.fn(async () => ({ exhausted: false, renewsAt: new Date(), spentMicros: 0, capMicros: 1, periodStart: new Date(), allowanceClass: 'STANDARD' })) };
});

import { createApp } from '../../app.js';
import { builtInAgentId, ensureBuiltInAgents } from '../../lib/agents.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { buildDataExport } from '../../lib/dataExport.js';
import { eraseAssociate } from '../../lib/erasure.js';
import { factsMatching, memoryForChannel } from '../../lib/hugoMemory.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createUser, prisma, truncateAll } from '../../../test/db.js';

beforeEach(async () => {
  await truncateAll();
  calls.inputs = [];
  calls.replies = [];
  calls.remember = null;
  calls.forget = null;
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(createApp());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`login failed: ${r.status}`);
  return a;
}

async function world() {
  // Fresh addresses per test: the sign-in limiter counts per email.
  const tag = Math.random().toString(36).slice(2, 8);
  // The built-in agents take the first admin as their owner: an agent with no owner is off.
  const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR', email: `hr-${tag}@example.com` });
  await ensureBuiltInAgents(prisma, ALTO_TENANT_ID);
  const ana = await createAssociate({ firstName: 'Ana', lastName: 'Lopez', email: `ana.assoc-${tag}@example.com` });
  const { user: anaUser } = await createUser({ role: 'ASSOCIATE', associateId: ana.id, email: `ana-${tag}@example.com` });
  const ben = await createAssociate({ firstName: 'Ben', lastName: 'Cho', email: `ben.assoc-${tag}@example.com` });
  const { user: benUser } = await createUser({ role: 'ASSOCIATE', associateId: ben.id, email: `ben-${tag}@example.com` });
  return { hr, ana, anaUser, ben, benUser };
}

/** Questions that go to the model: anything with a word of judgment in it (lib/hugoRouting). */
const ASK = 'Why is my week like this? Remember this please.';

describe('in the chat: kept only through the remember tool, when told', () => {
  it('a fact told is kept, the answer says so the first time with the chip’s ids; the next question has it in the prompt', async () => {
    const w = await world();
    const ana = await loginAs(w.anaUser.email);

    // A question with nothing to keep: the model doesn't call remember_fact, nothing is kept.
    const plain = await ana.post('/hugo/ask').send({ text: 'Why is my schedule like this?' });
    expect(plain.status, JSON.stringify(plain.body)).toBe(200);
    expect(plain.body.remembered).toBeUndefined();
    expect(await prisma.hugoMemory.count()).toBe(0);
    expect(calls.inputs[0]!.tools).toEqual(expect.arrayContaining(['remember_fact', 'forget_fact']));
    expect(calls.inputs[0]!.memory).toEqual([]);

    calls.remember = { text: 'I prefer morning shifts', kind: 'PREFERENCE' };
    const told = await ana.post('/hugo/ask').send({ text: ASK });
    expect(told.body).toMatchObject({ source: 'model', memoryFirst: true, remembered: [{ text: 'I prefer morning shifts' }] });
    expect(told.body.reply).toContain('Got it.');
    expect(told.body.reply).toContain('What Hugo knows');
    const rows = await prisma.hugoMemory.findMany();
    expect(rows).toMatchObject([{ userId: w.anaUser.id, text: 'I prefer morning shifts', kind: 'PREFERENCE', source: 'TOLD' }]);
    expect(told.body.remembered[0].id).toBe(rows[0]!.id);

    // The second fact: no first-time line again.
    calls.remember = { text: 'I take the van from the Main St stop', kind: 'TRAVEL' };
    const again = await ana.post('/hugo/ask').send({ text: ASK });
    expect(again.body.memoryFirst).toBeUndefined();
    expect(again.body.reply).toBe('Got it.');
    expect(again.body.remembered).toHaveLength(1);

    // Said twice, kept once.
    calls.remember = { text: 'i prefer MORNING shifts.', kind: 'PREFERENCE' };
    const dup = await ana.post('/hugo/ask').send({ text: ASK });
    expect(dup.body.remembered).toBeUndefined();
    expect(calls.replies.at(-1)).toContain('Already kept');
    expect(await prisma.hugoMemory.count()).toBe(2);

    // Next question: both facts in the model's input (most recent first), and marked used.
    calls.remember = null;
    await ana.post('/hugo/ask').send({ text: 'Why is my schedule like this?' });
    expect(calls.inputs.at(-1)!.memory).toEqual(['I take the van from the Main St stop', 'I prefer morning shifts']);
    expect(await prisma.hugoMemory.count({ where: { lastUsedAt: { not: null } } })).toBe(2);
  });

  it('internal staff keep their own too: an HR administrator’s fact is kept, listed and in their next prompt — and only theirs', async () => {
    const w = await world();
    const hr = await loginAs(w.hr.email);
    calls.remember = { text: 'I review time-off requests on Monday mornings', kind: 'WORK' };
    const told = await hr.post('/hugo/ask').send({ text: ASK });
    expect(told.status, JSON.stringify(told.body)).toBe(200);
    expect(told.body).toMatchObject({ source: 'model', remembered: [{ text: 'I review time-off requests on Monday mornings' }] });
    expect(await prisma.hugoMemory.findMany()).toMatchObject([{ userId: w.hr.id, kind: 'WORK', source: 'TOLD' }]);

    const list = await hr.get('/hugo/memory');
    expect(list.body).toMatchObject({ memoryOn: true, facts: [{ text: 'I review time-off requests on Monday mornings' }] });
    calls.remember = null;
    await hr.post('/hugo/ask').send({ text: 'Why is the desk like this today?' });
    expect(calls.inputs.at(-1)!.memory).toEqual(['I review time-off requests on Monday mornings']);

    // An associate's Hugo knows none of it.
    const ana = await loginAs(w.anaUser.email);
    expect((await ana.get('/hugo/memory')).body.facts).toEqual([]);
  });

  it('the instant (registry) path is unchanged: no model, no memory', async () => {
    const w = await world();
    const ana = await loginAs(w.anaUser.email);
    calls.remember = { text: 'I prefer mornings', kind: 'PREFERENCE' };
    const r = await ana.post('/hugo/ask').send({ text: 'When is payday?' });
    expect(r.body).toMatchObject({ tier: 'instant', source: 'rules' });
    expect(r.body.remembered).toBeUndefined();
    expect(calls.inputs).toEqual([]);
    expect(await prisma.hugoMemory.count()).toBe(0);
  });

  it('streamed: remembering is a step of its own, and the done answer carries what was kept', async () => {
    const w = await world();
    const ana = await loginAs(w.anaUser.email);
    calls.remember = { text: 'I like short answers', kind: 'PREFERENCE' };
    const raw = ((res: NodeJS.ReadableStream, cb: (err: Error | null, body: string) => void) => {
      let data = '';
      res.on('data', (c: Buffer) => (data += c.toString()));
      res.on('end', () => cb(null, data));
    }) as unknown as Parameters<Test['parse']>[0];
    const r = await ana.post('/hugo/ask/stream').send({ text: ASK }).buffer(true).parse(raw);
    const events = (r.body as string).split('\n').filter(Boolean).map((l) => JSON.parse(l) as { t: string; step?: string; answer?: { remembered?: unknown[] } });
    expect(events.find((e) => e.t === 'step')?.step).toBe('memory');
    expect(events.at(-1)!.answer!.remembered).toHaveLength(1);
  });

  it('“forget that”: the forget tool removes the one it names, and the answer counts it', async () => {
    const w = await world();
    const ana = await loginAs(w.anaUser.email);
    await ana.post('/hugo/memory').send({ text: 'I prefer morning shifts', kind: 'PREFERENCE' });
    await ana.post('/hugo/memory').send({ text: 'I take the van from Main St', kind: 'TRAVEL' });
    calls.forget = 'morning shifts';
    const r = await ana.post('/hugo/ask').send({ text: 'Why do you think that? Forget it.' });
    expect(r.body.forgot).toBe(1);
    expect((await prisma.hugoMemory.findMany()).map((m) => m.text)).toEqual(['I take the van from Main St']);
    // Ambiguous words remove nothing and ask which.
    await ana.post('/hugo/memory').send({ text: 'I take the bus on Sundays', kind: 'TRAVEL' });
    calls.forget = 'take the';
    const two = await ana.post('/hugo/ask').send({ text: 'Why? Forget it.' });
    expect(two.body.forgot).toBeUndefined();
    expect(calls.replies.at(-1)).toContain('matches 2 things');
    expect(await prisma.hugoMemory.count()).toBe(2);
  });

  it('factsMatching: the same words first, else every word of it', () => {
    const facts = [{ text: 'I prefer morning shifts' }, { text: 'I prefer the Main St store' }];
    expect(factsMatching(facts, 'I prefer morning shifts.')).toEqual([facts[0]]);
    expect(factsMatching(facts, 'main st store')).toEqual([facts[1]]);
    expect(factsMatching(facts, 'prefer')).toHaveLength(2);
    expect(factsMatching(facts, 'nights')).toEqual([]);
  });
});

describe('the guard', () => {
  it('refuses each sensitive category, by hand and through the chat, and keeps nothing', async () => {
    const w = await world();
    const ana = await loginAs(w.anaUser.email);
    const cases: Array<[string, string]> = [
      ['SECRET', 'My SSN is 123-45-6789'],
      ['HEALTH', 'Estoy embarazada'],
      ['RELIGION', 'Cuma günleri camiye giderim'],
      ['IMMIGRATION', 'Mwen san papye'],
      ['ORIENTATION', 'Sou bissexual'],
      ['CRIMINAL', 'У мене є судимість'],
      ['UNION', 'I’m a union member'],
      ['OTHER_PERSON', 'My coworker Maria is getting divorced'],
    ];
    for (const [reason, text] of cases) {
      const r = await ana.post('/hugo/memory').send({ text, kind: 'OTHER' });
      expect(r.status, text).toBe(422);
      expect(r.body.error).toMatchObject({ code: 'memory_refused', details: { reason } });
    }
    calls.remember = { text: 'I’m pregnant so no lifting', kind: 'OTHER' };
    const chat = await ana.post('/hugo/ask').send({ text: ASK });
    expect(chat.body.remembered).toBeUndefined();
    expect(calls.replies.at(-1)).toMatch(/^Not saved: you never keep health/);
    expect(await prisma.hugoMemory.count()).toBe(0);
    // An edit is held to the same guard.
    const ok = await ana.post('/hugo/memory').send({ text: 'I prefer mornings', kind: 'PREFERENCE' });
    const edit = await ana.patch(`/hugo/memory/${ok.body.fact.id}`).send({ text: 'I go to mass on Sundays' });
    expect(edit.body.error).toMatchObject({ code: 'memory_refused', details: { reason: 'RELIGION' } });
    expect((await prisma.hugoMemory.findFirstOrThrow()).text).toBe('I prefer mornings');
  });

  it('keeps 50 at most: then a plain refusal, by hand and in the chat', async () => {
    const w = await world();
    const ana = await loginAs(w.anaUser.email);
    await prisma.hugoMemory.createMany({ data: Array.from({ length: 50 }, (_, i) => ({ userId: w.anaUser.id, kind: 'OTHER', text: `Fact number ${i}`, source: 'ADDED' })) });
    const r = await ana.post('/hugo/memory').send({ text: 'One more thing', kind: 'OTHER' });
    expect(r.status).toBe(422);
    expect(r.body.error.details).toEqual({ reason: 'FULL' });
    calls.remember = { text: 'One more thing', kind: 'OTHER' };
    await ana.post('/hugo/ask').send({ text: ASK });
    expect(calls.replies.at(-1)).toContain('I can keep 50 things — remove some in What Hugo knows');
    expect(await prisma.hugoMemory.count()).toBe(50);
    // Someone else's 50 don't count against Ben.
    const ben = await loginAs(w.benUser.email);
    expect((await ben.post('/hugo/memory').send({ text: 'I prefer nights', kind: 'PREFERENCE' })).status).toBe(201);
  });

  it('memory off: the facts stay out of the prompt, no remember tool, nothing saved; back on, they return', async () => {
    const w = await world();
    const ana = await loginAs(w.anaUser.email);
    await ana.post('/hugo/memory').send({ text: 'I prefer mornings', kind: 'PREFERENCE' });
    expect((await ana.put('/hugo/memory/settings').send({ memoryOn: false })).body).toEqual({ memoryOn: false });
    calls.remember = { text: 'I prefer nights', kind: 'PREFERENCE' };
    const r = await ana.post('/hugo/ask').send({ text: ASK });
    expect(r.body.remembered).toBeUndefined();
    expect(calls.inputs[0]!.memory).toBeUndefined();
    expect(calls.inputs[0]!.tools).not.toContain('remember_fact');
    expect((await ana.post('/hugo/memory').send({ text: 'I prefer nights', kind: 'PREFERENCE' })).body.error.code).toBe('memory_off');
    // What is kept stays, visible and removable, until they remove it.
    const list = await ana.get('/hugo/memory');
    expect(list.body).toMatchObject({ memoryOn: false, max: 50, facts: [{ text: 'I prefer mornings', source: 'ADDED' }] });
    await ana.put('/hugo/memory/settings').send({ memoryOn: true });
    calls.remember = null;
    await ana.post('/hugo/ask').send({ text: ASK });
    expect(calls.inputs.at(-1)!.memory).toEqual(['I prefer mornings']);
  });
});

describe('/hugo/memory — the person’s own, only', () => {
  it('add, list, edit, remove; another person’s fact is a 404 and stays put', async () => {
    const w = await world();
    const ana = await loginAs(w.anaUser.email);
    const ben = await loginAs(w.benUser.email);
    const added = await ana.post('/hugo/memory').send({ text: '  I prefer the  Main St store ', kind: 'PREFERENCE' });
    expect(added.status).toBe(201);
    expect(added.body.fact).toMatchObject({ text: 'I prefer the Main St store', kind: 'PREFERENCE', source: 'ADDED', lastUsedAt: null });
    expect((await ana.post('/hugo/memory').send({ text: 'I prefer the main st store', kind: 'PREFERENCE' })).status).toBe(200);
    const id = added.body.fact.id as string;
    await ben.post('/hugo/memory').send({ text: 'I prefer nights', kind: 'PREFERENCE' });

    const list = await ana.get('/hugo/memory');
    expect(list.body.facts.map((f: { text: string }) => f.text)).toEqual(['I prefer the Main St store']);

    const edited = await ana.patch(`/hugo/memory/${id}`).send({ kind: 'WORK' });
    expect(edited.body.fact).toMatchObject({ kind: 'WORK', text: 'I prefer the Main St store' });
    expect((await ana.patch(`/hugo/memory/${id}`).send({ text: 'I prefer the Oak Ave store' })).body.fact.text).toBe('I prefer the Oak Ave store');

    // Ben can neither change nor remove Ana's.
    expect((await ben.patch(`/hugo/memory/${id}`).send({ text: 'mine now' })).status).toBe(404);
    expect((await ben.delete(`/hugo/memory/${id}`)).status).toBe(404);
    expect(await prisma.hugoMemory.count({ where: { id } })).toBe(1);

    expect((await ana.delete(`/hugo/memory/${id}?via=undo`)).body).toEqual({ ok: true });
    expect((await ana.delete(`/hugo/memory/${id}`)).status).toBe(404);
    expect(await prisma.hugoMemory.count({ where: { userId: w.benUser.id } })).toBe(1);
  });

  it('forget everything: only with the confirmation in the body, and only theirs', async () => {
    const w = await world();
    const ana = await loginAs(w.anaUser.email);
    const ben = await loginAs(w.benUser.email);
    await ana.post('/hugo/memory').send({ text: 'I prefer mornings', kind: 'PREFERENCE' });
    await ana.post('/hugo/memory').send({ text: 'I take the van', kind: 'TRAVEL' });
    await ben.post('/hugo/memory').send({ text: 'I prefer nights', kind: 'PREFERENCE' });
    expect((await ana.delete('/hugo/memory').send({})).status).toBe(400);
    expect(await prisma.hugoMemory.count()).toBe(3);
    expect((await ana.delete('/hugo/memory').send({ confirm: true })).body).toEqual({ forgot: 2 });
    expect((await prisma.hugoMemory.findMany()).map((m) => m.userId)).toEqual([w.benUser.id]);
  });

  it('with the assistant switched off: what is kept can still be read and removed, not added to', async () => {
    const w = await world();
    const ana = await loginAs(w.anaUser.email);
    const added = await ana.post('/hugo/memory').send({ text: 'I prefer mornings', kind: 'PREFERENCE' });
    const hugoId = (await builtInAgentId(prisma, 'whatsapp-assistant', ALTO_TENANT_ID))!;
    await prisma.agentProfile.update({ where: { workerId: hugoId }, data: { suspendedAt: new Date() } });
    expect((await ana.get('/hugo/memory')).body.facts).toHaveLength(1);
    expect((await ana.post('/hugo/memory').send({ text: 'I prefer nights', kind: 'PREFERENCE' })).body.error.code).toBe('hugo_off');
    expect((await ana.delete(`/hugo/memory/${added.body.fact.id}`)).status).toBe(200);
  });

  it('every change is audited by kind and count — never the words', async () => {
    const w = await world();
    const ana = await loginAs(w.anaUser.email);
    const added = await ana.post('/hugo/memory').send({ text: 'I prefer the Zebra Street store', kind: 'PREFERENCE' });
    await ana.patch(`/hugo/memory/${added.body.fact.id}`).send({ text: 'I prefer the Quokka Lane store' });
    await ana.post('/hugo/memory').send({ text: 'Estoy embarazada de gemelos', kind: 'OTHER' });
    await ana.put('/hugo/memory/settings').send({ memoryOn: false });
    await ana.put('/hugo/memory/settings').send({ memoryOn: true });
    calls.remember = { text: 'I like the Walrus Road van', kind: 'TRAVEL' };
    await ana.post('/hugo/ask').send({ text: ASK });
    await ana.delete(`/hugo/memory/${added.body.fact.id}`);
    await ana.delete('/hugo/memory').send({ confirm: true });
    await flushPendingAudits();
    const rows = await prisma.auditLog.findMany({ where: { action: { startsWith: 'hugo.memory.' } }, orderBy: { createdAt: 'asc' } });
    expect(rows.map((r) => r.action)).toEqual([
      'hugo.memory.saved',
      'hugo.memory.edited',
      'hugo.memory.refused',
      'hugo.memory.switched',
      'hugo.memory.switched',
      'hugo.memory.saved',
      'hugo.memory.removed',
      'hugo.memory.cleared',
    ]);
    expect(rows.every((r) => r.actorUserId === w.anaUser.id && r.entityType === 'User' && r.entityId === w.anaUser.id)).toBe(true);
    expect(rows[2]!.metadata).toMatchObject({ reason: 'HEALTH' });
    expect(rows.at(-1)!.metadata).toMatchObject({ count: 1 });
    const all = JSON.stringify(await prisma.auditLog.findMany({ select: { metadata: true, entityId: true } }));
    for (const word of ['Zebra', 'Quokka', 'embarazada', 'gemelos', 'Walrus']) expect(all).not.toContain(word);
    // The assistant's own trail says it kept something, and what kind.
    const trail = await prisma.auditLog.findMany({ where: { action: 'agent.memory.saved' } });
    expect(trail.map((t) => (t.metadata as { kind?: string }).kind)).toEqual(['TRAVEL']);
  });
});

describe('privacy rights', () => {
  it('the data export carries the person’s facts and their switch; someone with none gets no file', async () => {
    const w = await world();
    const ana = await loginAs(w.anaUser.email);
    await ana.post('/hugo/memory').send({ text: 'I prefer mornings', kind: 'PREFERENCE' });
    const entries = await buildDataExport(w.anaUser.id);
    const file = entries.find((e) => e.filename === 'hugo-memory.json');
    expect(JSON.parse(file!.contents)).toMatchObject({ memoryOn: true, facts: [{ kind: 'PREFERENCE', text: 'I prefer mornings', source: 'ADDED' }] });
    expect(entries.find((e) => e.filename === 'README.txt')!.contents).toContain('hugo-memory.json');
    expect((await buildDataExport(w.benUser.id)).map((e) => e.filename)).not.toContain('hugo-memory.json');
  });

  it('erasing the person deletes their facts and their switch, and counts them', async () => {
    const w = await world();
    const ana = await loginAs(w.anaUser.email);
    await ana.post('/hugo/memory').send({ text: 'I prefer mornings', kind: 'PREFERENCE' });
    await ana.post('/hugo/memory').send({ text: 'I take the van', kind: 'TRAVEL' });
    await ana.put('/hugo/memory/settings').send({ memoryOn: false });
    const ben = await loginAs(w.benUser.email);
    await ben.post('/hugo/memory').send({ text: 'I prefer nights', kind: 'PREFERENCE' });
    const out = await eraseAssociate(prisma, w.ana.id, w.hr.id, 'Right to erasure request', { force: true });
    expect(out.counts.hugoMemoriesDeleted).toBe(2);
    expect(await prisma.hugoMemory.count({ where: { userId: w.anaUser.id } })).toBe(0);
    expect(await prisma.hugoMemorySetting.count({ where: { userId: w.anaUser.id } })).toBe(0);
    expect(await prisma.hugoMemory.count({ where: { userId: w.benUser.id } })).toBe(1);
  });
});

describe('memoryForChannel (the WhatsApp brain and other model calls for one person)', () => {
  it('the person’s facts, most recent first, marked used — none when their memory is off or the account no longer signs in', async () => {
    const w = await world();
    const ana = await loginAs(w.anaUser.email);
    await ana.post('/hugo/memory').send({ text: 'I prefer mornings', kind: 'PREFERENCE' });
    await ana.post('/hugo/memory').send({ text: 'I take the van', kind: 'TRAVEL' });
    expect(await memoryForChannel(w.anaUser.id)).toEqual(['I take the van', 'I prefer mornings']);
    expect(await prisma.hugoMemory.count({ where: { lastUsedAt: null } })).toBe(0);
    expect(await memoryForChannel(w.benUser.id)).toEqual([]);
    await ana.put('/hugo/memory/settings').send({ memoryOn: false });
    expect(await memoryForChannel(w.anaUser.id)).toEqual([]);
    await ana.put('/hugo/memory/settings').send({ memoryOn: true });
    await prisma.user.update({ where: { id: w.anaUser.id }, data: { status: 'DISABLED' } });
    expect(await memoryForChannel(w.anaUser.id)).toEqual([]);
  });
});
