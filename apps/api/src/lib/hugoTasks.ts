import { Prisma, type HugoTask, type HugoTaskEvent } from '@prisma/client';
import {
  HUGO_TASK_CHOICES_FOR,
  HUGO_TASK_FOR,
  HUGO_TASK_OPEN_STATUSES,
  can,
  type HugoShiftRef,
  type HugoTaskChoice,
  type HugoTaskCreate,
  type HugoTaskEventCode,
  type HugoTaskKind,
  type HugoTaskNeed,
  type HugoTaskResult,
  type HugoTaskStatus,
  type HugoTaskSubject,
  type HugoTaskView,
  type TenantModule,
} from '@alto-people/shared';
import { env } from '../config/env.js';
import { prisma } from '../db.js';
import { sessionUserById } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import type { SessionUser } from '../types/express.js';
import { logBuiltInAgentAction, type AgentContext } from './agents.js';
import { enqueueAudit } from './audit.js';
import { armJob, stopJob } from './jobs.js';
import { HUGO_NOTICE, hugoDay, hugoPeriod, hugoWhen, type HugoLang } from './hugoWorkCopy.js';
import { SHIFT_REF_SELECT, hugoAgent, openShiftsThatFit, readerOf, sendHugoNotice, shiftRefOf } from './hugoWork.js';
import { emitLiveEvent } from './liveEvents.js';
import { notifyUser } from './notify.js';
import { scopeShifts } from './scope.js';
import { nudgeUnconfirmedShifts } from './shiftConfirmNudge.js';
import { cancelSwapRequest, createSwapRequest, swapCandidatesFor } from './shiftSwaps.js';
import { runWithTenant } from './tenant.js';
import { tenantJob } from './tenantJobs.js';
import { moduleOn } from './tenantProfile.js';
import { DEFAULT_TIMEZONE, addDaysInZone, localDateKey, zonedWallTimeToUtcInstant } from './timezone.js';
import { onWebhookEvent } from './webhookDispatch.js';
import { handoff } from './whatsappAssistant.js';

/**
 * Hugo's tasks (packages/shared/src/hugoWork.ts): work a person handed the
 * assistant with a tap, carried out on the server while they do other things.
 *
 *   startHugoTask      the person's tap: checks, captures what it is about, takes the first step
 *   advanceHugoTask    one step: claim the row, look at the records, write what changed
 *   sweepHugoTasks     the timer (and reading the list) advances every task that is due
 *   respondToHugoTask  the person's answer to a NEEDS_YOU
 *   cancelHugoTask     stop; anything Hugo started (a swap request in flight) is withdrawn
 *
 *   Rules every kind keeps:
 *     - Only the person's own records, read fresh each step with the reach
 *       they have now (sessionUserById) — a role revoked mid-task stops it.
 *     - Nothing changes a record without the person's tap. Asking a coworker
 *       to cover a shift is the one thing a task does on their behalf, and
 *       starting that task is the tap: their manager still approves, and they
 *       stay on the shift until then.
 *     - One step at a time per task: a guarded claim (claimedAt), taken over
 *       when stale, so two servers or a sweep and a read never both act.
 *     - Every step is on the task's trail; every notice carries the AI
 *       disclosure and Hugo's id; every state change is on Hugo's agent trail.
 */

const OPEN = HUGO_TASK_OPEN_STATUSES as readonly HugoTaskStatus[];
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const STALE_CLAIM_MS = 2 * MIN;
const MAX_OPEN_PER_USER = 10;
const WATCH_DAYS = 35;
const MAX_STEP_ERRORS = 5;
/** A finished task stays in the list this long. */
const KEEP_FINISHED_MS = 14 * DAY;
/** Find-cover never asks for a shift that starts sooner than this — calling off is the honest path then. */
const COVER_MIN_LEAD_MS = 3 * HOUR;
const MAX_RENUDGES = 3;

/** How long to wait before looking again, by kind. */
const GAP: Record<HugoTaskKind, number> = {
  WATCH_TIME_OFF: 10 * MIN,
  WATCH_OPEN_SHIFTS: 30 * MIN,
  WATCH_PAYCHECK: 15 * MIN,
  WATCH_DOCUMENT: 10 * MIN,
  FIND_COVER: 10 * MIN,
  CHASE_CONFIRMATIONS: 20 * MIN,
};

/** The modules a kind needs on. */
const NEEDS_MODULE: Partial<Record<HugoTaskKind, TenantModule>> = {
  WATCH_OPEN_SHIFTS: 'scheduling',
  FIND_COVER: 'scheduling',
  CHASE_CONFIRMATIONS: 'scheduling',
};

type EventData = Record<string, string | number | null>;
type Notice = { subject: string; body: string; category: 'hugo_task_done' | 'hugo_task_needs_you'; linkUrl: string; full?: boolean };

interface Outcome {
  status?: HugoTaskStatus;
  needs?: HugoTaskNeed | null;
  state?: Record<string, unknown>;
  progress?: { done: number; total: number } | null;
  result?: HugoTaskResult | null;
  linkUrl?: string | null;
  events?: Array<{ code: HugoTaskEventCode; data?: EventData }>;
  nextCheckAt?: Date;
  notice?: Notice;
}

interface Ctx {
  now: Date;
  agent: AgentContext;
  lang: HugoLang;
}

/** What every associate task carries in its params besides the person's input. */
interface Params {
  kind: HugoTaskKind;
  key: string;
  associateId?: string | null;
  requestId?: string;
  days?: number;
  documentId?: string;
  shiftId?: string;
  note?: string;
  date?: string;
}

