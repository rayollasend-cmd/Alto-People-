import { z } from 'zod';

/**
 * URL validation for values that a human types and the product later
 * renders as a link.
 *
 * Zod's `.url()` only asserts that `new URL()` parses the string — it
 * accepts `javascript:alert(1)` and `data:text/html,<script>…`. Several
 * fields used it: `Candidate.resumeUrl` / `linkedinUrl` (submitted through
 * the PUBLIC, unauthenticated careers form), VTO evidence, tuition
 * receipts, agreement documents, internal-job resumes. Each is rendered
 * straight into an `href` on an authenticated staff screen, so a
 * `javascript:` value was stored XSS reachable by anyone on the internet.
 *
 * `target="_blank"` is NOT a mitigation: browsers ignore `target` for the
 * `javascript:` scheme and execute in the current document.
 */

const HTTP_SCHEME = /^https?:\/\//i;

/** True when the value is a syntactically valid http(s) URL. */
export function isHttpUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  if (!HTTP_SCHEME.test(value)) return false;
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Safe `href` value. Returns `undefined` for anything that isn't an
 * http(s) URL, so the caller renders a non-link rather than an
 * executable one — defense in depth for rows written before the schema
 * below was introduced.
 */
export function safeHref(value: string | null | undefined): string | undefined {
  return isHttpUrl(value) ? (value as string) : undefined;
}

/**
 * Zod schema for user-supplied links: valid URL AND an http(s) scheme.
 *
 * Use `httpUrl(max)` when a length cap is needed — `.refine()` returns a
 * ZodEffects, which has no `.max()`, so the cap has to be applied to the
 * string before the scheme check rather than chained after it.
 */
export function httpUrl(maxLength = 2000) {
  return z
    .string()
    .max(maxLength)
    .url()
    .refine(isHttpUrl, { message: 'Must be an http:// or https:// URL' });
}

export const HttpUrlSchema = httpUrl();
