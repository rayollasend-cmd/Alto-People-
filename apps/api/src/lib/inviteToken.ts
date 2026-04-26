import { createHash, randomBytes } from 'node:crypto';

/**
 * Generates a cryptographically random invitation token.
 *
 * Returns BOTH the raw token (32 bytes → ~43-char base64url, ~256 bits of
 * entropy) and its SHA-256 hash. The raw token goes in the magic link
 * embedded in the email; only the hash is persisted in the database. On
 * accept, we hash the inbound token and look up by hash. If the database
 * leaks, the live tokens are unusable without the matching plaintext.
 */
export function generateInviteToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString('base64url');
  return { raw, hash: hashToken(raw) };
}

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}
