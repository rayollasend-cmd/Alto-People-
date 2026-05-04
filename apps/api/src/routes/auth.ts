import { Router } from 'express';
import { z } from 'zod';
import {
  AcceptInviteInputSchema,
  ChangePasswordInputSchema,
  ConfirmEmailChangeInputSchema,
  HUMAN_ROLES,
  NOTIFICATION_CATEGORIES,
  PatchNotificationPreferenceInputSchema,
  RequestEmailChangeInputSchema,
  UpdateProfileInputSchema,
  UpdateTimezoneInputSchema,
  type AuthUser,
  type InviteSummary,
  type NotificationPreferenceEntry,
} from '@alto-people/shared';
import { prisma } from '../db.js';
import { env } from '../config/env.js';
import {
  MFA_PENDING_TTL_SECONDS,
  signMfaPending,
  signSession,
  verifyMfaPending,
} from '../lib/jwt.js';
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
  MFA_PENDING_COOKIE,
  requireAuth,
  SESSION_COOKIE,
} from '../middleware/auth.js';
import {
  loginIpLimiter,
  loginEmailLimiter,
  changePasswordLimiter,
  forgotPasswordIpLimiter,
  forgotPasswordEmailLimiter,
  mfaChallengeIpLimiter,
  mfaChallengeUserLimiter,
} from '../middleware/rateLimit.js';
import { hashToken } from '../lib/inviteToken.js';
import {
  generatePasswordResetToken,
  hashResetToken,
  PASSWORD_RESET_TTL_SECONDS,
} from '../lib/passwordResetToken.js';
import {
  generateEmailChangeToken,
  hashEmailChangeToken,
  EMAIL_CHANGE_TTL_SECONDS,
} from '../lib/emailChangeToken.js';
import { send } from '../lib/notifications.js';
import {
  mfaCodesRegeneratedTemplate,
  mfaDisabledTemplate,
  mfaEnabledTemplate,
  passwordResetTemplate,
} from '../lib/emailTemplates.js';
import { HttpError } from '../middleware/error.js';
import archiver from 'archiver';
import { buildDataExport } from '../lib/dataExport.js';
import { generateSecret, generateURI, verifySync } from 'otplib';
import {
  decryptMfaSecret,
  encryptMfaSecret,
  generateRecoveryCode,
  hashRecoveryCode,
} from '../lib/mfaCrypto.js';
import {
  MFA_RECOVERY_CODE_COUNT,
  MFA_TOTP_PERIOD_SECONDS,
  MfaChallengeInputSchema,
  MfaDisableInputSchema,
  MfaEnrollConfirmInputSchema,
  MfaRegenerateInputSchema,
} from '@alto-people/shared';
import { getBrandingSync } from '../lib/branding.js';

// Tolerate one full TOTP period of skew on either side (~30s before/after
// the current window) so users with mildly drifted phone clocks still
// verify on the first try.
const TOTP_EPOCH_TOLERANCE = MFA_TOTP_PERIOD_SECONDS;

/**
 * Fire a security email about an MFA state change. Best-effort: a Resend
 * hiccup must not break the user-facing operation, so failures only log.
 * The template choice is the caller's responsibility — this just looks up
 * the first name for the greeting and dispatches.
 */
type MfaEventTemplate = (opts: {
  firstName: string;
  email: string;
  occurredAt: string;
}) => { subject: string; text: string; html: string };

async function sendMfaSecurityEmail(
  userId: string,
  email: string,
  template: MfaEventTemplate,
  context: string,
): Promise<void> {
  try {
    const firstName =
      (await prisma.user.findUnique({
        where: { id: userId },
        select: { associate: { select: { firstName: true } } },
      }))?.associate?.firstName ?? 'there';
    const occurredAt =
      new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
    const tpl = template({ firstName, email, occurredAt });
    await send({
      channel: 'EMAIL',
      recipient: { userId, phone: null, email },
      subject: tpl.subject,
      body: tpl.text,
      html: tpl.html,
    });
  } catch (err) {
    console.error(`[auth.${context}] security email send failed:`, err);
  }
}

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

