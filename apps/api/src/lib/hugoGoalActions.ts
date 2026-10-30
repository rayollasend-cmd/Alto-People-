import { z } from 'zod';
import { HUGO_GOAL_ACTIONS, can, redactSensitiveNumbers, type HugoGoalAction, type HugoGoalStepOutcome, type HugoTaskCreate, type TenantModule } from '@alto-people/shared';
import { prisma } from '../db.js';
import type { SessionUser } from '../types/express.js';
import { GOAL_STEP_WORDS, TIME_OFF_WORD } from './hugoGoalCopy.js';
import { escalationFor, type Asker } from './hugoRegistry.js';
import { previewHugoTask } from './hugoTasks.js';
import { SHIFT_REF_SELECT, openShiftsThatFit, shiftRefOf } from './hugoWork.js';
import { hugoDay, hugoWhen, type HugoLang } from './hugoWorkCopy.js';
import { scopeAssociates, scopeShifts, scopeWhere } from './scope.js';
import { companyWorkweek } from './timeAnomalies.js';
import { addDaysToKey, dateColumnKey, localDateKey } from './timezone.js';

/**
 * What a goal may PROPOSE (lib/hugoGoals): the allow-list. Hugo never acts on
 * a goal by himself — each entry turns the model's choice into one thing the
 * person approves, said in the product's own words, and either one request to
 * the product's own route (run AS THE PERSON with their session when they tap
 * Approve — lib/assistantActions dispatchAsUser — so their permissions, the
 * approval engine and the route's own audit apply) or a task of Hugo's to
 * start (asking coworkers to cover a shift, chasing confirmations).
 *
 *   allowed   who may use it: the capability the product route needs, their
 *             own records (an associate) and the module on
 *   options   what it could apply to right now — ids and plain labels, read
 *             with the person's reach as it is now — for the model to choose from
 *   prepare   checks the choice against the person's own records NOW and says
 *             what will happen; a refusal is a plain reason for the model
 *   judge     a 2xx that did not do the thing (no supervisor to send it to,
 *             texting not set up) reads as a refusal
 */

/** Why a proposal can't be made, in words the model can act on. */
export class GoalActionRefusal extends Error {}

export interface GoalCall {
  method: 'POST' | 'PUT' | 'PATCH';
  path: string;
  body?: unknown;
}

/** Run as the person through the product's route, or start one of Hugo's own tasks (linked to the goal). */
export type GoalRun = { call: GoalCall } | { task: HugoTaskCreate };

export interface PreparedGoalAction {
  action: HugoGoalAction;
  title: string;
  detail: string | null;
  run: GoalRun;
  /** Where to look once it ran. */
  linkUrl: string | null;
}

export interface GoalActionCtx {
  user: SessionUser;
  lang: HugoLang;
  now: Date;
  moduleOn: (m: TenantModule) => boolean;
}

type ProposableAction = Exclude<HugoGoalAction, 'KEEP_GOING'>;

interface Entry {
  action: ProposableAction;
  allowed: (c: GoalActionCtx) => boolean;
  /** For the model: what it does and the args it takes. */
  describe: string;
  options: (c: GoalActionCtx, query?: string) => Promise<string>;
  prepare: (c: GoalActionCtx, args: Record<string, unknown>) => Promise<PreparedGoalAction>;
  judge?: (body: unknown) => { outcome: HugoGoalStepOutcome; code: string } | null;
}

const DAY = 86_400_000;
const HOUR = 3_600_000;
const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const zoneOf = (user: SessionUser) => user.timezone ?? companyWorkweek().timezone;
/** "Sat, Oct 31, 7:00 AM (America/New_York)" — how a time reads to the model. */
const forModel = (iso: string | Date, tz: string) => `${hugoWhen(new Date(iso), tz, 'en')} (${tz})`;
const parse = <T>(schema: z.ZodType<T>, args: Record<string, unknown>): T => {
  const r = schema.safeParse(args);
  if (!r.success) throw new GoalActionRefusal(`Those arguments don't fit: ${r.error.issues.map((i) => `${i.path.join('.') || 'args'} ${i.message}`).join('; ')}.`);
  return r.data;
};
const uuid = () => z.string().uuid();
/** Free words that go to a person: no SSN or account number, ever. */
const words = (max: number) => z.string().trim().min(3).max(max).transform((s) => redactSensitiveNumbers(s));
const isAssociate = (c: GoalActionCtx) => Boolean(c.user.associateId);
const sched = (c: GoalActionCtx) => c.moduleOn('scheduling');
const handoffJudge = (body: unknown) => ((body as { sent?: boolean } | null)?.sent === false ? { outcome: 'refused' as const, code: 'no_supervisor' } : null);

