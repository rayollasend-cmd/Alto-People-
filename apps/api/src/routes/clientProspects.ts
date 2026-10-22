import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { ProspectInputSchema, ProspectUpdateSchema } from '@alto-people/shared';
import { HttpError } from '../middleware/error.js';
import { requireAnyCapability, requireCapability } from '../middleware/auth.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { isInternallyScoped } from '../lib/scope.js';
import {
  createProspect,
  deleteProspect,
  getProspectRow,
  listProspects,
  prospectAccess,
  prospectOwners,
  updateProspect,
} from '../lib/clientProspects.js';

/**
 * The new-business pipeline — Clients → Pipeline (/clients/pipeline).
 *
 *   GET    /client-prospects          the board: every prospect + header totals
 *   GET    /client-prospects/owners   who can own a prospect
 *   POST   /client-prospects          add one
 *   GET    /client-prospects/:id      one, as the board shapes it
 *   PATCH  /client-prospects/:id      edit, move a stage (LOST needs a reason;
 *                                     WON may link the client it became)
 *   DELETE /client-prospects/:id      remove (soft)
 *
 * Read: view:executive or manage:clients. Write: manage:clients. Money
 * (rate and values) only to callers who can read client money. Every read
 * and write is the caller's tenant. The pipeline is the whole company's new
 * business, so — like the executive layer it feeds — a client-bound or
 * store-bound account is turned away rather than shown it.
 */

export const clientProspectsRouter = Router();

const READ = requireAnyCapability('view:executive', 'manage:clients');
const WRITE = requireCapability('manage:clients');

const CLIENT_BOUND = new Set(['CLIENT_PORTAL', 'SHIFT_SUPERVISOR', 'FLOOR_SUPERVISOR', 'ASSOCIATE']);

clientProspectsRouter.use((req: Request, _res: Response, next: NextFunction) => {
  if (req.user && (CLIENT_BOUND.has(req.user.role) || isInternallyScoped(req.user))) {
    next(new HttpError(403, 'scope_too_narrow', 'The pipeline covers the whole company; your access is limited to certain sites.'));
    return;
  }
  next();
});

const idParam = (req: Request) => z.string().uuid().parse(req.params.id);

clientProspectsRouter.get('/', READ, async (req: Request, res: Response) => {
  res.json(await listProspects(tenantIdForWrite(), prospectAccess(req.user!)));
});

clientProspectsRouter.get('/owners', READ, async (_req: Request, res: Response) => {
  res.json({ owners: await prospectOwners(tenantIdForWrite()) });
});

clientProspectsRouter.get('/:id', READ, async (req: Request, res: Response) => {
  res.json(await getProspectRow(tenantIdForWrite(), idParam(req), prospectAccess(req.user!)));
});

clientProspectsRouter.post('/', WRITE, async (req: Request, res: Response) => {
  const input = ProspectInputSchema.parse(req.body);
  const created = await createProspect(tenantIdForWrite(), input, req.user!.id);
  res.status(201).json(created);
});

clientProspectsRouter.patch('/:id', WRITE, async (req: Request, res: Response) => {
  const id = idParam(req);
  const input = ProspectUpdateSchema.parse(req.body);
  const tenantId = tenantIdForWrite();
  await updateProspect(tenantId, id, input, req.user!.id);
  res.json(await getProspectRow(tenantId, id, prospectAccess(req.user!)));
});

clientProspectsRouter.delete('/:id', WRITE, async (req: Request, res: Response) => {
  await deleteProspect(tenantIdForWrite(), idParam(req), req.user!.id);
  res.json({ ok: true });
});
