import { Router } from 'express';
import {
  ClientGeofenceInputSchema,
  type ClientListResponse,
  type ClientSummary,
} from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { scopeClients } from '../lib/scope.js';

export const clientsRouter = Router();

const MANAGE = requireCapability('manage:clients');

clientsRouter.get('/', async (req, res, next) => {
  try {
    const rows = await prisma.client.findMany({
      where: scopeClients(req.user!),
      orderBy: { name: 'asc' },
    });
    const payload: ClientListResponse = { clients: rows.map(toSummary) };
    res.json(payload);
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
}): ClientSummary {
  return {
    id: row.id,
    name: row.name,
    industry: row.industry,
    status: row.status,
    contactEmail: row.contactEmail,
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
      latitude: row.latitude ? Number(row.latitude) : null,
      longitude: row.longitude ? Number(row.longitude) : null,
      geofenceRadiusMeters: row.geofenceRadiusMeters,
    });
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
    res.json({
      latitude: updated.latitude ? Number(updated.latitude) : null,
      longitude: updated.longitude ? Number(updated.longitude) : null,
      geofenceRadiusMeters: updated.geofenceRadiusMeters,
    });
  } catch (err) {
    next(err);
  }
});
