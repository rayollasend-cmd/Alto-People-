import type { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { hasCapability } from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';

/**
 * Which clients a driver picks up for.
 *
 * A driver asks for all clients or the ones they want; the Transportation
 * Director approves or denies; the driver then sees seat requests from
 * approved clients only — and can only accept, decline or open the map for
 * those. A null client on a row means "all clients". Drivers who were
 * driving before this existed were granted all clients by the migration.
 */

export interface DriverAccess {
  all: boolean;
  clientIds: Set<string>;
  pending: number;
}

type Db = Prisma.TransactionClient | typeof prisma;

export async function driverAccessFor(driverUserId: string, db: Db = prisma): Promise<DriverAccess> {
  const rows = await db.driverClientAccess.findMany({
    where: { driverUserId },
    select: { clientId: true, status: true },
  });
  return {
    all: rows.some((r) => r.clientId === null && r.status === 'APPROVED'),
    clientIds: new Set(rows.filter((r) => r.clientId !== null && r.status === 'APPROVED').map((r) => r.clientId!)),
    pending: rows.filter((r) => r.status === 'REQUESTED').length,
  };
}

/** The rides a driver may see — nothing at all while they drive for nobody. */
export function ridesForAccess(a: DriverAccess): Prisma.RideWhereInput {
  if (a.all) return {};
  if (a.clientIds.size === 0) return { id: { in: [] } };
  return { location: { clientId: { in: [...a.clientIds] } } };
}

export function mayServe(a: DriverAccess, clientId: string): boolean {
  return a.all || a.clientIds.has(clientId);
}

/**
 * 403 unless this driver is approved for the client. The director's own
 * word is never gated — dispatch overrides the drivers, and so does this.
 */
export async function assertDriverMayServe(req: Request, clientId: string): Promise<void> {
  const user = req.user!;
  if (hasCapability(user.role, 'manage:transport')) return;
  if (!mayServe(await driverAccessFor(user.id), clientId)) {
    throw new HttpError(
      403,
      'client_not_approved',
      'You don’t drive for this client yet — ask transportation to approve it under Clients I drive for.',
    );
  }
}

/** The User filter for drivers approved for a client (the all-declined check). */
export function approvedForClient(clientId: string): Prisma.UserWhereInput {
  return {
    driverClientAccess: { some: { status: 'APPROVED', OR: [{ clientId: null }, { clientId }] } },
  };
}
