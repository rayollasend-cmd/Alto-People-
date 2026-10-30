import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';

/**
 * Hugo's goals (lib/hugoGoals): the person hands Hugo an outcome; he plans,
 * watches, PROPOSES each step that would change something, and the person's
 * Approve runs it AS THEM through the product's own route. The model is
 * scripted here (runModelLoop stubbed): each step is a list of tool calls,
 * made through the very tools a step hands the model.
 */

type ToolFn = (args?: Record<string, unknown>) => Promise<string>;
type Step = (tools: Map<string, ToolFn>) => Promise<void>;
interface LoopInput {
  tier: string;
  system: string[];
  meter: { userId: string; purpose: string };
  tools: Array<{ name: string; run: ToolFn }>;
}

const model = vi.hoisted(() => ({ on: true, steps: [] as Step[], calls: [] as LoopInput[], fail: null as Error | null }));
vi.mock('../../lib/assistantModel.js', async (orig) => {
  const real = await orig<typeof import('../../lib/assistantModel.js')>();
  return {
    ...real,
    modelAvailable: () => model.on,
    runModelLoop: vi.fn(async (input: LoopInput) => {
      model.calls.push(input);
      if (model.fail) throw model.fail;
      const step = model.steps.shift();
      if (!step) throw new Error('the model was called with no step scripted');
      await step(new Map(input.tools.map((t) => [t.name, (a?: Record<string, unknown>) => t.run(a ?? {})])));
      return { content: [{ type: 'text', text: 'All set.' }], stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 } };
    }),
    // The chat's answer (routes/hugo answerAsk): its tools are the app's, scripted the same way.
    answerWithModel: vi.fn(async (input: { tools: Array<{ name: string; run: (a: Record<string, unknown>) => Promise<{ reply: string }> }> }) => {
      const step = model.steps.shift();
      if (!step) throw new Error('the model was called with no step scripted');
      await step(new Map(input.tools.map((t) => [t.name, async (a?: Record<string, unknown>) => (await t.run(a ?? {})).reply])));
      return { reply: 'I can work on that for you.', linkUrl: null, toolsUsed: [], handoff: null };
    }),
  };
});

import { createApp } from '../../app.js';
import { env } from '../../config/env.js';
import { ensureBuiltInAgents } from '../../lib/agents.js';
import { flushPendingAudits } from '../../lib/audit.js';
import { HugoAllowanceError } from '../../lib/hugoAllowance.js';
import { judgeGoalCall } from '../../lib/hugoGoalActions.js';
import { settleHugoGoals } from '../../lib/hugoGoals.js';
import { sweepHugoTasks } from '../../lib/hugoTasks.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { ALTO_TENANT_ID, runWithTenant } from '../../lib/tenant.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { pinMidweekNoon } from '../../../test/clock.js';

const app = () => createApp();
const H = 3_600_000;
const D = 24 * H;

beforeEach(async () => {
  await truncateAll();
  model.on = true;
  model.steps = [];
  model.calls = [];
  model.fail = null;
  await createUser({ role: 'HR_ADMINISTRATOR', email: 'owner@example.com' });
  await ensureBuiltInAgents(prisma, ALTO_TENANT_ID);
});

afterEach(async () => {
  await settleHugoGoals();
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

/** A store with Ana and Ben placed there, a supervisor, an open shift that fits Ana, and Ana's own shift. */
async function store() {
  const client = await createClient('Walmart 1234');
  const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  const place = async (firstName: string, lastName: string) => {
    const a = await createAssociate({ firstName, lastName });
    await prisma.application.create({ data: { associateId: a.id, clientId: client.id, onboardingTrack: 'STANDARD', status: 'APPROVED', approvedAt: new Date() } });
    await prisma.associateAssignment.create({ data: { associateId: a.id, locationId: site.id, startedAt: new Date(Date.now() - 30 * D) } });
    const { user } = await createUser({ role: 'ASSOCIATE', associateId: a.id });
    return { associate: a, user };
  };
  const ana = await place('Ana', 'Lopez');
  const ben = await place('Ben', 'Moss');
  const dana = await createAssociate({ firstName: 'Dana', lastName: 'Reyes' });
  const { user: supervisor } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id, associateId: dana.id });
  const shift = (associateId: string | null, startsAt: Date, position = 'Cashier') =>
    prisma.shift.create({
      data: {
        clientId: client.id,
        locationId: site.id,
        position,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 8 * H),
        status: associateId ? 'ASSIGNED' : 'OPEN',
        assignedAssociateId: associateId,
        publishedAt: new Date(),
      },
    });
  const open = await shift(null, new Date(Date.now() + 2 * D), 'Stocker');
  const mine = await shift(ana.associate.id, new Date(Date.now() + 3 * D));
  return { client, site, ana, ben, supervisor, open, mine, shift };
}

