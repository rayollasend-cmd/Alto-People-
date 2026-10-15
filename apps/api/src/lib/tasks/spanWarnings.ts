import type { Prisma, PrismaClient } from '@prisma/client';
import type { WorkTaskDetailView } from '@alto-people/shared';
import { policyFor } from './engine.js';
import { spanOfControlAt } from './spanOfControl.js';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Brief 3-3: when the engine hands a task to a robot, say whether the floor
 * can watch it. A warning the board shows as a caution banner; the
 * assignment stands either way.
 */
export async function spanWarningsFor(db: Db, task: WorkTaskDetailView, now: Date = new Date()): Promise<string[]> {
  if (task.assignment?.workerType !== 'ROBOT') return [];
  const policy = await policyFor(db, task.locationId);
  const span = await spanOfControlAt(db, task.locationId, policy.maxRobotsPerCrewLead, now);
  if (span.exceeded || span.leads === 0) return [`Span of control: ${span.text}`];
  return [];
}
