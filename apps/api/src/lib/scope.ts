import type { Prisma } from '@prisma/client';
import type { SessionUser } from '../types/express.js';

/**
 * Centralized multi-tenant + role scoping for Prisma queries.
 *
 * Every protected route should call the appropriate `scope*` helper
 * to derive its base `where` clause. A forgotten `where` therefore
 * becomes a single-place bug here, not a per-route data leak.
 *
 * Soft-delete filtering (`deletedAt: null`) is included so callers
 * never have to remember it.
 */

export function scopeClients(user: SessionUser): Prisma.ClientWhereInput {
  const base: Prisma.ClientWhereInput = { deletedAt: null };
  if (user.role === 'CLIENT_PORTAL' && user.clientId) {
    return { ...base, id: user.clientId };
  }
  return base;
}

export function scopeApplications(
  user: SessionUser
): Prisma.ApplicationWhereInput {
  const base: Prisma.ApplicationWhereInput = { deletedAt: null };
  if (user.role === 'CLIENT_PORTAL' && user.clientId) {
    return { ...base, clientId: user.clientId };
  }
  if (user.role === 'ASSOCIATE' && user.associateId) {
    return { ...base, associateId: user.associateId };
  }
  return base;
}

export function scopeTemplates(
  user: SessionUser
): Prisma.OnboardingTemplateWhereInput {
  if (user.role === 'CLIENT_PORTAL' && user.clientId) {
    // Client-portal users see global templates and their own client's.
    return { OR: [{ clientId: null }, { clientId: user.clientId }] };
  }
  return {};
}
