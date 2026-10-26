import type { HugoNote, Prisma, Role } from '@prisma/client';
import {
  HUGO_NOTE_FOR,
  HUGO_NOTE_KINDS,
  HugoTaskCreateInputSchema,
  can,
  type HugoNoteAction,
  type HugoNoteData,
  type HugoNoteKind,
  type HugoNoteSettings,
  type HugoNoteStatus,
  type HugoNoteView,
  type HugoTaskView,
} from '@alto-people/shared';
import { env } from '../config/env.js';
import { prisma } from '../db.js';
import { sessionUserById } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import type { SessionUser } from '../types/express.js';
import { logBuiltInAgentAction, type AgentContext } from './agents.js';
import { nextPaydayFor } from './associatePayday.js';
import { enqueueAudit } from './audit.js';
import { armJob, stopJob } from './jobs.js';
import { chaseItems } from './complianceAgent.js';
import { hugoAudienceOf } from './hugo.js';
import { startHugoTask } from './hugoTasks.js';
import { HUGO_NOTICE, hugoDay, hugoWhen, toHugoLang } from './hugoWorkCopy.js';
import { hugoAgent, openShiftsThatFit, sendHugoNotice } from './hugoWork.js';
import { emitLiveEvent } from './liveEvents.js';
import { scopeShifts } from './scope.js';
import { UNCONFIRMED_SHIFT } from './shiftConfirmNudge.js';
import { tenantIdForWrite } from './tenant.js';
import { tenantJob } from './tenantJobs.js';
import { loadTenantProfile } from './tenantProfile.js';
import { DEFAULT_TIMEZONE, addDaysInZone, localDateKey, zonedMinutes, zonedWallTimeToUtcInstant } from './timezone.js';

/**
 * Hugo's notes (packages/shared/src/hugoWork.ts): what the assistant
 * noticed in a person's own records, raised without being asked, each with
 * one thing it could do about it. A note never acts — accepting it is the
 * person's tap.
 *
 *   sweepHugoNotes   the hourly look, per tenant: each kind's detector says
 *                    which notes should exist now; new ones are created, the
 *                    ones no longer true expire, a dismissed one stays
 *                    dismissed (one per person, kind and subject)
 *
 *   No spam, by construction:
 *     - Only two kinds ever reach the lock screen (an open shift that fits,
 *       direct deposit missing before a first payday); the rest wait in the
 *       panel and on the home card.
 *     - At most two pushes a day per person, none before 8 AM or after
 *       8 PM on their clock, and the person's own quiet hours on top
 *       (lib/notificationDelivery). An open-shift push at most every three days.
 *     - Every kind can be turned off (Settings › Notifications); turning one off
 *       clears what is showing.
 *     - An offer is never pressure: the words say there is nothing to do
 *       unless they want to (lib/hugoWorkCopy).
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PUSH_KINDS: ReadonlySet<HugoNoteKind> = new Set(['OPEN_SHIFT_MATCH', 'DIRECT_DEPOSIT_MISSING']);
const MAX_PUSHES_PER_DAY = 2;
const OPEN_SHIFT_PUSH_GAP_MS = 3 * DAY;
/** A note not pushed within this long of being raised stays in the panel only. */
const PUSH_WINDOW_MS = 18 * HOUR;
const PUSH_HOURS = { from: 8, to: 20 } as const;
const OPEN_STATUSES: HugoNoteStatus[] = ['NEW', 'SEEN'];
/** How far back "uses the app" reaches: notes are for people who will see them. */
const ACTIVE_WITHIN_MS = 30 * DAY;
const MAX_PEOPLE_PER_KIND = 400;
/**
 * The desks that run a day's schedule: they get the desk's notes. HR, the
 * executive and finance hold manage:scheduling too, but a nightly count of
 * the whole company's unconfirmed shifts is not their job (and they can
 * still hand Hugo the chase themselves).
 */
const SCHEDULING_DESKS: ReadonlySet<string> = new Set(['SHIFT_SUPERVISOR', 'FLOOR_SUPERVISOR', 'OPERATIONS_MANAGER', 'WORKFORCE_MANAGER', 'MANAGER']);