/** The person's own upcoming shifts they could ask coworkers to take (three hours out or more, the next two weeks). */
async function myCoverableShifts(c: GoalActionCtx) {
  return prisma.shift.findMany({
    where: {
      assignedAssociateId: c.user.associateId!,
      status: 'ASSIGNED',
      publishedAt: { not: null },
      startsAt: { gt: new Date(c.now.getTime() + 3 * HOUR), lt: new Date(c.now.getTime() + 14 * DAY) },
    },
    orderBy: { startsAt: 'asc' },
    take: 20,
    select: SHIFT_REF_SELECT,
  });
}

/** Open shifts in the desk's reach over the next two weeks. */
async function deskOpenShifts(c: GoalActionCtx, id?: string) {
  return prisma.shift.findMany({
    where: scopeWhere(scopeShifts(c.user), {
      status: 'OPEN',
      assignedAssociateId: null,
      startsAt: { gt: c.now, lt: new Date(c.now.getTime() + 14 * DAY) },
      ...(id ? { id } : {}),
    }),
    orderBy: { startsAt: 'asc' },
    take: 30,
    select: SHIFT_REF_SELECT,
  });
}

/** Today's and tomorrow's staffed shifts in the desk's reach (the crew a text could go to). */
async function crewShifts(c: GoalActionCtx, ids?: string[]) {
  return prisma.shift.findMany({
    where: scopeWhere(scopeShifts(c.user), {
      status: 'ASSIGNED',
      assignedAssociateId: { not: null },
      startsAt: { gte: new Date(c.now.getTime() - 12 * HOUR), lt: new Date(c.now.getTime() + 2 * DAY) },
      ...(ids ? { id: { in: ids } } : {}),
    }),
    orderBy: { startsAt: 'asc' },
    take: 60,
    select: { ...SHIFT_REF_SELECT, clientId: true, assignedAssociate: { select: { firstName: true, lastName: true } } },
  });
}

