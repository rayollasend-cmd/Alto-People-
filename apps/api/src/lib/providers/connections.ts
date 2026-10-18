import { Prisma, type ProviderConnection, type ProviderKind } from '@prisma/client';
import { prisma } from '../../db.js';
import { decryptString, encryptString } from '../crypto.js';
import { tenantIdForWrite } from '../tenant.js';
import { providerInfo, type ProviderId } from './catalog.js';

/**
 * A tenant's provider connection, decrypted for one call: the base URL for
 * its environment, the credentials, the non-secret settings and the
 * webhook secret. Health (last success / last error) is recorded on every
 * call so the Integrations page can say what broke and when.
 */

export interface ProviderContext {
  connectionId: string;
  tenantId: string | null;
  provider: ProviderId;
  environment: 'SANDBOX' | 'PRODUCTION';
  baseUrl: string;
  credentials: Record<string, string>;
  settings: Record<string, unknown>;
  webhookSecret: string | null;
}

export function contextFor(row: ProviderConnection): ProviderContext {
  const info = providerInfo(row.provider);
  const env = row.environment === 'PRODUCTION' ? 'PRODUCTION' : 'SANDBOX';
  let credentials: Record<string, string> = {};
  if (row.credentialsEnc) {
    try {
      credentials = JSON.parse(decryptString(row.credentialsEnc)) as Record<string, string>;
    } catch {
      credentials = {};
    }
  }
  let webhookSecret: string | null = null;
  if (row.webhookSecretEnc) {
    try {
      webhookSecret = decryptString(row.webhookSecretEnc);
    } catch {
      webhookSecret = null;
    }
  }
  // A provider whose address the customer supplies (agents, partners) carries it in the credentials.
  const baseUrl = (credentials.baseUrl || info?.baseUrls[env] || '').replace(/\/+$/, '');
  return {
    connectionId: row.id,
    tenantId: row.tenantId,
    provider: row.provider as ProviderId,
    environment: env,
    baseUrl,
    credentials,
    settings: (row.settings as Record<string, unknown> | null) ?? {},
    webhookSecret,
  };
}

/** The tenant's active connection of a kind (the newest when there are several), or null. */
export async function activeConnection(kind: ProviderKind): Promise<ProviderConnection | null> {
  return prisma.providerConnection.findFirst({
    where: { tenantId: tenantIdForWrite(), kind, active: true },
    orderBy: { createdAt: 'desc' },
  });
}

export function encryptCredentials(c: Record<string, string>): Buffer<ArrayBuffer> {
  return encryptString(JSON.stringify(c));
}

export async function recordSuccess(connectionId: string): Promise<void> {
  await prisma.providerConnection.update({ where: { id: connectionId }, data: { lastSuccessAt: new Date() } }).catch(() => undefined);
}

export async function recordFailure(connectionId: string, message: string): Promise<void> {
  await prisma.providerConnection
    .update({ where: { id: connectionId }, data: { lastErrorAt: new Date(), lastError: message.slice(0, 500) } })
    .catch(() => undefined);
}

/** Keys never stored in an event payload, at any depth. */
const REDACT = /ssn|social|dob|birth|password|secret|token|apikey|api_key|account_?number|routing|abartn|alien|passport|license_number|signature/i;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[…]';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 500) return `${value.slice(0, 500)}…`;
  return value;
}

/**
 * Record an inbound event once. Returns null when the provider re-delivered
 * an event already recorded (the unique (connection, externalId) pair), so
 * the caller can answer 200 without applying it twice.
 */
export async function recordInboundEvent(input: {
  connection: ProviderContext;
  kind: ProviderKind;
  eventType: string;
  externalId: string;
  payload: unknown;
}): Promise<{ id: string } | null> {
  try {
    return await prisma.providerEvent.create({
      data: {
        tenantId: input.connection.tenantId,
        connectionId: input.connection.connectionId,
        kind: input.kind,
        direction: 'IN',
        eventType: input.eventType.slice(0, 80),
        externalId: input.externalId.slice(0, 160),
        payload: redact(input.payload) as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return null;
    throw err;
  }
}

export async function finishEvent(
  id: string,
  outcome: { status: 'PROCESSED' | 'IGNORED' | 'FAILED'; subjectType?: string; subjectId?: string | null; error?: string | null },
): Promise<void> {
  await prisma.providerEvent.update({
    where: { id },
    data: {
      status: outcome.status,
      subjectType: outcome.subjectType ?? null,
      subjectId: outcome.subjectId ?? null,
      error: outcome.error ? outcome.error.slice(0, 500) : null,
      processedAt: new Date(),
    },
  });
}

/** An outbound call worth keeping in the connection's log (orders, filings, tests). */
export async function recordOutboundEvent(input: {
  connection: ProviderContext;
  kind: ProviderKind;
  eventType: string;
  subjectType?: string;
  subjectId?: string | null;
  ok: boolean;
  error?: string | null;
  payload?: unknown;
}): Promise<void> {
  await prisma.providerEvent
    .create({
      data: {
        tenantId: input.connection.tenantId,
        connectionId: input.connection.connectionId,
        kind: input.kind,
        direction: 'OUT',
        eventType: input.eventType.slice(0, 80),
        externalId: `out:${input.eventType}:${input.subjectId ?? 'none'}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
        subjectType: input.subjectType ?? null,
        subjectId: input.subjectId ?? null,
        status: input.ok ? 'PROCESSED' : 'FAILED',
        error: input.error ? input.error.slice(0, 500) : null,
        payload: input.payload === undefined ? Prisma.JsonNull : (redact(input.payload) as Prisma.InputJsonValue),
        processedAt: new Date(),
      },
    })
    .catch(() => undefined);
}
