import type { NextFunction, Request, Response } from 'express';
import type { ApiScope } from '@alto-people/shared';
import { prisma } from '../db.js';
import { verifyToken } from '../lib/apiClients.js';
import { runWithTenant } from '../lib/tenant.js';

/**
 * Brief 2-4 step 1 — the /v1 bearer token.
 *
 *   Verifies the 15-minute JWT, then re-reads the client: revoked, expired or
 *   moved to another tenant and the request is refused, whatever the token
 *   says. The token's scopes are narrowed by the client's current scopes (a
 *   scope removed today stops today). The request then runs in the client's
 *   tenant. Errors use the API's envelope; a missing scope is 403
 *   insufficient_scope naming it.
 */

function refuse(res: Response, status: 401 | 403, code: string, message: string): void {
  if (status === 401) res.setHeader('WWW-Authenticate', `Bearer error="${code === 'insufficient_scope' ? 'insufficient_scope' : 'invalid_token'}"`);
  res.status(status).json({ error: { code, message } });
}

const lastTouched = new Map<string, number>();

export function requireApiToken(scopes: readonly ApiScope[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const m = /^Bearer\s+(\S+)$/i.exec(req.header('authorization') ?? '');
      if (!m) return refuse(res, 401, 'unauthenticated', 'A bearer token from POST /v1/oauth/token is required.');
      const claims = verifyToken(m[1]!);
      if (!claims) return refuse(res, 401, 'invalid_token', 'The token is invalid or expired.');
      const client = await prisma.apiClient.findUnique({ where: { id: claims.sub }, select: { id: true, clientId: true, name: true, scopes: true, ownerUserId: true, tenantId: true, status: true, expiresAt: true } });
      const now = new Date();
      if (!client || client.status !== 'ACTIVE' || (client.expiresAt && client.expiresAt <= now) || (client.tenantId ?? '') !== claims.tid) {
        return refuse(res, 401, 'invalid_token', 'The client is revoked or no longer valid.');
      }
      const granted = new Set(claims.scope.split(' ').filter((s) => client.scopes.includes(s)));
      const missing = scopes.find((s) => !granted.has(s));
      if (missing) return refuse(res, 403, 'insufficient_scope', `This client was not granted ${missing}.`);
      req.apiClient = { id: client.id, clientId: client.clientId, name: client.name, scopes: [...granted] as ApiScope[], ownerUserId: client.ownerUserId, tenantId: claims.tid };
      // lastUsedAt at most once a minute per client: one write, not one per request.
      if ((lastTouched.get(client.id) ?? 0) < now.getTime() - 60_000) {
        lastTouched.set(client.id, now.getTime());
        void prisma.apiClient.update({ where: { id: client.id }, data: { lastUsedAt: now } }).catch(() => {});
      }
      await runWithTenant(claims.tid, 'api-client', () => next());
    } catch (err) {
      next(err);
    }
  };
}
