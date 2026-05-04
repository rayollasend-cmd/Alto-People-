import rateLimit from 'express-rate-limit';
import type { Request } from 'express';

// In test runs the entire suite shares 127.0.0.1, which would trip the
// IP limiter across unrelated tests. The per-email limiter still enforces
// brute-force defense and is exercised explicitly by auth.test.ts.
const IP_LIMIT = process.env.NODE_ENV === 'test' ? 100_000 : 20;

// Brute-force defense matters in prod and is exercised in tests; in
// development it just gets in the way when iterating on the login flow.
const EMAIL_LIMIT = process.env.NODE_ENV === 'development' ? 100_000 : 5;

/** 20 requests / minute / IP for /auth/login. */
export const loginIpLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: IP_LIMIT,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    error: {
      code: 'rate_limited',
      message: 'Too many login attempts. Try again in a minute.',
    },
  },
});

// MFA challenge: brute-force defense for the second login factor. A 6-digit
// TOTP has only 1M possible values, and the verifier accepts a window of
// codes (current + previous + next), so a determined attacker who's already
// stolen a password could grind through the keyspace if we let them. The
// per-user (mfa_pending sub) limiter is the primary defense — the per-IP
// limiter catches sharing-IP-across-accounts abuse like NAT'd offices.
const MFA_CHALLENGE_IP_LIMIT = process.env.NODE_ENV === 'test' ? 100_000 : 30;
const MFA_CHALLENGE_USER_LIMIT = process.env.NODE_ENV === 'test' ? 100_000 : 5;

/** 30 challenge attempts / 15 min / IP for /auth/mfa-challenge. */
export const mfaChallengeIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: MFA_CHALLENGE_IP_LIMIT,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    error: {
      code: 'rate_limited',
      message: 'Too many code attempts. Try again in a few minutes.',
    },
  },
});

/** 5 challenge attempts / 15 min / pending-user for /auth/mfa-challenge.
 *  Keyed off the mfa_pending JWT subject, set on req by the route handler
 *  before this middleware runs. Falls back to IP if the cookie is absent
 *  (the route handler will still 401 those cleanly). */
export const mfaChallengeUserLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: MFA_CHALLENGE_USER_LIMIT,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    const sub = (req as Request & { mfaPendingSub?: string }).mfaPendingSub;
    return sub ? `mfa:${sub}` : `ip:${req.ip ?? 'unknown'}`;
  },
  message: {
    error: {
      code: 'rate_limited',
      message: 'Too many code attempts for this sign-in. Sign in again to retry.',
    },
  },
});

/** 5 requests / 15 minutes / email for /auth/login (production only). */
export const loginEmailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: EMAIL_LIMIT,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    const email = (req.body?.email ?? '').toString().trim().toLowerCase();
    if (email) return `email:${email}`;
    // Fall back to IP if body parsing failed. The IP-based limiter is the
    // primary defense for unauthenticated/garbage requests; this fallback
    // just keeps the per-email limiter from crashing on bad input.
    return `ip:${req.ip ?? 'unknown'}`;
  },
  message: {
    error: {
      code: 'rate_limited',
      message: 'Too many login attempts for this account. Try again later.',
    },
  },
});

// 10/hour/user is loose enough that a real user rotating a password they
// can't remember won't hit it, tight enough that a stolen-session attacker
// can't grind through guesses for the current password.
const CHANGE_PASSWORD_LIMIT =
  process.env.NODE_ENV === 'test' ? 100_000 : 10;

/** 10 requests / hour / authenticated user for /auth/change-password. */
export const changePasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: CHANGE_PASSWORD_LIMIT,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    // requireAuth runs before this limiter, so req.user is set. Falling back
    // to IP for safety if it isn't (e.g., misconfigured route).
    const userId = req.user?.id;
    return userId ? `user:${userId}` : `ip:${req.ip ?? 'unknown'}`;
  },
  message: {
    error: {
      code: 'rate_limited',
      message: 'Too many password-change attempts. Try again later.',
    },
  },
});

// Forgot-password endpoint is unauthenticated and could be abused both
// to enumerate accounts (despite the always-200 response, response time
// can leak) and to spam users with reset emails. Two limiters layered:
// per-IP catches mass scans, per-email caps how many reset emails any
// one account can receive in a window. Tests bypass both.
const FORGOT_PASSWORD_IP_LIMIT =
  process.env.NODE_ENV === 'test' ? 100_000 : 10;
const FORGOT_PASSWORD_EMAIL_LIMIT =
  process.env.NODE_ENV === 'test' ? 100_000 : 3;

/** 10 requests / hour / IP for /auth/forgot-password. */
export const forgotPasswordIpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: FORGOT_PASSWORD_IP_LIMIT,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    error: {
      code: 'rate_limited',
      message: 'Too many reset requests from this address. Try again later.',
    },
  },
});

