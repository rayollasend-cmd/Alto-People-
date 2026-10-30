import { z } from 'zod';

/**
 * Hugo works for you: tasks a person hands the assistant, and notes it
 * raises on its own (owner, 2026-10-25: "give Hugo a task and carry on; it
 * lets you know when it's done; it makes recommendations on its own").
 *
 *   A TASK is work the person started with a tap: watch for something and
 *   say when it happens, or ask coworkers to cover a shift one at a time,
 *   or chase tomorrow's unconfirmed shifts. It runs on the server
 *   (lib/hugoTasks), keeps a trail of every step, and tells the person when
 *   it is done or when only they can decide the next step (NEEDS_YOU).
 *
 *   A NOTE is something Hugo noticed in the person's own records — a
 *   credential running out, an open shift that fits them — with one thing
 *   it could do about it. Notes never act; accepting one is the tap.
 *   At most two a day reach the lock screen, none at night, and every
 *   kind can be turned off (lib/hugoNotes).
 *
 *   Words live with the reader: the web renders every title, step and
 *   choice from these codes in the person's language; the server writes
 *   only the notices it sends.
 */

export const HUGO_TASK_KINDS = ['WATCH_TIME_OFF', 'WATCH_OPEN_SHIFTS', 'WATCH_PAYCHECK', 'WATCH_DOCUMENT', 'FIND_COVER', 'CHASE_CONFIRMATIONS', 'RECURRING', 'GOAL'] as const;
export type HugoTaskKind = (typeof HUGO_TASK_KINDS)[number];

/**
 * Whose task it is: an associate's own records, a desk that schedules
 * (manage:scheduling), or anyone the assistant serves (each kind checks what
 * it needs itself — a recurring brief, by the answer it repeats).
 */
export const HUGO_TASK_FOR: Record<HugoTaskKind, 'associate' | 'desk' | 'anyone'> = {
  WATCH_TIME_OFF: 'associate',
  WATCH_OPEN_SHIFTS: 'associate',
  WATCH_PAYCHECK: 'associate',
  WATCH_DOCUMENT: 'associate',
  FIND_COVER: 'associate',
  CHASE_CONFIRMATIONS: 'desk',
  RECURRING: 'anyone',
  // A goal: what Hugo may propose depends on what the person may do (lib/hugoGoalActions).
  GOAL: 'anyone',
};

/**
 * WORKING: Hugo is doing something now. WAITING: on someone else (a coworker,
 * a manager, a decision). NEEDS_YOU: only the person can take the next step.
 * The rest are final.
 */
export const HUGO_TASK_STATUSES = ['WORKING', 'WAITING', 'NEEDS_YOU', 'DONE', 'CANCELLED', 'FAILED', 'EXPIRED'] as const;
export type HugoTaskStatus = (typeof HUGO_TASK_STATUSES)[number];
export const HUGO_TASK_OPEN_STATUSES: readonly HugoTaskStatus[] = ['WORKING', 'WAITING', 'NEEDS_YOU'];
export const isHugoTaskOpen = (s: HugoTaskStatus): boolean => HUGO_TASK_OPEN_STATUSES.includes(s);

/** Why a task waits on its person. */
export const HUGO_TASK_NEEDS = ['NO_ONE_LEFT', 'MANAGER_REJECTED', 'REUPLOAD', 'STILL_UNCONFIRMED', 'CALLED_OFF', 'KEEP_GOING', 'GOAL_APPROVAL'] as const;
export type HugoTaskNeed = (typeof HUGO_TASK_NEEDS)[number];

/** What the person can answer a NEEDS_YOU with. */
export const HUGO_TASK_CHOICES = ['KEEP_TRYING', 'ASK_SUPERVISOR', 'NUDGE_AGAIN', 'GOT_IT', 'STOP', 'KEEP_GOING', 'APPROVE', 'DECLINE'] as const;
export type HugoTaskChoice = (typeof HUGO_TASK_CHOICES)[number];

