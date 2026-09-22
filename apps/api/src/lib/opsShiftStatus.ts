import type { Prisma } from '@prisma/client';

/**
 * A CANCELLED ops shift never happened.
 *
 * HR voids one when it was opened by mistake — the afternoon supervisor who
 * picked the morning standard. That shift has no completed checklist and
 * never will, so anything that counts, rates or reports shifts must leave
 * it out: otherwise voiding a mistake creates a permanent 0-of-N failure in
 * the client's own service report, which is the opposite of the point.
 *
 * Queries that filter for a specific status — `status: 'ACTIVE'`,
 * `status: 'CLOSED'` — already exclude it and need nothing. This is for the
 * ones that ask for shifts in general, where "in general" has always meant
 * "shifts that happened".
 *
 * Its own module, and deliberately not in storeShiftSop.ts: the portal and
 * the client-facing reports need it, and they have no business importing a
 * module that pulls in notifications and audit.
 */
export const HAPPENED: Prisma.OpsShiftWhereInput = {
  status: { not: 'CANCELLED' },
};

/** The statuses a caller may ask for by name on a list endpoint. */
export function requestedShiftStatus(
  raw: string | undefined,
): Prisma.OpsShiftWhereInput {
  // CANCELLED is askable — HR reviewing what was voided is a real question —
  // but never a default.
  if (raw === 'ACTIVE' || raw === 'CLOSED' || raw === 'CANCELLED') {
    return { status: raw };
  }
  return HAPPENED;
}
