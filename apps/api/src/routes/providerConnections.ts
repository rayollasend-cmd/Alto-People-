import { randomBytes } from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Prisma, ProviderConnection, ProviderKind } from '@prisma/client';
import { prisma } from '../db.js';
import { env } from '../config/env.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { enqueueAudit } from '../lib/audit.js';
import { encryptString } from '../lib/crypto.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { ORIGINATION_PROVIDERS, PROVIDERS, PROVIDER_KIND_LABEL, providerInfo, type ProviderKindName } from '../lib/providers/catalog.js';
import { originationProviderFor } from '../lib/banking/origination.js';
import { testEmbeddedConnection } from '../lib/embeddedPayroll/index.js';
import { testTaxEngine } from '../lib/taxEngine/external.js';
import { contextFor, encryptCredentials, recordFailure, recordOutboundEvent, recordSuccess } from '../lib/providers/connections.js';
import { everifyAdapter } from '../lib/providers/everify.js';
import { screeningAdapter } from '../lib/providers/screening.js';
import { drugTestAdapter } from '../lib/providers/drugTesting.js';
import { taxFilingAdapter } from '../lib/providers/taxFiling.js';
import { testWiseConnection } from '../lib/providers/payouts.js';
import { ProviderError } from '../lib/providers/http.js';

/**
 * Settings & trust → Integrations → Screening, filing and payouts.
 *
 *   GET    /provider-connections                 every connection with its health, per kind
 *   GET    /provider-connections/catalog         the providers, their fields and setup steps
 *   POST   /provider-connections                 connect (credentials encrypted; a webhook secret minted when the provider uses one)
 *   PATCH  /provider-connections/:id             rename, environment, pause/resume, credentials (blank keeps), settings
 *   POST   /provider-connections/:id/test        call the provider; records the result and health
 *   POST   /provider-connections/:id/rotate-secret   a new webhook secret, shown once
 *   DELETE /provider-connections/:id             disconnect (manual entry keeps working)
 *   GET    /provider-connections/:id/events      the connection's log
 *
 * Reading needs view:integrations; changing needs manage:integrations.
 */
export const providerConnectionsRouter = Router();

const canView = requireCapability('view:integrations');
const canManage = requireCapability('manage:integrations');

const KINDS = ['EVERIFY', 'BACKGROUND_CHECK', 'DRUG_TEST', 'TAX_FILING', 'PAYOUT', 'EMBEDDED_PAYROLL', 'TAX_ENGINE', 'ORIGINATION'] as const;
/** Providers whose webhooks are signed with a secret Alto mints and the admin pastes into the provider. */
const SHARED_SECRET = new Set(['EVERIFY_AGENT', 'GENERIC_SCREENING', 'ESCREEN', 'QUEST_ESP']);

export function webhookUrl(id: string): string {
  return `${env.APP_BASE_URL.replace(/\/+$/, '')}/api/webhooks/providers/${id}`;
}

type Health = 'not_tested' | 'healthy' | 'failing' | 'paused';

function healthOf(c: ProviderConnection): Health {
  if (!c.active) return 'paused';
  const ok = c.lastSuccessAt?.getTime() ?? 0;
  const bad = c.lastErrorAt?.getTime() ?? 0;
  if (bad > ok) return 'failing';
  if (ok > 0 || c.lastTestOk) return 'healthy';
  if (c.lastTestOk === false) return 'failing';
  return 'not_tested';
}

function view(c: ProviderConnection) {
  const info = providerInfo(c.provider);
  const ctx = contextFor(c);
  return {
    id: c.id,
    kind: c.kind,
    provider: c.provider,
    providerLabel: info?.label ?? c.provider,
    name: c.name,
    environment: c.environment,
    active: c.active,
    health: healthOf(c),
    lastSuccessAt: c.lastSuccessAt?.toISOString() ?? null,
    lastErrorAt: c.lastErrorAt?.toISOString() ?? null,
    lastError: c.lastError,
    lastTestAt: c.lastTestAt?.toISOString() ?? null,
    lastTestOk: c.lastTestOk,
    // Which credential fields are filled — never their values.
    credentialsSet: Object.fromEntries((info?.credentialFields ?? []).map((f) => [f.key, !!ctx.credentials[f.key]])),
    // Non-secret credential values (an address, a company id) are shown so the admin can check them.
    credentialValues: Object.fromEntries((info?.credentialFields ?? []).filter((f) => !f.secret).map((f) => [f.key, ctx.credentials[f.key] ?? ''])),
    settings: c.settings,
    webhookUrl: info?.webhook.supported ? webhookUrl(c.id) : null,
    webhookSecretSet: !!c.webhookSecretEnc,
    createdAt: c.createdAt.toISOString(),
  };
}

