import { hash, verify } from '@node-rs/argon2';

// @node-rs/argon2 defaults to Argon2id; no options needed for the
// recommended profile.
export async function hashPassword(plain: string): Promise<string> {
  return hash(plain);
}

export async function verifyPassword(
  storedHash: string,
  plain: string
): Promise<boolean> {
  try {
    return await verify(storedHash, plain);
  } catch {
    return false;
  }
}

/**
 * Pre-computed argon2id hash of a fixed dummy password.
 * Used by the login flow to keep timing constant when:
 *   - the email doesn't exist
 *   - the user has no passwordHash (INVITED)
 *   - the user is DISABLED, deleted, or LIVE_ASN
 * so an attacker cannot enumerate emails by response time.
 */
export const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$YWx0by1wZW9wbGUtZHVtbXktc2FsdA$X8GmRkk8mO3RTHRzBuWdt5lQzqH6hNhO8vBldqsCZWY';
