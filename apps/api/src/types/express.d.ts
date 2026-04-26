import type { Role, UserStatus } from '@prisma/client';

export interface SessionUser {
  id: string;
  email: string;
  role: Role;
  status: UserStatus;
  clientId: string | null;
  associateId: string | null;
  tokenVersion: number;
}

declare global {
  namespace Express {
    interface Request {
      user?: SessionUser;
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
