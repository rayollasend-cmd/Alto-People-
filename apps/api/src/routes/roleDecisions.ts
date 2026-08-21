import { Router, type Request, type Response } from 'express';
import type { Role } from '@alto-people/shared';
import { prisma } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { computeRoleDecisions } from '../lib/roleDecisions.js';

/**
 * GET /me/decisions — the signed-in user's own decision queue, generated
 * by capability and clamped to their client scope. Every role gets the
 * chairman's "Needs your decision" pattern, sized to their seat.
 */
export const roleDecisionsRouter = Router();

roleDecisionsRouter.get('/decisions', requireAuth, async (req: Request, res: Response) => {
  const u = req.user!;
  const decisions = await computeRoleDecisions(prisma, {
    id: u.id,
    role: u.role as Role,
    clientId: (u as { clientId?: string | null }).clientId ?? null,
    associateId: (u as { associateId?: string | null }).associateId ?? null,
  });
  res.json({ decisions });
});
