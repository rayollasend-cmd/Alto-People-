import type { Request } from 'express';
import type { HugoTask, HugoTaskEvent } from '@prisma/client';
import {
  HUGO_GOAL_MAX_PLAN,
  HUGO_GOAL_STEP_STATES,
  ROLE_LABELS,
  redactSensitiveNumbers,
  type HugoGoalProposal,
  type HugoGoalStep,
  type HugoGoalStepResult,
  type HugoGoalView,
  type HugoTaskChoice,
  type HugoTaskCreate,
  type HugoTaskStatus,
  type HugoTaskSubject,
} from '@alto-people/shared';
import { env } from '../config/env.js';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import type { SessionUser } from '../types/express.js';
import { logBuiltInAgentAction } from './agents.js';
import { dispatchAsUser } from './assistantActions.js';
import { modelAvailable, type AssistantTool } from './assistantModel.js';
import { modelAvailableFor } from './hugoModelGate.js';
import { enqueueAudit } from './audit.js';
import { getBrandingSync } from './branding.js';
import { allowanceStatus, HugoAllowanceError, modelServes } from './hugoAllowance.js';
import { GOAL_NOTICE, GOAL_STEP_WORDS } from './hugoGoalCopy.js';
import { GoalActionRefusal, describeGoalActions, goalActionOptions, goalActionsFor, judgeGoalCall, prepareGoalAction, type GoalActionCtx, type GoalRun } from './hugoGoalActions.js';
import { runGoalStep } from './hugoGoalModel.js';
import { registryForUser } from './hugoRegistry.js';
import { startHugoTask, stopChildTasks, type HugoCtx, type HugoOutcome, type HugoPrepared } from './hugoTasks.js';
import { payTools } from './payAssistantTools.js';
import { runWithTenant } from './tenant.js';
import { memoryForChannel } from './hugoMemory.js';
import { companyWorkweek, orgDateKey } from './timeAnomalies.js';
import { addDaysInZone, zonedWallTimeToUtcInstant } from './timezone.js';

/**
 * Hugo's goals (Muse phase 3): the person hands Hugo an outcome in their own
 * words — "get me 40 hours next week", "keep tomorrow fully staffed" — and he
 * plans it, reads their records, watches for what matters, proposes each
 * thing that would change something, and comes back when he needs them.
 *
 * A goal IS a HugoTask of kind GOAL (lib/hugoTasks), so its trail, NEEDS_YOU,
 * notices, the badge, the Tasks tab and the sweep are the tasks' own. What is
 * a goal's:
 *
 *   startGoal / prepareGoal  needs the model on (else a plain 409
 *                            'hugo_no_model'); three open per person; ends in
 *                            14 days; any SSN or account number taken out
 *   stepGoal                 ONE model step per advance (lib/hugoGoalModel):
 *                            planning — the first step, and after the person
 *                            declined something — thinks ('deep'); a check-in
 *                            doesn't ('fast'). Read tools are the person's own
 *                            registry and pay tools, fresh, with their reach
 *                            now (a revoked role stops the goal). The model
 *                            may update_plan, start_watch (a WATCH_* child —
 *                            watching changes nothing), propose (an action
 *                            from lib/hugoGoalActions, checked against their
 *                            records now — the goal waits on them,
 *                            GOAL_APPROVAL), tell_person (one update a day),
 *                            check_back, finish
 *   answerGoal               the person's answer: APPROVE runs the proposal AS
 *                            THEM through the product's own route
 *                            (dispatchAsUser from their own request) or starts
 *                            the child task; DECLINE re-plans around it;
 *                            KEEP_GOING gives it more steps; STOP cancels it
 *                            and everything it started
 *
 *   Caps (config/env): HUGO_GOAL_MAX_STEPS steps per goal, then it asks to
 *   keep going (KEEP_GOING); HUGO_GOAL_STEP_GAP_MINUTES between two of its own
 *   steps (the person's answer may wake it sooner); HUGO_GOAL_DAILY_STEPS per
 *   organization per company day, then "I'll pick this up tomorrow"; and each
 *   person's monthly allowance (lib/hugoAllowance) — used up, the goal waits
 *   until it renews. A cap pauses with a line on the trail, never silently.
 *
 *   On Hugo's agent trail and the audit log: kinds, actions, tiers, outcomes,
 *   counts — never the person's words.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const GOAL_DAYS = 14;
/** The longest a goal may run, from its start, when the model asks (set_end_date). */
const GOAL_MAX_DAYS = 30;
const DEFAULT_CHECK_HOURS = 12;
const MAX_CHILDREN = 4;
const STALE_CLAIM_MS = 2 * MIN;
const TRAIL_LINES = 24;
/** Goal steps a server runs at once from the sweep; the rest wait for the next sweep. */
const MAX_CONCURRENT_STEPS = 4;
const WATCH_KINDS = ['WATCH_TIME_OFF', 'WATCH_OPEN_SHIFTS', 'WATCH_PAYCHECK', 'WATCH_DOCUMENT'] as const;
type WatchKind = (typeof WATCH_KINDS)[number];

