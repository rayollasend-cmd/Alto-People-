import type { Request, Response, NextFunction } from 'express';
import { HUMAN_ROLES, type Capability, hasCapability } from '@alto-people/shared';
import { env } from '../config/env.js';
import { prisma } from '../db.js';
import { verifySession } from '../lib/jwt.js';
import { profilePhotoUrlFor } from '../lib/profilePhotoUrl.js';

export const SESSION_COOKIE = env.NODE_ENV === 'production'
  ? '__Host-alto.session'
  : 'alto.session';

// ---------------------------------------------------------------------------
// In-process user cache
//
// Without this, every authenticated request ran a Prisma `findFirst` to
// re-confirm the user exists / is active / token version matches. At hundreds
// of users navigating an SPA that fires multiple API calls per page, the
// cumulative DB load (and the per-request 5-15ms latency) was the dominant
// cost of `attachUser`.
//
// The cache is keyed by userId and stores the fully-built `SessionUser` so a
// hit lets us skip both the DB roundtrip and the post-fetch reshape. Stale
// data falls out two ways:
//   1) tokenVersion mismatch — when invite-accept or change-password bumps
//      the version, the *new* JWT carries the *new* ver. Cached.tokenVersion
//      will mismatch the incoming payload.ver, so we drop straight through
//      to the DB lookup that refreshes the cache. No explicit invalidation
//      needed for those flows.
//   2) TTL — 30 seconds. After that we re-fetch even on a hit. This bounds
//      how stale a *non-tokenVersion-bumping* mutation can be: e.g. an admin
//      disabling a user by setting `status = INACTIVE` (which doesn't bump
//      tokenVersion in this codebase) propagates within 30s.
//
// Where stricter freshness is needed, callers can `invalidateUserCache(id)`
// to drop the entry immediately. Logout does this defensively, and the
// profile-update route does it so the new name/photo show on the next nav
// instead of after the TTL.
//
// Single-process Express today; in a multi-process deploy each process has
// its own cache, which is fine — the 30s TTL bounds divergence.
// ---------------------------------------------------------------------------

type SessionUser = NonNullable<Express.Request['user']>;

interface CachedUser {
  user: SessionUser;
  expiresAt: number;
}

const USER_CACHE_TTL_MS = 30_000;
const userCache = new Map<string, CachedUser>();

export function invalidateUserCache(userId: string) {
  userCache.delete(userId);
}

// Periodic prune so the map can't grow unbounded under user churn (rare on a
// 500-user app, but cheap insurance). `.unref()` so the timer doesn't keep
// the Node process alive in tests / shutdown.
const pruneTimer = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of userCache) {
    if (v.expiresAt <= now) userCache.delete(k);
  }
}, 60_000);
if (typeof pruneTimer.unref === 'function') pruneTimer.unref();

/**
 * Always-on middleware. If a session cookie is present and valid, attaches
 * `req.user`. If the cookie is present but the token / user is invalid,
 * sets `req.sessionStale = true` so `/auth/me` can return 401-clear.
 * Routes other than `/auth/me` should call `requireAuth` to enforce.
 */
export async function attachUser(
  req: Request,
  _res: Response,
  next: NextFunction
) {
  try {
    const raw = req.cookies?.[SESSION_COOKIE] as string | undefined;
    if (!raw) return next();

    const payload = verifySession(raw);
    if (!payload) {
      req.sessionStale = true;
      return next();
    }

    // Fast path — cache hit and tokenVersion still matches the JWT. Skips
    // the DB round-trip entirely.
    const cached = userCache.get(payload.sub);
    if (
      cached &&
      cached.expiresAt > Date.now() &&
      cached.user.tokenVersion === payload.ver
    ) {
      req.user = cached.user;
      return next();
    }

    const user = await prisma.user.findFirst({
      where: { id: payload.sub, deletedAt: null },
      select: {
        id: true,
        email: true,
        role: true,
        status: true,
        clientId: true,
        associateId: true,
        tokenVersion: true,
        associate: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            photoS3Key: true,
            photoUpdatedAt: true,
          },
        },
      },
    });

    if (
      !user ||
      user.status !== 'ACTIVE' ||
      user.tokenVersion !== payload.ver ||
      !HUMAN_ROLES.includes(user.role)
    ) {
      // Drop any stale entry so a follow-up request doesn't cache-hit the
      // pre-invalid version we (correctly) just rejected.
      userCache.delete(payload.sub);
      req.sessionStale = true;
      return next();
    }

    const { associate, ...rest } = user;
    const sessionUser: SessionUser = {
      ...rest,
      firstName: associate?.firstName ?? null,
      lastName: associate?.lastName ?? null,
      photoUrl: associate ? profilePhotoUrlFor(associate) : null,
    };
    userCache.set(payload.sub, {
      user: sessionUser,
      expiresAt: Date.now() + USER_CACHE_TTL_MS,
    });
    req.user = sessionUser;
    next();
  } catch (err) {
    next(err);
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    res.status(401).json({
      error: { code: 'unauthenticated', message: 'Authentication required' },
    });
    return;
  }
  next();
}

export function requireCapability(...caps: Capability[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({
        error: { code: 'unauthenticated', message: 'Authentication required' },
      });
      return;
    }
    const missing = caps.find((c) => !hasCapability(req.user!.role, c));
    if (missing) {
      res.status(403).json({
        error: {
          code: 'forbidden',
          message: `Missing capability: ${missing}`,
        },
      });
      return;
    }
    next();
  };
}
