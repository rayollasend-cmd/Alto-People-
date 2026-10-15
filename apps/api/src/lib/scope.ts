import type { Prisma, PrismaClient, Application } from '@prisma/client';
import { can } from '@alto-people/shared';
import type { SessionUser } from '../types/express.js';
import { HttpError } from '../middleware/error.js';
import { tenantIdForWrite } from './tenant.js';

type Tx = Prisma.TransactionClient | PrismaClient;

// A client id that cannot exist, used to fail a client-scoped role CLOSED
// when it has no clientId on file — so a mis-provisioned SHIFT_SUPERVISOR
// (who holds manage caps) sees nothing rather than everything.
const NO_CLIENT = '00000000-0000-0000-0000-000000000000';

/**
 * Brief 2-1b, step 3 — what a client-bounded account stands on: its tenant,
 * then its client or, with no client, its site. With neither it stands on
 * nothing and every scope resolves to no rows. Written against the
 * guardrail test (scopeFailClosed.test.ts) first: once Client is optional,
 * rows with no client exist, and a filter must never fall open onto them,
 * nor onto another tenant's rows.
 */
interface Bounds {
  tenantId: string;
  clientId: string | null;
  locationId: string | null;
  /** Brief 2-1b step 5: pinned to an organizational unit — every site under it. */
  orgUnitPath: string | null;
}

function boundsOf(user: SessionUser): Bounds | null {
  if (!user.tenantId) return null;
  if (user.clientId) return { tenantId: user.tenantId, clientId: user.clientId, locationId: user.locationId ?? null, orgUnitPath: null };
  if (user.locationId) return { tenantId: user.tenantId, clientId: null, locationId: user.locationId, orgUnitPath: null };
  if (user.orgUnitPath) return { tenantId: user.tenantId, clientId: null, locationId: null, orgUnitPath: user.orgUnitPath };
  return null;
}

/** The sites a site-only or unit-only account stands on: one store, or every store under the unit. */
function siteFilter(b: Bounds): Prisma.SiteWhereInput {
  if (b.locationId) return { id: b.locationId };
  return { orgUnit: { is: { path: { startsWith: b.orgUnitPath ?? NO_CLIENT }, deletedAt: null } } };
}

/** People placed at those sites. */
function atSites(b: Bounds): Prisma.AssociateWhereInput {
  return { assignments: { some: { endedAt: null, location: { is: siteFilter(b) } } } };
}

/** The three roles that are bounded to a client (or a site). */
function isBounded(user: SessionUser): boolean {
  return user.role === 'CLIENT_PORTAL' || user.role === 'SHIFT_SUPERVISOR' || user.role === 'FLOOR_SUPERVISOR';
}

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
  if (isBounded(user)) {
    const b = boundsOf(user);
    // A site-only account has no client to list.
    return b?.clientId ? { ...base, tenantId: b.tenantId, id: b.clientId } : { ...base, id: NO_CLIENT };
  }
  return base;
}

export function scopeApplications(
  user: SessionUser
): Prisma.ApplicationWhereInput {
  const base: Prisma.ApplicationWhereInput = { deletedAt: null };
  if (user.role === 'ASSOCIATE' && user.associateId) {
    return { ...base, associateId: user.associateId };
  }
  if (isBounded(user)) {
    const b = boundsOf(user);
    if (!b) return { ...base, clientId: NO_CLIENT };
    if (b.clientId) return { ...base, tenantId: b.tenantId, clientId: b.clientId };
    return { ...base, tenantId: b.tenantId, location: { is: siteFilter(b) } };
  }
  return base;
}

export function scopeTemplates(
  user: SessionUser
): Prisma.OnboardingTemplateWhereInput {
  if (user.role === 'CLIENT_PORTAL') {
    // Org-wide templates plus the client's own; a site-only account gets the org-wide ones.
    return { OR: [{ clientId: null }, { clientId: boundsOf(user)?.clientId ?? NO_CLIENT }] };
  }
  return {};
}