interface CoverAsk {
  associateId: string;
  name: string;
  swapId: string;
  askedAt: string;
  outcome: 'PENDING' | 'NO_ANSWER' | 'DECLINED' | 'ACCEPTED' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
}
interface CoverState {
  queue: string[];
  asked: CoverAsk[];
  current: string | null;
  /** The person said "keep trying": look again for someone free, hourly, without another notice. */
  retrying?: boolean;
  acceptedReported?: boolean;
  errors?: number;
}
interface ChaseState {
  nudged?: boolean;
  cutoffAt?: string;
  reportedCallOffs?: string[];
  renudges?: number;
  errors?: number;
}
interface WatchState {
  reported?: string[];
  errors?: number;
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const taskLink = (id: string) => `/?hugo=task:${id}`;
/** "Maria G." — enough to know who, on a trail only the requester reads. */
const shortName = (first: string, last: string) => `${first} ${last ? `${last.charAt(0)}.` : ''}`.trim();

/* ------------------------------------------------------------------ start */

/** The same task, asked twice, is one task. */
function keyOf(input: HugoTaskCreate): string {
  switch (input.kind) {
    case 'WATCH_TIME_OFF':
      return `${input.kind}:${input.requestId ?? 'all'}`;
    case 'WATCH_DOCUMENT':
      return `${input.kind}:${input.documentId ?? 'all'}`;
    case 'FIND_COVER':
      return `${input.kind}:${input.shiftId}`;
    case 'CHASE_CONFIRMATIONS':
      return `${input.kind}:${input.date ?? 'next'}`;
    default:
      return input.kind;
  }
}

/** The calendar day in a zone, as [start, end). */
function dayWindow(day: string, tz: string): { start: Date; end: Date } {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const start = zonedWallTimeToUtcInstant(y, m, d, 0, tz);
  return { start, end: addDaysInZone(start, 1, tz) };
}

/** Tomorrow on the desk's clock. */
function tomorrowIn(tz: string, now: Date): string {
  return localDateKey(addDaysInZone(now, 1, tz), tz);
}

/** Who Hugo asks first: coworkers with the fewest hours that week, so no one is pushed into overtime. */
async function coverQueue(shift: { id: string; startsAt: Date }, candidates: Array<{ associateId: string; name: string }>): Promise<string[]> {
  if (!candidates.length) return [];
  const rows = await prisma.shift.findMany({
    where: {
      assignedAssociateId: { in: candidates.map((c) => c.associateId) },
      status: { notIn: ['CANCELLED'] },
      startsAt: { gte: new Date(shift.startsAt.getTime() - 3 * DAY), lt: new Date(shift.startsAt.getTime() + 4 * DAY) },
    },
    select: { assignedAssociateId: true, startsAt: true, endsAt: true },
  });
  const minutes = new Map<string, number>();
  for (const r of rows) minutes.set(r.assignedAssociateId!, (minutes.get(r.assignedAssociateId!) ?? 0) + (r.endsAt.getTime() - r.startsAt.getTime()) / MIN);
  return [...candidates]
    .sort((a, b) => (minutes.get(a.associateId) ?? 0) - (minutes.get(b.associateId) ?? 0) || a.name.localeCompare(b.name))
    .map((c) => c.associateId);
}

interface Prepared {
  subject: HugoTaskSubject;
  state: Record<string, unknown>;
  expiresAt: Date;
  linkUrl: string | null;
  progress?: { done: number; total: number } | null;
}

async function prepare(user: SessionUser, input: HugoTaskCreate, now: Date): Promise<Prepared> {
  const associateId = user.associateId;
  switch (input.kind) {
    case 'WATCH_TIME_OFF': {
      const reqs = await prisma.timeOffRequest.findMany({
        where: { associateId: associateId!, status: 'PENDING', ...(input.requestId ? { id: input.requestId } : {}) },
        orderBy: { startDate: 'asc' },
        take: 10,
        select: { id: true, startDate: true, endDate: true },
      });
      if (!reqs.length) {
        throw new HttpError(409, 'nothing_pending', input.requestId ? 'That request has already been decided.' : 'You have no time-off request waiting for a decision.');
      }
      return {
        subject: { timeOff: reqs.map((r) => ({ id: r.id, startDate: ymd(r.startDate), endDate: ymd(r.endDate) })) },
        state: {},
        expiresAt: new Date(now.getTime() + WATCH_DAYS * DAY),
        linkUrl: '/time-off',
      };
    }
    case 'WATCH_OPEN_SHIFTS':
      return { subject: { days: input.days }, state: {}, expiresAt: new Date(now.getTime() + input.days * DAY), linkUrl: '/marketplace' };
    case 'WATCH_PAYCHECK':
      return { subject: {}, state: {}, expiresAt: new Date(now.getTime() + WATCH_DAYS * DAY), linkUrl: '/payroll' };
    case 'WATCH_DOCUMENT': {
      const docs = await prisma.documentRecord.findMany({
        where: { associateId: associateId!, status: 'UPLOADED', deletedAt: null, purgedAt: null, ...(input.documentId ? { id: input.documentId } : {}) },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { id: true, filename: true, kind: true },
      });
      if (!docs.length) {
        throw new HttpError(409, 'nothing_in_review', input.documentId ? 'That document has already been reviewed.' : 'You have no document waiting for review.');
      }
      return {
        subject: { documents: docs.map((d) => ({ id: d.id, name: d.filename, kind: d.kind })) },
        state: {},
        expiresAt: new Date(now.getTime() + WATCH_DAYS * DAY),
        linkUrl: '/documents',
      };
    }
    case 'FIND_COVER': {
      const shift = await prisma.shift.findFirst({
        where: { id: input.shiftId, assignedAssociateId: associateId!, publishedAt: { not: null } },
        select: { ...SHIFT_REF_SELECT, status: true },
      });
      if (!shift || shift.status !== 'ASSIGNED') throw new HttpError(404, 'shift_not_found', 'That shift is not one of yours.');
      if (shift.startsAt.getTime() - now.getTime() < COVER_MIN_LEAD_MS) {
        throw new HttpError(409, 'too_soon', 'This shift starts too soon to find cover. If you cannot make it, call off in the app so your supervisor knows.');
      }
      const inFlight = await prisma.shiftSwapRequest.findFirst({ where: { shiftId: shift.id, status: { in: ['PENDING_PEER', 'PEER_ACCEPTED'] } }, select: { id: true } });
      if (inFlight) throw new HttpError(409, 'swap_in_flight', 'A swap for this shift is already waiting on an answer.');
      const found = await swapCandidatesFor(prisma, shift.id, associateId!);
      const free = (found?.candidates ?? []).filter((c) => !c.busy && c.userId);
      const queue = await coverQueue(shift, free);
      return {
        subject: { shift: shiftRefOf(shift) },
        state: { queue, asked: [], current: null } satisfies CoverState,
        expiresAt: new Date(shift.startsAt.getTime() - HOUR),
        linkUrl: '/scheduling',
        progress: { done: 0, total: queue.length },
      };
    }
    case 'CHASE_CONFIRMATIONS': {
      const tz = user.timezone ?? DEFAULT_TIMEZONE;
      const today = localDateKey(now, tz);
      const date = input.date ?? tomorrowIn(tz, now);
      const last = localDateKey(addDaysInZone(now, 7, tz), tz);
      if (date < today || date > last) throw new HttpError(400, 'invalid_date', 'Pick a day in the next week.');
      const { start, end } = dayWindow(date, tz);
      const total = await prisma.shift.count({ where: { AND: [scopeShifts(user), chaseWindow(start, end, now)] } });
      if (!total) throw new HttpError(409, 'nothing_to_chase', 'No shifts that day need confirming.');
      return { subject: { date, shifts: total }, state: {}, expiresAt: end, linkUrl: '/approvals?tab=unconfirmed', progress: { done: 0, total } };
    }
  }
}

/** Assigned, published shifts still ahead on that day. */
function chaseWindow(start: Date, end: Date, now: Date): Prisma.ShiftWhereInput {
  return { status: 'ASSIGNED', publishedAt: { not: null }, assignedAssociateId: { not: null }, startsAt: { gte: start, lt: end, gt: now } };
}

/** May this person start this kind, here? Throws the reason when not. */
async function assertMayStart(user: SessionUser, kind: HugoTaskKind): Promise<void> {
  if (HUGO_TASK_FOR[kind] === 'associate' && !user.associateId) throw new HttpError(403, 'not_an_associate', 'Only someone with their own schedule and pay can start this.');
  if (HUGO_TASK_FOR[kind] === 'desk' && !can(user, 'manage:scheduling')) throw new HttpError(403, 'forbidden', 'This needs a scheduling desk.');
  const module = NEEDS_MODULE[kind];
  if (module && !(await moduleOn(module))) throw new HttpError(404, 'module_off', 'That part of the app is not on here.');
}

/**
 * The person's tap. Asked twice, the same task comes back (`existing`);
 * otherwise it is created, its first step is taken at once — the answer
 * shows what Hugo actually did — and it carries on in the background.
 */
export async function startHugoTask(
  user: SessionUser,
  input: HugoTaskCreate,
  source: 'panel' | 'chat' | 'note',
  now: Date = new Date(),
  noteId: string | null = null,
): Promise<{ task: HugoTaskView; existing: boolean }> {
  await assertMayStart(user, input.kind);
  const key = keyOf(input);
  const same = await prisma.hugoTask.findFirst({
    where: { userId: user.id, kind: input.kind, status: { in: [...OPEN] }, params: { path: ['key'], equals: key } },
    include: { events: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
  });
  if (same) return { task: toHugoTaskView(same), existing: true };
  const open = await prisma.hugoTask.count({ where: { userId: user.id, status: { in: [...OPEN] } } });
  if (open >= MAX_OPEN_PER_USER) throw new HttpError(409, 'too_many_tasks', `${MAX_OPEN_PER_USER} tasks are already running. Finish or stop one first.`);

  const prep = await prepare(user, input, now);
  const params: Params = { ...input, key, associateId: user.associateId ?? null };
  const task = await prisma.hugoTask.create({
    data: {
      userId: user.id,
      kind: input.kind,
      status: 'WORKING',
      params: params as unknown as Prisma.InputJsonValue,
      subject: prep.subject as Prisma.InputJsonValue,
      state: prep.state as Prisma.InputJsonValue,
      progress: prep.progress ?? Prisma.DbNull,
      linkUrl: prep.linkUrl,
      source,
      noteId,
      expiresAt: prep.expiresAt,
      nextCheckAt: now,
      // The app's clock, like every later line: the trail reads in the order it happened.
      events: { create: [{ code: 'STARTED', data: {}, createdAt: now }] },
    },
  });
  await logBuiltInAgentAction(prisma, 'whatsapp-assistant', { action: 'agent.task.started', entityType: 'HugoTask', entityId: task.id, metadata: { kind: task.kind, source } });
  enqueueAudit({ actorUserId: user.id, clientId: user.clientId ?? null, action: 'hugo.task_started', entityType: 'HugoTask', entityId: task.id, metadata: { kind: task.kind, source } }, 'hugo');
  await advanceHugoTask(task.id, new Date(now.getTime() + 1));
  return { task: await viewOf(task.id), existing: false };
}

/* ------------------------------------------------------------------ steps */

const STEPS: Record<HugoTaskKind, (t: HugoTask, c: Ctx) => Promise<Outcome>> = {
  WATCH_TIME_OFF: stepTimeOff,
  WATCH_OPEN_SHIFTS: stepOpenShifts,
  WATCH_PAYCHECK: stepPaycheck,
  WATCH_DOCUMENT: stepDocument,
  FIND_COVER: stepCover,
  CHASE_CONFIRMATIONS: stepChase,
};

/**
 * Time off: the decision itself already reaches the person (lib/timeOffRequests),
 * so a decided watch closes on Hugo's own surfaces without a second notice.
 */
async function stepTimeOff(t: HugoTask, _c: Ctx): Promise<Outcome> {
  const p = t.params as unknown as Params;
  const s = t.state as WatchState;
  const ids = ((t.subject as HugoTaskSubject).timeOff ?? []).map((r) => r.id);
  const rows = await prisma.timeOffRequest.findMany({ where: { id: { in: ids }, associateId: p.associateId! }, select: { id: true, status: true, startDate: true, endDate: true } });
  if (!rows.length) return { status: 'FAILED', events: [{ code: 'FAILED', data: { reason: 'gone' } }] };
  const reported = new Set(s.reported ?? []);
  const events: Outcome['events'] = [];
  for (const r of rows) {
    if (r.status === 'PENDING' || reported.has(r.id)) continue;
    events.push({ code: 'DECIDED', data: { status: r.status, startDate: ymd(r.startDate), endDate: ymd(r.endDate) } });
    reported.add(r.id);
  }
  const decided = rows.filter((r) => r.status !== 'PENDING');
  const result: HugoTaskResult = {
    timeOff: decided.map((r) => ({ id: r.id, startDate: ymd(r.startDate), endDate: ymd(r.endDate), status: r.status as 'APPROVED' | 'DENIED' | 'CANCELLED' })),
  };
  const state = { ...s, reported: [...reported] };
  if (decided.length === rows.length) return { status: 'DONE', events, result, state };
  return { status: 'WAITING', events, result: decided.length ? result : undefined, state };
}

async function stepOpenShifts(t: HugoTask, c: Ctx): Promise<Outcome> {
  const p = t.params as unknown as Params;
  const before = new Date(Math.min(t.expiresAt.getTime(), c.now.getTime() + 14 * DAY));
  const fits = await openShiftsThatFit(p.associateId!, { before });
  if (!fits.length) return { status: 'WAITING' };
  const first = fits[0]!;
  const link = `/marketplace?shift=${first.id}`;
  return {
    status: 'DONE',
    result: { shifts: fits.slice(0, 5) },
    linkUrl: link,
    events: [{ code: 'FOUND_SHIFTS', data: { count: fits.length, startsAt: first.startsAt, timezone: first.timezone, site: first.site } }],
    notice: { ...HUGO_NOTICE.openShifts(c.lang, fits.length, hugoWhen(new Date(first.startsAt), first.timezone, c.lang), first.site), category: 'hugo_task_done', linkUrl: link },
  };
}

async function stepPaycheck(t: HugoTask, c: Ctx): Promise<Outcome> {
  const p = t.params as unknown as Params;
  const item = await prisma.payrollItem.findFirst({
    where: {
      associateId: p.associateId!,
      status: 'DISBURSED',
      OR: [{ disbursedAt: { gte: t.createdAt } }, { disbursedAt: null, updatedAt: { gte: t.createdAt } }],
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, payrollRun: { select: { periodStart: true, periodEnd: true } } },
  });
  if (!item) return { status: 'WAITING' };
  const periodStart = ymd(item.payrollRun.periodStart);
  const periodEnd = ymd(item.payrollRun.periodEnd);
  const link = `/payroll?item=${item.id}`;
  return {
    status: 'DONE',
    result: { paycheck: { itemId: item.id, periodStart, periodEnd } },
    linkUrl: link,
    events: [{ code: 'PAID', data: { periodStart, periodEnd } }],
    notice: { ...HUGO_NOTICE.paycheck(c.lang, hugoPeriod(periodStart, periodEnd, c.lang)), category: 'hugo_task_done', linkUrl: link },
  };
}

async function stepDocument(t: HugoTask, c: Ctx): Promise<Outcome> {
  const p = t.params as unknown as Params;
  const s = t.state as WatchState;
  const ids = ((t.subject as HugoTaskSubject).documents ?? []).map((d) => d.id);
  const docs = await prisma.documentRecord.findMany({
    where: { id: { in: ids }, associateId: p.associateId!, deletedAt: null },
    select: { id: true, status: true, filename: true, rejectionReason: true },
  });
  // A document replaced, purged or expired before review is no longer waiting on anyone.
  const live = docs.filter((d) => d.status !== 'EXPIRED');
  if (!live.length) return { status: 'FAILED', events: [{ code: 'FAILED', data: { reason: 'gone' } }] };
  const reported = new Set(s.reported ?? []);
  const events: Outcome['events'] = [];
  for (const d of live) {
    if (d.status === 'UPLOADED' || reported.has(d.id)) continue;
    events.push(d.status === 'VERIFIED' ? { code: 'DOC_VERIFIED', data: { document: d.filename } } : { code: 'DOC_REJECTED', data: { document: d.filename, reason: d.rejectionReason ?? null } });
    reported.add(d.id);
  }
  const decided = live.filter((d) => d.status === 'VERIFIED' || d.status === 'REJECTED');
  const state = { ...s, reported: [...reported] };
  const result: HugoTaskResult = {
    documents: decided.map((d) => ({ id: d.id, name: d.filename, status: d.status as 'VERIFIED' | 'REJECTED', reason: d.status === 'REJECTED' ? (d.rejectionReason ?? null) : null })),
  };
  if (decided.length < live.length) return { status: 'WAITING', events, state, result: decided.length ? result : undefined };
  const rejected = decided.find((d) => d.status === 'REJECTED');
  if (rejected) {
    return {
      status: 'NEEDS_YOU',
      needs: 'REUPLOAD',
      events,
      state,
      result,
      linkUrl: '/documents',
      notice: { ...HUGO_NOTICE.docRejected(c.lang, rejected.filename, rejected.rejectionReason ?? null), category: 'hugo_task_needs_you', linkUrl: '/documents', full: true },
    };
  }
  return {
    status: 'DONE',
    events,
    state,
    result,
    notice: { ...HUGO_NOTICE.docVerified(c.lang, decided.map((d) => d.filename).join(', ')), category: 'hugo_task_done', linkUrl: '/documents' },
  };
}

/** How long a coworker has to answer before Hugo asks the next: a quarter of the time left, one to six hours. */
function peerWindowMs(startsAt: Date, askedAt: Date): number {
  const left = startsAt.getTime() - askedAt.getTime() - HOUR;
  return Math.min(6 * HOUR, Math.max(HOUR, left / 4));
}

/** Withdraw an ask Hugo made, and tell that coworker quietly so a late "yes" doesn't surprise them. */
async function withdrawAsk(t: HugoTask, swapId: string, c: Ctx): Promise<void> {
  const p = t.params as unknown as Params;
  try {
    const swap = await cancelSwapRequest(prisma, swapId, p.associateId!);
    const peer = await prisma.user.findFirst({ where: { associateId: swap.counterpartyAssociateId, status: 'ACTIVE', deletedAt: null }, select: { id: true, language: true } });
    if (!peer) return;
    const { lang } = await readerOf(peer.id);
    const tz = swap.shift.locationRel?.timezone ?? DEFAULT_TIMEZONE;
    const n = HUGO_NOTICE.swapClosed(lang, swap.requester.firstName, hugoWhen(swap.shift.startsAt, tz, lang));
    await notifyUser(peer.id, { subject: n.subject, body: n.body, category: 'swap_request_closed', quiet: true, byAgentId: c.agent.workerId, linkUrl: '/scheduling' });
  } catch (err) {
    // Already decided or withdrawn elsewhere: nothing left to withdraw.
    if (!(err instanceof HttpError)) throw err;
  }
}

async function stepCover(t: HugoTask, c: Ctx): Promise<Outcome> {
  const p = t.params as unknown as Params;
  const st = structuredClone(t.state) as unknown as CoverState;
  const subject = t.subject as HugoTaskSubject;
  const when = hugoWhen(new Date(subject.shift!.startsAt), subject.shift!.timezone, c.lang);
  const events: NonNullable<Outcome['events']> = [];
  const progress = () => ({ done: st.asked.length, total: Math.max(st.asked.length, st.queue.length) });

  // 1. The ask in flight decides most things.
  if (st.current) {
    const swap = await prisma.shiftSwapRequest.findUnique({
      where: { id: st.current },
      select: { id: true, status: true, counterparty: { select: { firstName: true, lastName: true } } },
    });
    const ask = st.asked.find((a) => a.swapId === st.current);
    const name = ask?.name ?? (swap ? shortName(swap.counterparty.firstName, swap.counterparty.lastName) : '');
    const full = swap ? `${swap.counterparty.firstName} ${swap.counterparty.lastName}` : name;
    const settle = (outcome: CoverAsk['outcome']) => {
      if (ask) ask.outcome = outcome;
    };
    switch (swap?.status) {
      case 'MANAGER_APPROVED':
        settle('APPROVED');
        return {
          status: 'DONE',
          state: { ...st },
          progress: progress(),
          result: { coveredBy: name },
          events: [{ code: 'APPROVED', data: { name } }],
          notice: { ...HUGO_NOTICE.coverDone(c.lang, full, when), category: 'hugo_task_done', linkUrl: '/scheduling', full: true },
        };
      case 'MANAGER_REJECTED':
        settle('REJECTED');
        st.current = null;
        return {
          status: 'NEEDS_YOU',
          needs: 'MANAGER_REJECTED',
          state: { ...st },
          progress: progress(),
          events: [{ code: 'REJECTED', data: { name } }],
          notice: { ...HUGO_NOTICE.coverRejected(c.lang, when), category: 'hugo_task_needs_you', linkUrl: taskLink(t.id), full: true },
        };
      case 'PEER_ACCEPTED':
        // The swap flow tells the person and the supervisors; Hugo waits on the decision.
        settle('ACCEPTED');
        if (!st.acceptedReported) events.push({ code: 'ACCEPTED', data: { name } });
        st.acceptedReported = true;
        return { status: 'WAITING', state: { ...st }, progress: progress(), events };
      case 'PENDING_PEER': {
        const askedAt = new Date(ask?.askedAt ?? c.now);
        const due = askedAt.getTime() + peerWindowMs(new Date(subject.shift!.startsAt), askedAt);
        if (c.now.getTime() < due) return { status: 'WAITING', state: { ...st }, nextCheckAt: new Date(Math.min(due, c.now.getTime() + GAP.FIND_COVER)) };
        await withdrawAsk(t, swap.id, c);
        settle('NO_ANSWER');
        events.push({ code: 'NO_ANSWER', data: { name } });
        st.current = null;
        break;
      }
      case 'PEER_DECLINED':
        settle('DECLINED');
        events.push({ code: 'DECLINED', data: { name } });
        st.current = null;
        break;
      default:
        // Withdrawn from the swap screen (or gone): the person took it from here.
        settle('CANCELLED');
        return { status: 'CANCELLED', state: { ...st, current: null }, events: [{ code: 'CANCELLED', data: { by: 'swap' } }] };
    }
  }

  // 2. The shift has to still be theirs to give.
  const shift = await prisma.shift.findUnique({ where: { id: p.shiftId! }, select: { status: true, assignedAssociateId: true, startsAt: true } });
  if (!shift || shift.status !== 'ASSIGNED' || shift.assignedAssociateId !== p.associateId) {
    return { status: 'CANCELLED', state: { ...st }, events: [...events, { code: 'SHIFT_CHANGED' }] };
  }

  // 3. Ask the next coworker who is still free.
  const found = await swapCandidatesFor(prisma, p.shiftId!, p.associateId!);
  const free = new Map((found?.candidates ?? []).filter((x) => !x.busy && x.userId).map((x) => [x.associateId, x]));
  const asked = new Set(st.asked.map((a) => a.associateId));
  if (st.retrying) {
    // Someone free since the last look joins the end of the line.
    for (const id of free.keys()) if (!st.queue.includes(id)) st.queue.push(id);
  }
  const nextId = st.queue.find((id) => !asked.has(id) && free.has(id));
  if (!nextId) {
    if (st.retrying) return { status: 'WAITING', state: { ...st }, progress: progress(), events, nextCheckAt: new Date(c.now.getTime() + HOUR) };
    return {
      status: 'NEEDS_YOU',
      needs: 'NO_ONE_LEFT',
      state: { ...st },
      progress: progress(),
      events: [...events, { code: 'NO_ONE_LEFT', data: { asked: st.asked.length } }],
      notice: { ...HUGO_NOTICE.coverNoOne(c.lang, st.asked.length, when), category: 'hugo_task_needs_you', linkUrl: taskLink(t.id), full: true },
    };
  }
  const who = await prisma.associate.findUnique({ where: { id: nextId }, select: { firstName: true, lastName: true } });
  const name = who ? shortName(who.firstName, who.lastName) : '';
  try {
    const created = await createSwapRequest(
      prisma,
      { requesterAssociateId: p.associateId!, actorUserId: t.userId, shiftId: p.shiftId!, counterpartyAssociateId: nextId, note: p.note ?? null },
      { managerCopy: false },
    );
    st.asked.push({ associateId: nextId, name, swapId: created.id, askedAt: c.now.toISOString(), outcome: 'PENDING' });
    st.current = created.id;
    st.acceptedReported = false;
    events.push({ code: 'ASKED', data: { name } });
    return { status: 'WAITING', state: { ...st }, progress: progress(), events, nextCheckAt: new Date(c.now.getTime() + GAP.FIND_COVER) };
  } catch (err) {
    if (err instanceof HttpError && (err.code === 'shift_not_assigned' || err.code === 'not_your_shift' || err.code === 'shift_not_found')) {
      return { status: 'CANCELLED', state: { ...st }, events: [...events, { code: 'SHIFT_CHANGED' }] };
    }
    if (err instanceof HttpError && err.code === 'counterparty_not_found') {
      // Gone since the line was made: skip them and look again now.
      st.queue = st.queue.filter((id) => id !== nextId);
      return { status: 'WORKING', state: { ...st }, events, nextCheckAt: c.now };
    }
    throw err;
  }
}

/** Where the desk's chase stands for the day: confirmed, called off, still waiting. */
async function chaseStatus(user: SessionUser, day: string, now: Date) {
  const tz = user.timezone ?? DEFAULT_TIMEZONE;
  const { start, end } = dayWindow(day, tz);
  const where: Prisma.ShiftWhereInput = { AND: [scopeShifts(user), chaseWindow(start, end, now)] };
  const shifts = await prisma.shift.findMany({
    where,
    orderBy: { startsAt: 'asc' },
    take: 500,
    select: {
      ...SHIFT_REF_SELECT,
      acknowledgedAt: true,
      assignedAssociateId: true,
      assignedAssociate: { select: { firstName: true, lastName: true } },
      attendanceConfirmation: { select: { answer: true } },
      callOuts: { where: { status: { not: 'CANCELLED' } }, select: { associateId: true } },
    },
  });
  const row = (s: (typeof shifts)[number]) => {
    const ref = shiftRefOf(s);
    return { shiftId: s.id, name: s.assignedAssociate ? `${s.assignedAssociate.firstName} ${s.assignedAssociate.lastName}` : '', startsAt: ref.startsAt, timezone: ref.timezone, site: ref.site };
  };
  const calledOff = shifts.filter((s) => s.attendanceConfirmation?.answer === 'NO' || s.callOuts.some((x) => x.associateId === s.assignedAssociateId));
  const off = new Set(calledOff.map((s) => s.id));
  const confirmed = shifts.filter((s) => s.acknowledgedAt && !off.has(s.id));
  const waiting = shifts.filter((s) => !s.acknowledgedAt && !off.has(s.id));
  return { where, start, tz, total: shifts.length, confirmed: confirmed.length, calledOff: calledOff.map(row), waiting: waiting.map(row) };
}

/** When the chase reports back: 8 PM the evening before, or two hours before the first shift — never sooner than an hour from now. */
function chaseCutoff(dayStart: Date, firstStart: string | null, now: Date): Date {
  const evening = dayStart.getTime() - 4 * HOUR;
  const beforeFirst = firstStart ? new Date(firstStart).getTime() - 2 * HOUR : evening;
  return new Date(Math.max(now.getTime() + HOUR, Math.min(evening, beforeFirst)));
}

async function stepChase(t: HugoTask, c: Ctx): Promise<Outcome> {
  const user = await sessionUserById(t.userId);
  if (!user || !can(user, 'manage:scheduling')) return { status: 'FAILED', events: [{ code: 'FAILED', data: { reason: 'no_access' } }] };
  const st = { ...(t.state as ChaseState) };
  const subject = t.subject as HugoTaskSubject;
  const day = subject.date!;
  const now = c.now;
  const events: NonNullable<Outcome['events']> = [];
  if (!st.nudged) {
    const s0 = await chaseStatus(user, day, now);
    const { nudged } = await nudgeUnconfirmedShifts(prisma, s0.where, t.userId, now);
    events.push({ code: 'NUDGED', data: { count: nudged } });
    st.nudged = true;
    st.cutoffAt = chaseCutoff(s0.start, s0.waiting[0]?.startsAt ?? null, now).toISOString();
  }
  const s = await chaseStatus(user, day, now);
  const progress = { done: s.confirmed, total: s.total };
  const dayLabel = hugoDay(day, c.lang);

  // Someone said they can't come: that is the desk's to cover, now.
  const reported = new Set(st.reportedCallOffs ?? []);
  const fresh = s.calledOff.filter((x) => !reported.has(x.shiftId));
  if (fresh.length) {
    for (const x of fresh) {
      events.push({ code: 'CALLED_OFF', data: { name: x.name, startsAt: x.startsAt, timezone: x.timezone } });
      reported.add(x.shiftId);
    }
    const first = fresh[0]!;
    return {
      status: 'NEEDS_YOU',
      needs: 'CALLED_OFF',
      state: { ...st, reportedCallOffs: [...reported] },
      progress,
      events,
      result: { calledOff: s.calledOff, unconfirmed: s.waiting },
      linkUrl: `/scheduling?shift=${first.shiftId}`,
      notice: { ...HUGO_NOTICE.chaseCalledOff(c.lang, first.name, hugoWhen(new Date(first.startsAt), first.timezone, c.lang)), category: 'hugo_task_needs_you', linkUrl: `/scheduling?shift=${first.shiftId}`, full: true },
    };
  }
  if (!s.waiting.length) {
    return {
      status: 'DONE',
      state: st,
      progress,
      events: [...events, { code: 'ALL_CONFIRMED', data: { count: s.confirmed } }],
      result: { calledOff: s.calledOff, unconfirmed: [] },
      notice: { ...HUGO_NOTICE.chaseDone(c.lang, dayLabel, s.confirmed), category: 'hugo_task_done', linkUrl: '/approvals?tab=unconfirmed' },
    };
  }
  if (st.cutoffAt && now >= new Date(st.cutoffAt)) {
    const names = s.waiting.slice(0, 5).map((x) => x.name).join(', ') + (s.waiting.length > 5 ? ` +${s.waiting.length - 5}` : '');
    return {
      status: 'NEEDS_YOU',
      needs: 'STILL_UNCONFIRMED',
      state: st,
      progress,
      events: [...events, { code: 'STILL_UNCONFIRMED', data: { count: s.waiting.length } }],
      result: { calledOff: s.calledOff, unconfirmed: s.waiting },
      linkUrl: '/approvals?tab=unconfirmed',
      notice: { ...HUGO_NOTICE.chaseUnconfirmed(c.lang, dayLabel, s.confirmed, s.total, names), category: 'hugo_task_needs_you', linkUrl: taskLink(t.id), full: true },
    };
  }
  return { status: 'WAITING', state: st, progress, events, result: { calledOff: s.calledOff, unconfirmed: s.waiting } };
}

/** The deadline passed with the task still open. */
async function expire(t: HugoTask, c: Ctx): Promise<Outcome> {
  if (t.kind === 'FIND_COVER') {
    const st = t.state as unknown as CoverState;
    const swap = st.current ? await prisma.shiftSwapRequest.findUnique({ where: { id: st.current }, select: { id: true, status: true } }) : null;
    // A decision that landed at the wire still counts.
    if (swap?.status === 'MANAGER_APPROVED') return stepCover(t, c);
    // The coworker said yes: the manager's decision is the swap flow's from here, and it tells the person.
    if (swap?.status === 'PEER_ACCEPTED') return { status: 'EXPIRED', events: [{ code: 'EXPIRED', data: { waiting: 'manager' } }] };
    if (swap?.status === 'PENDING_PEER') await withdrawAsk(t, swap.id, c);
    const subject = t.subject as HugoTaskSubject;
    const when = hugoWhen(new Date(subject.shift!.startsAt), subject.shift!.timezone, c.lang);
    return {
      status: 'EXPIRED',
      state: { ...st, current: null },
      events: [{ code: 'EXPIRED' }],
      notice: { ...HUGO_NOTICE.coverExpired(c.lang, when), category: 'hugo_task_needs_you', linkUrl: '/scheduling', full: true },
    };
  }
  return { status: 'EXPIRED', events: [{ code: 'EXPIRED' }] };
}

/* ---------------------------------------------------------------- engine */

/** Take the one step in flight for this task; false when another step holds it. */
async function claim(taskId: string, at: Date, statuses: readonly HugoTaskStatus[] = OPEN): Promise<boolean> {
  const r = await prisma.hugoTask.updateMany({
    where: { id: taskId, status: { in: [...statuses] }, OR: [{ claimedAt: null }, { claimedAt: { lt: new Date(at.getTime() - STALE_CLAIM_MS) } }] },
    data: { claimedAt: at },
  });
  return r.count === 1;
}

async function release(taskId: string, at: Date, nextCheckAt: Date, state?: Record<string, unknown>): Promise<void> {
  await prisma.hugoTask.updateMany({
    where: { id: taskId, claimedAt: at },
    data: { claimedAt: null, nextCheckAt, ...(state ? { state: state as Prisma.InputJsonValue } : {}) },
  });
}

/** Write a step's outcome under the claim it was taken with; false when the claim was lost. */
async function apply(t: HugoTask, at: Date, o: Outcome, c: Ctx): Promise<boolean> {
  const status = o.status ?? (t.status as HugoTaskStatus);
  const final = !OPEN.includes(status);
  const changed = status !== t.status;
  const data: Prisma.HugoTaskUpdateManyMutationInput = {
    status,
    needs: status === 'NEEDS_YOU' ? (o.needs ?? t.needs) : null,
    claimedAt: null,
    nextCheckAt: o.nextCheckAt ?? new Date(c.now.getTime() + GAP[t.kind as HugoTaskKind]),
    ...(o.state !== undefined ? { state: o.state as Prisma.InputJsonValue } : {}),
    ...(o.progress !== undefined ? { progress: o.progress ?? Prisma.DbNull } : {}),
    ...(o.result !== undefined ? { result: (o.result ?? Prisma.DbNull) as Prisma.InputJsonValue } : {}),
    ...(o.linkUrl !== undefined ? { linkUrl: o.linkUrl } : {}),
    ...(final && !t.completedAt ? { completedAt: c.now } : {}),
    // Finished, or waiting on them: unseen until they look.
    ...(changed && (final || status === 'NEEDS_YOU') ? { seenAt: null } : {}),
  };
  const done = await prisma.hugoTask.updateMany({ where: { id: t.id, claimedAt: at }, data });
  if (done.count !== 1) return false;
  const events = o.events ?? [];
  // One timestamp per line, in order, so the trail reads as it happened.
  for (const [i, e] of events.entries()) {
    await prisma.hugoTaskEvent.create({ data: { tenantId: t.tenantId, taskId: t.id, code: e.code, data: (e.data ?? {}) as Prisma.InputJsonValue, createdAt: new Date(c.now.getTime() + i) } });
  }
  if (o.notice) await sendHugoNotice(c.agent, { ...o.notice, userId: t.userId, lang: c.lang });
  else if (changed || events.length) emitLiveEvent(t.userId, 'hugo');
  if (changed) {
    await logBuiltInAgentAction(prisma, 'whatsapp-assistant', {
      action: `agent.task.${status.toLowerCase()}`,
      entityType: 'HugoTask',
      entityId: t.id,
      metadata: { kind: t.kind, needs: status === 'NEEDS_YOU' ? (o.needs ?? t.needs) : null, notified: Boolean(o.notice) },
    });
  }
  return true;
}

/**
 * One step for one task, if it is due (or `force`). Safe to call from
 * anywhere at any time: the claim makes a concurrent call a no-op. A step
 * that throws is retried later; five in a row and the task fails.
 */
export async function advanceHugoTask(taskId: string, now: Date = new Date()): Promise<void> {
  if (!(await claim(taskId, now))) return;
  const t = await prisma.hugoTask.findUnique({ where: { id: taskId } });
  if (!t) return;
  const agent = await hugoAgent(t.tenantId);
  if (!agent) {
    // Hugo is switched off: everything waits, nothing is lost.
    await release(t.id, now, new Date(now.getTime() + 30 * MIN));
    return;
  }
  const { lang, active } = await readerOf(t.userId);
  const c: Ctx = { now, agent, lang };
  try {
    let o: Outcome;
    if (!active) o = { status: 'FAILED', events: [{ code: 'FAILED', data: { reason: 'no_access' } }] };
    else if (t.expiresAt <= now) o = await expire(t, c);
    else if (t.status === 'NEEDS_YOU') {
      await release(t.id, now, t.expiresAt);
      return;
    } else o = await STEPS[t.kind as HugoTaskKind](t, c);
    // A step that went through resets the run of failures.
    if ((t.state as { errors?: number }).errors && o.state === undefined) {
      const { errors: _errors, ...rest } = t.state as Record<string, unknown>;
      o.state = rest;
    } else if (o.state && 'errors' in o.state) delete o.state.errors;
    await apply(t, now, o, c);
  } catch (err) {
    const errors = ((t.state as { errors?: number }).errors ?? 0) + 1;
    console.error(`[hugo] task ${t.id} (${t.kind}) step failed (${errors}/${MAX_STEP_ERRORS}):`, err instanceof Error ? err.message : err);
    if (errors >= MAX_STEP_ERRORS) {
      await apply(t, now, { status: 'FAILED', events: [{ code: 'FAILED', data: { reason: 'error' } }] }, c).catch(() => release(t.id, now, new Date(now.getTime() + HOUR)));
    } else {
      await release(t.id, now, new Date(now.getTime() + 10 * MIN * errors), { ...(t.state as Record<string, unknown>), errors });
    }
  }
}

/** Every task in this tenant that is due a step or past its deadline. */
export async function sweepHugoTasks(now: Date = new Date()): Promise<{ stepped: number }> {
  if (!(await hugoAgent())) return { stepped: 0 };
  const due = await prisma.hugoTask.findMany({
    where: {
      OR: [
        { status: { in: ['WORKING', 'WAITING'] }, nextCheckAt: { lte: now } },
        { status: { in: [...OPEN] }, expiresAt: { lte: now } },
      ],
      AND: [{ OR: [{ claimedAt: null }, { claimedAt: { lt: new Date(now.getTime() - STALE_CLAIM_MS) } }] }],
    },
    orderBy: { nextCheckAt: 'asc' },
    take: 200,
    select: { id: true },
  });
  for (const t of due) await advanceHugoTask(t.id, now);
  return { stepped: due.length };
}

/** Is Hugo asking this swap for someone right now? Then Hugo, not the swap flow, keeps the requester posted. */
export async function hugoHandlesSwap(swapId: string): Promise<boolean> {
  const n = await prisma.hugoTask.count({ where: { kind: 'FIND_COVER', status: { in: [...OPEN] }, state: { path: ['current'], equals: swapId } } });
  return n > 0;
}

/** A swap Hugo is waiting on was answered: look now, not at the next sweep. */
export async function kickCoverTask(swapId: string): Promise<void> {
  const tasks = await prisma.hugoTask.findMany({
    where: { kind: 'FIND_COVER', status: { in: ['WORKING', 'WAITING'] }, state: { path: ['current'], equals: swapId } },
    select: { id: true },
  });
  for (const t of tasks) await advanceHugoTask(t.id);
}

/** A time-off request was decided: the watches on it look now. */
export async function kickTimeOffTasks(associateId: string): Promise<void> {
  const tasks = await prisma.hugoTask.findMany({
    where: { kind: 'WATCH_TIME_OFF', status: { in: ['WORKING', 'WAITING'] }, params: { path: ['associateId'], equals: associateId } },
    select: { id: true },
  });
  for (const t of tasks) await advanceHugoTask(t.id);
}

/* ------------------------------------------------------- the person's say */

async function ownTask(userId: string, taskId: string): Promise<HugoTask> {
  const t = await prisma.hugoTask.findFirst({ where: { id: taskId, userId } });
  if (!t) throw new HttpError(404, 'task_not_found', 'Task not found');
  return t;
}

async function claimForPerson(t: HugoTask, at: Date): Promise<void> {
  if (!OPEN.includes(t.status as HugoTaskStatus)) throw new HttpError(409, 'task_closed', 'This task has already finished.');
  if (!(await claim(t.id, at))) throw new HttpError(409, 'task_busy', 'Hugo is in the middle of a step on this — try again in a moment.');
}

/** Stop, under a claim already held: withdraw what is in flight, then close. */
async function stopUnderClaim(t: HugoTask, at: Date, c: Ctx, by: 'person'): Promise<void> {
  if (t.kind === 'FIND_COVER') {
    const st = t.state as unknown as CoverState;
    if (st.current) {
      const swap = await prisma.shiftSwapRequest.findUnique({ where: { id: st.current }, select: { id: true, status: true } });
      if (swap && (swap.status === 'PENDING_PEER' || swap.status === 'PEER_ACCEPTED')) await withdrawAsk(t, swap.id, c);
    }
  }
  await apply(t, at, { status: 'CANCELLED', events: [{ code: 'CANCELLED', data: { by } }] }, c);
}

async function personCtx(t: HugoTask, now: Date): Promise<Ctx> {
  const agent = await hugoAgent(t.tenantId);
  if (!agent) throw new HttpError(409, 'hugo_off', 'The assistant is switched off for now.');
  return { now, agent, lang: (await readerOf(t.userId)).lang };
}

export async function cancelHugoTask(user: SessionUser, taskId: string, now: Date = new Date()): Promise<HugoTaskView> {
  const t = await ownTask(user.id, taskId);
  const c = await personCtx(t, now);
  await claimForPerson(t, now);
  try {
    await stopUnderClaim(t, now, c, 'person');
  } catch (err) {
    await release(t.id, now, now);
    throw err;
  }
  enqueueAudit({ actorUserId: user.id, clientId: user.clientId ?? null, action: 'hugo.task_cancelled', entityType: 'HugoTask', entityId: t.id, metadata: { kind: t.kind } }, 'hugo');
  return viewOf(t.id);
}

/** The person's answer to a task that needs them. */
export async function respondToHugoTask(user: SessionUser, taskId: string, choice: HugoTaskChoice, now: Date = new Date()): Promise<HugoTaskView> {
  const t = await ownTask(user.id, taskId);
  if (t.status !== 'NEEDS_YOU' || !t.needs) throw new HttpError(409, 'nothing_to_answer', 'This task is not waiting on you.');
  if (!choicesFor(t).includes(choice)) throw new HttpError(400, 'invalid_choice', 'That is not one of the answers for this task.');
  const c = await personCtx(t, now);
  await claimForPerson(t, now);
  try {
    const o = await answer(t, user, choice, c);
    if (o === 'stop') await stopUnderClaim(t, now, c, 'person');
    else await apply(t, now, o, c);
  } catch (err) {
    await release(t.id, now, t.expiresAt);
    throw err;
  }
  enqueueAudit({ actorUserId: user.id, clientId: user.clientId ?? null, action: 'hugo.task_answered', entityType: 'HugoTask', entityId: t.id, metadata: { kind: t.kind, needs: t.needs, choice } }, 'hugo');
  // Keep going straight away when the answer sent Hugo back to work.
  await advanceHugoTask(t.id, new Date(now.getTime() + 1));
  return viewOf(t.id);
}

async function answer(t: HugoTask, user: SessionUser, choice: HugoTaskChoice, c: Ctx): Promise<Outcome | 'stop'> {
  const needs = t.needs as HugoTaskNeed;
  switch (choice) {
    case 'STOP':
      return 'stop';
    case 'GOT_IT':
      // A call-off acknowledged: the chase carries on with everyone else.
      return needs === 'CALLED_OFF' ? { status: 'WAITING', nextCheckAt: c.now } : { status: 'DONE' };
    case 'KEEP_TRYING':
      return { status: 'WORKING', state: { ...(t.state as Record<string, unknown>), retrying: true, current: null }, events: [{ code: 'KEPT_TRYING' }], nextCheckAt: c.now };
    case 'ASK_SUPERVISOR': {
      const p = t.params as unknown as Params;
      const st = t.state as unknown as CoverState;
      const subject = t.subject as HugoTaskSubject;
      const when = hugoWhen(new Date(subject.shift!.startsAt), subject.shift!.timezone, c.lang);
      const hand = await handoff(prisma, p.associateId!, user.id, HUGO_NOTICE.coverHandoff(c.lang, when, st.asked.length, c.agent.name), c.now, c.agent.name);
      if (!hand.conversationId) throw new HttpError(409, 'no_supervisor', 'I could not find a supervisor to pass this to. If you cannot make the shift, call off in the app so they know.');
      const url = `/messages/${hand.conversationId}`;
      return { status: 'DONE', result: { passedTo: { who: hand.who, url } }, linkUrl: url, events: [{ code: 'PASSED_TO_SUPERVISOR', data: { who: hand.who } }] };
    }
    case 'NUDGE_AGAIN': {
      const st = t.state as ChaseState;
      const day = (t.subject as HugoTaskSubject).date!;
      const s = await chaseStatus(user, day, c.now);
      // The person asked for it: a shorter guard than the button's 20 hours, never twice an hour.
      const { nudged } = await nudgeUnconfirmedShifts(prisma, s.where, user.id, c.now, 3);
      const recheck = new Date(Math.max(c.now.getTime() + HOUR, Math.min(c.now.getTime() + 2 * HOUR, (s.waiting[0] ? new Date(s.waiting[0].startsAt).getTime() : c.now.getTime()) - HOUR)));
      return {
        status: 'WAITING',
        state: { ...st, renudges: (st.renudges ?? 0) + 1, cutoffAt: recheck.toISOString() },
        events: [{ code: 'NUDGED', data: { count: nudged } }],
        nextCheckAt: new Date(c.now.getTime() + GAP.CHASE_CONFIRMATIONS),
      };
    }
  }
}

/* ----------------------------------------------------------------- views */

function choicesFor(t: Pick<HugoTask, 'status' | 'needs' | 'kind' | 'state'>): HugoTaskChoice[] {
  if (t.status !== 'NEEDS_YOU' || !t.needs) return [];
  const all = [...(HUGO_TASK_CHOICES_FOR[t.needs as HugoTaskNeed] ?? [])];
  if (t.needs === 'STILL_UNCONFIRMED' && ((t.state as ChaseState).renudges ?? 0) >= MAX_RENUDGES) return all.filter((x) => x !== 'NUDGE_AGAIN');
  return all;
}

export function toHugoTaskView(t: HugoTask & { events: HugoTaskEvent[] }): HugoTaskView {
  const status = t.status as HugoTaskStatus;
  const open = OPEN.includes(status);
  return {
    id: t.id,
    kind: t.kind as HugoTaskKind,
    status,
    needs: (t.needs as HugoTaskNeed | null) ?? null,
    choices: choicesFor(t),
    subject: t.subject as HugoTaskSubject,
    progress: (t.progress as { done: number; total: number } | null) ?? null,
    result: (t.result as HugoTaskResult | null) ?? null,
    linkUrl: t.linkUrl,
    source: t.source as HugoTaskView['source'],
    seen: (open && status !== 'NEEDS_YOU') || t.seenAt !== null,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
    completedAt: t.completedAt?.toISOString() ?? null,
    expiresAt: t.expiresAt.toISOString(),
    events: t.events.map((e) => ({ id: e.id, code: e.code as HugoTaskEventCode, data: e.data as Record<string, string | number | null>, at: e.createdAt.toISOString() })),
  };
}

async function viewOf(taskId: string): Promise<HugoTaskView> {
  const t = await prisma.hugoTask.findUniqueOrThrow({ where: { id: taskId }, include: { events: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 100 } } });
  return toHugoTaskView(t);
}

/** The person's tasks: everything open and what finished in the last two weeks — after a step for any that are due. */
export async function listHugoTasks(userId: string, now: Date = new Date()): Promise<HugoTaskView[]> {
  const due = await prisma.hugoTask.findMany({
    where: { userId, OR: [{ status: { in: ['WORKING', 'WAITING'] }, nextCheckAt: { lte: now } }, { status: { in: [...OPEN] }, expiresAt: { lte: now } }] },
    select: { id: true },
    take: MAX_OPEN_PER_USER,
  });
  for (const t of due) await advanceHugoTask(t.id, now);
  const rows = await prisma.hugoTask.findMany({
    where: { userId, OR: [{ status: { in: [...OPEN] } }, { completedAt: { gte: new Date(now.getTime() - KEEP_FINISHED_MS) } }] },
    orderBy: { updatedAt: 'desc' },
    take: 50,
    include: { events: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 100 } },
  });
  return rows.map(toHugoTaskView);
}

