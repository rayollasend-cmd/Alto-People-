import type { Request, Response, NextFunction } from 'express';
import type { Capability } from '@alto-people/shared';
import { prisma } from '../db.js';
import { verifyPassword } from '../lib/passwords.js';

/**
 * Bearer-token auth for the public integration API (e.g. AltoHR / ShiftReport
 * Nexus). Validates `Authorization: Bearer altop_<hex>`, looks up the
 * matching un-revoked / un-expired ApiKey row, and bcrypt-verifies the
 * presented plaintext against `keyHash`. On success, attaches
 * `req.apiKey = { id, clientId, capabilities, name }` and bumps
 * `lastUsedAt` (best-effort, fire-and-forget) so admins can spot stale
 * keys.
 *
 * Why the disambiguating `last4` lookup: ApiKey.keyHash is bcrypt, which
 * is intentionally slow and not searchable, so we can't `findFirst({ keyHash })`.
 * The plaintext encodes `last4` (the final 4 chars of the random body)
 * which we extract from the bearer and use to narrow candidates before
 * running the (slow) bcrypt verify on each. With 16^4 = 65k buckets and
 * a sane number of total keys, this is effectively a single bcrypt call
 * per request.
 *
 * Failure modes intentionally collapse to a generic 401 so a probing
 * client can't distinguish "no such key" from "wrong secret" from
 * "revoked" — same defense rationale as the login endpoint.
 */

export const KEY_PREFIX = 'altop_';

interface PerformOpts {
  /** Required capabilities; the request is rejected if any are missing. */
  capabilities: Capability[];
}

function unauthorized(res: Response, code = 'unauthenticated'): void {
  res.status(401).json({
    error: { code, message: 'Invalid or missing API key.' },
  });
}

function forbidden(res: Response, missing: Capability): void {
  res.status(403).json({
    error: {
      code: 'forbidden',
      message: `API key is missing capability: ${missing}`,
    },
  });
}

/**
 * Higher-order middleware factory. Use as
 *   router.use(requireApiKey({ capabilities: ['asn:read:schedule'] }))
 * or per-route on a single endpoint.
 */
export function requireApiKey(opts: PerformOpts) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const header = req.header('authorization') ?? '';
      const match = /^Bearer\s+(\S+)$/i.exec(header);
      if (!match) return unauthorized(res);
      const presented = match[1];

      if (!presented.startsWith(KEY_PREFIX)) {
        return unauthorized(res);
      }
      const body = presented.slice(KEY_PREFIX.length);
      // 32 random bytes hex = 64 chars. Reject anything that doesn't fit
      // the shape we mint, so we never even hash a malformed string.
      if (!/^[0-9a-f]{64}$/.test(body)) {
        return unauthorized(res);
      }
      const last4 = body.slice(-4);

      const candidates = await prisma.apiKey.findMany({
        where: {
          last4,
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        select: {
          id: true,
          clientId: true,
          capabilities: true,
          keyHash: true,
          name: true,
        },
      });

      let matched: (typeof candidates)[number] | null = null;
      for (const c of candidates) {
        // verifyPassword uses constant-time bcrypt compare under the hood.
        if (await verifyPassword(c.keyHash, presented)) {
          matched = c;
          break;
        }
      }
      if (!matched) return unauthorized(res);

      // Capability check.
      const caps = matched.capabilities as Capability[];
      const missing = opts.capabilities.find((c) => !caps.includes(c));
      if (missing) return forbidden(res, missing);

      req.apiKey = {
        id: matched.id,
        clientId: matched.clientId,
        capabilities: caps,
        name: matched.name,
      };

      // Best-effort last-used bump. Don't await — the response shouldn't
      // wait on it, and failure to update is non-fatal.
      void prisma.apiKey
        .update({
          where: { id: matched.id },
          data: { lastUsedAt: new Date() },
        })
        .catch(() => {});

      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Per-handler capability assertion when the route is mounted under a
 * router that already validated the bearer (e.g. you used a permissive
 * `requireApiKey({ capabilities: [] })` at the router level). Most
 * callers should pass the capability up-front to `requireApiKey`
 * instead — this helper exists for cases where one router serves
 * endpoints that need different capabilities.
 */
export function requireApiKeyCapability(...caps: Capability[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.apiKey) return unauthorized(res);
    const have = req.apiKey.capabilities;
    const missing = caps.find((c) => !have.includes(c));
    if (missing) return forbidden(res, missing);
    next();
  };
}

/**
 * Helper for store-scoped routes. Returns the storeId the caller is
 * allowed to read, or null if scoping should reject. The route should
 * 404 (not 403) on a mismatch so a store-scoped key can't enumerate
 * which storeIds exist on the platform.
 */
export function resolveStoreScope(
  req: Request,
  requestedStoreId: string,
): { ok: true; storeId: string } | { ok: false } {
  const apiKey = req.apiKey;
  if (!apiKey) return { ok: false };
  // Global key — can read any store.
  if (apiKey.clientId === null) return { ok: true, storeId: requestedStoreId };
  // Scoped key — only its own store.
  if (apiKey.clientId === requestedStoreId) {
    return { ok: true, storeId: requestedStoreId };
  }
  return { ok: false };
}
