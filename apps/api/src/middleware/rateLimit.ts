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
