import { Router } from 'express';
import { z } from 'zod';
import { ApiClientInputSchema } from '@alto-people/shared';
import { prisma } from '../db.js';
import { requireCapability } from '../middleware/auth.js';
import { createApiClient, listApiClients, revokeApiClient, rotateApiClient } from '../lib/apiClients.js';
import { tenantIdForWrite } from '../lib/tenant.js';

/**
 * Brief 2-4 step 1 — the admin side of /v1's OAuth clients, beside the API
 * keys on the Integrations page (view/manage:integrations, as the keys).
 *
 *   GET  /api-clients              this organization's clients (never a secret)
 *   POST /api-clients              a new client; the secret is in this answer only
 *   POST /api-clients/:id/rotate   a new secret; the old works five more minutes
 *   POST /api-clients/:id/revoke   stops at once, even for tokens already issued
 */

export const apiClientsRouter = Router();

const VIEW = requireCapability('view:integrations');
const MANAGE = requireCapability('manage:integrations');
const Id = z.string().uuid();

apiClientsRouter.get('/', VIEW, async (_req, res) => {
  res.json({ clients: await listApiClients(prisma, tenantIdForWrite()) });
});

apiClientsRouter.post('/', MANAGE, async (req, res) => {
  res.status(201).json(await createApiClient(prisma, tenantIdForWrite(), ApiClientInputSchema.parse(req.body), req.user!.id));
});

apiClientsRouter.post('/:id/rotate', MANAGE, async (req, res) => {
  res.json(await rotateApiClient(prisma, tenantIdForWrite(), Id.parse(req.params.id), req.user!.id));
});

apiClientsRouter.post('/:id/revoke', MANAGE, async (req, res) => {
  res.json({ client: await revokeApiClient(prisma, tenantIdForWrite(), Id.parse(req.params.id), req.user!.id) });
});