const sweep = async (at: Date = new Date()) => {
  await runWithTenant(ALTO_TENANT_ID, 'job', () => sweepHugoTasks(at));
  await settleHugoGoals();
};
const inApp = (userId: string) => prisma.notification.findMany({ where: { recipientUserId: userId, channel: 'IN_APP' }, orderBy: { createdAt: 'asc' } });
const codes = (task: { events: Array<{ code: string }> }) => task.events.map((e) => e.code);
/** The id on the first line of a find_options answer. */
const firstId = (text: string) => /([0-9a-f-]{36})/.exec(text)?.[1] ?? '';

async function startGoal(agent: TestAgent<Test>, goal: string) {
  const r = await agent.post('/hugo/tasks').send({ task: { kind: 'GOAL', goal }, source: 'panel' });
  await settleHugoGoals();
  return r;
}

describe('a goal: plan → watch → propose → approve as the person → finish', () => {
  it('a first step that only made the plan goes straight on to the first useful step — not tomorrow’s check-in', async () => {
    const s = await store();
    const ana = await loginAs(s.ana.user.email);
    // Step 1: the plan, nothing else (DeepSeek did exactly this live).
    model.steps.push(async (tools) => {
      await tools.get('update_plan')!({ steps: [{ text: 'Check my schedule for next week', state: 'doing' }, { text: 'Ask for a morning shift', state: 'todo' }] });
    });
    // Step 2: told it made the plan, it acts.
    let options = '';
    model.steps.push(async (tools) => {
      options = await tools.get('find_options')!({ action: 'PICK_UP_SHIFT' });
      await tools.get('propose')!({ action: 'PICK_UP_SHIFT', args: { shiftId: firstId(options) }, why: 'It adds eight hours.' });
    });
    const started = await startGoal(ana, 'Get me a few more hours next week, mornings if possible.');
    const id = started.body.task.id as string;
    let view = (await ana.get(`/hugo/tasks/${id}`)).body.task;
    expect(view.status).toBe('WORKING');
    expect(new Date(view.goal.nextCheckAt).getTime()).toBeLessThanOrEqual(Date.now());
    // The next sweep takes the second step at once — the 10-minute spacing doesn't hold it back.
    await sweep();
    expect(model.calls).toHaveLength(2);
    expect(model.calls[1]!.system.join('\n')).toContain('You made the plan');
    view = (await ana.get(`/hugo/tasks/${id}`)).body.task;
    expect(view).toMatchObject({ status: 'NEEDS_YOU', needs: 'GOAL_APPROVAL' });
    // Only the first step continues like this: the third waits for its check-in.
    expect(model.steps).toHaveLength(0);
  });

  it('plans in the background, proposes with a notice, and Approve runs the product route as the person', async () => {
    const s = await store();
    const ana = await loginAs(s.ana.user.email);
    let options = '';
    model.steps.push(async (tools) => {
      expect([...tools.keys()]).toEqual(expect.arrayContaining(['my_next_shifts', 'update_plan', 'find_options', 'propose', 'start_watch', 'tell_person', 'check_back', 'finish']));
      expect(await tools.get('update_plan')!({ steps: [{ text: 'Find open shifts that fit', state: 'doing' }, { text: 'Ask for the best one', state: 'todo' }, { text: 'Check it was approved', state: 'todo' }] })).toContain('Plan saved');
      expect(await tools.get('start_watch')!({ kind: 'WATCH_PAYCHECK' })).toContain('Watching');
      options = await tools.get('find_options')!({ action: 'PICK_UP_SHIFT' });
      expect(await tools.get('propose')!({ action: 'PICK_UP_SHIFT', args: { shiftId: firstId(options) }, why: 'It adds eight hours.' })).toContain('Proposed');
      // The step is over: nothing more is taken.
      expect(await tools.get('update_plan')!({ steps: [{ text: 'x', state: 'todo' }] })).toContain('step is over');
    });

    const started = await startGoal(ana, 'Get me more hours next week — my SSN is 123-45-6789');
    expect(started.status).toBe(201);
    expect(started.body.task).toMatchObject({ kind: 'GOAL', status: 'WORKING', source: 'panel' });
    // Never an SSN, anywhere it is kept.
    expect(JSON.stringify(started.body)).not.toContain('123-45-6789');
    expect(started.body.task.goal.text).toContain('Get me more hours next week');
    const id = started.body.task.id as string;
    expect(options).toContain(s.open.id);
    expect(options).toContain('Stocker');

    // The first step planned on the strongest tier, charged to Ana as a goal, with her goal and language in the prompt.
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]!.tier).toBe('deep');
    expect(model.calls[0]!.meter).toEqual({ userId: s.ana.user.id, purpose: 'goal' });
    const prompt = model.calls[0]!.system.join('\n');
    expect(prompt).toContain('Get me more hours next week');
    expect(prompt).not.toContain('123-45-6789');
    expect(prompt).toContain('"en"');
    expect(prompt).toContain('Today is');
    expect(prompt).toContain('first step');

    let view = (await ana.get(`/hugo/tasks/${id}`)).body.task;
    expect(view).toMatchObject({ status: 'NEEDS_YOU', needs: 'GOAL_APPROVAL', choices: ['APPROVE', 'DECLINE', 'STOP'], progress: { done: 0, total: 3 } });
    expect(view.goal.plan.map((p: { state: string }) => p.state)).toEqual(['doing', 'todo', 'todo']);
    expect(view.goal.pending).toMatchObject({ action: 'PICK_UP_SHIFT', why: 'It adds eight hours.' });
    expect(view.goal.pending.title).toContain('Stocker');
    expect(view.goal.pending.run).toBeUndefined();
    expect(codes(view)).toEqual(['STARTED', 'STEP', 'PLANNED', 'WATCH_STARTED', 'PROPOSED']);
    expect(view.goal.steps).toEqual({ used: 1, max: env.HUGO_GOAL_MAX_STEPS });

    // The watch is the goal's child, started as Ana.
    const child = await prisma.hugoTask.findFirstOrThrow({ where: { parentId: id } });
    expect(child).toMatchObject({ kind: 'WATCH_PAYCHECK', userId: s.ana.user.id, source: 'goal', status: 'WAITING' });

    // One notice: what to approve, with the AI disclosure and Hugo's id.
    await flushPendingNotifications();
    const asked = (await inApp(s.ana.user.id)).filter((n) => n.category?.startsWith('hugo_'));
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ category: 'hugo_task_needs_you', subject: 'One step to approve for your goal', linkUrl: `/?hugo=task:${id}` });
    expect(asked[0]!.body).toContain('Stocker');
    expect(asked[0]!.body).toMatch(/AI agent/);
    expect(asked[0]!.byAgentId).not.toBeNull();

    // Nothing changed before the tap.
    expect(await prisma.openShiftClaim.count()).toBe(0);

    // Approve: the claim route runs as Ana — the record changes and the route writes its own audit, as her.
    model.steps.push(async (tools) => {
      expect(await tools.get('tell_person')!({ message: 'I asked for the Stocker shift; your manager decides.' })).toContain('Noted');
      expect(await tools.get('check_back')!({ hours: 24 })).toContain('24 hours');
    });
    const approved = await ana.post(`/hugo/tasks/${id}/respond`).send({ choice: 'APPROVE' });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.task.goal.last).toMatchObject({ action: 'PICK_UP_SHIFT', outcome: 'done', code: null, linkUrl: '/marketplace' });
    expect(approved.body.task.goal.pending).toBeNull();
    const claim = await prisma.openShiftClaim.findFirstOrThrow({ where: { shiftId: s.open.id } });
    expect(claim).toMatchObject({ associateId: s.ana.associate.id, status: 'PENDING' });
    await settleHugoGoals();
    await flushPendingAudits();
    const routeAudit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'shift.pickup_requested', entityId: s.open.id } });
    expect(routeAudit.actorUserId).toBe(s.ana.user.id);
    const goalAudit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'hugo.goal_step_run', entityId: id } });
    expect(goalAudit.metadata).toMatchObject({ action: 'PICK_UP_SHIFT', outcome: 'done', via: 'assistant' });
    // Kinds and outcomes on the trail — never her words.
    expect(JSON.stringify(goalAudit.metadata)).not.toContain('hours');

    // The check-in after the approval was quick (no deliberation) and told her once.
    expect(model.calls[1]!.tier).toBe('fast');
    expect(model.calls[1]!.system.join('\n')).toContain('They approved');
    view = (await ana.get(`/hugo/tasks/${id}`)).body.task;
    expect(view.status).toBe('WORKING');
    expect(codes(view).slice(-3)).toEqual(['STEP_DONE', 'STEP', 'UPDATE']);
    expect(new Date(view.goal.nextCheckAt).getTime()).toBeGreaterThan(Date.now() + 23 * H);
    await flushPendingNotifications();
    const update = (await inApp(s.ana.user.id)).find((n) => n.subject === 'An update on your goal');
    expect(update?.body).toContain('I asked for the Stocker shift');
    expect(update?.body).toMatch(/AI agent/);

    // A day later: done. What it started stops, and she is told.
    model.steps.push(async (tools) => {
      expect(await tools.get('tell_person')!({ message: 'second' })).toBeTruthy();
      expect(await tools.get('finish')!({ outcome: 'DONE', summary: 'You asked for the Stocker shift; it adds eight hours.' })).toContain('Closed');
    });
    await sweep(new Date(Date.now() + 25 * H));
    view = (await ana.get(`/hugo/tasks/${id}`)).body.task;
    expect(view).toMatchObject({ status: 'DONE', goal: { outcome: 'DONE', summary: 'You asked for the Stocker shift; it adds eight hours.' } });
    expect((await prisma.hugoTask.findUniqueOrThrow({ where: { id: child.id } })).status).toBe('CANCELLED');
    await flushPendingNotifications();
    expect((await inApp(s.ana.user.id)).some((n) => n.subject === 'Your goal is done')).toBe(true);
  });

  it('a refusal by the product route is shown plainly in place; a request for time off lands as hers', async () => {
    const s = await store();
    const ana = await loginAs(s.ana.user.email);
    model.steps.push(async (tools) => {
      const options = await tools.get('find_options')!({ action: 'PICK_UP_SHIFT' });
      await tools.get('propose')!({ action: 'PICK_UP_SHIFT', args: { shiftId: firstId(options) } });
    });
    const { id } = (await startGoal(ana, 'More hours this week')).body.task;
    // Someone else takes the shift before she approves.
    await prisma.shift.update({ where: { id: s.open.id }, data: { status: 'ASSIGNED', assignedAssociateId: s.ben.associate.id } });
    model.steps.push(async (tools) => {
      const day = new Date(Date.now() + 10 * D);
      const ymd = `${day.getUTCFullYear()}-${String(day.getUTCMonth() + 1).padStart(2, '0')}-${String(day.getUTCDate()).padStart(2, '0')}`;
      expect(await tools.get('propose')!({ action: 'REQUEST_TIME_OFF', args: { startDate: ymd, endDate: ymd, category: 'VACATION', hours: 8, reason: 'Family visit' } })).toContain('Proposed');
    });
    const r = await ana.post(`/hugo/tasks/${id}/respond`).send({ choice: 'APPROVE' });
    expect(r.body.task.goal.last).toMatchObject({ outcome: 'refused', code: 'shift_not_available', linkUrl: null });
    await settleHugoGoals();
    const view = (await ana.get(`/hugo/tasks/${id}`)).body.task;
    expect(view.goal.pending).toMatchObject({ action: 'REQUEST_TIME_OFF' });
    expect(view.goal.pending.detail).toContain('8 h');
    expect(await prisma.timeOffRequest.count()).toBe(0);
    const ok = await ana.post(`/hugo/tasks/${id}/respond`).send({ choice: 'APPROVE' });
    expect(ok.body.task.goal.last).toMatchObject({ action: 'REQUEST_TIME_OFF', outcome: 'done', linkUrl: '/time-off' });
    const req = await prisma.timeOffRequest.findFirstOrThrow();
    expect(req).toMatchObject({ associateId: s.ana.associate.id, status: 'PENDING', category: 'VACATION', requestedMinutes: 480 });
    model.steps.push(async () => {});
    await settleHugoGoals();
  });

  it('decline re-plans on the strongest tier and says why; a proposal is checked against her records now', async () => {
    const s = await store();
    const ana = await loginAs(s.ana.user.email);
    model.steps.push(async (tools) => {
      // An id from someone else's records is refused in words the model can act on.
      expect(await tools.get('propose')!({ action: 'FIND_COVER', args: { shiftId: s.open.id } })).toContain('Not proposed');
      // Desk actions are not hers.
      expect(await tools.get('propose')!({ action: 'OFFER_SHIFT', args: { shiftId: s.open.id, associateId: s.ben.associate.id } })).toContain('not something this person can do');
      const options = await tools.get('find_options')!({ action: 'FIND_COVER' });
      expect(options).toContain(s.mine.id);
      await tools.get('propose')!({ action: 'FIND_COVER', args: { shiftId: s.mine.id }, why: 'You asked for the day off.' });
    });
    const { id } = (await startGoal(ana, 'Get my Saturday off')).body.task;
    let view = (await ana.get(`/hugo/tasks/${id}`)).body.task;
    expect(view.goal.pending).toMatchObject({ action: 'FIND_COVER' });

    model.steps.push(async (tools) => {
      await tools.get('check_back')!({ hours: 6 });
    });
    const declined = await ana.post(`/hugo/tasks/${id}/respond`).send({ choice: 'DECLINE' });
    expect(declined.status).toBe(200);
    expect(codes(declined.body.task).at(-1)).toBe('STEP_DECLINED');
    await settleHugoGoals();
    expect(model.calls[1]!.tier).toBe('deep');
    expect(model.calls[1]!.system.join('\n')).toContain('They declined');
    view = (await ana.get(`/hugo/tasks/${id}`)).body.task;
    expect(view.status).toBe('WORKING');
    // Nothing was asked of anyone.
    expect(await prisma.shiftSwapRequest.count()).toBe(0);
  });

  it('approving a cover ask starts it as her task, linked to the goal; its news wakes the goal', async () => {
    const s = await store();
    const ana = await loginAs(s.ana.user.email);
    model.steps.push(async (tools) => {
      await tools.get('propose')!({ action: 'FIND_COVER', args: { shiftId: s.mine.id } });
    });
    const { id } = (await startGoal(ana, 'Get my Saturday off')).body.task;
    model.steps.push(async (tools) => {
      await tools.get('check_back')!({ hours: 48 });
    });
    const r = await ana.post(`/hugo/tasks/${id}/respond`).send({ choice: 'APPROVE' });
    expect(r.body.task.goal.last).toMatchObject({ action: 'FIND_COVER', outcome: 'done' });
    await settleHugoGoals();
    const cover = await prisma.hugoTask.findFirstOrThrow({ where: { kind: 'FIND_COVER' } });
    expect(cover).toMatchObject({ parentId: id, source: 'goal', userId: s.ana.user.id });
    expect(r.body.task.goal.last.linkUrl).toBe(`/?hugo=task:${cover.id}`);
    // Ben was asked (the cover task's own first step).
    expect(await prisma.shiftSwapRequest.count({ where: { shiftId: s.mine.id, status: 'PENDING_PEER' } })).toBe(1);
    const before = await prisma.hugoTask.findUniqueOrThrow({ where: { id } });
    expect(before.nextCheckAt.getTime()).toBeGreaterThan(Date.now() + 40 * H);
    // Ana stops the cover task herself: the goal looks again.
    await ana.post(`/hugo/tasks/${cover.id}/cancel`).send({});
    const after = await prisma.hugoTask.findUniqueOrThrow({ where: { id } });
    expect(after.nextCheckAt.getTime()).toBeLessThanOrEqual(Date.now());
  });
});