/** 3 requests / hour / email for /auth/forgot-password. */
export const forgotPasswordEmailLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: FORGOT_PASSWORD_EMAIL_LIMIT,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    const email = (req.body?.email ?? '').toString().trim().toLowerCase();
    if (email) return `email:${email}`;
    return `ip:${req.ip ?? 'unknown'}`;
  },
  message: {
    error: {
      code: 'rate_limited',
      message: 'Too many reset requests for this account. Try again later.',
    },
  },
});

// Token-consume endpoints (accept-invite, reset-password) are unauthenticated
// and consume a high-entropy bearer token. The IP limiter caps a botnet that's
// already harvested a token from somewhere it shouldn't have been (email
// archive leak, shoulder-surf) before they can grind through password
// candidates against the consume step. 10/hour/IP is loose for legitimate
// "I clicked the link wrong / network hiccup" retries, tight against abuse.
const TOKEN_CONSUME_IP_LIMIT =
  process.env.NODE_ENV === 'test' ? 100_000 : 10;

/** 10 requests / hour / IP for /auth/accept-invite. */
export const acceptInviteIpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: TOKEN_CONSUME_IP_LIMIT,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    error: {
      code: 'rate_limited',
      message: 'Too many invite attempts. Try again later.',
    },
  },
});

/** 10 requests / hour / IP for /auth/reset-password. */
export const resetPasswordIpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: TOKEN_CONSUME_IP_LIMIT,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    error: {
      code: 'rate_limited',
      message: 'Too many reset attempts. Try again later.',
    },
  },
});

// MFA enrollment confirmation. The TOTP verifier accepts a window of 3 codes
// (current ± 1) out of a 1M keyspace, so each guess is ~3/1M odds of hitting.
// Without a per-user limit, an attacker with a stolen session could grind
// the keyspace until they confirm enrollment under their authenticator. Cap
// at 5/15min — same shape as the mfa-challenge limiter for the login path.
const MFA_ENROLL_CONFIRM_LIMIT =
  process.env.NODE_ENV === 'test' ? 100_000 : 5;

/** 5 enroll-confirm attempts / 15 min / user for /auth/me/mfa/enroll/confirm. */
export const mfaEnrollConfirmLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: MFA_ENROLL_CONFIRM_LIMIT,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    const userId = req.user?.id;
    return userId ? `user:${userId}` : `ip:${req.ip ?? 'unknown'}`;
  },
  message: {
    error: {
      code: 'rate_limited',
      message: 'Too many code attempts. Try again in a few minutes.',
    },
  },
});

// Public careers apply endpoint is unauthenticated and therefore the most
// abusable surface in the API. Two limiters layered: per-IP catches a
// botnet hammering one origin; per-email catches a single account being
// re-submitted at scale. Tests bypass both.
const CAREERS_APPLY_IP_LIMIT = process.env.NODE_ENV === 'test' ? 100_000 : 30;
const CAREERS_APPLY_EMAIL_LIMIT =
  process.env.NODE_ENV === 'test' ? 100_000 : 5;

/** 30 applications / hour / IP for /careers/:slug/apply. */
export const careersApplyIpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: CAREERS_APPLY_IP_LIMIT,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    error: {
      code: 'rate_limited',
      message: 'Too many applications from this address. Try again later.',
    },
  },
});

/** 5 applications / hour / email for /careers/:slug/apply. */
export const careersApplyEmailLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: CAREERS_APPLY_EMAIL_LIMIT,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    const email = (req.body?.email ?? '').toString().trim().toLowerCase();
    if (email) return `email:${email}`;
    return `ip:${req.ip ?? 'unknown'}`;
  },
  message: {
    error: {
      code: 'rate_limited',
      message: 'Too many applications for this email. Try again later.',
    },
  },
});

// Public integration API (e.g. AltoHR / ASN bridge). Keyed by the
// authenticated ApiKey.id so noisy neighbours don't starve other tenants.
// 60/min/key is generous for a polling integration that refreshes once
// every few seconds; tests bypass.
const INTEGRATIONS_LIMIT = process.env.NODE_ENV === 'test' ? 100_000 : 60;

/** 60 requests / minute / API key for /integrations/v1/*. */
export const integrationsApiKeyLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: INTEGRATIONS_LIMIT,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    // requireApiKey runs before this limiter so req.apiKey is set.
    // Falling back to IP for safety if the limiter is somehow mounted
    // before the auth middleware (misconfiguration).
    const id = req.apiKey?.id;
    return id ? `apiKey:${id}` : `ip:${req.ip ?? 'unknown'}`;
  },
  message: {
    error: {
      code: 'rate_limited',
      message: 'Too many requests for this API key. Try again in a minute.',
    },
  },
});