/** Why Hugo is looking: the person's answers wake a goal at once; the rest keep their spacing. */
type Wake = 'start' | 'continue' | 'approved' | 'declined' | 'kept_going' | null;

interface PendingStep extends HugoGoalProposal {
  run: GoalRun | null;
  linkUrl: string | null;
}

interface GoalState {
  plan: HugoGoalStep[];
  pending: PendingStep | null;
  last: HugoGoalStepResult | null;
  steps: number;
  budget: number;
  lastStepAt: string | null;
  /** The company day of the last update notice (one a day). */
  toldOn: string | null;
  wake: Wake;
  declined: string[];
  paused: { why: 'daily' | 'allowance'; until: string } | null;
  outcome: 'DONE' | 'GAVE_UP' | null;
  summary: string | null;
  /** Tasks of theirs the goal found already running and follows (not its own children — never stopped by it). */
  adopted: string[];
  errors?: number;
}

const taskLink = (id: string) => `/?hugo=task:${id}`;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const clean = (s: unknown, n: number) => clip(redactSensitiveNumbers(String(s ?? '').replace(/\s+/g, ' ').trim()), n);

function stateOf(t: Pick<HugoTask, 'state'>): GoalState {
  const s = (t.state ?? {}) as Partial<GoalState>;
  return {
    plan: Array.isArray(s.plan) ? s.plan : [],
    pending: s.pending ?? null,
    last: s.last ?? null,
    steps: s.steps ?? 0,
    budget: s.budget ?? env.HUGO_GOAL_MAX_STEPS,
    lastStepAt: s.lastStepAt ?? null,
    toldOn: s.toldOn ?? null,
    wake: s.wake ?? null,
    declined: Array.isArray(s.declined) ? s.declined : [],
    paused: s.paused ?? null,
    outcome: s.outcome ?? null,
    summary: s.summary ?? null,
    adopted: Array.isArray(s.adopted) ? s.adopted : [],
    ...(s.errors ? { errors: s.errors } : {}),
  };
}

const goalText = (t: Pick<HugoTask, 'subject'>) => (t.subject as HugoTaskSubject).goal ?? '';
const progressOf = (plan: HugoGoalStep[]) => (plan.length ? { done: plan.filter((s) => s.state === 'done' || s.state === 'skipped').length, total: plan.length } : null);

/* ------------------------------------------------------------------ start */

/** The goal as it is kept: no SSN or account number, one line. */
export function cleanGoal<T extends HugoTaskCreate>(input: T): T {
  return input.kind === 'GOAL' ? { ...input, goal: clean(input.goal, 300) } : input;
}

/** The same goal, asked twice, is one goal. */
export function goalKey(goal: string): string {
  return `GOAL:${goal.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200)}`;
}

/** The checks and the capture for a new goal (lib/hugoTasks prepare). */
export async function prepareGoal(user: SessionUser, input: Extract<HugoTaskCreate, { kind: 'GOAL' }>, now: Date): Promise<HugoPrepared> {
  if (!modelAvailable()) throw new HttpError(409, 'hugo_no_model', 'Goals need my thinking, and that isn’t switched on here yet. I can still watch things for you and answer questions.');
  // An associate's Hugo never calls the model (lib/hugoAllowance modelServes).
  if (!modelAvailableFor(user)) throw new HttpError(409, 'hugo_no_model', 'Goals aren’t something I take on here. I can still watch things for you and answer questions.');
  const left = await allowanceStatus(user.id, now);
  if (left.exhausted) throw new HttpError(409, 'hugo_allowance', 'You’ve used this month’s thinking time. Goals can start again when it renews.', { renewsAt: left.renewsAt.toISOString() });
  const open = await prisma.hugoTask.count({ where: { userId: user.id, kind: 'GOAL', status: { in: ['WORKING', 'WAITING', 'NEEDS_YOU'] } } });
  if (open >= env.HUGO_GOAL_MAX_OPEN) throw new HttpError(409, 'too_many_goals', `You already have ${open} goals open. Finish or stop one first.`);
  const goal = clean(input.goal, 300);
  if (goal.replace(/\W/g, '').length < 3) throw new HttpError(400, 'invalid_goal', 'Say what you want done in a few words.');
  const state: GoalState = {
    plan: [],
    pending: null,
    last: null,
    steps: 0,
    budget: env.HUGO_GOAL_MAX_STEPS,
    lastStepAt: null,
    toldOn: null,
    wake: 'start',
    declined: [],
    paused: null,
    outcome: null,
    summary: null,
    adopted: [],
  };
  return { subject: { goal }, state: state as unknown as Record<string, unknown>, expiresAt: new Date(now.getTime() + GOAL_DAYS * DAY), linkUrl: null, progress: null };
}

/* ------------------------------------------------------- in the background */

const inflight = new Set<Promise<void>>();

/**
 * Take a goal's next step in the background: the person's tap answers at
 * once and the card follows live. False when this server is already
 * running as many goal steps as it should (the sweep picks it up later).
 */