describe('what a step may decide', () => {
  it('one update a day per goal; a goal may ask to run longer, never past 30 days', async () => {
    pinMidweekNoon();
    const s = await store();
    const ana = await loginAs(s.ana.user.email);
    model.steps.push(async (tools) => {
      expect(await tools.get('tell_person')!({ message: 'Looking at next week now.' })).toContain('Noted');
      expect(await tools.get('tell_person')!({ message: 'again' })).toContain('already wrote');
      expect(await tools.get('set_end_date')!({ days: 45, why: 'Next month' })).toContain('30 days is the longest');
      await tools.get('check_back')!({ hours: 1 });
    });
    const { id, createdAt } = (await startGoal(ana, 'Keep my documents current')).body.task;
    const row = await prisma.hugoTask.findUniqueOrThrow({ where: { id } });
    expect(row.expiresAt.getTime()).toBe(new Date(createdAt).getTime() + 30 * D);
    model.steps.push(async (tools) => {
      expect(await tools.get('tell_person')!({ message: 'Second today.' })).toContain('already told them something today');
      await tools.get('check_back')!({ hours: 6 });
    });
    await sweep(new Date(Date.now() + 61 * 60_000));
    expect(model.calls).toHaveLength(2);
    const view = (await ana.get(`/hugo/tasks/${id}`)).body.task;
    expect(view.events.filter((e: { code: string }) => e.code === 'UPDATE')).toHaveLength(1);
    // Every step is charged to the goal's owner.
    expect(model.calls.every((c) => c.meter.userId === s.ana.user.id)).toBe(true);
  });
});

