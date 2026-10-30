import { createHash } from 'node:crypto';
import { Prisma, type HugoTask } from '@prisma/client';
import {
  HUGO_TASK_OPEN_STATUSES,
  ROLE_LABELS,
  redactSensitiveNumbers,
  type HugoRecurringChange,
  type HugoRecurringSchedule,
  type HugoRecurringStatus,
  type HugoRecurringWhat,
  type HugoTaskCreate,
  type HugoTaskEventCode,
  type HugoTaskNeed,
  type HugoTaskResult,
  type HugoTaskStatus,
  type HugoTaskSubject,
} from '@alto-people/shared';
import { env } from '../config/env.js';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import type { SessionUser } from '../types/express.js';
import { logBuiltInAgentAction, type AgentContext } from './agents.js';
import { computeAssociateEarnings } from './associateEarnings.js';
import { answerWithModel, modelAvailable } from './assistantModel.js';
import { modelAvailableFor } from './hugoModelGate.js';
import { enqueueAudit } from './audit.js';
import { getBrandingSync } from './branding.js';
import { detectHugoIntent } from './hugo.js';
import { HugoAllowanceError } from './hugoAllowance.js';
import { passQuestion, registryForUser } from './hugoRegistry.js';
import { RECURRING_NOTICE, briefSubject, hoursBrief, scheduleLabel } from './hugoRecurringCopy.js';
import { hugoDay, type HugoLang } from './hugoWorkCopy.js';
import { emitLiveEvent } from './liveEvents.js';
import { dayBoundsInTz, orgTimeZone } from './siteDay.js';
import { companyWorkweek, dateKeyInZone, orgDateKey } from './timeAnomalies.js';
import { addDaysToKey, localDateKey, zonedWallTimeToUtcInstant } from './timezone.js';

/**
 * Recurring briefs (Muse phase 5, owner 2026-10-29): "every Friday tell me
 * my hours", "each morning tell me who's short", "remind me every day at 7
 * of my next shift". A RECURRING task (lib/hugoTasks runs it like every
 * other kind) that sends the person one thing on the schedule they set.
 *
 *   What it sends is read fresh at each run, as the person is NOW
 *   (registryForUser — their reach, the modules on, the assistant on): one
 *   of the registry's answers open to them, their hours this store week
 *   (the reader the pay screen uses, never money — a brief reaches the lock
 *   screen), or a question of theirs answered by the quick model ('ASK',
 *   only while a model is on, charged to their own allowance). A brief they
 *   can no longer have stops, and says why.
 *
 *   The schedule is wall-clock on their clock (their site's zone, else
 *   their own setting, else the company's), so a 7:00 AM brief stays at
 *   7:00 AM across a daylight-saving change. Between runs it is WAITING;
 *   the sweep (and opening the list) runs it when it is due. A run the
 *   server missed by hours is skipped, never sent late in a bunch.
 *
 *   It ends after 180 days. A week before, it asks "keep going?" (NEEDS_YOU
 *   with KEEP_GOING / STOP, while it carries on sending); no answer and it
 *   ends EXPIRED with one last notice. The person pauses, resumes, changes
 *   the time or stops it (PATCH /hugo/recurring/:id, POST /hugo/tasks/:id/cancel).
 *
 *   Caps: HUGO_RECURRING_MAX_PER_USER briefs per person; a per-tenant
 *   safety valve HUGO_RECURRING_DAILY_MODEL on the model's runs per company
 *   day (over it, "I'll answer this one tomorrow"). Every send is on Hugo's
 *   agent trail (what, tier, source — never the words).
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const OPEN = HUGO_TASK_OPEN_STATUSES as readonly HugoTaskStatus[];
/** How long a brief runs before it asks to keep going. */
export const RECURRING_LIFE_MS = 180 * DAY;
/** "Keep going?" is asked this long before the end. */
export const KEEP_ASK_BEFORE_MS = 7 * DAY;
/** A run this late (the server was down) is skipped, not sent. */
const LATE_MS = 6 * HOUR;
const STALE_CLAIM_MS = 2 * MIN;
const MAX_TEXT = 1500;