export function scopeBackgroundChecks(user: SessionUser): Prisma.BackgroundCheckWhereInput {
  if (user.role === 'CLIENT_PORTAL') {
    const b = boundsOf(user);
    return b?.clientId ? { tenantId: b.tenantId, clientId: b.clientId } : { clientId: NO_CLIENT };
  }
  return {};
}

export function scopeDrugTests(user: SessionUser): Prisma.DrugTestWhereInput {
  if (user.role === 'CLIENT_PORTAL') {
    const b = boundsOf(user);
    return b?.clientId ? { tenantId: b.tenantId, clientId: b.clientId } : { clientId: NO_CLIENT };
  }
  return {};
}

export function scopeDocuments(user: SessionUser): Prisma.DocumentRecordWhereInput {
  const base: Prisma.DocumentRecordWhereInput = { deletedAt: null };
  if (user.role === 'ASSOCIATE' && user.associateId) {
    return { ...base, associateId: user.associateId };
  }
  if (isBounded(user)) {
    const b = boundsOf(user);
    if (!b) return { ...base, clientId: NO_CLIENT };
    if (b.clientId) return { ...base, tenantId: b.tenantId, clientId: b.clientId };
    // A site-only account sees the documents of the people at its site.
    return { ...base, tenantId: b.tenantId, associate: { is: atSites(b) } };
  }
  return base;
}

export function scopePayrollRuns(user: SessionUser): Prisma.PayrollRunWhereInput {
  if (isBounded(user)) {
    const b = boundsOf(user);
    return b?.clientId ? { tenantId: b.tenantId, clientId: b.clientId } : { clientId: NO_CLIENT };
  }
  return {};
}

export function scopePayrollSchedules(user: SessionUser): Prisma.PayrollScheduleWhereInput {
  const base: Prisma.PayrollScheduleWhereInput = { deletedAt: null };
  if (user.role === 'CLIENT_PORTAL') {
    return { ...base, OR: [{ clientId: null }, { clientId: boundsOf(user)?.clientId ?? NO_CLIENT }] };
  }
  return base;
}

export function scopeShifts(user: SessionUser): Prisma.ShiftWhereInput {
  if (user.role === 'ASSOCIATE' && user.associateId) {
    return {
      assignedAssociateId: user.associateId,
      publishedAt: { not: null },
    };
  }
  if (isBounded(user)) {
    const b = boundsOf(user);
    if (!b) return { clientId: NO_CLIENT };
    if (b.clientId) {
      // A portal account pinned to a store sees that store; a supervisor sees the client.
      return { tenantId: b.tenantId, clientId: b.clientId, ...(user.role === 'CLIENT_PORTAL' && b.locationId ? { locationId: b.locationId } : {}) };
    }
    return { tenantId: b.tenantId, locationRel: { is: siteFilter(b) } };
  }
  return {};
}

/**
 * Associates that belong to a client (the roster: scheduling, time, the
 * supervisor's and the portal's views): see atClient — an open assignment
 * there, else (no open assignment anywhere) an APPROVED application there.
 */
export function associatesOfClient(clientId: string): Prisma.AssociateWhereInput {
  return atClient(clientId, { approvedOnly: true });
}

/**
 * "This client's people" — ONE answer, the same one
 * lib/associateClients.primaryClientsForAssociates gives:
 *
 *   1. an OPEN assignment places them — where they work today;
 *   2. only someone with NO open assignment anywhere falls back to their
 *      application at the client (approved, or — for the directory,
 *      which lists people still onboarding — any live application).
 *
 * It used to be "an approved application OR an open assignment", so a
 * cross-client transfer (which moves the assignment; the approved
 * application stays filed under the old client) left the associate at
 * BOTH clients: still on the old store's roster and schedule, and missing
 * from every application-keyed count and filter at the new one.
 */