export function kickHugoGoal(taskId: string, tenantId: string, at?: Date): boolean {
  if (inflight.size >= MAX_CONCURRENT_STEPS) return false;
  const p: Promise<void> = runWithTenant(tenantId, 'job', async () => {
    const { advanceHugoTask } = await import('./hugoTasks.js');
    await advanceHugoTask(taskId, at ?? new Date());
  })
    .catch((err: unknown) => console.warn(`[hugo] goal ${taskId} step failed:`, err instanceof Error ? err.message : err))
    .finally(() => inflight.delete(p));
  inflight.add(p);
  return true;
}

/** Every goal step started in the background has finished (tests; a graceful stop). */
export async function settleHugoGoals(): Promise<void> {
  while (inflight.size) await Promise.allSettled([...inflight]);
}

/** Something a goal started has news: look again now (its own spacing still applies). */
export async function wakeGoal(parentId: string, now: Date): Promise<void> {
  await prisma.hugoTask.updateMany({ where: { id: parentId, kind: 'GOAL', status: { in: ['WORKING', 'WAITING'] }, nextCheckAt: { gt: now } }, data: { nextCheckAt: now } });
}

/* ------------------------------------------------------------------- step */

/** When the organization's company day began, and when the next one begins. */
function companyDay(now: Date): { start: Date; next: Date; key: string } {
  const tz = companyWorkweek().timezone;
  const key = orgDateKey(now);
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  const start = zonedWallTimeToUtcInstant(y, m, d, 0, tz);
  return { start, next: addDaysInZone(start, 1, tz), key };
}

