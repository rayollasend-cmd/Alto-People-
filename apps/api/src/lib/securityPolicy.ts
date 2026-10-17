import type { PrismaClient, Role } from '@prisma/client';
import { prisma } from '../db.js';
import { ALTO_TENANT_ID } from './tenant.js';

/**
 * Access pack — a tenant's sign-in posture beyond its identity provider.
 *
 *   - CIDR allowlists per role class (internal staff, client accounts,
 *     associates): a session from outside the list is refused on every
 *     request, not only at sign-in, so a policy change bites at once.
 *   - Session life: idle (minutes since the last request) and absolute
 *     (hours since sign-in). Enforced in attachUser from the token's own
 *     claims — no session table, no extra query.
 *   - Device trust: a two-step sign-in may remember the device for N days;
 *     a new device is challenged again (lib/trustedDevices).
 *   - Break-glass: whether the tenant's named owners may use password +
 *     two-step while SSO is required (an IdP outage must not lock every
 *     admin out).
 *
 * The policy is read on every request, so it is cached per tenant for a
 * short while; a save clears the cache in this process.
 */

export type RoleClass = 'internal' | 'client' | 'associate';

export interface SecurityPolicy {
  sessionIdleMinutes: number | null;
  sessionAbsoluteHours: number | null;
  allowedCidrsInternal: string[];
  allowedCidrsClient: string[];
  allowedCidrsAssociate: string[];
  deviceTrustEnabled: boolean;
  deviceTrustDays: number;
  breakGlassEnabled: boolean;
}

export const NO_POLICY: SecurityPolicy = {
  sessionIdleMinutes: null,
  sessionAbsoluteHours: null,
  allowedCidrsInternal: [],
  allowedCidrsClient: [],
  allowedCidrsAssociate: [],
  deviceTrustEnabled: false,
  deviceTrustDays: 30,
  breakGlassEnabled: true,
};

const CACHE_MS = 30_000;
const cache = new Map<string, { at: number; policy: SecurityPolicy }>();

export function resetSecurityPolicyCache(tenantId?: string): void {
  if (tenantId) cache.delete(tenantId);
  else cache.clear();
}

export async function loadSecurityPolicy(tenantId: string | null | undefined, db: PrismaClient = prisma): Promise<SecurityPolicy> {
  const id = tenantId ?? ALTO_TENANT_ID;
  const hit = cache.get(id);
  if (hit && process.env.NODE_ENV !== 'test' && Date.now() - hit.at < CACHE_MS) return hit.policy;
  const row = await db.tenantSecurityPolicy.findUnique({ where: { tenantId: id } });
  const policy: SecurityPolicy = row
    ? {
        sessionIdleMinutes: row.sessionIdleMinutes,
        sessionAbsoluteHours: row.sessionAbsoluteHours,
        allowedCidrsInternal: row.allowedCidrsInternal,
        allowedCidrsClient: row.allowedCidrsClient,
        allowedCidrsAssociate: row.allowedCidrsAssociate,
        deviceTrustEnabled: row.deviceTrustEnabled,
        deviceTrustDays: row.deviceTrustDays,
        breakGlassEnabled: row.breakGlassEnabled,
      }
    : NO_POLICY;
  cache.set(id, { at: Date.now(), policy });
  return policy;
}

/** Which allowlist a role answers to. */
export function roleClassOf(role: Role | string): RoleClass {
  if (role === 'ASSOCIATE') return 'associate';
  if (role === 'CLIENT_PORTAL') return 'client';
  return 'internal';
}

export function allowedCidrsFor(policy: SecurityPolicy, role: Role | string): string[] {
  const cls = roleClassOf(role);
  return cls === 'associate' ? policy.allowedCidrsAssociate : cls === 'client' ? policy.allowedCidrsClient : policy.allowedCidrsInternal;
}

/* ------------------------------------------------------------- CIDR match */

function parseV4(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  let n = 0;
  for (let i = 1; i <= 4; i += 1) {
    const o = Number(m[i]);
    if (o > 255) return null;
    n = n * 256 + o;
  }
  return n;
}

