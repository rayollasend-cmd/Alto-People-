import { randomUUID } from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { makeRequestLogger } from '../lib/logger.js';

/**
 * Tag every request with a UUID so logs, error responses, and audit rows
 * can be correlated. Forwards an inbound `X-Request-Id` if present (so an
 * upstream load balancer / proxy gets to set the trace ID), otherwise mints
 * a fresh one. The ID is:
 *
 *   - exposed on the response as `X-Request-Id` so curl / browser devtools
 *     show it without parsing the JSON body
 *   - copied into `HttpError` JSON responses by `errorHandler`
 *   - included in audit metadata so a single trace ties handler → DB →
 *     AuditLog row
 *
 * UUIDs are big but cheap; the alternative (sequential counter) couples
 * replicas and risks collision on restart, neither of which is worth the
 * smaller string.
 *
 * Inbound IDs are sanity-checked: max 128 chars, only [A-Za-z0-9._-], else
 * we discard and mint our own. Without this an attacker could smuggle CRLF
 * into the response header or pollute the audit log with arbitrary text.
 */

const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

export function requestId(req: Request, res: Response, next: NextFunction) {
  const inbound = req.headers['x-request-id'];
  const candidate = Array.isArray(inbound) ? inbound[0] : inbound;
  const id = candidate && SAFE_ID.test(candidate) ? candidate : randomUUID();
  req.id = id;
  // Attach a child logger so route handlers can call req.log.info({...},
  // 'message') without redundantly threading the requestId through every
  // log call. userId is filled in lazily — attachUser hasn't run yet
  // when requestId fires, so we re-bind once req.user is available.
  req.log = makeRequestLogger({
    requestId: id,
    method: req.method,
    path: req.path,
  });
  res.setHeader('X-Request-Id', id);
  next();
}