/** The trail as the model reads it: plain lines, never more than the person could see. */
function trailForModel(events: HugoTaskEvent[]): string[] {
  const lines: string[] = [];
  for (const e of events) {
    const d = (e.data ?? {}) as Record<string, string | number | null>;
    const at = `${e.createdAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
    const line = ((): string | null => {
      switch (e.code) {
        case 'PLANNED':
          return `Plan made or changed (${d.count} steps).`;
        case 'PROPOSED':
          return `You proposed: ${d.title}`;
        case 'STEP_DONE':
          return `They approved "${d.title}" → ${d.outcome === 'done' ? 'it went through' : d.outcome === 'pending' ? 'sent for a second person’s approval' : `the product refused it (${d.code})`}.`;
        case 'STEP_DECLINED':
          return `They declined "${d.title}".`;
        case 'UPDATE':
          return `You told them: ${d.text}`;
        case 'WATCH_STARTED':
          return `You started ${d.kind}.`;
        case 'PAUSED':
          return `Paused (${d.why}) until ${d.until}.`;
        case 'KEPT_GOING':
          return 'They asked you to keep going.';
        default:
          return null;
      }
    })();
    if (line) lines.push(`${at} — ${line}`);
  }
  return lines.slice(-TRAIL_LINES);
}

/** What the watches and asks it started (or follows) are doing. */
async function childrenOf(t: HugoTask, st: GoalState) {
  return prisma.hugoTask.findMany({
    where: { userId: t.userId, OR: [{ parentId: t.id }, ...(st.adopted.length ? [{ id: { in: st.adopted } }] : [])] },
    orderBy: { createdAt: 'asc' },
    take: 10,
    include: { events: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1 } },
  });
}

function childLine(k: HugoTask & { events: HugoTaskEvent[] }): string {
  const last = k.events[0];
  const news = last ? ` — latest: ${last.code}${Object.keys(last.data as object).length ? ` ${JSON.stringify(last.data)}` : ''}` : '';
  const result = k.result ? ` — result: ${JSON.stringify(k.result).slice(0, 300)}` : '';
  return `${k.kind} [${k.status}${k.needs ? `, needs them: ${k.needs}` : ''}] (task ${k.id})${news}${result}`;
}

/** What one step decided, as its tools recorded it. */
interface StepAcc {
  plan?: HugoGoalStep[];
  watches: Array<{ kind: WatchKind; taskId: string }>;
  proposal?: PendingStep;
  tell?: string;
  checkBackHours?: number;
  finish?: { outcome: 'DONE' | 'GAVE_UP'; summary: string };
  /** A new end date the goal needs (up to GOAL_MAX_DAYS from its start). */
  endsAt?: Date;
}
const ended = (acc: StepAcc) => Boolean(acc.proposal || acc.finish);
const OVER = 'This step is over. Stop now; nobody reads your reply.';

/** The goal tools of one step: what the model may decide, each checked here. */
function goalTools(t: HugoTask, st: GoalState, c: HugoCtx, user: SessionUser, ac: GoalActionCtx, acc: StepAcc, childCount: number): AssistantTool[] {
  const actions = goalActionsFor(ac);
  const reply = (text: string) => ({ reply: text, linkUrl: null });
  const today = companyDay(c.now).key;
  const tools: AssistantTool[] = [
    {
      key: 'GOAL_PLAN',
      name: 'update_plan',
      description: `Set the visible checklist for this goal: at most ${HUGO_GOAL_MAX_PLAN} short steps in the person's language, each with its state (todo, doing, done, skipped). Replaces the plan.`,
      input: {
        properties: {
          steps: {
            type: 'array',
            items: { type: 'object', properties: { text: { type: 'string' }, state: { type: 'string', enum: [...HUGO_GOAL_STEP_STATES] } }, required: ['text', 'state'] },
          },
        },
        required: ['steps'],
      },
      run: async (args) => {
        if (ended(acc)) return reply(OVER);
        const raw = Array.isArray(args?.steps) ? (args.steps as Array<Record<string, unknown>>) : [];
        const plan = raw
          .map((s) => ({ text: clean(s?.text, 80), state: (HUGO_GOAL_STEP_STATES as readonly string[]).includes(String(s?.state)) ? (String(s.state) as HugoGoalStep['state']) : 'todo' }))
          .filter((s) => s.text.length > 0)
          .slice(0, HUGO_GOAL_MAX_PLAN);
        if (!plan.length) return reply('The plan needs at least one step.');
        acc.plan = plan;
        return reply(`Plan saved (${plan.length} steps).${raw.length > HUGO_GOAL_MAX_PLAN ? ` Only the first ${HUGO_GOAL_MAX_PLAN} were kept.` : ''}`);
      },
    },
  ];
  if (actions.length) {
    tools.push(
      {
        key: 'GOAL_OPTIONS',
        name: 'find_options',
        description: `What an action could apply to right now, read from the person's own records with their reach (ids and plain labels). Call it before propose. Actions:\n${describeGoalActions(actions)}`,
        input: { properties: { action: { type: 'string', enum: actions }, query: { type: 'string', description: 'A name to look for, where the action takes one.' } }, required: ['action'] },
        run: async (args) => {
          try {
            return reply(await goalActionOptions(ac, String(args?.action ?? ''), typeof args?.query === 'string' ? args.query : undefined));
          } catch (err) {
            if (err instanceof GoalActionRefusal) return reply(err.message);
            throw err;
          }
        },
      },
      {
        key: 'GOAL_PROPOSE',
        name: 'propose',
        description:
          'Propose ONE thing that would change something, for the person to approve. Nothing happens until they do; then it runs as them. Ends the step. ' +
          'args are the action\'s own (see find_options); why is one sentence in their language on how it helps the goal.',
        input: {
          properties: {
            action: { type: 'string', enum: actions },
            args: { type: 'object', description: "The action's arguments." },
            why: { type: 'string', description: 'One short sentence, in their language.' },
          },
          required: ['action', 'args'],
        },
        run: async (args) => {
          if (ended(acc)) return reply(OVER);
          const action = String(args?.action ?? '');
          try {
            const p = await prepareGoalAction(ac, action, (args?.args && typeof args.args === 'object' ? args.args : {}) as Record<string, unknown>);
            acc.proposal = { action: p.action, title: clip(p.title, 200), detail: p.detail ? clip(p.detail, 400) : null, why: args?.why ? clean(args.why, 200) : null, at: c.now.toISOString(), run: p.run, linkUrl: p.linkUrl };
            return reply(`Proposed: ${p.title}. The person will see it and decide. The step is over — stop now.`);
          } catch (err) {
            if (err instanceof GoalActionRefusal) return reply(`Not proposed: ${err.message}`);
            throw err;
          }
        },
      },
    );
  }
  if (user.associateId) {
    tools.push({
      key: 'GOAL_WATCH',
      name: 'start_watch',
      description:
        'Start watching something for this goal (changes nothing, needs no approval); its news wakes you. Kinds: WATCH_OPEN_SHIFTS (an open shift that fits them, days 1–14), WATCH_TIME_OFF (their pending time-off requests are decided), WATCH_PAYCHECK (their next pay is in), WATCH_DOCUMENT (their uploads are reviewed).',
      input: { properties: { kind: { type: 'string', enum: [...WATCH_KINDS] }, days: { type: 'number', description: 'WATCH_OPEN_SHIFTS: how many days ahead (1–14).' } }, required: ['kind'] },
      run: async (args) => {
        if (ended(acc)) return reply(OVER);
        const kind = String(args?.kind ?? '') as WatchKind;
        if (!WATCH_KINDS.includes(kind)) return reply('That is not a kind of watch.');
        if (childCount + acc.watches.length >= MAX_CHILDREN) return reply(`This goal already has ${MAX_CHILDREN} watches and asks; use them.`);
        const input = (kind === 'WATCH_OPEN_SHIFTS' ? { kind, days: Math.min(14, Math.max(1, Math.round(Number(args?.days) || 7))) } : { kind }) as HugoTaskCreate;
        try {
          const r = await startHugoTask(user, input, 'goal', c.now, null, t.id);
          if (r.existing) {
            if (!st.adopted.includes(r.task.id)) st.adopted.push(r.task.id);
            return reply(`They already had ${kind} running (task ${r.task.id}, ${r.task.status}); you follow it now.`);
          }
          acc.watches.push({ kind, taskId: r.task.id });
          return reply(`Watching: ${kind} (task ${r.task.id}, ${r.task.status}).`);
        } catch (err) {
          if (err instanceof HttpError) return reply(`Could not start ${kind}: ${err.message}`);
          throw err;
        }
      },
    });
  }
  tools.push(
    {
      key: 'GOAL_TELL',
      name: 'tell_person',
      description: 'Send the person a short update on this goal (one or two sentences, their language). At most one a day; only news that matters.',
      input: { properties: { message: { type: 'string' } }, required: ['message'] },
      run: async (args) => {
        if (acc.finish) return reply(OVER);
        if (acc.tell) return reply('You already wrote an update this step.');
        if (st.toldOn === today) return reply('You already told them something today. Put it in the plan instead, or wait.');
        const message = clean(args?.message, 300);
        if (!message) return reply('The message is empty.');
        acc.tell = message;
        return reply('Noted — they will get it.');
      },
    },
    {
      key: 'GOAL_END',
      name: 'set_end_date',
      description: `The goal ends ${GOAL_DAYS} days after it started. When it needs longer (next month's schedule, a document due in three weeks), set how many days from its start it may run: up to ${GOAL_MAX_DAYS}.`,
      input: { properties: { days: { type: 'number' }, why: { type: 'string' } }, required: ['days'] },
      run: async (args) => {
        if (acc.finish) return reply(OVER);
        const days = Math.round(Number(args?.days));
        if (!Number.isFinite(days) || days < 1) return reply('Give a number of days from its start.');
        const endsAt = new Date(t.createdAt.getTime() + Math.min(GOAL_MAX_DAYS, days) * DAY);
        if (endsAt.getTime() <= c.now.getTime() + HOUR) return reply('That is already past; pick a later day.');
        acc.endsAt = endsAt;
        return reply(`It now ends ${orgDateKey(endsAt)}${days > GOAL_MAX_DAYS ? ` (${GOAL_MAX_DAYS} days is the longest)` : ''}.`);
      },
    },
    {
      key: 'GOAL_CHECK_BACK',
      name: 'check_back',
      description: 'When to look at this goal again: in 1 to 72 hours. Ends the step.',
      input: { properties: { hours: { type: 'number' }, why: { type: 'string' } }, required: ['hours'] },
      run: async (args) => {
        if (ended(acc)) return reply(OVER);
        const h = Number(args?.hours);
        acc.checkBackHours = Math.min(72, Math.max(1, Number.isFinite(h) ? h : DEFAULT_CHECK_HOURS));
        return reply(`You will look again in ${acc.checkBackHours} hours. The step is over — stop now.`);
      },
    },
    {
      key: 'GOAL_FINISH',
      name: 'finish',
      description: 'Close the goal: DONE when it is reached, GAVE_UP when it cannot be done here. summary: one sentence in their language. Anything still watching for it stops.',
      input: { properties: { outcome: { type: 'string', enum: ['DONE', 'GAVE_UP'] }, summary: { type: 'string' } }, required: ['outcome', 'summary'] },
      run: async (args) => {
        if (ended(acc)) return reply(OVER);
        const summary = clean(args?.summary, 300);
        if (!summary) return reply('Say in a sentence how it went.');
        acc.finish = { outcome: args?.outcome === 'DONE' ? 'DONE' : 'GAVE_UP', summary };
        return reply('Closed. Stop now.');
      },
    },
  );
  return tools;
}