/** The answers each need offers, first = the suggested one. */
export const HUGO_TASK_CHOICES_FOR: Record<HugoTaskNeed, readonly HugoTaskChoice[]> = {
  NO_ONE_LEFT: ['KEEP_TRYING', 'ASK_SUPERVISOR', 'STOP'],
  MANAGER_REJECTED: ['KEEP_TRYING', 'ASK_SUPERVISOR', 'STOP'],
  REUPLOAD: ['GOT_IT'],
  STILL_UNCONFIRMED: ['NUDGE_AGAIN', 'GOT_IT'],
  CALLED_OFF: ['GOT_IT'],
  // A recurring brief a week from its end: carry on for another 180 days, or let it end.
  KEEP_GOING: ['KEEP_GOING', 'STOP'],
  // A goal's proposal (HugoGoalView.pending): do it, not this one (Hugo plans around it), or stop the goal.
  GOAL_APPROVAL: ['APPROVE', 'DECLINE', 'STOP'],
};

/**
 * One line on a task's trail. `data` carries what the line names (a
 * coworker's first name, a count, a date) — never more than the person
 * could already see.
 */
export const HUGO_TASK_EVENT_CODES = [
  'STARTED',
  'DECIDED',
  'FOUND_SHIFTS',
  'PAID',
  'DOC_VERIFIED',
  'DOC_REJECTED',
  'ASKED',
  'NO_ANSWER',
  'DECLINED',
  'ACCEPTED',
  'APPROVED',
  'REJECTED',
  'NO_ONE_LEFT',
  'NUDGED',
  'CONFIRMED',
  'CALLED_OFF',
  'ALL_CONFIRMED',
  'STILL_UNCONFIRMED',
  'KEPT_TRYING',
  'PASSED_TO_SUPERVISOR',
  'SHIFT_CHANGED',
  'DONE',
  'CANCELLED',
  'EXPIRED',
  'FAILED',
  // RECURRING: a brief sent (data.what, data.text), paused / resumed by the
  // person, its time changed, one held to tomorrow (a cap), one skipped (with
  // why), and "keep going" for another 180 days.
  'DELIVERED',
  'PAUSED',
  'RESUMED',
  'RESCHEDULED',
  'DEFERRED',
  'SKIPPED',
  'KEPT_GOING',
  // GOAL: the plan made or changed (data.count), one step of Hugo's thinking
  // (data.tier — counted for the caps, not shown), a proposal made
  // (data.action, data.title), how an approved one went (data.outcome done |
  // pending | refused, data.code), one declined, an update for the person
  // (data.text), a watch or ask started for it (data.kind, data.taskId), and
  // given up (data.summary). PAUSED and KEPT_GOING serve goals too.
  'PLANNED',
  'STEP',
  'PROPOSED',
  'STEP_DONE',
  'STEP_DECLINED',
  'UPDATE',
  'WATCH_STARTED',
  'GAVE_UP',
] as const;
export type HugoTaskEventCode = (typeof HUGO_TASK_EVENT_CODES)[number];

/* -------------------------------------------- recurring briefs (Muse phase 5) */

/**
 * What a RECURRING task tells the person, on a schedule they set: one of the
 * registry's answers open to them (their shifts, payday, ride, documents to
 * renew; a desk's queue and coverage; a driver's next run), their hours this
 * store week (MY_HOURS), or a question of their own answered fresh each
 * time by the quick model (ASK — only while a model is on).
 */
export const HUGO_RECURRING_WHATS = ['SCHEDULE', 'PAYDAY', 'RIDE', 'RENEW', 'DESK', 'COVERAGE', 'DRIVER_NEXT_RUN', 'MY_HOURS', 'ASK'] as const;
export type HugoRecurringWhat = (typeof HUGO_RECURRING_WHATS)[number];

/** Every day, Monday to Friday, or one day a week. */
export const HUGO_RECURRING_CADENCES = ['DAILY', 'WEEKDAYS', 'WEEKLY'] as const;
export type HugoRecurringCadence = (typeof HUGO_RECURRING_CADENCES)[number];

