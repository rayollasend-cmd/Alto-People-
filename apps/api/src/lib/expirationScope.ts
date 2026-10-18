import type { Prisma } from '@prisma/client';
import type { SessionUser } from '../types/express.js';
import { scopeAssociates } from './scope.js';
import { tenantIdForWrite } from './tenant.js';

/**
 * The credentials a caller may see expiring: this tenant's, held by people
 * still employed (a former employee's lapsed forklift card is no one's
 * job), inside the caller's reach (a site-scoped lead sees their sites'
 * people). The Expirations page and its Inbox count share it, so the badge
 * and the page always agree.
 */
export function expiringQualificationsWhere(
  user: SessionUser,
  opts: { isCert?: boolean } = {},
): Prisma.AssociateQualificationWhereInput {
  return {
    AND: [
      { tenantId: tenantIdForWrite(), deletedAt: null, expiresAt: { not: null } },
      { qualification: { deletedAt: null, ...(typeof opts.isCert === 'boolean' ? { isCert: opts.isCert } : {}) } },
      { associate: { AND: [{ tenantId: tenantIdForWrite(), deletedAt: null, deactivatedAt: null }, scopeAssociates(user)] } },
    ],
  };
}
