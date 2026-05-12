import type { Role, UserStatus } from '@prisma/client';
import type { Capability } from '@alto-people/shared';
import type { RequestLogger } from '../lib/logger.js';

export interface SessionUser {
  id: string;
  email: string;
  role: Role;
  status: UserStatus;
  clientId: string | null;
  associateId: string | null;
  tokenVersion: number;
  firstName: string | null;
  lastName: string | null;
  photoUrl: string | null;
  timezone: string | null;
  mfaEnabled: boolean;
}

/**
 * Authenticated API-key context. Set by `requireApiKey` middleware on
 * /integrations/v1/* requests. Distinct from `req.user` (cookie session)
 * so route handlers can't accidentally mix the two surfaces.
 */
export interface ApiKeyContext {
  id: string;
  /** null => global key (sees every client). Non-null => store-scoped. */
  clientId: string | null;
  capabilities: Capability[];
  name: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: SessionUser;
      apiKey?: ApiKeyContext;
      /**
       * Set by `attachUser` when the request had a session cookie that
       * was malformed, expired, or pointed at a now-invalid user.
       * `/auth/me` uses this to distinguish "no cookie" (200 with null)
       * from "stale cookie" (401, signal client to clear).
       */
      sessionStale?: boolean;
      /**
       * Per-request correlation ID, set by the `requestId` middleware.
       * Echoed back as the `X-Request-Id` response header and surfaced
       * in error bodies + AuditLog metadata so a single trace ties
       * client report → middleware → handler → DB write together.
       */
      id: string;
      /**
       * Per-request structured logger, also set by `requestId`. Already
       * bound with { requestId, method, path } so `req.log.info({...})`
       * lines correlate to the trace automatically.
       */
      log: RequestLogger;
    }
  }
}
