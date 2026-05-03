import { createHash, randomBytes } from 'node:crypto';

/**
 * Cryptographically random email-change token.
 *
 * Same construction as passwordResetToken: 32 random bytes (~43-char
 * base64url, ~256 bits of entropy). The raw token goes in the magic
 * link emailed to the NEW address; only the sha256 hash lives in
 * `EmailChangeRequest`. On confirm, we hash the inbound token and look
 * up by hash. If the database leaks, the live tokens are unusable
 * without the matching plaintext.
 */
export function generateEmailChangeToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString('base64url');
  return { raw, hash: hashEmailChangeToken(raw) };
}

export function hashEmailChangeToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/** Tokens live for 1 hour — short enough to limit blast radius if a
 *  forwarded link leaks; long enough that "I'll click after dinner" still
 *  works. Same TTL as password reset. */
export const EMAIL_CHANGE_TTL_SECONDS = 60 * 60;
