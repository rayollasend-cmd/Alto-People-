import type { PrismaClient } from '@prisma/client';
import { HttpError } from '../middleware/error.js';

/**
 * Phase 131 — picks the canonical Location for a Client. New Shift /
 * KioskDevice writers use this when the caller didn't pass an explicit
 * `locationId`, so every row ends up tied to a physical site.
 *
 * Returns the oldest active Location under the client (the migration
 * created one per Client 1:1 and that row is "the default"). Throws
 * 400 if the client has no active Locations — HR must add one via the
 * Locations admin section before scheduling can happen there.
 */
export async function firstLocationForClient(
  prisma: PrismaClient,
  clientId: string,
): Promise<{ id: string }> {
  const loc = await prisma.location.findFirst({
    where: { clientId, deletedAt: null, isActive: true },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (!loc) {
    throw new HttpError(
      400,
      'no_location_for_client',
      'Client has no active Location. Add one before creating shifts or devices.',
    );
  }
  return loc;
}