describe('stopping a goal', () => {
  it('STOP on a proposal cancels the goal and everything it started; cancel does the same while it works', async () => {
    const s = await store();
    const ana = await loginAs(s.ana.user.email);
    model.steps.push(async (tools) => {
      await tools.get('start_watch')!({ kind: 'WATCH_PAYCHECK' });
      const options = await tools.get('find_options')!({ action: 'PICK_UP_SHIFT' });
      await tools.get('propose')!({ action: 'PICK_UP_SHIFT', args: { shiftId: firstId(options) } });
    });
    const { id } = (await startGoal(ana, 'More hours')).body.task;
    const stop = await ana.post(`/hugo/tasks/${id}/respond`).send({ choice: 'STOP' });
    expect(stop.body.task.status).toBe('CANCELLED');
    expect(await prisma.hugoTask.count({ where: { parentId: id, status: 'CANCELLED' } })).toBe(1);
    expect(await prisma.openShiftClaim.count()).toBe(0);

    model.steps.push(async (tools) => {
      await tools.get('start_watch')!({ kind: 'WATCH_OPEN_SHIFTS', days: 3 });
      await tools.get('check_back')!({ hours: 12 });
    });
    const second = (await startGoal(ana, 'Watch for weekend shifts')).body.task;
    const kids = await prisma.hugoTask.findMany({ where: { parentId: second.id } });
    expect(kids).toHaveLength(1);
    const cancelled = await ana.post(`/hugo/tasks/${second.id}/cancel`).send({});
    expect(cancelled.body.task.status).toBe('CANCELLED');
    const kid = await prisma.hugoTask.findUniqueOrThrow({ where: { id: kids[0]!.id } });
    // Already done (the open shift fit at once) or stopped with the goal — never left running.
    expect(['CANCELLED', 'DONE']).toContain(kid.status);
  });
});

