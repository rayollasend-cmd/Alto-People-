import { Router } from 'express';
import type { ClientListResponse, ClientSummary } from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';

export const clientsRouter = Router();

clientsRouter.get('/', async (_req, res, next) => {
  try {
    const rows = await prisma.client.findMany({
      where: { deletedAt: null },
      orderBy: { name: 'asc' },
    });

    const payload: ClientListResponse = {
      clients: rows.map(toSummary),
    };
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

clientsRouter.get('/:id', async (req, res, next) => {
  try {
    const row = await prisma.client.findFirst({
      where: { id: req.params.id, deletedAt: null },
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
