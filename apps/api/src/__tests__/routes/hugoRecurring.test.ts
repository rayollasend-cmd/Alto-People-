import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';

/**
 * Recurring briefs (lib/hugoRecurring) — "every Friday tell me my hours".
 * The chat offers a Start card (the rules, or the model's offer_recurring);
 * the tap starts a RECURRING task; each run reads the person's answer fresh
 * through the registry, sends it as Hugo's notice (with the AI disclosure)
 * and waits for the next run on their clock. Free questions use the quick
 * model on their own allowance, under a per-tenant safety valve. They pause,
 * resume, change the time or stop it; after 180 days it asks to keep going.
 * The model is scripted (no SDK call).
 */

const calls = vi.hoisted(() => ({
  model: false,
  mode: 'ok' as 'ok' | 'allowance' | 'fail',
  inputs: [] as Array<{ tier?: string; meter?: { userId: string; purpose: string }; text: string; tools: Array<{ key: string; name: string; run: (a?: Record<string, unknown>) => Promise<{ reply: string }> }> }>,
  offer: null as Record<string, unknown> | null,
}));
vi.mock('../../lib/assistantModel.js', async (orig) => {
  const real = await orig<typeof import('../../lib/assistantModel.js')>();
  const { HugoAllowanceError } = await import('../../lib/hugoAllowance.js');
  return {
    ...real,
    modelAvailable: () => calls.model,
    answerWithModel: vi.fn(async (input: (typeof calls.inputs)[number]) => {
      calls.inputs.push(input);
      if (calls.mode === 'allowance') throw new HugoAllowanceError(new Date('2026-11-20T15:00:00Z'));
      if (calls.mode === 'fail') throw new Error('provider down');
      const offerTool = input.tools.find((t) => t.name === 'offer_recurring');
      if (calls.offer && offerTool) await offerTool.run(calls.offer);
      return { reply: calls.offer ? 'I can send that every Friday — tap Start.' : 'Two new policies were posted this week.', linkUrl: null, toolsUsed: [], handoff: null };
    }),
  };
});

import { createApp } from '../../app.js';
import { builtInAgentId, ensureBuiltInAgents } from '../../lib/agents.js';
import { env } from '../../config/env.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { nextRunAt } from '../../lib/hugoRecurring.js';
import { sweepHugoTasks } from '../../lib/hugoTasks.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { ALTO_TENANT_ID, runWithTenant } from '../../lib/tenant.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { pinMidweekNoon } from '../../../test/clock.js';
import { associatesOffTheModel, letAssociatesUseTheModel } from '../../../test/hugoModel.js';

// The model's machinery, driven by an associate: allowed for this file (by default an associate's Hugo never calls it).
letAssociatesUseTheModel();

const app = () => createApp();
const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;
const CHI = 'America/Chicago';

