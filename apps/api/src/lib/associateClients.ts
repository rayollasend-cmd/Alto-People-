import { prisma } from '../db.js';

export interface AssociateClientRef {
  clientId: string;
  clientName: string;
}

/**
 * Resolve each associate's PRIMARY client, for labeling and filtering the
 * compliance ledgers (background checks, drug tests, I-9, E-Verify) by
 * client. These ledgers are associate-driven and mostly carry no clientId
 * of their own, so "which client is this person's?" has to come from
 * employment:
 *
 *   1. an OPEN AssociateAssignment — where they work today — wins;
 *   2. else the most recently approved application's client.
 *
 * Mirrors `associatesOfClient` in lib/scope.ts (the definition of "your
 * client's people" used by scheduling and time) so the compliance filter
 * never disagrees with the roster. Associates with neither (mid-onboarding
 * with an undecided application) simply have no entry — the UI shows them
 * under "no client on record".
 *
 * Two bounded queries regardless of list size; call once per request with
 * the page's associateIds, never per row.
 */
export async function primaryClientsForAssociates(
  associateIds: string[],
): Promise<Map<string, AssociateClientRef>> {
  const out = new Map<string, AssociateClientRef>();
  const ids = [...new Set(associateIds)];
  if (ids.length === 0) return out;

  const approved = await prisma.application.findMany({
    where: { associateId: { in: ids }, status: 'APPROVED', deletedAt: null },
    orderBy: { approvedAt: 'desc' },
    select: {
      associateId: true,
      client: { select: { id: true, name: true } },
    },
    take: 2000,
  });
  // Rows arrive newest-approval-first; first occurrence per associate wins.
  for (const a of approved) {
    if (!out.has(a.associateId)) {
      out.set(a.associateId, { clientId: a.client.id, clientName: a.client.name });
    }
  }

  const assignments = await prisma.associateAssignment.findMany({
    where: { associateId: { in: ids }, endedAt: null },
    select: {
      associateId: true,
      location: { select: { client: { select: { id: true, name: true } } } },
    },
    take: 2000,
  });
  // Open assignment overrides the application-derived client — a transfer
  // moves someone's "current client" even though the original application
  // stays approved under the old one.
  for (const a of assignments) {
    out.set(a.associateId, {
      clientId: a.location.client.id,
      clientName: a.location.client.name,
    });
  }

  return out;
}

/** Names for a set of client ids — for rows that carry their own clientId. */
export async function clientNamesById(
  clientIds: Array<string | null | undefined>,
): Promise<Map<string, string>> {
  const ids = [...new Set(clientIds.filter((c): c is string => !!c))];
  if (ids.length === 0) return new Map();
  const rows = await prisma.client.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true },
  });
  return new Map(rows.map((r) => [r.id, r.name]));
}

/**
 * Active associates per client, for the client list — placed by the same
 * rule as primaryClientsForAssociates: an open assignment's client, else
 * (no open assignment) the newest approved application's. Active = not
 * separated, deactivated or erased.
 *
 * It used to count APPROVED applications filed under each client, so a
 * cross-client transfer (the assignment moves; the application stays) was
 * counted at the old client forever and never at the new one — and
 * separated people kept counting too. Two bounded reads regardless of the
 * number of clients.
 */
export async function activeAssociateCountsByClient(
  clientIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const ids = [...new Set(clientIds)];
  if (ids.length === 0) return out;
  const rows = await prisma.associate.findMany({
    where: {
      deletedAt: null,
      separatedAt: null,
      deactivatedAt: null,
      OR: [
        { assignments: { some: { endedAt: null, location: { clientId: { in: ids } } } } },
        {
          applications: { some: { status: 'APPROVED', deletedAt: null, clientId: { in: ids } } },
          assignments: { none: { endedAt: null } },
        },
      ],
    },
    select: {
      assignments: {
        where: { endedAt: null },
        orderBy: { startedAt: 'desc' },
        take: 1,
        select: { location: { select: { clientId: true } } },
      },
      applications: {
        where: { status: 'APPROVED', deletedAt: null },
        orderBy: { approvedAt: 'desc' },
        take: 1,
        select: { clientId: true },
      },
    },
  });
  const wanted = new Set(ids);
  for (const r of rows) {
    const clientId = r.assignments[0]?.location.clientId ?? r.applications[0]?.clientId ?? null;
    if (clientId && wanted.has(clientId)) out.set(clientId, (out.get(clientId) ?? 0) + 1);
  }
  return out;
}
