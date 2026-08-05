/**
 * Redaction for anything on its way to Sentry.
 *
 * This product handles SSNs, bank details, and kiosk PINs. Error
 * telemetry is a side channel into all of it: URLs carry identifiers in
 * their query strings, breadcrumbs record fetch targets and DOM input,
 * and arbitrary `extra` context is attached at capture sites. None of it
 * was filtered.
 *
 * Two passes: strip query strings from anything URL-shaped, and censor
 * any object key whose NAME looks sensitive (we never try to detect
 * sensitive *values* — that direction has no reliable signal).
 */

const SENSITIVE_KEY =
  /(ssn|social|routing|account_?number|accountnumber|passw|secret|token|pin\b|dob|birth|salary|bank|iban|cvv|authorization|cookie|selfie|descriptor)/i;

const REDACTED = '[redacted]';

/** Drops the query string and fragment from a URL-ish string. */
export function stripUrlSecrets(value: string): string {
  try {
    const u = new URL(value, 'https://placeholder.invalid');
    // Keep the path shape (useful for grouping), lose the payload.
    return u.pathname + (u.search ? '?[redacted]' : '');
  } catch {
    return value.split('?')[0] ?? value;
  }
}

/** Recursively censor sensitive-looking keys. Depth-capped. */
export function scrubDeep(input: unknown, depth = 0): unknown {
  if (depth > 6 || input === null || input === undefined) return input;
  if (Array.isArray(input)) return input.map((v) => scrubDeep(v, depth + 1));
  if (typeof input !== 'object') return input;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY.test(k) ? REDACTED : scrubDeep(v, depth + 1);
  }
  return out;
}
