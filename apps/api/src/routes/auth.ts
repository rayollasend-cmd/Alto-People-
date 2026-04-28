import { Router } from 'express';
import { z } from 'zod';
import {
  AcceptInviteInputSchema,
  ChangePasswordInputSchema,
  HUMAN_ROLES,
  UpdateProfileInputSchema,
  type AuthUser,
  type InviteSummary,
} from '@alto-people/shared';
import { prisma } from '../db.js';
import { env } from '../config/env.js';
import { signSession } from '../lib/jwt.js';
import { profilePhotoUrlFor } from '../lib/profilePhotoUrl.js';
import {
  hashPassword,
  verifyPassword,
  DUMMY_HASH,
} from '../lib/passwords.js';
import {
  enqueueAudit,
  recordLoginFailure,
  recordLoginSuccess,
  recordLogout,
} from '../lib/audit.js';
import {
  invalidateUserCache,
  requireAuth,
  SESSION_COOKIE,
} from '../middleware/auth.js';
import {
  loginIpLimiter,
  loginEmailLimiter,
  changePasswordLimiter,
} from '../middleware/rateLimit.js';
import { hashToken } from '../lib/inviteToken.js';
import { HttpError } from '../middleware/error.js';

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
  firstName?: string | null;
  lastName?: string | null;
  photoUrl?: string | null;
}): AuthUser {
  return {
    id: u.id,
    email: u.email,
    role: u.role as AuthUser['role'],
    status: u.status as AuthUser['status'],
    clientId: u.clientId,
    associateId: u.associateId,
    firstName: u.firstName ?? null,
    lastName: u.lastName ?? null,
    photoUrl: u.photoUrl ?? null,
  };
}

/**
 * Look up profile fields (name + photo) for the linked Associate so we can
 * surface them in `AuthUser`. Skips the query when the user has no associate
 * row (HR-only / portal accounts) — they always carry null.
 */