const CATALOG: Entry[] = [
  {
    action: 'PICK_UP_SHIFT',
    allowed: (c) => isAssociate(c) && sched(c) && can(c.user, 'view:scheduling'),
    describe: 'Ask to pick up an open shift that fits the person (placed there, qualified, free, inside their availability). Their manager approves it. args: { shiftId }',
    options: async (c) => {
      const fits = await openShiftsThatFit(c.user.associateId!, { before: new Date(c.now.getTime() + 14 * DAY) });
      if (!fits.length) return 'No open shift fits them in the next two weeks.';
      return fits.slice(0, 15).map((s) => `${s.id} — ${s.position ?? 'Shift'} at ${s.site ?? 'the site'}, ${forModel(s.startsAt, s.timezone)} to ${hugoWhen(new Date(s.endsAt), s.timezone, 'en').split(', ').pop()}`).join('\n');
    },
    prepare: async (c, args) => {
      const { shiftId } = parse(z.object({ shiftId: uuid() }), args);
      const fits = await openShiftsThatFit(c.user.associateId!, { before: new Date(c.now.getTime() + 14 * DAY) });
      const s = fits.find((x) => x.id === shiftId);
      if (!s) throw new GoalActionRefusal('That shift is not one of the open shifts that fit them now — look again with find_options.');
      const asked = await prisma.openShiftClaim.findFirst({ where: { shiftId, associateId: c.user.associateId!, status: 'PENDING' }, select: { id: true } });
      if (asked) throw new GoalActionRefusal('They already asked for that shift; it is waiting on their manager.');
      const w = GOAL_STEP_WORDS.pickUp(c.lang, s.position ?? '', hugoWhen(new Date(s.startsAt), s.timezone, c.lang), s.site);
      return { action: 'PICK_UP_SHIFT', ...w, run: { call: { method: 'POST', path: `/scheduling/me/open-shifts/${shiftId}/claim`, body: {} } }, linkUrl: '/marketplace' };
    },
  },
  {
    action: 'REQUEST_TIME_OFF',
    allowed: (c) => isAssociate(c) && can(c.user, 'view:time'),
    describe:
      'Request time off for the person. Their manager decides. args: { startDate: "YYYY-MM-DD", endDate: "YYYY-MM-DD", category: SICK | VACATION | PTO | BEREAVEMENT | JURY_DUTY | OTHER, hours: number (half-hours, the total), reason?: string }',
    options: async (c) => {
      const tz = zoneOf(c.user);
      const today = localDateKey(c.now, tz);
      const mine = await prisma.timeOffRequest.findMany({
        where: { associateId: c.user.associateId!, status: { in: ['PENDING', 'APPROVED'] }, endDate: { gte: new Date(`${today}T00:00:00Z`) } },
        orderBy: { startDate: 'asc' },
        take: 10,
        select: { startDate: true, endDate: true, status: true, category: true },
      });
      const lines = [`Today is ${today} on their clock (${tz}). Dates from today up to a year ahead; at most 60 days at once.`];
      lines.push(mine.length ? `Already asked or approved: ${mine.map((r) => `${dateColumnKey(r.startDate)}–${dateColumnKey(r.endDate)} ${r.category} (${r.status.toLowerCase()})`).join('; ')}.` : 'They have no time off asked for or approved ahead.');
      return lines.join('\n');
    },
    prepare: async (c, args) => {
      const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
      const a = parse(
        z.object({
          startDate: day,
          endDate: day,
          category: z.enum(['SICK', 'VACATION', 'PTO', 'BEREAVEMENT', 'JURY_DUTY', 'OTHER']),
          hours: z.number().positive().max(2000).multipleOf(0.5),
          reason: z.string().trim().max(300).optional().transform((s) => (s ? redactSensitiveNumbers(s) : undefined)),
        }),
        args,
      );
      const tz = zoneOf(c.user);
      const today = localDateKey(c.now, tz);
      if (a.startDate < today) throw new GoalActionRefusal(`The first day is in the past (today is ${today}).`);
      if (a.endDate < a.startDate) throw new GoalActionRefusal('The last day is before the first.');
      if (a.startDate > addDaysToKey(today, 365)) throw new GoalActionRefusal('That is more than a year ahead.');
      const days = Math.round((Date.parse(`${a.endDate}T12:00:00Z`) - Date.parse(`${a.startDate}T12:00:00Z`)) / DAY) + 1;
      if (days > 60) throw new GoalActionRefusal('That is more than 60 days at once — split it.');
      if (a.hours > days * 24) throw new GoalActionRefusal(`${a.hours} hours don't fit in ${days} day(s).`);
      const overlap = await prisma.timeOffRequest.findFirst({
        where: {
          associateId: c.user.associateId!,
          status: { in: ['PENDING', 'APPROVED'] },
          startDate: { lte: new Date(`${a.endDate}T00:00:00Z`) },
          endDate: { gte: new Date(`${a.startDate}T00:00:00Z`) },
        },
        select: { id: true },
      });
      if (overlap) throw new GoalActionRefusal('They already asked for (or have) time off on some of those days.');
      const range = a.startDate === a.endDate ? hugoDay(a.startDate, c.lang) : `${hugoDay(a.startDate, c.lang)} – ${hugoDay(a.endDate, c.lang)}`;
      const w = GOAL_STEP_WORDS.timeOff(c.lang, range, TIME_OFF_WORD[a.category]![c.lang], a.hours);
      const body = { category: a.category, startDate: a.startDate, endDate: a.endDate, hours: a.hours, ...(a.reason ? { reason: a.reason } : {}) };
      return { action: 'REQUEST_TIME_OFF', ...w, run: { call: { method: 'POST', path: '/time-off/me/requests', body } }, linkUrl: '/time-off' };
    },
  },
  {
    action: 'FIND_COVER',
    allowed: (c) => isAssociate(c) && sched(c),
    describe: "Ask the person's free coworkers, one at a time, to take one of their shifts (Hugo's own cover task; their manager approves, they stay on the shift until then). Not for a shift starting within three hours. args: { shiftId }",
    options: async (c) => {
      const mine = await myCoverableShifts(c);
      if (!mine.length) return 'They have no shift three hours or more away in the next two weeks.';
      return mine.map((s) => {
        const r = shiftRefOf(s);
        return `${s.id} — ${r.position ?? 'Shift'} at ${r.site ?? 'the site'}, ${forModel(r.startsAt, r.timezone)}`;
      }).join('\n');
    },
    prepare: async (c, args) => {
      const { shiftId } = parse(z.object({ shiftId: uuid() }), args);
      const s = (await myCoverableShifts(c)).find((x) => x.id === shiftId);
      if (!s) throw new GoalActionRefusal('That is not one of their shifts three hours or more away — look again with find_options.');
      const inFlight = await prisma.shiftSwapRequest.findFirst({ where: { shiftId, status: { in: ['PENDING_PEER', 'PEER_ACCEPTED'] } }, select: { id: true } });
      if (inFlight) throw new GoalActionRefusal('A swap for that shift is already waiting on an answer.');
      const task: HugoTaskCreate = { kind: 'FIND_COVER', shiftId };
      if (!(await previewHugoTask(c.user, task, c.now))) throw new GoalActionRefusal('Hugo cannot look for cover for that shift.');
      const r = shiftRefOf(s);
      return { action: 'FIND_COVER', ...GOAL_STEP_WORDS.cover(c.lang, hugoWhen(new Date(r.startsAt), r.timezone, c.lang)), run: { task }, linkUrl: null };
    },
  },
  {
    action: 'SCHEDULE_CHANGE',
    allowed: (c) => isAssociate(c),
    describe: "Send the person's lead a schedule-change request in their words (days, times, availability). args: { text } (their request, under 450 characters, in their language)",
    options: async (c) => {
      const esc = await escalationFor(c.user as unknown as Asker);
      return esc ? `It goes to ${esc.who ?? 'their supervisor'} as a message thread.` : 'There is no supervisor to send it to.';
    },
    prepare: async (c, args) => {
      const { text } = parse(z.object({ text: words(450) }), args);
      return {
        action: 'SCHEDULE_CHANGE',
        title: GOAL_STEP_WORDS.scheduleChange(c.lang),
        detail: text,
        run: { call: { method: 'POST', path: '/hugo/handoff', body: { text: `Schedule change request: ${text}` } } },
        linkUrl: '/messages',
      };
    },
    judge: handoffJudge,
  },
  {
    action: 'ASK_SUPERVISOR',
    allowed: (c) => isAssociate(c),
    describe: "Pass a question of the person's to their supervisor as a message thread (for what no tool covers). args: { question } (in their words, under 450 characters)",
    options: async (c) => {
      const esc = await escalationFor(c.user as unknown as Asker);
      return esc ? `It goes to ${esc.who ?? 'their supervisor'}.` : 'There is no supervisor to send it to.';
    },
    prepare: async (c, args) => {
      const { question } = parse(z.object({ question: words(450) }), args);
      const esc = await escalationFor(c.user as unknown as Asker);
      return {
        action: 'ASK_SUPERVISOR',
        title: GOAL_STEP_WORDS.askSupervisor(c.lang, esc?.who ?? null),
        detail: question,
        run: { call: { method: 'POST', path: '/hugo/handoff', body: { text: question } } },
        linkUrl: '/messages',
      };
    },
    judge: handoffJudge,
  },
  {
    action: 'CHASE_CONFIRMATIONS',
    allowed: (c) => sched(c) && can(c.user, 'manage:scheduling'),
    describe: "Nudge everyone in the desk's reach who hasn't confirmed a day's shifts, keep count, and report who's still out (Hugo's own chase task). args: { date?: \"YYYY-MM-DD\" } (default tomorrow, within the next week)",
    options: async (c) => {
      const tz = zoneOf(c.user);
      const lines: string[] = [];
      for (let i = 0; i <= 2; i++) {
        const date = addDaysToKey(localDateKey(c.now, tz), i);
        const s = await previewHugoTask(c.user, { kind: 'CHASE_CONFIRMATIONS', date }, c.now);
        lines.push(`${date}: ${s ? `${s.shifts} assigned shifts not yet started` : 'nothing to confirm'}`);
      }
      return lines.join('\n');
    },
    prepare: async (c, args) => {
      const { date } = parse(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }), args);
      const task: HugoTaskCreate = { kind: 'CHASE_CONFIRMATIONS', ...(date ? { date } : {}) };
      const s = await previewHugoTask(c.user, task, c.now);
      if (!s?.date) throw new GoalActionRefusal('No shifts that day need confirming (or the day is not within the next week).');
      return { action: 'CHASE_CONFIRMATIONS', ...GOAL_STEP_WORDS.chase(c.lang, hugoDay(s.date, c.lang), s.shifts ?? 0), run: { task: { kind: 'CHASE_CONFIRMATIONS', date: s.date } }, linkUrl: null };
    },
  },
  {
    action: 'OFFER_SHIFT',
    allowed: (c) => sched(c) && can(c.user, 'manage:scheduling'),
    describe:
      "Give one open shift in the desk's reach to one named worker (the product's assign route checks their time off, rest and rules). args: { shiftId, associateId }. find_options with a query (a name) also lists matching workers.",
    options: async (c, query) => {
      const shifts = await deskOpenShifts(c);
      const lines = shifts.length
        ? shifts.slice(0, 20).map((s) => {
            const r = shiftRefOf(s);
            return `shift ${s.id} — ${r.position ?? 'Shift'} at ${r.site ?? 'the site'}, ${forModel(r.startsAt, r.timezone)}`;
          })
        : ['No open shifts in reach over the next two weeks.'];
      const q = str(query).trim().slice(0, 60);
      if (q) {
        const people = await prisma.associate.findMany({
          where: scopeWhere(scopeAssociates(c.user), { deletedAt: null }, { OR: [{ firstName: { contains: q, mode: 'insensitive' } }, { lastName: { contains: q, mode: 'insensitive' } }] }),
          orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
          take: 8,
          select: { id: true, firstName: true, lastName: true },
        });
        lines.push(...(people.length ? people.map((p) => `person ${p.id} — ${p.firstName} ${p.lastName}`) : [`Nobody in reach matches "${q}".`]));
      } else lines.push('Pass query (a name) to find the worker.');
      return lines.join('\n');
    },
    prepare: async (c, args) => {
      const a = parse(z.object({ shiftId: uuid(), associateId: uuid() }), args);
      const [shift] = await deskOpenShifts(c, a.shiftId);
      if (!shift) throw new GoalActionRefusal('That shift is not open in their reach — look again with find_options.');
      const person = await prisma.associate.findFirst({ where: scopeWhere(scopeAssociates(c.user), { id: a.associateId, deletedAt: null }), select: { firstName: true, lastName: true } });
      if (!person) throw new GoalActionRefusal('That worker is not in their reach.');
      const r = shiftRefOf(shift);
      const w = GOAL_STEP_WORDS.offerShift(c.lang, `${person.firstName} ${person.lastName}`, r.position ?? '', hugoWhen(new Date(r.startsAt), r.timezone, c.lang), r.site);
      return { action: 'OFFER_SHIFT', ...w, run: { call: { method: 'POST', path: `/scheduling/shifts/${a.shiftId}/assign`, body: { associateId: a.associateId } } }, linkUrl: '/scheduling' };
    },
  },
  {
    action: 'MESSAGE_CREW',
    allowed: (c) => can(c.user, 'message:crew'),
    describe: "Text the people on some of today's or tomorrow's staffed shifts at one client. args: { shiftIds: string[], body } (under 600 characters, in the crew's language)",
    options: async (c) => {
      const rows = await crewShifts(c);
      if (!rows.length) return 'Nobody is scheduled today or tomorrow in their reach.';
      return rows.slice(0, 40).map((s) => {
        const r = shiftRefOf(s);
        return `${s.id} — ${r.position ?? 'Shift'} at ${r.site ?? 'the site'}, ${forModel(r.startsAt, r.timezone)}, ${s.assignedAssociate ? `${s.assignedAssociate.firstName} ${s.assignedAssociate.lastName}` : ''}`;
      }).join('\n');
    },
    prepare: async (c, args) => {
      const a = parse(z.object({ shiftIds: z.array(uuid()).min(1).max(60), body: words(600) }), args);
      const rows = await crewShifts(c, a.shiftIds);
      if (!rows.length) throw new GoalActionRefusal("None of those shifts are today's or tomorrow's in their reach — look again with find_options.");
      // One client per text (the crew-text route's rule): the first shift's.
      const clientId = rows[0]!.clientId;
      const mine = rows.filter((s) => s.clientId === clientId);
      const names = [...new Set(mine.map((s) => (s.assignedAssociate ? `${s.assignedAssociate.firstName} ${s.assignedAssociate.lastName}` : '')).filter(Boolean))];
      const short = a.body.length > 80 ? `${a.body.slice(0, 80)}…` : a.body;
      const w = GOAL_STEP_WORDS.crew(c.lang, names.length, short, names.slice(0, 8).join(', '));
      return { action: 'MESSAGE_CREW', ...w, run: { call: { method: 'POST', path: '/floor/crew-text', body: { shiftIds: mine.map((s) => s.id), body: a.body, ...(clientId ? { clientId } : {}) } } }, linkUrl: '/' };
    },
    judge: (body) => {
      const b = body as { sent?: number; notConfigured?: string | null } | null;
      if (b?.notConfigured) return { outcome: 'refused', code: 'texting_off' };
      if (b && b.sent === 0) return { outcome: 'refused', code: 'not_sent' };
      return null;
    },
  },
];

