import { Router } from 'express';
import type { Request } from 'express';
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
} from '@alto-people/shared';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { scopeClients } from '../lib/scope.js';
import { enqueueAudit } from '../lib/audit.js';

export const clientsRouter = Router();

const MANAGE = requireCapability('manage:clients');

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

    const rows = await prisma.client.findMany({
      take: 1000,
      where,
      orderBy: { name: 'asc' },
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
    const payload: ClientListResponse = { clients };
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
      },
    });
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
    const client = await prisma.client.findFirst({
      where: { ...scopeClients(req.user!), id: req.params.id },
      select: { id: true },
    });
    if (!client) {
      throw new HttpError(404, 'client_not_found', 'Client not found');
    }
    const includeInactive =
      typeof req.query.includeInactive === 'string' &&
      req.query.includeInactive.toLowerCase() === 'true';
    const rows = await prisma.location.findMany({
      where: {
        clientId: client.id,
        deletedAt: null,
        ...(includeInactive ? {} : { isActive: true }),
      },
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
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
  };
}

function toSummary(row: {
  id: string;
  name: string;
  industry: string | null;
  status: 'ACTIVE' | 'INACTIVE' | 'PROSPECT';
  contactEmail: string | null;
  state: string | null;
}): ClientSummary {
  return {
    id: row.id,
    name: row.name,
    industry: row.industry,
    status: row.status,
    contactEmail: row.contactEmail,
    state: row.state,
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
