import type { NextFunction, Request, Response } from 'express';
import { noteUserActive, recordRequest, routePattern } from '../lib/usageTracker.js';

/**
 * Counts a request after it has finished, so nothing here is on the path
 * to a response.
 *
 * It hooks 'finish' rather than wrapping res.end: by the time the event
 * fires the status code is final, the route has been resolved (so
 * `req.route` exists and the pattern is available), and the client already
 * has its bytes — anything this does costs the user nothing.
 *
 * Mounted after auth so `req.user` is populated, and after the routers
 * would have matched. Requests that matched no route are counted as
 * traffic under no key at all — a 404 on a random path is not a fact worth
 * storing, and storing it would mean storing the path.
 */
export function usageTracking(req: Request, res: Response, next: NextFunction): void {
  const startedAt = process.hrtime.bigint();
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    try {
      const ms = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      const route = routePattern(req);
      if (route) recordRequest(req.method, route, res.statusCode, ms);
      const user = req.user;
      if (user?.id) noteUserActive(user.id, user.role);
    } catch {
      // A counter must never be the reason a response goes wrong.
    }
  };
  res.on('finish', finish);
  // A client that hangs up mid-response still consumed the work.
  res.on('close', finish);
  next();
}
