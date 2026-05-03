import { Router } from 'express';
import { z } from 'zod';
import {
  AcceptInviteInputSchema,
  ChangePasswordInputSchema,
  HUMAN_ROLES,
  UpdateProfileInputSchema,
  UpdateTimezoneInputSchema,
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
  forgotPasswordIpLimiter,
  forgotPasswordEmailLimiter,
} from '../middleware/rateLimit.js';
import { hashToken } from '../lib/inviteToken.js';
import {
  generatePasswordResetToken,
  hashResetToken,
  PASSWORD_RESET_TTL_SECONDS,
} from '../lib/passwordResetToken.js';
import { send } from '../lib/notifications.js';
import { passwordResetTemplate } from '../lib/emailTemplates.js';
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
  timezone?: string | null;
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
    timezone: u.timezone ?? null,
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
 * POST /auth/me/revoke-other-sessions
 *
 * Bumps tokenVersion (kills every existing session — same mechanism as
 * change-password) and re-issues a fresh cookie for the caller so they
 * stay signed in. Intended for the "I see a sign-in I don't recognise
 * in my login history" panic button. Cheaper than forcing a full
 * password change when the user just wants to evict other devices.
 */
authRouter.post('/me/revoke-other-sessions', requireAuth, async (req, res, next) => {
  try {
    const updated = await prisma.user.update({
      where: { id: req.user!.id },
      data: { tokenVersion: { increment: 1 } },
      select: { id: true, role: true, clientId: true, tokenVersion: true },
    });
    invalidateUserCache(updated.id);

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
        action: 'auth.sessions_revoked',
        entityType: 'User',
        entityId: updated.id,
        metadata: {
          ip: req.ip ?? null,
          userAgent: req.headers['user-agent'] ?? null,
        },
      },
      'auth.sessions_revoked'
    );

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/* ===== Self-serve password reset ======================================= */

const ForgotPasswordSchema = z.object({
  email: z.string().email().max(254),
});

const ResetPasswordSchema = z.object({
  // ~43-char base64url; cap higher to allow for future formats but reject
  // obviously bogus inputs early.
  token: z.string().min(20).max(200),
  newPassword: z.string().min(12).max(256),
});

/**
 * POST /auth/forgot-password { email }
 *
 * Public. ALWAYS returns 200 regardless of whether the email exists or
 * the user is eligible to reset — leaking that distinction would let an
 * attacker enumerate accounts. The audit log records the actual outcome
 * for forensics.
 *
 * Eligibility: user must exist, not be soft-deleted, have a password
 * already (so newly-invited accounts can't bypass the invite flow), and
 * be in a human role. Anything else falls through to "no email sent" but
 * the response is identical.
 *
 * Token lives 1 hour. Earlier outstanding tokens for the same user are
 * invalidated when a new one is issued — the latest reset request wins.
 */
authRouter.post(
  '/forgot-password',
  forgotPasswordIpLimiter,
  forgotPasswordEmailLimiter,
  async (req, res, next) => {
    try {
      const parsed = ForgotPasswordSchema.safeParse(req.body);
      if (!parsed.success) {
        // Even bad input gets a 200 — same reason as the success path.
        // Don't audit; the rate limiter handles abuse.
        res.json({ ok: true });
        return;
      }
      const email = parsed.data.email.trim().toLowerCase();

      const user = await prisma.user.findFirst({
        where: { email, deletedAt: null },
        select: {
          id: true,
          email: true,
          status: true,
          role: true,
          clientId: true,
          passwordHash: true,
        },
      });

      const eligible =
        !!user &&
        user.status === 'ACTIVE' &&
        !!user.passwordHash &&
        HUMAN_ROLES.includes(user.role);

      if (eligible && user) {
        const { raw, hash } = generatePasswordResetToken();
        const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_SECONDS * 1000);

        await prisma.$transaction(async (tx) => {
          // Invalidate any outstanding tokens — newest-issued wins so a
          // user who clicks "send me another" doesn't leave the older
          // link live alongside it.
          await tx.passwordResetToken.updateMany({
            where: { userId: user.id, consumedAt: null },
            data: { consumedAt: new Date() },
          });
          await tx.passwordResetToken.create({
            data: {
              tokenHash: hash,
              userId: user.id,
              expiresAt,
              requestedIp: req.ip ?? null,
            },
          });
        });

        const resetUrl = `${env.APP_BASE_URL}/reset-password/${raw}`;
        // Best-effort first-name lookup for the greeting; falls back to
        // "there" if the user isn't an associate (e.g. an HR account).
        const firstName =
          (await prisma.user.findUnique({
            where: { id: user.id },
            select: { associate: { select: { firstName: true } } },
          }))?.associate?.firstName ?? 'there';
        const tpl = passwordResetTemplate({
          firstName,
          email: user.email,
          requestedAt: new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
          resetLink: resetUrl,
        });

        try {
          await send({
            channel: 'EMAIL',
            recipient: { userId: user.id, phone: null, email: user.email },
            subject: tpl.subject,
            body: tpl.text,
            html: tpl.html,
          });
        } catch (sendErr) {
          // Don't surface to the client (see enumeration note above) but
          // do record so HR can investigate undelivered resets.
          console.error('[auth.forgot-password] email send failed:', sendErr);
        }

        enqueueAudit(
          {
            actorUserId: user.id,
            clientId: user.clientId ?? null,
            action: 'auth.password_reset_requested',
            entityType: 'User',
            entityId: user.id,
            metadata: {
              ip: req.ip ?? null,
              userAgent: req.headers['user-agent'] ?? null,
              email,
            },
          },
          'auth.password_reset_requested'
        );
      } else {
        // No-op path. Still record so a flood of resets against a single
        // unknown email leaves a paper trail.
        enqueueAudit(
          {
            actorUserId: null,
            clientId: null,
            action: 'auth.password_reset_skipped',
            entityType: 'User',
            entityId: email,
            metadata: {
              ip: req.ip ?? null,
              userAgent: req.headers['user-agent'] ?? null,
              email,
              reason: !user
                ? 'unknown_email'
                : user.status !== 'ACTIVE'
                  ? 'not_active'
                  : !user.passwordHash
                    ? 'no_password'
                    : 'non_human_role',
            },
          },
          'auth.password_reset_skipped'
        );
      }

      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /auth/reset-password { token, newPassword }
 *
 * Public. Looks up by sha256(token); returns 400 with a generic message
 * for any failure (unknown / expired / consumed / wrong user state) so
 * we don't leak which case applied.
 *
 * On success: stores the new hash, marks the token consumed, and bumps
 * tokenVersion so every previously-issued session cookie for this user
 * goes stale immediately. Does NOT auto-sign-in — the user must log in
 * with the new password from a clean state. This is the safer pattern
 * (it confirms the password actually works before they leave the page).
 */
authRouter.post('/reset-password', async (req, res, next) => {
  try {
    const parsed = ResetPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_token', 'Reset link is invalid or expired');
    }
    const { token, newPassword } = parsed.data;
    const tokenHash = hashResetToken(token);

    const reset = await prisma.passwordResetToken.findUnique({
      where: { tokenHash },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            role: true,
            status: true,
            clientId: true,
            deletedAt: true,
          },
        },
      },
    });
    if (
      !reset ||
      reset.consumedAt ||
      reset.expiresAt <= new Date() ||
      !reset.user ||
      reset.user.deletedAt ||
      reset.user.status !== 'ACTIVE' ||
      !HUMAN_ROLES.includes(reset.user.role)
    ) {
      throw new HttpError(400, 'invalid_token', 'Reset link is invalid or expired');
    }

    const newHash = await hashPassword(newPassword);
    const now = new Date();

    await prisma.$transaction(async (tx) => {
      await tx.passwordResetToken.update({
        where: { id: reset.id },
        data: { consumedAt: now },
      });
      // Kill any siblings — once one was used, the others are dead.
      await tx.passwordResetToken.updateMany({
        where: {
          userId: reset.userId,
          consumedAt: null,
          id: { not: reset.id },
        },
        data: { consumedAt: now },
      });
      await tx.user.update({
        where: { id: reset.userId },
        data: {
          passwordHash: newHash,
          // Nuke every existing session so a stolen cookie can't outlive
          // the password it was paired with.
          tokenVersion: { increment: 1 },
        },
      });
    });

    invalidateUserCache(reset.userId);

    enqueueAudit(
      {
        actorUserId: reset.userId,
        clientId: reset.user.clientId ?? null,
        action: 'auth.password_reset_completed',
        entityType: 'User',
        entityId: reset.userId,
        metadata: {
          ip: req.ip ?? null,
          userAgent: req.headers['user-agent'] ?? null,
        },
      },
      'auth.password_reset_completed'
    );

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/**
 * GET /auth/me/login-history
 *
 * Returns the most recent auth-related AuditLog rows for the current user
 * so they can spot a session they don't recognise. Includes successful
 * logins, password changes, password resets, and logouts. Login *failures*
 * (which carry no actorUserId — see audit.ts) are NOT included here:
 * surfacing "someone tried to log in as you and failed" to the user is
 * a separate, noisier security feature; this endpoint is the simple
 * "where am I logged in" view.
 *
 * Capped at 25 entries — the Settings card shows a short table, not a
 * forensic timeline. The full picture is in /audit for HR.
 */
authRouter.get('/me/login-history', requireAuth, async (req, res, next) => {
  try {
    const rows = await prisma.auditLog.findMany({
      where: {
        actorUserId: req.user!.id,
        action: { in: ['auth.login', 'auth.logout', 'auth.password_changed', 'auth.password_reset_completed', 'auth.sessions_revoked'] },
      },
      orderBy: { createdAt: 'desc' },
      take: 25,
      select: {
        id: true,
        action: true,
        createdAt: true,
        metadata: true,
      },
    });
    res.json({
      events: rows.map((r) => {
        const meta = (r.metadata ?? {}) as { ip?: string | null; userAgent?: string | null };
        return {
          id: r.id,
          action: r.action,
          at: r.createdAt.toISOString(),
          ip: meta.ip ?? null,
          userAgent: meta.userAgent ?? null,
        };
      }),
    });
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

/**
 * PATCH /auth/me/timezone { timezone: SupportedTimezone | null }
 *
 * Self-serve IANA timezone preference. Validated against the curated
 * SUPPORTED_TIMEZONES list — submitting an arbitrary string returns
 * 400. Null clears the preference (web falls back to browser locale).
 *
 * Lives on User (not Associate) so HR-only / portal accounts get the
 * preference too. tokenVersion is NOT bumped — this is a cosmetic
 * setting, not a security boundary.
 */
authRouter.patch('/me/timezone', requireAuth, async (req, res, next) => {
  try {
    const parsed = UpdateTimezoneInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    await prisma.user.update({
      where: { id: req.user!.id },
      data: { timezone: parsed.data.timezone },
    });
    invalidateUserCache(req.user!.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