/** The step's verdict as the task engine writes it. */
function outcomeOf(t: HugoTask, st: GoalState, acc: StepAcc, c: HugoCtx, tier: 'fast' | 'deep'): HugoOutcome {
  const goal = goalText(t);
  const endsAt = acc.endsAt ?? t.expiresAt;
  const today = companyDay(c.now).key;
  const events: NonNullable<HugoOutcome['events']> = [{ code: 'STEP', data: { tier } }];
  const next: GoalState = { ...st, steps: st.steps + 1, lastStepAt: c.now.toISOString(), wake: null, paused: null };
  if (acc.plan) {
    next.plan = acc.plan;
    events.push({ code: 'PLANNED', data: { count: acc.plan.length } });
  }
  for (const w of acc.watches) events.push({ code: 'WATCH_STARTED', data: { kind: w.kind, taskId: w.taskId } });
  const progress = progressOf(next.plan);
  if (acc.finish) {
    // An update written in the same step stays on the trail; the closing notice says the rest.
    if (acc.tell) events.push({ code: 'UPDATE', data: { text: acc.tell } });
    next.outcome = acc.finish.outcome;
    next.summary = acc.finish.summary;
    if (acc.finish.outcome === 'DONE') {
      return {
        status: 'DONE',
        state: next as unknown as Record<string, unknown>,
        progress,
        events: [...events, { code: 'DONE', data: { summary: acc.finish.summary } }],
        notice: { ...GOAL_NOTICE.done(c.lang, goal, acc.finish.summary), category: 'hugo_task_done', linkUrl: taskLink(t.id) },
      };
    }
    return {
      status: 'FAILED',
      state: next as unknown as Record<string, unknown>,
      progress,
      events: [...events, { code: 'GAVE_UP', data: { summary: acc.finish.summary } }],
      notice: { ...GOAL_NOTICE.gaveUp(c.lang, goal, acc.finish.summary), category: 'hugo_task_done', linkUrl: taskLink(t.id) },
    };
  }
  if (acc.tell) {
    events.push({ code: 'UPDATE', data: { text: acc.tell } });
    next.toldOn = today;
  }
  if (acc.proposal) {
    next.pending = acc.proposal;
    events.push({ code: 'PROPOSED', data: { action: acc.proposal.action, title: acc.proposal.title } });
    return {
      status: 'NEEDS_YOU',
      needs: 'GOAL_APPROVAL',
      state: next as unknown as Record<string, unknown>,
      progress,
      events,
      nextCheckAt: endsAt,
      notice: { ...GOAL_NOTICE.proposed(c.lang, goal, acc.proposal.title), category: 'hugo_task_needs_you', linkUrl: taskLink(t.id) },
    };
  }
  // The first step that only made the plan goes straight on to the first useful
  // step (once): a person who just handed Hugo a goal shouldn't wait for tomorrow's
  // check-in to see him act. It still counts against the goal's steps.
  if (st.steps === 0 && acc.checkBackHours === undefined) {
    next.wake = 'continue';
    return { status: 'WORKING', state: next as unknown as Record<string, unknown>, progress, events, nextCheckAt: c.now };
  }
  const gap = env.HUGO_GOAL_STEP_GAP_MINUTES * MIN;
  const wanted = c.now.getTime() + (acc.checkBackHours ?? DEFAULT_CHECK_HOURS) * HOUR;
  const nextCheckAt = new Date(Math.min(endsAt.getTime(), Math.max(c.now.getTime() + gap, wanted)));
  return {
    status: 'WORKING',
    state: next as unknown as Record<string, unknown>,
    progress,
    events,
    nextCheckAt,
    ...(acc.tell ? { notice: { ...GOAL_NOTICE.update(c.lang, goal, acc.tell), category: 'hugo_task_done' as const, linkUrl: taskLink(t.id) } } : {}),
  };
}

