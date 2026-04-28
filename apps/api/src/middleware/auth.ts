import type { Request, Response, NextFunction } from 'express';
import { HUMAN_ROLES, type Capability, hasCapability } from '@alto-people/shared';
import { env } from '../config/env.js';
import { prisma } from '../db.js';
import { verifySession } from '../lib/jwt.js';
import { profilePhotoUrlFor } from '../lib/profilePhotoUrl.js';

export const SESSION_COOKIE = env.NODE_ENV === 'production'
  ? '__Host-alto.session'
  : 'alto.session';

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
      req.sessionStale = true;
      return next();
    }

    const { associate, ...rest } = user;
    req.user = {
      ...rest,
      firstName: associate?.firstName ?? null,
      lastName: associate?.lastName ?? null,
      photoUrl: associate ? profilePhotoUrlFor(associate) : null,
    };
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
