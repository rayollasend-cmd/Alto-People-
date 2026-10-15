import { Router } from 'express';
import { z } from 'zod';
import type { AuditSearchEntry, AuditSearchResponse } from '@alto-people/shared';
import { csvCell as sharedCsvCell } from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import type { Prisma } from '@prisma/client';
import { requireCapability } from '../middleware/auth.js';
import { recordCriticalAudit } from '../lib/audit.js';
import { MIN_RETENTION_YEARS, retentionYearsFor, verifyAuditChain } from '../lib/auditChain.js';
import { createAuditSink } from '../lib/auditSink.js';

export const auditRouter = Router();

const PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;
const CSV_MAX_ROWS = 50_000;

const FilterSchema = z.object({
  action: z.string().trim().min(1).max(80).optional(),
  entityType: z.string().trim().min(1).max(80).optional(),
  entityId: z.string().trim().min(1).max(80).optional(),
  actorUserId: z.string().uuid().optional(),
  clientId: z.string().uuid().optional(),
  /** ISO datetime — inclusive lower bound. */
  since: z.string().datetime().optional(),
  /** ISO datetime — exclusive upper bound. Drives cursor pagination. */
  before: z.string().datetime().optional(),
  /** Free-text fragment — `action` LIKE %q%. Case-insensitive. */
  q: z.string().trim().min(1).max(80).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
});

type Filters = z.infer<typeof FilterSchema>;

function buildWhere(f: Filters) {
  // Brief 2-3 step 1: the viewer and the CSV read only the caller's tenant (explicit while TENANCY_MODE observes).
  const where: Record<string, unknown> = { tenantId: tenantIdForWrite() };
  if (f.action) where.action = f.action;
  if (f.entityType) where.entityType = f.entityType;
  if (f.entityId) where.entityId = f.entityId;
  if (f.actorUserId) where.actorUserId = f.actorUserId;
  if (f.clientId) where.clientId = f.clientId;
  if (f.q) where.action = { contains: f.q, mode: 'insensitive' };
  const createdAt: Record<string, Date> = {};
  if (f.since) createdAt.gte = new Date(f.since);
  if (f.before) createdAt.lt = new Date(f.before);
  if (Object.keys(createdAt).length > 0) where.createdAt = createdAt;
  return where;
}

function parseFilters(req: import('express').Request): Filters {
  const parsed = FilterSchema.safeParse(req.query);
  if (!parsed.success) {
    throw new HttpError(400, 'invalid_query', 'Invalid filters', parsed.error.flatten());
  }
  return parsed.data;
}

/**
 * GET /audit/logs
 * Cursor-paginated by createdAt DESC. Pass the prior page's `nextBefore`
 * back as `?before=…` to walk through older rows. Default page size 100.
 */
