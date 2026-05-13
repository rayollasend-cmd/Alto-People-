import type { Prisma, PrismaClient, TaskKind, TaskStatus } from '@prisma/client';

type Tx = Prisma.TransactionClient | PrismaClient;

/**
 * Idempotently mark a task DONE by kind. The `notIn` guard makes
 * re-submission a no-op so a double-click doesn't reset completedAt.
 */
export async function markTaskDoneByKind(
  tx: Tx,
  checklistId: string,
  kind: TaskKind
): Promise<void> {
  await tx.onboardingTask.updateMany({
    where: {
      checklistId,
      kind,
      status: { notIn: ['DONE', 'SKIPPED'] },
    },
    data: { status: 'DONE', completedAt: new Date() },
  });
}

export async function markTaskSkippedById(
  tx: Tx,
  taskId: string
): Promise<void> {
  await tx.onboardingTask.updateMany({
    where: {
      id: taskId,
      status: { notIn: ['DONE', 'SKIPPED'] },
    },
    data: { status: 'SKIPPED', completedAt: new Date() },
  });
}

/**
 * Inverse of `markTaskDoneByKind` — flips a previously-DONE task back to
 * PENDING and clears `completedAt`. Used when an admin rejects a document
 * (or other artifact) that the associate had already submitted; the
 * checklist row needs to re-open so they're prompted to redo the step.
 *
 * Skips SKIPPED tasks — those are explicit admin decisions ("we waived
 * this step") and shouldn't be re-opened by a downstream artifact
 * rejection. Returns the count of rows that were actually flipped so
 * callers can decide whether to emit a "task reopened" event.
 */
export async function markTaskTodoByKind(
  tx: Tx,
  checklistId: string,
  kind: TaskKind
): Promise<number> {
  const result = await tx.onboardingTask.updateMany({
    where: {
      checklistId,
      kind,
      status: 'DONE',
    },
    data: { status: 'PENDING', completedAt: null },
  });
  return result.count;
}

/**
 * Percent complete. SKIPPED counts as complete because the schema
 * intentionally distinguishes IN_PROGRESS from SKIPPED — a skipped
 * task is a completed (decided) state, not a pending one.
 */
export function computePercent(
  tasks: Array<{ status: TaskStatus }>
): number {
  if (tasks.length === 0) return 0;
  const complete = tasks.filter(
    (t) => t.status === 'DONE' || t.status === 'SKIPPED'
  ).length;
  return Math.round((complete / tasks.length) * 100);
}
