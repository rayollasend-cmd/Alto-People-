import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import {
  IntegrationConnectionCreateSchema,
  IntegrationConnectionPatchSchema,
  IntegrationSyncRequestSchema,
  type IntegrationCapability,
  type IntegrationConnectionSummary,
  type IntegrationSyncRunSummary,
  type IntegrationVendor,
} from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { enqueueAudit } from '../lib/audit.js';
import { encryptString } from '../lib/crypto.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { VENDOR_CATALOG, adapterFor, vendorInfo } from '../lib/integrations/registry.js';
import { providerFailureText } from '../lib/providers/failureText.js';
import { SyncRefused, runSync } from '../lib/integrations/sync.js';

/**
 * Brief 3-5: the tenant admin's view of its HR and VMS connections.
 *
 *   GET    /integration-connections                the connections with their last run
 *   GET    /integration-connections/vendors        the catalog (capabilities, credential fields, default mapping)
 *   POST   /integration-connections                connect a vendor (credentials encrypted at rest)
 *   GET    /integration-connections/:id            one connection with its last twenty runs
 *   PATCH  /integration-connections/:id            name, pause/resume, sandbox, credentials, mapping, capabilities, schedule
 *   DELETE /integration-connections/:id            disconnect (runs and errors go with it)
 *   POST   /integration-connections/:id/test       run every capability in sandbox mode; the log shows what would happen
 *   POST   /integration-connections/:id/sync       run one capability now (live if the connection is live)
 *   GET    /integration-connections/:id/runs       the sync log
 *   GET    /integration-connections/runs/:runId/errors   the per-record errors of a run
 *
 * Reading needs view:integrations; changing or running needs manage:integrations.
 */
export const integrationConnectionsRouter = Router();

const canView = requireCapability('view:integrations');
const canManage = requireCapability('manage:integrations');

const runShape = (r: {
  id: string;
  capability: string;
  direction: string;
  status: string;
  trigger: string;
  eventType: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  total: number;
  succeeded: number;
  failed: number;
  summary: Prisma.JsonValue | null;
}): IntegrationSyncRunSummary => ({
  id: r.id,
  capability: r.capability as IntegrationCapability,
  direction: r.direction as 'PULL' | 'PUSH',
  status: r.status as IntegrationSyncRunSummary['status'],
  trigger: r.trigger,
  eventType: r.eventType,
  startedAt: r.startedAt.toISOString(),
  finishedAt: r.finishedAt?.toISOString() ?? null,
  total: r.total,
  succeeded: r.succeeded,
  failed: r.failed,
  summary: (r.summary as Record<string, unknown> | null) ?? null,
});

async function summarize(ids: string[]): Promise<IntegrationConnectionSummary[]> {
  const tenantId = tenantIdForWrite();
  const rows = await prisma.integrationConnection.findMany({
    where: { tenantId, ...(ids.length ? { id: { in: ids } } : {}) },
    orderBy: [{ vendor: 'asc' }, { createdAt: 'asc' }],
    include: { runs: { orderBy: { startedAt: 'desc' }, take: 10, select: { id: true, capability: true, direction: true, status: true, trigger: true, eventType: true, startedAt: true, finishedAt: true, total: true, succeeded: true, failed: true, summary: true } } },
  });
  return rows.map((c) => {
    const failure = providerFailureText(c.lastError, { label: VENDOR_CATALOG.find((v) => v.vendor === c.vendor)?.label ?? c.vendor });
    return {
      id: c.id,
      vendor: c.vendor as IntegrationVendor,
      name: c.name,
      status: c.status,
      sandbox: c.sandbox,
      hasCredentials: !!c.credentialsEnc,
      capabilities: c.capabilities as IntegrationCapability[],
      mapping: (c.mapping as IntegrationConnectionSummary['mapping']) ?? {},
      scheduleMinutes: c.scheduleMinutes,
      eventDriven: c.eventDriven,
      lastSyncAt: c.lastSyncAt?.toISOString() ?? null,
      nextSyncAt: c.nextSyncAt?.toISOString() ?? null,
      lastError: failure?.message ?? null,
      lastErrorDetail: failure?.detail ?? null,
      recentErrors: c.runs.reduce((a, r) => a + r.failed, 0),
      lastRun: c.runs[0] ? runShape(c.runs[0]) : null,
      createdAt: c.createdAt.toISOString(),
    };
  });
}