// Same flags as the session cookie — only the maxAge differs (5 min vs
// JWT_TTL_SECONDS). Keeping them aligned means the __Host- prefix's
// requirements (secure + path=/ + no Domain) match in production.
function mfaPendingCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: env.NODE_ENV === 'production',
    path: '/',
    maxAge: MFA_PENDING_TTL_SECONDS * 1000,
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
  // Both shapes are accepted: SessionUser carries `mfaEnabled` (boolean)
  // pre-computed; raw prisma User carries `mfaEnabledAt` (Date | null).
  mfaEnabled?: boolean;
  mfaEnabledAt?: Date | null;
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
    mfaEnabled: u.mfaEnabled ?? (u.mfaEnabledAt != null),
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

      // MFA gate. Password is correct and the user is in good standing —
      // but if they've enrolled in two-step sign-in, the password alone
      // does not produce a session. Instead we issue a short-lived
      // mfa_pending cookie carrying just enough context for the follow-up
      // /auth/mfa-challenge call (sub + tokenVersion). No `auth.login`
      // audit row is written here — that fires from the challenge endpoint
      // on success, so login-history reflects "I was actually signed in"
      // rather than "I typed my password right".
      if (user.mfaEnabledAt) {
        const pending = signMfaPending({
          sub: user.id,
          ver: user.tokenVersion,
        });
        res.cookie(MFA_PENDING_COOKIE, pending, mfaPendingCookieOptions());
        // Defensive: if the user is mid-flow on another tab and re-logs
        // here, clear any session cookie so we never leave the user with
        // both a real session AND a pending challenge.
        res.clearCookie(SESSION_COOKIE, cookieOptions());
        res.json({ mfaRequired: true });
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
 * POST /auth/mfa-challenge { code }
 *
 * Second leg of the two-step sign-in. Reads the mfa_pending cookie set by
 * /auth/login, verifies the supplied code (TOTP first if it looks numeric,
 * recovery code as the fallback), and on success swaps the pending cookie
 * for a real session cookie. The audit row written here uses the regular
 * `auth.login` action so the login history feed reads naturally.
 *
 * Recovery codes are single-use: the matching MfaRecoveryCode row's
 * `usedAt` is set atomically as part of the verify, so a leaked code
 * can't be replayed.
 *
 * Two rate-limiters layered:
 *   - mfaChallengeIpLimiter   (30/15min/IP)        — broad abuse cap
 *   - mfaChallengeUserLimiter (5/15min/pending sub) — primary defense
 *     against TOTP brute-force on a stolen password
 */
authRouter.post(
  '/mfa-challenge',
  mfaChallengeIpLimiter,
  // Read+verify the pending cookie BEFORE the user-keyed limiter so the
  // limiter has a sub to key off of. Stash it on the request for both the
  // limiter's keyGenerator and the handler below.
  (req, _res, next) => {
    const raw = req.cookies?.[MFA_PENDING_COOKIE] as string | undefined;
    const payload = raw ? verifyMfaPending(raw) : null;
    if (payload) {
      (req as typeof req & { mfaPendingSub?: string }).mfaPendingSub = payload.sub;
      (req as typeof req & { mfaPendingPayload?: typeof payload }).mfaPendingPayload = payload;
    }
    next();
  },
  mfaChallengeUserLimiter,
  async (req, res, next) => {
    try {
      const payload = (req as typeof req & {
        mfaPendingPayload?: { sub: string; ver: number };
      }).mfaPendingPayload;
      if (!payload) {
        throw new HttpError(401, 'mfa_pending_missing', 'Sign in again to continue');
      }

      const parsed = MfaChallengeInputSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
      }
      const code = parsed.data.code;

      const user = await prisma.user.findFirst({
        where: { id: payload.sub, deletedAt: null },
      });
      if (
        !user ||
        user.status !== 'ACTIVE' ||
        user.tokenVersion !== payload.ver ||
        !user.mfaEnabledAt ||
        !user.mfaSecretEncrypted ||
        !HUMAN_ROLES.includes(user.role)
      ) {
        // Don't leak which condition failed — same generic 401 the password
        // step uses for similar reasons.
        res.clearCookie(MFA_PENDING_COOKIE, mfaPendingCookieOptions());
        throw new HttpError(401, 'mfa_state_invalid', 'Sign in again to continue');
      }

      // Numeric → try TOTP. Anything else → try recovery code. We don't
      // try both: a 6-digit string can't collide with the recovery format
      // (xxxxx-xxxxx), so guessing is unambiguous.
      let success = false;
      let usedRecovery = false;
      if (/^\d{6}$/.test(code)) {
        const secret = decryptMfaSecret(Buffer.from(user.mfaSecretEncrypted));
        const result = verifySync({
          token: code,
          secret,
          epochTolerance: TOTP_EPOCH_TOLERANCE,
        });
        success = result.valid;
      } else if (/^[a-z2-9]{5}-[a-z2-9]{5}$/.test(code)) {
        // Atomic compare-and-consume: only update the row if it matches AND
        // hasn't been used yet. updateMany returns count=1 on success, 0
        // when the code doesn't exist or has already been consumed.
        const consumed = await prisma.mfaRecoveryCode.updateMany({
          where: {
            userId: user.id,
            codeHash: hashRecoveryCode(code),
            usedAt: null,
          },
          data: { usedAt: new Date() },
        });
        success = consumed.count === 1;
        usedRecovery = success;
      }

      if (!success) {
        await recordLoginFailure({
          email: user.email,
          req,
          reason: 'mfa_invalid_code',
        });
        throw new HttpError(401, 'invalid_code', 'That code is incorrect or expired');
      }

      // Promote pending cookie → real session.
      res.clearCookie(MFA_PENDING_COOKIE, mfaPendingCookieOptions());
      const token = signSession({
        sub: user.id,
        role: user.role,
        ver: user.tokenVersion,
      });
      res.cookie(SESSION_COOKIE, token, cookieOptions());

      await recordLoginSuccess({
        email: user.email,
        req,
        userId: user.id,
        clientId: user.clientId,
      });

      if (usedRecovery) {
        // Distinct audit row so HR / the user can see "I had to fall back
        // to a recovery code" — high signal that the user lost their phone
        // and should regenerate codes / re-enroll soon.
        enqueueAudit(
          {
            actorUserId: user.id,
            clientId: user.clientId ?? null,
            action: 'auth.mfa_recovery_used',
            entityType: 'User',
            entityId: user.id,
            metadata: {
              ip: req.ip ?? null,
              userAgent: req.headers['user-agent'] ?? null,
            },
          },
          'auth.mfa_recovery_used'
        );
      }

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
 * GET /auth/me/data-export
 *
 * Streams a ZIP archive of the caller's own data: profile, login history,
 * notification preferences, and (for associate-linked accounts) time
 * entries, paystubs, and document metadata. File attachments are not
 * bundled — those have dedicated download endpoints. The build is done
 * by `buildDataExport` so it can be unit-tested without parsing a stream.
 */
authRouter.get('/me/data-export', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const entries = await buildDataExport(userId);
    const datestamp = new Date().toISOString().slice(0, 10);
    const filename = `alto-data-export-${datestamp}.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', (err) => res.destroy(err));
    archive.pipe(res);
    for (const entry of entries) {
      archive.append(entry.contents, { name: entry.filename });
    }
    await archive.finalize();

    enqueueAudit(
      {
        actorUserId: userId,
        clientId: req.user!.clientId ?? null,
        action: 'auth.data_exported',
        entityType: 'User',
        entityId: userId,
        metadata: {
          ip: req.ip ?? null,
          userAgent: req.headers['user-agent'] ?? null,
          fileCount: entries.length,
        },
      },
      'data-export'
    );
  } catch (err) {
    next(err);
  }
});

/* ===== TOTP MFA enrollment (settings audit row #3, PR 1) ================
 *
 * Three endpoints. Login enforcement (the actual challenge step) ships in
 * a follow-up PR — for now, enrolling does not gate sign-in. That's
 * deliberate: rolling out enrollment first lets HR / curious users opt in
 * and shake out the UI before the second factor is required to sign in.
 *
 * State machine on User:
 *   - mfaSecretEncrypted = NULL,    mfaEnabledAt = NULL  → not enrolled
 *   - mfaSecretEncrypted = <bytes>, mfaEnabledAt = NULL  → enrollment in flight
 *   - mfaSecretEncrypted = <bytes>, mfaEnabledAt = <ts>  → fully enrolled
 *
 * The "in-flight" state is overwritten on the next /enroll/start call, so
 * a user who closes the page mid-enrollment has nothing to clean up.
 */

/**
 * POST /auth/me/mfa/enroll/start
 *
 * Issue a fresh TOTP secret + recovery codes and persist them server-side.
 * Returns plaintext (secret string for QR/manual entry, recovery codes for
 * the user to save) — these are the ONLY chance the user will see them.
 * The secret and codes are stored encrypted/hashed before this responds.
 *
 * Calling this on an already-enrolled account starts a new enrollment that
 * will only become active on /enroll/confirm. Until then, the previous
 * (still-enabled) configuration keeps working — we don't tear down a
 * working setup until the user proves they've migrated.
 *
 * Note: PR 1 doesn't enforce MFA at login, so currently "enrolled" only
 * affects the Settings card. The state machine is built right so PR 2 can
 * just flip the enforcement switch.
 */
authRouter.post('/me/mfa/enroll/start', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const email = req.user!.email;

    const secret = generateSecret();
    const issuer = getBrandingSync().orgName || 'Alto HR';
    const provisioningUri = generateURI({ issuer, label: email, secret });

    const codes: string[] = [];
    const codeRows: { userId: string; codeHash: string }[] = [];
    for (let i = 0; i < MFA_RECOVERY_CODE_COUNT; i++) {
      const code = generateRecoveryCode();
      codes.push(code);
      codeRows.push({ userId, codeHash: hashRecoveryCode(code) });
    }

    // Wipe any stale in-flight enrollment row + previous unused codes, then
    // persist the new pair atomically. If the user re-enrolls while already
    // enabled, mfaEnabledAt is left intact — flipping back to fully-enabled
    // happens on /enroll/confirm.
    await prisma.$transaction([
      prisma.mfaRecoveryCode.deleteMany({ where: { userId } }),
      prisma.user.update({
        where: { id: userId },
        data: { mfaSecretEncrypted: encryptMfaSecret(secret) },
      }),
      prisma.mfaRecoveryCode.createMany({ data: codeRows }),
    ]);

    res.json({
      secret,
      provisioningUri,
      recoveryCodes: codes,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /auth/me/mfa/enroll/confirm { code }
 *
 * Verify a 6-digit TOTP against the stashed secret. On success, set
 * mfaEnabledAt = now() — the user is now considered fully enrolled and
 * the Settings card flips to the "MFA is on" state. tokenVersion is NOT
 * bumped: enabling MFA shouldn't sign anyone out.
 */
authRouter.post('/me/mfa/enroll/confirm', requireAuth, async (req, res, next) => {
  try {
    const parsed = MfaEnrollConfirmInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Code must be 6 digits', parsed.error.flatten());
    }
    const userId = req.user!.id;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, clientId: true, mfaSecretEncrypted: true },
    });
    if (!user || !user.mfaSecretEncrypted) {
      throw new HttpError(409, 'no_pending_enrollment', 'Start an enrollment first');
    }

    const secret = decryptMfaSecret(Buffer.from(user.mfaSecretEncrypted));
    const result = verifySync({
      token: parsed.data.code,
      secret,
      epochTolerance: TOTP_EPOCH_TOLERANCE,
    });
    if (!result.valid) {
      throw new HttpError(401, 'invalid_code', 'That code is incorrect or expired');
    }

    await prisma.user.update({
      where: { id: userId },
      data: { mfaEnabledAt: new Date() },
    });
    invalidateUserCache(userId);

    enqueueAudit(
      {
        actorUserId: userId,
        clientId: user.clientId ?? null,
        action: 'auth.mfa_enabled',
        entityType: 'User',
        entityId: userId,
        metadata: {
          ip: req.ip ?? null,
          userAgent: req.headers['user-agent'] ?? null,
        },
      },
      'auth.mfa_enabled'
    );

    void sendMfaSecurityEmail(userId, req.user!.email, mfaEnabledTemplate, 'mfa_enabled');

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/**
 * GET /auth/me/mfa/status
 *
 * Snapshot of the caller's MFA state for the Settings card. The card
 * polls this when it mounts (and after enroll/disable/regenerate) so the
 * "X of 8 codes remaining" indicator stays current. Kept off /auth/me on
 * purpose — every authenticated request hits attachUser, and counting
 * recovery codes there would add a query to the hot path.
 */
authRouter.get('/me/mfa/status', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const [user, remaining] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: { mfaEnabledAt: true },
      }),
      prisma.mfaRecoveryCode.count({
        where: { userId, usedAt: null },
      }),
    ]);
    res.json({
      enrolled: (user?.mfaEnabledAt ?? null) !== null,
      enabledAt: user?.mfaEnabledAt?.toISOString() ?? null,
      remainingRecoveryCodes: remaining,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /auth/me/mfa/recovery-codes/regenerate { currentPassword }
 *
 * Issue a fresh batch of 8 recovery codes WITHOUT rotating the TOTP
 * secret. Authenticator apps keep working. The previous codes are
 * deleted (used or unused) — by design, so a leaked printed sheet is
 * neutralised in one click.
 *
 * Requires password reauth (same bar as disable). Only valid when the
 * user is fully enrolled — calling this mid-enrollment or while not
 * enrolled returns 409 to avoid creating orphan codes.
 */
authRouter.post(
  '/me/mfa/recovery-codes/regenerate',
  requireAuth,
  async (req, res, next) => {
    try {
      const parsed = MfaRegenerateInputSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
      }
      const userId = req.user!.id;
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, clientId: true, passwordHash: true, mfaEnabledAt: true },
      });
      if (!user || !user.passwordHash) {
        throw new HttpError(401, 'invalid_credentials', 'Current password is incorrect');
      }
      const ok = await verifyPassword(user.passwordHash, parsed.data.currentPassword);
      if (!ok) {
        throw new HttpError(401, 'invalid_credentials', 'Current password is incorrect');
      }
      if (!user.mfaEnabledAt) {
        throw new HttpError(409, 'mfa_not_enrolled', 'Two-step sign-in is not turned on');
      }

      const codes: string[] = [];
      const codeRows: { userId: string; codeHash: string }[] = [];
      for (let i = 0; i < MFA_RECOVERY_CODE_COUNT; i++) {
        const code = generateRecoveryCode();
        codes.push(code);
        codeRows.push({ userId, codeHash: hashRecoveryCode(code) });
      }

      await prisma.$transaction([
        prisma.mfaRecoveryCode.deleteMany({ where: { userId } }),
        prisma.mfaRecoveryCode.createMany({ data: codeRows }),
      ]);

      enqueueAudit(
        {
          actorUserId: userId,
          clientId: user.clientId ?? null,
          action: 'auth.mfa_codes_regenerated',
          entityType: 'User',
          entityId: userId,
          metadata: {
            ip: req.ip ?? null,
            userAgent: req.headers['user-agent'] ?? null,
          },
        },
        'auth.mfa_codes_regenerated'
      );

      void sendMfaSecurityEmail(
        userId,
        req.user!.email,
        mfaCodesRegeneratedTemplate,
        'mfa_codes_regenerated',
      );

      res.json({ recoveryCodes: codes });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * DELETE /auth/me/mfa { currentPassword }
 *
 * Disable MFA on the caller's account. Requires a fresh password reauth
 * (cookie alone isn't enough — disabling a security control should always
 * cost the same as setting it up). Wipes the secret AND every recovery
 * code so a future re-enroll starts from a clean slate.
 */
authRouter.delete('/me/mfa', requireAuth, async (req, res, next) => {
  try {
    const parsed = MfaDisableInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const userId = req.user!.id;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, clientId: true, passwordHash: true, mfaEnabledAt: true },
    });
    if (!user || !user.passwordHash) {
      throw new HttpError(401, 'invalid_credentials', 'Current password is incorrect');
    }
    const ok = await verifyPassword(user.passwordHash, parsed.data.currentPassword);
    if (!ok) {
      throw new HttpError(401, 'invalid_credentials', 'Current password is incorrect');
    }
    if (!user.mfaEnabledAt) {
      // Idempotent: nothing to disable. Still 204 so the UI flow stays
      // simple, but skip the audit row — there's no state change.
      res.status(204).end();
      return;
    }

    await prisma.$transaction([
      prisma.mfaRecoveryCode.deleteMany({ where: { userId } }),
      prisma.user.update({
        where: { id: userId },
        data: { mfaSecretEncrypted: null, mfaEnabledAt: null },
      }),
    ]);
    invalidateUserCache(userId);

    enqueueAudit(
      {
        actorUserId: userId,
        clientId: user.clientId ?? null,
        action: 'auth.mfa_disabled',
        entityType: 'User',
        entityId: userId,
        metadata: {
          ip: req.ip ?? null,
          userAgent: req.headers['user-agent'] ?? null,
        },
      },
      'auth.mfa_disabled'
    );

    void sendMfaSecurityEmail(userId, req.user!.email, mfaDisabledTemplate, 'mfa_disabled');

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

/**
 * GET /auth/me/notification-preferences
 *
 * Returns one row per category in the catalog, joining the catalog's
 * label/description/mandatory fields with the user's stored emailEnabled.
 * Categories without a stored row default to enabled (the table is
 * append-on-mute, not pre-seeded). Mandatory categories always report
 * emailEnabled=true regardless of any stored row — defence in depth in
 * case a row was inserted directly.
 */
authRouter.get('/me/notification-preferences', requireAuth, async (req, res, next) => {
  try {
    const stored = await prisma.notificationPreference.findMany({
      take: 500,
      where: { userId: req.user!.id },
      select: { category: true, emailEnabled: true },
    });
    const byCategory = new Map(stored.map((s) => [s.category, s.emailEnabled]));

    const entries: NotificationPreferenceEntry[] = NOTIFICATION_CATEGORIES.map((c) => ({
      category: c.key,
      label: c.label,
      description: c.description,
      mandatory: c.mandatory,
      emailEnabled: c.mandatory ? true : (byCategory.get(c.key) ?? true),
    }));

    res.json({ entries });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /auth/me/notification-preferences { category, emailEnabled }
 *
 * Upserts the (userId, category) row. Refuses to mute mandatory
 * categories — those are formal HR notices / security alerts the
 * organisation must be able to deliver.
 */
authRouter.patch('/me/notification-preferences', requireAuth, async (req, res, next) => {
  try {
    const parsed = PatchNotificationPreferenceInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const { category, emailEnabled } = parsed.data;
    const meta = NOTIFICATION_CATEGORIES.find((c) => c.key === category);
    if (meta?.mandatory && !emailEnabled) {
      throw new HttpError(
        400,
        'mandatory_category',
        'This category cannot be muted.',
      );
    }
    await prisma.notificationPreference.upsert({
      where: { userId_category: { userId: req.user!.id, category } },
      create: { userId: req.user!.id, category, emailEnabled },
      update: { emailEnabled },
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/* ===== Two-step email change ============================================ */

/**
 * POST /auth/me/email-change/request { newEmail, currentPassword }
 *
 * Authenticated. Re-auth via current password (defence against a stolen
 * session quietly redirecting account takeover to an attacker inbox).
 * Mints a single-use ~256-bit token, stores its sha256, invalidates any
 * outstanding requests for the same user, and emails the raw token in a
 * confirmation link to the NEW address. Always 204 to the caller — the
 * UI shows a generic "check your inbox" message regardless of outcome.
 *
 * Specific failure paths (collision, same email, bad password) DO return
 * a meaningful error code for the in-app form, since the request is
 * authenticated (no enumeration risk: the caller is already a known user).
 */
authRouter.post('/me/email-change/request', requireAuth, async (req, res, next) => {
  try {
    const parsed = RequestEmailChangeInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const newEmail = parsed.data.newEmail.trim().toLowerCase();
    const { currentPassword } = parsed.data;

    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: {
        id: true,
        email: true,
        passwordHash: true,
        clientId: true,
      },
    });
    if (!user || !user.passwordHash) {
      throw new HttpError(401, 'invalid_credentials', 'Current password is incorrect');
    }
    const ok = await verifyPassword(user.passwordHash, currentPassword);
    if (!ok) {
      throw new HttpError(401, 'invalid_credentials', 'Current password is incorrect');
    }

    if (newEmail === user.email.toLowerCase()) {
      throw new HttpError(
        400,
        'same_email',
        'New email is the same as your current email.',
      );
    }

    // Collision against any active (non-deleted) account, including INVITED.
    // Re-checked in the confirm step in case a new account took the address
    // between request and confirm.
    const collision = await prisma.user.findFirst({
      where: { email: newEmail, deletedAt: null, NOT: { id: user.id } },
      select: { id: true },
    });
    if (collision) {
      throw new HttpError(
        409,
        'email_in_use',
        'That email already belongs to another account.',
      );
    }

    const { raw, hash } = generateEmailChangeToken();
    const expiresAt = new Date(Date.now() + EMAIL_CHANGE_TTL_SECONDS * 1000);

    await prisma.$transaction(async (tx) => {
      // Newest request wins — any older outstanding row goes dead.
      await tx.emailChangeRequest.updateMany({
        where: { userId: user.id, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      await tx.emailChangeRequest.create({
        data: {
          tokenHash: hash,
          userId: user.id,
          newEmail,
          expiresAt,
          requestedIp: req.ip ?? null,
        },
      });
    });

    const confirmUrl = `${env.APP_BASE_URL}/confirm-email-change/${raw}`;
    const subject = 'Confirm your new Alto People email';
    const body = [
      `Hi,`,
      ``,
      `Someone (hopefully you) asked to change the email on the Alto People account ${user.email} to this address.`,
      ``,
      `Open this link to confirm — it works once and expires in 1 hour:`,
      ``,
      confirmUrl,
      ``,
      `If you didn't request this, you can ignore this email — your account stays the same.`,
      ``,
      `— Alto People`,
    ].join('\n');

    try {
      await send({
        channel: 'EMAIL',
        recipient: { userId: user.id, phone: null, email: newEmail },
        subject,
        body,
      });
    } catch (sendErr) {
      console.error('[auth.email-change-request] email send failed:', sendErr);
    }

    enqueueAudit(
      {
        actorUserId: user.id,
        clientId: user.clientId ?? null,
        action: 'auth.email_change_requested',
        entityType: 'User',
        entityId: user.id,
        metadata: {
          ip: req.ip ?? null,
          userAgent: req.headers['user-agent'] ?? null,
          fromEmail: user.email,
          toEmail: newEmail,
        },
      },
      'auth.email_change_requested',
    );

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/**
 * POST /auth/email-change/confirm { token }
 *
 * Public — the token IS the authorization (the user must have opened
 * a link delivered to the NEW address to get here). Re-checks collision
 * in case another account claimed the address between request and
 * confirm. On success: swaps User.email, marks the token consumed, kills
 * sibling tokens, bumps tokenVersion (every existing session dies — the
 * cookie-bearer must re-auth with the new email), and notifies the OLD
 * address as a security alert.
 */
authRouter.post('/email-change/confirm', async (req, res, next) => {
  try {
    const parsed = ConfirmEmailChangeInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_token', 'Confirmation link is invalid or expired');
    }
    const tokenHash = hashEmailChangeToken(parsed.data.token);

    const request = await prisma.emailChangeRequest.findUnique({
      where: { tokenHash },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            status: true,
            clientId: true,
            deletedAt: true,
          },
        },
      },
    });
    if (
      !request ||
      request.consumedAt ||
      request.expiresAt <= new Date() ||
      !request.user ||
      request.user.deletedAt ||
      request.user.status !== 'ACTIVE'
    ) {
      throw new HttpError(400, 'invalid_token', 'Confirmation link is invalid or expired');
    }

    // Race cover: somebody might have grabbed this address since the request.
    const collision = await prisma.user.findFirst({
      where: {
        email: request.newEmail,
        deletedAt: null,
        NOT: { id: request.userId },
      },
      select: { id: true },
    });
    if (collision) {
      throw new HttpError(
        409,
        'email_in_use',
        'That email already belongs to another account.',
      );
    }

    const oldEmail = request.user.email;
    const now = new Date();

    await prisma.$transaction(async (tx) => {
      await tx.emailChangeRequest.update({
        where: { id: request.id },
        data: { consumedAt: now },
      });
      await tx.emailChangeRequest.updateMany({
        where: {
          userId: request.userId,
          consumedAt: null,
          id: { not: request.id },
        },
        data: { consumedAt: now },
      });
      await tx.user.update({
        where: { id: request.userId },
        data: {
          email: request.newEmail,
          // Sessions key off email implicitly via tokenVersion + the
          // cached SessionUser email field. Bump so every cookie dies
          // and the next auth fetches fresh.
          tokenVersion: { increment: 1 },
        },
      });
    });

    invalidateUserCache(request.userId);

    // Tell the old address — defensive notification, not a confirmation.
    // Best-effort; don't fail the swap if the email send hiccups.
    try {
      await send({
        channel: 'EMAIL',
        recipient: { userId: request.userId, phone: null, email: oldEmail },
        subject: 'Your Alto People email was changed',
        body: [
          `Hi,`,
          ``,
          `The email on this Alto People account was changed to ${request.newEmail}.`,
          ``,
          `If this was you, no action is needed. If you didn't make this change, contact your HR administrator immediately and reset your password — your existing sessions have already been signed out.`,
          ``,
          `— Alto People`,
        ].join('\n'),
      });
    } catch (sendErr) {
      console.error('[auth.email-change-confirm] notify-old send failed:', sendErr);
    }

    enqueueAudit(
      {
        actorUserId: request.userId,
        clientId: request.user.clientId ?? null,
        action: 'auth.email_changed',
        entityType: 'User',
        entityId: request.userId,
        metadata: {
          ip: req.ip ?? null,
          userAgent: req.headers['user-agent'] ?? null,
          fromEmail: oldEmail,
          toEmail: request.newEmail,
        },
      },
      'auth.email_changed',
    );

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
