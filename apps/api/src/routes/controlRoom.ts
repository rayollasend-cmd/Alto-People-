import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireCapability } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { controlRoom, controlRoomSites } from '../lib/controlRoom.js';
import { tenantIdForWrite } from '../lib/tenant.js';

/**
 * Brief 3-3: the control room.
 *
 *   GET /control-room/sites            the sites a person may watch
 *   GET /control-room?locationId=      one site, live: people, robots, agents,
 *                                      exceptions, what waits, zones, span
 *
 * Reads need view:time-live (the floor's live view: supervisors and up, never an
 * associate, a driver or the client portal). Every action the page offers goes through
 * the record's own route (/robots/:id/stop, /tasks/:id/handoff, /agents…).
 */
export const controlRoomRouter = Router();

const VIEW = requireCapability('view:time-live');

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

/** Roles pinned to a site or a client see only that. */
function scopeOf(user: { role: string; clientId?: string | null; locationId?: string | null }): { clientId?: string | null; locationId?: string | null } {
  if (user.role === 'CLIENT_PORTAL' || user.role === 'SHIFT_SUPERVISOR' || user.role === 'FLOOR_SUPERVISOR') {
    return { clientId: user.clientId ?? null, locationId: user.locationId ?? null };
  }
  return {};
}

controlRoomRouter.get(
  '/sites',
  VIEW,
  wrap(async (req, res) => {
    const user = req.user as unknown as { role: string; clientId?: string | null; locationId?: string | null };
    res.json({ sites: await controlRoomSites(prisma, tenantIdForWrite(), scopeOf(user)) });
  }),
);

controlRoomRouter.get(
  '/',
  VIEW,
  wrap(async (req, res) => {
    const q = z.object({ locationId: z.string().uuid() }).safeParse(req.query);
    if (!q.success) throw new HttpError(400, 'location_required', 'Pick a site.');
    const user = req.user as unknown as { role: string; clientId?: string | null; locationId?: string | null };
    const scope = scopeOf(user);
    if (scope.locationId && scope.locationId !== q.data.locationId) throw new HttpError(403, 'forbidden', 'That site is not yours.');
    res.json(await controlRoom(prisma, q.data.locationId, tenantIdForWrite(), new Date()));
  }),
);
