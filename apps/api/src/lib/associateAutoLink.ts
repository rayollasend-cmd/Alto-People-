import { prisma } from '../db.js';
import { enqueueAudit } from './audit.js';

/**
 * Heal an ASSOCIATE login that has no linked Associate row by matching on
 * email.
 *
 * Why this exists: `User.associateId` is the only bridge between a login
 * and an employment record — every /me surface (schedule, time, paystubs)
 * silently shows NOTHING when it's null. The invite flow always sets it,
 * but SCIM-provisioned logins never did, and CSV-migrated associates have
 * no login until one is created some other way. Reported 2026-08-13:
 * supervisors published shifts and the assigned associates saw an empty
 * schedule — their logins simply weren't pointed at their employment rows.
 *
 * Links only when the match is unambiguous:
 *   - exactly ONE non-deleted Associate row matches the email
 *     (case-insensitive), and
 *   - no other login already claims that row (`associateId` is unique —
 *     the claim check includes soft-deleted users, who still hold the
 *     constraint).
 *
 * Anything ambiguous is left alone for a human: auto-linking the wrong
 * person's employment record would leak their schedule and pay.
 *
 * Returns the linked associateId, or null when no unambiguous link exists.
 */
export async function autoLinkAssociateByEmail(user: {
  id: string;
  email: string;
}): Promise<string | null> {
  const matches = await prisma.associate.findMany({
    where: { email: { equals: user.email, mode: 'insensitive' }, deletedAt: null },
    select: { id: true },
    take: 2,
  });
  if (matches.length !== 1) return null;
  const associateId = matches[0].id;

  const claimed = await prisma.user.findFirst({
    where: { associateId },
    select: { id: true },
  });
  if (claimed) return null;

  try {
    await prisma.user.update({
      where: { id: user.id },
      data: { associateId },
    });
  } catch {
    // Unique-violation race — another login claimed the row between the
    // check and the write. Treat as no-link; nothing was changed.
    return null;
  }

  enqueueAudit(
    {
      actorUserId: null,
      clientId: null,
      action: 'auth.associate_autolinked',
      entityType: 'User',
      entityId: user.id,
      metadata: { associateId, email: user.email },
    },
    'autoLinkAssociateByEmail',
  );
  return associateId;
}
