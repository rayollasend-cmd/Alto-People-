import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * Brief 3-2's seam to Brief 3-1, wired by Brief 3-3.
 *
 * The assignment engine asks one question of a ROBOT worker: can it take a
 * task now, and at what battery. The answer comes from the registry: the
 * worker's status (an emergency stop suspends it), the fleet connector's
 * latest reading (status, battery, how old), an open maintenance item, and
 * whether the robot is commissioned at the site it is placed at. The
 * engine then weighs battery and the note; a robot that is unavailable
 * stays in the ranking with the reason, so a supervisor can read why.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export interface RobotAvailability {
  available: boolean;
  /** "Running (67%)" / "In maintenance: brake inspection" / "Charging (22%)". */
  note: string;
  batteryPct: number | null;
}

/** A reading older than this is no reading: the fleet samples every minute. */
export const STALE_READING_MS = 30 * 60_000;
/** Below this a charging robot stays on the dock. */
export const LOW_BATTERY_PCT = 20;

export async function robotAvailability(db: Db, workerId: string, now: Date = new Date()): Promise<RobotAvailability> {
  const w = await db.worker.findUnique({ where: { id: workerId }, select: { status: true, type: true, name: true } });
  if (!w || w.type !== 'ROBOT') return { available: false, note: 'Not a robot on the roster', batteryPct: null };
  if (w.status === 'SUSPENDED') return { available: false, note: 'Under an emergency stop', batteryPct: null };
  if (w.status !== 'ACTIVE') return { available: false, note: `Robot is ${w.status.toLowerCase()}`, batteryPct: null };

  const [latest, placement, maintenance] = await Promise.all([
    db.robotStatusSample.findFirst({ where: { workerId }, orderBy: { at: 'desc' }, select: { at: true, status: true, batteryPct: true, errorCode: true } }),
    db.workerAssignment.findFirst({ where: { workerId, endedAt: null }, orderBy: { startedAt: 'desc' }, select: { locationId: true, location: { select: { name: true } } } }),
    db.robotMaintenance.findFirst({ where: { workerId, nextDueOn: { lte: now } }, orderBy: { nextDueOn: 'asc' }, select: { kind: true, nextDueOn: true } }),
  ]);
  const battery = latest?.batteryPct ?? null;

  if (placement) {
    const commissioning = await db.robotCommissioning.findUnique({ where: { workerId_locationId: { workerId, locationId: placement.locationId } }, select: { signedOffAt: true } });
    if (!commissioning?.signedOffAt) return { available: false, note: `Not commissioned at ${placement.location.name}`, batteryPct: battery };
  }
  if (maintenance) return { available: false, note: `Maintenance due: ${maintenance.kind}`, batteryPct: battery };

  if (!latest) return { available: true, note: 'Running (no fleet reading yet)', batteryPct: null };
  const ageMs = now.getTime() - latest.at.getTime();
  if (ageMs > STALE_READING_MS) return { available: false, note: `No reading for ${Math.round(ageMs / 60_000)} min`, batteryPct: battery };
  const pct = battery === null ? '' : ` (${battery}%)`;
  switch (latest.status) {
    case 'OFFLINE':
      return { available: false, note: 'Offline', batteryPct: battery };
    case 'ERROR':
      return { available: false, note: `Error${latest.errorCode ? ` ${latest.errorCode}` : ''}`, batteryPct: battery };
    case 'STOPPED':
      return { available: false, note: 'Stopped', batteryPct: battery };
    case 'CHARGING':
      if (battery !== null && battery < LOW_BATTERY_PCT) return { available: false, note: `Charging${pct}`, batteryPct: battery };
      return { available: true, note: `Charging${pct}`, batteryPct: battery };
    case 'WORKING':
      return { available: true, note: `Working${pct}`, batteryPct: battery };
    default:
      return { available: true, note: `Idle${pct}`, batteryPct: battery };
  }
}
