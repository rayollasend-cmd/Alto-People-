import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Prisma, PrismaClient, QboCompanyConnection } from '@prisma/client';
import { env } from '../../../config/env.js';
import { encryptString, tryDecryptString } from '../../crypto.js';
import { HttpError } from '../../../middleware/error.js';
import { tenantIdForWrite } from '../../tenant.js';
import { HttpQboClient } from './http.js';
import { FakeQboClient, stubCompany } from './fake.js';
import type { QboClient } from './types.js';

/**
 * The company's own QuickBooks connection (one per tenant) — separate from
 * the per-client payroll connection in lib/quickbooks.ts. OAuth with a
 * signed state that names the tenant and the person, tokens encrypted under
 * the keyring, refreshed a minute before they expire. Without Intuit keys
 * (stub mode) the flow loops straight back with a fake company, so the sync
 * runs end to end in development.
 */

type Db = PrismaClient | Prisma.TransactionClient;

const AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const SCOPES = 'com.intuit.quickbooks.accounting';

export function isStubMode(): boolean {
  return !env.INTUIT_CLIENT_ID || !env.INTUIT_CLIENT_SECRET;
}

/**
 * The return address Intuit must have on file — the SAME one the per-client
 * payroll connection registered (lib/quickbooks.ts), so connecting the
 * company needs no change in the Intuit developer portal. That callback
 * sees a "company." state and hands the browser on to
 * /api/books/quickbooks/callback (app.ts).
 */
export function redirectUri(): string {
  return `${env.APP_BASE_URL}/api/quickbooks/connect/callback`;
}

function sign(tenantId: string, userId: string, nonce: string): string {
  return createHmac('sha256', env.JWT_SECRET).update(`company:${tenantId}:${userId}:${nonce}`).digest('hex');
}

/** Where to send the person to approve the connection (or, in stub mode, straight back). */
export function authorizeUrl(tenantId: string, userId: string): string {
  const nonce = randomBytes(16).toString('hex');
  const state = `company.${tenantId}.${userId}.${nonce}.${sign(tenantId, userId, nonce)}`;
  if (isStubMode()) {
    const sp = new URLSearchParams({ code: 'STUB-CODE', state, realmId: `STUB-COMPANY-${tenantId.slice(0, 8)}` });
    return `${env.APP_BASE_URL}/api/books/quickbooks/callback?${sp.toString()}`;
  }
  const sp = new URLSearchParams({ client_id: env.INTUIT_CLIENT_ID!, response_type: 'code', scope: SCOPES, redirect_uri: redirectUri(), state });
  return `${AUTH_URL}?${sp.toString()}`;
}

