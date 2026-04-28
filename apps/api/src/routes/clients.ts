import { Router } from 'express';
import type { Request } from 'express';
import {
  ClientCreateInputSchema,
  ClientGeofenceInputSchema,
  ClientStateInputSchema,
  ClientStatusSchema,
  ClientUpdateInputSchema,
  type ClientListItem,
  type ClientListResponse,
  type ClientSummary,
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

/* ===== Geofence config (HR only) ======================================== */

clientsRouter.get('/:id/geofence', async (req, res, next) => {
  try {
    const row = await prisma.client.findFirst({
      where: { ...scopeClients(req.user!), id: req.params.id },
      select: { latitude: true, longitude: true, geofenceRadiusMeters: true },
    });
    if (!row) throw new HttpError(404, 'client_not_found', 'Client not found');
    res.json({
      latitude: row.latitude !== null ? Number(row.latitude) : null,
      longitude: row.longitude !== null ? Number(row.longitude) : null,
      geofenceRadiusMeters: row.geofenceRadiusMeters,
    });
  } catch (err) {
    next(err);
  }
});

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

clientsRouter.put('/:id/geofence', MANAGE, async (req, res, next) => {
  try {
    const parsed = ClientGeofenceInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const existing = await prisma.client.findFirst({
      where: { ...scopeClients(req.user!), id: req.params.id },
    });
    if (!existing) throw new HttpError(404, 'client_not_found', 'Client not found');

    const updated = await prisma.client.update({
      where: { id: existing.id },
      data: {
        latitude: parsed.data.latitude ?? null,
        longitude: parsed.data.longitude ?? null,
        geofenceRadiusMeters: parsed.data.geofenceRadiusMeters ?? null,
      },
      select: { latitude: true, longitude: true, geofenceRadiusMeters: true },
    });
    await auditClient(req, 'client.geofence_updated', existing.id, {
      cleared: parsed.data.latitude === null && parsed.data.longitude === null,
      radiusMeters: updated.geofenceRadiusMeters,
    });
    res.json({
      latitude: updated.latitude !== null ? Number(updated.latitude) : null,
      longitude: updated.longitude !== null ? Number(updated.longitude) : null,
      geofenceRadiusMeters: updated.geofenceRadiusMeters,
    });
  } catch (err) {
    next(err);
  }
});