/** The registry answers a brief can repeat (the rest are MY_HOURS and ASK). */
export const REGISTRY_WHATS: readonly HugoRecurringWhat[] = ['SCHEDULE', 'PAYDAY', 'RIDE', 'RENEW', 'DESK', 'COVERAGE', 'DRIVER_NEXT_RUN'];

/** Where each brief's notice opens when the answer names no page. */
const LINK: Record<HugoRecurringWhat, string | null> = {
  SCHEDULE: '/scheduling',
  PAYDAY: '/payroll',
  RIDE: '/rides',
  RENEW: '/documents',
  DESK: '/approvals',
  COVERAGE: '/scheduling',
  DRIVER_NEXT_RUN: '/',
  MY_HOURS: '/time-attendance',
  ASK: null,
};

type RecurringCreate = Extract<HugoTaskCreate, { kind: 'RECURRING' }>;
type EventData = Record<string, string | number | null>;

/** The step's outcome, in the shape lib/hugoTasks applies. */
export interface RecurringOutcome {
  status?: HugoTaskStatus;
  needs?: HugoTaskNeed | null;
  state?: Record<string, unknown>;
  result?: HugoTaskResult | null;
  linkUrl?: string | null;
  events?: Array<{ code: HugoTaskEventCode; data?: EventData }>;
  nextCheckAt?: Date;
  notice?: { subject: string; body: string; category: 'hugo_task_done' | 'hugo_task_needs_you'; linkUrl: string; full?: boolean };
}

export interface RecurringCtx {
  now: Date;
  agent: AgentContext;
  lang: HugoLang;
}

interface RecurringState {
  /** The run that is due next (ISO); null while paused. */
  dueAt?: string | null;
  /** "Keep going?" has been asked. */
  keepAsked?: boolean;
  /** Free questions skipped in a row because no model is on (the first one says so). */
  quietSkips?: number;
  deliveries?: number;
  lastAt?: string | null;
  errors?: number;
}

const taskLink = (id: string) => `/?hugo=task:${id}`;

/* ------------------------------------------------------------ the clock */

/** Does this schedule run on that weekday (0 = Sunday)? */
export function runsOn(s: Pick<HugoRecurringSchedule, 'cadence' | 'weekday'>, dow: number): boolean {
  if (s.cadence === 'DAILY') return true;
  if (s.cadence === 'WEEKDAYS') return dow >= 1 && dow <= 5;
  return dow === (s.weekday ?? 5);
}

/**
 * The first run strictly after `after`: the schedule's wall time on the
 * next day it runs, on its own clock. DST-safe — each day's instant is
 * worked out from that day's wall time, so 7:00 AM is 7:00 AM on both sides
 * of a change (a time inside the skipped spring-forward hour lands on the
 * nearest real instant).
 */
export function nextRunAt(s: Pick<HugoRecurringSchedule, 'cadence' | 'weekday' | 'time' | 'timezone'>, after: Date): Date {
  const [h, m] = s.time.split(':').map(Number) as [number, number];
  const today = localDateKey(after, s.timezone);
  for (let i = 0; i <= 8; i++) {
    const key = addDaysToKey(today, i);
    if (!runsOn(s, new Date(`${key}T12:00:00Z`).getUTCDay())) continue;
    const [y, mo, d] = key.split('-').map(Number) as [number, number, number];
    const at = zonedWallTimeToUtcInstant(y, mo, d, h * 60 + m, s.timezone);
    if (at.getTime() > after.getTime()) return at;
  }
  // Unreachable: every cadence runs at least once in eight days.
  throw new Error('recurring schedule has no next run');
}