integrationConnectionsRouter.get('/vendors', canView, (_req, res) => {
  res.json({ vendors: VENDOR_CATALOG });
});

integrationConnectionsRouter.get('/', canView, async (_req, res) => {
  res.json({ connections: await summarize([]) });
});

integrationConnectionsRouter.post('/', canManage, async (req, res) => {
  const input = IntegrationConnectionCreateSchema.parse(req.body);
  const info = vendorInfo(input.vendor);
  const capabilities = (input.capabilities ?? info.capabilities).filter((c) => adapterFor(input.vendor).capabilities.has(c));
  const row = await prisma.integrationConnection.create({
    data: {
      tenantId: tenantIdForWrite(),
      vendor: input.vendor,
      name: input.name,
      sandbox: input.sandbox,
      credentialsEnc: input.credentials && Object.keys(input.credentials).length ? encryptString(JSON.stringify(input.credentials)) : null,
      mapping: (input.mapping ?? {}) as Prisma.InputJsonValue,
      capabilities,
      scheduleMinutes: input.scheduleMinutes ?? null,
      eventDriven: input.eventDriven ?? true,
      nextSyncAt: input.scheduleMinutes ? new Date() : null,
      createdByUserId: req.user!.id,
    },
  });
  enqueueAudit(
    { actorUserId: req.user!.id, clientId: null, tenantId: tenantIdForWrite(), action: 'integration.connected', entityType: 'IntegrationConnection', entityId: row.id, metadata: { vendor: row.vendor, sandbox: row.sandbox, capabilities } },
    'integrations',
  );
  const [summary] = await summarize([row.id]);
  res.status(201).json({ connection: summary });
});

integrationConnectionsRouter.get('/runs/:runId/errors', canView, async (req, res) => {
  const run = await prisma.integrationSyncRun.findFirst({ where: { id: req.params.runId, tenantId: tenantIdForWrite() }, select: { id: true } });
  if (!run) throw new HttpError(404, 'not_found', 'No such run.');
  const rows = await prisma.integrationSyncError.findMany({ where: { runId: run.id }, orderBy: { createdAt: 'asc' }, take: 500 });
  res.json({ errors: rows.map((e) => ({ id: e.id, recordRef: e.recordRef, message: e.message, excerpt: (e.excerpt as Record<string, unknown> | null) ?? null, createdAt: e.createdAt.toISOString() })) });
});

integrationConnectionsRouter.get('/:id', canView, async (req, res) => {
  const [summary] = await summarize([req.params.id]);
  if (!summary) throw new HttpError(404, 'not_found', 'No such connection.');
  const runs = await prisma.integrationSyncRun.findMany({ where: { connectionId: summary.id }, orderBy: { startedAt: 'desc' }, take: 20 });
  res.json({ connection: summary, vendor: vendorInfo(summary.vendor), runs: runs.map(runShape) });
});

integrationConnectionsRouter.get('/:id/runs', canView, async (req, res) => {
  const c = await prisma.integrationConnection.findFirst({ where: { id: req.params.id, tenantId: tenantIdForWrite() }, select: { id: true } });
  if (!c) throw new HttpError(404, 'not_found', 'No such connection.');
  const runs = await prisma.integrationSyncRun.findMany({ where: { connectionId: c.id }, orderBy: { startedAt: 'desc' }, take: 100 });
  res.json({ runs: runs.map(runShape) });
});