export async function getHugoTask(userId: string, taskId: string, now: Date = new Date()): Promise<HugoTaskView> {
  const t = await ownTask(userId, taskId);
  if (OPEN.includes(t.status as HugoTaskStatus) && (t.nextCheckAt <= now || t.expiresAt <= now)) await advanceHugoTask(t.id, now);
  return viewOf(t.id);
}

/** The person looked: finished and needs-you tasks stop counting on the badge. */
export async function markHugoTasksSeen(userId: string, ids: string[], now: Date = new Date()): Promise<number> {
  if (!ids.length) return 0;
  const r = await prisma.hugoTask.updateMany({ where: { userId, id: { in: ids }, seenAt: null }, data: { seenAt: now } });
  return r.count;
}

export async function hugoTaskCounts(userId: string, now: Date = new Date()): Promise<{ working: number; needsYou: number; unseenDone: number }> {
  const [working, needsYou, unseenDone] = await Promise.all([
    prisma.hugoTask.count({ where: { userId, status: { in: ['WORKING', 'WAITING'] } } }),
    prisma.hugoTask.count({ where: { userId, status: 'NEEDS_YOU' } }),
    prisma.hugoTask.count({ where: { userId, status: { in: ['DONE', 'FAILED', 'EXPIRED'] }, seenAt: null, completedAt: { gte: new Date(now.getTime() - KEEP_FINISHED_MS) } } }),
  ]);
  return { working, needsYou, unseenDone };
}

