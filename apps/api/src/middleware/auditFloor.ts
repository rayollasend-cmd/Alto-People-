import type { NextFunction, Request, Response } from 'express';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { logger } from '../lib/logger.js';
import { auditRequestStore, type AuditRequestState } from '../lib/auditRequestContext.js';
import { tenantIdForWrite } from '../lib/tenant.js';

/**
 * Brief 2-3, step 1 — the audit floor.
 *
 *   Every data-changing request (POST, PUT, PATCH, DELETE) and every export
 *   writes one AuditLog row: actor, tenant, method, route, the record it
 *   named, and the outcome (status). The row is written before the
 *   response ends (awaited, decision 7), so a crash cannot lose it once
 *   the caller has seen success.
 *
 *   A request that already wrote its own, richer audit row (enqueueAudit,
 *   recordCriticalAudit, a direct insert, the agent API's recorder) is
 *   marked through lib/auditRequestContext and gets no floor row: one row
 *   per request, never two.
 *
 *   Never a body value: the row names the fields the request sent, not
 *   what they held (no SSN, bank, tax id, password, token or I-9 data can
 *   reach it). Before/after values with masking are step 4.
 *
 *   An export is a GET whose response is a file: an attachment, or CSV,
 *   PDF, ZIP or spreadsheet content.
 */

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Machine chatter that changes no business data: browser vitals and passkey challenge issuance. */
const SKIP_PREFIXES = ['/telemetry/', '/health'];
const SKIP_EXACT = new Set(['/auth/webauthn/login/options', '/auth/webauthn/register/options']);

const EXPORT_TYPE = /^(text\/csv|application\/pdf|application\/zip|application\/x-zip-compressed|application\/vnd\.openxmlformats|application\/vnd\.ms-excel)/i;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FIELDS = 40;

/** The request path without the /api prefix or query, with ids folded to :id — the route as a pattern. */
export function routePattern(originalUrl: string): { route: string; ids: string[] } {
  const path = (originalUrl.split('?')[0] ?? '/').replace(/^\/api(?=\/|$)/, '') || '/';
  const ids = path.match(UUID) ?? [];
  const route = path
    .split('/')
    .map((seg) => (UUID_SEGMENT.test(seg) || /^\d+$/.test(seg) ? ':id' : seg))
    .join('/');
  return { route, ids: ids.map((i) => i.toLowerCase()) };
}

function isExport(res: Response): boolean {
  const disposition = String(res.getHeader('content-disposition') ?? '');
  if (/attachment/i.test(disposition)) return true;
  return EXPORT_TYPE.test(String(res.getHeader('content-type') ?? ''));
}

/** The row this request owes, or null when it owes none. */
export function floorRow(req: Request, res: Response, state: AuditRequestState): Prisma.AuditLogUncheckedCreateInput | null {
  if (state.audited) return null;
  const method = req.method.toUpperCase();
  const mutating = MUTATING.has(method);
  const status = res.statusCode;
  const exporting = !mutating && method === 'GET' && status >= 200 && status < 300 && isExport(res);
  if (!mutating && !exporting) return null;
  const { route, ids } = routePattern(req.originalUrl);
  if (SKIP_EXACT.has(route) || SKIP_PREFIXES.some((p) => route.startsWith(p))) return null;
  // No route matched (a scanner's 404), or an unauthenticated write bounced at the door: nothing changed.
  if (status === 404 && !req.route) return null;
  if (status === 401 && !req.user) return null;
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : null;
  const query = req.query && typeof req.query === 'object' ? Object.keys(req.query) : [];
  const metadata: Record<string, unknown> = {
    method,
    route,
    status,
    requestId: req.id ?? null,
    via: req.apiClient ? 'api_client' : req.apiKey ? 'api_key' : req.user ? 'session' : 'none',
  };
  if (req.apiKey) metadata.apiKeyId = req.apiKey.id;
  // Brief 2-4: a /v1 client acts with a named human owner.
  if (req.apiClient) metadata.ownerUserId = req.apiClient.ownerUserId;
  if (ids.length > 1) metadata.ids = ids.slice(0, 5);
  if (body) metadata.fields = Object.keys(body).slice(0, MAX_FIELDS);
  if (exporting) {
    metadata.query = query.slice(0, MAX_FIELDS);
    metadata.contentType = String(res.getHeader('content-type') ?? '').split(';')[0] || null;
  }
  return {
    actorUserId: req.user?.id ?? null,
    apiClientId: req.apiClient?.id ?? null,
    clientId: req.user?.clientId ?? null,
    tenantId: tenantIdForWrite(),
    action: exporting ? 'http.export' : `http.${method.toLowerCase()}`,
    entityType: 'HttpRequest',
    entityId: ids[0] ?? route,
    metadata: metadata as Prisma.InputJsonValue,
  };
}

/**
 * Mounted once in app.ts, after the session and the tenant are known and
 * before any router. GETs pass straight through unless they turn out to be
 * a file; nothing is read or written for an ordinary page load.
 */
export function auditFloor(req: Request, res: Response, next: NextFunction): void {
  if (req.method === 'OPTIONS' || req.method === 'HEAD') {
    next();
    return;
  }
  const state: AuditRequestState = { audited: false };
  const originalEnd = res.end;
  let ending = false;
  let pending = false;
  res.end = function auditedEnd(this: Response, ...args: unknown[]) {
    // A second end while the first waits on its audit row would race it (a
    // handler that responded, then threw): the first response stands.
    if (pending) return this;
    if (ending) return (originalEnd as (...a: unknown[]) => Response).apply(this, args);
    ending = true;
    let row: Prisma.AuditLogUncheckedCreateInput | null = null;
    try {
      row = floorRow(req, res, state);
    } catch (err) {
      logger.error({ err, path: req.originalUrl }, 'audit floor: could not build the row');
    }
    if (!row) return (originalEnd as (...a: unknown[]) => Response).apply(this, args);
    // Awaited before the response completes (decision 7). A failed insert is
    // logged loudly and the response still goes out: the work is already done.
    pending = true;
    prisma.auditLog
      .create({ data: row })
      .catch((err) => logger.error({ err, path: req.originalUrl, audit: 'floor' }, 'audit floor insert failed'))
      .finally(() => {
        pending = false;
        (originalEnd as (...a: unknown[]) => Response).apply(this, args);
      });
    return this;
  } as typeof res.end;
  auditRequestStore.run(state, () => next());
}
