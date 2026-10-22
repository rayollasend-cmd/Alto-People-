import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';

/**
 * The one rule every automatic onboarding reminder answers to (HR walk:
 * "email-style onboarding nags every 3 days" piled up — the progress sweep
 * and the stale-nudge sweep each mailed the same person about the same
 * tasks on their own clocks):
 *
 *   - at most one reminder per TASK per REMINDER_ITEM_COOLDOWN_DAYS, per person;
 *   - a task that is done (or skipped) is never reminded again;
 *   - everything due for a person goes out together, in one email.
 *
 * OnboardingTask.remindedAt is the memory: whichever sender reminds about a
 * task stamps it, so the other sender (and the next run) sees it as not due.
 */

export const REMINDER_ITEM_COOLDOWN_DAYS = 3;
const COOLDOWN_MS = REMINDER_ITEM_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;

export interface RemindableTask {
  id: string;
  status: string;
  remindedAt: Date | null;
}

export function isTaskOpen(t: { status: string }): boolean {
  return t.status !== 'DONE' && t.status !== 'SKIPPED';
}

/** True when this task may be reminded about at `now` (pure). */
export function isReminderDue(t: RemindableTask, now: Date): boolean {
  if (!isTaskOpen(t)) return false;
  return t.remindedAt === null || now.getTime() - t.remindedAt.getTime() >= COOLDOWN_MS;
}

/** The open tasks a reminder may name at `now`, in their given order (pure). */
export function dueReminderItems<T extends RemindableTask>(tasks: readonly T[], now: Date): T[] {
  return tasks.filter((t) => isReminderDue(t, now));
}

/** The cutoff a DB filter uses: reminded at or before this instant is due again. */
export function reminderCutoff(now: Date): Date {
  return new Date(now.getTime() - COOLDOWN_MS);
}

/** Stamp the tasks a sent reminder named. Done tasks are left alone. */
export async function markItemsReminded(ids: readonly string[], now: Date, db: PrismaClient = defaultPrisma): Promise<void> {
  if (ids.length === 0) return;
  await db.onboardingTask.updateMany({
    where: { id: { in: [...ids] }, status: { notIn: ['DONE', 'SKIPPED'] } },
    data: { remindedAt: now },
  });
}

/** Stamp every open task of one application (a nudge that went out names them all). */
export async function markApplicationReminded(applicationId: string, now: Date, db: PrismaClient = defaultPrisma): Promise<void> {
  await db.onboardingTask.updateMany({
    where: { checklist: { applicationId }, status: { notIn: ['DONE', 'SKIPPED'] } },
    data: { remindedAt: now },
  });
}