export function atClient(
  clientId: string,
  opts: { approvedOnly?: boolean } = {},
): Prisma.AssociateWhereInput {
  return {
    OR: [
      { assignments: { some: { endedAt: null, location: { clientId } } } },
      {
        AND: [
          {
            applications: {
              some: {
                clientId,
                deletedAt: null,
                ...(opts.approvedOnly ? { status: 'APPROVED' as const } : {}),
              },
            },
          },
          { assignments: { none: { endedAt: null } } },
        ],
      },
    ],
  };
}

/**
 * "This store's people" — the same rule as atClient, one level down.
 *
 * An account pinned to a store (User.locationId) must never resolve a
 * person who works at a sibling store, in any surface: the portal, the
 * report builder, an export. Placement is the open assignment; there is
 * no application fallback, because an application names a client, not a
 * building, and guessing would put the whole client back in view.
 */
export function atStore(locationId: string): Prisma.AssociateWhereInput {
  return { assignments: { some: { endedAt: null, locationId } } };
}

/**
 * "Placed at this site" — atClient's two branches, one level down, for a
 * site that names no client (a direct employer's property). The open
 * assignment at the site; or, for someone with no open assignment
 * anywhere, an approved application that names the site. Never wider.
 */
export function placedAtSite(locationId: string, opts: { approvedOnly?: boolean } = {}): Prisma.AssociateWhereInput {
  return {
    OR: [
      { assignments: { some: { endedAt: null, locationId } } },
      {
        AND: [
          { applications: { some: { locationId, deletedAt: null, ...(opts.approvedOnly ? { status: 'APPROVED' as const } : {}) } } },
          { assignments: { none: { endedAt: null } } },
        ],
      },
    ],
  };
}

/**
 * The bench a shift may be offered to: the client's people when the shift
 * names a client, the site's people when it names only a site, and nobody
 * (null) when it names neither — fail closed, never the whole tenant.
 */
export function benchFor(shift: { clientId: string | null; locationId: string | null }): Prisma.AssociateWhereInput | null {
  if (shift.clientId) return atClient(shift.clientId, { approvedOnly: true });
  if (shift.locationId) return placedAtSite(shift.locationId, { approvedOnly: true });
  return null;
}

/**
 * Associates visible to this caller. CLIENT_PORTAL and SHIFT_SUPERVISOR
 * are clamped to their own client's roster (fail closed when the client
 * is unset); an ASSOCIATE only ever resolves to themselves.
 */
export function scopeAssociates(user: SessionUser): Prisma.AssociateWhereInput {
  if (user.role === 'ASSOCIATE') {
    return { id: user.associateId ?? NO_CLIENT };
  }
  if (isBounded(user)) {
    const b = boundsOf(user);
    if (!b) return { id: NO_CLIENT };
    if (!b.clientId) return { tenantId: b.tenantId, ...atSites(b) };
    if (user.role === 'CLIENT_PORTAL' && b.locationId) return { tenantId: b.tenantId, ...atStore(b.locationId) };
    return { tenantId: b.tenantId, ...associatesOfClient(b.clientId) };
  }
  return {};
}

/**
 * Payroll items for the caller's tenant. Items carry no clientId of their
 * own, so we reach through the run.
 */
export function scopePayrollItems(user: SessionUser): Prisma.PayrollItemWhereInput {
  if (user.role === 'ASSOCIATE') {
    return { associateId: user.associateId ?? NO_CLIENT };
  }
  if (isBounded(user)) {
    const b = boundsOf(user);
    // Pay is a client's matter; a site-only account sees none of it.
    return b?.clientId ? { payrollRun: { is: { tenantId: b.tenantId, clientId: b.clientId } } } : { payrollRun: { is: { clientId: NO_CLIENT } } };
  }
  return {};
}

