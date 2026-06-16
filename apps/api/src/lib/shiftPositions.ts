import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';

// Default shift-position catalog seeded for every new client (and
// backfilled onto existing clients via migration). Departments crossed
// with the three standard dayparts. Admins edit the list afterward under
// Org → Shift positions, so this is only a starting point.
const DEPARTMENTS = ['F&D', 'GM', 'Produce', 'Meat', 'Bakery', 'Deli'] as const;
const PERIODS = ['Morning', 'Afternoon', 'Overnight'] as const;

export const DEFAULT_SHIFT_POSITIONS: ReadonlyArray<string> = DEPARTMENTS.flatMap(
  (dept) => PERIODS.map((period) => `${dept} ${period} Shift`),
);

/**
 * Seed the default shift-position catalog for a client. Idempotent: skips
 * any name that already exists (active or soft-deleted) so re-running on a
 * client that already has positions is a no-op. sortOrder follows the
 * department × period order above.
 */
export async function seedDefaultShiftPositions(
  clientId: string,
  client: Pick<PrismaClient, 'shiftPosition'> = defaultPrisma,
): Promise<number> {
  const existing = await client.shiftPosition.findMany({
    where: { clientId },
    select: { name: true },
  });
  const have = new Set(existing.map((r) => r.name));
  const toCreate = DEFAULT_SHIFT_POSITIONS.map((name, i) => ({
    clientId,
    name,
    sortOrder: i,
  })).filter((row) => !have.has(row.name));
  if (toCreate.length === 0) return 0;
  await client.shiftPosition.createMany({ data: toCreate });
  return toCreate.length;
}
