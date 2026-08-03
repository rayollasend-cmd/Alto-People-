/**
 * Open-redirect guard for post-auth destinations.
 *
 * A value is only accepted when it's a same-origin ABSOLUTE PATH. The
 * subtle case is `//evil.com`: it starts with `/`, so a naive
 * `startsWith('/')` check passes it, but browsers treat it as
 * protocol-relative and navigate off-site. Backslashes are rejected too
 * because some browsers normalise `/\evil.com` the same way.
 */
export function safeNextPath(
  candidate: string | null | undefined,
  fallback = '/',
): string {
  if (!candidate) return fallback;
  if (!candidate.startsWith('/')) return fallback;
  if (candidate.startsWith('//')) return fallback;
  if (candidate.startsWith('/\\')) return fallback;
  return candidate;
}
