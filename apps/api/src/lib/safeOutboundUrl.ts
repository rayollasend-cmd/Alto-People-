import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { HttpError } from '../middleware/error.js';

/**
 * SSRF guard for URLs that the SERVER will fetch on a user's behalf
 * (outbound webhooks today; any future callback/import URL).
 *
 * Two properties are enforced:
 *
 *  1. **https only.** `http:` is refused because a webhook body carries
 *     HR data and its HMAC signature; `file:`, `gopher:` and friends are
 *     refused because they aren't fetches at all.
 *  2. **Public destinations only.** The hostname is resolved and every
 *     returned address checked against the private, loopback, link-local
 *     and carrier-grade-NAT ranges. Without this a `manage:integrations`
 *     holder could point a webhook at the cloud metadata endpoint
 *     (169.254.169.254) or an internal Postgres port and read the reply.
 *
 * Note the residual TOCTOU: DNS can change between this check and the
 * fetch. Closing that needs a pinned-IP agent; the pairing here is
 * "validate + never return the response body to the caller", which is
 * what removes the payoff.
 */

/** RFC1918 + loopback + link-local + CGNAT + unique-local (v6). */
function isPrivateAddress(addr: string): boolean {
  const family = isIP(addr);
  if (family === 4) {
    const p = addr.split('.').map(Number);
    const [a, b] = [p[0] ?? 0, p[1] ?? 0];
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // loopback
    if (a === 0) return true; // "this network"
    if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
    if (a >= 224) return true; // multicast + reserved
    return false;
  }
  if (family === 6) {
    const lower = addr.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fe80')) return true; // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique-local
    // IPv4-mapped (::ffff:10.0.0.1) — re-check the embedded v4 address.
    const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped?.[1]) return isPrivateAddress(mapped[1]);
    return false;
  }
  return true; // unparseable → refuse
}

/**
 * Validates an outbound URL. Throws HttpError(400) when it isn't a
 * public https destination. Returns the parsed URL on success.
 */
export async function assertSafeOutboundUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, 'invalid_url', 'That is not a valid URL.');
  }
  if (url.protocol !== 'https:') {
    throw new HttpError(
      400,
      'insecure_url',
      'Webhook URLs must use https — the payload carries HR data.',
    );
  }
  if (url.username || url.password) {
    throw new HttpError(400, 'invalid_url', 'Credentials in the URL are not allowed.');
  }

  const host = url.hostname.replace(/^\[|\]$/g, '');
  // A literal IP needs no DNS round trip.
  if (isIP(host)) {
    if (isPrivateAddress(host)) {
      throw new HttpError(400, 'private_url', 'That address is not publicly routable.');
    }
    return url;
  }

  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new HttpError(400, 'unresolvable_host', 'That hostname does not resolve.');
  }
  if (addresses.length === 0) {
    throw new HttpError(400, 'unresolvable_host', 'That hostname does not resolve.');
  }
  // EVERY address must be public — one private answer in a round-robin
  // set is enough to reach the internal network.
  for (const a of addresses) {
    if (isPrivateAddress(a.address)) {
      throw new HttpError(400, 'private_url', 'That address is not publicly routable.');
    }
  }
  return url;
}