/** HH:MM, 24-hour, on the person's clock. */
export const HUGO_RECURRING_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A recurring brief's schedule, as the person set it (HugoTaskSubject.recurring). */
export interface HugoRecurringSchedule {
  what: HugoRecurringWhat;
  cadence: HugoRecurringCadence;
  /** WEEKLY: 0 = Sunday … 6 = Saturday; null otherwise. */
  weekday: number | null;
  /** HH:MM on the person's clock. */
  time: string;
  /** Their site's zone, else the company's — the clock the time is read on. */
  timezone: string;
  /** ASK: their question, with any SSN or account number taken out. */
  question?: string;
  paused: boolean;
}

/** Where a recurring brief stands (HugoTaskResult.recurring). */
export interface HugoRecurringStatus {
  /** The next one, or null while paused. */
  nextAt: string | null;
  lastAt: string | null;
  deliveries: number;
}

export interface HugoShiftRef {
  id: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  site: string | null;
  position: string | null;
}

/** What a task is about, captured when it starts — its title is built from this. */
export interface HugoTaskSubject {
  shift?: HugoShiftRef;
  timeOff?: Array<{ id: string; startDate: string; endDate: string }>;
  documents?: Array<{ id: string; name: string; kind: string }>;
  /** WATCH_OPEN_SHIFTS: how many days ahead it looks. */
  days?: number;
  /** CHASE_CONFIRMATIONS: the day (YYYY-MM-DD, the desk's own zone) and the shifts it started with. */
  date?: string;
  shifts?: number;
  /** RECURRING: what, how often, when. */
  recurring?: HugoRecurringSchedule;
  /** GOAL: the person's words (any SSN or account number taken out). */
  goal?: string;
}

/** What a task came to. */
export interface HugoTaskResult {
  timeOff?: Array<{ id: string; startDate: string; endDate: string; status: 'APPROVED' | 'DENIED' | 'CANCELLED' }>;
  shifts?: HugoShiftRef[];
  paycheck?: { itemId: string; periodStart: string; periodEnd: string };
  documents?: Array<{ id: string; name: string; status: 'VERIFIED' | 'REJECTED'; reason: string | null }>;
  /** FIND_COVER: who took the shift. */
  coveredBy?: string;
  /** FIND_COVER: handed to a person instead (their name when known) and the thread it went to. */
  passedTo?: { who: string | null; url: string | null };
  /** CHASE_CONFIRMATIONS: who has still not confirmed, and who called off. */
  unconfirmed?: Array<{ shiftId: string; name: string; startsAt: string; timezone: string; site: string | null }>;
  calledOff?: Array<{ shiftId: string; name: string; startsAt: string; timezone: string; site: string | null }>;
  /** RECURRING: the next one, the last one, how many so far. */
  recurring?: HugoRecurringStatus;
}

export interface HugoTaskEventView {
  id: string;
  code: HugoTaskEventCode;
  data: Record<string, string | number | null>;
  at: string;
}

export interface HugoTaskView {
  id: string;
  kind: HugoTaskKind;
  status: HugoTaskStatus;
  needs: HugoTaskNeed | null;
  choices: HugoTaskChoice[];
  subject: HugoTaskSubject;
  /** e.g. 3 of 5 coworkers asked, 7 of 9 shifts confirmed. */
  progress: { done: number; total: number } | null;
  result: HugoTaskResult | null;
  linkUrl: string | null;
  /** goal: started by one of the person's goals, on its approved step. */
  source: 'panel' | 'chat' | 'note' | 'goal' | 'whatsapp';
  /** False while a finished or needs-you task has not been looked at. */
  seen: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  expiresAt: string;
  /** Oldest first. */
  events: HugoTaskEventView[];
  /** GOAL: the plan, what waits on the person, how the last step went. */
  goal?: HugoGoalView;
}

export interface HugoTaskListResponse {
  tasks: HugoTaskView[];
}

