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
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { scopeClients } from '../lib/scope.js';
import { enqueueAudit, recordCriticalAudit } from '../lib/audit.js';
import { seedDefaultShiftPositions } from '../lib/shiftPositions.js';
import { computeStatementSnapshot, type StatementSnapshot } from '../lib/clientStatement.js';
import { renderStatementPdf } from '../lib/statementPdf.js';
import { ensureBrandingLoaded } from '../lib/branding.js';

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
    (req.user?.role === 'SHIFT_SUPERVISOR' || req.user?.role === 'CLIENT_PORTAL')
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
const CLIENTS_MAX_PAGE_SIZE = 500;

clientsRouter.get('/', async (req, res, next) => {
  try {
    const where: Prisma.ClientWhereInput = scopeClients(req.user!);
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

    // Three batched aggregates regardless of N — no per-row queries.
    const [appCounts, approvedCounts, lastPayrolls] = ids.length
      ? await Promise.all([
          prisma.application.groupBy({
            by: ['clientId'],
            where: {
              clientId: { in: ids },
              status: { not: 'REJECTED' },
              deletedAt: null,
            },
            _count: { _all: true },
          }),
          prisma.application.groupBy({
            by: ['clientId'],
            where: {
              clientId: { in: ids },
              status: 'APPROVED',
              deletedAt: null,
            },
            _count: { _all: true },
          }),
          prisma.payrollRun.groupBy({
            by: ['clientId'],
            where: { clientId: { in: ids }, disbursedAt: { not: null } },
            _max: { disbursedAt: true },
          }),
        ])
      : [[], [], []];

    const appCountByClient = new Map<string, number>();
    for (const r of appCounts) {
      if (r.clientId) appCountByClient.set(r.clientId, r._count._all);
    }
    const approvedCountByClient = new Map<string, number>();
    for (const r of approvedCounts) {
      if (r.clientId) approvedCountByClient.set(r.clientId, r._count._all);
    }
    const lastPayrollByClient = new Map<string, Date | null>();
    for (const r of lastPayrolls) {
      if (r.clientId) lastPayrollByClient.set(r.clientId, r._max.disbursedAt);
    }

    const clients: ClientListItem[] = rows.map((row) => ({
      ...toSummary(row),
      openApplications: appCountByClient.get(row.id) ?? 0,
      activeAssociateCount: approvedCountByClient.get(row.id) ?? 0,
      lastPayrollDisbursedAt:
        lastPayrollByClient.get(row.id)?.toISOString() ?? null,
    }));
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
      await prisma.location.create({
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
    res.status(201).json(toSummary(created));
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
      where: { ...scopeClients(req.user!), id: req.params.id },
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
    if (Object.keys(data).length === 0) {
      res.json(toSummary(existing));
      return;
    }

    const updated = await prisma.client.update({
      where: { id: existing.id },
      data,
    });
    await auditClient(req, 'client.updated', updated.id, {
      changed: Object.keys(data),
    });
    res.json(toSummary(updated));
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
      where: { ...scopeClients(req.user!), id: req.params.id },
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
      where: { ...scopeClients(req.user!), id: req.params.id },
    });
    if (!row) {
      throw new HttpError(404, 'client_not_found', 'Client not found');
    }
    res.json(toSummary(row));
  } catch (err) {
    next(err);
  }
});

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
      where: { AND: [scopeClients(req.user!), { id: req.params.id }] },
      select: { id: true },
    });
    if (!client) {
      throw new HttpError(404, 'client_not_found', 'Client not found');
    }
    const includeInactive =
      typeof req.query.includeInactive === 'string' &&
      req.query.includeInactive.toLowerCase() === 'true';
    const rows = await prisma.location.findMany({
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
      clientId: r.clientId,
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
      where: { ...scopeClients(req.user!), id: req.params.id },
      select: { id: true },
    });
    if (!client) throw new HttpError(404, 'client_not_found', 'Client not found');
    const input = LocationCreateInputSchema.parse(req.body);
    const geo = normalizeGeofence(input);
    const created = await prisma.location.create({
      data: {
        clientId: client.id,
        name: input.name,
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
      where: { ...scopeClients(req.user!), id: req.params.id },
      select: { id: true },
    });
    if (!client) throw new HttpError(404, 'client_not_found', 'Client not found');
    const existing = await prisma.location.findFirst({
      where: { id: req.params.lid, clientId: client.id, deletedAt: null },
    });
    if (!existing) {
      throw new HttpError(404, 'location_not_found', 'Location not found');
    }
    const input = LocationUpdateInputSchema.parse(req.body);
    const geo = normalizeGeofence(input);
    const updated = await prisma.location.update({
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
      where: { ...scopeClients(req.user!), id: req.params.id },
      select: { id: true },
    });
    if (!client) throw new HttpError(404, 'client_not_found', 'Client not found');
    const existing = await prisma.location.findFirst({
      where: { id: req.params.lid, clientId: client.id, deletedAt: null },
      select: { id: true },
    });
    if (!existing) {
      throw new HttpError(404, 'location_not_found', 'Location not found');
    }
    await prisma.location.update({
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
  clientId: string;
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
}): ClientSummary {
  return {
    id: row.id,
    name: row.name,
    industry: row.industry,
    status: row.status,
    contactEmail: row.contactEmail,
    state: row.state,
    weekStartsOn: row.weekStartsOn,
    fieldglassSiteName: row.fieldglassSiteName,
    fieldglassBillRate:
      row.fieldglassBillRate == null ? null : Number(row.fieldglassBillRate),
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
      where: { ...scopeClients(req.user!), id: req.params.id },
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
    res.json(toSummary(updated));
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

const STATEMENTS = requireCapability('process:payroll');

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
}) {
  return {
    id: r.id,
    clientId: r.clientId,
    periodStart: r.periodStart.toISOString().slice(0, 10),
    periodEnd: r.periodEnd.toISOString().slice(0, 10),
    number: r.number,
    status: r.status,
    snapshot: r.snapshot as StatementSnapshot,
    finalizedAt: r.finalizedAt?.toISOString() ?? null,
    finalizedByEmail: r.finalizedBy?.email ?? null,
  };
}

clientsRouter.get('/:id/statements', STATEMENTS, async (req, res, next) => {
  try {
    const rows = await prisma.clientStatement.findMany({
      where: { clientId: req.params.id },
      orderBy: [{ periodStart: 'desc' }],
      take: 60,
      include: { finalizedBy: { select: { email: true } } },
    });
    res.json({ statements: rows.map(statementRow) });
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
      where: { id: req.params.id, deletedAt: null },
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
    const user = req.user!;
    const row = await prisma.clientStatement.findFirst({
      where: { id: req.params.sid, clientId: req.params.id },
    });
    if (!row) throw new HttpError(404, 'not_found', 'Statement not found');
    if (row.status === 'FINAL') {
      throw new HttpError(409, 'already_final', 'Already finalized.');
    }
    // Record-then-commit: a numbered billing artifact must never exist
    // without a durable record of who issued it.
    const updated = await prisma.$transaction(async (tx) => {
      const max = await tx.clientStatement.aggregate({ _max: { number: true } });
      return tx.clientStatement.update({
        where: { id: row.id },
        data: {
          status: 'FINAL',
          number: (max._max.number ?? 0) + 1,
          finalizedById: user.id,
          finalizedAt: new Date(),
        },
        include: { finalizedBy: { select: { email: true } } },
      });
    });
    await recordCriticalAudit(
      {
        actorUserId: user.id,
        clientId: row.clientId,
        action: 'clients.statement_finalized',
        entityType: 'ClientStatement',
        entityId: row.id,
        metadata: {
          number: updated.number,
          periodStart: row.periodStart.toISOString().slice(0, 10),
          periodEnd: row.periodEnd.toISOString().slice(0, 10),
        },
      },
      'clients.statement_finalized',
    );
    res.json(statementRow(updated));
  } catch (err) {
    next(err);
  }
});

// CSV twin of the PDF — the shape AP teams paste into their own sheets.
clientsRouter.get('/:id/statements/:sid.csv', STATEMENTS, async (req, res, next) => {
  try {
    const row = await prisma.clientStatement.findFirst({
      where: { id: req.params.sid, clientId: req.params.id },
    });
    if (!row) throw new HttpError(404, 'not_found', 'Statement not found');
    const s = row.snapshot as unknown as StatementSnapshot;
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

clientsRouter.get('/:id/statements/:sid.pdf', STATEMENTS, async (req, res, next) => {
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