providerConnectionsRouter.get('/catalog', canView, (_req, res) => {
  res.json({ kinds: KINDS.map((k) => ({ kind: k, label: PROVIDER_KIND_LABEL[k] })), providers: [...PROVIDERS, ...ORIGINATION_PROVIDERS] });
});

providerConnectionsRouter.get('/', canView, async (_req, res) => {
  const rows = await prisma.providerConnection.findMany({ where: { tenantId: tenantIdForWrite() }, orderBy: [{ kind: 'asc' }, { createdAt: 'desc' }] });
  res.json({
    kinds: KINDS.map((k) => {
      const mine = rows.filter((r) => r.kind === k);
      const active = mine.find((r) => r.active) ?? null;
      return { kind: k, label: PROVIDER_KIND_LABEL[k], active: active ? view(active) : null, connections: mine.map(view) };
    }),
  });
});

const CreateBody = z.object({
  kind: z.enum(KINDS),
  provider: z.string().min(1).max(30),
  name: z.string().trim().min(1).max(120).optional(),
  environment: z.enum(['SANDBOX', 'PRODUCTION']).default('SANDBOX'),
  credentials: z.record(z.string(), z.string().max(4000)).default({}),
  settings: z.record(z.string(), z.unknown()).default({}),
});

function audit(req: Request, action: string, id: string, metadata: Record<string, unknown> = {}) {
  enqueueAudit({ actorUserId: req.user!.id, action, entityType: 'ProviderConnection', entityId: id, metadata: metadata as Prisma.InputJsonValue }, 'providerConnections');
}

providerConnectionsRouter.post('/', canManage, async (req, res) => {
  const body = CreateBody.parse(req.body ?? {});
  const info = providerInfo(body.provider);
  if (!info || info.kind !== body.kind) throw new HttpError(400, 'bad_provider', 'That provider does not do this.');
  const missing = info.credentialFields.filter((f) => !f.optional && !body.credentials[f.key]?.trim());
  if (missing.length) throw new HttpError(400, 'missing_credentials', `Enter ${missing.map((f) => f.label.toLowerCase()).join(', ')}.`);
  const secret = SHARED_SECRET.has(info.id) ? randomBytes(32).toString('hex') : null;
  const tenantId = tenantIdForWrite();
  const created = await prisma.$transaction(async (tx) => {
    // One active connection per kind: the new one takes over.
    await tx.providerConnection.updateMany({ where: { tenantId, kind: body.kind as ProviderKind, active: true }, data: { active: false } });
    return tx.providerConnection.create({
      data: {
        tenantId,
        kind: body.kind as ProviderKind,
        provider: info.id,
        name: body.name ?? info.label,
        environment: body.environment,
        credentialsEnc: encryptCredentials(Object.fromEntries(Object.entries(body.credentials).map(([k, v]) => [k, v.trim()]))),
        webhookSecretEnc: secret ? encryptString(secret) : null,
        settings: body.settings as Prisma.InputJsonValue,
        createdByUserId: req.user!.id,
      },
    });
  });
  audit(req, 'provider.connected', created.id, { kind: created.kind, provider: created.provider, environment: created.environment });
  // The secret is shown once, now; afterwards only "set".
  res.status(201).json({ connection: view(created), webhookSecret: secret });
});

async function load(id: string): Promise<ProviderConnection> {
  const row = await prisma.providerConnection.findFirst({ where: { id: z.string().uuid().parse(id), tenantId: tenantIdForWrite() } });
  if (!row) throw new HttpError(404, 'not_found', 'Connection not found.');
  return row;
}

const PatchBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  environment: z.enum(['SANDBOX', 'PRODUCTION']).optional(),
  active: z.boolean().optional(),
  credentials: z.record(z.string(), z.string().max(4000)).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});