describe('caps: spend is bounded and a pause is never silent', () => {
  it('a goal that used its steps asks to keep going; Keep going gives it more', async () => {
    const s = await store();
    const ana = await loginAs(s.ana.user.email);
    model.steps.push(async (tools) => {
      await tools.get('check_back')!({ hours: 2 });
    });
    const { id } = (await startGoal(ana, 'More hours')).body.task;
    const row = await prisma.hugoTask.findUniqueOrThrow({ where: { id } });
    await prisma.hugoTask.update({ where: { id }, data: { state: { ...(row.state as object), steps: env.HUGO_GOAL_MAX_STEPS } } });
    await sweep(new Date(Date.now() + 3 * H));
    expect(model.calls).toHaveLength(1);
    let view = (await ana.get(`/hugo/tasks/${id}`)).body.task;
    expect(view).toMatchObject({ status: 'NEEDS_YOU', needs: 'KEEP_GOING', choices: ['KEEP_GOING', 'STOP'], goal: { pending: { action: 'KEEP_GOING' } } });
    expect(view.events.at(-1)).toMatchObject({ code: 'PAUSED', data: { why: 'steps' } });
    await flushPendingNotifications();
    expect((await inApp(s.ana.user.id)).some((n) => n.subject === 'Keep working on your goal?')).toBe(true);

    model.steps.push(async (tools) => {
      await tools.get('check_back')!({ hours: 2 });
    });
    const kept = await ana.post(`/hugo/tasks/${id}/respond`).send({ choice: 'KEEP_GOING' });
    // (Its line is at the real clock — before the swept step's, which ran three hours ahead.)
    expect(codes(kept.body.task)).toContain('KEPT_GOING');
    await settleHugoGoals();
    expect(model.calls).toHaveLength(2);
    view = (await ana.get(`/hugo/tasks/${id}`)).body.task;
    expect(view.status).toBe('WORKING');
    expect(view.goal.steps).toEqual({ used: env.HUGO_GOAL_MAX_STEPS + 1, max: 2 * env.HUGO_GOAL_MAX_STEPS });
  });

  it("the organization's steps for the day: paused to tomorrow with one line, no model call", async () => {
    const s = await store();
    const ana = await loginAs(s.ana.user.email);
    model.steps.push(async (tools) => {
      await tools.get('check_back')!({ hours: 1 });
    });
    const { id } = (await startGoal(ana, 'More hours')).body.task;
    const saved = env.HUGO_GOAL_DAILY_STEPS;
    (env as { HUGO_GOAL_DAILY_STEPS: number }).HUGO_GOAL_DAILY_STEPS = 1;
    try {
      const at = new Date(Date.now() + 61 * 60_000);
      await prisma.hugoTask.update({ where: { id }, data: { nextCheckAt: at } });
      await sweep(at);
      await sweep(new Date(at.getTime() + 60_000));
      expect(model.calls).toHaveLength(1);
      const view = (await ana.get(`/hugo/tasks/${id}`)).body.task;
      expect(view.status).toBe('WORKING');
      expect(view.events.filter((e: { code: string }) => e.code === 'PAUSED')).toHaveLength(1);
      expect(view.goal.paused).toMatchObject({ why: 'daily' });
      expect(new Date(view.goal.nextCheckAt).getTime()).toBeGreaterThan(at.getTime());
    } finally {
      (env as { HUGO_GOAL_DAILY_STEPS: number }).HUGO_GOAL_DAILY_STEPS = saved;
    }
  });

  it('two of its own steps are at least the gap apart; a used-up allowance waits until it renews', async () => {
    const s = await store();
    const ana = await loginAs(s.ana.user.email);
    model.steps.push(async (tools) => {
      await tools.get('check_back')!({ hours: 1 });
    });
    const { id } = (await startGoal(ana, 'More hours')).body.task;
    const first = await prisma.hugoTask.findUniqueOrThrow({ where: { id } });
    const lastStepAt = new Date((first.state as { lastStepAt: string }).lastStepAt);
    // A watch's news woke it three minutes later: it waits out the gap without thinking.
    const at = new Date(lastStepAt.getTime() + 3 * 60_000);
    await prisma.hugoTask.update({ where: { id }, data: { nextCheckAt: at } });
    await sweep(at);
    expect(model.calls).toHaveLength(1);
    const spaced = await prisma.hugoTask.findUniqueOrThrow({ where: { id } });
    expect(spaced.nextCheckAt.getTime()).toBe(lastStepAt.getTime() + env.HUGO_GOAL_STEP_GAP_MINUTES * 60_000);

    // Her allowance is used up: it waits until it renews, and says so once.
    const renewsAt = new Date(Date.now() + 9 * D);
    model.fail = new HugoAllowanceError(renewsAt);
    await sweep(new Date(spaced.nextCheckAt.getTime() + 1));
    const view = (await ana.get(`/hugo/tasks/${id}`)).body.task;
    expect(view.status).toBe('WAITING');
    expect(view.events.at(-1)).toMatchObject({ code: 'PAUSED', data: { why: 'allowance', until: renewsAt.toISOString() } });
    expect(view.goal.paused).toEqual({ why: 'allowance', until: renewsAt.toISOString() });
    expect(new Date(view.goal.nextCheckAt).getTime()).toBe(renewsAt.getTime());
  });
});