export const HugoTaskCreateInputSchema = /* @__PURE__ */ (() =>
  z.discriminatedUnion('kind', [
    // No request named: every request of theirs still pending.
    z.object({ kind: z.literal('WATCH_TIME_OFF'), requestId: z.string().uuid().optional() }),
    z.object({ kind: z.literal('WATCH_OPEN_SHIFTS'), days: z.number().int().min(1).max(14).default(7) }),
    z.object({ kind: z.literal('WATCH_PAYCHECK') }),
    // No document named: every upload of theirs waiting for review.
    z.object({ kind: z.literal('WATCH_DOCUMENT'), documentId: z.string().uuid().optional() }),
    z.object({ kind: z.literal('FIND_COVER'), shiftId: z.string().uuid(), note: z.string().trim().max(300).optional() }),
    // No day named: tomorrow, in the desk's zone.
    z.object({ kind: z.literal('CHASE_CONFIRMATIONS'), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }),
    // A brief on a schedule: WEEKLY names its weekday; ASK carries the question.
    z.object({
      kind: z.literal('RECURRING'),
      what: z.enum(HUGO_RECURRING_WHATS),
      cadence: z.enum(HUGO_RECURRING_CADENCES),
      weekday: z.number().int().min(0).max(6).optional(),
      time: z.string().regex(HUGO_RECURRING_TIME),
      question: z.string().trim().min(3).max(300).optional(),
    }),
    // An outcome in the person's words: Hugo plans it and proposes each step (lib/hugoGoals).
    z.object({ kind: z.literal('GOAL'), goal: z.string().trim().min(3).max(300) }),
  ]))();
export type HugoTaskCreateInput = z.input<typeof HugoTaskCreateInputSchema>;
export type HugoTaskCreate = z.output<typeof HugoTaskCreateInputSchema>;

export const HugoTaskStartSchema = /* @__PURE__ */ (() =>
  z.object({ task: HugoTaskCreateInputSchema, source: z.enum(['panel', 'chat', 'note']).default('panel') }))();

export const HugoTaskRespondInputSchema = /* @__PURE__ */ (() => z.object({ choice: z.enum(HUGO_TASK_CHOICES) }))();

/* ------------------------------------------------------------------ notes */

export const HUGO_NOTE_KINDS = ['CREDENTIAL_EXPIRING', 'OPEN_SHIFT_MATCH', 'DIRECT_DEPOSIT_MISSING', 'UNCONFIRMED_TOMORROW'] as const;
export type HugoNoteKind = (typeof HUGO_NOTE_KINDS)[number];

export const HUGO_NOTE_FOR: Record<HugoNoteKind, 'associate' | 'desk'> = {
  CREDENTIAL_EXPIRING: 'associate',
  OPEN_SHIFT_MATCH: 'associate',
  DIRECT_DEPOSIT_MISSING: 'associate',
  UNCONFIRMED_TOMORROW: 'desk',
};

export const HUGO_NOTE_STATUSES = ['NEW', 'SEEN', 'ACCEPTED', 'DISMISSED', 'EXPIRED'] as const;
export type HugoNoteStatus = (typeof HUGO_NOTE_STATUSES)[number];

export interface HugoNoteData {
  /** `word`: the kind of credential (the compliance agent's word key — ID, J1_VISA, VACCINATION…), for the reader's language; `name` is HR's label. */
  credential?: { id: string; word: string; name: string; expiresOn: string; days: number; url: string };
  shift?: HugoShiftRef;
  /** OPEN_SHIFT_MATCH: other open shifts that fit too. */
  more?: number;
  /** DIRECT_DEPOSIT_MISSING: the payday it is for (YYYY-MM-DD). */
  payday?: string;
  /** UNCONFIRMED_TOMORROW */
  unconfirmed?: { date: string; count: number; total: number };
}

/** What accepting a note does: open a page, or start a task (the person's tap). */
export type HugoNoteAction = { kind: 'link'; url: string } | { kind: 'task'; task: HugoTaskCreateInput; url: string | null };

