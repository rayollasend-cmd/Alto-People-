import { emitBooksChange } from '../lib/books/events.js';
import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import {
  ClientCreateInputSchema,
  ClientStateInputSchema,
  ClientStatusSchema,
  ClientUpdateInputSchema,
  LocationCreateInputSchema,
  LocationUpdateInputSchema,
  type ClientListItem,
  type ClientListResponse,
  type ClientSummary,
  type LocationSummary,
  csvCell,
} from '@alto-people/shared';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { activeAssociateCountsByClient } from '../lib/associateClients.js';
import { canReadStatements, clientPerformanceHandler, withAccountNumbers } from './clientsMetrics.js';
import { HttpError } from '../middleware/error.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { invalidateUserCache, requireAnyCapability, requireCapability } from '../middleware/auth.js';
import { z } from 'zod';
import { invitePortalAccount } from '../lib/portalInvite.js';
import { portalEngagementFor } from '../lib/portalEngagement.js';
import { computePortalReadiness, nudgePortalReadiness } from '../lib/portalReadiness.js';
import { trackNotificationWork } from '../lib/notify.js';
import { scopeClients } from '../lib/scope.js';
import { enqueueAudit, recordCriticalAudit } from '../lib/audit.js';
import { seedDefaultShiftPositions } from '../lib/shiftPositions.js';
import { computeStatementSnapshot, type StatementSnapshot } from '../lib/clientStatement.js';
import { orgDateKey, startOfWeekUTC } from '../lib/timeAnomalies.js';
import {
  buildClientServiceReport,
  renderClientServiceReportPdf,
} from '../lib/clientServiceReport.js';
import { completeStatementSnapshot, renderStatementPdf, statementContext } from '../lib/statementPdf.js';
import { ensureBrandingLoaded } from '../lib/branding.js';
import { finalizeStatement, notifyPortalOfStatement, statementLabel } from '../lib/statementFinalize.js';
import { recordStatementPaidInFull, statementBalances } from '../lib/books/posting/receivables.js';
import { daysPastDue, dueOnFor } from '../lib/books/aging.js';
import { UNBILLED_GRACE_DAYS } from '../lib/payBillRecon.js';
import { sendStatementReminderNow } from '../lib/statementDunning.js';
import { accountFieldsPatch, accountSummaryFields, type AccountSummaryRow } from '../lib/clientAccountFields.js';

export const clientsRouter = Router();

const MANAGE = requireCapability('manage:clients');
const VIEW = requireCapability('view:clients');

/**
 * Mount-level gate for the /clients router (used in app.ts instead of a
 * bare requireCapability).
 *
 * /clients is the client-accounts admin area, gated on view:clients — but
 * ONE read inside it feeds operational UI everywhere: GET /:id/locations
 * powers the location pickers on the scheduling grid, the time board,
 * kiosk admin, and the onboarding invite dialog. SHIFT_SUPERVISOR and
 * CLIENT_PORTAL hold none of the clients-area capabilities yet must see
 * their OWN client's sites (reported 2026-08-14: supervisors couldn't pick
 * a location or create shift teams — this gate 403'd the cascade's first
 * link). The locations handler already clamps those two roles through
 * scopeClients, which fails closed to exactly their own client, so letting
 * them reach it grants nothing beyond their tenancy.
 *
 * Deliberately role-listed rather than capability-derived: scopeClients
 * clamps exactly these two roles. ASSOCIATE holds view:scheduling too but
 * is NOT clamped by scopeClients, so admitting by capability would open
 * org-wide location reads. Every other method/path keeps requiring
 * view:clients.
 */
export function clientsAccessGate(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (
    req.method === 'GET' &&
    /^\/[^/]+\/locations\/?$/.test(req.path) &&
    (req.user?.role === 'SHIFT_SUPERVISOR' ||
      // The floor supervisor's My floor names its store and address.
      req.user?.role === 'FLOOR_SUPERVISOR' ||
      req.user?.role === 'CLIENT_PORTAL' ||
      // WORKFORCE_MANAGER runs scheduling and the time board org-wide but
      // deliberately lacks view:clients (the accounts area carries bill
      // rates). Locations are operational data — names and timezones —
      // and without them the WFM's site pickers rendered empty (reported
      // 2026-09-06). Org-wide by design: scopeClients doesn't clamp them.
      req.user?.role === 'WORKFORCE_MANAGER')
  ) {
    next();
    return;
  }
  VIEW(req, res, next);
}

function auditClient(
  req: Request,
  action: string,
  clientId: string,
  metadata: Record<string, unknown> = {}
): void {
  enqueueAudit(
    {
      actorUserId: req.user!.id,
      clientId,
      action,
      entityType: 'Client',
      entityId: clientId,
      metadata: {
        ip: req.ip ?? null,
        userAgent: req.headers['user-agent'] ?? null,
        ...metadata,
      },
    },
    `clients.${action}`
  );
}

/**
 * GET /clients?status=ACTIVE&q=acme
 *
 * Both filters are optional and combine. `q` does case-insensitive
 * substring on name only — small enough that an index isn't worth
 * adding. Counts (open applications, last payroll) are batched into
 * two grouped queries no matter how many clients match.
 */
// Same pagination contract as /directory: optional ?cursor + ?limit,
// defaults to the prior "fetch 1000" behaviour so existing callers
// keep working. The cursor is the id of the last client from the
// previous page; the API skips it and returns the next batch.
const CLIENTS_DEFAULT_PAGE_SIZE = 1000;
/** How the internal-hires pseudo-client is recognised (no flag on Client yet): its name. */
export const INTERNAL_HIRES_MARK = 'Internal Hires';
const CLIENTS_MAX_PAGE_SIZE = 500;