interface Desired {
  userId: string;
  subjectKey: string;
  data: HugoNoteData;
  expiresAt: Date;
}

/* -------------------------------------------------------------- detectors */

/** Signed-in associates (Hugo's associate audience) who used the app lately, not muting this kind. */
async function associatesFor(kind: HugoNoteKind, now: Date, opts: { anyActivity?: boolean } = {}) {
  const rows = await prisma.user.findMany({
    where: {
      status: 'ACTIVE',
      deletedAt: null,
      associateId: { not: null },
      ...(opts.anyActivity ? {} : { lastSeenAt: { gte: new Date(now.getTime() - ACTIVE_WITHIN_MS) } }),
      hugoNoteMutes: { none: { kind } },
    },
    orderBy: { lastSeenAt: { sort: 'desc', nulls: 'last' } },
    take: MAX_PEOPLE_PER_KIND * 2,
    select: { id: true, role: true, associateId: true, timezone: true },
  });
  return rows.filter((u) => hugoAudienceOf(u) === 'associate').slice(0, MAX_PEOPLE_PER_KIND);
}

/** A credential of theirs running out within 30 days (or lapsed): the compliance agent's own list. */
async function detectCredentials(tenantId: string, now: Date): Promise<Desired[]> {
  const people = await associatesFor('CREDENTIAL_EXPIRING', now);
  if (!people.length) return [];
  const byAssociate = new Map(people.map((p) => [p.associateId!, p.id]));
  const items = (await chaseItems(prisma, tenantId, now)).filter((i) => byAssociate.has(i.associateId));
  // The soonest one per person — one note, not a list.
  const first = new Map<string, (typeof items)[number]>();
  for (const i of items.sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime())) if (!first.has(i.associateId)) first.set(i.associateId, i);
  return [...first.values()].map((i) => ({
    userId: byAssociate.get(i.associateId)!,
    subjectKey: i.itemKey.slice(0, 120),
    data: { credential: { id: i.itemKey, word: i.wordKey, name: i.label, expiresOn: i.expiresAt.toISOString().slice(0, 10), days: Math.ceil((i.expiresAt.getTime() - now.getTime()) / DAY), url: i.linkUrl } },
    expiresAt: new Date(Math.max(i.expiresAt.getTime() + 7 * DAY, now.getTime() + DAY)),
  }));
}

/** An open shift that fits them — one they could claim, inside their availability, not already offered to them. */
async function detectOpenShifts(now: Date): Promise<Desired[]> {
  const horizon = new Date(now.getTime() + 7 * DAY);
  const anyOpen = await prisma.shift.count({ where: { status: 'OPEN', assignedAssociateId: null, publishedAt: { not: null }, startsAt: { gt: now, lt: horizon } } });
  if (!anyOpen) return [];
  const people = await associatesFor('OPEN_SHIFT_MATCH', now);
  // Shifts they already passed on, or were told about here, are not offered twice.
  const settled = await prisma.hugoNote.findMany({
    where: { kind: 'OPEN_SHIFT_MATCH', userId: { in: people.map((p) => p.id) }, status: { notIn: OPEN_STATUSES } },
    select: { userId: true, subjectKey: true },
  });
  const skipOf = new Map<string, Set<string>>();
  for (const n of settled) skipOf.set(n.userId, (skipOf.get(n.userId) ?? new Set()).add(n.subjectKey));
  const out: Desired[] = [];
  for (const p of people) {
    const fits = await openShiftsThatFit(p.associateId!, { before: horizon, skipInvited: true, skip: skipOf.get(p.id) });
    const first = fits[0];
    if (!first) continue;
    out.push({ userId: p.id, subjectKey: first.id, data: { shift: first, more: fits.length - 1 }, expiresAt: new Date(first.startsAt) });
  }
  return out;
}

