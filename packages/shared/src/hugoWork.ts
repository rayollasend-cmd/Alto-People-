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

export const HUGO_TASK_KINDS = ['WATCH_TIME_OFF', 'WATCH_OPEN_SHIFTS', 'WATCH_PAYCHECK', 'WATCH_DOCUMENT', 'FIND_COVER', 'CHASE_CONFIRMATIONS'] as const;
export type HugoTaskKind = (typeof HUGO_TASK_KINDS)[number];

/** Whose task it is: an associate's own records, or a desk that schedules (manage:scheduling). */
export const HUGO_TASK_FOR: Record<HugoTaskKind, 'associate' | 'desk'> = {
  WATCH_TIME_OFF: 'associate',
  WATCH_OPEN_SHIFTS: 'associate',
  WATCH_PAYCHECK: 'associate',
  WATCH_DOCUMENT: 'associate',
  FIND_COVER: 'associate',
  CHASE_CONFIRMATIONS: 'desk',
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
export const HUGO_TASK_NEEDS = ['NO_ONE_LEFT', 'MANAGER_REJECTED', 'REUPLOAD', 'STILL_UNCONFIRMED', 'CALLED_OFF'] as const;
export type HugoTaskNeed = (typeof HUGO_TASK_NEEDS)[number];

/** What the person can answer a NEEDS_YOU with. */
export const HUGO_TASK_CHOICES = ['KEEP_TRYING', 'ASK_SUPERVISOR', 'NUDGE_AGAIN', 'GOT_IT', 'STOP'] as const;
export type HugoTaskChoice = (typeof HUGO_TASK_CHOICES)[number];

/** The answers each need offers, first = the suggested one. */
export const HUGO_TASK_CHOICES_FOR: Record<HugoTaskNeed, readonly HugoTaskChoice[]> = {
  NO_ONE_LEFT: ['KEEP_TRYING', 'ASK_SUPERVISOR', 'STOP'],
  MANAGER_REJECTED: ['KEEP_TRYING', 'ASK_SUPERVISOR', 'STOP'],
  REUPLOAD: ['GOT_IT'],
  STILL_UNCONFIRMED: ['NUDGE_AGAIN', 'GOT_IT'],
  CALLED_OFF: ['GOT_IT'],
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
] as const;
export type HugoTaskEventCode = (typeof HUGO_TASK_EVENT_CODES)[number];

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
  source: 'panel' | 'chat' | 'note';
  /** False while a finished or needs-you task has not been looked at. */
  seen: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  expiresAt: string;
  /** Oldest first. */
  events: HugoTaskEventView[];
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

/** A task the chat offers to start: the person taps Start, or doesn't. */
export interface HugoTaskOffer {
  task: HugoTaskCreateInput;
  subject: HugoTaskSubject;
}
