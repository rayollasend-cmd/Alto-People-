import { prisma } from '../db.js';
import { env } from '../config/env.js';

/**
 * What the vans cost — one reckoning for Costs, the eight-week trends and
 * the ops board's cost per ride (routes/transportOps /costs, /trends,
 * lib/transportKpis):
 *
 *   driver   a completed run's hours (started → ended; two hours when the
 *            clock is missing) at the driver's hourly rate — their open
 *            HOURLY compensation record, else the default associate rate
 *   van      fuel and upkeep from the service log, on the day spent
 */

/** A run's hours on the clock; two when it never recorded both ends. */
export function runHours(run: { startedAt: Date | null; endedAt: Date | null }): number {
  return run.startedAt && run.endedAt ? (run.endedAt.getTime() - run.startedAt.getTime()) / 3_600_000 : 2;
}

/** Each driver's hourly rate in dollars, in one read. */
export async function driverHourlyRates(driverUserIds: string[]): Promise<Map<string, number>> {
  const ids = [...new Set(driverUserIds)];
  const drivers = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, associateId: true } }) : [];
  const assocIds = drivers.map((d) => d.associateId).filter((x): x is string => !!x);
  const comps = assocIds.length
    ? await prisma.compensationRecord.findMany({
        where: { associateId: { in: assocIds }, payType: 'HOURLY', effectiveTo: null },
        orderBy: { effectiveFrom: 'desc' },
        select: { associateId: true, amount: true },
      })
    : [];
  const rateByAssoc = new Map<string, number>();
  for (const c of comps) if (!rateByAssoc.has(c.associateId)) rateByAssoc.set(c.associateId, Number(c.amount));
  const out = new Map<string, number>();
  for (const id of ids) {
    const d = drivers.find((x) => x.id === id);
    out.set(id, (d?.associateId && rateByAssoc.get(d.associateId)) || env.DEFAULT_ASSOCIATE_PAY_RATE);
  }
  return out;
}

/** The driver side of one run, in cents. */
export function runDriverCents(run: { driverUserId: string; startedAt: Date | null; endedAt: Date | null }, rates: Map<string, number>): number {
  return Math.round(runHours(run) * (rates.get(run.driverUserId) ?? env.DEFAULT_ASSOCIATE_PAY_RATE) * 100);
}