beforeEach(async () => {
  await truncateAll();
  calls.model = false;
  calls.mode = 'ok';
  calls.inputs = [];
  calls.offer = null;
  await createUser({ role: 'HR_ADMINISTRATOR', email: 'owner@example.com' });
  await ensureBuiltInAgents(prisma, ALTO_TENANT_ID);
});
afterEach(() => {
  (env as Record<string, unknown>).HUGO_RECURRING_DAILY_MODEL = 200;
  (env as Record<string, unknown>).HUGO_RECURRING_MAX_PER_USER = 5;
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

/** Ana works at a store on Chicago time; a manager runs the desk. */
async function store(language: string | null = null) {
  const client = await createClient('Walmart 1234');
  const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  await prisma.site.update({ where: { id: site.id }, data: { timezone: CHI } });
  const ana = await createAssociate({ firstName: 'Ana', lastName: 'Lopez' });
  await prisma.application.create({ data: { associateId: ana.id, clientId: client.id, onboardingTrack: 'STANDARD', status: 'APPROVED', approvedAt: new Date() } });
  await prisma.associateAssignment.create({ data: { associateId: ana.id, locationId: site.id, startedAt: new Date(Date.now() - 30 * D) } });
  const { user } = await createUser({ role: 'ASSOCIATE', associateId: ana.id });
  if (language) await prisma.user.update({ where: { id: user.id }, data: { language } });
  const shift = (startsAt: Date, hours = 8) =>
    prisma.shift.create({
      data: { clientId: client.id, locationId: site.id, position: 'Cashier', startsAt, endsAt: new Date(startsAt.getTime() + hours * H), status: 'ASSIGNED', assignedAssociateId: ana.id, publishedAt: new Date() },
    });
  return { client, site, ana, user, shift };
}

const inApp = (userId: string) => prisma.notification.findMany({ where: { recipientUserId: userId, channel: 'IN_APP' }, orderBy: { createdAt: 'asc' } });
const sweep = (at: Date) => runWithTenant(ALTO_TENANT_ID, 'job', () => sweepHugoTasks(at));
const codes = (task: { events: Array<{ code: string }> }) => task.events.map((e) => e.code);
const view = async (a: TestAgent<Test>, id: string) => (await a.get(`/hugo/tasks/${id}`)).body.task;

describe('asking for a brief in the chat', () => {
  it('offers a Start card for the phrasings — hours, shifts, coverage — on the person’s clock; nothing starts until the tap', async () => {
    pinMidweekNoon();
    const s = await store();
    const ana = await loginAs(s.user.email);

    const hours = await ana.post('/hugo/ask').send({ text: 'Every Friday tell me my hours' });
    expect(hours.status).toBe(200);
    expect(hours.body.intent).toBe('TASK_RECURRING');
    expect(hours.body.offers).toHaveLength(1);
    expect(hours.body.offers[0].task).toEqual({ kind: 'RECURRING', what: 'MY_HOURS', cadence: 'WEEKLY', weekday: 5, time: '17:00' });
    expect(hours.body.offers[0].subject.recurring).toMatchObject({ what: 'MY_HOURS', timezone: CHI, paused: false });
    expect(hours.body.reply).toContain('every Friday at 5:00 PM');

    const shift = await ana.post('/hugo/ask').send({ text: 'remind me every day at 7 of my next shift' });
    expect(shift.body.offers[0].task).toEqual({ kind: 'RECURRING', what: 'SCHEDULE', cadence: 'DAILY', time: '07:00' });
    expect(await prisma.hugoTask.count()).toBe(0);

    // A question with "every" in it is still a question.
    const q = await ana.post('/hugo/ask').send({ text: 'Do I work every Friday?' });
    expect(q.body.intent).not.toBe('TASK_RECURRING');

    // A desk: "each morning tell me who's short" (the Workforce agent's coverage, running).
    await prisma.worker.update({ where: { id: (await builtInAgentId(prisma, 'workforce-agent', ALTO_TENANT_ID))! }, data: { status: 'ACTIVE' } });
    const { user: mgr } = await createUser({ role: 'OPERATIONS_MANAGER' });
    const ops = await loginAs(mgr.email);
    const cov = await ops.post('/hugo/ask').send({ text: "each morning tell me who's short" });
    expect(cov.body.intent, cov.body.reply).toBe('TASK_RECURRING');
    expect(cov.body.offers, cov.body.reply).toHaveLength(1);
    expect(cov.body.offers[0].task).toEqual({ kind: 'RECURRING', what: 'COVERAGE', cadence: 'DAILY', time: '07:00' });
  });

  it('in Spanish and Turkish, answered in the person’s language', async () => {
    pinMidweekNoon();
    const s = await store('es');
    const ana = await loginAs(s.user.email);
    const es = await ana.post('/hugo/ask').send({ text: 'cada mañana dime mis próximos turnos' });
    expect(es.body.offers[0].task).toEqual({ kind: 'RECURRING', what: 'SCHEDULE', cadence: 'DAILY', time: '07:00' });
    expect(es.body.reply).toMatch(/^Puedo enviarte tus próximos turnos todos los días a las 7:00/);

    const deniz = await createAssociate({ firstName: 'Deniz', lastName: 'Kaya' });
    await prisma.associateAssignment.create({ data: { associateId: deniz.id, locationId: s.site.id, startedAt: new Date(Date.now() - 30 * D) } });
    const { user: dUser } = await createUser({ role: 'ASSOCIATE', associateId: deniz.id });
    await prisma.user.update({ where: { id: dUser.id }, data: { language: 'tr' } });
    const deniz2 = await loginAs(dUser.email);
    const tr = await deniz2.post('/hugo/ask').send({ text: 'her cuma saatlerimi söyle' });
    expect(tr.body.offers[0].task).toEqual({ kind: 'RECURRING', what: 'MY_HOURS', cadence: 'WEEKLY', weekday: 5, time: '17:00' });
    expect(tr.body.reply).toContain('her Cuma saat 17:00');
    // A possessive the registry's words miss ("vardiyamı"): still his shifts, each morning at 7.
    const tr2 = await deniz2.post('/hugo/ask').send({ text: 'her sabah saat 7’de bir sonraki vardiyamı hatırlat' });
    expect(tr2.body.offers[0].task).toEqual({ kind: 'RECURRING', what: 'SCHEDULE', cadence: 'DAILY', time: '07:00' });
  });

  it('a free question needs the model: without it, he says what he can repeat; with it, the question is the brief', async () => {
    pinMidweekNoon();
    const s = await store();
    const ana = await loginAs(s.user.email);
    const off = await ana.post('/hugo/ask').send({ text: 'every Monday tell me what is new in the handbook' });
    expect(off.body).toMatchObject({ intent: 'TASK_RECURRING', offers: [] });
    expect(off.body.reply).toMatch(/^I can repeat your next shifts, your next payday/);

    calls.model = true;
    const on = await ana.post('/hugo/ask').send({ text: 'every Monday tell me what is new in the handbook' });
    expect(on.body.offers[0].task).toMatchObject({ kind: 'RECURRING', what: 'ASK', cadence: 'WEEKLY', weekday: 1, time: '08:00', question: 'every Monday tell me what is new in the handbook' });
  });

  it('phrasings the rules miss reach the same card through the model’s offer_recurring tool', async () => {
    pinMidweekNoon();
    const s = await store();
    calls.model = true;
    calls.offer = { what: 'PAYDAY', cadence: 'WEEKLY', weekday: 5, time: '09:00' };
    const ana = await loginAs(s.user.email);
    const r = await ana.post('/hugo/ask').send({ text: 'I would really love a little Friday nudge about my payday please, thanks so much' });
    expect(r.status).toBe(200);
    expect(r.body.source).toBe('model');
    expect(calls.inputs[0]!.tools.map((t) => t.name)).toContain('offer_recurring');
    expect(r.body.offers).toHaveLength(1);
    expect(r.body.offers[0]).toMatchObject({ task: { kind: 'RECURRING', what: 'PAYDAY', cadence: 'WEEKLY', weekday: 5, time: '09:00' }, subject: { recurring: { timezone: CHI } } });
    expect(await prisma.hugoTask.count()).toBe(0);
  });
});

describe('a brief runs on its schedule', () => {
  it('delivers the registry’s answer as Hugo’s notice with the disclosure, then waits for the next run on the person’s clock', async () => {
    pinMidweekNoon();
    const s = await store();
    const ana = await loginAs(s.user.email);
    const started = await ana.post('/hugo/tasks').send({ task: { kind: 'RECURRING', what: 'SCHEDULE', cadence: 'DAILY', time: '07:00' }, source: 'chat' });
    expect(started.status).toBe(201);
    const task = started.body.task;
    const first = nextRunAt({ cadence: 'DAILY', weekday: null, time: '07:00', timezone: CHI }, new Date());
    expect(task).toMatchObject({ kind: 'RECURRING', status: 'WAITING', subject: { recurring: { what: 'SCHEDULE', cadence: 'DAILY', time: '07:00', timezone: CHI, paused: false } } });
    expect(task.result.recurring).toEqual({ nextAt: first.toISOString(), lastAt: null, deliveries: 0 });
    // Between runs it is not "working on it".
    expect((await ana.get('/hugo/summary')).body).toMatchObject({ working: 0, needsYou: 0 });

    await s.shift(new Date(first.getTime() + D + 2 * H));
    // Not due yet: nothing goes out.
    await sweep(new Date(first.getTime() - MIN));
    await flushPendingNotifications();
    expect(await inApp(s.user.id)).toHaveLength(0);

    await sweep(new Date(first.getTime() + MIN));
    await flushPendingNotifications();
    let v = await view(ana, task.id);
    expect(v.status).toBe('WAITING');
    expect(codes(v)).toEqual(['STARTED', 'DELIVERED']);
    expect(v.events[1].data).toMatchObject({ what: 'SCHEDULE', tier: 'instant', source: 'registry' });
    expect(String(v.events[1].data.text)).toContain('Cashier');
    const second = nextRunAt({ cadence: 'DAILY', weekday: null, time: '07:00', timezone: CHI }, new Date(first.getTime() + MIN));
    expect(v.result.recurring).toEqual({ nextAt: second.toISOString(), lastAt: new Date(first.getTime() + MIN).toISOString(), deliveries: 1 });
    const told = await inApp(s.user.id);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ category: 'hugo_task_done', subject: 'Your next shifts', linkUrl: '/scheduling' });
    expect(told[0]!.body).toContain('Cashier');
    expect(told[0]!.body).toMatch(/AI agent/);
    expect(told[0]!.byAgentId).not.toBeNull();

    // The same moment again sends nothing twice.
    await sweep(new Date(first.getTime() + 2 * MIN));
    await flushPendingNotifications();
    expect(await inApp(s.user.id)).toHaveLength(1);
    // On Hugo's trail: what was sent and how — never the words.
    const trail = await prisma.auditLog.findMany({ where: { action: 'agent.task.delivered' } });
    expect(trail).toHaveLength(1);
    expect(trail[0]!.metadata).toMatchObject({ kind: 'RECURRING', what: 'SCHEDULE', tier: 'instant', source: 'registry' });
    expect(JSON.stringify(trail[0]!.metadata)).not.toContain('Cashier');

    // The next day, the next one.
    await sweep(new Date(second.getTime() + MIN));
    await flushPendingNotifications();
    v = await view(ana, task.id);
    expect(v.result.recurring.deliveries).toBe(2);
  });

  it('a run the server missed by hours is skipped, not sent late', async () => {
    pinMidweekNoon();
    const s = await store();
    const ana = await loginAs(s.user.email);
    const { task } = (await ana.post('/hugo/tasks').send({ task: { kind: 'RECURRING', what: 'SCHEDULE', cadence: 'DAILY', time: '07:00' } })).body;
    const first = new Date(task.result.recurring.nextAt);
    await sweep(new Date(first.getTime() + 8 * H));
    await flushPendingNotifications();
    const v = await view(ana, task.id);
    expect(codes(v)).toEqual(['STARTED', 'SKIPPED']);
    expect(v.events[1].data).toMatchObject({ reason: 'late' });
    expect(await inApp(s.user.id)).toHaveLength(0);
  });

  it('their hours: worked this store week and still scheduled, never money', async () => {
    pinMidweekNoon();
    const s = await store();
    // Worked yesterday; one more shift tomorrow.
    await prisma.timeEntry.create({ data: { associateId: s.ana.id, clientId: s.client.id, locationId: s.site.id, clockInAt: new Date(Date.now() - D), clockOutAt: new Date(Date.now() - D + 6 * H), status: 'COMPLETED' } });
    const ana = await loginAs(s.user.email);
    const { task } = (await ana.post('/hugo/tasks').send({ task: { kind: 'RECURRING', what: 'MY_HOURS', cadence: 'DAILY', time: '07:00' } })).body;
    const first = new Date(task.result.recurring.nextAt);
    await s.shift(new Date(first.getTime() + 2 * H), 4);
    await sweep(new Date(first.getTime() + MIN));
    await flushPendingNotifications();
    const told = (await inApp(s.user.id))[0]!;
    expect(told.subject).toBe('Your hours this week');
    expect(told.body).toMatch(/you’ve worked 6 hours so far, with 4 more scheduled\./);
    expect(told.body).not.toMatch(/\$/);
  });

  it('a free question: the quick model, on the person’s own allowance, with their registry answers and not their pay', async () => {
    pinMidweekNoon();
    const s = await store();
    const ana = await loginAs(s.user.email);
    // No model: a free question can't be set up.
    const refused = await ana.post('/hugo/tasks').send({ task: { kind: 'RECURRING', what: 'ASK', cadence: 'DAILY', time: '07:00', question: 'What is new?' } });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('hugo_no_model');

    calls.model = true;
    // An SSN never reaches the record or the model.
    const { task } = (await ana.post('/hugo/tasks').send({ task: { kind: 'RECURRING', what: 'ASK', cadence: 'DAILY', time: '07:00', question: 'Anything new for 123-45-6789 this week?' } })).body;
    expect(task.subject.recurring.question).not.toContain('123-45-6789');
    const first = new Date(task.result.recurring.nextAt);
    await sweep(new Date(first.getTime() + MIN));
    await flushPendingNotifications();
    expect(calls.inputs).toHaveLength(1);
    const input = calls.inputs[0]!;
    expect(input.tier).toBe('fast');
    expect(input.meter).toEqual({ userId: s.user.id, purpose: 'recurring' });
    expect(input.text).not.toContain('123-45-6789');
    const keys = input.tools.map((t) => t.key);
    expect(keys).toContain('SCHEDULE');
    expect(keys).not.toContain('PAYSTUB');
    const v = await view(ana, task.id);
    expect(v.events.at(-1)).toMatchObject({ code: 'DELIVERED', data: { what: 'ASK', tier: 'fast', source: 'model', model: 1 } });
    expect((await inApp(s.user.id))[0]).toMatchObject({ subject: 'Your question: Anything new for [number removed] this week?' });
  });

  it('an associate’s Hugo takes no free question by default, and one already set stops at its next run — no model call', async () => {
    pinMidweekNoon();
    const s = await store();
    const ana = await loginAs(s.user.email);
    calls.model = true;
    const { task } = (await ana.post('/hugo/tasks').send({ task: { kind: 'RECURRING', what: 'ASK', cadence: 'DAILY', time: '07:00', question: 'What is new?' } })).body;
    associatesOffTheModel();
    const refused = await ana.post('/hugo/tasks').send({ task: { kind: 'RECURRING', what: 'ASK', cadence: 'DAILY', time: '08:00', question: 'Who is on with me?' } });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('hugo_no_model');
    await sweep(new Date(new Date(task.result.recurring.nextAt).getTime() + MIN));
    await flushPendingNotifications();
    expect(calls.inputs).toHaveLength(0);
    const row = await prisma.hugoTask.findUniqueOrThrow({ where: { id: task.id }, include: { events: true } });
    expect(row.status).toBe('FAILED');
    expect(row.events.find((e) => e.code === 'FAILED')!.data).toEqual({ reason: 'not_available' });
  });

  it('the safety valve: over the tenant’s model runs for the day, "I’ll answer this one tomorrow" — same time tomorrow', async () => {
    pinMidweekNoon();
    (env as Record<string, unknown>).HUGO_RECURRING_DAILY_MODEL = 1;
    calls.model = true;
    const s = await store();
    const ana = await loginAs(s.user.email);
    const a = (await ana.post('/hugo/tasks').send({ task: { kind: 'RECURRING', what: 'ASK', cadence: 'WEEKLY', weekday: 4, time: '07:00', question: 'What is new?' } })).body.task;
    const b = (await ana.post('/hugo/tasks').send({ task: { kind: 'RECURRING', what: 'ASK', cadence: 'WEEKLY', weekday: 4, time: '07:00', question: 'Who is on with me?' } })).body.task;
    const due = new Date(a.result.recurring.nextAt);
    await sweep(new Date(due.getTime() + MIN));
    await flushPendingNotifications();
    expect(calls.inputs).toHaveLength(1);
    const [va, vb] = [await view(ana, a.id), await view(ana, b.id)];
    const deferred = [va, vb].find((x) => x.events.some((e: { code: string }) => e.code === 'DEFERRED'))!;
    expect(deferred).toBeDefined();
    // Weekly, but the held one comes back tomorrow at 7:00.
    expect(deferred.result.recurring.nextAt).toBe(nextRunAt({ cadence: 'DAILY', weekday: null, time: '07:00', timezone: CHI }, new Date(due.getTime() + MIN)).toISOString());
    expect((await inApp(s.user.id)).map((n) => n.body).some((b) => b.startsWith('I’ll answer this one tomorrow'))).toBe(true);
  });

  it('allowance used up: a plain line with when it’s back, and the registry’s answer when there is one — the schedule carries on', async () => {
    pinMidweekNoon();
    calls.model = true;
    calls.mode = 'allowance';
    const s = await store();
    const ana = await loginAs(s.user.email);
    const { task } = (await ana.post('/hugo/tasks').send({ task: { kind: 'RECURRING', what: 'ASK', cadence: 'DAILY', time: '07:00', question: 'When is my next shift?' } })).body;
    const first = new Date(task.result.recurring.nextAt);
    await s.shift(new Date(first.getTime() + D));
    await sweep(new Date(first.getTime() + MIN));
    await flushPendingNotifications();
    const v = await view(ana, task.id);
    expect(v.status).toBe('WAITING');
    expect(v.events.at(-1)).toMatchObject({ code: 'DELIVERED', data: { source: 'allowance' } });
    const body = (await inApp(s.user.id))[0]!.body;
    expect(body).toMatch(/^I’ve used this month’s thinking time, so your question is back on Fri, Nov 20\. Here’s what I can tell you:/);
    expect(body).toContain('Cashier');
    expect(v.result.recurring.nextAt).not.toBeNull();
  });
});