function parseV6(ip: string): bigint | null {
  if (!ip.includes(':')) return null;
  let s = ip;
  // An IPv4-mapped tail ("::ffff:1.2.3.4") becomes two hextets.
  const v4 = /^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s);
  if (v4) {
    const n = parseV4(v4[2]!);
    if (n === null) return null;
    s = `${v4[1]}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const parts = [...head, ...Array<string>(missing).fill('0'), ...tail];
  let n = 0n;
  for (const p of parts) {
    if (!/^[0-9a-f]{1,4}$/i.test(p)) return null;
    n = (n << 16n) + BigInt(parseInt(p, 16));
  }
  return n;
}

/** The address, normalized: an IPv4-mapped IPv6 reads as its IPv4. */
function normalize(ip: string): string {
  const m = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(ip.trim());
  return m ? m[1]! : ip.trim();
}

/** True when `ip` is inside `cidr` ("10.0.0.0/8", "203.0.113.7", "2001:db8::/32"). */
export function ipInCidr(ip: string, cidr: string): boolean {
  const addr = normalize(ip);
  const [range, bitsRaw] = cidr.trim().split('/');
  if (!range) return false;
  const v4 = parseV4(addr);
  const r4 = parseV4(range);
  if (v4 !== null && r4 !== null) {
    const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
    if (bits === 0) return true;
    const mask = (0xffffffff << (32 - bits)) >>> 0;
    return ((v4 & mask) >>> 0) === ((r4 & mask) >>> 0);
  }
  const v6 = parseV6(addr);
  const r6 = parseV6(range);
  if (v6 === null || r6 === null) return false;
  const bits = bitsRaw === undefined ? 128 : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 128) return false;
  if (bits === 0) return true;
  const shift = BigInt(128 - bits);
  return v6 >> shift === r6 >> shift;
}

/** A CIDR the policy editor will accept. */
export function isValidCidr(cidr: string): boolean {
  const [range, bits] = cidr.trim().split('/');
  if (!range) return false;
  if (parseV4(range) !== null) return bits === undefined || (/^\d{1,2}$/.test(bits) && Number(bits) <= 32);
  if (parseV6(range) !== null) return bits === undefined || (/^\d{1,3}$/.test(bits) && Number(bits) <= 128);
  return false;
}

/** True when the list is empty (anywhere) or holds the address. */
export function ipAllowed(ip: string | undefined, cidrs: readonly string[]): boolean {
  if (cidrs.length === 0) return true;
  if (!ip) return false;
  return cidrs.some((c) => ipInCidr(ip, c));
}

/* ------------------------------------------------------- session life */

/** Why a session is over, or null while it lives. */
export function sessionExpiry(
  policy: SecurityPolicy,
  claims: { iat: number; lat?: number },
  nowSeconds: number = Math.floor(Date.now() / 1000),
): 'idle' | 'absolute' | null {
  if (policy.sessionAbsoluteHours && nowSeconds - claims.iat > policy.sessionAbsoluteHours * 3600) return 'absolute';
  const last = claims.lat ?? claims.iat;
  if (policy.sessionIdleMinutes && nowSeconds - last > policy.sessionIdleMinutes * 60) return 'idle';
  return null;
}

/* ---------------------------------------------------- IdP reachability */

const health = new Map<string, { at: number; reachable: boolean }>();
const HEALTH_MS = 60_000;

/** Reset between tests. */
export function resetIdpHealthCache(): void {
  health.clear();
}

/**
 * Can the identity provider be reached right now? A cached probe (one a
 * minute per issuer, three-second timeout). OIDC: the discovery document;
 * SAML: the single sign-on URL answers at all. Null when nothing to probe.
 */
export async function idpReachable(conn: { kind: string; issuerUrl: string } | null, now: number = Date.now()): Promise<boolean | null> {
  if (!conn) return null;
  const hit = health.get(conn.issuerUrl);
  if (hit && now - hit.at < HEALTH_MS) return hit.reachable;
  const url = conn.kind === 'SAML' ? conn.issuerUrl : `${conn.issuerUrl.replace(/\/$/, '')}/.well-known/openid-configuration`;
  let reachable: boolean;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const r = await fetch(url, { method: 'GET', signal: ctrl.signal, redirect: 'manual' });
    clearTimeout(t);
    reachable = r.status < 500;
  } catch {
    reachable = false;
  }
  health.set(conn.issuerUrl, { at: now, reachable });
  return reachable;
}