/** What a task is about, for the chat's offer card — the same capture startHugoTask makes, without starting it. */
export async function previewHugoTask(user: SessionUser, input: HugoTaskCreate, now: Date = new Date()): Promise<HugoTaskSubject | null> {
  try {
    await assertMayStart(user, input.kind);
    return (await prepare(user, input, now)).subject;
  } catch (err) {
    if (err instanceof HttpError) return null;
    throw err;
  }
}

export type { HugoShiftRef };

/* ------------------------------------------------------------------ boot */

let installed = false;

/** Boot: a time-off decision wakes the watches on it at once (the decision's own event, lib/webhookDispatch). */
export function installHugoTaskEvents(): void {
  if (installed) return;
  installed = true;
  onWebhookEvent((eventType, payload, tenantId) => {
    if (eventType !== 'time_off.approved' && eventType !== 'time_off.denied') return;
    const associateId = typeof payload.associateId === 'string' ? payload.associateId : null;
    if (!associateId) return;
    void runWithTenant(tenantId, 'job', () => kickTimeOffTasks(associateId)).catch((err: unknown) =>
      console.warn('[hugo] time-off watch kick failed:', err instanceof Error ? err.message : err),
    );
  });
}

export const HUGO_TASKS_JOB = 'hugoTasks';

/** Every HUGO_TASKS_INTERVAL_SECONDS (default 120): each tenant's due tasks take their next step. */
export function startHugoTasksCron(): void {
  armJob({
    name: HUGO_TASKS_JOB,
    label: "Hugo's tasks (next steps and deadlines)",
    intervalSeconds: env.HUGO_TASKS_INTERVAL_SECONDS,
    run: tenantJob(HUGO_TASKS_JOB, () => sweepHugoTasks()),
    note: 'HUGO_TASKS_INTERVAL_SECONDS; a task also steps when its person opens the list, and on the events it waits for.',
  });
}

export function stopHugoTasksCron(): void {
  stopJob(HUGO_TASKS_JOB);
}
