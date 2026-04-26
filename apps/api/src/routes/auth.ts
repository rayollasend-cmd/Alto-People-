import { Router } from 'express';
import { z } from 'zod';
import { HUMAN_ROLES } from '@alto-people/shared';
import type { AuthUser } from '@alto-people/shared';
import { prisma } from '../db.js';
import { env } from '../config/env.js';
import { signSession } from '../lib/jwt.js';
import {
  verifyPassword,
  DUMMY_HASH,
} from '../lib/passwords.js';
import {
  recordLoginFailure,
  recordLoginSuccess,
  recordLogout,
} from '../lib/audit.js';
import { SESSION_COOKIE } from '../middleware/auth.js';
import {
  loginIpLimiter,
  loginEmailLimiter,
} from '../middleware/rateLimit.js';

export const authRouter = Router();

const LoginBodySchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(12).max(256),
});

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: env.NODE_ENV === 'production',
    path: '/',
    maxAge: env.JWT_TTL_SECONDS * 1000,
  };
}

const GENERIC_LOGIN_ERROR = {
  error: { code: 'invalid_credentials', message: 'Invalid email or password' },
};

function toAuthUser(u: {
  id: string;
  email: string;
  role: string;
  status: string;
  clientId: string | null;
  associateId: string | null;
}): AuthUser {
  return {
    id: u.id,
    email: u.email,
    role: u.role as AuthUser['role'],
    status: u.status as AuthUser['status'],
    clientId: u.clientId,
    associateId: u.associateId,
  };
}

/**
 * POST /auth/login
 * Generic 401 on every failure path. Always runs an argon2id verify
 * (against either the user's hash or DUMMY_HASH) so timing doesn't
 * distinguish unknown-email from wrong-password from disabled-user.
 */
authRouter.post(
  '/login',
  loginIpLimiter,
  loginEmailLimiter,
  async (req, res, next) => {
    try {
      const parsed = LoginBodySchema.safeParse(req.body);
      if (!parsed.success) {
        // Still consume time so length-of-input doesn't side-channel.
        await verifyPassword(DUMMY_HASH, 'invalid-input-pad-pad-pad');
        res.status(401).json(GENERIC_LOGIN_ERROR);
        return;
      }
      const email = parsed.data.email.trim().toLowerCase();
      const password = parsed.data.password;

      const user = await prisma.user.findFirst({
        where: { email, deletedAt: null },
      });

      // Pick the hash to verify against. If no user, use DUMMY_HASH.
      const hashToCheck = user?.passwordHash ?? DUMMY_HASH;
      const passwordOk = await verifyPassword(hashToCheck, password);

      // Eligibility checks done AFTER verify so timing stays uniform.
      if (!user) {
        await recordLoginFailure({ email, req, reason: 'unknown_email' });
        res.status(401).json(GENERIC_LOGIN_ERROR);
        return;
      }
      if (!user.passwordHash) {
        await recordLoginFailure({ email, req, reason: 'no_password' });
        res.status(401).json(GENERIC_LOGIN_ERROR);
        return;
      }
      if (!passwordOk) {
        await recordLoginFailure({ email, req, reason: 'wrong_password' });
        res.status(401).json(GENERIC_LOGIN_ERROR);
        return;
      }
      if (user.status !== 'ACTIVE') {
        await recordLoginFailure({ email, req, reason: 'disabled' });
        res.status(401).json(GENERIC_LOGIN_ERROR);
        return;
      }
      if (!HUMAN_ROLES.includes(user.role)) {
        await recordLoginFailure({ email, req, reason: 'non_human_role' });
        res.status(401).json(GENERIC_LOGIN_ERROR);
        return;
      }

      const token = signSession({
        sub: user.id,
        role: user.role,
        ver: user.tokenVersion,
      });
      res.cookie(SESSION_COOKIE, token, cookieOptions());

      await recordLoginSuccess({
        email,
        req,
        userId: user.id,
        clientId: user.clientId,
      });

      res.json({ user: toAuthUser(user) });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /auth/logout
 * Always 204. Idempotent. Clears cookie with the same flags as login.
 */
authRouter.post('/logout', async (req, res, next) => {
  try {
    if (req.user) {
      await recordLogout({
        userId: req.user.id,
        clientId: req.user.clientId,
        req,
      });
    }
    res.clearCookie(SESSION_COOKIE, cookieOptions());
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/**
 * GET /auth/me
 * 200 with `{ user: null }` when no cookie (anonymous, normal).
 * 401 when cookie is present but invalid/stale (signal client to clear).
 */
authRouter.get('/me', (req, res) => {
  if (req.sessionStale && !req.user) {
    res.clearCookie(SESSION_COOKIE, cookieOptions());
    res.status(401).json({
      error: { code: 'session_stale', message: 'Session no longer valid' },
    });
    return;
  }
  res.json({ user: req.user ? toAuthUser(req.user) : null });
});