/** No bank account or pay card on file, first payday within a week. */
async function detectDirectDeposit(now: Date): Promise<Desired[]> {
  const people = await associatesFor('DIRECT_DEPOSIT_MISSING', now, { anyActivity: true });
  if (!people.length) return [];
  const without = await prisma.associate.findMany({
    where: {
      id: { in: people.map((p) => p.associateId!) },
      payoutMethods: { none: { retiredAt: null, OR: [{ branchCardId: { not: null } }, { accountNumberEnc: { not: null } }] } },
      payrollItems: { none: { status: 'DISBURSED' } },
    },
    select: { id: true },
  });
  const userOf = new Map(people.map((p) => [p.associateId!, p.id]));
  const out: Desired[] = [];
  for (const a of without) {
    const next = await nextPaydayFor(a.id, now);
    if (!next) continue;
    const payday = new Date(`${next.payDate}T12:00:00Z`);
    if (payday.getTime() - now.getTime() > 7 * DAY || payday.getTime() < now.getTime() - DAY) continue;
    out.push({ userId: userOf.get(a.id)!, subjectKey: 'first-paycheck', data: { payday: next.payDate }, expiresAt: new Date(payday.getTime() + DAY) });
  }
  return out;
}

/**
 * A desk with shifts tomorrow nobody has confirmed — after noon on their
 * clock, when the morning reminders have had their chance. Not raised when
 * Hugo is already chasing that day for them.
 */
async function detectUnconfirmedTomorrow(now: Date): Promise<Desired[]> {
  const desks = await prisma.user.findMany({
    where: {
      status: 'ACTIVE',
      deletedAt: null,
      lastSeenAt: { gte: new Date(now.getTime() - 14 * DAY) },
      hugoNoteMutes: { none: { kind: 'UNCONFIRMED_TOMORROW' } },
      role: { in: [...SCHEDULING_DESKS] as Role[] },
    },
    orderBy: { lastSeenAt: 'desc' },
    take: MAX_PEOPLE_PER_KIND,
    select: { id: true },
  });
  const out: Desired[] = [];
  for (const d of desks) {
    const user = await sessionUserById(d.id);
    if (!user || !SCHEDULING_DESKS.has(user.role) || !can(user, 'manage:scheduling')) continue;
    const tz = user.timezone ?? DEFAULT_TIMEZONE;
    if (zonedMinutes(now, tz) < 12 * 60) continue;
    const date = localDateKey(addDaysInZone(now, 1, tz), tz);
    const [y, m, dd] = date.split('-').map(Number) as [number, number, number];
    const start = zonedWallTimeToUtcInstant(y, m, dd, 0, tz);
    const end = addDaysInZone(start, 1, tz);
    const chasing = await prisma.hugoTask.count({ where: { userId: user.id, kind: 'CHASE_CONFIRMATIONS', status: { in: ['WORKING', 'WAITING', 'NEEDS_YOU'] }, subject: { path: ['date'], equals: date } } });
    if (chasing) continue;
    const window: Prisma.ShiftWhereInput = { AND: [scopeShifts(user), { status: 'ASSIGNED', publishedAt: { not: null }, assignedAssociateId: { not: null }, startsAt: { gte: start, lt: end } }] };
    const [total, count] = await Promise.all([prisma.shift.count({ where: window }), prisma.shift.count({ where: { AND: [window, UNCONFIRMED_SHIFT] } })]);
    if (!count) continue;
    out.push({ userId: user.id, subjectKey: date, data: { unconfirmed: { date, count, total } }, expiresAt: start });
  }
  return out;
}

/* ------------------------------------------------------------- reconcile */

