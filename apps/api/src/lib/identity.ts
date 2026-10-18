import { createHash, randomBytes } from 'node:crypto';
import { resolveTxt } from 'node:dns/promises';
import type { IdentityConnection, PrismaClient, User } from '@prisma/client';
import { env } from '../config/env.js';
import { HttpError } from '../middleware/error.js';
import { enqueueAudit, recordCriticalAudit } from './audit.js';
import { decryptString, encryptString } from './crypto.js';
import { getOidcSettings, type OidcSettings } from './oidc.js';
import { ALTO_TENANT_ID, withIdentityScope, runWithTenant } from './tenant.js';

/**
 * Brief 2-3 step 2 — identity per tenant (docs/identity-rbac-audit-investigation.md §4.1, §4.2).
 *
 *   Connections: a tenant's own OIDC IdP, its client secret sealed with the
 *   payout key machinery. The environment IdP became Alto HR's first row
 *   (ensureEnvIdentity, at boot and on the legacy button), and stays in step
 *   with the environment while it is set.
 *
 *   Discovery (decision 1): an email's domain, verified by DNS TXT, names a
 *   tenant; its enabled connections are offered. Nothing about an account
 *   is revealed: an unknown domain and a known one with no connection answer
 *   the same. A tenant slug is the fallback for shared domains.
 *
 *   Subject binding (decision 2): the first SSO sign-in links the person by
 *   email inside the connection's tenant; every later one matches the IdP
 *   subject, never the email. A different subject for an already linked
 *   person is refused and audited (the email-reuse takeover).
 *
 *   SCIM tokens: hashed, shown once; the token decides the tenant.
 *
 *   Tenancy note for the enforcing step (2-1 step four): discovery, the
 *   SCIM token lookup and the subject lookup run BEFORE anyone's tenant is
 *   known (a login page, a bearer), so they read across tenants by design
 *   and name the tenant they find explicitly afterwards. When the wall
 *   enforces, these lookups move under a narrow platform path.
 */

type Db = PrismaClient;

/* ---------------------------------------------------------- connections */

export function connectionSettings(c: Pick<IdentityConnection, 'issuerUrl' | 'clientId' | 'clientSecretEnc' | 'buttonLabel' | 'displayName'>): OidcSettings {
  return { issuerUrl: c.issuerUrl, clientId: c.clientId, clientSecret: decryptString(c.clientSecretEnc), buttonLabel: c.buttonLabel ?? `Continue with ${c.displayName}` };
}

/**
 * The environment IdP as Alto HR's connection: created once, then kept in step
 * with the environment while the variables are set (a rotated secret rotates
 * here). With the variables unset, the row is ordinary data, managed in the app.
 */
export async function ensureEnvIdentity(db: Db): Promise<IdentityConnection | null> {
  // The environment connection is Alto HR's, whoever's request asks: under
  // TENANCY_MODE=enforce a read for Alto's row from another tenant's
  // context would throw, so this runs as Alto.
  return runWithTenant(ALTO_TENANT_ID, 'job', () => syncEnvIdentity(db));
}

async function syncEnvIdentity(db: Db): Promise<IdentityConnection | null> {
  const s = getOidcSettings();
  const existing = await db.identityConnection.findFirst({ where: { tenantId: ALTO_TENANT_ID, fromEnvironment: true } });
  if (!s) return existing;
  if (!existing) {
    return db.identityConnection.create({
      data: { tenantId: ALTO_TENANT_ID, kind: 'OIDC', displayName: 'Company sign-in', buttonLabel: s.buttonLabel, issuerUrl: s.issuerUrl, clientId: s.clientId, clientSecretEnc: encryptString(s.clientSecret), fromEnvironment: true },
    });
  }
  const current = connectionSettings(existing);
  if (current.issuerUrl === s.issuerUrl && current.clientId === s.clientId && current.clientSecret === s.clientSecret && existing.buttonLabel === s.buttonLabel) return existing;
  return db.identityConnection.update({ where: { id: existing.id }, data: { issuerUrl: s.issuerUrl, clientId: s.clientId, clientSecretEnc: encryptString(s.clientSecret), buttonLabel: s.buttonLabel } });
}

