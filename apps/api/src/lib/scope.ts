import type { Prisma, PrismaClient, Application } from '@prisma/client';
import { hasCapability } from '@alto-people/shared';
import type { SessionUser } from '../types/express.js';
import { HttpError } from '../middleware/error.js';

type Tx = Prisma.TransactionClient | PrismaClient;

// A client id that cannot exist, used to fail a client-scoped role CLOSED
// when it has no clientId on file — so a mis-provisioned SHIFT_SUPERVISOR
// (who holds manage caps) sees nothing rather than everything.
const NO_CLIENT = '00000000-0000-0000-0000-000000000000';

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
  if (user.role === 'CLIENT_PORTAL') {
    return { ...base, id: (user.clientId ?? NO_CLIENT) };
  }
  // SHIFT_ and FLOOR_SUPERVISOR only ever see their own client (fail
  // closed if unset).
  if (user.role === 'SHIFT_SUPERVISOR' || user.role === 'FLOOR_SUPERVISOR') {
    return { ...base, id: user.clientId ?? NO_CLIENT };
  }
  return base;
}

export function scopeApplications(
  user: SessionUser
): Prisma.ApplicationWhereInput {
  const base: Prisma.ApplicationWhereInput = { deletedAt: null };
  if (user.role === 'CLIENT_PORTAL') {
    return { ...base, clientId: (user.clientId ?? NO_CLIENT) };
  }
  if (user.role === 'ASSOCIATE' && user.associateId) {
    return { ...base, associateId: user.associateId };
  }
  // SHIFT_SUPERVISOR sends onboarding invites and watches checklist progress
  // for its own client only (fail closed if unassigned). Without this branch
  // the role reads every application org-wide the moment it holds
  // view:onboarding — same hazard scopeClients guards against above.
  if (user.role === 'SHIFT_SUPERVISOR') {
    return { ...base, clientId: user.clientId ?? NO_CLIENT };
  }
  return base;
}

export function scopeTemplates(
  user: SessionUser
): Prisma.OnboardingTemplateWhereInput {
  if (user.role === 'CLIENT_PORTAL') {
    // Client-portal users see global templates and their own client's.
    return { OR: [{ clientId: null }, { clientId: (user.clientId ?? NO_CLIENT) }] };
  }
  return {};
}

export function scopeBackgroundChecks(user: SessionUser): Prisma.BackgroundCheckWhereInput {
  if (user.role === 'CLIENT_PORTAL') {
    return { clientId: (user.clientId ?? NO_CLIENT) };
  }
  return {};
}

export function scopeDrugTests(user: SessionUser): Prisma.DrugTestWhereInput {
  if (user.role === 'CLIENT_PORTAL') {
    return { clientId: (user.clientId ?? NO_CLIENT) };
  }
  return {};
}

export function scopeDocuments(user: SessionUser): Prisma.DocumentRecordWhereInput {
  const base: Prisma.DocumentRecordWhereInput = { deletedAt: null };
  if (user.role === 'ASSOCIATE' && user.associateId) {
    return { ...base, associateId: user.associateId };
  }
  if (user.role === 'CLIENT_PORTAL') {
    return { ...base, clientId: (user.clientId ?? NO_CLIENT) };
  }
  return base;
}

export function scopePayrollRuns(user: SessionUser): Prisma.PayrollRunWhereInput {
  // CLIENT_PORTAL only ever sees runs for its own client (although it lacks
  // view:payroll today; defense in depth for when finance roles are added).
  if (user.role === 'CLIENT_PORTAL') {
    return { clientId: (user.clientId ?? NO_CLIENT) };
  }
  // ASSOCIATE doesn't list runs — they hit /payroll/me/items instead.
  return {};
}

