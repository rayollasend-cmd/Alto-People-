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

/* ------------------------------------------------ internal roles, narrowed */

/**
 * Access pack — an INTERNAL role (HR admin, Ops manager, Workforce manager,
 * Finance…) narrowed to named sites and/or regions: a regional Ops lead
 * sees their region's stores, not the whole organization. The binding is
 * on the account (User.scopeSiteIds / scopeRegionIds, with a named
 * approver); every list helper below clamps through it, and a write route
 * that loads its row through the same helper fails to a 404 outside it.
 *
 * Empty binding = the whole tenant, exactly as before; bounded roles and
 * associates are never widened by it (their own clamp runs first).
 */
export function internalSites(user: SessionUser): Prisma.SiteWhereInput | null {
  if (user.role === 'ASSOCIATE' || isBounded(user)) return null;
  const sites = user.scopeSiteIds ?? [];
  const regions = user.scopeRegionIds ?? [];
  if (sites.length === 0 && regions.length === 0) return null;
  const or: Prisma.SiteWhereInput[] = [];
  if (sites.length) or.push({ id: { in: sites } });
  if (regions.length) or.push({ regionId: { in: regions } });
  return { deletedAt: null, OR: or };
}

/** True when the caller's reach is narrowed to sites/regions. */
export function isInternallyScoped(user: SessionUser): boolean {
  return internalSites(user) !== null;
}

/** People placed at the caller's sites (open assignment there). */
function atInternalSites(sites: Prisma.SiteWhereInput): Prisma.AssociateWhereInput {
  return { assignments: { some: { endedAt: null, location: { is: sites } } } };
}

/**
 * Combine where-clauses with AND — never with object spread. Two helpers
 * that both constrain `assignments`, `OR` or `id` silently overwrite each
 * other when spread (the people directory let a store filter replace the
 * caller's scope that way). Falsy parts are dropped, so optional filters
 * read as `cond && { … }`.
 */
export function scopeWhere<T extends object>(...parts: Array<T | null | undefined | false>): { AND: T[] } {
  return { AND: parts.filter((p): p is T => !!p && Object.keys(p).length > 0) };
}

/**
 * The people the caller may see, active only and in the caller's tenant —
 * the usual base for any people list. `former` keeps deactivated people
 * (the separated) for the lists that are about them.
 */
export function scopeActiveAssociates(user: SessionUser, opts: { former?: boolean } = {}): Prisma.AssociateWhereInput {
  return scopeWhere<Prisma.AssociateWhereInput>(
    { tenantId: tenantIdForWrite(), deletedAt: null },
    !opts.former && { deactivatedAt: null },
    scopeAssociates(user),
  );
}

/**
 * Is this site inside the caller's reach? Always true for an unscoped
 * caller; a scoped one must name a site under their binding. Use on writes
 * that create a record at a site (a shift, a time entry) — the list
 * helpers cover reads and the writes that load through them.
 */
export async function siteInScope(tx: Tx, user: SessionUser, locationId: string | null | undefined): Promise<boolean> {
  const sites = internalSites(user);
  if (!sites) return true;
  if (!locationId) return false;
  const hit = await tx.site.findFirst({ where: { id: locationId, ...sites }, select: { id: true } });
  return !!hit;
}

/**
 * 404 unless this person is in the caller's tenant and reach — for the
 * routes that take an associate id in the path (their pay, their skills).
 * `former` admits deactivated people (their history is still theirs).
 */
export async function assertAssociateInScope(
  tx: Tx,
  user: SessionUser,
  associateId: string,
  opts: { former?: boolean } = {},
): Promise<void> {
  const hit = await tx.associate.findFirst({ where: { AND: [{ id: associateId }, scopeActiveAssociates(user, { former: opts.former ?? true })] }, select: { id: true } });
  if (!hit) throw new HttpError(404, 'not_found', 'Associate not found.');
}

