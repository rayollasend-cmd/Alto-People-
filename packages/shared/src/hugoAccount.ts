/**
 * One Hugo per account (owner, 2026-10-29: "every unique individual user
 * should have their Hugo. It should be tied to every user account").
 *
 *   HugoProfile   one row per account: the allowance cycle (lib/hugoAllowance)
 *                 and the person's Hugo settings that used to live in one
 *                 browser — read answers aloud, and when they last started over.
 *   HugoTurn      the conversation in the app, kept on the server so it follows
 *                 the person to every device they sign in on (90 days, then a
 *                 sweep removes it). Words are stored redacted — never an SSN
 *                 or an account number — and only the person reads them.
 *
 * Types only: nothing here runs at import (the web's first load stays small).
 */

/** The most turns GET /hugo/thread returns (the newest, oldest first). */
export const HUGO_THREAD_PAGE = 50;
/** The longest a stored turn's words can be. */
export const HUGO_TURN_MAX_CHARS = 4000;
/** How many of the person's own last turns the model is given as the conversation so far. */
export const HUGO_MODEL_HISTORY_TURNS = 10;

export type HugoTurnRole = 'user' | 'assistant';

/** One turn of the person's conversation with Hugo, as the app shows it. */
export interface HugoThreadTurn {
  id: string;
  role: HugoTurnRole;
  text: string;
  /** What the answer came from (the registry's intent, MODEL…) — the source line. */
  intent: string | null;
  linkUrl: string | null;
  createdAt: string;
}

/** GET /hugo/thread */
export interface HugoThreadView {
  turns: HugoThreadTurn[];
  /** The last "Start over" (on any device): anything older is gone everywhere. */
  clearedAt: string | null;
  /** How long a conversation is kept before the sweep removes it. */
  retentionDays: number;
}

/** The ids the server gave the two turns of one ask (the answer payload's `turns`). */
export interface HugoSavedTurns {
  question: { id: string; createdAt: string };
  answer: { id: string; createdAt: string };
}

/** GET/PATCH /hugo/profile — the person's own Hugo settings, on every device. */
export interface HugoProfileView {
  /** Null: never chosen on any device (the app carries a browser's earlier choice up once). */
  readAloud: boolean | null;
  threadClearedAt: string | null;
  retentionDays: number;
}

/** GET /hugo/allowance — where the person's own allowance for Hugo's thinking stands. */
export interface HugoAllowanceView {
  /** A model is configured: without one there is no thinking time to count. */
  on: boolean;
  allowanceClass: 'floor' | 'staff';
  usedPercent: number;
  exhausted: boolean;
  periodStart: string;
  renewsAt: string;
  /** The office only: dollars spent and the cap. A worker sees the share. */
  spentUsd?: number;
  capUsd?: number;
}

export type HugoUsagePurpose = 'chat' | 'goal' | 'recurring' | 'whatsapp';

/** One person in the admin's top spenders. */
export interface HugoUsagePerson {
  userId: string;
  name: string;
  /** The role's plain name (ROLE_LABELS). */
  role: string;
  allowanceClass: 'floor' | 'staff';
  /** Spent this month, in US dollars. */
  spentUsd: number;
  /** Of their own allowance, in their own current period (what they see). */
  usedPercent: number;
  exhausted: boolean;
}

/** GET /hugo/admin/usage (manage:org) — this month's spend on Hugo's thinking for the organization. */
export interface HugoAdminUsage {
  on: boolean;
  /** The company's calendar month. */
  periodStart: string;
  periodEnd: string;
  totalUsd: number;
  /** How many people Hugo thought for this month. */
  people: number;
  byClass: { floor: number; staff: number };
  byPurpose: Record<HugoUsagePurpose, number>;
  /** People whose own allowance is used up right now. */
  exhaustedPeople: number;
  /** Each person's allowance, in US dollars. */
  capUsd: { floor: number; staff: number };
  /** The 20 who spent the most this month. */
  top: HugoUsagePerson[];
}
