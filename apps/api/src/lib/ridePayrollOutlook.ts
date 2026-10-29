import type { PrismaClient } from '@prisma/client';
import { buildPayPreview } from './payPreview.js';
import { rideMinimumWage } from './transport.js';

/**
 * What payroll will actually take for van rides on the rider's coming
 * payday — the Ride page's and Home's "comes out of your pay" must say the
 * same thing the paycheck does (coordinator note after ASSOC-1).
 *
 *   Payroll never takes a fare that would push the check under the minimum
 *   wage (lib/transport planRideCharges). A rider paid AT the minimum wage
 *   (Maria: $15/h in Florida, whose minimum is $15) can't have any fare taken
 *   from pay at all, so "$40 comes out Fri, Oct 30" was a promise payroll
 *   breaks every payday. That case is structural — it holds whatever hours
 *   the period ends with — so it is answered at once. Otherwise, once the
 *   pay preview's window opens (a few days before payday, hours in), the
 *   preview's own read-only plan says what this check takes and what stays
 *   owed. Before that the outcome isn't known yet, and `takeCents` is null.
 */
export interface RidePayrollOutlook {
  /** What payroll takes from the coming check for rides; null while the check's hours aren't in yet. */
  takeCents: number | null;
  /** Owed through the coming check's period that stays owed after that payday. */
  keptCents: number;
  /** Why it stays owed: paid at the minimum wage, or this check is too small above it. */
  reason: 'MINIMUM_WAGE' | 'CHECK_TOO_SMALL' | null;
  minimumWageCents: number;
  /** The state whose minimum wage applies. */
  state: string;
}

export async function ridePayrollOutlook(
  db: PrismaClient,
  associateId: string,
  periodEnd: string,
  now: Date = new Date(),
): Promise<RidePayrollOutlook | null> {
  // Signed-for, unwaived, not yet taken, ridden on or before the period's last day: what this payday could take.
  const owed = await db.ride.findMany({
    where: { associateId, chargeCents: { gt: 0 }, waivedAt: null, chargedRunId: null, serviceDate: { lte: periodEnd }, authorizedSignatureId: { not: null } },
    select: { chargeCents: true },
  });
  const owedCents = owed.reduce((n, r) => n + r.chargeCents, 0);
  if (owedCents <= 0) return null;
  const [associate, comp] = await Promise.all([
    db.associate.findUnique({ where: { id: associateId }, select: { state: true } }),
    db.compensationRecord.findFirst({ where: { associateId, effectiveTo: null, payType: 'HOURLY' }, orderBy: { effectiveFrom: 'desc' }, select: { amount: true } }),
  ]);
  const floor = rideMinimumWage(associate?.state ?? null);
  const rateCents = comp ? Math.round(Number(comp.amount) * 100) : null;
  if (rateCents !== null && rateCents <= floor.minimumWageCents) {
    return { takeCents: 0, keptCents: owedCents, reason: 'MINIMUM_WAGE', ...floor };
  }
  const preview = await buildPayPreview(db, associateId, now);
  if (!preview.available || preview.source !== 'ESTIMATE' || !preview.rides) {
    return { takeCents: null, keptCents: 0, reason: null, ...floor };
  }
  const takeCents = Math.round(preview.rides.taken * 100);
  const keptCents = Math.round(preview.rides.held * 100);
  return { takeCents, keptCents, reason: keptCents > 0 ? 'CHECK_TOO_SMALL' : null, minimumWageCents: Math.round(preview.rides.minimumWage * 100), state: preview.rides.state };
}
