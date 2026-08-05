import {
  createHash,
  createHmac,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify as cryptoVerify,
  type JsonWebKey,
} from 'node:crypto';
import { env } from '../config/env.js';

/* ============================================================================
 * OIDC (OpenID Connect) authorization-code + PKCE support.
 *
 * Written against the OIDC Core spec with Microsoft Entra ID as the primary
 * target, but nothing here is Entra-specific: any IdP that publishes
 * {issuer}/.well-known/openid-configuration and signs ID tokens with RS256
 * works. Zero new dependencies — discovery/JWKS use global fetch, and ID
 * token signatures verify with node:crypto's native JWK import.
 *
 * All outbound calls carry a 10s timeout: the IdP sits on the login
 * critical path, and a hung discovery fetch must never wedge a request.
 * ========================================================================== */

const FETCH_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1h for both discovery and JWKS
/** Allowed clock skew when validating exp/iat (seconds). */
const CLOCK_SKEW_SECONDS = 300;

/**
 * Machine-readable failure taxonomy. The browser only ever sees a generic
 * `/login?error=sso_failed` redirect; `reason` lands in the
 * `auth.login_failed` audit row (prefixed `oidc_`) so forensics can tell
 * a key-rotation hiccup from an actual forged token.
 */
export class OidcError extends Error {
  constructor(
    public readonly reason: string,
    message?: string,
  ) {
    super(message ?? `OIDC failure: ${reason}`);
    this.name = 'OidcError';
  }
}

export interface OidcSettings {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  buttonLabel: string;
}

// Test seam: config/env.ts parses process.env exactly once per process, so
// integration tests (single-fork vitest, module cache shared across files)
// can't flip the feature on by mutating process.env. Same pattern as
// __setPayrollTaxConfigForTesting. `undefined` = no override (read env).
let testOverride: OidcSettings | null | undefined;

export function __setOidcEnvForTests(settings: OidcSettings | null): void {
  testOverride = settings;
}

export function __clearOidcEnvOverrideForTests(): void {
  testOverride = undefined;
}

/** Resolved settings, or null when the feature is off (env vars unset). */
export function getOidcSettings(): OidcSettings | null {
  if (testOverride !== undefined) return testOverride;
  if (!env.OIDC_ISSUER_URL || !env.OIDC_CLIENT_ID || !env.OIDC_CLIENT_SECRET) {
    return null;
  }
  return {
    issuerUrl: env.OIDC_ISSUER_URL,
    clientId: env.OIDC_CLIENT_ID,
    clientSecret: env.OIDC_CLIENT_SECRET,
    buttonLabel: env.OIDC_BUTTON_LABEL,
  };
}

/* ===== Discovery ======================================================== */