const validZone = (tz: string | null | undefined): tz is string => {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/** The person's clock: their site's zone (their own, or where they are placed), else the zone they chose, else the company's. */
export async function recurringZone(user: Pick<SessionUser, 'locationId' | 'associateId' | 'timezone'>): Promise<string> {
  if (user.locationId) {
    const site = await prisma.site.findUnique({ where: { id: user.locationId }, select: { timezone: true } });
    if (validZone(site?.timezone)) return site.timezone;
  }
  if (user.associateId) {
    const placed = await prisma.associateAssignment.findFirst({
      where: { associateId: user.associateId, endedAt: null },
      orderBy: { startedAt: 'desc' },
      select: { location: { select: { timezone: true } } },
    });
    if (validZone(placed?.location.timezone)) return placed.location.timezone;
  }
  return validZone(user.timezone) ? user.timezone : companyWorkweek().timezone;
}

/* -------------------------------------------------------------- start */

/** The same brief, asked twice, is one brief. */
export function recurringKey(input: RecurringCreate): string {
  const q = input.question ? createHash('sha256').update(input.question.trim().toLowerCase()).digest('hex').slice(0, 16) : '-';
  return `RECURRING:${input.what}:${input.cadence}:${input.cadence === 'WEEKLY' ? (input.weekday ?? '-') : '-'}:${input.time}:${q}`;
}

/** Can this person have this answer repeated, here and now? Throws the plain reason when not. */
export async function assertCanHave(user: Pick<SessionUser, 'id' | 'associateId' | 'role' | 'primaryRole'>, what: HugoRecurringWhat, now: Date): Promise<void> {
  if (what === 'ASK') {
    // An associate's Hugo never calls the model (lib/hugoAllowance modelServes): no free questions.
    if (!modelAvailableFor(user)) throw new HttpError(409, 'hugo_no_model', 'Free questions aren’t on here right now. Pick one of the answers I can repeat.');
    return;
  }
  if (what === 'MY_HOURS') {
    if (!user.associateId) throw new HttpError(403, 'not_an_associate', 'Only someone with their own hours can have them sent.');
    return;
  }
  const reg = await registryForUser(user.id, { now });
  if (!reg) throw new HttpError(409, 'hugo_off', 'The assistant is switched off for now.');
  if (!reg.tools.some((t) => t.key === what)) throw new HttpError(409, 'not_available', 'That isn’t something I can tell you here.');
}

/** What this person can have on a schedule, right now (the chat lists them; the web works it out from GET /hugo). */
export async function recurringWhatsFor(user: Pick<SessionUser, 'id' | 'associateId' | 'role' | 'primaryRole'>, now: Date = new Date()): Promise<HugoRecurringWhat[]> {
  const reg = await registryForUser(user.id, { now });
  const keys = new Set(reg?.tools.map((t) => t.key) ?? []);
  return [...REGISTRY_WHATS.filter((w) => keys.has(w)), ...(user.associateId ? (['MY_HOURS'] as const) : []), ...(modelAvailableFor(user) ? (['ASK'] as const) : [])];
}

/** The tap on Start (lib/hugoTasks prepare): checks, the schedule on their clock, the first run. */
export async function prepareRecurring(user: SessionUser, input: RecurringCreate, now: Date) {
  if (input.cadence === 'WEEKLY' && input.weekday === undefined) throw new HttpError(400, 'weekday_required', 'Pick the day of the week.');
  let question: string | undefined;
  if (input.what === 'ASK') {
    // An SSN or account number never reaches the model or the record.
    question = redactSensitiveNumbers(input.question ?? '').trim();
    if (question.length < 3) throw new HttpError(400, 'question_required', 'Say what you’d like me to answer each time.');
  }
  await assertCanHave(user, input.what, now);
  const open = await prisma.hugoTask.count({ where: { userId: user.id, kind: 'RECURRING', status: { in: [...OPEN] } } });
  if (open >= env.HUGO_RECURRING_MAX_PER_USER) {
    throw new HttpError(409, 'too_many_recurring', `You already have ${open} repeating messages. Stop one in Tasks first.`, { max: env.HUGO_RECURRING_MAX_PER_USER });
  }
  const schedule: HugoRecurringSchedule = {
    what: input.what,
    cadence: input.cadence,
    weekday: input.cadence === 'WEEKLY' ? (input.weekday ?? 5) : null,
    time: input.time,
    timezone: await recurringZone(user),
    ...(question ? { question } : {}),
    paused: false,
  };
  const dueAt = nextRunAt(schedule, now);
  return {
    subject: { recurring: schedule } satisfies HugoTaskSubject,
    state: { dueAt: dueAt.toISOString(), deliveries: 0, lastAt: null } satisfies RecurringState as Record<string, unknown>,
    expiresAt: new Date(now.getTime() + RECURRING_LIFE_MS),
    linkUrl: LINK[input.what],
    progress: null,
  };
}

/* ------------------------------------------------------------- a run */

const statusOf = (st: RecurringState, nextAt: Date | null): HugoRecurringStatus => ({
  nextAt: nextAt ? nextAt.toISOString() : null,
  lastAt: st.lastAt ?? null,
  deliveries: st.deliveries ?? 0,
});

type Brief =
  | { kind: 'deliver'; text: string; linkUrl: string | null; tier: 'instant' | 'fast'; source: 'registry' | 'hours' | 'model' | 'allowance'; model: boolean }
  | { kind: 'stop'; reason: 'no_access' | 'not_available' }
  | { kind: 'defer' }
  | { kind: 'skip'; reason: 'no_model' | 'error' | 'nothing'; model: boolean };

/** The model's runs today across the tenant (the safety valve), on the company's day. */
export async function modelRunsToday(tenantId: string, now: Date): Promise<number> {
  const { start } = dayBoundsInTz(orgDateKey(now), orgTimeZone());
  return prisma.hugoTaskEvent.count({
    where: { tenantId, code: { in: ['DELIVERED', 'SKIPPED'] }, createdAt: { gte: start }, data: { path: ['model'], equals: 1 } },
  });
}

/** "Sat, Oct 24 – Fri, Oct 30": the store week the hours are counted in. */
function weekLabel(weekStart: string, weekEnd: string, lang: HugoLang): string {
  const tz = companyWorkweek().timezone;
  const a = dateKeyInZone(new Date(weekStart), tz);
  const b = dateKeyInZone(new Date(new Date(weekEnd).getTime() - 1), tz);
  return `${hugoDay(a, lang)} – ${hugoDay(b, lang)}`;
}

/** Build the one thing this run sends, read fresh as the person is now. */
async function makeBrief(t: HugoTask, s: HugoRecurringSchedule, c: RecurringCtx): Promise<Brief> {
  const reg = await registryForUser(t.userId, { now: c.now, text: s.question ?? '' });
  if (!reg) return { kind: 'stop', reason: 'no_access' };

  if (s.what === 'MY_HOURS') {
    if (!reg.user.associateId) return { kind: 'stop', reason: 'no_access' };
    const e = await computeAssociateEarnings(prisma, reg.user.associateId, c.now);
    return { kind: 'deliver', text: hoursBrief(c.lang, weekLabel(e.weekStart, e.weekEnd, c.lang), e.workedHours, e.remainingHours), linkUrl: '/time-attendance', tier: 'instant', source: 'hours', model: false };
  }

  if (s.what !== 'ASK') {
    if (!reg.tools.some((x) => x.key === s.what)) return { kind: 'stop', reason: 'not_available' };
    const run = reg.mk(s.what);
    if (!run) return { kind: 'stop', reason: 'not_available' };
    const out = await run();
    // A brief can't be answered back: drop the "want me to pass it on?" an answer may end with.
    const reply = out.handoff ? out.reply.replace(passQuestion(reg.lang, out.handoff.who), '').trim() : out.reply;
    return { kind: 'deliver', text: reply, linkUrl: out.linkUrl, tier: 'instant', source: 'registry', model: false };
  }

  // A free question: the quick model, with the person's own registry answers as its tools.
  const question = s.question ?? '';
  const fallback = async (): Promise<{ text: string; linkUrl: string | null } | null> => {
    const { intent } = detectHugoIntent(question, reg.ctx);
    // "What I can do" or "who I am" is no answer to their question.
    if (intent === 'HELP' || intent === 'WHO') return null;
    const run = reg.mk(intent);
    if (!run) return null;
    const out = await run();
    return { text: out.reply, linkUrl: out.linkUrl };
  };
  if (!modelAvailable()) return { kind: 'skip', reason: 'no_model', model: false };
  // An associate's free question (set before their Hugo stopped using the model): it can't be answered, so it stops.
  if (!modelAvailableFor(reg.user)) return { kind: 'stop', reason: 'not_available' };
  if ((await modelRunsToday(t.tenantId, c.now)) >= env.HUGO_RECURRING_DAILY_MODEL) return { kind: 'defer' };
  try {
    // A variable, not a literal: the call's input is the model module's to grow.
    const input = {
      text: question,
      history: [],
      // What this is, for the model: a scheduled message, read later on a lock screen.
      page: { path: '/?hugo=tasks', title: 'A repeating message the person set up: answer their question as it stands now, in three sentences at most, with nothing asked back — it arrives as a notification' },
      tools: reg.tools,
      identity: {
        name: reg.name,
        product: getBrandingSync().orgName || 'Alto People',
        audience: reg.audience,
        roleLabel: ROLE_LABELS[reg.user.role] ?? reg.user.role,
        lang: c.lang,
        terms: { worker: reg.terms.worker, workers: reg.terms.workers, site: reg.terms.site, sites: reg.terms.sites, manager: reg.terms.manager, managers: reg.terms.managers },
        escalation: null,
        canPropose: false,
      },
      now: c.now,
      tier: 'fast' as const,
      meter: { userId: t.userId, purpose: 'recurring' as const },
    };
    const answer = await answerWithModel(input);
    if (answer.reply) return { kind: 'deliver', text: answer.reply, linkUrl: answer.linkUrl, tier: 'fast', source: 'model', model: true };
    const fb = await fallback();
    return fb ? { kind: 'deliver', text: fb.text, linkUrl: fb.linkUrl, tier: 'instant', source: 'registry', model: true } : { kind: 'skip', reason: 'nothing', model: true };
  } catch (err) {
    if (err instanceof HugoAllowanceError) {
      // Their allowance is used up: say when it's back, with the registry's answer when it has one. No model was called.
      const fb = await fallback();
      const renews = hugoDay(orgDateKey(err.renewsAt), c.lang);
      return { kind: 'deliver', text: RECURRING_NOTICE.allowance(c.lang, renews, fb?.text ?? null), linkUrl: fb?.linkUrl ?? null, tier: 'instant', source: 'allowance', model: false };
    }
    console.warn(`[hugo] recurring ${t.id}: the model's answer failed; trying the registry:`, err instanceof Error ? err.message : err);
    const fb = await fallback();
    return fb ? { kind: 'deliver', text: fb.text, linkUrl: fb.linkUrl, tier: 'instant', source: 'registry', model: true } : { kind: 'skip', reason: 'error', model: true };
  }
}

/** One step of a recurring brief (lib/hugoTasks STEPS.RECURRING). */
export async function stepRecurring(t: HugoTask, c: RecurringCtx): Promise<RecurringOutcome> {
  const s = (t.subject as HugoTaskSubject).recurring;
  if (!s) return { status: 'FAILED', events: [{ code: 'FAILED', data: { reason: 'gone' } }] };
  const st: RecurringState = { ...(t.state as RecurringState) };
  const now = c.now;
  // The first step after Start: it waits for its first run.
  const waiting = t.status === 'WORKING' ? ('WAITING' as const) : undefined;

  // A week from the end: ask once, and keep sending meanwhile.
  if (!st.keepAsked && t.status !== 'NEEDS_YOU' && now.getTime() >= t.expiresAt.getTime() - KEEP_ASK_BEFORE_MS) {
    st.keepAsked = true;
    const due = st.dueAt ? new Date(st.dueAt) : null;
    const ends = hugoDay(localDateKey(t.expiresAt, s.timezone), c.lang);
    return {
      status: 'NEEDS_YOU',
      needs: 'KEEP_GOING',
      state: { ...st },
      nextCheckAt: s.paused || !due ? t.expiresAt : new Date(Math.max(now.getTime(), due.getTime())),
      notice: { ...RECURRING_NOTICE.keepGoing(c.lang, s.what, scheduleLabel(s, c.lang), ends), category: 'hugo_task_needs_you', linkUrl: taskLink(t.id) },
    };
  }

  // Paused: wake only for the end (and the question before it).
  if (s.paused) {
    const wake = st.keepAsked ? t.expiresAt : new Date(Math.max(now.getTime() + MIN, t.expiresAt.getTime() - KEEP_ASK_BEFORE_MS));
    return { status: waiting, state: { ...st, dueAt: null }, result: { recurring: statusOf(st, null) }, nextCheckAt: wake };
  }

  const dueAt = st.dueAt ? new Date(st.dueAt) : nextRunAt(s, now);
  if (now.getTime() < dueAt.getTime()) {
    return { status: waiting, state: { ...st, dueAt: dueAt.toISOString() }, result: { recurring: statusOf(st, dueAt) }, nextCheckAt: dueAt };
  }
  const next = nextRunAt(s, now);
  if (now.getTime() - dueAt.getTime() > LATE_MS) {
    // The server missed it by hours: a stale brief is worse than none.
    return {
      status: waiting,
      state: { ...st, dueAt: next.toISOString() },
      result: { recurring: statusOf(st, next) },
      events: [{ code: 'SKIPPED', data: { what: s.what, reason: 'late' } }],
      nextCheckAt: next,
    };
  }

  const brief = await makeBrief(t, s, c);
  const trail = (action: string, metadata: Record<string, unknown>) =>
    logBuiltInAgentAction(prisma, 'whatsapp-assistant', { action, entityType: 'HugoTask', entityId: t.id, metadata: { kind: 'RECURRING', what: s.what, ...metadata } });

  if (brief.kind === 'stop') {
    await trail('agent.task.recurring_stopped', { reason: brief.reason });
    return {
      status: 'FAILED',
      state: { ...st, dueAt: null },
      result: { recurring: statusOf(st, null) },
      events: [{ code: 'FAILED', data: { reason: brief.reason } }],
      notice: { ...RECURRING_NOTICE.stopped(c.lang, s.what), category: 'hugo_task_done', linkUrl: taskLink(t.id) },
    };
  }

  if (brief.kind === 'defer') {
    // Tomorrow at the same time, then the schedule as before.
    const tomorrow = nextRunAt({ ...s, cadence: 'DAILY', weekday: null }, new Date(now.getTime() + 12 * HOUR));
    await trail('agent.task.recurring_deferred', { reason: 'cap' });
    return {
      status: waiting,
      state: { ...st, dueAt: tomorrow.toISOString() },
      result: { recurring: statusOf(st, tomorrow) },
      events: [{ code: 'DEFERRED', data: { what: s.what, reason: 'cap' } }],
      nextCheckAt: tomorrow,
      notice: { subject: briefSubject(s.what, c.lang, s.question), body: RECURRING_NOTICE.tomorrow(c.lang), category: 'hugo_task_done', linkUrl: taskLink(t.id) },
    };
  }

  if (brief.kind === 'skip') {
    const quietSkips = brief.reason === 'no_model' ? (st.quietSkips ?? 0) + 1 : (st.quietSkips ?? 0);
    await trail('agent.task.recurring_skipped', { reason: brief.reason });
    return {
      status: waiting,
      state: { ...st, dueAt: next.toISOString(), quietSkips },
      result: { recurring: statusOf(st, next) },
      events: [{ code: 'SKIPPED', data: { what: s.what, reason: brief.reason, ...(brief.model ? { model: 1 } : {}) } }],
      nextCheckAt: next,
      // Said once, the first time free questions are off — not every day.
      ...(brief.reason === 'no_model' && quietSkips === 1
        ? { notice: { subject: briefSubject(s.what, c.lang, s.question), body: RECURRING_NOTICE.noModel(c.lang), category: 'hugo_task_done' as const, linkUrl: taskLink(t.id) } }
        : {}),
    };
  }

  // Never an SSN or an account number on a lock screen, whatever the answer said.
  const text = redactSensitiveNumbers(brief.text).slice(0, MAX_TEXT);
  const done: RecurringState = { ...st, dueAt: next.toISOString(), quietSkips: 0, deliveries: (st.deliveries ?? 0) + 1, lastAt: now.toISOString() };
  await trail('agent.task.delivered', { tier: brief.tier, source: brief.source });
  return {
    status: waiting,
    state: { ...done },
    result: { recurring: statusOf(done, next) },
    events: [{ code: 'DELIVERED', data: { what: s.what, text, tier: brief.tier, source: brief.source, ...(brief.model ? { model: 1 } : {}) } }],
    nextCheckAt: next,
    notice: { subject: briefSubject(s.what, c.lang, s.question), body: text, category: 'hugo_task_done', linkUrl: brief.linkUrl ?? taskLink(t.id) },
  };
}

/** Its 180 days ran out with no "keep going": it ends, and says so once. */
export function expireRecurring(t: HugoTask, c: RecurringCtx): RecurringOutcome {
  const s = (t.subject as HugoTaskSubject).recurring;
  const st = t.state as RecurringState;
  return {
    status: 'EXPIRED',
    state: { ...st, dueAt: null },
    result: { recurring: statusOf(st, null) },
    events: [{ code: 'EXPIRED' }],
    ...(s ? { notice: { ...RECURRING_NOTICE.ended(c.lang, s.what), category: 'hugo_task_done' as const, linkUrl: '/?hugo=tasks' } } : {}),
  };
}

/**
 * The person's "Keep going" (respondToHugoTask, under the claim it took at
 * c.now): another 180 days from today, and back to waiting for the next run.
 */
export async function keepGoingOutcome(t: HugoTask, c: RecurringCtx): Promise<RecurringOutcome> {
  const expiresAt = new Date(c.now.getTime() + RECURRING_LIFE_MS);
  await prisma.hugoTask.updateMany({ where: { id: t.id, claimedAt: c.now }, data: { expiresAt } });
  const s = (t.subject as HugoTaskSubject).recurring;
  const st: RecurringState = { ...(t.state as RecurringState), keepAsked: false };
  const due = st.dueAt ? new Date(st.dueAt) : null;
  return {
    status: 'WAITING',
    state: { ...st },
    events: [{ code: 'KEPT_GOING', data: { until: localDateKey(expiresAt, s?.timezone ?? companyWorkweek().timezone) } }],
    nextCheckAt: s?.paused || !due ? new Date(expiresAt.getTime() - KEEP_ASK_BEFORE_MS) : new Date(Math.max(c.now.getTime(), due.getTime())),
  };
}

/* ------------------------------------------------------ the person's say */

/**
 * Pause, resume or change when a brief comes (PATCH /hugo/recurring/:id).
 * Their own brief only; one change at a time under the task's guarded
 * claim, so a run in flight and a change never cross.
 */
export async function changeRecurring(user: SessionUser, taskId: string, change: HugoRecurringChange, now: Date = new Date()): Promise<void> {
  const t = await prisma.hugoTask.findFirst({ where: { id: taskId, userId: user.id } });
  if (!t || t.kind !== 'RECURRING') throw new HttpError(404, 'task_not_found', 'Task not found');
  if (!OPEN.includes(t.status as HugoTaskStatus)) throw new HttpError(409, 'task_closed', 'This has already ended.');
  const s0 = (t.subject as HugoTaskSubject).recurring;
  if (!s0) throw new HttpError(404, 'task_not_found', 'Task not found');

  const cadence = change.cadence ?? s0.cadence;
  const weekday = cadence === 'WEEKLY' ? (change.weekday ?? s0.weekday ?? null) : null;
  if (cadence === 'WEEKLY' && weekday === null) throw new HttpError(400, 'weekday_required', 'Pick the day of the week.');
  const time = change.time ?? s0.time;
  const s: HugoRecurringSchedule = { ...s0, cadence, weekday, time, paused: change.paused ?? s0.paused };
  const events: Array<{ code: HugoTaskEventCode; data: EventData }> = [];
  if (cadence !== s0.cadence || weekday !== s0.weekday || time !== s0.time) events.push({ code: 'RESCHEDULED', data: { cadence, weekday, time } });
  if (s.paused !== s0.paused) events.push({ code: s.paused ? 'PAUSED' : 'RESUMED', data: {} });
  if (!events.length) return;

  const claimed = await prisma.hugoTask.updateMany({
    where: { id: t.id, status: { in: [...OPEN] }, OR: [{ claimedAt: null }, { claimedAt: { lt: new Date(now.getTime() - STALE_CLAIM_MS) } }] },
    data: { claimedAt: now },
  });
  if (claimed.count !== 1) throw new HttpError(409, 'task_busy', 'Hugo is in the middle of a step on this — try again in a moment.');
  try {
    const st: RecurringState = { ...(t.state as RecurringState) };
    const next = s.paused ? null : nextRunAt(s, now);
    const wake = next ?? (st.keepAsked ? t.expiresAt : new Date(Math.max(now.getTime() + MIN, t.expiresAt.getTime() - KEEP_ASK_BEFORE_MS)));
    const params: Record<string, unknown> = { ...(t.params as Record<string, unknown>), cadence, time, weekday: weekday ?? undefined };
    params.key = recurringKey({ kind: 'RECURRING', what: s.what, cadence, time, ...(weekday === null ? {} : { weekday }), ...(s.question ? { question: s.question } : {}) });
    await prisma.hugoTask.updateMany({
      where: { id: t.id, claimedAt: now },
      data: {
        subject: { ...(t.subject as object), recurring: s } as unknown as Prisma.InputJsonValue,
        params: params as Prisma.InputJsonValue,
        state: { ...st, dueAt: next ? next.toISOString() : null } as Prisma.InputJsonValue,
        result: { ...((t.result as object | null) ?? {}), recurring: statusOf(st, next) } as unknown as Prisma.InputJsonValue,
        nextCheckAt: wake,
        claimedAt: null,
      },
    });
    // After the trail's last line, whatever this server's clock says: the trail reads in the order it happened.
    const last = await prisma.hugoTaskEvent.findFirst({ where: { taskId: t.id }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
    const base = Math.max(now.getTime(), (last?.createdAt.getTime() ?? 0) + 1);
    for (const [i, e] of events.entries()) {
      await prisma.hugoTaskEvent.create({ data: { tenantId: t.tenantId, taskId: t.id, code: e.code, data: e.data as Prisma.InputJsonValue, createdAt: new Date(base + i) } });
    }
  } catch (err) {
    await prisma.hugoTask.updateMany({ where: { id: t.id, claimedAt: now }, data: { claimedAt: null } });
    throw err;
  }
  const codes = events.map((e) => e.code);
  await logBuiltInAgentAction(prisma, 'whatsapp-assistant', { action: 'agent.task.recurring_changed', entityType: 'HugoTask', entityId: t.id, metadata: { kind: 'RECURRING', what: s.what, changes: codes } });
  enqueueAudit({ actorUserId: user.id, clientId: user.clientId ?? null, action: 'hugo.recurring_changed', entityType: 'HugoTask', entityId: t.id, metadata: { what: s.what, changes: codes, cadence, paused: s.paused } }, 'hugo');
  emitLiveEvent(user.id, 'hugo');
}