/** 404 (not 403) when the site is outside the caller's reach, so nothing is revealed. */
export async function assertSiteInScope(tx: Tx, user: SessionUser, locationId: string | null | undefined): Promise<void> {
  if (!(await siteInScope(tx, user, locationId))) {
    throw new HttpError(404, 'site_not_found', 'That site is not within your scope.');
  }
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
  const sites = internalSites(user);
  if (sites) return { ...base, locations: { some: sites } };
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
  const sites = internalSites(user);
  if (sites) {
    // The application's own site; else (no site on it) its client has a site
    // in reach AND the person isn't already placed at a store outside it —
    // the client alone would show a store-A lead every store-B hire.
    return {
      ...base,
      OR: [
        { location: { is: sites } },
        {
          locationId: null,
          client: { is: { locations: { some: sites } } },
          associate: { is: { OR: [{ assignments: { none: { endedAt: null } } }, atInternalSites(sites)] } },
        },
      ],
    };
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
  // A site/region-bound office account: the checks of the people at its sites.
  const sites = internalSites(user);
  if (sites) return { associate: { is: atInternalSites(sites) } };
  return {};
}

export function scopeDrugTests(user: SessionUser): Prisma.DrugTestWhereInput {
  if (user.role === 'CLIENT_PORTAL') {
    const b = boundsOf(user);
    return b?.clientId ? { tenantId: b.tenantId, clientId: b.clientId } : { clientId: NO_CLIENT };
  }
  const sites = internalSites(user);
  if (sites) return { associate: { is: atInternalSites(sites) } };
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
  const sites = internalSites(user);
  if (sites) return { ...base, associate: { is: atInternalSites(sites) } };
  return base;
}

export function scopePayrollRuns(user: SessionUser): Prisma.PayrollRunWhereInput {
  if (isBounded(user)) {
    const b = boundsOf(user);
    return b?.clientId ? { tenantId: b.tenantId, clientId: b.clientId } : { clientId: NO_CLIENT };
  }
  // A site/region-bound office account sees the runs of clients with a site
  // in its reach — never an org-wide run, whose totals span every site.
  const sites = internalSites(user);
  if (sites) return { client: { is: { locations: { some: sites } } } };
  return {};
}

export function scopePayrollSchedules(user: SessionUser): Prisma.PayrollScheduleWhereInput {
  const base: Prisma.PayrollScheduleWhereInput = { deletedAt: null };
  if (user.role === 'CLIENT_PORTAL') {
    return { ...base, OR: [{ clientId: null }, { clientId: boundsOf(user)?.clientId ?? NO_CLIENT }] };
  }
  // Schedules are definitions, not people: the org-wide ones plus the clients in reach.
  const sites = internalSites(user);
  if (sites) return { ...base, OR: [{ clientId: null }, { client: { is: { locations: { some: sites } } } }] };
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
  const sites = internalSites(user);
  if (sites) return { locationRel: { is: sites } };
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
  const sites = internalSites(user);
  if (sites) return atInternalSites(sites);
  return {};
}

/**
 * scopeAssociates for records about people who may have LEFT (separations,
 * discipline history): a separated person has no open assignment, so the
 * open-assignment clamp would hide them from the very lead who managed
 * them. A site-scoped office account reaches anyone whose placement —
 * current or past — was at a site in its reach. Everyone else: as
 * scopeAssociates.
 */
export function scopeAssociatesIncludingFormer(user: SessionUser): Prisma.AssociateWhereInput {
  const sites = internalSites(user);
  if (sites) return { assignments: { some: { location: { is: sites } } } };
  return scopeAssociates(user);
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
  // A site/region-bound office account: the pay of the people at its sites.
  const sites = internalSites(user);
  if (sites) return { associate: { is: atInternalSites(sites) } };
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
  const sites = internalSites(user);
  if (sites) return { associate: { is: atInternalSites(sites) } };
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
  const sites = internalSites(user);
  if (sites) return { OR: [{ location: { is: sites } }, { shift: { is: { locationRel: { is: sites } } } }] };
  return {};
}

/**
 * The seats (Positions) a caller may read: this tenant's; a client-bound or
 * site/region-bound account only the clients in its reach — an org-wide
 * seat with no client is the whole company's, not theirs.
 */
export function scopePositions(user: SessionUser): Prisma.PositionWhereInput {
  const tenantId = tenantIdForWrite();
  if (isClientBoundedRole(user) || internalSites(user)) return { tenantId, deletedAt: null, client: { is: scopeClients(user) } };
  return { tenantId, deletedAt: null };
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
  // The globals plus the qualifications of clients with a site in reach.
  const sites = internalSites(user);
  if (sites) return { OR: [{ clientId: null }, { client: { is: { locations: { some: sites } } } }] };
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

/* ------------------------------------------- fix wave 2026-10-29 (SEC) */

/**
 * The sites the caller stands on: a client-bound account its client's
 * (or its own site's), a site/region-bound office account its sites, an
 * associate none, everyone else the whole tenant. For rows that hang off
 * a site — a work task, a punch-photo rule, a kiosk — the way scopeShifts
 * is for shifts.
 */
export function scopeSites(user: SessionUser): Prisma.SiteWhereInput {
  if (user.role === 'ASSOCIATE') return { id: NO_CLIENT };
  if (isBounded(user)) {
    const b = boundsOf(user);
    if (!b) return { id: NO_CLIENT };
    if (b.clientId) {
      // A portal account pinned to a store stands on that store; a supervisor on the client.
      return user.role === 'CLIENT_PORTAL' && b.locationId
        ? { tenantId: b.tenantId, id: b.locationId }
        : { tenantId: b.tenantId, clientId: b.clientId };
    }
    return { tenantId: b.tenantId, ...siteFilter(b) };
  }
  return internalSites(user) ?? {};
}

/** True when the caller's reach is narrower than the whole company (bounded, site/region-bound, or an associate). */
export function isNarrowedCaller(user: SessionUser): boolean {
  return user.role === 'ASSOCIATE' || isBounded(user) || isInternallyScoped(user);
}

/**
 * Company-wide records (a 941, the company photo rule, a tax filing) are
 * for company-wide callers. A store-bound or client-bound account gets a
 * 403 that says so — the contractors / retirement / carrier pattern, in
 * one place.
 */
export function assertCompanyWide(user: SessionUser, message = 'This covers the whole company; ask someone without a site limit.'): void {
  if (isNarrowedCaller(user)) throw new HttpError(403, 'company_wide', message);
}

/**
 * The people a caller may act on BY ID: placed (open assignment) inside
 * their reach — or, for someone with no open placement anywhere (separated,
 * between stores), last placed there. A person who moved from store A to
 * store B is B's now, never A's (scopeAssociatesIncludingFormer would keep
 * them A's forever). Unscoped callers: scopeAssociates as ever.
 */
export function associatesInReach(user: SessionUser): Prisma.AssociateWhereInput {
  const sites = internalSites(user);
  if (!sites) return scopeAssociates(user);
  return {
    OR: [
      atInternalSites(sites),
      { AND: [{ assignments: { none: { endedAt: null } } }, { assignments: { some: { location: { is: sites } } } }] },
    ],
  };
}

/**
 * A row that names a person and/or a client but has no relation to filter
 * through (an ApprovalRequest): is it inside the caller's reach? The person
 * decides when there is one, else the client; a row naming neither is the
 * company's, and only a company-wide caller reaches it.
 */
export async function subjectInReach(
  tx: Tx,
  user: SessionUser,
  subject: { associateId?: string | null; clientId?: string | null },
): Promise<boolean> {
  if (!isNarrowedCaller(user)) return true;
  const tenantId = tenantIdForWrite();
  if (subject.associateId) {
    const hit = await tx.associate.findFirst({ where: { AND: [{ id: subject.associateId, tenantId }, associatesInReach(user)] }, select: { id: true } });
    return !!hit;
  }
  if (subject.clientId) {
    const hit = await tx.client.findFirst({ where: { AND: [{ id: subject.clientId, tenantId }, clientsInReach(user)] }, select: { id: true } });
    return !!hit;
  }
  return false;
}

/** The clients a narrowed caller stands on — an associate none (scopeClients leaves them unclamped). */
function clientsInReach(user: SessionUser): Prisma.ClientWhereInput {
  return user.role === 'ASSOCIATE' ? { id: NO_CLIENT } : scopeClients(user);
}

/**
 * subjectInReach as a where, for lists and counts of such rows: the ids in
 * reach, resolved once. Null for a company-wide caller (no narrowing).
 */
export async function subjectReachWhere(
  tx: Tx,
  user: SessionUser,
): Promise<{ OR: Array<{ associateId: { in: string[] } } | { associateId: null; clientId: { in: string[] } }> } | null> {
  if (!isNarrowedCaller(user)) return null;
  const tenantId = tenantIdForWrite();
  const [people, clients] = await Promise.all([
    tx.associate.findMany({ where: { AND: [{ tenantId }, associatesInReach(user)] }, select: { id: true } }),
    tx.client.findMany({ where: { AND: [{ tenantId }, clientsInReach(user)] }, select: { id: true } }),
  ]);
  return {
    OR: [
      { associateId: { in: people.map((p) => p.id) } },
      { associateId: null, clientId: { in: clients.map((c) => c.id) } },
    ],
  };
}

/** The by-id models whose reach loadInScope knows. */
export type InScopeModel =
  | 'associate'
  | 'approvalRequest'
  | 'garnishment'
  | 'taxForm'
  | 'reimbursement'
  | 'document'
  | 'task'
  | 'shift'
  | 'timeEntry';

const NOT_FOUND: Record<InScopeModel, string> = {
  associate: 'Associate not found.',
  approvalRequest: 'Approval request not found.',
  garnishment: 'Garnishment not found.',
  taxForm: 'Form not found.',
  reimbursement: 'Reimbursement not found.',
  document: 'Document not found',
  task: 'No such task.',
  shift: 'Shift not found',
  timeEntry: 'Time entry not found',
};

/**
 * Load a row BY ID through the caller's reach — tenant first, then the
 * caller's clients/sites/people — or 404 (never 403: a store-bound account
 * must not learn another store's row exists). The one door for the
 * /:id routes, so a new handler cannot forget the caller's reach; the
 * tenancy suite (byIdScope.test.ts) calls each with another store's id.
 */
export async function loadInScope(
  tx: Tx,
  model: InScopeModel,
  id: string,
  user: SessionUser,
  opts: { includeDeleted?: boolean } = {},
): Promise<{ id: string }> {
  const tenantId = tenantIdForWrite();
  const ok = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  let hit: { id: string } | null = null;
  if (ok) {
    switch (model) {
      case 'associate':
        // includeDeleted: erasure reaches a soft-deleted record too.
        hit = await tx.associate.findFirst({ where: { AND: [{ id, tenantId }, opts.includeDeleted ? {} : { deletedAt: null }, associatesInReach(user)] }, select: { id: true } });
        break;
      case 'garnishment':
        hit = await tx.garnishment.findFirst({ where: { id, tenantId, deletedAt: null, associate: { is: associatesInReach(user) } }, select: { id: true } });
        break;
      case 'taxForm': {
        // A company form (941, 940, W-3) is the company's; a person's form follows the person.
        const narrowed = isNarrowedCaller(user);
        hit = await tx.taxForm.findFirst({ where: { id, tenantId, ...(narrowed ? { associate: { is: associatesInReach(user) } } : {}) }, select: { id: true } });
        break;
      }
      case 'reimbursement':
        hit = await tx.reimbursement.findFirst({
          where: { id, tenantId, ...(user.role === 'ASSOCIATE' ? { associateId: user.associateId ?? NO_CLIENT } : { associate: { is: associatesInReach(user) } }) },
          select: { id: true },
        });
        break;
      case 'document':
        hit = await tx.documentRecord.findFirst({ where: { AND: [{ id, tenantId }, scopeDocuments(user)] }, select: { id: true } });
        break;
      case 'task':
        hit = await tx.workTask.findFirst({ where: { id, tenantId, location: { is: scopeSites(user) } }, select: { id: true } });
        break;
      case 'shift':
        hit = await tx.shift.findFirst({ where: { AND: [{ id, tenantId }, scopeShifts(user)] }, select: { id: true } });
        break;
      case 'timeEntry':
        hit = await tx.timeEntry.findFirst({ where: { AND: [{ id, tenantId }, scopeTimeEntries(user)] }, select: { id: true } });
        break;
      case 'approvalRequest': {
        const row = await tx.approvalRequest.findFirst({ where: { id, tenantId }, select: { id: true, associateId: true, clientId: true } });
        hit = row && (await subjectInReach(tx, user, row)) ? { id: row.id } : null;
        break;
      }
    }
  }
  if (!hit) throw new HttpError(404, 'not_found', NOT_FOUND[model]);
  return hit;
}