describe('only the person, only their reach, only with a model', () => {
  it('a revoked role stops the goal and what it started', async () => {
    const s = await store();
    const ana = await loginAs(s.ana.user.email);
    model.steps.push(async (tools) => {
      await tools.get('start_watch')!({ kind: 'WATCH_PAYCHECK' });
      await tools.get('check_back')!({ hours: 1 });
    });
    const { id } = (await startGoal(ana, 'More hours')).body.task;
    // No longer an associate: Hugo has nothing of hers to work with.
    await prisma.user.update({ where: { id: s.ana.user.id }, data: { associateId: null } });
    await sweep(new Date(Date.now() + 2 * H));
    expect(model.calls).toHaveLength(1);
    const row = await prisma.hugoTask.findUniqueOrThrow({ where: { id }, include: { events: true } });
    expect(row.status).toBe('FAILED');
    expect(row.events.find((e) => e.code === 'FAILED')?.data).toEqual({ reason: 'no_access' });
    expect(await prisma.hugoTask.count({ where: { parentId: id, status: { in: ['WORKING', 'WAITING', 'NEEDS_YOU'] } } })).toBe(0);
  });

  it("another person's goal is 404 to read, answer or stop; another organization's is never served", async () => {
    const s = await store();
    const ana = await loginAs(s.ana.user.email);
    model.steps.push(async (tools) => {
      const options = await tools.get('find_options')!({ action: 'PICK_UP_SHIFT' });
      await tools.get('propose')!({ action: 'PICK_UP_SHIFT', args: { shiftId: firstId(options) } });
    });
    const { id } = (await startGoal(ana, 'More hours')).body.task;
    const ben = await loginAs(s.ben.user.email);
    expect((await ben.get(`/hugo/tasks/${id}`)).status).toBe(404);
    expect((await ben.post(`/hugo/tasks/${id}/respond`).send({ choice: 'APPROVE' })).status).toBe(404);
    expect((await ben.post(`/hugo/tasks/${id}/cancel`).send({})).status).toBe(404);
    expect((await ben.get('/hugo/tasks')).body.tasks).toEqual([]);
    expect(await prisma.openShiftClaim.count()).toBe(0);

    const T2 = '00000000-0000-4000-8000-0000000000b2';
    await prisma.tenant.create({ data: { id: T2, slug: 'tenant-goals', name: 'Tenant Goals' } });
    const { user: other } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'admin@tenant-goals.example' });
    await prisma.user.update({ where: { id: other.id }, data: { tenantId: T2 } });
    const t2 = await loginAs(other.email);
    for (const r of [await t2.get(`/hugo/tasks/${id}`), await t2.post(`/hugo/tasks/${id}/respond`).send({ choice: 'APPROVE' })]) {
      expect(r.status).not.toBe(200);
      expect(JSON.stringify(r.body)).not.toContain('More hours');
    }
    expect((await prisma.hugoTask.findUniqueOrThrow({ where: { id } })).status).toBe('NEEDS_YOU');
  });

  it('no model: a plain 409; three open goals at most; the same goal twice is one', async () => {
    const s = await store();
    const ana = await loginAs(s.ana.user.email);
    model.on = false;
    const off = await ana.post('/hugo/tasks').send({ task: { kind: 'GOAL', goal: 'More hours' } });
    expect(off.status).toBe(409);
    expect(off.body.error.code).toBe('hugo_no_model');
    model.on = true;
    for (const goal of ['More hours', 'Keep my documents current', 'Get Friday off']) {
      model.steps.push(async (tools) => {
        await tools.get('check_back')!({ hours: 12 });
      });
      expect((await startGoal(ana, goal)).status).toBe(201);
    }
    const again = await ana.post('/hugo/tasks').send({ task: { kind: 'GOAL', goal: 'more   HOURS' } });
    expect(again.status).toBe(200);
    expect(again.body.existing).toBe(true);
    const fourth = await ana.post('/hugo/tasks').send({ task: { kind: 'GOAL', goal: 'Something else' } });
    expect(fourth.status).toBe(409);
    expect(fourth.body.error.code).toBe('too_many_goals');
  });
});