export interface HugoNoteView {
  id: string;
  kind: HugoNoteKind;
  status: HugoNoteStatus;
  data: HugoNoteData;
  action: HugoNoteAction;
  createdAt: string;
}

export interface HugoNoteListResponse {
  notes: HugoNoteView[];
}

export interface HugoNoteSettings {
  kinds: Array<{ kind: HugoNoteKind; on: boolean }>;
}

export const HugoNoteSettingInputSchema = /* @__PURE__ */ (() => z.object({ kind: z.enum(HUGO_NOTE_KINDS), on: z.boolean() }))();

export const HugoSeenInputSchema = /* @__PURE__ */ (() =>
  z.object({ tasks: z.array(z.string().uuid()).max(100).optional(), notes: z.array(z.string().uuid()).max(100).optional() }))();

/** The badge on the assistant's button. */
export interface HugoSummary {
  /** Running or waiting on someone else. */
  working: number;
  needsYou: number;
  /** Finished since the person last looked. */
  unseenDone: number;
  newNotes: number;
}

/** What the badge counts: what needs the person, what finished unseen, what Hugo noticed. */
export function hugoBadgeCount(s: HugoSummary | null | undefined): number {
  return s ? s.needsYou + s.unseenDone + s.newNotes : 0;
}

/**
 * What Hugo is doing while he answers, for the step line ("Checking your
 * schedule…"): one per kind of record a tool reads, so the words are the
 * app's (hugoPane.step.*) and the tools' names never reach the screen.
 */
export const HUGO_STEPS = ['records', 'schedule', 'pay', 'ride', 'documents', 'desk', 'coverage', 'help', 'report', 'team', 'action', 'person', 'memory'] as const;
export type HugoStep = (typeof HUGO_STEPS)[number];

/**
 * How an answer was made, fastest first: `instant` is the registry's own
 * answer (no model), `fast` a quick model for everyday questions, `deep`
 * the strongest one for actions and numbers (routes/hugo, pickTier).
 */
export type HugoTier = 'instant' | 'fast' | 'deep';

/**
 * POST /hugo/ask/stream: one JSON object per line while Hugo answers.
 * `text` adds to the reply as it is written; `clear` drops what was written
 * so far (he said "let me check" and is now checking); `done` carries the
 * whole answer, the same body POST /hugo/ask returns — the one to keep.
 */
export type HugoAskEvent =
  | { t: 'step'; step: HugoStep }
  | { t: 'text'; d: string }
  | { t: 'clear' }
  | { t: 'done'; answer: Record<string, unknown> }
  | { t: 'error'; message: string };

/** A task the chat offers to start: the person taps Start, or doesn't. */
export interface HugoTaskOffer {
  task: HugoTaskCreateInput;
  subject: HugoTaskSubject;
}

/* -------------------------------------- recurring briefs: the person's say */

/** Change a recurring brief: how often, which day, what time — or pause and resume it. Stopping is POST /hugo/tasks/:id/cancel. */
export const HugoRecurringChangeSchema = /* @__PURE__ */ (() =>
  z.object({
    cadence: z.enum(HUGO_RECURRING_CADENCES).optional(),
    weekday: z.number().int().min(0).max(6).nullable().optional(),
    time: z.string().regex(HUGO_RECURRING_TIME).optional(),
    paused: z.boolean().optional(),
  }))();
export type HugoRecurringChange = z.output<typeof HugoRecurringChangeSchema>;

/* ------------------------------------------------- what Hugo did (activity) */

/**
 * One line of the person's own Hugo history (GET /hugo/activity), newest
 * first. `kind` says where it came from:
 *   task    a line on one of their tasks' trails (every kind — recurring
 *           briefs delivered, goal steps, cover asks…); `code` is the trail's
 *           code and `task` names the task so the line can say what it was about
 *   note    a note they accepted or put away (`code` ACCEPTED | DISMISSED)
 *   action  something they confirmed through the assistant and it ran as
 *           them (`code` DONE | SENT_FOR_APPROVAL | FAILED; `data.title`)
 *   usage   their monthly allowance used up or renewed
 * The words are the app's, from these codes; `data` carries only what the
 * line names.
 */