auditRouter.get('/logs', async (req, res, next) => {
  try {
    const f = parseFilters(req);
    const take = f.limit ?? PAGE_SIZE;

    const rows = await prisma.auditLog.findMany({
      where: buildWhere(f),
      orderBy: { createdAt: 'desc' },
      take,
      include: { actorUser: { select: { email: true } } },
    });

    const entries: AuditSearchEntry[] = rows.map((r) => ({
      id: r.id,
      action: r.action,
      actorUserId: r.actorUserId,
      actorEmail: r.actorUser?.email ?? null,
      entityType: r.entityType,
      entityId: r.entityId,
      clientId: r.clientId,
      metadata: (r.metadata as Record<string, unknown> | null) ?? null,
      createdAt: r.createdAt.toISOString(),
    }));

    const nextBefore =
      rows.length === take ? rows[rows.length - 1]!.createdAt.toISOString() : null;

    const body: AuditSearchResponse = { entries, nextBefore };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /audit/logs.csv
 * Same filters, no pagination — streams up to CSV_MAX_ROWS to keep the
 * response bounded. Sorted DESC by createdAt to match the table view.
 */
auditRouter.get('/logs.csv', async (req, res, next) => {
  try {
    const f = parseFilters(req);
    const rows = await prisma.auditLog.findMany({
      where: buildWhere(f),
      orderBy: { createdAt: 'desc' },
      take: CSV_MAX_ROWS,
      include: { actorUser: { select: { email: true } } },
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="alto-audit-${new Date().toISOString().slice(0, 10)}.csv"`
    );

    res.write('createdAt,action,actorEmail,entityType,entityId,clientId,metadata\n');
    for (const r of rows) {
      const cols = [
        r.createdAt.toISOString(),
        r.action,
        r.actorUser?.email ?? '',
        r.entityType,
        r.entityId,
        r.clientId ?? '',
        r.metadata ? JSON.stringify(r.metadata) : '',
      ].map(csvEscape);
      res.write(cols.join(',') + '\n');
    }
    res.end();
  } catch (err) {
    next(err);
  }
});

// Delegates to the shared escaper: RFC-4180 quoting PLUS formula-injection
// guarding. This export embeds raw JSON metadata, which is exactly where a
// crafted value would ride into a spreadsheet.
function csvEscape(v: string): string {
  return sharedCsvCell(v);
}

// ---------------------------------------------------------------------------
// Brief 2-3 step 4 — audit depth: the full export, the hash chain, retention,
// archives and the SIEM sink. Reads are view:audit (the router's gate);
// changes are manage:org.
// ---------------------------------------------------------------------------

const MANAGE = requireCapability('manage:org');

/**
 * GET /audit/export.csv — every row matching the filters, uncapped, streamed
 * in batches (an org admin's full extract). The chain columns ride along so
 * the file can be checked against the chain.
 */
auditRouter.get('/export.csv', MANAGE, async (req, res) => {
  const f = parseFilters(req);
  const where = buildWhere(f);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="alto-audit-full-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.write('seq,createdAt,action,actorEmail,entityType,entityId,clientId,metadata,hash\n');
  let cursor: { createdAt: Date; id: string } | null = null;
  for (;;) {
    const batch: Array<{ id: string; seq: bigint | null; createdAt: Date; action: string; entityType: string; entityId: string; clientId: string | null; metadata: unknown; hash: string | null; actorUser: { email: string } | null }> = await prisma.auditLog.findMany({
      where: cursor ? { AND: [where, { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] }] } : where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 5000,
      include: { actorUser: { select: { email: true } } },
    });
    for (const r of batch) {
      const cols = [r.seq === null ? '' : String(r.seq), r.createdAt.toISOString(), r.action, r.actorUser?.email ?? '', r.entityType, r.entityId, r.clientId ?? '', r.metadata ? JSON.stringify(r.metadata) : '', r.hash ?? ''].map(csvEscape);
      if (!res.write(cols.join(',') + '\n')) await new Promise((resolve) => res.once('drain', resolve));
    }
    if (batch.length < 5000) break;
    const last = batch[batch.length - 1]!;
    cursor = { createdAt: last.createdAt, id: last.id };
  }
  res.end();
});

const bigintSafe = <T extends Record<string, unknown>>(r: T) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'bigint' ? String(v) : v]));

/** GET /audit/integrity — the chain's last checks, retention, archives and the sink, for this tenant. */
auditRouter.get('/integrity', async (_req, res) => {
  const tenantId = tenantIdForWrite();
  const [checks, retentionYears, archives, sink] = await Promise.all([
    prisma.auditChainCheck.findMany({ where: { tenantId }, orderBy: { checkedAt: 'desc' }, take: 10 }),
    retentionYearsFor(prisma, tenantId),
    prisma.auditArchive.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' }, take: 20 }),
    prisma.auditSink.findUnique({ where: { tenantId }, include: { deliveries: { orderBy: { createdAt: 'desc' }, take: 10 } } }),
  ]);
  res.json({
    checks: checks.map(bigintSafe),
    retentionYears,
    minRetentionYears: MIN_RETENTION_YEARS,
    archives: archives.map(bigintSafe),
    sink: sink
      ? {
          id: sink.id,
          url: sink.url,
          enabled: sink.enabled,
          cursorSeq: String(sink.cursorSeq),
          failures: sink.failures,
          nextAttemptAt: sink.nextAttemptAt,
          lastDeliveredAt: sink.lastDeliveredAt,
          lastError: sink.lastError,
          deliveries: sink.deliveries.map(bigintSafe),
        }
      : null,
  });
});

/** POST /audit/integrity/verify — check this tenant's chain now. */
auditRouter.post('/integrity/verify', MANAGE, async (_req, res) => {
  const tenantId = tenantIdForWrite();
  const r = await verifyAuditChain(prisma, tenantId);
  await prisma.auditChainCheck.create({ data: { tenantId, rows: r.rows, headSeq: r.headSeq, headHash: r.headHash, ok: r.breaks.length === 0, breaks: r.breaks as unknown as Prisma.InputJsonArray } });
  res.json({ ok: r.breaks.length === 0, rows: r.rows, headSeq: r.headSeq === null ? null : String(r.headSeq), breaks: r.breaks });
});

/** PUT /audit/integrity/retention — { years }: never below the legal floor. */
auditRouter.put('/integrity/retention', MANAGE, async (req, res) => {
  const { years } = z.object({ years: z.number().int().min(MIN_RETENTION_YEARS).max(50) }).parse(req.body);
  const tenantId = tenantIdForWrite();
  const before = await retentionYearsFor(prisma, tenantId);
  await prisma.tenant.update({ where: { id: tenantId }, data: { auditRetentionYears: years } });
  await recordCriticalAudit({ actorUserId: req.user!.id, tenantId, action: 'audit.retention_changed', entityType: 'Tenant', entityId: tenantId, metadata: { before: { years: before }, after: { years } } }, 'audit.retention_changed');
  res.json({ retentionYears: years });
});

/** PUT /audit/integrity/sink — { url }: start (or re-key) the SIEM stream; the signing secret is shown once. */
auditRouter.put('/integrity/sink', MANAGE, async (req, res) => {
  const { url } = z.object({ url: z.string().url().max(500).startsWith('https://') }).parse(req.body);
  const tenantId = tenantIdForWrite();
  let made: { id: string; secret: string };
  try {
    made = await createAuditSink(prisma, tenantId, url, req.user!.id);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, 'unsafe_url', err instanceof Error ? err.message : 'That address cannot receive the stream.');
  }
  await recordCriticalAudit({ actorUserId: req.user!.id, tenantId, action: 'audit.sink_configured', entityType: 'AuditSink', entityId: made.id, metadata: { url } }, 'audit.sink_configured');
  res.json({ id: made.id, secret: made.secret });
});

/** POST /audit/integrity/sink/disable — stop the stream (the cursor is kept). */
auditRouter.post('/integrity/sink/disable', MANAGE, async (req, res) => {
  const tenantId = tenantIdForWrite();
  const sink = await prisma.auditSink.findUnique({ where: { tenantId } });
  if (!sink) throw new HttpError(404, 'not_found', 'No sink is configured.');
  await prisma.auditSink.update({ where: { id: sink.id }, data: { enabled: false } });
  await recordCriticalAudit({ actorUserId: req.user!.id, tenantId, action: 'audit.sink_disabled', entityType: 'AuditSink', entityId: sink.id, metadata: { url: sink.url } }, 'audit.sink_disabled');
  res.json({ ok: true });
});