const BY_ACTION = new Map(CATALOG.map((e) => [e.action, e]));

/** The actions this person may propose right now. */
export function goalActionsFor(c: GoalActionCtx): ProposableAction[] {
  return CATALOG.filter((e) => e.allowed(c)).map((e) => e.action);
}

/** One line per action, for the model's tool description. */
export function describeGoalActions(actions: ProposableAction[]): string {
  return actions.map((a) => `${a}: ${BY_ACTION.get(a)!.describe}`).join('\n');
}

function entryFor(c: GoalActionCtx, action: string): Entry {
  const e = BY_ACTION.get(action as ProposableAction);
  if (!e || !(HUGO_GOAL_ACTIONS as readonly string[]).includes(action)) throw new GoalActionRefusal(`There is no action called ${action}.`);
  if (!e.allowed(c)) throw new GoalActionRefusal(`${action} is not something this person can do here.`);
  return e;
}

/** What an action could apply to now, for the model (ids and plain labels). */
export async function goalActionOptions(c: GoalActionCtx, action: string, query?: string): Promise<string> {
  return entryFor(c, action).options(c, query);
}

/** Check the model's choice against the person's own records now; say what will happen. */
export async function prepareGoalAction(c: GoalActionCtx, action: string, args: Record<string, unknown>): Promise<PreparedGoalAction> {
  return entryFor(c, action).prepare(c, args);
}

/**
 * How the product's route answered: done, sent for a second person's
 * approval (202 / `pending` — second-person approvals), or refused (its
 * code). A 2xx that did not do the thing reads as refused (`judge`).
 */
export function judgeGoalCall(action: HugoGoalAction, status: number, body: unknown): { outcome: HugoGoalStepOutcome; code: string | null } {
  if (status >= 200 && status < 300) {
    const judged = BY_ACTION.get(action as ProposableAction)?.judge?.(body);
    if (judged) return judged;
    const pending = status === 202 || (body as { pending?: boolean } | null)?.pending === true;
    return { outcome: pending ? 'pending' : 'done', code: null };
  }
  const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
  return { outcome: 'refused', code: typeof code === 'string' ? code.slice(0, 48) : `http_${status}` };
}
