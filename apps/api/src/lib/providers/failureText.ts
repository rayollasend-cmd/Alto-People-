import type { ProviderKindName } from './catalog.js';

/**
 * What a provider failure says to the admin reading the Integrations page.
 *
 * A failed call is recorded with the vendor's own words ("wise_profiles_
 * failed (HTTP 401): Invalid token") because that is what support needs.
 * It is not what an HR admin should read on a card: they need to know what
 * stopped and what to do. So every surface that shows a stored failure
 * passes it through here and gets two fields back:
 *
 *   message  one plain sentence — what broke and the next step
 *            ("Wise rejected the saved credentials — reconnect to resume
 *            payouts.")
 *   detail   the recorded technical text, for a "details" disclosure and
 *            for support; null when the message already is the record
 *
 * A failure that is already a plain sentence ("Enter the client ID and
 * secret.") is returned as it is, with no detail.
 */

export interface ProviderFailureText {
  message: string;
  detail: string | null;
}

/** What each kind of connection keeps running, for "reconnect to resume …". */
const RESUMES: Record<ProviderKindName, string> = {
  EVERIFY: 'E-Verify cases',
  BACKGROUND_CHECK: 'background checks',
  DRUG_TEST: 'drug tests',
  TAX_FILING: 'e-filing',
  PAYOUT: 'payouts',
  EMBEDDED_PAYROLL: 'payroll tax filing',
  TAX_ENGINE: 'tax calculations',
  ORIGINATION: 'bank payments',
  BANK_FEED: 'bank feeds',
};

/** Marks of a machine-written failure: an HTTP status, a snake_case code, a vendor's "answered 4xx". */
const TECHNICAL = /\bHTTP\s*\d{3}\b|\b[a-z]+(?:_[a-z0-9]+){1,}\b|\banswered\s+\d{3}\b|\b(?:ECONN\w+|ENOTFOUND|ETIMEDOUT)\b|\bstatus\s*\d{3}\b/;

function statusOf(raw: string): number | null {
  const m = /\b(?:HTTP\s*|answered\s+|status\s*)(\d{3})\b/i.exec(raw);
  return m ? Number(m[1]) : null;
}

export function providerFailureText(
  raw: string | null | undefined,
  provider: { label: string; kind?: ProviderKindName | string | null },
): ProviderFailureText | null {
  const text = (raw ?? '').trim();
  if (!text) return null;
  const who = provider.label || 'The provider';
  const resumes = provider.kind && provider.kind in RESUMES ? RESUMES[provider.kind as ProviderKindName] : null;
  const status = statusOf(text);
  const withDetail = (message: string): ProviderFailureText => ({ message, detail: text === message ? null : text });

  if (status === 401 || status === 403 || /refused the (?:token|credentials|user id)|invalid (?:token|credentials|api key)|bad authentication|authentication failed|unauthori[sz]ed|forbidden|auth_failed/i.test(text)) {
    return withDetail(`${who} rejected the saved credentials — reconnect to resume ${resumes ?? 'this connection'}.`);
  }
  if (/did not answer in time|timed? ?out|ETIMEDOUT/i.test(text)) {
    return withDetail(`${who} didn't answer in time. Test the connection again in a few minutes.`);
  }
  if (/could not reach|unreachable|ENOTFOUND|ECONNREFUSED|ECONNRESET/i.test(text)) {
    return withDetail(`We couldn't reach ${who}. Check the connection's address, then test it again.`);
  }
  if (/signature does not match/i.test(text)) {
    return withDetail(`A message from ${who} failed its signature check — check the webhook key on the connection.`);
  }
  if (/is not one of its profiles/i.test(text)) {
    return withDetail(`The saved ${who} token works, but the profile ID isn't one of its profiles — check the profile ID on the connection.`);
  }
  if (status !== null && status >= 500) {
    return withDetail(`${who} had a problem on their side. Test the connection again in a few minutes.`);
  }
  if (status === 429) {
    return withDetail(`${who} is limiting requests right now. Test the connection again in a few minutes.`);
  }
  if (status !== null || TECHNICAL.test(text)) {
    return withDetail(`${who} turned the request down. Check the connection's settings, then test it again.`);
  }
  // Already a plain sentence (given a capital, when a lower-case reason was recorded).
  return { message: text.charAt(0).toUpperCase() + text.slice(1), detail: null };
}