/** Make the open notes of one kind match what is true now. */
async function reconcile(kind: HugoNoteKind, desired: Desired[], now: Date): Promise<{ created: number; expired: number }> {
  let created = 0;
  for (const d of desired) {
    const existing = await prisma.hugoNote.findUnique({ where: { userId_kind_subjectKey: { userId: d.userId, kind, subjectKey: d.subjectKey } }, select: { id: true, status: true } });
    if (!existing) {
      await prisma.hugoNote.create({ data: { userId: d.userId, kind, subjectKey: d.subjectKey, data: d.data as Prisma.InputJsonValue, expiresAt: d.expiresAt } });
      emitLiveEvent(d.userId, 'hugo');
      created += 1;
    } else if (OPEN_STATUSES.includes(existing.status as HugoNoteStatus)) {
      // Still true: keep the numbers current (a count that moved, the days left).
      await prisma.hugoNote.update({ where: { id: existing.id }, data: { data: d.data as Prisma.InputJsonValue, expiresAt: d.expiresAt } });
    }
    // Dismissed or accepted: it stays that way.
  }
  const keep = new Set(desired.map((d) => `${d.userId}|${d.subjectKey}`));
  const open = await prisma.hugoNote.findMany({ where: { kind, status: { in: OPEN_STATUSES } }, select: { id: true, userId: true, subjectKey: true, expiresAt: true } });
  const stale = open.filter((n) => n.expiresAt <= now || !keep.has(`${n.userId}|${n.subjectKey}`));
  if (stale.length) {
    await prisma.hugoNote.updateMany({ where: { id: { in: stale.map((n) => n.id) } }, data: { status: 'EXPIRED' } });
    for (const u of new Set(stale.map((n) => n.userId))) emitLiveEvent(u, 'hugo');
  }
  return { created, expired: stale.length };
}

/** Send what may go to the lock screen now, within each person's budget and hours. */
async function pushDue(agent: AgentContext, now: Date): Promise<number> {
  const due = await prisma.hugoNote.findMany({
    where: { kind: { in: [...PUSH_KINDS] }, status: 'NEW', pushedAt: null, createdAt: { gte: new Date(now.getTime() - PUSH_WINDOW_MS) }, expiresAt: { gt: now } },
    orderBy: { createdAt: 'asc' },
    take: 500,
    include: { user: { select: { timezone: true, language: true, status: true } } },
  });
  let pushed = 0;
  for (const n of due) {
    if (n.user.status !== 'ACTIVE') continue;
    const hour = Math.floor(zonedMinutes(now, n.user.timezone ?? DEFAULT_TIMEZONE) / 60);
    if (hour < PUSH_HOURS.from || hour >= PUSH_HOURS.to) continue;
    const today = await prisma.hugoNote.count({ where: { userId: n.userId, pushedAt: { gte: new Date(now.getTime() - DAY) } } });
    if (today >= MAX_PUSHES_PER_DAY) continue;
    if (n.kind === 'OPEN_SHIFT_MATCH') {
      const recent = await prisma.hugoNote.count({ where: { userId: n.userId, kind: 'OPEN_SHIFT_MATCH', pushedAt: { gte: new Date(now.getTime() - OPEN_SHIFT_PUSH_GAP_MS) } } });
      if (recent) continue;
    }
    // Claimed before sending: two servers never push the same note.
    const claim = await prisma.hugoNote.updateMany({ where: { id: n.id, pushedAt: null }, data: { pushedAt: now } });
    if (claim.count !== 1) continue;
    const lang = toHugoLang(n.user.language);
    const data = n.data as HugoNoteData;
    const words =
      n.kind === 'OPEN_SHIFT_MATCH' && data.shift
        ? HUGO_NOTICE.noteOpenShift(lang, hugoWhen(new Date(data.shift.startsAt), data.shift.timezone, lang), data.shift.site)
        : HUGO_NOTICE.noteDirectDeposit(lang, hugoDay(data.payday ?? now.toISOString().slice(0, 10), lang));
    const action = actionOf(n);
    await sendHugoNotice(agent, { userId: n.userId, lang, ...words, category: 'hugo_note', linkUrl: action.kind === 'link' ? action.url : (action.url ?? '/') });
    await logBuiltInAgentAction(prisma, 'whatsapp-assistant', { action: 'agent.note.pushed', entityType: 'HugoNote', entityId: n.id, metadata: { kind: n.kind } });
    pushed += 1;
  }
  return pushed;
}