/** Why Hugo is looking now, for the prompt. */
function whyNow(st: GoalState, news: boolean): string {
  if (st.steps === 0) return 'This is the first step: make the plan, then take the first useful step.';
  if (st.wake === 'approved' && st.last) {
    const how = st.last.outcome === 'done' ? 'it went through' : st.last.outcome === 'pending' ? 'it was sent for a second person’s approval' : `the product refused it (${st.last.code})`;
    return `They approved "${st.last.title}" and ${how}. Update the plan and take the next step.`;
  }
  if (st.wake === 'declined') return `They declined "${st.declined[st.declined.length - 1] ?? 'your last proposal'}". Plan around it — don't propose it again.`;
  if (st.wake === 'kept_going') return 'They asked you to keep going.';
  if (st.wake === 'continue') return 'You made the plan. Now take the first useful step: read what you need, then propose an action, start a watch, or check back.';
  if (news) return 'Something you started has news.';
  return 'Your scheduled check-in.';
}

/**
 * One step for a goal (lib/hugoTasks STEPS.GOAL), under the task's claim:
 * the caps first, then the person read fresh, then one model step.
 */
export async function stepGoal(t: HugoTask, c: HugoCtx): Promise<HugoOutcome> {
  const st = stateOf(t);
  const now = c.now;
  // A person's answer wakes it at once; otherwise its own steps keep their spacing.
  const gap = env.HUGO_GOAL_STEP_GAP_MINUTES * MIN;
  if (!st.wake && st.lastStepAt && now.getTime() - new Date(st.lastStepAt).getTime() < gap) {
    return { nextCheckAt: new Date(new Date(st.lastStepAt).getTime() + gap) };
  }
  // The steps this goal had are used: ask to keep going.
  if (st.steps >= st.budget) {
    const w = GOAL_STEP_WORDS.keepGoing(c.lang, st.steps);
    const pending: PendingStep = { action: 'KEEP_GOING', title: w.title, detail: w.detail, why: null, at: now.toISOString(), run: null, linkUrl: null };
    return {
      status: 'NEEDS_YOU',
      needs: 'KEEP_GOING',
      state: { ...st, pending, wake: null } as unknown as Record<string, unknown>,
      events: [{ code: 'PAUSED', data: { why: 'steps', count: st.steps } }],
      nextCheckAt: t.expiresAt,
      notice: { ...GOAL_NOTICE.keepGoing(c.lang, goalText(t), st.steps), category: 'hugo_task_needs_you', linkUrl: taskLink(t.id) },
    };
  }
  // The organization's goal steps for today are used: tomorrow.
  const day = companyDay(now);
  {
    const today = await prisma.hugoTaskEvent.count({ where: { tenantId: t.tenantId, code: 'STEP', createdAt: { gte: day.start } } });
    if (today >= env.HUGO_GOAL_DAILY_STEPS) {
      const until = new Date(day.next.getTime() + 5 * MIN);
      const already = st.paused?.why === 'daily' && new Date(st.paused.until) > now;
      return {
        state: { ...st, paused: { why: 'daily', until: until.toISOString() } } as unknown as Record<string, unknown>,
        events: already ? [] : [{ code: 'PAUSED', data: { why: 'daily', until: until.toISOString() } }],
        nextCheckAt: until,
      };
    }
  }
  // The person, as they are now: a revoked role or a switched-off assistant stops the goal.
  const reg = await registryForUser(t.userId, { now });
  if (!reg) {
    await stopChildTasks(t.id, now);
    return { status: 'FAILED', events: [{ code: 'FAILED', data: { reason: 'no_access' } }] };
  }
  const user = reg.user;
  // An associate's goal (one set before their Hugo stopped using the model) stops: it can't take a step.
  if (!modelServes(user.role, user.primaryRole)) {
    await stopChildTasks(t.id, now);
    return { status: 'FAILED', events: [{ code: 'FAILED', data: { reason: 'no_access' } }] };
  }
  const ac: GoalActionCtx = { user, lang: c.lang, now, moduleOn: reg.ctx.moduleOn };
  const [events, kids] = await Promise.all([
    prisma.hugoTaskEvent.findMany({ where: { taskId: t.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 200 }),
    childrenOf(t, st),
  ]);
  const news = kids.some((k) => st.lastStepAt && k.updatedAt > new Date(st.lastStepAt));
  const acc: StepAcc = { watches: [] };
  const tier = st.steps === 0 || st.wake === 'declined' ? 'deep' : 'fast';
  const ownKids = kids.filter((k) => k.parentId === t.id).length;
  const tools = [...reg.tools, ...payTools(prisma, user), ...goalTools(t, st, c, user, ac, acc, ownKids)];
  try {
    await runGoalStep({
      userId: t.userId,
      identity: {
        name: reg.name,
        product: getBrandingSync(t.tenantId).orgName || 'Alto People',
        audience: reg.audience,
        roleLabel: ROLE_LABELS[user.role] ?? user.role,
        lang: c.lang,
        terms: { worker: reg.terms.worker, workers: reg.terms.workers, site: reg.terms.site, sites: reg.terms.sites, manager: reg.terms.manager, managers: reg.terms.managers },
      },
      goal: goalText(t),
      plan: st.plan,
      trail: trailForModel(events),
      children: kids.map(childLine),
      why: whyNow(st, news),
      startedAt: t.createdAt,
      expiresAt: t.expiresAt,
      steps: { used: st.steps, max: st.budget },
      // What the person told Hugo before ("What Hugo knows"; nothing when their memory is off).
      memory: await memoryForChannel(t.userId),
      tools,
      tier,
      now,
    });
  } catch (err) {
    if (err instanceof HugoAllowanceError) {
      // Their allowance is used up: the goal waits until it renews, and says so.
      const until = err.renewsAt.toISOString();
      const already = st.paused?.why === 'allowance' && st.paused.until === until;
      return {
        status: 'WAITING',
        state: { ...st, paused: { why: 'allowance', until } } as unknown as Record<string, unknown>,
        events: already ? [] : [{ code: 'PAUSED', data: { why: 'allowance', until } }],
        nextCheckAt: err.renewsAt,
      };
    }
    // Past its deadline after it had decided: keep the decision. Otherwise the step is retried.
    if (!ended(acc)) throw err;
  }
  if (acc.finish) await stopChildTasks(t.id, now);
  // A longer run it asked for (set_end_date), under this step's claim.
  if (acc.endsAt && !acc.finish) await prisma.hugoTask.updateMany({ where: { id: t.id, claimedAt: now }, data: { expiresAt: acc.endsAt } });
  await logBuiltInAgentAction(prisma, 'whatsapp-assistant', {
    action: 'agent.goal.step',
    entityType: 'HugoTask',
    entityId: t.id,
    metadata: { tier, step: st.steps + 1, planned: Boolean(acc.plan), watches: acc.watches.length, proposed: acc.proposal?.action ?? null, told: Boolean(acc.tell), finished: acc.finish?.outcome ?? null },
  });
  return outcomeOf(t, st, acc, c, tier);
}

/** The deadline passed with the goal still open. */
export async function expireGoal(t: HugoTask, c: HugoCtx): Promise<HugoOutcome> {
  await stopChildTasks(t.id, c.now);
  const st = stateOf(t);
  return {
    status: 'EXPIRED',
    state: { ...st, pending: null } as unknown as Record<string, unknown>,
    events: [{ code: 'EXPIRED' }],
    notice: { ...GOAL_NOTICE.expired(c.lang, goalText(t)), category: 'hugo_task_done', linkUrl: taskLink(t.id) },
  };
}

/* ------------------------------------------------------- the person's say */

/**
 * The person's answer to what a goal is waiting on (lib/hugoTasks answer, under
 * their claim). APPROVE runs the proposal as them — through the product's own
 * route with their own session, so their permissions, the approval engine and
 * the route's audit apply — or starts the task; the result is on the trail and
 * in place on the card, and the goal steps again at once.
 */
export async function answerGoal(t: HugoTask, user: SessionUser, choice: HugoTaskChoice, c: HugoCtx, req?: Request): Promise<HugoOutcome | 'stop'> {
  const st = stateOf(t);
  if (choice === 'STOP') return 'stop';
  const pending = st.pending;
  if (choice === 'KEEP_GOING') {
    return {
      status: 'WORKING',
      state: { ...st, pending: null, budget: st.steps + env.HUGO_GOAL_MAX_STEPS, wake: 'kept_going' } as unknown as Record<string, unknown>,
      events: [{ code: 'KEPT_GOING' }],
      nextCheckAt: c.now,
    };
  }
  if (!pending) throw new HttpError(409, 'nothing_to_answer', 'This goal is not waiting on you.');
  if (choice === 'DECLINE') {
    return {
      status: 'WORKING',
      state: { ...st, pending: null, wake: 'declined', declined: [...st.declined, pending.title].slice(-5) } as unknown as Record<string, unknown>,
      events: [{ code: 'STEP_DECLINED', data: { action: pending.action, title: pending.title } }],
      nextCheckAt: c.now,
    };
  }
  if (choice !== 'APPROVE' || !pending.run) throw new HttpError(400, 'invalid_choice', 'That is not one of the answers for this goal.');
  let outcome: HugoGoalStepResult['outcome'];
  let code: string | null = null;
  let linkUrl = pending.linkUrl;
  if ('call' in pending.run) {
    if (!req) throw new HttpError(409, 'approve_in_app', 'Approve this in the app.');
    const r = await dispatchAsUser(req, pending.run.call);
    ({ outcome, code } = judgeGoalCall(pending.action, r.status, r.body));
    const thread = (r.body as { linkUrl?: unknown } | null)?.linkUrl;
    if (outcome !== 'refused' && typeof thread === 'string' && thread.startsWith('/')) linkUrl = thread;
    if (outcome === 'refused') linkUrl = null;
  } else {
    try {
      const r = await startHugoTask(user, pending.run.task, 'goal', c.now, null, t.id);
      if (r.existing && !st.adopted.includes(r.task.id)) st.adopted.push(r.task.id);
      outcome = 'done';
      linkUrl = taskLink(r.task.id);
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      outcome = 'refused';
      code = err.code;
      linkUrl = null;
    }
  }
  const last: HugoGoalStepResult = { action: pending.action, title: pending.title, outcome, code, at: c.now.toISOString(), linkUrl };
  enqueueAudit(
    { actorUserId: user.id, clientId: user.clientId ?? null, action: 'hugo.goal_step_run', entityType: 'HugoTask', entityId: t.id, metadata: { action: pending.action, outcome, code, via: 'assistant' } },
    'hugo',
  );
  await logBuiltInAgentAction(prisma, 'whatsapp-assistant', { action: 'agent.goal.step_run', entityType: 'HugoTask', entityId: t.id, metadata: { action: pending.action, outcome } });
  return {
    status: 'WORKING',
    state: { ...st, pending: null, last, wake: 'approved' } as unknown as Record<string, unknown>,
    events: [{ code: 'STEP_DONE', data: { action: pending.action, title: pending.title, outcome, code } }],
    nextCheckAt: c.now,
  };
}

/* ----------------------------------------------------------------- views */

/** What the card shows: the plan, what waits on the person, how the last step went. */
export function goalViewOf(t: HugoTask, now: Date = new Date()): HugoGoalView {
  const st = stateOf(t);
  const status = t.status as HugoTaskStatus;
  const open = status === 'WORKING' || status === 'WAITING' || status === 'NEEDS_YOU';
  const claimed = Boolean(t.claimedAt && now.getTime() - t.claimedAt.getTime() < STALE_CLAIM_MS);
  const pending: HugoGoalProposal | null = st.pending && status === 'NEEDS_YOU' ? { action: st.pending.action, title: st.pending.title, detail: st.pending.detail, why: st.pending.why, at: st.pending.at } : null;
  return {
    text: goalText(t),
    plan: st.plan,
    pending,
    last: st.last,
    lastCheckInAt: st.lastStepAt,
    nextCheckAt: open && status !== 'NEEDS_YOU' ? t.nextCheckAt.toISOString() : null,
    thinking: open && status !== 'NEEDS_YOU' && (claimed || (st.wake !== null && t.nextCheckAt <= now)),
    steps: { used: st.steps, max: st.budget },
    paused: open && st.paused && new Date(st.paused.until) > now ? st.paused : null,
    outcome: st.outcome,
    summary: st.summary,
  };
}