clientsRouter.get('/', async (req, res, next) => {
  try {
    // Explicit tenant (Brief 2-1, cross-tenant suite): the guard only observes until enforce mode.
    const where: Prisma.ClientWhereInput = { ...scopeClients(req.user!), tenantId: tenantIdForWrite() };
    const statusParam = typeof req.query.status === 'string' ? req.query.status : null;
    if (statusParam) {
      const parsedStatus = ClientStatusSchema.safeParse(statusParam);
      if (!parsedStatus.success) {
        throw new HttpError(400, 'invalid_query', 'status must be ACTIVE | INACTIVE | PROSPECT');
      }
      where.status = parsedStatus.data;
    }
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q.length > 0) {
      where.name = { contains: q, mode: 'insensitive' };
    }
    // The accounts list (?include=metrics, the Clients page) is the company's
    // book of business: the synthetic "client" its own internal hires are
    // onboarded under (seeded as "Alto HR — Internal Hires") is not an
    // account and stays out — of the rows and of every count built from
    // them ("Active accounts"). The pickers (no include) still list it: the
    // new-applicant dialog hires internal staff through it.
    if (req.query.include === 'metrics') {
      where.NOT = { name: { contains: INTERNAL_HIRES_MARK, mode: 'insensitive' } };
    }

    // Validate cursor + limit. Bad input is a 400 rather than silently
    // ignored so a malformed client query doesn't accidentally return
    // page 0 over and over.
    const cursorParam =
      typeof req.query.cursor === 'string' ? req.query.cursor.trim() : '';
    const cursor = cursorParam.length > 0 ? cursorParam : null;
    if (cursor && !/^[0-9a-f-]{36}$/i.test(cursor)) {
      throw new HttpError(400, 'invalid_query', 'cursor must be a UUID');
    }
    const limitParam =
      typeof req.query.limit === 'string' ? Number(req.query.limit) : NaN;
    const limit = Number.isFinite(limitParam)
      ? Math.min(Math.max(1, Math.floor(limitParam)), CLIENTS_MAX_PAGE_SIZE)
      : CLIENTS_DEFAULT_PAGE_SIZE;

    const rows = await prisma.client.findMany({
      take: limit,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      where,
      // (name, id) ordering keeps cursors stable when names collide
      // (multiple clients literally named "Walmart" exist).
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    const ids = rows.map((r) => r.id);

    // Clients rebuild: ?include=metrics adds how each account is doing
    // (routes/clientsMetrics). Opt-in: the client pickers across the app
    // (the topbar's store scope loads this list on every page) need names,
    // not hours and money.
    const withNumbers = req.query.include === 'metrics';

    // Batched aggregates regardless of N — no per-row queries.
    const [appCounts, activeCounts, lastPayrolls] = ids.length
      ? await Promise.all([
          prisma.application.groupBy({
            by: ['clientId'],
            where: {
              clientId: { in: ids },
              status: { notIn: ['REJECTED', 'CANCELLED'] },
              deletedAt: null,
            },
            _count: { _all: true },
          }),
          // Where people work NOW — a transfer moves them (lib/associateClients).
          // With the account numbers it comes from there (onAssignment, the same count), computed once.
          withNumbers ? Promise.resolve(new Map<string, number>()) : activeAssociateCountsByClient(ids),
          prisma.payrollRun.groupBy({
            by: ['clientId'],
            where: { clientId: { in: ids }, disbursedAt: { not: null } },
            _max: { disbursedAt: true },
          }),
        ])
      : [[], new Map<string, number>(), []];

    const appCountByClient = new Map<string, number>();
    for (const r of appCounts) {
      if (r.clientId) appCountByClient.set(r.clientId, r._count._all);
    }
    const lastPayrollByClient = new Map<string, Date | null>();
    for (const r of lastPayrolls) {
      if (r.clientId) lastPayrollByClient.set(r.clientId, r._max.disbursedAt);
    }

    const base: ClientListItem[] = rows.map((row) => ({
      ...toSummary(row, canReadStatements(req)),
      openApplications: appCountByClient.get(row.id) ?? 0,
      activeAssociateCount: activeCounts.get(row.id) ?? 0,
      lastPayrollDisbursedAt:
        lastPayrollByClient.get(row.id)?.toISOString() ?? null,
    }));
    // On assignment, fill rate, hours, health, owner, and money for
    // statements readers only; activeAssociateCount becomes onAssignment.
    const clients = withNumbers ? await withAccountNumbers(req, base, rows) : base;
    const nextCursor = rows.length === limit ? rows[rows.length - 1]!.id : null;
    const payload: ClientListResponse = { clients, nextCursor };
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /clients   (HR only)
 * Creates a new client. Defaults to PROSPECT so the live-roster numbers
 * don't shift before HR explicitly flips the status to ACTIVE.
 */
clientsRouter.post('/', MANAGE, async (req, res, next) => {
  try {
    const parsed = ClientCreateInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const created = await prisma.client.create({
      data: {
        name: parsed.data.name,
        industry: parsed.data.industry ?? null,
        status: parsed.data.status ?? 'PROSPECT',
        contactEmail: parsed.data.contactEmail ?? null,
        state: parsed.data.state ? parsed.data.state.toUpperCase() : null,
        fieldglassSiteName: parsed.data.fieldglassSiteName ?? null,
        fieldglassBillRate: parsed.data.fieldglassBillRate ?? null,
      },
    });
    // Seed the default shift-position catalog so the scheduling dropdown
    // isn't empty for a brand-new client. Best-effort: a seeding hiccup
    // must not fail client creation — the admin can add positions manually.
    try {
      await seedDefaultShiftPositions(created.id);
    } catch {
      // non-fatal
    }
    // Every client gets a work site at birth, named after the client.
    // Most clients ARE one store ("Walmart Front Beach"); with a sole site
    // on record, invites auto-assign it, approval opens the assignment,
    // and the associate's site is recorded from day one — no picker, no
    // "not at this site" drift. Multi-store clients just add more sites,
    // which flips the invite dialogs to an explicit picker. Best-effort
    // for the same reason as positions: without it, invites simply fall
    // back to the no-site behavior until an admin adds one.
    try {
      await prisma.site.create({
        data: {
          clientId: created.id,
          name: created.name,
          state: created.state,
        },
      });
    } catch {
      // non-fatal
    }
    await auditClient(req, 'client.created', created.id, {
      name: created.name,
      status: created.status,
    });
    // The company QuickBooks keeps a customer per client (lib/books/qbo).
    emitBooksChange({ localType: 'Client', localId: created.id, op: 'UPSERT' });
    res.status(201).json(toSummary(created, canReadStatements(req)));
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /clients/:id   (HR only)
 * Partial update of name / industry / status / contactEmail. State and
 * geofence have dedicated routes because they trigger policy
 * recomputation downstream.
 */
clientsRouter.patch('/:id', MANAGE, async (req, res, next) => {
  try {
    const parsed = ClientUpdateInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const existing = await prisma.client.findFirst({
      where: { ...scopeClients(req.user!), id: req.params.id, tenantId: tenantIdForWrite() },
    });
    if (!existing) throw new HttpError(404, 'client_not_found', 'Client not found');

    const data: Record<string, unknown> = {};
    if (parsed.data.name !== undefined) data.name = parsed.data.name;
    if (parsed.data.industry !== undefined) data.industry = parsed.data.industry;
    if (parsed.data.status !== undefined) data.status = parsed.data.status;
    if (parsed.data.contactEmail !== undefined) data.contactEmail = parsed.data.contactEmail;
    if (parsed.data.weekStartsOn !== undefined) data.weekStartsOn = parsed.data.weekStartsOn;
    if (parsed.data.fieldglassSiteName !== undefined)
      data.fieldglassSiteName = parsed.data.fieldglassSiteName;
    if (parsed.data.fieldglassBillRate !== undefined)
      data.fieldglassBillRate = parsed.data.fieldglassBillRate;
    if (parsed.data.poNumber !== undefined) data.poNumber = parsed.data.poNumber;
    if (parsed.data.paymentTermsDays !== undefined) data.paymentTermsDays = parsed.data.paymentTermsDays;
    // The account: owner (an internal user), contract term, legal facts (lib/clientAccountFields).
    const account = await accountFieldsPatch(prisma, tenantIdForWrite(), existing, parsed.data);
    Object.assign(data, account.data);
    if (Object.keys(data).length === 0) {
      res.json(toSummary(existing, canReadStatements(req)));
      return;
    }

    const updated = await prisma.client.update({
      where: { id: existing.id },
      data,
    });
    await auditClient(req, 'client.updated', updated.id, {
      changed: Object.keys(data),
    });
    if (account.owner) await auditClient(req, 'client.owner_changed', updated.id, account.owner);
    if (account.contract) await auditClient(req, 'client.contract_changed', updated.id, account.contract);
    emitBooksChange({ localType: 'Client', localId: updated.id, op: 'UPSERT' });
    res.json(toSummary(updated, canReadStatements(req)));
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /clients/:id   (HR only)
 * Soft-delete (sets deletedAt). Hidden from every scoped query thereafter
 * because scopeClients enforces deletedAt: null. Idempotent — second
 * delete returns 404 because the row is already invisible to the scope.
 *
 * Cascades are NOT triggered: associates, applications, payroll runs,
 * etc. for this client remain in place. HR should resolve those before
 * archiving in normal operation; the API allows it either way so a bad
 * client added in error can be removed in one click.
 */
clientsRouter.delete('/:id', MANAGE, async (req, res, next) => {
  try {
    const existing = await prisma.client.findFirst({
      where: { ...scopeClients(req.user!), id: req.params.id, tenantId: tenantIdForWrite() },
    });
    if (!existing) throw new HttpError(404, 'client_not_found', 'Client not found');
    await prisma.client.update({
      where: { id: existing.id },
      data: { deletedAt: new Date() },
    });
    await auditClient(req, 'client.archived', existing.id, { name: existing.name });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

clientsRouter.get('/:id', async (req, res, next) => {
  try {
    const row = await prisma.client.findFirst({
      where: { ...scopeClients(req.user!), id: req.params.id, tenantId: tenantIdForWrite() },
    });
    if (!row) {
      throw new HttpError(404, 'client_not_found', 'Client not found');
    }
    res.json(toSummary(row, canReadStatements(req)));
  } catch (err) {
    next(err);
  }
});

// Clients rebuild: the Performance tab — weeks, statements, NPS (routes/clientsMetrics).
clientsRouter.get('/:id/performance', clientPerformanceHandler);

// Phase 131 — Locations under this client. `?includeInactive=true`
// surfaces archived rows for the admin UI; default hides them so the
// transfer picker and kiosk device registration only see live sites.
clientsRouter.get('/:id/locations', async (req, res, next) => {
  try {
    // AND, not spread: scopeClients clamps SHIFT_SUPERVISOR/CLIENT_PORTAL
    // via `id: ownClientId`, and a spread would let `id: req.params.id`
    // OVERRIDE the clamp — any supervisor could read any client's sites.
    // This is the one /clients handler reachable by clamped roles (the
    // gate above admits them for exactly this path).
    const client = await prisma.client.findFirst({
      where: { AND: [scopeClients(req.user!), { id: req.params.id, tenantId: tenantIdForWrite() }] },
      select: { id: true },
    });
    if (!client) {
      throw new HttpError(404, 'client_not_found', 'Client not found');
    }
    const includeInactive =
      typeof req.query.includeInactive === 'string' &&
      req.query.includeInactive.toLowerCase() === 'true';
    const rows = await prisma.site.findMany({
      take: 500,
      where: {
        clientId: client.id,
        deletedAt: null,
        ...(includeInactive ? {} : { isActive: true }),
      },
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      select: {
        id: true,
        clientId: true,
        name: true,
        addressLine1: true,
        addressLine2: true,
        city: true,
        state: true,
        zip: true,
        latitude: true,
        longitude: true,
        geofenceRadiusMeters: true,
        isActive: true,
        timezone: true,
      },
    });
    const locations: LocationSummary[] = rows.map((r) => ({
      id: r.id,
      clientId: r.clientId ?? client.id,
      name: r.name,
      addressLine1: r.addressLine1,
      addressLine2: r.addressLine2,
      city: r.city,
      state: r.state,
      zip: r.zip,
      latitude: r.latitude === null ? null : Number(r.latitude),
      longitude: r.longitude === null ? null : Number(r.longitude),
      geofenceRadiusMeters: r.geofenceRadiusMeters,
      isActive: r.isActive,
      timezone: r.timezone,
    }));
    res.json({ locations });
  } catch (err) {
    next(err);
  }
});

clientsRouter.post('/:id/locations', MANAGE, async (req, res, next) => {
  try {
    const client = await prisma.client.findFirst({
      where: { ...scopeClients(req.user!), id: req.params.id, tenantId: tenantIdForWrite() },
      select: { id: true },
    });
    if (!client) throw new HttpError(404, 'client_not_found', 'Client not found');
    const input = LocationCreateInputSchema.parse(req.body);
    const geo = normalizeGeofence(input);
    const created = await prisma.site.create({
      data: {
        clientId: client.id,
        name: input.name,
        type: input.type ?? undefined,
        addressLine1: input.addressLine1 ?? null,
        addressLine2: input.addressLine2 ?? null,
        city: input.city ?? null,
        state: input.state ?? null,
        zip: input.zip ?? null,
        latitude: geo.latitude,
        longitude: geo.longitude,
        geofenceRadiusMeters: geo.radius,
        ...(input.timezone ? { timezone: input.timezone } : {}),
      },
    });
    auditClient(req, 'location.create', client.id, { locationId: created.id });
    res.status(201).json(shapeLocation(created));
  } catch (err) {
    next(err);
  }
});

clientsRouter.patch('/:id/locations/:lid', MANAGE, async (req, res, next) => {
  try {
    const client = await prisma.client.findFirst({
      where: { ...scopeClients(req.user!), id: req.params.id, tenantId: tenantIdForWrite() },
      select: { id: true },
    });
    if (!client) throw new HttpError(404, 'client_not_found', 'Client not found');
    const existing = await prisma.site.findFirst({
      where: { id: req.params.lid, clientId: client.id, deletedAt: null },
    });
    if (!existing) {
      throw new HttpError(404, 'location_not_found', 'Location not found');
    }
    const input = LocationUpdateInputSchema.parse(req.body);
    const geo = normalizeGeofence(input);
    const updated = await prisma.site.update({
      where: { id: existing.id },
      data: {
        name: input.name,
        addressLine1: input.addressLine1 ?? null,
        addressLine2: input.addressLine2 ?? null,
        city: input.city ?? null,
        state: input.state ?? null,
        zip: input.zip ?? null,
        latitude: geo.latitude,
        longitude: geo.longitude,
        geofenceRadiusMeters: geo.radius,
        ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
        ...(input.timezone ? { timezone: input.timezone } : {}),
      },
    });
    auditClient(req, 'location.update', client.id, { locationId: updated.id });
    res.json(shapeLocation(updated));
  } catch (err) {
    next(err);
  }
});

clientsRouter.delete('/:id/locations/:lid', MANAGE, async (req, res, next) => {
  try {
    const client = await prisma.client.findFirst({
      where: { ...scopeClients(req.user!), id: req.params.id, tenantId: tenantIdForWrite() },
      select: { id: true },
    });
    if (!client) throw new HttpError(404, 'client_not_found', 'Client not found');
    const existing = await prisma.site.findFirst({
      where: { id: req.params.lid, clientId: client.id, deletedAt: null },
      select: { id: true },
    });
    if (!existing) {
      throw new HttpError(404, 'location_not_found', 'Location not found');
    }
    await prisma.site.update({
      where: { id: existing.id },
      data: { deletedAt: new Date(), isActive: false },
    });
    auditClient(req, 'location.delete', client.id, { locationId: existing.id });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

function normalizeGeofence(input: {
  latitude?: number | null;
  longitude?: number | null;
  geofenceRadiusMeters?: number | null;
}): { latitude: number | null; longitude: number | null; radius: number | null } {
  const allSet =
    input.latitude !== null &&
    input.latitude !== undefined &&
    input.longitude !== null &&
    input.longitude !== undefined &&
    input.geofenceRadiusMeters !== null &&
    input.geofenceRadiusMeters !== undefined;
  if (!allSet) {
    return { latitude: null, longitude: null, radius: null };
  }
  return {
    latitude: input.latitude as number,
    longitude: input.longitude as number,
    radius: input.geofenceRadiusMeters as number,
  };
}

function shapeLocation(row: {
  id: string;
  clientId: string | null;
  name: string;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  latitude: { toString(): string } | null;
  longitude: { toString(): string } | null;
  geofenceRadiusMeters: number | null;
  isActive: boolean;
  timezone: string;
}): LocationSummary {
  return {
    id: row.id,
    clientId: row.clientId,
    name: row.name,
    addressLine1: row.addressLine1,
    addressLine2: row.addressLine2,
    city: row.city,
    state: row.state,
    zip: row.zip,
    latitude: row.latitude === null ? null : Number(row.latitude.toString()),
    longitude: row.longitude === null ? null : Number(row.longitude.toString()),
    geofenceRadiusMeters: row.geofenceRadiusMeters,
    isActive: row.isActive,
    timezone: row.timezone,
  };
}

function toSummary(row: {
  id: string;
  name: string;
  industry: string | null;
  status: 'ACTIVE' | 'INACTIVE' | 'PROSPECT';
  contactEmail: string | null;
  state: string | null;
  weekStartsOn: number;
  fieldglassSiteName: string | null;
  fieldglassBillRate: Prisma.Decimal | null;
} & AccountSummaryRow, money: boolean): ClientSummary {
  return {
    id: row.id,
    name: row.name,
    industry: row.industry,
    status: row.status,
    contactEmail: row.contactEmail,
    state: row.state,
    weekStartsOn: row.weekStartsOn,
    fieldglassSiteName: row.fieldglassSiteName,
    // A bill rate is client money: only statement readers get it (omitted, not null).
    ...(money
      ? { fieldglassBillRate: row.fieldglassBillRate == null ? null : Number(row.fieldglassBillRate) }
      : {}),
    // Owner, contract term, legal facts, invoicing terms (lib/clientAccountFields).
    ...accountSummaryFields(row),
  };
}

// Phase 25 — set the work-site state. Drives Phase 23 OT/break policy and
// Phase 25 predictive-scheduling enforcement. Two-letter USPS code or null
// to clear (which puts the client back on the federal default).
clientsRouter.put('/:id/state', MANAGE, async (req, res, next) => {
  try {
    const parsed = ClientStateInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'state must be a 2-letter code or null', parsed.error.flatten());
    }
    const existing = await prisma.client.findFirst({
      where: { ...scopeClients(req.user!), id: req.params.id, tenantId: tenantIdForWrite() },
    });
    if (!existing) throw new HttpError(404, 'client_not_found', 'Client not found');

    const normalized = parsed.data.state ? parsed.data.state.toUpperCase() : null;
    const updated = await prisma.client.update({
      where: { id: existing.id },
      data: { state: normalized },
    });
    await auditClient(req, 'client.state_updated', updated.id, {
      from: existing.state,
      to: normalized,
    });
    res.json(toSummary(updated, canReadStatements(req)));
  } catch (err) {
    next(err);
  }
});

// Phase 131 — geofence used to live on Client; it moved to Location.
// The /clients/:id/geofence GET/PUT routes are gone. Use the LocationsSection
// UI (PATCH /clients/:id/locations/:lid) to set per-site geofences.

/* ===== Client statements ================================================== *
 * Monthly billing/SLA statement per client. DRAFT recomputes the snapshot
 * from live data on every read of the create/refresh route; FINALIZE
 * assigns the next org-wide sequential number and freezes the snapshot —
 * a statement must never change after the client has it. Gated on
 * process:payroll (billing artifact, not a client-admin CRUD surface).
 * ========================================================================== */

const DAY_MS = 86_400_000;
const STATEMENTS = requireCapability('process:payroll');
// Reading statements (list/PDF/CSV) is also an executive surface —
// drafting and finalizing stay with payroll.
const STATEMENTS_READ = requireAnyCapability('process:payroll', 'view:executive');

function statementRow(r: {
  id: string;
  clientId: string;
  periodStart: Date;
  periodEnd: Date;
  number: number | null;
  status: string;
  snapshot: unknown;
  finalizedAt: Date | null;
  finalizedBy?: { email: string } | null;
  paidAt?: Date | null;
  paymentRef?: string | null;
  poNumber?: string | null;
  dueAt?: Date | null;
  reminderStage?: number;
  lastReminderAt?: Date | null;
}) {
  return {
    id: r.id,
    clientId: r.clientId,
    periodStart: r.periodStart.toISOString().slice(0, 10),
    periodEnd: r.periodEnd.toISOString().slice(0, 10),
    number: r.number,
    status: r.status,
    // Statements saved before a field existed read complete (lib/statementPdf).
    snapshot: completeStatementSnapshot(r.snapshot as StatementSnapshot, 'Client', { start: r.periodStart.toISOString().slice(0, 10), end: r.periodEnd.toISOString().slice(0, 10) }),
    finalizedAt: r.finalizedAt?.toISOString() ?? null,
    finalizedByEmail: r.finalizedBy?.email ?? null,
    paidAt: r.paidAt?.toISOString() ?? null,
    paymentRef: r.paymentRef ?? null,
    poNumber: r.poNumber ?? null,
    dueAt: r.dueAt ? r.dueAt.toISOString().slice(0, 10) : null,
    reminderStage: r.reminderStage ?? 0,
    lastReminderAt: r.lastReminderAt?.toISOString() ?? null,
  };
}

/**
 * POST /clients/statements/generate-due — the weekly statement run in one
 * click. For every active client, create (or refresh) the DRAFT statement
 * for the LAST COMPLETED org week (Sat→Fri); FINAL periods are skipped.
 * Same create-or-refresh semantics as the per-client POST below, so
 * running it twice is harmless.
 */
clientsRouter.post('/statements/generate-due', STATEMENTS, async (req, res, next) => {
  try {
    // Last completed org week as Florida-local calendar dates.
    const thisWeekStart = startOfWeekUTC(new Date());
    const prevWeekStart = new Date(thisWeekStart.getTime() - 7 * 24 * 3_600_000);
    const prevWeekEnd = new Date(thisWeekStart.getTime() - 24 * 3_600_000);
    const startKey = orgDateKey(prevWeekStart);
    const endKey = orgDateKey(prevWeekEnd);
    const start = new Date(`${startKey}T00:00:00.000Z`);
    const end = new Date(`${endKey}T00:00:00.000Z`);
    const endExclusive = new Date(end.getTime() + 24 * 3_600_000);

    const clients = await prisma.client.findMany({
      where: { deletedAt: null, status: 'ACTIVE' },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
      take: 200,
    });

    let generated = 0;
    let refreshed = 0;
    let skippedFinal = 0;
    for (const client of clients) {
      const existing = await prisma.clientStatement.findUnique({
        where: {
          clientId_periodStart_periodEnd: {
            clientId: client.id,
            periodStart: start,
            periodEnd: end,
          },
        },
        select: { id: true, status: true },
      });
      if (existing?.status === 'FINAL') {
        skippedFinal += 1;
        continue;
      }
      const snapshot = await computeStatementSnapshot(
        prisma,
        client.id,
        start,
        endExclusive,
      );
      if (existing) {
        await prisma.clientStatement.update({
          where: { id: existing.id },
          data: { snapshot: snapshot as unknown as Prisma.InputJsonValue },
        });
        refreshed += 1;
      } else {
        await prisma.clientStatement.create({
          data: {
            clientId: client.id,
            periodStart: start,
            periodEnd: end,
            snapshot: snapshot as unknown as Prisma.InputJsonValue,
          },
        });
        generated += 1;
      }
    }

    enqueueAudit(
      {
        actorUserId: req.user!.id,
        action: 'client.statements_generated_due',
        entityType: 'ClientStatement',
        entityId: `${startKey}..${endKey}`,
        metadata: { periodStart: startKey, periodEnd: endKey, generated, refreshed, skippedFinal },
      },
      'clients.statements_generate_due',
    );
    res.json({ periodStart: startKey, periodEnd: endKey, generated, refreshed, skippedFinal });
  } catch (err) {
    next(err);
  }
});

/**
 * Finance walk 6 — the weekly close roll-up in one call: every client's
 * recent statements (in the caller's reach) with what closing needs — the
 * due date, days late, what is still open, the change against the client's
 * previous statement — and the weeks with billable approved time that no
 * statement covers ("Missing weeks").
 */
const ROLLUP_PERIODS_PER_CLIENT = 12;
clientsRouter.get('/statements/rollup', STATEMENTS_READ, async (req, res, next) => {
  try {
    const now = new Date();
    const clients = await prisma.client.findMany({ where: { ...scopeClients(req.user!), tenantId: tenantIdForWrite(), deletedAt: null }, select: { id: true, name: true }, orderBy: { name: 'asc' }, take: 2000 });
    const clientName = new Map(clients.map((c) => [c.id, c.name]));
    const ids = clients.map((c) => c.id);
    const [all, balances] = await Promise.all([
      prisma.clientStatement.findMany({ where: { clientId: { in: ids } }, orderBy: [{ clientId: 'asc' }, { periodStart: 'desc' }], include: { finalizedBy: { select: { email: true } } }, take: 20_000 }),
      statementBalances(prisma, { clientId: { in: ids }, paidAt: null }),
    ]);
    const open = new Map(balances.map((b) => [b.statementId, b.open / 100]));
    const byClient = new Map<string, typeof all>();
    for (const st of all) byClient.set(st.clientId, [...(byClient.get(st.clientId) ?? []), st]);
    const rows = [];
    for (const [clientId, list] of byClient) {
      // Newest first; each row's "previous" is the client's statement before it (adjustments-only ones skipped).
      const hourly = list.filter((st) => !(st.snapshot as { adjustmentsOnly?: boolean } | null)?.adjustmentsOnly);
      for (const st of list.slice(0, ROLLUP_PERIODS_PER_CLIENT)) {
        const snap = (st.snapshot as { totals?: { hours?: number; amount?: number }; adjustmentsOnly?: boolean } | null) ?? {};
        const prev = snap.adjustmentsOnly ? null : (hourly[hourly.indexOf(st) + 1] ?? null);
        const prevSnap = (prev?.snapshot as { totals?: { hours?: number; amount?: number } } | null) ?? null;
        const dueOn = st.status === 'FINAL' ? dueOnFor(st) : null;
        const unpaid = st.status === 'FINAL' && !st.paidAt;
        rows.push({
          ...statementRow(st),
          clientName: clientName.get(clientId) ?? 'Client',
          dueOn,
          daysLate: unpaid && dueOn ? Math.max(0, daysPastDue(dueOn, now)) : 0,
          open: unpaid ? (open.get(st.id) ?? snap.totals?.amount ?? 0) : 0,
          previous: prev && prevSnap?.totals ? { statementId: prev.id, periodStart: prev.periodStart.toISOString().slice(0, 10), hours: prevSnap.totals.hours ?? 0, amount: prevSnap.totals.amount ?? 0 } : null,
        });
      }
    }
    rows.sort((x, y) => y.periodStart.localeCompare(x.periodStart) || x.clientName.localeCompare(y.clientName));

    // Missing weeks: approved time at a client, older than the grace, that no statement period covers.
    const since = new Date(now.getTime() - 12 * 7 * DAY_MS);
    const graceCut = new Date(now.getTime() - UNBILLED_GRACE_DAYS * DAY_MS);
    const entries = ids.length
      ? await prisma.timeEntry.findMany({
          where: { tenantId: tenantIdForWrite(), clientId: { in: ids }, status: 'APPROVED', clockInAt: { gte: since, lt: graceCut }, clockOutAt: { not: null } },
          select: { clientId: true, clockInAt: true, clockOutAt: true, breaks: { select: { startedAt: true, endedAt: true } } },
          take: 100_000,
        })
      : [];
    const covered = (clientId: string, at: Date) => (byClient.get(clientId) ?? []).some((st) => st.periodStart.getTime() <= at.getTime() && at.getTime() < st.periodEnd.getTime() + DAY_MS);
    const missing = new Map<string, { clientId: string; clientName: string; weekStart: string; hours: number }>();
    for (const e of entries) {
      if (!e.clientId || covered(e.clientId, e.clockInAt)) continue;
      const ws = orgDateKey(startOfWeekUTC(e.clockInAt));
      const key = `${e.clientId}:${ws}`;
      let ms = e.clockOutAt!.getTime() - e.clockInAt.getTime();
      for (const b of e.breaks) ms -= Math.max(0, (b.endedAt ?? e.clockOutAt!).getTime() - b.startedAt.getTime());
      const m = missing.get(key) ?? { clientId: e.clientId, clientName: clientName.get(e.clientId) ?? 'Client', weekStart: ws, hours: 0 };
      m.hours += Math.max(0, ms) / 3_600_000;
      missing.set(key, m);
    }
    res.json({
      statements: rows,
      missingWeeks: [...missing.values()].map((m) => ({ ...m, hours: Math.round(m.hours * 10) / 10 })).sort((a, b) => a.weekStart.localeCompare(b.weekStart) || a.clientName.localeCompare(b.clientName)),
    });
  } catch (err) {
    next(err);
  }
});

clientsRouter.get('/:id/statements', STATEMENTS_READ, async (req, res, next) => {
  try {
    const owner = await prisma.client.findFirst({ where: { id: req.params.id, deletedAt: null, tenantId: tenantIdForWrite() }, select: { id: true } });
    if (!owner) throw new HttpError(404, 'client_not_found', 'Client not found');
    const [rows, acks] = await Promise.all([
      prisma.clientStatement.findMany({
        where: { clientId: req.params.id },
        orderBy: [{ periodStart: 'desc' }],
        take: 60,
        include: { finalizedBy: { select: { email: true } } },
      }),
      // The client's own "reviewed" marks — disputes have a record on both sides.
      prisma.clientAcknowledgement.findMany({
        where: { clientId: req.params.id, kind: 'STATEMENT' },
        include: { user: { select: { email: true, associate: { select: { firstName: true } } } } },
        take: 500,
      }),
    ]);
    const reviewed = new Map(
      acks.map((a) => [
        a.subjectKey,
        {
          reviewedAt: a.createdAt.toISOString(),
          reviewedBy: a.user?.associate?.firstName ?? a.user?.email.split('@')[0] ?? null,
        },
      ]),
    );
    res.json({
      statements: rows.map((r) => ({ ...statementRow(r), clientReviewed: reviewed.get(r.id) ?? null })),
    });
  } catch (err) {
    next(err);
  }
});

// Create or refresh the DRAFT for a period. Recomputing an existing DRAFT
// is the normal flow as late approvals land; a FINAL period 409s.
clientsRouter.post('/:id/statements', STATEMENTS, async (req, res, next) => {
  try {
    const start = new Date(`${req.body?.periodStart}T00:00:00.000Z`);
    const end = new Date(`${req.body?.periodEnd}T00:00:00.000Z`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) {
      throw new HttpError(400, 'invalid_period', 'periodStart/periodEnd must be YYYY-MM-DD, end on or after start.');
    }
    const endExclusive = new Date(end.getTime() + 24 * 3_600_000);
    const client = await prisma.client.findFirst({
      where: { id: req.params.id, deletedAt: null, tenantId: tenantIdForWrite() },
      select: { id: true },
    });
    if (!client) throw new HttpError(404, 'client_not_found', 'Client not found');

    const existing = await prisma.clientStatement.findUnique({
      where: {
        clientId_periodStart_periodEnd: {
          clientId: client.id,
          periodStart: start,
          periodEnd: end,
        },
      },
    });
    if (existing?.status === 'FINAL') {
      throw new HttpError(409, 'already_final', 'This period is finalized — its snapshot no longer changes.');
    }
    if ((existing?.snapshot as unknown as StatementSnapshot | undefined)?.adjustmentsOnly) {
      throw new HttpError(409, 'adjustments_statement', 'This is an adjustments-only statement — refresh it from the pay and bill desk.');
    }
    const snapshot = await computeStatementSnapshot(prisma, client.id, start, endExclusive);
    const row = existing
      ? await prisma.clientStatement.update({
          where: { id: existing.id },
          data: { snapshot: snapshot as unknown as Prisma.InputJsonValue },
          include: { finalizedBy: { select: { email: true } } },
        })
      : await prisma.clientStatement.create({
          data: {
            clientId: client.id,
            periodStart: start,
            periodEnd: end,
            snapshot: snapshot as unknown as Prisma.InputJsonValue,
          },
          include: { finalizedBy: { select: { email: true } } },
        });
    res.json(statementRow(row));
  } catch (err) {
    next(err);
  }
});

clientsRouter.post('/:id/statements/:sid/finalize', STATEMENTS, async (req, res, next) => {
  try {
    // One path for finalizing (lib/statementFinalize): the number, the terms, the books, the portal.
    const updated = await finalizeStatement(prisma, req.params.sid, req.user!.id, { clientId: req.params.id });
    res.json(statementRow(updated));
  } catch (err) {
    next(err);
  }
});

// Invoicing fields on one statement: the PO it bills against and, for a
// FINAL one, the due date Finance agreed (terms can be negotiated per
// invoice). The reminder cadence follows the new date.
clientsRouter.patch('/:id/statements/:sid', STATEMENTS, async (req, res, next) => {
  try {
    const body = z
      .object({
        poNumber: z.string().trim().max(60).nullable().optional(),
        dueAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      })
      .parse(req.body ?? {});
    const row = await prisma.clientStatement.findFirst({ where: { id: req.params.sid, clientId: req.params.id } });
    if (!row) throw new HttpError(404, 'not_found', 'Statement not found.');
    if (body.dueAt !== undefined && row.status !== 'FINAL') {
      throw new HttpError(409, 'not_final', 'A due date applies to a finalized statement.');
    }
    const updated = await prisma.clientStatement.update({
      where: { id: row.id },
      data: {
        ...(body.poNumber !== undefined ? { poNumber: body.poNumber } : {}),
        ...(body.dueAt !== undefined ? { dueAt: body.dueAt ? new Date(`${body.dueAt}T00:00:00.000Z`) : null, reminderStage: 0 } : {}),
      },
      include: { finalizedBy: { select: { email: true } } },
    });
    enqueueAudit(
      {
        actorUserId: req.user!.id,
        clientId: row.clientId,
        action: 'clients.statement_terms_updated',
        entityType: 'ClientStatement',
        entityId: row.id,
        metadata: { poNumber: body.poNumber, dueAt: body.dueAt },
      },
      'clients.statement_terms',
    );
    res.json(statementRow(updated));
  } catch (err) {
    next(err);
  }
});

// The dunning cadence, paused and resumed per client — "they're disputing
// it", "the check is in the mail". Reminders stop until Finance resumes.
clientsRouter.post('/:id/dunning/pause', STATEMENTS, async (req, res, next) => {
  try {
    const note = z.string().trim().min(3).max(500).parse(req.body?.note);
    const client = await prisma.client.findFirst({ where: { ...scopeClients(req.user!), id: req.params.id, tenantId: tenantIdForWrite() } });
    if (!client) throw new HttpError(404, 'client_not_found', 'Client not found');
    await prisma.client.update({
      where: { id: client.id },
      data: { dunningPausedAt: new Date(), dunningPausedById: req.user!.id, dunningPauseNote: note },
    });
    await auditClient(req, 'client.dunning_paused', client.id, { note });
    res.json({ ok: true, pausedAt: new Date().toISOString(), note });
  } catch (err) {
    next(err);
  }
});

clientsRouter.delete('/:id/dunning/pause', STATEMENTS, async (req, res, next) => {
  try {
    const client = await prisma.client.findFirst({ where: { ...scopeClients(req.user!), id: req.params.id, tenantId: tenantIdForWrite() } });
    if (!client) throw new HttpError(404, 'client_not_found', 'Client not found');
    await prisma.client.update({
      where: { id: client.id },
      data: { dunningPausedAt: null, dunningPausedById: null, dunningPauseNote: null },
    });
    await auditClient(req, 'client.dunning_resumed', client.id, {});
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Invoicing terms are Finance's to set: the standing PO and net-days terms
// every statement takes from here on (finalized ones keep their own).
clientsRouter.patch('/:id/billing-terms', STATEMENTS, async (req, res, next) => {
  try {
    const body = z
      .object({
        poNumber: z.string().trim().max(60).nullable().optional(),
        paymentTermsDays: z.number().int().min(0).max(365).optional(),
        /** Sales tax on this client's statements (audit 2026-10-21 #17): taxable, and the rate in percent. */
        salesTaxable: z.boolean().optional(),
        salesTaxRatePct: z.number().min(0).max(100).nullable().optional(),
      })
      .parse(req.body ?? {});
    if (body.salesTaxable === true && (body.salesTaxRatePct == null || body.salesTaxRatePct <= 0)) {
      throw new HttpError(400, 'tax_rate_required', 'A taxable client needs a sales tax rate above zero.');
    }
    const client = await prisma.client.findFirst({ where: { ...scopeClients(req.user!), id: req.params.id, tenantId: tenantIdForWrite() } });
    if (!client) throw new HttpError(404, 'client_not_found', 'Client not found');
    const updated = await prisma.client.update({
      where: { id: client.id },
      data: {
        ...(body.poNumber !== undefined ? { poNumber: body.poNumber || null } : {}),
        ...(body.paymentTermsDays !== undefined ? { paymentTermsDays: body.paymentTermsDays } : {}),
        ...(body.salesTaxable !== undefined ? { salesTaxable: body.salesTaxable } : {}),
        ...(body.salesTaxRatePct !== undefined ? { salesTaxRatePct: body.salesTaxRatePct } : {}),
      },
      select: { poNumber: true, paymentTermsDays: true, salesTaxable: true, salesTaxRatePct: true },
    });
    await auditClient(req, 'client.billing_terms_updated', client.id, { ...body });
    res.json({ ...updated, salesTaxRatePct: updated.salesTaxRatePct === null ? null : Number(updated.salesTaxRatePct) });
  } catch (err) {
    next(err);
  }
});

/**
 * Finance walk 7 — the collections worklist's actions on one client:
 * "Send reminder now" for a statement (the next stage goes today), and the
 * promise-to-pay / call / note log.
 */
clientsRouter.post('/:id/dunning/send-now', STATEMENTS, async (req, res, next) => {
  try {
    const { statementId } = z.object({ statementId: z.string().uuid() }).parse(req.body ?? {});
    const client = await prisma.client.findFirst({ where: { ...scopeClients(req.user!), id: req.params.id, tenantId: tenantIdForWrite() }, select: { id: true } });
    if (!client) throw new HttpError(404, 'client_not_found', 'Client not found');
    const st = await prisma.clientStatement.findFirst({ where: { id: statementId, clientId: client.id }, select: { id: true } });
    if (!st) throw new HttpError(404, 'not_found', 'Statement not found.');
    const r = await sendStatementReminderNow(prisma, st.id);
    await auditClient(req, 'client.statement_reminder_sent_now', client.id, { statementId: st.id, ...r });
    res.json(r);
  } catch (err) {
    next(err);
  }
});

const CollectionNoteInput = z.object({
  kind: z.enum(['PROMISE', 'CALL', 'NOTE']).default('NOTE'),
  note: z.string().trim().min(1).max(1000),
  statementId: z.string().uuid().nullable().optional(),
  promisedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  promisedAmount: z.number().positive().max(100_000_000).nullable().optional(),
}).refine((n) => n.kind !== 'PROMISE' || !!n.promisedOn, { message: 'A promise to pay carries the day promised.', path: ['promisedOn'] });

const noteRow = (n: { id: string; clientId: string; statementId: string | null; kind: string; note: string; promisedOn: Date | null; promisedAmount: Prisma.Decimal | null; createdById: string | null; createdAt: Date }) => ({
  id: n.id,
  clientId: n.clientId,
  statementId: n.statementId,
  kind: n.kind as 'PROMISE' | 'CALL' | 'NOTE',
  note: n.note,
  promisedOn: n.promisedOn ? n.promisedOn.toISOString().slice(0, 10) : null,
  promisedAmount: n.promisedAmount === null ? null : Number(n.promisedAmount),
  createdById: n.createdById,
  createdAt: n.createdAt.toISOString(),
});

clientsRouter.get('/:id/collection-notes', STATEMENTS_READ, async (req, res, next) => {
  try {
    const client = await prisma.client.findFirst({ where: { ...scopeClients(req.user!), id: req.params.id, tenantId: tenantIdForWrite() }, select: { id: true } });
    if (!client) throw new HttpError(404, 'client_not_found', 'Client not found');
    const rows = await prisma.clientCollectionNote.findMany({ where: { tenantId: tenantIdForWrite(), clientId: client.id }, orderBy: { createdAt: 'desc' }, take: 100 });
    res.json({ notes: rows.map(noteRow) });
  } catch (err) {
    next(err);
  }
});

clientsRouter.post('/:id/collection-notes', STATEMENTS, async (req, res, next) => {
  try {
    const body = CollectionNoteInput.parse(req.body ?? {});
    const client = await prisma.client.findFirst({ where: { ...scopeClients(req.user!), id: req.params.id, tenantId: tenantIdForWrite() }, select: { id: true } });
    if (!client) throw new HttpError(404, 'client_not_found', 'Client not found');
    if (body.statementId) {
      const st = await prisma.clientStatement.findFirst({ where: { id: body.statementId, clientId: client.id }, select: { id: true } });
      if (!st) throw new HttpError(404, 'not_found', 'Statement not found.');
    }
    const row = await prisma.clientCollectionNote.create({
      data: {
        tenantId: tenantIdForWrite(),
        clientId: client.id,
        statementId: body.statementId ?? null,
        kind: body.kind,
        note: body.note,
        promisedOn: body.promisedOn ? new Date(`${body.promisedOn}T00:00:00.000Z`) : null,
        promisedAmount: body.promisedAmount ?? null,
        createdById: req.user!.id,
      },
    });
    await auditClient(req, 'client.collection_note_added', client.id, { kind: body.kind, statementId: body.statementId ?? null, promisedOn: body.promisedOn ?? null, promisedAmount: body.promisedAmount ?? null });
    res.status(201).json({ note: noteRow(row) });
  } catch (err) {
    next(err);
  }
});

// Where every client stands with reminders: terms, PO, paused or not.
clientsRouter.get('/:id/dunning', STATEMENTS_READ, async (req, res, next) => {
  try {
    const client = await prisma.client.findFirst({
      where: { ...scopeClients(req.user!), id: req.params.id, tenantId: tenantIdForWrite() },
      select: { id: true, poNumber: true, paymentTermsDays: true, salesTaxable: true, salesTaxRatePct: true, dunningPausedAt: true, dunningPauseNote: true, dunningPausedById: true },
    });
    if (!client) throw new HttpError(404, 'client_not_found', 'Client not found');
    const reminders = await prisma.clientStatementReminder.findMany({
      where: { statement: { clientId: client.id } },
      orderBy: { sentAt: 'desc' },
      take: 50,
      select: { id: true, stage: true, sentAt: true, recipients: true, statement: { select: { id: true, number: true, periodStart: true, periodEnd: true } } },
    });
    res.json({
      poNumber: client.poNumber,
      paymentTermsDays: client.paymentTermsDays,
      salesTaxable: client.salesTaxable,
      salesTaxRatePct: client.salesTaxRatePct === null ? null : Number(client.salesTaxRatePct),
      paused: client.dunningPausedAt ? { at: client.dunningPausedAt.toISOString(), note: client.dunningPauseNote, byUserId: client.dunningPausedById } : null,
      reminders: reminders.map((r) => ({
        id: r.id,
        stage: r.stage,
        sentAt: r.sentAt.toISOString(),
        recipients: r.recipients,
        statementId: r.statement.id,
        number: r.statement.number,
        periodStart: r.statement.periodStart.toISOString().slice(0, 10),
        periodEnd: r.statement.periodEnd.toISOString().slice(0, 10),
      })),
    });
  } catch (err) {
    next(err);
  }
});

// Record the client's payment against a FINAL statement — the receivables
// view ages every unpaid FINAL from its due date until this lands.
clientsRouter.post('/:id/statements/:sid/mark-paid', STATEMENTS, async (req, res, next) => {
  try {
    const paymentRef =
      typeof req.body?.paymentRef === 'string' && req.body.paymentRef.trim()
        ? String(req.body.paymentRef).trim().slice(0, 120)
        : null;
    const row = await prisma.clientStatement.findFirst({
      where: { id: req.params.sid, clientId: req.params.id },
    });
    if (!row) throw new HttpError(404, 'not_found', 'Statement not found.');
    if (row.status !== 'FINAL') {
      throw new HttpError(409, 'not_final', 'Only finalized statements can be marked paid.');
    }
    if (row.paidAt) {
      throw new HttpError(409, 'already_paid', 'Statement is already marked paid.');
    }
    // One path for money received (lib/books/posting/receivables): a payment of
    // what is still open, into the books, and the statement marked paid.
    const updated = await recordStatementPaidInFull(prisma, { statementId: row.id, userId: req.user!.id, paymentRef });
    await recordCriticalAudit(
      {
        actorUserId: req.user!.id,
        clientId: row.clientId,
        action: 'clients.statement_paid',
        entityType: 'ClientStatement',
        entityId: row.id,
        metadata: { number: row.number, paymentRef },
      },
      'clients.statement_paid',
    );
    notifyPortalOfStatement(
      row.clientId,
      `Payment received: ${statementLabel(row.number, row.periodStart, row.periodEnd)}`,
      'Your payment is recorded against this statement. Thank you.',
    );
    res.json(statementRow(updated));
  } catch (err) {
    next(err);
  }
});

// CSV twin of the PDF — the shape AP teams paste into their own sheets.
clientsRouter.get('/:id/statements/:sid.csv', STATEMENTS_READ, async (req, res, next) => {
  try {
    const row = await prisma.clientStatement.findFirst({
      where: { id: req.params.sid, clientId: req.params.id },
    });
    if (!row) throw new HttpError(404, 'not_found', 'Statement not found');
    const s = completeStatementSnapshot(row.snapshot as unknown as StatementSnapshot, 'Client', { start: row.periodStart.toISOString().slice(0, 10), end: row.periodEnd.toISOString().slice(0, 10) });
    const lines: string[] = [];
    const push = (...cells: Array<string | number>) =>
      lines.push(cells.map((c) => csvCell(String(c))).join(','));
    push('Client', s.clientName);
    push('Period', s.periodStart, s.periodEnd);
    push(
      'Statement',
      row.status === 'FINAL' && row.number !== null
        ? `No. ${String(row.number).padStart(4, '0')}`
        : 'DRAFT',
    );
    push('');
    push('Service', 'Hours', 'Rate', 'Amount');
    for (const l of s.lines) push(l.label, l.hours.toFixed(2), l.rate.toFixed(2), l.amount.toFixed(2));
    push(
      'Total',
      s.totals.hours.toFixed(2),
      '',
      s.totals.amount.toFixed(2),
    );
    push('Regular hours', s.totals.regularHours.toFixed(2));
    push('Overtime hours', s.totals.otHours.toFixed(2));
    push('');
    push('Work site', 'Hours', 'Amount');
    for (const st of s.stores) push(st.locationName, st.hours.toFixed(2), st.amount.toFixed(2));
    push('');
    push('Shifts published', s.sla.publishedShifts);
    push('Shifts filled', s.sla.assignedShifts);
    if (s.sla.fillRatePct !== null) push('Fill rate %', s.sla.fillRatePct);
    if (s.sla.punctualPct !== null) push('On-time %', s.sla.punctualPct);
    push('No-shows', s.sla.noShows);
    if (s.sla.pendingEntries > 0) push('Entries pending approval (unbilled)', s.sla.pendingEntries);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="statement-${row.periodStart.toISOString().slice(0, 10)}${
        row.number !== null ? `-no${String(row.number).padStart(4, '0')}` : '-draft'
      }.csv"`,
    );
    res.send(lines.join('\n'));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /clients/:id/service-report.pdf?week=YYYY-MM-DD
 * The weekly client-facing service report — coverage, day-by-day,
 * reliability, roster, next-week readiness, billing status — as a
 * letterheaded PDF Alto downloads and hands to the client. `week` is any
 * date inside the desired org week (Sat→Fri); omitted = the last
 * COMPLETED week, which is what a handout is usually about.
 */
clientsRouter.get('/:id/service-report.pdf', STATEMENTS_READ, async (req, res, next) => {
  try {
    const client = await prisma.client.findFirst({
      where: { id: req.params.id, deletedAt: null, tenantId: tenantIdForWrite() },
      select: { id: true, name: true },
    });
    if (!client) throw new HttpError(404, 'client_not_found', 'Client not found');
    const weekParam = req.query.week?.toString();
    if (weekParam && !/^\d{4}-\d{2}-\d{2}$/.test(weekParam)) {
      throw new HttpError(400, 'invalid_week', '`week` must be YYYY-MM-DD');
    }
    const weekStart = weekParam
      ? startOfWeekUTC(new Date(`${weekParam}T12:00:00.000Z`))
      : new Date(startOfWeekUTC(new Date()).getTime() - 7 * 24 * 3_600_000);

    const branding = await ensureBrandingLoaded(prisma);
    const data = await buildClientServiceReport(
      prisma,
      client.id,
      weekStart,
      branding.orgName,
    );
    const pdf = await renderClientServiceReportPdf(data);

    enqueueAudit(
      {
        actorUserId: req.user!.id,
        clientId: client.id,
        action: 'client.service_report_exported',
        entityType: 'Client',
        entityId: client.id,
        metadata: { periodStart: data.periodStart, periodEnd: data.periodEnd },
      },
      'clients.service_report',
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="service-report-${client.name.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}-${data.periodStart}.pdf"`,
    );
    res.send(pdf);
  } catch (err) {
    next(err);
  }
});

clientsRouter.get('/:id/statements/:sid.pdf', STATEMENTS_READ, async (req, res, next) => {
  try {
    const row = await prisma.clientStatement.findFirst({
      where: { id: req.params.sid, clientId: req.params.id },
      include: { finalizedBy: { select: { email: true } } },
    });
    if (!row) throw new HttpError(404, 'not_found', 'Statement not found');
    // Letterhead carries the org's configured name; bill-to uses the
    // client's IRS-registered identity + address when HR has filled them
    // in (same fields the W-2 employer block uses).
    const [branding, client] = await Promise.all([
      ensureBrandingLoaded(prisma),
      prisma.client.findUnique({
        where: { id: row.clientId },
        select: {
          legalName: true,
          addressLine1: true,
          addressLine2: true,
          city: true,
          state: true,
          zip: true,
        },
      }),
    ]);
    const pdf = await renderStatementPdf({
      snapshot: row.snapshot as unknown as StatementSnapshot,
      number: row.number,
      status: row.status,
      finalizedAt: row.finalizedAt,
      finalizedByEmail: row.finalizedBy?.email ?? null,
      orgName: branding.orgName,
      billTo: client,
      ...(await statementContext(prisma, { statementId: row.id, clientId: row.clientId, tenantId: row.tenantId ?? tenantIdForWrite() })),
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="statement-${row.periodStart.toISOString().slice(0, 10)}${
        row.number !== null ? `-no${String(row.number).padStart(4, '0')}` : '-draft'
      }.pdf"`,
    );
    res.send(pdf);
  } catch (err) {
    next(err);
  }
});

/* ====================================================================== */
/* Portal access — the store's logins, from the client page.               */
/* ====================================================================== */

/**
 * GET /clients/:id/portal-users — every CLIENT_PORTAL account bound to
 * this client, with its store and status, so whoever owns the account
 * can see who at the store has access and pull it.
 */
clientsRouter.get('/:id/portal-users', async (req, res, next) => {
  try {
    const client = await prisma.client.findFirst({
      where: { id: req.params.id, deletedAt: null, tenantId: tenantIdForWrite() },
      select: { id: true },
    });
    if (!client) throw new HttpError(404, 'client_not_found', 'Client not found');
    const rows = await prisma.user.findMany({
      where: { clientId: client.id, role: 'CLIENT_PORTAL', deletedAt: null },
      select: {
        id: true,
        email: true,
        status: true,
        createdAt: true,
        locationId: true,
        location: { select: { name: true } },
        inviteTokens: {
          where: { consumedAt: null },
          select: { expiresAt: true },
          orderBy: { expiresAt: 'desc' },
          take: 1,
        },
      },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
    // Are they using it: last seen, sign-ins this week, reports pulled.
    const engagement = await portalEngagementFor(rows.map((u) => u.id), new Date());
    res.json({
      users: rows.map((u) => ({
        id: u.id,
        email: u.email,
        status: u.status,
        createdAt: u.createdAt.toISOString(),
        locationId: u.locationId,
        locationName: u.location?.name ?? null,
        inviteExpiresAt: u.inviteTokens[0]?.expiresAt.toISOString() ?? null,
        ...engagement.get(u.id)!,
      })),
    });
  } catch (err) {
    next(err);
  }
});

const PortalInviteSchema = z.object({
  email: z.string().email().max(254),
  /** null = the whole client (a market manager). */
  locationId: z.string().uuid().nullable().optional(),
  /** Brief 1A-4: store-level is the default; the whole client must be asked for by name. */
  wholeClient: z.boolean().optional(),
  /** How the note addresses them — name only; nothing else is known. */
  name: z.string().trim().min(1).max(120).optional(),
});

/**
 * POST /clients/:id/portal-users — "Give this store a portal login."
 * Creates (or re-invites) a CLIENT_PORTAL account bound to the client and
 * optionally one store, mails the magic link, and rings the Workforce
 * desk if the store isn't ready for a portal yet. manage:clients.
 */
clientsRouter.post('/:id/portal-users', MANAGE, async (req, res, next) => {
  try {
    const client = await prisma.client.findFirst({
      where: { id: req.params.id, deletedAt: null, tenantId: tenantIdForWrite() },
      select: { id: true, name: true },
    });
    if (!client) throw new HttpError(404, 'client_not_found', 'Client not found');
    const input = PortalInviteSchema.parse(req.body);
    const email = input.email.trim().toLowerCase();
    if (!input.locationId && !input.wholeClient) {
      throw new HttpError(400, 'store_required', 'Pick the store this login is for. A whole-client (market manager) login must be asked for by name.');
    }
    let location: { id: string; name: string } | null = null;
    if (input.locationId) {
      location = await prisma.site.findFirst({
        where: { id: input.locationId, clientId: client.id, deletedAt: null },
        select: { id: true, name: true },
      });
      if (!location) {
        throw new HttpError(400, 'location_not_found', 'That store does not belong to this client.');
      }
    }

    const storeCount = await prisma.site.count({ where: { clientId: client.id, deletedAt: null, isActive: true } });
    // A store account gets the store-manager note; a client-wide account
    // is a market manager over this client's stores and gets that note.
    const { user, expiresAt, emailFailed } = await invitePortalAccount({
      email,
      name: input.name ?? null,
      scope: { kind: 'store', clientId: client.id, clientName: client.name, location, storeCount },
      actorUserId: req.user!.id,
    });
    // The portal will show dashes if the store isn't set up — ring the desk.
    void trackNotificationWork(nudgePortalReadiness(client.id).catch(() => false));

    res.status(201).json({
      id: user.id,
      email,
      status: 'INVITED',
      locationId: location?.id ?? null,
      locationName: location?.name ?? null,
      inviteExpiresAt: expiresAt.toISOString(),
      emailFailed,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /clients/:id/portal-users/:uid/disable — pull a store's login.
 * Only CLIENT_PORTAL accounts of THIS client are reachable here, so the
 * clients-area capability can never touch an Alto account.
 */
clientsRouter.post('/:id/portal-users/:uid/disable', MANAGE, async (req, res, next) => {
  try {
    const user = await prisma.user.findFirst({
      where: { id: req.params.uid, clientId: req.params.id, role: 'CLIENT_PORTAL', deletedAt: null },
      select: { id: true, status: true },
    });
    if (!user) throw new HttpError(404, 'not_found', 'Portal account not found');
    if (user.status !== 'DISABLED') {
      await prisma.user.update({
        where: { id: user.id },
        data: { status: 'DISABLED', tokenVersion: { increment: 1 } },
      });
      invalidateUserCache(user.id);
      await recordCriticalAudit(
        {
          actorUserId: req.user!.id,
          clientId: req.params.id,
          action: 'client.portal_user_disabled',
          entityType: 'User',
          entityId: user.id,
          metadata: { ip: req.ip ?? null },
        },
        'clients.portal_user_disabled',
      );
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/**
 * GET /clients/:id/portal-readiness — the setup checklist the portal
 * depends on: contracted headcount per store, a lead position, supervisor
 * phones, photos, the support address, the MFA policy.
 */
clientsRouter.get('/:id/portal-readiness', async (req, res, next) => {
  try {
    const client = await prisma.client.findFirst({
      where: { id: req.params.id, deletedAt: null, tenantId: tenantIdForWrite() },
      select: { id: true },
    });
    if (!client) throw new HttpError(404, 'client_not_found', 'Client not found');
    res.json(await computePortalReadiness(client.id));
  } catch (err) {
    next(err);
  }
});
