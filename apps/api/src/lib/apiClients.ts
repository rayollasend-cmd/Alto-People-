import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { PrismaClient } from '@prisma/client';
import { API_SCOPES, type ApiClientInput, type ApiClientIssued, type ApiClientSummary, type ApiScope } from '@alto-people/shared';
import { prisma as defaultPrisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { enqueueAudit } from './audit.js';
import { jobSecret } from './jobSecrets.js';
import { ALTO_TENANT_ID } from './tenant.js';
import { DUMMY_HASH, hashPassword, verifyPassword } from './passwords.js';

/**
 * Brief 2-4 step 1 — OAuth 2 client credentials for the public /v1 API.
 *
 *   A client belongs to one tenant, carries named scopes and a named,
 *   accountable owner. Its secret is shown once and stored hashed; a
 *   rotation keeps the previous secret valid for five minutes, as agent
 *   credentials do. POST /v1/oauth/token trades the pair for a 15-minute
 *   JWT (sub = client, tid = tenant, scope); requireApiToken re-reads the
 *   client on every request, so a revoked client stops within one request,
 *   not one token lifetime. The signing key is the apiToken job's own
 *   secret (lib/jobSecrets), never the session's.
 */

type Db = PrismaClient;

export const CLIENT_ID_PREFIX = 'altc_';
export const CLIENT_SECRET_PREFIX = 'altcs_';
export const TOKEN_TTL_SECONDS = 15 * 60;
const ROTATION_OVERLAP_MS = 5 * 60_000;
const ISSUER = 'alto-people';
const AUDIENCE = 'alto-v1';

const signingKey = () => createHmac('sha256', jobSecret('apiToken')).update('alto-api-token-v1').digest();

const newClientId = () => `${CLIENT_ID_PREFIX}${randomBytes(12).toString('hex')}`;
const newSecret = () => `${CLIENT_SECRET_PREFIX}${randomBytes(32).toString('hex')}`;

type ClientRow = Awaited<ReturnType<typeof loadRow>>;
async function loadRow(db: Db, id: string, tenantId: string) {
  return db.apiClient.findFirst({ where: { id, tenantId }, include: { owner: { select: { id: true, email: true, associate: { select: { firstName: true, lastName: true } } } } } });
}

export function toSummary(r: NonNullable<ClientRow>): ApiClientSummary {
  const name = r.owner.associate ? `${r.owner.associate.firstName} ${r.owner.associate.lastName}` : r.owner.email;
  return {
    id: r.id,
    clientId: r.clientId,
    name: r.name,
    scopes: r.scopes.filter((s): s is ApiScope => (API_SCOPES as readonly string[]).includes(s)),
    owner: { id: r.owner.id, name },
    status: r.status === 'REVOKED' ? 'REVOKED' : 'ACTIVE',
    lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
    expiresAt: r.expiresAt?.toISOString() ?? null,
    revokedAt: r.revokedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

export async function listApiClients(db: Db, tenantId: string): Promise<ApiClientSummary[]> {
  const rows = await db.apiClient.findMany({
    where: { tenantId },
    orderBy: { createdAt: 'desc' },
    include: { owner: { select: { id: true, email: true, associate: { select: { firstName: true, lastName: true } } } } },
  });
  return rows.map(toSummary);
}

/** A new client; the secret is returned this once. The owner must be an active account of the tenant. */
export async function createApiClient(db: Db, tenantId: string, input: ApiClientInput, actorUserId: string): Promise<ApiClientIssued> {
  const owner = await db.user.findFirst({ where: { id: input.ownerUserId, tenantId, status: 'ACTIVE', deletedAt: null }, select: { id: true } });
  if (!owner) throw new HttpError(400, 'owner_not_found', 'The owner must be an active account in this organization.');
  const secret = newSecret();
  const row = await db.apiClient.create({
    data: {
      tenantId,
      clientId: newClientId(),
      secretHash: await hashPassword(secret),
      name: input.name,
      scopes: [...new Set(input.scopes)],
      ownerUserId: owner.id,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      createdById: actorUserId,
    },
    select: { id: true },
  });
  enqueueAudit({ actorUserId, clientId: null, apiClientId: row.id, action: 'api_client.created', entityType: 'ApiClient', entityId: row.id, metadata: { name: input.name, scopes: input.scopes, ownerUserId: owner.id } }, 'apiClients');
  return { client: toSummary((await loadRow(db, row.id, tenantId))!), clientSecret: secret };
}

/** A new secret; the old one keeps working for five minutes so a deploy can switch over. */
export async function rotateApiClient(db: Db, tenantId: string, id: string, actorUserId: string, now: Date = new Date()): Promise<ApiClientIssued> {
  const row = await db.apiClient.findFirst({ where: { id, tenantId, status: 'ACTIVE' }, select: { id: true, secretHash: true } });
  if (!row) throw new HttpError(404, 'api_client_not_found', 'No such active client.');
  const secret = newSecret();
  await db.apiClient.update({
    where: { id },
    data: { secretHash: await hashPassword(secret), previousSecretHash: row.secretHash, previousValidUntil: new Date(now.getTime() + ROTATION_OVERLAP_MS) },
  });
  enqueueAudit({ actorUserId, clientId: null, apiClientId: id, action: 'api_client.rotated', entityType: 'ApiClient', entityId: id, metadata: { previousValidUntil: new Date(now.getTime() + ROTATION_OVERLAP_MS).toISOString() } }, 'apiClients');
  return { client: toSummary((await loadRow(db, id, tenantId))!), clientSecret: secret };
}

/** Revoked at once: the next request with a token it already holds is refused. */
export async function revokeApiClient(db: Db, tenantId: string, id: string, actorUserId: string, now: Date = new Date()): Promise<ApiClientSummary> {
  const r = await db.apiClient.updateMany({ where: { id, tenantId, status: 'ACTIVE' }, data: { status: 'REVOKED', revokedAt: now } });
  if (!r.count) throw new HttpError(404, 'api_client_not_found', 'No such active client.');
  enqueueAudit({ actorUserId, clientId: null, apiClientId: id, action: 'api_client.revoked', entityType: 'ApiClient', entityId: id, metadata: {} }, 'apiClients');
  return toSummary((await loadRow(db, id, tenantId))!);
}

export interface TokenClaims {
  sub: string;
  cid: string;
  tid: string;
  scope: string;
}

/**
 * client_credentials: the client id and secret for a 15-minute token. The
 * same answer for an unknown id, a wrong secret and a revoked or expired
 * client (no oracle); a hash is always verified so timing says nothing.
 */
export async function issueToken(db: Db, clientId: string, secret: string, now: Date = new Date()): Promise<{ access_token: string; token_type: 'Bearer'; expires_in: number; scope: string } | null> {
  const row = await db.apiClient.findUnique({ where: { clientId } });
  const usable = !!row && row.status === 'ACTIVE' && (!row.expiresAt || row.expiresAt > now);
  let ok = await verifyPassword(row?.secretHash ?? DUMMY_HASH, secret);
  if (!ok && row?.previousSecretHash && row.previousValidUntil && row.previousValidUntil > now) ok = await verifyPassword(row.previousSecretHash, secret);
  if (!usable || !ok || !row) return null;
  const scope = row.scopes.join(' ');
  const access_token = jwt.sign({ cid: row.clientId, tid: row.tenantId ?? ALTO_TENANT_ID, scope } satisfies Omit<TokenClaims, 'sub'>, signingKey(), {
    algorithm: 'HS256',
    subject: row.id,
    issuer: ISSUER,
    audience: AUDIENCE,
    expiresIn: TOKEN_TTL_SECONDS,
    jwtid: randomUUID(),
  });
  enqueueAudit({ actorUserId: null, clientId: null, tenantId: row.tenantId, apiClientId: row.id, action: 'api_client.token_issued', entityType: 'ApiClient', entityId: row.id, metadata: { scope } }, 'apiClients');
  return { access_token, token_type: 'Bearer', expires_in: TOKEN_TTL_SECONDS, scope };
}

/** The token's claims when its signature, issuer, audience and expiry hold; null otherwise. */
export function verifyToken(token: string): TokenClaims | null {
  try {
    const claims = jwt.verify(token, signingKey(), { algorithms: ['HS256'], issuer: ISSUER, audience: AUDIENCE }) as jwt.JwtPayload;
    if (typeof claims.sub !== 'string' || typeof claims.tid !== 'string' || typeof claims.scope !== 'string' || typeof claims.cid !== 'string') return null;
    return { sub: claims.sub, cid: claims.cid, tid: claims.tid, scope: claims.scope };
  } catch {
    return null;
  }
}

export const defaultDb = defaultPrisma;