/** The environment SCIM_TOKEN as Alto HR's first SCIM token row. */
export async function ensureEnvScimToken(db: Db): Promise<void> {
  return runWithTenant(ALTO_TENANT_ID, 'job', () => syncEnvScimToken(db));
}

async function syncEnvScimToken(db: Db): Promise<void> {
  const t = env.SCIM_TOKEN?.trim();
  if (!t) return;
  const hashedSecret = hashToken(t);
  if (await db.scimToken.findUnique({ where: { hashedSecret }, select: { id: true } })) return;
  await db.scimToken.create({ data: { tenantId: ALTO_TENANT_ID, name: 'Environment SCIM_TOKEN (migrated)', hashedSecret, last4: t.slice(-4) } });
}

export interface PublicConnection {
  id: string;
  label: string;
}

const publicOf = (c: Pick<IdentityConnection, 'id' | 'buttonLabel' | 'displayName'>): PublicConnection => ({ id: c.id, label: c.buttonLabel ?? `Continue with ${c.displayName}` });

/* ------------------------------------------------------------ discovery */

export function domainOf(email: string): string | null {
  const m = /@([^@\s]+)$/.exec(email.trim().toLowerCase());
  return m ? m[1]!.replace(/\.$/, '') : null;
}

/** The sign-in a person's email domain leads to. Same empty answer for every reason there is none. */
export async function discoverByEmail(db: Db, email: string): Promise<PublicConnection[]> {
  // The login page asks before anyone is known: a lookup by unique domain.
  return withIdentityScope(() => discoverByEmailResolved(db, email));
}

async function discoverByEmailResolved(db: Db, email: string): Promise<PublicConnection[]> {
  const domain = domainOf(email);
  if (!domain) return [];
  const d = await db.tenantDomain.findUnique({ where: { domain }, select: { tenantId: true, verifiedAt: true } });
  if (!d?.verifiedAt || !d.tenantId) return [];
  const rows = await db.identityConnection.findMany({ where: { tenantId: d.tenantId, enabled: true }, orderBy: { createdAt: 'asc' }, select: { id: true, buttonLabel: true, displayName: true } });
  return rows.map(publicOf);
}

/** The fallback for shared domains: /login/<slug>. */
export async function discoverBySlug(db: Db, slug: string): Promise<PublicConnection[]> {
  return withIdentityScope(() => discoverBySlugResolved(db, slug));
}

async function discoverBySlugResolved(db: Db, slug: string): Promise<PublicConnection[]> {
  const t = await db.tenant.findUnique({ where: { slug: slug.toLowerCase() }, select: { id: true, status: true } });
  if (!t || t.status !== 'ACTIVE') return [];
  const rows = await db.identityConnection.findMany({ where: { tenantId: t.id, enabled: true }, orderBy: { createdAt: 'asc' }, select: { id: true, buttonLabel: true, displayName: true } });
  return rows.map(publicOf);
}

/* -------------------------------------------------------------- domains */

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
/** Domains no tenant may claim: they are shared by everyone. */
const SHARED = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'live.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'mail.com']);

export const txtRecordFor = (token: string) => `alto-verification=${token}`;

export async function addDomain(db: Db, tenantId: string, raw: string, actorUserId: string) {
  const domain = raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '');
  if (!DOMAIN_RE.test(domain)) throw new HttpError(400, 'invalid_domain', 'That is not a domain name.');
  if (SHARED.has(domain)) throw new HttpError(400, 'shared_domain', 'A shared email domain cannot name one organization; use the sign-in link with your organization’s slug instead.');
  const taken = await db.tenantDomain.findUnique({ where: { domain }, select: { tenantId: true } });
  // Another tenant's domain answers like any taken domain: no detail about whose it is.
  if (taken) throw new HttpError(409, 'domain_taken', 'That domain is already registered.');
  const row = await db.tenantDomain.create({ data: { tenantId, domain, verificationToken: randomBytes(16).toString('hex'), createdById: actorUserId } });
  enqueueAudit({ actorUserId, clientId: null, tenantId, action: 'identity.domain_added', entityType: 'TenantDomain', entityId: row.id, metadata: { domain } }, 'identity');
  return row;
}

