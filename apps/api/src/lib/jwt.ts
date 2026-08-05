import jwt from 'jsonwebtoken';
import type { Role } from '@alto-people/shared';
import { env } from '../config/env.js';

export interface SessionPayload {
  sub: string; // user id
  role: Role;
  ver: number; // tokenVersion
  iat: number;
  exp: number;
}

export function signSession(input: {
  sub: string;
  role: Role;
  ver: number;
}): string {
  return jwt.sign(
    { sub: input.sub, role: input.role, ver: input.ver },
    env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: env.JWT_TTL_SECONDS }
  );
}

export function verifySession(raw: string): SessionPayload | null {
  try {
    const decoded = jwt.verify(raw, env.JWT_SECRET, {
      algorithms: ['HS256'],
    });
    if (typeof decoded === 'string') return null;

    const { sub, role, ver, iat, exp } = decoded as Record<string, unknown>;
    if (
      typeof sub !== 'string' ||
      typeof role !== 'string' ||
      typeof ver !== 'number' ||
      typeof iat !== 'number' ||
      typeof exp !== 'number'
    ) {
      return null;
    }
    return { sub, role: role as Role, ver, iat, exp };
  } catch {
    return null;
  }
}

/**
 * Short-lived "you've passed the password step, now show me a code" token.
 * Issued by /auth/login when the user has MFA enabled, consumed by
 * /auth/mfa-challenge. The `typ` claim distinguishes it from a real
 * session JWT so the two surfaces can never be confused.
 *
 * 5 minutes is long enough for a user to grab their phone and find the
 * code, short enough that a stolen pending token expires before it's
 * useful in any sustained attack.
 */
export const MFA_PENDING_TTL_SECONDS = 5 * 60;

export interface MfaPendingPayload {
  sub: string;
  ver: number;
  typ: 'mfa_pending';
  iat: number;
  exp: number;
}

export function signMfaPending(input: { sub: string; ver: number }): string {
  return jwt.sign(
    { sub: input.sub, ver: input.ver, typ: 'mfa_pending' },
    env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: MFA_PENDING_TTL_SECONDS }
  );
}

export function verifyMfaPending(raw: string): MfaPendingPayload | null {
  try {
    const decoded = jwt.verify(raw, env.JWT_SECRET, {
      algorithms: ['HS256'],
    });
    if (typeof decoded === 'string') return null;
    const { sub, ver, typ, iat, exp } = decoded as Record<string, unknown>;
    if (
      typeof sub !== 'string' ||
      typeof ver !== 'number' ||
      typ !== 'mfa_pending' ||
      typeof iat !== 'number' ||
      typeof exp !== 'number'
    ) {
      return null;
    }
    return { sub, ver, typ: 'mfa_pending', iat, exp };
  } catch {
    return null;
  }
}

/**
 * Short-lived "you've passed the password step, but org policy says you
 * must enroll in TOTP before you get a session" token. Issued by
 * /auth/login when OrgSetting.mfaRequirement applies to the user's role
 * and they have no TOTP enrolled; accepted ONLY by the two MFA enrollment
 * endpoints (/auth/me/mfa/enroll/start + /enroll/confirm) via
 * `allowMfaEnrollToken` in middleware/auth.ts. Same shape/`typ` guard as
 * mfa_pending so the three JWT surfaces (session / mfa_pending /
 * mfa_enroll) can never be confused — note it deliberately carries NO
 * `role` claim, so `verifySession` rejects it even if it were smuggled
 * into the session cookie.
 *
 * 15 minutes (vs mfa_pending's 5): enrollment means installing an
 * authenticator app, scanning a QR, and saving recovery codes — a first-
 * time flow, not a code lookup.
 */
export const MFA_ENROLL_TTL_SECONDS = 15 * 60;

export interface MfaEnrollPayload {
  sub: string;
  ver: number;
  typ: 'mfa_enroll';
  iat: number;
  exp: number;
}

export function signMfaEnroll(input: { sub: string; ver: number }): string {
  return jwt.sign(
    { sub: input.sub, ver: input.ver, typ: 'mfa_enroll' },
    env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: MFA_ENROLL_TTL_SECONDS }
  );
}

export function verifyMfaEnroll(raw: string): MfaEnrollPayload | null {
  try {
    const decoded = jwt.verify(raw, env.JWT_SECRET, {
      algorithms: ['HS256'],
    });
    if (typeof decoded === 'string') return null;
    const { sub, ver, typ, iat, exp } = decoded as Record<string, unknown>;
    if (
      typeof sub !== 'string' ||
      typeof ver !== 'number' ||
      typ !== 'mfa_enroll' ||
      typeof iat !== 'number' ||
      typeof exp !== 'number'
    ) {
      return null;
    }
    return { sub, ver, typ: 'mfa_enroll', iat, exp };
  } catch {
    return null;
  }
}
