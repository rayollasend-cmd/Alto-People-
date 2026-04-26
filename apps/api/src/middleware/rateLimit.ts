import rateLimit from 'express-rate-limit';
import type { Request } from 'express';

/** 20 requests / minute / IP for /auth/login. */
export const loginIpLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    error: {
      code: 'rate_limited',
      message: 'Too many login attempts. Try again in a minute.',
    },
  },
});

/** 5 requests / 15 minutes / email for /auth/login. */
export const loginEmailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
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