export function scopePayrollSchedules(user: SessionUser): Prisma.PayrollScheduleWhereInput {
  // Wave 1.1 — Pay schedules are managed by HR/finance. CLIENT_PORTAL only
  // ever sees schedules for its own client (plus org-wide nulls); other
  // privileged roles see everything not soft-deleted.
  const base: Prisma.PayrollScheduleWhereInput = { deletedAt: null };
  if (user.role === 'CLIENT_PORTAL') {
    return { ...base, OR: [{ clientId: null }, { clientId: (user.clientId ?? NO_CLIENT) }] };
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
  // CLIENT_PORTAL is restricted to its own client's shifts — and to its
  // own store's, when the account is pinned to one.
  if (user.role === 'CLIENT_PORTAL') {
    return {
      clientId: user.clientId ?? NO_CLIENT,
      ...(user.locationId ? { locationId: user.locationId } : {}),
    };
  }
  // SHIFT_SUPERVISOR manages only its own client's shifts (fail closed),
  // narrowed to their store when they have one.
  if (user.role === 'SHIFT_SUPERVISOR') {
    return {
      clientId: user.clientId ?? NO_CLIENT,
      ...(user.locationId ? { locationId: user.locationId } : {}),
    };
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
 * Associates visible to this caller. CLIENT_PORTAL and SHIFT_SUPERVISOR
 * are clamped to their own client's roster (fail closed when the client
 * is unset); an ASSOCIATE only ever resolves to themselves.
 */
export function scopeAssociates(user: SessionUser): Prisma.AssociateWhereInput {
  if (user.role === 'ASSOCIATE') {
    return { id: user.associateId ?? NO_CLIENT };
  }
  if (user.role === 'CLIENT_PORTAL' || user.role === 'SHIFT_SUPERVISOR') {
    if (!user.clientId) return { id: NO_CLIENT };
    // Pinned to a store: their roster is that building's, not the
    // client's. Without this a store account could build an ad-hoc
    // associate or time report and read every store on the account.
    if (user.locationId) return atStore(user.locationId);
    return associatesOfClient(user.clientId);
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
  if (user.role === 'CLIENT_PORTAL' || user.role === 'SHIFT_SUPERVISOR') {
    return { payrollRun: { is: { clientId: user.clientId ?? NO_CLIENT } } };
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
  // SHIFT_SUPERVISOR sees only requests from their own client's people
  // (fail closed when unassigned). Without this, a supervisor could read
  // and decide PTO org-wide.
  if (user.role === 'SHIFT_SUPERVISOR') {
    if (!user.clientId) return { associateId: NO_CLIENT };
    return { associate: { is: associatesOfClient(user.clientId) } };
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
    // A punch carries its own location (kiosk/geofence) or inherits its
    // shift's, so a store account is clamped on either.
    if (user.locationId) {
      return {
        clientId: user.clientId,
        OR: [
          { locationId: user.locationId },
          { shift: { is: { locationId: user.locationId } } },
        ],
      };
    }
    return { clientId: user.clientId };
  }
  // SHIFT_SUPERVISOR manages — and FLOOR_SUPERVISOR watches — only its
  // own client's time (fail closed).
  if (user.role === 'SHIFT_SUPERVISOR' || user.role === 'FLOOR_SUPERVISOR') {
    return { clientId: user.clientId ?? NO_CLIENT };
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
    return { OR: [{ clientId: null }, { clientId: user.clientId ?? NO_CLIENT }] };
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
    return { clientId: user.clientId ?? NO_CLIENT };
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
  const intent = opts.intent ?? 'applicant-record';
  if (
    intent === 'applicant-record' &&
    !(user.associateId && app.associateId === user.associateId) &&
    !hasCapability(user.role, 'manage:onboarding')
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
    (app.status === 'APPROVED' || app.status === 'REJECTED') &&
    !hasCapability(user.role, 'manage:onboarding')
  ) {
    throw new HttpError(
      409,
      'application_locked',
      'This application has been finalized by HR and can no longer be changed. Contact HR to request a correction.'
    );
  }
  return app;
}