describe('a desk goal', () => {
  it('a scheduler proposes giving an open shift to a named worker; Approve assigns it through the assign route', async () => {
    const s = await store();
    const { user: desk } = await createUser({ role: 'OPERATIONS_MANAGER' });
    const ops = await loginAs(desk.email);
    model.steps.push(async (tools) => {
      expect(await tools.has('start_watch')).toBe(false);
      const list = await tools.get('find_options')!({ action: 'OFFER_SHIFT', query: 'Moss' });
      expect(list).toContain(`shift ${s.open.id}`);
      expect(list).toContain(`person ${s.ben.associate.id}`);
      expect(await tools.get('propose')!({ action: 'OFFER_SHIFT', args: { shiftId: s.open.id, associateId: s.ben.associate.id } })).toContain('Proposed');
    });
    const { id } = (await startGoal(ops, 'Keep this week fully staffed')).body.task;
    const view = (await ops.get(`/hugo/tasks/${id}`)).body.task;
    expect(view.goal.pending.title).toContain('Ben Moss');
    model.steps.push(async (tools) => {
      await tools.get('check_back')!({ hours: 4 });
    });
    const r = await ops.post(`/hugo/tasks/${id}/respond`).send({ choice: 'APPROVE' });
    expect(r.body.task.goal.last).toMatchObject({ action: 'OFFER_SHIFT', outcome: 'done', linkUrl: '/scheduling' });
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: s.open.id } })).assignedAssociateId).toBe(s.ben.associate.id);
    await settleHugoGoals();
  });
});