export interface DiscoveryDoc {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

let discoveryCache: {
  issuerUrl: string;
  doc: DiscoveryDoc;
  fetchedAt: number;
} | null = null;

async function fetchJson(url: string, failReason: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new OidcError(
      failReason,
      `fetch ${url} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    throw new OidcError(failReason, `fetch ${url} returned ${res.status}`);
  }
  try {
    return await res.json();
  } catch {
    throw new OidcError(failReason, `fetch ${url} returned non-JSON`);
  }
}

/** Issuer comparison per spec is exact-match; we only forgive a trailing slash. */
function normalizeIssuer(iss: string): string {
  return iss.replace(/\/+$/, '');
}

/**
 * Fetch + validate {issuer}/.well-known/openid-configuration. Cached
 * in-process for 1h — the document is effectively static, and hitting the
 * IdP on every login adds latency and a dependency we don't need.
 */
export async function getDiscovery(settings: OidcSettings): Promise<DiscoveryDoc> {
  if (
    discoveryCache &&
    discoveryCache.issuerUrl === settings.issuerUrl &&
    Date.now() - discoveryCache.fetchedAt < CACHE_TTL_MS
  ) {
    return discoveryCache.doc;
  }
  const base = settings.issuerUrl.replace(/\/+$/, '');
  const raw = (await fetchJson(
    `${base}/.well-known/openid-configuration`,
    'discovery_failed',
  )) as Record<string, unknown>;

  const issuer = raw?.issuer;
  const authorization_endpoint = raw?.authorization_endpoint;
  const token_endpoint = raw?.token_endpoint;
  const jwks_uri = raw?.jwks_uri;
  if (
    typeof issuer !== 'string' ||
    typeof authorization_endpoint !== 'string' ||
    typeof token_endpoint !== 'string' ||
    typeof jwks_uri !== 'string'
  ) {
    throw new OidcError('discovery_invalid', 'discovery document is missing required fields');
  }
  // Spec §4.3: the discovered issuer MUST match the configured one —
  // otherwise a DNS/redirect hijack of the well-known URL could point us
  // at an attacker-controlled token/JWKS endpoint.
  if (normalizeIssuer(issuer) !== normalizeIssuer(settings.issuerUrl)) {
    throw new OidcError(
      'issuer_mismatch',
      `discovery issuer "${issuer}" does not match configured "${settings.issuerUrl}"`,
    );
  }
  const doc: DiscoveryDoc = { issuer, authorization_endpoint, token_endpoint, jwks_uri };
  discoveryCache = { issuerUrl: settings.issuerUrl, doc, fetchedAt: Date.now() };
  return doc;
}

/* ===== JWKS ============================================================= */

interface Jwk {
  kty?: string;
  kid?: string;
  use?: string;
  alg?: string;
  n?: string;
  e?: string;
}

let jwksCache: { uri: string; keys: Jwk[]; fetchedAt: number } | null = null;

async function loadJwks(uri: string, force: boolean): Promise<Jwk[]> {
  if (
    !force &&
    jwksCache &&
    jwksCache.uri === uri &&
    Date.now() - jwksCache.fetchedAt < CACHE_TTL_MS
  ) {
    return jwksCache.keys;
  }
  const raw = (await fetchJson(uri, 'jwks_failed')) as { keys?: unknown };
  if (!Array.isArray(raw?.keys)) {
    throw new OidcError('jwks_invalid', 'JWKS document has no keys array');
  }
  const keys = raw.keys as Jwk[];
  jwksCache = { uri, keys, fetchedAt: Date.now() };
  return keys;
}

function pickKey(keys: Jwk[], kid: string): Jwk | undefined {
  return keys.find(
    (k) => k.kid === kid && k.kty === 'RSA' && (!k.use || k.use === 'sig'),
  );
}

/**
 * Resolve the RSA JWK for `kid`. Cached 1h; on a cache miss for the kid we
 * re-fetch exactly once — that's the normal signature of IdP key rotation
 * (Entra rotates signing keys roughly every 6 weeks), and one refetch
 * bounds the amplification an attacker gets by spraying bogus kids.
 */
async function getSigningJwk(jwksUri: string, kid: string): Promise<Jwk> {
  let keys = await loadJwks(jwksUri, false);
  let jwk = pickKey(keys, kid);
  if (!jwk) {
    keys = await loadJwks(jwksUri, true);
    jwk = pickKey(keys, kid);
  }
  if (!jwk) throw new OidcError('unknown_kid', `no RSA signing key with kid "${kid}"`);
  return jwk;
}

/* ===== ID-token validation ============================================= */

function decodeSegment(seg: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('segment is not an object');
  }
  return parsed as Record<string, unknown>;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function looksLikeEmail(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 254 && EMAIL_RE.test(v);
}

export interface VerifiedIdToken {
  /** Lower-cased later by the caller — returned as the IdP sent it. */
  email: string;
  sub: string;
  givenName: string | null;
  familyName: string | null;
  name: string | null;
}

/**
 * Full ID-token validation: RS256 signature against the IdP's JWKS, then
 * iss / aud / exp / iat (±300s skew) / nonce. Any failure throws OidcError.
 *
 * Email extraction: prefer the `email` claim. Entra ID sometimes omits it
 * (the claim rides on the user having a Mail attribute / the app having
 * the email claim mapped), so fall back to `preferred_username` — but ONLY
 * when it actually looks like an email address: for some Entra accounts
 * preferred_username is a UPN like "user@tenant.onmicrosoft.com" (fine,
 * still an email-shaped identifier the org provisioned) or a phone number
 * (not fine — never match users on that).
 */
export async function verifyIdToken(
  idToken: string,
  opts: { settings: OidcSettings; discovery: DiscoveryDoc; nonce: string },
): Promise<VerifiedIdToken> {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new OidcError('malformed_token');

  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = decodeSegment(parts[0]);
    payload = decodeSegment(parts[1]);
  } catch {
    throw new OidcError('malformed_token');
  }

  // RS256 only. Rejecting everything else kills the classic alg-confusion
  // attacks ("none", or HS256 signed with the public key as the HMAC secret).
  if (header.alg !== 'RS256') throw new OidcError('bad_alg', `alg "${String(header.alg)}"`);
  if (typeof header.kid !== 'string' || header.kid.length === 0) {
    throw new OidcError('missing_kid');
  }

  const jwk = await getSigningJwk(opts.discovery.jwks_uri, header.kid);
  let publicKey;
  try {
    publicKey = createPublicKey({ key: jwk as JsonWebKey, format: 'jwk' });
  } catch {
    throw new OidcError('bad_jwk');
  }

  let signatureOk = false;
  try {
    signatureOk = cryptoVerify(
      'sha256',
      Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8'),
      publicKey,
      Buffer.from(parts[2], 'base64url'),
    );
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) throw new OidcError('bad_signature');

  // Claims — only checked AFTER the signature so every value is trusted.
  if (
    typeof payload.iss !== 'string' ||
    normalizeIssuer(payload.iss) !== normalizeIssuer(opts.discovery.issuer)
  ) {
    throw new OidcError('bad_issuer');
  }
  const aud = payload.aud;
  const audOk =
    aud === opts.settings.clientId ||
    (Array.isArray(aud) && aud.length === 1 && aud[0] === opts.settings.clientId);
  if (!audOk) throw new OidcError('bad_audience');

  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp <= nowSec - CLOCK_SKEW_SECONDS) {
    throw new OidcError('token_expired');
  }
  if (typeof payload.iat !== 'number' || payload.iat > nowSec + CLOCK_SKEW_SECONDS) {
    throw new OidcError('bad_iat');
  }
  if (typeof payload.nonce !== 'string' || payload.nonce !== opts.nonce) {
    throw new OidcError('nonce_mismatch');
  }
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    throw new OidcError('missing_sub');
  }

  const email = looksLikeEmail(payload.email)
    ? payload.email
    : looksLikeEmail(payload.preferred_username)
      ? payload.preferred_username
      : null;
  if (!email) throw new OidcError('no_email');

  return {
    email,
    sub: payload.sub,
    givenName: typeof payload.given_name === 'string' ? payload.given_name : null,
    familyName: typeof payload.family_name === 'string' ? payload.family_name : null,
    name: typeof payload.name === 'string' ? payload.name : null,
  };
}

/* ===== Token exchange =================================================== */

/**
 * Authorization-code exchange at the token endpoint. client_secret_post
 * (credentials in the form body — what Entra app registrations expect by
 * default) plus the PKCE code_verifier. Returns the raw id_token; the
 * access token is intentionally discarded — we never call userinfo, the
 * ID token carries everything we consume.
 */
export async function exchangeCode(opts: {
  settings: OidcSettings;
  discovery: DiscoveryDoc;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<string> {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: opts.settings.clientId,
    client_secret: opts.settings.clientSecret,
    code_verifier: opts.codeVerifier,
  });
  let res: Response;
  try {
    res = await fetch(opts.discovery.token_endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: form.toString(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new OidcError(
      'token_endpoint_unreachable',
      err instanceof Error ? err.message : String(err),
    );
  }
  if (!res.ok) {
    throw new OidcError('token_exchange_failed', `token endpoint returned ${res.status}`);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new OidcError('token_exchange_failed', 'token endpoint returned non-JSON');
  }
  const idToken = (body as { id_token?: unknown })?.id_token;
  if (typeof idToken !== 'string' || idToken.length === 0) {
    throw new OidcError('no_id_token');
  }
  return idToken;
}

/* ===== PKCE + flow-state cookie ======================================== */

export const OIDC_FLOW_TTL_MS = 10 * 60 * 1000;

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  return { verifier, challenge };
}

export interface OidcFlowState {
  state: string;
  nonce: string;
  verifier: string;
}

function flowSignature(body: string): string {
  return createHmac('sha256', env.JWT_SECRET).update(body, 'utf8').digest('base64url');
}

/**
 * Compact HMAC-signed cookie value carrying the per-flow secrets between
 * /start and /callback: `ts.state.nonce.verifier.sig`. All four payload
 * parts are dot-free (base36 timestamp, hex, hex, base64url) so splitting
 * on '.' is unambiguous. Signed with JWT_SECRET — same trust root as the
 * session itself; a party who can forge this can already mint sessions.
 * The embedded timestamp gives a server-side 10-minute expiry that a
 * captured cookie can't sidestep by ignoring the browser Max-Age.
 */
export function signFlowCookie(flow: OidcFlowState): string {
  const body = [Date.now().toString(36), flow.state, flow.nonce, flow.verifier].join('.');
  return `${body}.${flowSignature(body)}`;
}

export function verifyFlowCookie(raw: string): OidcFlowState | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 1024) return null;
  const parts = raw.split('.');
  if (parts.length !== 5) return null;
  const [ts, state, nonce, verifier, sig] = parts;
  const expected = flowSignature([ts, state, nonce, verifier].join('.'));
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const issuedAt = parseInt(ts, 36);
  if (
    !Number.isFinite(issuedAt) ||
    Date.now() - issuedAt > OIDC_FLOW_TTL_MS ||
    issuedAt > Date.now() + 60_000 // future-dated = tampered clock math
  ) {
    return null;
  }
  if (!state || !nonce || !verifier) return null;
  return { state, nonce, verifier };
}

/**
 * Single-use enforcement for the callback. Clearing the cookie only helps
 * against cooperative browsers — a captured cookie value replays fine — so
 * we also remember consumed `state` values (32B random hex, unique per
 * flow) in-process for the flow TTL and reject a second consumption.
 *
 * Per-process, like the user cache in middleware/auth.ts: fine on the
 * single-container Railway deployment; a multi-replica deploy would need
 * a shared store (see the MULTI_REPLICA sentinel pattern) — worst case
 * today would be one replay per extra replica within 10 minutes, using a
 * cookie that had to be stolen off the wire first.
 */
const consumedStates = new Map<string, number>();

export function consumeFlowState(state: string): boolean {
  const now = Date.now();
  for (const [k, exp] of consumedStates) {
    if (exp <= now) consumedStates.delete(k);
  }
  if (consumedStates.has(state)) return false;
  consumedStates.set(state, now + OIDC_FLOW_TTL_MS);
  return true;
}

/** Test-only: drop discovery/JWKS caches and the consumed-state set. */
export function __resetOidcCachesForTests(): void {
  discoveryCache = null;
  jwksCache = null;
  consumedStates.clear();
}