/**
 * The recruiting pipeline is org-wide — a Candidate has no owning client
 * until they're hired. There is no correct tenant slice, so tenant-bounded
 * roles get nothing rather than everything.
 */
export function scopeCandidates(user: SessionUser): Prisma.CandidateWhereInput {
  if (
    user.role === 'CLIENT_PORTAL' ||
    user.role === 'SHIFT_SUPERVISOR' ||
    user.role === 'ASSOCIATE'
  ) {
    return { id: NO_CLIENT };
  }
  return {};
}

export function scopeTimeOffRequests(
  user: SessionUser,
): Prisma.TimeOffRequestWhereInput {
  if (user.role === 'ASSOCIATE' && user.associateId) {
    return { associateId: user.associateId };
  }
  // A bounded account sees only requests from its own client's (or site's)
  // people, and nothing when it has neither. Without this, a supervisor
  // could read and decide PTO org-wide.
  if (isBounded(user)) {
    const b = boundsOf(user);
    if (!b) return { associateId: NO_CLIENT };
    if (!b.clientId) return { associate: { is: { tenantId: b.tenantId, ...atSites(b) } } };
    return { associate: { is: { tenantId: b.tenantId, ...associatesOfClient(b.clientId) } } };
  }
  return {};
}

export function scopeTimeEntries(user: SessionUser): Prisma.TimeEntryWhereInput {
  if (user.role === 'ASSOCIATE' && user.associateId) {
    return { associateId: user.associateId };
  }
  if (isBounded(user)) {
    const b = boundsOf(user);
    if (!b) return { clientId: NO_CLIENT };
    const atSite = (sites: Prisma.SiteWhereInput): Prisma.TimeEntryWhereInput => ({
      OR: [{ location: { is: sites } }, { shift: { is: { locationRel: { is: sites } } } }],
    });
    if (b.clientId) {
      return user.role === 'CLIENT_PORTAL' && b.locationId
        ? { tenantId: b.tenantId, clientId: b.clientId, ...atSite({ id: b.locationId }) }
        : { tenantId: b.tenantId, clientId: b.clientId };
    }
    return { tenantId: b.tenantId, ...atSite(siteFilter(b)) };
  }
  return {};
}

/** The roles clamped to a single client. */
export function isClientBoundedRole(user: SessionUser): boolean {
  return (
    user.role === 'CLIENT_PORTAL' ||
    user.role === 'SHIFT_SUPERVISOR' ||
    user.role === 'FLOOR_SUPERVISOR' ||
    user.role === 'ASSOCIATE'
  );
}

/**
 * The qualification catalog a caller may READ.
 *
 * A Qualification with a null clientId is GLOBAL — every client's shifts
 * and rosters draw on it — so a client-bounded caller sees their own
 * client's plus the globals.
 */
export function scopeQualifications(user: SessionUser): Prisma.QualificationWhereInput {
  if (isClientBoundedRole(user)) {
    return { OR: [{ clientId: null }, { clientId: boundsOf(user)?.clientId ?? NO_CLIENT }] };
  }
  return {};
}

/**
 * The qualification catalog a caller may EDIT — deliberately narrower
 * than what they may read.
 *
 * Reading a global qualification is how a supervisor attaches "Forklift
 * certified" to their own shift. EDITING one is an org-wide act: renaming
 * it renames it everywhere, and soft-deleting it drops the requirement
 * from every client's shifts at once and silently widens who may claim
 * them. So a client-bounded caller may only write rows their own client
 * owns — never a global, never another client's.
 */
export function scopeQualificationWrites(
  user: SessionUser,
): Prisma.QualificationWhereInput {
  if (isClientBoundedRole(user)) {
    const b = boundsOf(user);
    return b?.clientId ? { tenantId: b.tenantId, clientId: b.clientId } : { clientId: NO_CLIENT };
  }
  return {};
}