/** The hourly look for one tenant (the one in context). */
export async function sweepHugoNotes(now: Date = new Date()): Promise<{ created: number; expired: number; pushed: number }> {
  const agent = await hugoAgent();
  if (!agent) return { created: 0, expired: 0, pushed: 0 };
  const tenantId = tenantIdForWrite();
  const { modules } = await loadTenantProfile(tenantId);
  const detectors: Array<[HugoNoteKind, () => Promise<Desired[]>]> = [];
  if (modules.compliance) detectors.push(['CREDENTIAL_EXPIRING', () => detectCredentials(tenantId, now)]);
  if (modules.scheduling) {
    detectors.push(['OPEN_SHIFT_MATCH', () => detectOpenShifts(now)]);
    detectors.push(['UNCONFIRMED_TOMORROW', () => detectUnconfirmedTomorrow(now)]);
  }
  detectors.push(['DIRECT_DEPOSIT_MISSING', () => detectDirectDeposit(now)]);
  let created = 0;
  let expired = 0;
  for (const [kind, detect] of detectors) {
    try {
      const r = await reconcile(kind, await detect(), now);
      created += r.created;
      expired += r.expired;
    } catch (err) {
      // One detector failing never stops the others.
      console.error(`[hugo] notes: ${kind} failed:`, err instanceof Error ? err.message : err);
    }
  }
  const pushed = await pushDue(agent, now);
  return { created, expired, pushed };
}

/* ----------------------------------------------------------- the person */

function actionOf(n: Pick<HugoNote, 'kind' | 'data'>): HugoNoteAction {
  const data = n.data as HugoNoteData;
  switch (n.kind as HugoNoteKind) {
    case 'CREDENTIAL_EXPIRING':
      return { kind: 'link', url: data.credential?.url ?? '/documents' };
    case 'OPEN_SHIFT_MATCH':
      return { kind: 'link', url: data.shift ? `/marketplace?shift=${data.shift.id}` : '/marketplace' };
    case 'DIRECT_DEPOSIT_MISSING':
      return { kind: 'link', url: '/payroll#payout-method' };
    case 'UNCONFIRMED_TOMORROW':
      return { kind: 'task', task: { kind: 'CHASE_CONFIRMATIONS', date: data.unconfirmed?.date }, url: '/approvals?tab=unconfirmed' };
  }
}

export function toHugoNoteView(n: HugoNote): HugoNoteView {
  return { id: n.id, kind: n.kind as HugoNoteKind, status: n.status as HugoNoteStatus, data: n.data as HugoNoteData, action: actionOf(n), createdAt: n.createdAt.toISOString() };
}

/** The kinds this person can get: an associate's, or a desk's. */
export function noteKindsFor(user: Pick<SessionUser, 'role' | 'associateId'>): HugoNoteKind[] {
  const audience = hugoAudienceOf(user);
  if (!audience) return [];
  // A desk's notes are for the desks that run a day's schedule (SCHEDULING_DESKS).
  const want = audience === 'associate' ? 'associate' : SCHEDULING_DESKS.has(user.role) && can(user, 'manage:scheduling') ? 'desk' : null;
  return HUGO_NOTE_KINDS.filter((k) => HUGO_NOTE_FOR[k] === want);
}

export async function listHugoNotes(userId: string, now: Date = new Date()): Promise<HugoNoteView[]> {
  const rows = await prisma.hugoNote.findMany({ where: { userId, status: { in: OPEN_STATUSES }, expiresAt: { gt: now } }, orderBy: { createdAt: 'desc' }, take: 20 });
  return rows.map(toHugoNoteView);
}

export async function countNewHugoNotes(userId: string, now: Date = new Date()): Promise<number> {
  return prisma.hugoNote.count({ where: { userId, status: 'NEW', expiresAt: { gt: now } } });
}

export async function markHugoNotesSeen(userId: string, ids: string[], now: Date = new Date()): Promise<number> {
  if (!ids.length) return 0;
  const r = await prisma.hugoNote.updateMany({ where: { userId, id: { in: ids }, status: 'NEW' }, data: { status: 'SEEN', seenAt: now } });
  return r.count;
}

async function ownOpenNote(userId: string, noteId: string): Promise<HugoNote> {
  const n = await prisma.hugoNote.findFirst({ where: { id: noteId, userId } });
  if (!n) throw new HttpError(404, 'note_not_found', 'Note not found');
  if (!OPEN_STATUSES.includes(n.status as HugoNoteStatus)) throw new HttpError(409, 'note_closed', 'This note has already been dealt with.');
  return n;
}

