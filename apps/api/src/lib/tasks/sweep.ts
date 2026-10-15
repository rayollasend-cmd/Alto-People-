import { prisma } from '../../db.js';
import { logger } from '../logger.js';
import { runForEachTenant } from '../tenantJobs.js';
import { handOffExceptions } from './engine.js';

/**
 * Brief 3-2: the handoff sweep. Every fifteen seconds, per tenant, a
 * machine's task that has sat STALLED or FAILED longer than the policy's
 * seconds goes to a person on shift and the crew lead hears about it. The
 * event endpoint hands off straight away when the policy's seconds are zero
 * at that moment; the sweep is what catches a robot that just went quiet.
 */
export const TASK_HANDOFF_SWEEP_MS = 15_000;

let timer: NodeJS.Timeout | null = null;

export function startTaskHandoffSweep(): void {
  if (timer) return;
  const tick = () =>
    runForEachTenant('tasks.handoff', () => handOffExceptions(prisma)).catch((err) => logger.warn({ err }, 'task handoff sweep failed'));
  timer = setInterval(tick, TASK_HANDOFF_SWEEP_MS);
  timer.unref();
}

export function stopTaskHandoffSweep(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
