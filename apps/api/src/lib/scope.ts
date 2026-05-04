import type { Prisma, PrismaClient, Application } from '@prisma/client';
import type { SessionUser } from '../types/express.js';
import { HttpError } from '../middleware/error.js';

type Tx = Prisma.TransactionClient | PrismaClient;

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

export function scopeBackgroundChecks(user: SessionUser): Prisma.BackgroundCheckWhereInput {
  if (user.role === 'CLIENT_PORTAL' && user.clientId) {
    return { clientId: user.clientId };
  }
  return {};
}

export function scopeDocuments(user: SessionUser): Prisma.DocumentRecordWhereInput {
  const base: Prisma.DocumentRecordWhereInput = { deletedAt: null };
  if (user.role === 'ASSOCIATE' && user.associateId) {
    return { ...base, associateId: user.associateId };
  }
  if (user.role === 'CLIENT_PORTAL' && user.clientId) {
    return { ...base, clientId: user.clientId };
  }
  return base;
}

export function scopePayrollRuns(user: SessionUser): Prisma.PayrollRunWhereInput {
  // CLIENT_PORTAL only ever sees runs for its own client (although it lacks
  // view:payroll today; defense in depth for when finance roles are added).
  if (user.role === 'CLIENT_PORTAL' && user.clientId) {
    return { clientId: user.clientId };
  }
  // ASSOCIATE doesn't list runs — they hit /payroll/me/items instead.
  return {};
}

export function scopePayrollSchedules(user: SessionUser): Prisma.PayrollScheduleWhereInput {
  // Wave 1.1 — Pay schedules are managed by HR/finance. CLIENT_PORTAL only
  // ever sees schedules for its own client (plus org-wide nulls); other
  // privileged roles see everything not soft-deleted.
  const base: Prisma.PayrollScheduleWhereInput = { deletedAt: null };
  if (user.role === 'CLIENT_PORTAL' && user.clientId) {
    return { ...base, OR: [{ clientId: null }, { clientId: user.clientId }] };
  }
  return base;
}

export function scopeShifts(user: SessionUser): Prisma.ShiftWhereInput {
  // ASSOCIATE only ever sees shifts assigned to them — and only after
  // they're published. DRAFT shifts are the manager's in-progress
  // schedule; surfacing them to associates would leak edits-in-progress
  // and break the Sling/Deputy convention every workforce-management
  // product ships. `publishedAt` is stamped the first time a shift
  // transitions out of DRAFT, so non-null = "the manager has shown this
  // to people."
  if (user.role === 'ASSOCIATE' && user.associateId) {
    return {
      assignedAssociateId: user.associateId,
      publishedAt: { not: null },
    };
  }
  // CLIENT_PORTAL is restricted to its own client's shifts.
  if (user.role === 'CLIENT_PORTAL' && user.clientId) {
    return { clientId: user.clientId };
  }
  return {};
}

export function scopeTimeEntries(user: SessionUser): Prisma.TimeEntryWhereInput {
  // ASSOCIATE only ever sees their own entries (defense-in-depth on top of
  // the route-level /me vs /admin split). HR/Ops see all.
  if (user.role === 'ASSOCIATE' && user.associateId) {
    return { associateId: user.associateId };
  }
  // CLIENT_PORTAL doesn't have view:time so it shouldn't reach here, but if
  // it ever does, scope to its own client's entries via denormalized clientId.
  if (user.role === 'CLIENT_PORTAL' && user.clientId) {
    return { clientId: user.clientId };
  }
  return {};
}

/**
 * Resolves the effective `clientId` filter for a list endpoint that's
 * reachable by tenant-bounded roles. CLIENT_PORTAL and ASSOCIATE are
 * always clamped to their own `clientId` — anything they pass in the
 * query is ignored. FULL_ADMIN holders pass through whatever was
 * requested (their cross-client access is by design).
 *
 * Returns:
 *   - a uuid string  → "filter to this client (plus globals if the
 *                       caller's where uses OR clientId IS NULL)"
 *   - null           → caller is tenant-bounded but has no clientId
 *                      on file → only company-wide rows are visible
 *   - undefined      → admin caller with no filter requested → no
 *                      clientId restriction
 */
export function effectiveClientIdFilter(
  user: SessionUser,
  requested: string | undefined,
): string | null | undefined {
  if (user.role === 'CLIENT_PORTAL' || user.role === 'ASSOCIATE') {
    return user.clientId ?? null;
  }
  return requested;
}

/**
 * Loads an application the caller is allowed to modify, or throws 404.
 * Use 404 (not 403) so existence isn't leaked across tenants.
 *
 * Defense-in-depth: even though `scopeApplications` already filters
 * Associates to their own application, we re-check here so a future
 * scope-helper bug doesn't become a write leak.
 */
export async function assertCanModifyApplication(
  tx: Tx,
  user: SessionUser,
  applicationId: string
): Promise<Application> {
  const app = await tx.application.findFirst({
    where: { ...scopeApplications(user), id: applicationId },
  });
  if (!app) {
    throw new HttpError(404, 'application_not_found', 'Application not found');
  }
  if (
    user.role === 'ASSOCIATE' &&
    app.associateId !== user.associateId
  ) {
    throw new HttpError(404, 'application_not_found', 'Application not found');
  }
  return app;
}