type TxtResolver = (domain: string) => Promise<string[][]>;
let txtResolver: TxtResolver = resolveTxt;
export function setTxtResolverForTests(fn: TxtResolver | null): void {
  txtResolver = fn ?? resolveTxt;
}

/** Looks the TXT record up now; verified once found, and stays verified. */
export async function verifyDomain(db: Db, tenantId: string, id: string, actorUserId: string) {
  const row = await db.tenantDomain.findFirst({ where: { id, tenantId } });
  if (!row) throw new HttpError(404, 'domain_not_found', 'Domain not found.');
  if (row.verifiedAt) return row;
  // No record, a timeout and NXDOMAIN all read as "not there yet".
  const records: string[][] = await txtResolver(row.domain).catch(() => []);
  const found = records.some((parts) => parts.join('').trim() === txtRecordFor(row.verificationToken));
  const updated = await db.tenantDomain.update({ where: { id }, data: { lastCheckedAt: new Date(), ...(found ? { verifiedAt: new Date() } : {}) } });
  if (found) enqueueAudit({ actorUserId, clientId: null, tenantId, action: 'identity.domain_verified', entityType: 'TenantDomain', entityId: id, metadata: { domain: row.domain } }, 'identity');
  return updated;
}

/* ------------------------------------------------------ subject binding */

export type SsoMatch =
  | { ok: true; user: Pick<User, 'id' | 'email' | 'role' | 'status' | 'clientId' | 'tokenVersion' | 'tenantId'>; linked: boolean }
  | { ok: false; reason: 'unknown_email' | 'subject_changed' | 'wrong_tenant'; email: string };

/**
 * The account an SSO sign-in is for. By subject when the person is linked to
 * this connection; else, the first time, by email inside the connection's
 * tenant, and linked. Never by email once linked.
 */
export async function matchSsoUser(db: Db, conn: Pick<IdentityConnection, 'id' | 'tenantId'>, claims: { sub: string; email: string }): Promise<SsoMatch> {
  const email = claims.email.trim().toLowerCase();
  const tenantId = conn.tenantId ?? ALTO_TENANT_ID;
  const select = { id: true, email: true, role: true, status: true, clientId: true, tokenVersion: true, tenantId: true, deletedAt: true } as const;
  const bound = await db.userIdentity.findUnique({ where: { connectionId_subject: { connectionId: conn.id, subject: claims.sub } }, select: { user: { select } } });
  if (bound) {
    if (bound.user.deletedAt) return { ok: false, reason: 'unknown_email', email };
    if ((bound.user.tenantId ?? ALTO_TENANT_ID) !== tenantId) return { ok: false, reason: 'wrong_tenant', email };
    await db.userIdentity.update({ where: { connectionId_subject: { connectionId: conn.id, subject: claims.sub } }, data: { lastLoginAt: new Date() } });
    return { ok: true, user: bound.user, linked: false };
  }
  const user = await db.user.findFirst({ where: { email, deletedAt: null, tenantId }, select });
  if (!user) return { ok: false, reason: 'unknown_email', email };
  const prior = await db.userIdentity.findUnique({ where: { userId_connectionId: { userId: user.id, connectionId: conn.id } }, select: { subject: true } });
  if (prior) {
    // The same email arriving under another subject: the mailbox was reassigned or the IdP account replaced. Refuse; a person relinks it.
    await recordCriticalAudit({ actorUserId: null, clientId: user.clientId, tenantId, action: 'identity.subject_mismatch', entityType: 'User', entityId: user.id, metadata: { connectionId: conn.id, linkedSubject: prior.subject, presentedSubject: claims.sub } }, 'identity');
    return { ok: false, reason: 'subject_changed', email };
  }
  await db.userIdentity.create({ data: { tenantId, userId: user.id, connectionId: conn.id, subject: claims.sub, emailAtLink: email, lastLoginAt: new Date() } });
  enqueueAudit({ actorUserId: user.id, clientId: user.clientId, tenantId, action: 'identity.linked', entityType: 'User', entityId: user.id, metadata: { connectionId: conn.id, subject: claims.sub } }, 'identity');
  return { ok: true, user, linked: true };
}