export async function dismissHugoNote(user: SessionUser, noteId: string, now: Date = new Date()): Promise<HugoNoteView> {
  const n = await ownOpenNote(user.id, noteId);
  const row = await prisma.hugoNote.update({ where: { id: n.id }, data: { status: 'DISMISSED', actedAt: now, seenAt: n.seenAt ?? now } });
  await logBuiltInAgentAction(prisma, 'whatsapp-assistant', { action: 'agent.note.dismissed', entityType: 'HugoNote', entityId: n.id, metadata: { kind: n.kind } });
  return toHugoNoteView(row);
}

/** The person's yes: open the page, or start the task the note offered. */
export async function acceptHugoNote(user: SessionUser, noteId: string, now: Date = new Date()): Promise<{ note: HugoNoteView; task: HugoTaskView | null; url: string | null }> {
  const n = await ownOpenNote(user.id, noteId);
  const action = actionOf(n);
  let task: HugoTaskView | null = null;
  if (action.kind === 'task') task = (await startHugoTask(user, HugoTaskCreateInputSchema.parse(action.task), 'note', now, n.id)).task;
  const row = await prisma.hugoNote.update({ where: { id: n.id }, data: { status: 'ACCEPTED', actedAt: now, seenAt: n.seenAt ?? now } });
  await logBuiltInAgentAction(prisma, 'whatsapp-assistant', { action: 'agent.note.accepted', entityType: 'HugoNote', entityId: n.id, metadata: { kind: n.kind, task: task?.id ?? null } });
  enqueueAudit({ actorUserId: user.id, clientId: user.clientId ?? null, action: 'hugo.note_accepted', entityType: 'HugoNote', entityId: n.id, metadata: { kind: n.kind } }, 'hugo');
  return { note: toHugoNoteView(row), task, url: action.url };
}

export async function hugoNoteSettings(user: SessionUser): Promise<HugoNoteSettings> {
  const kinds = noteKindsFor(user);
  const muted = new Set((await prisma.hugoNoteMute.findMany({ where: { userId: user.id }, select: { kind: true } })).map((m) => m.kind));
  return { kinds: kinds.map((kind) => ({ kind, on: !muted.has(kind) })) };
}

/** Turn a kind on or off. Off clears what is showing of that kind. */
export async function setHugoNoteKind(user: SessionUser, kind: HugoNoteKind, on: boolean): Promise<HugoNoteSettings> {
  if (!noteKindsFor(user).includes(kind)) throw new HttpError(400, 'invalid_kind', 'That kind of note is not one you get.');
  if (on) await prisma.hugoNoteMute.deleteMany({ where: { userId: user.id, kind } });
  else {
    await prisma.hugoNoteMute.upsert({ where: { userId_kind: { userId: user.id, kind } }, create: { userId: user.id, kind }, update: {} });
    await prisma.hugoNote.updateMany({ where: { userId: user.id, kind, status: { in: OPEN_STATUSES } }, data: { status: 'EXPIRED' } });
  }
  enqueueAudit({ actorUserId: user.id, clientId: user.clientId ?? null, action: 'hugo.note_kind_set', entityType: 'User', entityId: user.id, metadata: { kind, on } }, 'hugo');
  emitLiveEvent(user.id, 'hugo');
  return hugoNoteSettings(user);
}

export const HUGO_NOTES_JOB = 'hugoNotes';

/** Every HUGO_NOTES_INTERVAL_SECONDS (default 3600): each tenant's notes are brought up to date and the due pushes go out. */
export function startHugoNotesCron(): void {
  armJob({
    name: HUGO_NOTES_JOB,
    label: "Hugo's notes (what it noticed, at most two pushes a day)",
    intervalSeconds: env.HUGO_NOTES_INTERVAL_SECONDS,
    run: tenantJob(HUGO_NOTES_JOB, () => sweepHugoNotes()),
    note: 'HUGO_NOTES_INTERVAL_SECONDS; pushes only 8 AM–8 PM on the person\'s clock.',
  });
}

export function stopHugoNotesCron(): void {
  stopJob(HUGO_NOTES_JOB);
}
