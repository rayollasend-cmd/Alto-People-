import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * Brief 3-2's seam to Brief 3-1 (the robot registry, built in parallel).
 *
 * The assignment engine asks one question of a ROBOT worker: can it take a
 * task in this window, and at what battery. Until the registry's connector
 * stores a status time series, the answer comes from the Worker row alone:
 * an ACTIVE robot is available, battery unknown. Brief 3-1 replaces the body
 * of this function with the fleet connector's latest reading (status,
 * battery, maintenance, commissioning sign-off) and keeps the signature.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export interface RobotAvailability {
  available: boolean;
  /** "Running" / "In maintenance" / "Charging (22%)". */
  note: string;
  batteryPct: number | null;
}

export async function robotAvailability(db: Db, workerId: string): Promise<RobotAvailability> {
  const w = await db.worker.findUnique({ where: { id: workerId }, select: { status: true, type: true } });
  if (!w || w.type !== 'ROBOT') return { available: false, note: 'Not a robot on the roster', batteryPct: null };
  if (w.status !== 'ACTIVE') return { available: false, note: `Robot is ${w.status.toLowerCase()}`, batteryPct: null };
  return { available: true, note: 'Running (no fleet reading yet)', batteryPct: null };
}