/** The tenant and person a state was signed for, or null when it was tampered with. */
export function verifyCompanyState(state: string): { tenantId: string; userId: string } | null {
  const parts = state.split('.');
  if (parts.length !== 5 || parts[0] !== 'company') return null;
  const [, tenantId, userId, nonce, sig] = parts as [string, string, string, string, string];
  const a = Buffer.from(sign(tenantId, userId, nonce), 'utf8');
  const b = Buffer.from(sig, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return { tenantId, userId };
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

async function tokenCall(body: Record<string, string>): Promise<TokenResponse> {
  const basic = Buffer.from(`${env.INTUIT_CLIENT_ID}:${env.INTUIT_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) throw new HttpError(res.status === 400 || res.status === 401 ? 409 : 502, 'quickbooks_token', `QuickBooks refused the sign-in (${res.status}).`);
  return (await res.json()) as TokenResponse;
}

export async function exchangeCompanyCode(code: string): Promise<TokenResponse> {
  if (isStubMode()) return { access_token: 'STUB-COMPANY-ACCESS', refresh_token: 'STUB-COMPANY-REFRESH', expires_in: 3600 };
  return tokenCall({ grant_type: 'authorization_code', code, redirect_uri: redirectUri() });
}

/** Save (or replace) the tenant's connection with a fresh token pair. */
export async function saveCompanyConnection(db: Db, input: { realmId: string; tokens: TokenResponse; userId: string | null; companyName?: string | null }): Promise<QboCompanyConnection> {
  const tenantId = tenantIdForWrite();
  const data = {
    realmId: input.realmId,
    accessTokenEnc: encryptString(input.tokens.access_token),
    refreshTokenEnc: encryptString(input.tokens.refresh_token),
    expiresAt: new Date(Date.now() + input.tokens.expires_in * 1000),
    lastRefreshedAt: new Date(),
    status: 'CONNECTED',
    lastError: null,
    ...(input.companyName ? { companyName: input.companyName } : {}),
  };
  const existing = await db.qboCompanyConnection.findFirst({ where: { tenantId } });
  if (existing) {
    // A different company: what was linked to the old one no longer means anything.
    if (existing.realmId !== input.realmId) {
      await db.qboSyncLink.deleteMany({ where: { tenantId } });
      await db.qboOutbox.deleteMany({ where: { tenantId } });
      await db.qboSyncConflict.deleteMany({ where: { tenantId } });
      return db.qboCompanyConnection.update({ where: { id: existing.id }, data: { ...data, pulledThrough: new Date(), connectedById: input.userId } });
    }
    return db.qboCompanyConnection.update({ where: { id: existing.id }, data });
  }
  return db.qboCompanyConnection.create({ data: { tenantId, ...data, pulledThrough: new Date(), connectedById: input.userId } });
}

export async function companyConnection(db: Db): Promise<QboCompanyConnection | null> {
  return db.qboCompanyConnection.findFirst({ where: { tenantId: tenantIdForWrite() } });
}

/** A usable access token, refreshed when it's within a minute of expiring. A refused refresh marks the connection NEEDS_RECONNECT. */
async function accessToken(db: Db, connId: string): Promise<string> {
  const conn = await db.qboCompanyConnection.findFirst({ where: { id: connId } });
  if (!conn) throw new HttpError(404, 'quickbooks_not_connected', 'QuickBooks isn’t connected.');
  const access = tryDecryptString(conn.accessTokenEnc);
  if (access && conn.expiresAt.getTime() > Date.now() + 60_000) return access;
  const refresh = tryDecryptString(conn.refreshTokenEnc);
  if (!refresh) {
    await db.qboCompanyConnection.update({ where: { id: conn.id }, data: { status: 'NEEDS_RECONNECT', lastError: 'The saved sign-in can no longer be read. Reconnect QuickBooks.' } });
    throw new HttpError(409, 'quickbooks_reconnect_required', 'QuickBooks needs to be reconnected.');
  }
  let tokens: TokenResponse;
  try {
    tokens = isStubMode() ? { access_token: 'STUB-COMPANY-ACCESS', refresh_token: refresh, expires_in: 3600 } : await tokenCall({ grant_type: 'refresh_token', refresh_token: refresh });
  } catch (err) {
    if (err instanceof HttpError && err.status === 409) {
      await db.qboCompanyConnection.update({ where: { id: conn.id }, data: { status: 'NEEDS_RECONNECT', lastError: 'QuickBooks refused to renew the sign-in (it expires after 100 days unused, or was revoked). Reconnect QuickBooks.' } });
      throw new HttpError(409, 'quickbooks_reconnect_required', 'QuickBooks needs to be reconnected.');
    }
    throw err;
  }
  await db.qboCompanyConnection.update({
    where: { id: conn.id },
    data: { accessTokenEnc: encryptString(tokens.access_token), refreshTokenEnc: encryptString(tokens.refresh_token), expiresAt: new Date(Date.now() + tokens.expires_in * 1000), lastRefreshedAt: new Date() },
  });
  return tokens.access_token;
}

/* ---- The client --------------------------------------------------------- */

type Factory = (conn: QboCompanyConnection) => QboClient;
let override: Factory | null = null;

/** Tests hand in their own QuickBooks (a FakeQboClient). null restores the default. */
export function setQboClientFactory(f: Factory | null): void {
  override = f;
}

export function qboClientFor(db: PrismaClient, conn: QboCompanyConnection): QboClient {
  if (override) return override(conn);
  if (isStubMode()) return stubCompany(conn.realmId);
  return new HttpQboClient(conn.realmId, () => accessToken(db, conn.id));
}

export { FakeQboClient };

/* ---- Settings (kept as Setting rows in QboSyncLink) --------------------- */

/** Which QuickBooks dimension each site dimension fills. */
export interface QboSyncSettings {
  /** QuickBooks Class: the client (default), the department, or nothing. */
  classMode: 'CLIENT' | 'DEPARTMENT' | 'NONE';
  /** QuickBooks Location (Department): the site (default), or nothing. */
  locationMode: 'SITE' | 'NONE';
}

export const DEFAULT_SETTINGS: QboSyncSettings = { classMode: 'CLIENT', locationMode: 'SITE' };

export async function readSettings(db: Db): Promise<QboSyncSettings> {
  const tenantId = tenantIdForWrite();
  const conn = await db.qboCompanyConnection.findFirst({ where: { tenantId }, select: { settings: true } });
  const saved = (conn?.settings ?? {}) as Partial<Record<keyof QboSyncSettings, string>>;
  const out = { ...DEFAULT_SETTINGS };
  if (saved.classMode === 'CLIENT' || saved.classMode === 'DEPARTMENT' || saved.classMode === 'NONE') out.classMode = saved.classMode;
  if (saved.locationMode === 'SITE' || saved.locationMode === 'NONE') out.locationMode = saved.locationMode;
  return out;
}

export async function writeSettings(db: Db, next: Partial<QboSyncSettings>): Promise<QboSyncSettings> {
  const tenantId = tenantIdForWrite();
  const conn = await db.qboCompanyConnection.findFirst({ where: { tenantId }, select: { id: true } });
  if (!conn) throw new HttpError(409, 'not_connected', 'Connect QuickBooks first.');
  const merged = { ...(await readSettings(db)), ...Object.fromEntries(Object.entries(next).filter(([, v]) => !!v)) };
  await db.qboCompanyConnection.update({ where: { id: conn.id }, data: { settings: merged } });
  return readSettings(db);
}

/* ---- The history ------------------------------------------------------- */

export async function logEvent(
  db: Db,
  e: { direction: 'PUSH' | 'PULL'; result: 'OK' | 'ERROR' | 'CONFLICT' | 'SKIPPED'; localType?: string | null; localId?: string | null; qboType?: string | null; qboId?: string | null; message?: string | null },
): Promise<void> {
  await db.qboSyncEvent.create({
    data: {
      tenantId: tenantIdForWrite(),
      direction: e.direction,
      result: e.result,
      localType: e.localType ?? null,
      localId: e.localId ?? null,
      qboType: e.qboType ?? null,
      qboId: e.qboId ?? null,
      message: e.message?.slice(0, 1000) ?? null,
    },
  });
}