/**
 * The client this write is about had better be one the caller owns.
 *
 * For a row that hangs off a client — a Job, a Project, a rate card — the
 * capability says whether the caller may manage that KIND of thing, and
 * this says whose. 404 rather than 403, so an id from another tenant is
 * indistinguishable from one that does not exist.
 *
 * `AND` rather than a spread: several scope helpers return an `id`
 * constraint of their own, and two `id` keys in one object literal means
 * one silently wins.
 */
export async function assertClientInScope(
  tx: Tx,
  user: SessionUser,
  clientId: string,
): Promise<void> {
  const found = await tx.client.findFirst({
    where: { AND: [{ id: clientId }, scopeClients(user)] },
    select: { id: true },
  });
  if (!found) throw new HttpError(404, 'client_not_found', 'Client not found');
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
  if (
    user.role === 'CLIENT_PORTAL' ||
    user.role === 'ASSOCIATE' ||
    user.role === 'SHIFT_SUPERVISOR' ||
    user.role === 'FLOOR_SUPERVISOR'
  ) {
    return user.clientId ?? null;
  }
  return requested;
}

/**
 * What the caller is reaching for. Drives the PII gate below.
 *
 *  - 'applicant-record' (default) — the personal record behind the
 *    application: profile/DOB/address, W-4 + SSN last-4, I-9 Section 1,
 *    uploaded identity documents, signed agreements. Restricted to the
 *    applicant themselves and holders of manage:onboarding.
 *  - 'invite' — the delivery mechanics only (send/resend an invite, nudge
 *    a stalled applicant). No personal data is returned, so invite-only
 *    roles are allowed through.
 */
export type ApplicationAccessIntent = 'applicant-record' | 'invite';

/**
 * Loads an application the caller is allowed to modify, or throws.
 * Use 404 (not 403) for scope misses so existence isn't leaked across
 * tenants; 403 once scope passes but the capability doesn't, since at
 * that point the caller already knows the record exists.
 *
 * Defense-in-depth: even though `scopeApplications` already filters
 * Associates to their own application, we re-check here so a future
 * scope-helper bug doesn't become a write leak.
 *
 * The PII gate defaults to the strict intent so a route added later
 * inherits the safe behavior without having to know this rule exists.
 * Scope alone is not enough: SHIFT_SUPERVISOR is client-bounded and may
 * legitimately watch an application's *progress*, but must never read or
 * write the identity documents behind it — untrained review of I-9
 * documents carries INA §274B document-abuse exposure.
 */
export async function assertCanModifyApplication(
  tx: Tx,
  user: SessionUser,
  applicationId: string,
  opts: { intent?: ApplicationAccessIntent; write?: boolean } = {}
): Promise<Application> {
  // Explicit tenant (Brief 2-1, cross-tenant suite): the guard only observes until enforce mode.
  const app = await tx.application.findFirst({
    where: { ...scopeApplications(user), id: applicationId, tenantId: tenantIdForWrite() },
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
  const intent = opts.intent ?? 'applicant-record';
  if (
    intent === 'applicant-record' &&
    !(user.associateId && app.associateId === user.associateId) &&
    !can(user, 'manage:onboarding')
  ) {
    throw new HttpError(
      403,
      'forbidden',
      'Missing capability: manage:onboarding'
    );
  }
  // Approval is the edit boundary. Until HR settles the application the
  // applicant may freely revise what they entered (the forms re-open from
  // the checklist); once APPROVED/REJECTED the record is what HR signed
  // off on, and only manage:onboarding may correct it. Reads are never
  // blocked — pass write: true only on mutating routes.
  if (
    opts.write &&
    (app.status === 'APPROVED' || app.status === 'REJECTED' || app.status === 'CANCELLED') &&
    !can(user, 'manage:onboarding')
  ) {
    throw new HttpError(
      409,
      'application_locked',
      'This application has been finalized by HR and can no longer be changed. Contact HR to request a correction.'
    );
  }
  return app;
}
