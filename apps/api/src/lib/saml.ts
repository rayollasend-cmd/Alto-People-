import { SAML, ValidateInResponseTo, type CacheItem, type CacheProvider, type Profile } from '@node-saml/node-saml';
import type { IdentityConnection, PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';

/**
 * Brief 2-3 step 5 — SAML 2.0 sign-in per connection (docs/identity-rbac-
 * audit-investigation.md §4.1, decision 6). A SAML connection is an
 * IdentityConnection with kind SAML: issuerUrl = the IdP's single sign-on
 * URL, clientId = the IdP's entity id, samlIdpCert = its signing
 * certificate.
 *
 *   SP-initiated only by default: every response must answer an
 *   AuthnRequest we sent (InResponseTo, once). IdP-initiated responses are
 *   refused unless the connection turns them on.
 *   Assertions must be signed, addressed to us (audience = our entity id,
 *   recipient = our ACS URL) and fresh (2 minutes' skew). Every accepted
 *   assertion id is remembered until it would have expired anyway; the same
 *   assertion twice is refused (the replay cache), IdP-initiated or not.
 *
 * The ACS URL is un-prefixed (/auth/saml/acs/:id): the IdP POSTs a form
 * there as a top-level navigation, and the /api prefix's navigation bounce
 * would turn that POST into a GET and lose the response.
 */

export const SAML_REQUEST_TTL_MS = 10 * 60_000;
const ASSERTION_MEMORY_MS = 24 * 60 * 60_000;

export class SamlError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

const base = () => env.APP_BASE_URL.replace(/\/+$/, '');
/** Our entity id for this connection (what the IdP calls the "audience"). */
export const spEntityId = (conn: Pick<IdentityConnection, 'id'>) => `${base()}/auth/saml/metadata/${conn.id}`;
export const acsUrl = (conn: Pick<IdentityConnection, 'id'>) => `${base()}/auth/saml/acs/${conn.id}`;

/** node-saml's cache in our database: request ids (InResponseTo) and accepted assertion ids. */
export function dbCacheProvider(db: PrismaClient, prefix: string): CacheProvider {
  return {
    async saveAsync(key, value): Promise<CacheItem | null> {
      const now = Date.now();
      await db.samlCache.upsert({
        where: { key: `${prefix}${key}` },
        create: { key: `${prefix}${key}`, value: value.slice(0, 300), expiresAt: new Date(now + SAML_REQUEST_TTL_MS) },
        update: {},
      });
      return { value, createdAt: now };
    },
    async getAsync(key) {
      const row = await db.samlCache.findUnique({ where: { key: `${prefix}${key}` } });
      return row && row.expiresAt > new Date() ? row.value : null;
    },
    async removeAsync(key) {
      if (!key) return null;
      const row = await db.samlCache.deleteMany({ where: { key: `${prefix}${key}` } });
      return row.count ? key : null;
    },
  };
}

export function samlFor(conn: IdentityConnection, cache: CacheProvider): SAML {
  if (conn.kind !== 'SAML' || !conn.samlIdpCert) throw new SamlError('not_saml');
  return new SAML({
    entryPoint: conn.issuerUrl,
    idpIssuer: conn.clientId,
    idpCert: conn.samlIdpCert,
    issuer: spEntityId(conn),
    audience: spEntityId(conn),
    callbackUrl: acsUrl(conn),
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,
    acceptedClockSkewMs: 2 * 60_000,
    maxAssertionAgeMs: 60 * 60_000,
    identifierFormat: null,
    disableRequestedAuthnContext: true,
    signatureAlgorithm: 'sha256',
    validateInResponseTo: conn.allowIdpInitiated ? ValidateInResponseTo.ifPresent : ValidateInResponseTo.always,
    requestIdExpirationPeriodMs: SAML_REQUEST_TTL_MS,
    cacheProvider: cache,
  });
}

/** The IdP URL to send the browser to; `relayState` comes back with the response. */
export async function samlAuthorizeUrl(db: PrismaClient, conn: IdentityConnection, relayState: string): Promise<string> {
  return samlFor(conn, dbCacheProvider(db, `req:${conn.id}:`)).getAuthorizeUrlAsync(relayState, undefined, {});
}

export function samlMetadata(conn: IdentityConnection): string {
  return samlFor(conn, { saveAsync: async () => null, getAsync: async () => null, removeAsync: async () => null }).generateServiceProviderMetadata(null, null);
}

function emailOf(p: Profile): string | null {
  const candidates = [p.email, p.mail, p['urn:oid:0.9.2342.19200300.100.1.3'], p['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress'], p.nameID];
  for (const c of candidates) {
    const v = Array.isArray(c) ? c[0] : c;
    if (typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())) return v.trim().toLowerCase();
  }
  return null;
}

/**
 * Validate a POSTed SAMLResponse for this connection. Returns the subject
 * (NameID) and email, or throws SamlError with an audit reason.
 */
export async function validateSamlResponse(db: PrismaClient, conn: IdentityConnection, body: Record<string, string>, cache?: CacheProvider): Promise<{ sub: string; email: string; assertionId: string | null }> {
  if (typeof body.SAMLResponse !== 'string' || !body.SAMLResponse) throw new SamlError('missing_response');
  let profile: Profile | null;
  try {
    ({ profile } = await samlFor(conn, cache ?? dbCacheProvider(db, `req:${conn.id}:`)).validatePostResponseAsync(body));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new SamlError(
      /InResponseTo/i.test(msg) ? 'unsolicited_or_replayed' : /signature/i.test(msg) ? 'bad_signature' : /audience/i.test(msg) ? 'wrong_audience' : /expired|NotOnOrAfter|NotBefore/i.test(msg) ? 'expired' : /issuer/i.test(msg) ? 'wrong_issuer' : 'invalid_response',
    );
  }
  if (!profile || !profile.nameID) throw new SamlError('no_subject');
  const email = emailOf(profile);
  if (!email) throw new SamlError('no_email');
  // The replay cache: an assertion is accepted once.
  const xml = profile.getAssertionXml?.() ?? '';
  const assertionId = /<(?:[A-Za-z0-9]+:)?Assertion\b[^>]*\bID="([^"]+)"/.exec(xml)?.[1] ?? null;
  if (assertionId) {
    const key = `assertion:${conn.id}:${assertionId}`.slice(0, 300);
    const seen = await db.samlCache.findUnique({ where: { key } });
    if (seen) throw new SamlError('replayed_assertion');
    await db.samlCache.create({ data: { key, value: profile.nameID.slice(0, 300), expiresAt: new Date(Date.now() + ASSERTION_MEMORY_MS) } }).catch(() => {
      throw new SamlError('replayed_assertion');
    });
  }
  return { sub: profile.nameID, email, assertionId };
}

/** Drop expired request and assertion ids. */
export async function sweepSamlCache(db: PrismaClient, now: Date = new Date()): Promise<number> {
  return (await db.samlCache.deleteMany({ where: { expiresAt: { lt: now } } })).count;
}
