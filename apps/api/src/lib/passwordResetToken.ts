import { createHash, randomBytes } from 'node:crypto';

/**
 * Cryptographically random password-reset token.
 *
 * Same construction as inviteToken: 32 random bytes (~43-char base64url,
 * ~256 bits of entropy). The raw token goes in the magic link emailed to
 * the user; only the sha256 hash is persisted in `PasswordResetToken`.
 * On reset, we hash the inbound token and look up by hash. If the
 * database leaks, the live tokens are unusable without the matching
 * plaintext.
 */
export function generatePasswordResetToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString('base64url');
  return { raw, hash: hashResetToken(raw) };
}

export function hashResetToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/** Reset tokens live for 1 hour — short enough to limit blast radius if
 *  an email is forwarded; long enough that a user finishing dinner before
 *  clicking still works. */
export const PASSWORD_RESET_TTL_SECONDS = 60 * 60;