providerConnectionsRouter.patch('/:id', canManage, async (req, res) => {
  const row = await load(String(req.params.id));
  const body = PatchBody.parse(req.body ?? {});
  const ctx = contextFor(row);
  let credentialsEnc: Buffer<ArrayBuffer> | undefined;
  if (body.credentials) {
    // A blank field keeps what is stored: secrets are never sent back to be re-typed.
    const merged = { ...ctx.credentials };
    for (const [k, v] of Object.entries(body.credentials)) if (v.trim()) merged[k] = v.trim();
    credentialsEnc = encryptCredentials(merged);
  }
  const updated = await prisma.$transaction(async (tx) => {
    if (body.active === true) {
      await tx.providerConnection.updateMany({ where: { tenantId: row.tenantId, kind: row.kind, active: true, id: { not: row.id } }, data: { active: false } });
    }
    return tx.providerConnection.update({
      where: { id: row.id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.environment !== undefined ? { environment: body.environment, lastTestOk: null, lastTestAt: null } : {}),
        ...(body.active !== undefined ? { active: body.active } : {}),
        ...(credentialsEnc ? { credentialsEnc, lastTestOk: null, lastTestAt: null } : {}),
        ...(body.settings !== undefined ? { settings: { ...ctx.settings, ...body.settings } as Prisma.InputJsonValue } : {}),
      },
    });
  });
  audit(req, 'provider.updated', row.id, { fields: Object.keys(body), environment: updated.environment, active: updated.active });
  res.json({ connection: view(updated) });
});

/** The provider-specific "can we talk" call. */
async function runTest(row: ProviderConnection): Promise<void> {
  const ctx = contextFor(row);
  switch (row.kind as ProviderKindName) {
    case 'EVERIFY':
      return everifyAdapter(row.provider).test(ctx);
    case 'BACKGROUND_CHECK':
      return screeningAdapter(row.provider).test(ctx);
    case 'DRUG_TEST':
      return drugTestAdapter(row.provider).test(ctx);
    case 'TAX_FILING':
      return taxFilingAdapter(row.provider).test(ctx);
    case 'PAYOUT':
      return testWiseConnection(ctx);
    case 'EMBEDDED_PAYROLL':
      return testEmbeddedConnection(ctx);
    case 'TAX_ENGINE':
      return testTaxEngine(ctx);
    case 'ORIGINATION':
      return originationProviderFor(ctx).test();
  }
}

providerConnectionsRouter.post('/:id/test', canManage, async (req, res) => {
  const row = await load(String(req.params.id));
  const ctx = contextFor(row);
  let ok = true;
  let message: string | null = null;
  try {
    await runTest(row);
  } catch (err) {
    ok = false;
    message = err instanceof ProviderError || err instanceof Error ? err.message : 'The test failed.';
  }
  const now = new Date();
  await prisma.providerConnection.update({ where: { id: row.id }, data: { lastTestAt: now, lastTestOk: ok } });
  if (ok) await recordSuccess(row.id);
  else await recordFailure(row.id, message ?? 'The test failed.');
  await recordOutboundEvent({ connection: ctx, kind: row.kind, eventType: 'connection.test', ok, error: message });
  audit(req, 'provider.tested', row.id, { ok });
  res.json({ ok, message, connection: view(await load(row.id)) });
});

providerConnectionsRouter.post('/:id/rotate-secret', canManage, async (req, res) => {
  const row = await load(String(req.params.id));
  if (!SHARED_SECRET.has(row.provider)) throw new HttpError(409, 'no_secret', 'This provider signs webhooks with its own key; there is no secret to rotate.');
  const secret = randomBytes(32).toString('hex');
  await prisma.providerConnection.update({ where: { id: row.id }, data: { webhookSecretEnc: encryptString(secret) } });
  audit(req, 'provider.secret_rotated', row.id);
  res.json({ webhookSecret: secret });
});

providerConnectionsRouter.delete('/:id', canManage, async (req, res) => {
  const row = await load(String(req.params.id));
  await prisma.providerConnection.delete({ where: { id: row.id } });
  audit(req, 'provider.disconnected', row.id, { kind: row.kind, provider: row.provider });
  res.status(204).end();
});

providerConnectionsRouter.get('/:id/events', canView, async (req, res) => {
  const row = await load(String(req.params.id));
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
  const events = await prisma.providerEvent.findMany({
    where: { connectionId: row.id },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: { id: true, direction: true, eventType: true, status: true, error: true, subjectType: true, subjectId: true, createdAt: true, processedAt: true },
  });
  res.json({ events: events.map((e) => ({ ...e, createdAt: e.createdAt.toISOString(), processedAt: e.processedAt?.toISOString() ?? null })) });
});
