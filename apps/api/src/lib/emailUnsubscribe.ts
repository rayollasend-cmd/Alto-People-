import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';

/**
 * One-click unsubscribe tokens for broadcast/announcement email.
 *
 * RFC 8058 one-click unsubscribe means the mailbox provider POSTs the
 * List-Unsubscribe URL with NO session and NO user interaction, so — like
 * the iCal feed tokens in lib/calendarFeed.ts — the token in the URL IS
 * the authorization. The token binds the recipient email address:
 *
 *   token = base64url(email) + '.' + base64url(HMAC-SHA256(secret, 'unsub:' + email))
 *
 * Carrying the email inside the token (rather than HMAC-only) lets the
 * endpoint recover WHO is unsubscribing without a reverse lookup; the HMAC
 * half proves we minted it. The 'unsub:' domain prefix keeps these tokens
 * non-interchangeable with any other HMAC token minted from the same secret.
 *
 * Secret reuses CALENDAR_FEED_SECRET (falling back to JWT_SECRET) exactly
 * like the calendar feed — rotating that secret invalidates outstanding
 * unsubscribe links in old emails, which is acceptable: the settings page
 * remains the durable opt-out surface.
 */

function unsubscribeSecret(): string {
  return env.CALENDAR_FEED_SECRET ?? env.JWT_SECRET;
}

function sign(email: string): Buffer {
  return createHmac('sha256', unsubscribeSecret())
    .update(`unsub:${email}`, 'utf8')
    .digest();
}

/** Mint a token for `email`. The address is lowercased first so a token
 *  minted from a mixed-case source matches the stored lowercase form. */
export function mintUnsubscribeToken(email: string): string {
  const normalized = email.trim().toLowerCase();
  const payload = Buffer.from(normalized, 'utf8').toString('base64url');
  const sig = sign(normalized).toString('base64url');
  return `${payload}.${sig}`;
}

/**
 * Verify a token and return the bound (lowercased) email, or null when the
 * token is malformed or the signature doesn't match. Constant-time compare
 * with an explicit byte-length pre-check (timingSafeEqual throws on length
 * mismatch).
 */
export function verifyUnsubscribeToken(token: string): string | null {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  let email: string;
  let candidate: Buffer;
  try {
    email = Buffer.from(token.slice(0, dot), 'base64url').toString('utf8');
    candidate = Buffer.from(token.slice(dot + 1), 'base64url');
  } catch {
    return null;
  }
  if (!email || !email.includes('@')) return null;
  const normalized = email.toLowerCase();
  const expected = sign(normalized);
  if (candidate.length !== expected.length) return null;
  return timingSafeEqual(candidate, expected) ? normalized : null;
}