describe('starting a goal from the chat', () => {
  it('the model offers a goal for an outcome: a Start card, nothing started', async () => {
    const s = await store();
    const ana = await loginAs(s.ana.user.email);
    model.steps.push(async (tools) => {
      expect(await tools.get('offer_goal')!({ goal: 'Get me 40 hours next week' })).toContain('Start card');
      expect(await tools.get('offer_goal')!({ goal: 'Another one' })).toContain('already offered');
    });
    const r = await ana.post('/hugo/ask').send({ text: 'Could you work on getting me 40 hours next week?' });
    expect(r.status).toBe(200);
    expect(r.body, JSON.stringify(r.body)).toMatchObject({ source: 'model' });
    expect(r.body.offers).toEqual([{ task: { kind: 'GOAL', goal: 'Get me 40 hours next week' }, subject: { goal: 'Get me 40 hours next week' } }]);
    expect(await prisma.hugoTask.count()).toBe(0);
  });
});

describe('how a route answer reads', () => {
  it('done, sent for approval (202 or pending), or refused with its code; a 2xx that did nothing is refused', () => {
    expect(judgeGoalCall('PICK_UP_SHIFT', 201, { id: 'x' })).toEqual({ outcome: 'done', code: null });
    expect(judgeGoalCall('OFFER_SHIFT', 202, { pending: true, approvalId: 'a' })).toEqual({ outcome: 'pending', code: null });
    expect(judgeGoalCall('OFFER_SHIFT', 200, { pending: true })).toEqual({ outcome: 'pending', code: null });
    expect(judgeGoalCall('PICK_UP_SHIFT', 409, { error: { code: 'already_requested', message: 'x' } })).toEqual({ outcome: 'refused', code: 'already_requested' });
    expect(judgeGoalCall('ASK_SUPERVISOR', 200, { sent: false })).toEqual({ outcome: 'refused', code: 'no_supervisor' });
    expect(judgeGoalCall('MESSAGE_CREW', 200, { sent: 0, notConfigured: 'No SMS provider' })).toEqual({ outcome: 'refused', code: 'texting_off' });
    expect(judgeGoalCall('MESSAGE_CREW', 500, null)).toEqual({ outcome: 'refused', code: 'http_500' });
  });
});
