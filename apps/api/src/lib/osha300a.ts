import type { Prisma, PrismaClient } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

export interface Osha300aSummary {
  clientId: string;
  year: number;
  totalCases: number;
  fatalities: number;
  daysAwayCases: number;
  restrictedCases: number;
  otherRecordable: number;
  totalDaysAway: number;
  totalDaysRestricted: number;
}

/**
 * OSHA Form 300A annual summary aggregates for one client and calendar
 * year: the counts employers post by Feb 1 covering the prior year. One
 * copy for the 300A route and the Compliance agent's incident.loop.
 */
export async function osha300aSummary(db: Db, clientId: string, year: number): Promise<Osha300aSummary> {
  const start = new Date(`${year}-01-01T00:00:00Z`);
  const end = new Date(`${year + 1}-01-01T00:00:00Z`);
  const rows = await db.oshaIncident.findMany({
    take: 500,
    where: { clientId, occurredAt: { gte: start, lt: end }, isRecordable: true },
    select: { severity: true, daysAway: true, daysRestricted: true },
  });
  return {
    clientId,
    year,
    totalCases: rows.length,
    fatalities: rows.filter((r) => r.severity === 'FATAL').length,
    daysAwayCases: rows.filter((r) => r.severity === 'DAYS_AWAY').length,
    restrictedCases: rows.filter((r) => r.severity === 'RESTRICTED_DUTY').length,
    // First-aid-only cases are excluded via isRecordable (default false for
    // FIRST_AID); any explicitly-marked-recordable leftovers bucket under
    // "other recordable" per the form's categories.
    otherRecordable: rows.filter((r) => r.severity === 'MEDICAL_TREATMENT' || r.severity === 'FIRST_AID').length,
    totalDaysAway: rows.reduce((s, r) => s + r.daysAway, 0),
    totalDaysRestricted: rows.reduce((s, r) => s + r.daysRestricted, 0),
  };
}

/** The year so far, in one line for a desk item. */
export function osha300aLine(s: Osha300aSummary): string {
  return `${s.year} so far: ${s.totalCases} recordable case${s.totalCases === 1 ? '' : 's'}, ${s.daysAwayCases} with days away (${s.totalDaysAway} days), ${s.restrictedCases} restricted (${s.totalDaysRestricted} days), ${s.fatalities} fatal.`;
}