async function loadProfileFor(associateId: string | null) {
  if (!associateId) {
    return { firstName: null, lastName: null, photoUrl: null };
  }
  const a = await prisma.associate.findUnique({
    where: { id: associateId },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      photoS3Key: true,
      photoUpdatedAt: true,
    },
  });
  if (!a) return { firstName: null, lastName: null, photoUrl: null };
  return {
    firstName: a.firstName,
    lastName: a.lastName,
    photoUrl: profilePhotoUrlFor(a),
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

      const profile = await loadProfileFor(user.associateId);
      res.json({ user: toAuthUser({ ...user, ...profile }) });
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
      // Drop any cached SessionUser so a stolen cookie can't ride a still-
      // warm cache entry past the cookie clear. (Defense in depth — the JWT
      // itself isn't invalidated server-side on logout in this codebase.)
      invalidateUserCache(req.user.id);
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

/* ===== Invitation flow (Phase 16) ====================================== */

/**
 * GET /auth/invite/:token
 * Public — no auth required. Returns the associate's name + email so the
 * accept-invite page can render a personalized welcome. 404 on any
 * invalid/expired/consumed token (no oracle: same response for "doesn't
 * exist" vs "expired" vs "consumed").
 */
authRouter.get('/invite/:token', async (req, res, next) => {
  try {
    const tokenHash = hashToken(req.params.token);
    const invite = await prisma.inviteToken.findUnique({
      where: { tokenHash },
      include: {
        user: {
          include: {
            associate: { select: { firstName: true, lastName: true } },
          },
        },
      },
    });
    if (!invite || invite.consumedAt || invite.expiresAt <= new Date()) {
      throw new HttpError(404, 'invite_not_found', 'Invitation not found or expired');
    }
    const payload: InviteSummary = {
      email: invite.user.email,
      firstName: invite.user.associate?.firstName ?? null,
      lastName: invite.user.associate?.lastName ?? null,
      expiresAt: invite.expiresAt.toISOString(),
    };
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /auth/accept-invite { token, password }
 * Consumes the token, sets passwordHash, flips status to ACTIVE, issues a
 * session cookie. Wrapped in a transaction so a partial failure doesn't
 * leave a consumed token attached to a still-INVITED user.
 */
authRouter.post('/accept-invite', async (req, res, next) => {
  try {
    const parsed = AcceptInviteInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const { token, password } = parsed.data;
    const tokenHash = hashToken(token);

    const invite = await prisma.inviteToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });
    if (!invite || invite.consumedAt || invite.expiresAt <= new Date()) {
      throw new HttpError(404, 'invite_not_found', 'Invitation not found or expired');
    }
    if (invite.user.status === 'ACTIVE' && invite.user.passwordHash) {
      // The user is already set up — could happen if HR re-invited then the
      // associate accepted the older link. Refuse rather than silently
      // overwriting their password.
      throw new HttpError(409, 'already_active', 'This account is already active. Use sign in.');
    }

    const passwordHash = await hashPassword(password);
    const now = new Date();

    const updatedUser = await prisma.$transaction(async (tx) => {
      await tx.inviteToken.update({
        where: { id: invite.id },
        data: { consumedAt: now },
      });
      // Invalidate any other outstanding invites for this user — once one
      // is consumed, the rest are useless.
      await tx.inviteToken.updateMany({
        where: { userId: invite.userId, consumedAt: null, id: { not: invite.id } },
        data: { consumedAt: now },
      });
      return tx.user.update({
        where: { id: invite.userId },
        data: {
          passwordHash,
          status: 'ACTIVE',
          // Bump tokenVersion so any pre-existing session cookies (unlikely
          // for an INVITED user but defensive) become stale.
          tokenVersion: { increment: 1 },
        },
      });
    });

    const sessionToken = signSession({
      sub: updatedUser.id,
      role: updatedUser.role,
      ver: updatedUser.tokenVersion,
    });
    res.cookie(SESSION_COOKIE, sessionToken, cookieOptions());

    await recordLoginSuccess({
      email: updatedUser.email,
      req,
      userId: updatedUser.id,
      clientId: updatedUser.clientId,
    });

    // Phase 32 — point the freshly-activated user straight at their
    // checklist if they have one open. The dashboard is a fine fallback
    // for HR-created users without an Application, but most accept-invite
    // flows are associates whose application drives the entire reason
    // they got the invite in the first place.
    const nextPath = await pickPostAcceptPath(updatedUser.id);

    const profile = await loadProfileFor(updatedUser.associateId);
    res.json({ user: toAuthUser({ ...updatedUser, ...profile }), nextPath });
  } catch (err) {
    next(err);
  }
});

async function pickPostAcceptPath(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { associateId: true },
  });
  if (!user?.associateId) return '/';
  const app = await prisma.application.findFirst({
    where: { associateId: user.associateId },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  return app ? `/onboarding/me/${app.id}` : '/';
}

/* ===== Self-service settings (Phase 39) ================================ */

/**
 * POST /auth/change-password { currentPassword, newPassword }
 * Authenticated. Verifies the current password, swaps the hash, bumps
 * tokenVersion (nukes every other live session for this user), and
 * re-issues a fresh cookie so the caller stays logged in. The
 * tokenVersion bump is the critical bit — without it a stolen cookie
 * would survive a password change.
 */
authRouter.post('/change-password', requireAuth, changePasswordLimiter, async (req, res, next) => {
  try {
    const parsed = ChangePasswordInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const { currentPassword, newPassword } = parsed.data;

    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { id: true, role: true, clientId: true, passwordHash: true },
    });
    if (!user || !user.passwordHash) {
      throw new HttpError(401, 'invalid_credentials', 'Current password is incorrect');
    }
    const ok = await verifyPassword(user.passwordHash, currentPassword);
    if (!ok) {
      throw new HttpError(401, 'invalid_credentials', 'Current password is incorrect');
    }

    const newHash = await hashPassword(newPassword);
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: newHash,
        tokenVersion: { increment: 1 },
      },
    });

    const sessionToken = signSession({
      sub: updated.id,
      role: updated.role,
      ver: updated.tokenVersion,
    });
    res.cookie(SESSION_COOKIE, sessionToken, cookieOptions());

    enqueueAudit(
      {
        actorUserId: updated.id,
        clientId: updated.clientId ?? null,
        action: 'auth.password_changed',
        entityType: 'User',
        entityId: updated.id,
        metadata: {
          ip: req.ip ?? null,
          userAgent: req.headers['user-agent'] ?? null,
        },
      },
      'auth.password_changed'
    );

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /auth/me/profile { firstName?, lastName? }
 * Authenticated. Updates the linked Associate row's display name.
 * Users without an Associate row (HR-only / portal accounts) get a
 * 404 — the field doesn't apply to them, and silently no-op'ing
 * would be confusing.
 */
authRouter.patch('/me/profile', requireAuth, async (req, res, next) => {
  try {
    const parsed = UpdateProfileInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    if (!req.user!.associateId) {
      throw new HttpError(404, 'no_associate', 'This account has no associate profile to edit');
    }
    const { firstName, lastName } = parsed.data;
    if (firstName === undefined && lastName === undefined) {
      res.status(204).end();
      return;
    }
    const updated = await prisma.associate.update({
      where: { id: req.user!.associateId },
      data: {
        ...(firstName !== undefined ? { firstName } : {}),
        ...(lastName !== undefined ? { lastName } : {}),
      },
      select: { firstName: true, lastName: true, email: true },
    });
    // Drop the cached SessionUser so the new firstName/lastName surface on
    // the very next request (chrome avatars, mentions, audit display) rather
    // than after the 30s TTL.
    invalidateUserCache(req.user!.id);
    res.json(updated);
  } catch (err) {
    next(err);
  }
});