export type HugoActivityKind = 'task' | 'note' | 'action' | 'usage';

export interface HugoActivityItem {
  id: string;
  at: string;
  kind: HugoActivityKind;
  code: string;
  data: Record<string, string | number | null>;
  linkUrl: string | null;
  task?: { id: string; kind: HugoTaskKind; subject: HugoTaskSubject };
  note?: { id: string; kind: HugoNoteKind; data: HugoNoteData };
}

export interface HugoActivityPage {
  items: HugoActivityItem[];
  /** Pass as `before` for the page after this one; null at the start of their history. */
  next: string | null;
}

/* ------------------------------------------------------ goals (Muse phase 3) */

/**
 * A GOAL is an outcome the person hands Hugo in their own words ("get me 40
 * hours next week", "keep tomorrow fully staffed"). Hugo plans it as a short
 * checklist, reads their records with the reach they have now, watches for
 * what matters, and PROPOSES each thing that would change something: the
 * person approves it, and it runs as them through the product's own route
 * (lib/hugoGoals, lib/hugoGoalActions). It comes back when it needs them.
 */
/** The longest goal (HugoTaskCreateInputSchema says the same). */
export const HUGO_GOAL_MAX_CHARS = 300;
export const HUGO_GOAL_MAX_PLAN = 6;

export const HUGO_GOAL_STEP_STATES = ['todo', 'doing', 'done', 'skipped'] as const;
export type HugoGoalStepState = (typeof HUGO_GOAL_STEP_STATES)[number];

/** One line of the plan, in the person's language. */
export interface HugoGoalStep {
  text: string;
  state: HugoGoalStepState;
}

/**
 * What a goal may propose: an associate's own moves (ask for an open shift,
 * request time off, ask coworkers to cover a shift, send their lead a
 * schedule-change request, pass a question to their supervisor), then a
 * scheduling desk's (chase tomorrow's confirmations, give an open shift to a
 * named person, text a crew). KEEP_GOING asks for more steps when a goal has
 * used the ones it had.
 */
export const HUGO_GOAL_ACTIONS = [
  'PICK_UP_SHIFT',
  'REQUEST_TIME_OFF',
  'FIND_COVER',
  'SCHEDULE_CHANGE',
  'ASK_SUPERVISOR',
  'CHASE_CONFIRMATIONS',
  'OFFER_SHIFT',
  'MESSAGE_CREW',
  'KEEP_GOING',
] as const;
export type HugoGoalAction = (typeof HUGO_GOAL_ACTIONS)[number];

/** What Hugo wants to do, waiting on the person: the product's own words for it, and his reason. */
export interface HugoGoalProposal {
  action: HugoGoalAction;
  title: string;
  detail: string | null;
  /** Why it helps the goal, in a sentence (his words). */
  why: string | null;
  at: string;
}

/** done: it happened · pending: sent for a second person's approval · refused: the product said no (`code` names why). */
export type HugoGoalStepOutcome = 'done' | 'pending' | 'refused';

/** How the last approved step went — shown in place on the card. */
export interface HugoGoalStepResult {
  action: HugoGoalAction;
  title: string;
  outcome: HugoGoalStepOutcome;
  code: string | null;
  at: string;
  linkUrl: string | null;
}

export interface HugoGoalView {
  text: string;
  plan: HugoGoalStep[];
  pending: HugoGoalProposal | null;
  last: HugoGoalStepResult | null;
  lastCheckInAt: string | null;
  /** When Hugo looks again; null while it waits on the person or is closed. */
  nextCheckAt: string | null;
  /** He is taking a step on it right now. */
  thinking: boolean;
  steps: { used: number; max: number };
  /** daily: the organization's steps for today are used · allowance: the person's monthly allowance is. */
  paused: { why: 'daily' | 'allowance'; until: string } | null;
  outcome: 'DONE' | 'GAVE_UP' | null;
  summary: string | null;
}
