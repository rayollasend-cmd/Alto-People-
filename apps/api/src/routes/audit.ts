import { Router } from 'express';
import { z } from 'zod';
import type { AuditSearchEntry, AuditSearchResponse } from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';

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
  const where: Record<string, unknown> = {};
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

function csvEscape(v: string): string {
  if (v === '') return '';
  if (/[",\n\r]/.test(v)) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}