integrationConnectionsRouter.patch('/:id', canManage, async (req, res) => {
  const input = IntegrationConnectionPatchSchema.parse(req.body);
  const tenantId = tenantIdForWrite();
  const existing = await prisma.integrationConnection.findFirst({ where: { id: req.params.id, tenantId } });
  if (!existing) throw new HttpError(404, 'not_found', 'No such connection.');
  const vendor = existing.vendor as IntegrationVendor;
  const capabilities = input.capabilities ? input.capabilities.filter((c) => adapterFor(vendor).capabilities.has(c)) : undefined;
  const row = await prisma.integrationConnection.update({
    where: { id: existing.id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.status !== undefined ? { status: input.status, lastError: input.status === 'CONNECTED' ? null : existing.lastError } : {}),
      ...(input.sandbox !== undefined ? { sandbox: input.sandbox } : {}),
      ...(input.credentials !== undefined ? { credentialsEnc: Object.keys(input.credentials).length ? encryptString(JSON.stringify(input.credentials)) : null } : {}),
      ...(input.mapping !== undefined ? { mapping: input.mapping as Prisma.InputJsonValue } : {}),
      ...(capabilities !== undefined ? { capabilities } : {}),
      ...(input.scheduleMinutes !== undefined ? { scheduleMinutes: input.scheduleMinutes, nextSyncAt: input.scheduleMinutes ? new Date() : null } : {}),
      ...(input.eventDriven !== undefined ? { eventDriven: input.eventDriven } : {}),
    },
  });
  enqueueAudit(
    { actorUserId: req.user!.id, clientId: null, tenantId, action: 'integration.updated', entityType: 'IntegrationConnection', entityId: row.id, metadata: { fields: Object.keys(input).filter((k) => k !== 'credentials'), credentialsReplaced: input.credentials !== undefined } },
    'integrations',
  );
  const [summary] = await summarize([row.id]);
  res.json({ connection: summary });
});

integrationConnectionsRouter.delete('/:id', canManage, async (req, res) => {
  const tenantId = tenantIdForWrite();
  const existing = await prisma.integrationConnection.findFirst({ where: { id: req.params.id, tenantId }, select: { id: true, vendor: true } });
  if (!existing) throw new HttpError(404, 'not_found', 'No such connection.');
  await prisma.integrationConnection.delete({ where: { id: existing.id } });
  enqueueAudit({ actorUserId: req.user!.id, clientId: null, tenantId, action: 'integration.disconnected', entityType: 'IntegrationConnection', entityId: existing.id, metadata: { vendor: existing.vendor } }, 'integrations');
  res.status(204).end();
});

integrationConnectionsRouter.post('/:id/test', canManage, async (req, res) => {
  const tenantId = tenantIdForWrite();
  const existing = await prisma.integrationConnection.findFirst({ where: { id: req.params.id, tenantId }, select: { id: true, vendor: true } });
  if (!existing) throw new HttpError(404, 'not_found', 'No such connection.');
  const caps = [...adapterFor(existing.vendor as IntegrationVendor).capabilities];
  const results = [];
  for (const capability of caps) {
    try {
      results.push({ capability, ...(await runSync({ connectionId: existing.id, capability, trigger: 'sandbox-test', forceSandbox: true })) });
    } catch (err) {
      results.push({ capability, runId: null, status: 'FAILED' as const, total: 0, succeeded: 0, failed: 1, summary: { error: err instanceof Error ? err.message : 'refused' } });
    }
  }
  enqueueAudit({ actorUserId: req.user!.id, clientId: null, tenantId, action: 'integration.sandbox_test', entityType: 'IntegrationConnection', entityId: existing.id, metadata: { results: results.map((r) => ({ capability: r.capability, status: r.status, total: r.total, failed: r.failed })) } }, 'integrations');
  res.json({ results });
});

integrationConnectionsRouter.post('/:id/sync', canManage, async (req, res) => {
  const input = IntegrationSyncRequestSchema.parse(req.body);
  const tenantId = tenantIdForWrite();
  try {
    const result = await runSync({ connectionId: req.params.id, capability: input.capability, trigger: 'manual', periodStart: input.periodStart, periodEnd: input.periodEnd, payrollRunId: input.payrollRunId });
    enqueueAudit({ actorUserId: req.user!.id, clientId: null, tenantId, action: 'integration.sync_run', entityType: 'IntegrationSyncRun', entityId: result.runId, metadata: { capability: input.capability, status: result.status, total: result.total, failed: result.failed } }, 'integrations');
    res.json({ run: result });
  } catch (err) {
    if (err instanceof SyncRefused) {
      const status = err.code === 'not_found' ? 404 : err.code === 'nothing_to_send' ? 409 : 422;
      throw new HttpError(status, err.code, err.message);
    }
    throw err;
  }
});
