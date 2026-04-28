import type { Role, UserStatus } from '@prisma/client';
import type { Capability } from '@alto-people/shared';

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
    }
  }
}