describe('the person’s say', () => {
  it('pause, resume, change the time, stop — their own only', async () => {
    pinMidweekNoon();
    const s = await store();
    const ana = await loginAs(s.user.email);
    const { task } = (await ana.post('/hugo/tasks').send({ task: { kind: 'RECURRING', what: 'SCHEDULE', cadence: 'DAILY', time: '07:00' } })).body;
    const first = new Date(task.result.recurring.nextAt);

    const paused = await ana.patch(`/hugo/recurring/${task.id}`).send({ paused: true });
    expect(paused.status).toBe(200);
    expect(paused.body.task).toMatchObject({ status: 'WAITING', subject: { recurring: { paused: true } }, result: { recurring: { nextAt: null } } });
    await sweep(new Date(first.getTime() + MIN));
    await flushPendingNotifications();
    expect(await inApp(s.user.id)).toHaveLength(0);

    const resumed = await ana.patch(`/hugo/recurring/${task.id}`).send({ paused: false });
    expect(resumed.body.task.subject.recurring.paused).toBe(false);
    expect(resumed.body.task.result.recurring.nextAt).not.toBeNull();

    // Every Monday at 9:30 instead.
    const moved = await ana.patch(`/hugo/recurring/${task.id}`).send({ cadence: 'WEEKLY', weekday: 1, time: '09:30' });
    expect(moved.body.task.subject.recurring).toMatchObject({ cadence: 'WEEKLY', weekday: 1, time: '09:30' });
    expect(moved.body.task.result.recurring.nextAt).toBe(nextRunAt({ cadence: 'WEEKLY', weekday: 1, time: '09:30', timezone: CHI }, new Date()).toISOString());
    expect(codes(moved.body.task)).toEqual(['STARTED', 'PAUSED', 'RESUMED', 'RESCHEDULED']);
    // Weekly needs its day.
    const daily = (await ana.post('/hugo/tasks').send({ task: { kind: 'RECURRING', what: 'PAYDAY', cadence: 'DAILY', time: '08:00' } })).body.task;
    expect((await ana.patch(`/hugo/recurring/${daily.id}`).send({ cadence: 'WEEKLY' })).status).toBe(400);
    expect((await ana.patch(`/hugo/recurring/${task.id}`).send({ time: '25:00' })).status).toBe(400);

    // Someone else's brief is not there for them.
    const ben = await createAssociate({ firstName: 'Ben', lastName: 'Moss' });
    const { user: benUser } = await createUser({ role: 'ASSOCIATE', associateId: ben.id });
    const benAgent = await loginAs(benUser.email);
    expect((await benAgent.patch(`/hugo/recurring/${task.id}`).send({ paused: true })).status).toBe(404);
    expect((await benAgent.post(`/hugo/tasks/${task.id}/cancel`).send({})).status).toBe(404);

    const stopped = await ana.post(`/hugo/tasks/${task.id}/cancel`).send({});
    expect(stopped.body.task.status).toBe('CANCELLED');
    expect((await ana.patch(`/hugo/recurring/${task.id}`).send({ paused: true })).status).toBe(409);

    await flushPendingAudits();
    const audits = await prisma.auditLog.findMany({ where: { action: 'hugo.recurring_changed' } });
    expect(audits).toHaveLength(3);
    expect(audits.map((a) => (a.metadata as { changes: string[] }).changes)).toEqual(expect.arrayContaining([['PAUSED'], ['RESUMED'], ['RESCHEDULED']]));
  });

  it('caps: the same brief twice is one; a sixth is refused', async () => {
    pinMidweekNoon();
    const s = await store();
    const ana = await loginAs(s.user.email);
    const one = { kind: 'RECURRING', what: 'SCHEDULE', cadence: 'DAILY', time: '07:00' };
    const a = await ana.post('/hugo/tasks').send({ task: one });
    const again = await ana.post('/hugo/tasks').send({ task: one });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ existing: true, task: { id: a.body.task.id } });
    for (const time of ['08:00', '09:00', '10:00', '11:00']) expect((await ana.post('/hugo/tasks').send({ task: { ...one, time } })).status).toBe(201);
    const sixth = await ana.post('/hugo/tasks').send({ task: { ...one, time: '12:00' } });
    expect(sixth.status).toBe(409);
    expect(sixth.body.error.code).toBe('too_many_recurring');
    // A desk's answer is not an associate's to repeat.
    expect((await ana.post('/hugo/tasks').send({ task: { ...one, what: 'COVERAGE' } })).status).toBe(409);
  });

  it('180 days: a week before, "keep going?" — it keeps sending meanwhile; Keep going adds 180 days; no answer ends it', async () => {
    pinMidweekNoon();
    const s = await store();
    const ana = await loginAs(s.user.email);
    const { task } = (await ana.post('/hugo/tasks').send({ task: { kind: 'RECURRING', what: 'SCHEDULE', cadence: 'DAILY', time: '07:00' } })).body;
    const first = new Date(task.result.recurring.nextAt);
    await s.shift(new Date(first.getTime() + 2 * D));
    await prisma.hugoTask.update({ where: { id: task.id }, data: { expiresAt: new Date(first.getTime() + 6 * D) } });

    await sweep(new Date(first.getTime() + MIN));
    await flushPendingNotifications();
    let v = await view(ana, task.id);
    expect(v).toMatchObject({ status: 'NEEDS_YOU', needs: 'KEEP_GOING', choices: ['KEEP_GOING', 'STOP'], seen: false });
    const ask = (await inApp(s.user.id)).find((n) => n.category === 'hugo_task_needs_you')!;
    expect(ask.subject).toBe('Keep these coming?');
    expect(ask.body).toMatch(/^I’ve been sending you your next shifts every day at 7:00 AM\. It ends on .+ unless you tap Keep going\./);
    expect(ask.body).toMatch(/AI agent/);
    expect((await ana.get('/hugo/summary')).body.needsYou).toBe(1);

    // Still sending while it waits on them.
    await sweep(new Date(first.getTime() + 2 * MIN));
    await flushPendingNotifications();
    v = await view(ana, task.id);
    expect(v.status).toBe('NEEDS_YOU');
    expect(codes(v)).toContain('DELIVERED');

    const kept = await ana.post(`/hugo/tasks/${task.id}/respond`).send({ choice: 'KEEP_GOING' });
    expect(kept.status).toBe(200);
    expect(kept.body.task).toMatchObject({ status: 'WAITING', needs: null });
    expect(codes(kept.body.task)).toContain('KEPT_GOING');
    expect(new Date(kept.body.task.expiresAt).getTime()).toBeGreaterThan(Date.now() + 179 * D);

    // Another, left unanswered past its end.
    const other = (await ana.post('/hugo/tasks').send({ task: { kind: 'RECURRING', what: 'PAYDAY', cadence: 'DAILY', time: '08:00' } })).body.task;
    await prisma.hugoTask.update({ where: { id: other.id }, data: { expiresAt: new Date(Date.now() - MIN) } });
    await sweep(new Date());
    await flushPendingNotifications();
    const ended = await view(ana, other.id);
    expect(ended.status).toBe('EXPIRED');
    const last = (await inApp(s.user.id)).at(-1)!;
    expect(last).toMatchObject({ subject: 'I’ve stopped a repeating message', linkUrl: '/?hugo=tasks' });
    expect(last.body).toMatch(/^I’ve stopped sending your next payday\. Start it again any time from Tasks\./);
  });

  it('a role that no longer has the answer stops the brief, and says why', async () => {
    pinMidweekNoon();
    const s = await store();
    const ana = await loginAs(s.user.email);
    const { task } = (await ana.post('/hugo/tasks').send({ task: { kind: 'RECURRING', what: 'SCHEDULE', cadence: 'DAILY', time: '07:00' } })).body;
    // Now an office account: "my next shifts" is an associate's answer.
    await prisma.user.update({ where: { id: s.user.id }, data: { role: 'HR_ADMINISTRATOR' } });
    await sweep(new Date(new Date(task.result.recurring.nextAt).getTime() + MIN));
    await flushPendingNotifications();
    const row = await prisma.hugoTask.findUniqueOrThrow({ where: { id: task.id }, include: { events: true } });
    expect(row.status).toBe('FAILED');
    expect(row.events.find((e) => e.code === 'FAILED')!.data).toEqual({ reason: 'not_available' });
    expect((await inApp(s.user.id))[0]!.body).toMatch(/^I can’t tell you your next shifts any more/);
  });
});
