import type { Prisma } from '@prisma/client';

/**
 * ONE DEFINITION OF "STUCK" (F500 SH-4; role walk HR 2 / HR 15).
 *
 *   An application is stuck when it is still in flight (draft, submitted
 *   or in review), its checklist is not finished, and NOTHING HAS MOVED for
 *   STUCK_DAYS: no task completed and no invite since. Its last activity is
 *   the later of the invite and the latest task completion; a nudge from HR
 *   is not activity — the hire is still where they were.
 *
 *   One rule for every surface that counts or lists it: the onboarding
 *   list's "Stuck" chip and its rows' "Nd idle", the stats tile and the
 *   banner, "Nudge all stale" (the count HR confirms is the set nudged), the
 *   automatic nudge sweep, the Inbox's count and the HR home's item. They
 *   used to be three: the banner counted from the invite ("stuck 33d"), the
 *   row from the last task ("0d idle"), the chip from the row's updatedAt
 *   ("Idle drafts 0") — all on one screen.
 */
export const STUCK_DAYS = 7;
/** Kept for older callers: the same number. */
export const IDLE_DRAFT_DAYS = STUCK_DAYS;

const DAY_MS = 86_400_000;
const IN_FLIGHT = ['DRAFT', 'SUBMITTED', 'IN_REVIEW'] as const;
const DONE = ['DONE', 'SKIPPED'] as const;

/** When the application last moved: the latest task completion, else the invite. */
export function lastActivityOf(app: { invitedAt: Date; tasks?: ReadonlyArray<{ completedAt: Date | null }> | null }): Date {
  let at = app.invitedAt.getTime();
  for (const t of app.tasks ?? []) if (t.completedAt && t.completedAt.getTime() > at) at = t.completedAt.getTime();
  return new Date(at);
}

/** The rule, on a row in hand. */
export function isStuck(
  app: { status: string; invitedAt: Date; tasks?: ReadonlyArray<{ status: string; completedAt: Date | null }> | null },
  now: Date = new Date(),
): boolean {
  if (!(IN_FLIGHT as readonly string[]).includes(app.status)) return false;
  const tasks = app.tasks ?? [];
  const finished = tasks.length > 0 && tasks.every((t) => (DONE as readonly string[]).includes(t.status));
  if (finished) return false;
  return now.getTime() - lastActivityOf(app).getTime() > STUCK_DAYS * DAY_MS;
}

/** The same rule as a where clause, for counts and the "Stuck" list filter. */
export function stuckWhere(now: Date = new Date()): Prisma.ApplicationWhereInput {
  const cutoff = new Date(now.getTime() - STUCK_DAYS * DAY_MS);
  return {
    status: { in: [...IN_FLIGHT] },
    invitedAt: { lt: cutoff },
    AND: [
      // Not finished: no checklist yet, or a task still open.
      { OR: [{ checklist: { is: null } }, { checklist: { is: { tasks: { some: { status: { notIn: [...DONE] } } } } } }, { checklist: { is: { tasks: { none: {} } } } }] },
      // Nothing completed since the cutoff.
      { OR: [{ checklist: { is: null } }, { checklist: { is: { tasks: { none: { completedAt: { gte: cutoff } } } } } }] },
    ],
  };
}

/**
 * The "Idle drafts" filter's old name and the Inbox's "drafts gone quiet":
 * now the one rule above (the chip is called "Stuck").
 */
export function idleDraftsWhere(now: Date = new Date()): Prisma.ApplicationWhereInput {
  return stuckWhere(now);
}