/** Unlink a person from a connection (an admin, after the IdP account was replaced); the next SSO sign-in links afresh. */
export async function unlinkIdentity(db: Db, tenantId: string, userId: string, connectionId: string, actorUserId: string): Promise<void> {
  const r = await db.userIdentity.deleteMany({ where: { userId, connectionId, tenantId } });
  if (!r.count) throw new HttpError(404, 'identity_not_found', 'That person is not linked to this sign-in.');
  await recordCriticalAudit({ actorUserId, clientId: null, tenantId, action: 'identity.unlinked', entityType: 'User', entityId: userId, metadata: { connectionId } }, 'identity');
}

/* ---------------------------------------------------- SSO required (d4) */

/**
 * Password sign-in refused: the person is staff (not an associate) in a tenant
 * that requires its SSO. Access pack: a break-glass owner is not exempt here —
 * the login route lets them through only with a second factor
 * (lib/breakGlass.breakGlassVerdict).
 */
export async function ssoRequiredFor(db: Db, user: { role: string; tenantId: string | null }): Promise<boolean> {
  if (user.role === 'ASSOCIATE') return false;
  const n = await db.identityConnection.count({ where: { tenantId: user.tenantId ?? ALTO_TENANT_ID, enabled: true, ssoRequiredForStaff: true } });
  return n > 0;
}

/* ------------------------------------------------------------ SCIM (§4.2) */

export const SCIM_TOKEN_PREFIX = 'alto_scim_';
export const hashToken = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');

export async function issueScimToken(db: Db, tenantId: string, name: string, actorUserId: string): Promise<{ id: string; token: string; last4: string }> {
  const token = `${SCIM_TOKEN_PREFIX}${randomBytes(32).toString('hex')}`;
  const row = await db.scimToken.create({ data: { tenantId, name, hashedSecret: hashToken(token), last4: token.slice(-4), createdById: actorUserId } });
  await recordCriticalAudit({ actorUserId, clientId: null, tenantId, action: 'identity.scim_token_issued', entityType: 'ScimToken', entityId: row.id, metadata: { name, last4: row.last4 } }, 'identity');
  return { id: row.id, token, last4: row.last4 };
}

export async function revokeScimToken(db: Db, tenantId: string, id: string, actorUserId: string): Promise<void> {
  const r = await db.scimToken.updateMany({ where: { id, tenantId, revokedAt: null }, data: { revokedAt: new Date() } });
  if (!r.count) throw new HttpError(404, 'scim_token_not_found', 'No such active token.');
  await recordCriticalAudit({ actorUserId, clientId: null, tenantId, action: 'identity.scim_token_revoked', entityType: 'ScimToken', entityId: id, metadata: {} }, 'identity');
}

const touched = new Map<string, number>();

/** The tenant a presented SCIM bearer belongs to, or null. A hash lookup: nothing about a near miss leaks. */
export async function scimTenantFor(db: Db, presented: string): Promise<string | null> {
  // The bearer names the tenant; until it is known, the lookup is by its unique hash.
  const row = await withIdentityScope(() => db.scimToken.findUnique({ where: { hashedSecret: hashToken(presented) }, select: { id: true, tenantId: true, revokedAt: true } }));
  if (!row || row.revokedAt) return null;
  const now = Date.now();
  if ((touched.get(row.id) ?? 0) < now - 60_000) {
    touched.set(row.id, now);
    void withIdentityScope(() => db.scimToken.update({ where: { id: row.id }, data: { lastUsedAt: new Date(now) } })).catch(() => {});
  }
  return row.tenantId ?? ALTO_TENANT_ID;
}
