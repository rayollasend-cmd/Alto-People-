import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import type { SessionUser } from '../types/express.js';
import {
  scopeApplications,
  scopeAssociates,
  scopeCandidates,
  scopePayrollItems,
  scopePayrollRuns,
  scopeTimeEntries,
} from '../lib/scope.js';

/**
 * Phase 96 — Reporting builder.
 *
 * A Report is { entity, columns, filters, sort, limit }. The runner
 * compiles spec → Prisma findMany() args. Filters are restricted to a
 * whitelist of operators per column to prevent injection / abuse.
 */

export const reports96Router = Router();

// view:analytics, NOT view:dashboard — the column whitelist includes
// payroll gross/net figures, so any associate or supervisor could build
// an org-wide payroll report through the API while the web nav hid the
// button. Report building is an analytics-tier surface.
const VIEW = requireCapability('view:analytics');

// Whitelist: per-entity, the columns that can be selected/filtered/sorted.
// Maps the spec's column key to a Prisma scalar field. Anything not in
// this map is rejected.
const ENTITY_COLUMNS: Record<string, Record<string, string>> = {
  ASSOCIATE: {
    id: 'id',
    firstName: 'firstName',
    lastName: 'lastName',
    email: 'email',
    state: 'state',
    createdAt: 'createdAt',
  },
  TIME_ENTRY: {
    id: 'id',
    associateId: 'associateId',
    clockIn: 'clockIn',
    clockOut: 'clockOut',
    status: 'status',
  },
  PAYROLL_ITEM: {
    id: 'id',
    runId: 'runId',
    associateId: 'associateId',
    grossAmount: 'grossAmount',
    netAmount: 'netAmount',
  },
  PAYROLL_RUN: {
    id: 'id',
    periodStart: 'periodStart',
    periodEnd: 'periodEnd',
    status: 'status',
    totalGross: 'totalGross',
    totalNet: 'totalNet',
  },
  APPLICATION: {
    id: 'id',
    associateId: 'associateId',
    clientId: 'clientId',
    status: 'status',
    createdAt: 'createdAt',
  },
  EXPENSE: {
    id: 'id',
    amount: 'amount',
    status: 'status',
    submittedAt: 'submittedAt',
  },
  CANDIDATE: {
    id: 'id',
    firstName: 'firstName',
    lastName: 'lastName',
    email: 'email',
    stage: 'stage',
    createdAt: 'createdAt',
  },
};

const FILTER_OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'in'] as const;

const FilterSchema = z.object({
  column: z.string(),
  op: z.enum(FILTER_OPS),
  value: z.unknown(),
});

const SortSchema = z.object({
  column: z.string(),
  direction: z.enum(['asc', 'desc']),
});

const SpecSchema = z.object({
  columns: z.array(z.string()).min(1),
  filters: z.array(FilterSchema).default([]),
  sort: z.array(SortSchema).default([]),
  limit: z.number().int().min(1).max(10000).default(1000),
});

const ReportInputSchema = z.object({
  name: z.string().min(1).max(160),
  description: z.string().max(2000).optional().nullable(),
  entity: z.enum([
    'ASSOCIATE',
    'TIME_ENTRY',
    'PAYROLL_ITEM',
    'PAYROLL_RUN',
    'APPLICATION',
    'EXPENSE',
    'CANDIDATE',
  ]),
  spec: SpecSchema,
  isPublic: z.boolean().optional(),
});

function buildWhere(
  entity: string,
  filters: z.infer<typeof FilterSchema>[],
): Record<string, unknown> {
  const cols = ENTITY_COLUMNS[entity];
  if (!cols) throw new HttpError(400, 'invalid_entity', 'Unknown report entity.');
  const where: Record<string, unknown> = {};
  for (const f of filters) {
    const col = cols[f.column];
    if (!col) {
      throw new HttpError(
        400,
        'invalid_column',
        `Column "${f.column}" is not allowed on ${entity}.`,
      );
    }
    if (f.op === 'eq') where[col] = f.value;
    else if (f.op === 'ne') where[col] = { not: f.value };
    else if (f.op === 'in') {
      if (!Array.isArray(f.value)) {
        throw new HttpError(400, 'invalid_value', '`in` requires an array.');
      }
      where[col] = { in: f.value };
    } else if (f.op === 'contains') {
      where[col] = { contains: String(f.value), mode: 'insensitive' };
    } else {
      where[col] = { [f.op]: f.value };
    }
  }
  return where;
}

function buildSelect(entity: string, columns: string[]): Record<string, true> {
  const cols = ENTITY_COLUMNS[entity];
  if (!cols) throw new HttpError(400, 'invalid_entity', 'Unknown report entity.');
  const select: Record<string, true> = {};
  for (const c of columns) {
    if (!cols[c]) {
      throw new HttpError(
        400,
        'invalid_column',
        `Column "${c}" is not allowed on ${entity}.`,
      );
    }
    select[cols[c]] = true;
  }
  return select;
}

function buildOrderBy(
  entity: string,
  sort: z.infer<typeof SortSchema>[],
): Array<Record<string, 'asc' | 'desc'>> {
  const cols = ENTITY_COLUMNS[entity];
  return sort.map((s) => {
    const col = cols![s.column];
    if (!col) {
      throw new HttpError(
        400,
        'invalid_column',
        `Sort column "${s.column}" not allowed.`,
      );
    }
    return { [col]: s.direction };
  });
}

/**
 * Run a report AS a specific caller.
 *
 * The spec's filters are caller-supplied, so the tenant slice can never
 * come from them — every entity's `where` is the AND of the sanitized
 * spec filters and the caller's `scope*()` clause. Without this a
 * CLIENT_PORTAL user (who holds view:analytics) could select
 * entity=ASSOCIATE or PAYROLL_ITEM and read names, emails, and gross/net
 * pay across EVERY tenant.
 */
async function runReport(
  entity: string,
  spec: z.infer<typeof SpecSchema>,
  user: SessionUser,
): Promise<unknown[]> {
  const specWhere = buildWhere(entity, spec.filters);
  const select = buildSelect(entity, spec.columns);
  const orderBy = buildOrderBy(entity, spec.sort);
  const scoped = <T>(scope: T) => ({ AND: [specWhere, scope] });

  // Map entity → Prisma model client. Only entities in the whitelist are
  // reachable, and the where/select/orderBy are sanitized above.
  switch (entity) {
    case 'ASSOCIATE':
      return prisma.associate.findMany({
        where: scoped(scopeAssociates(user)),
        select,
        orderBy,
        take: spec.limit,
      });
    case 'TIME_ENTRY':
      return prisma.timeEntry.findMany({
        where: scoped(scopeTimeEntries(user)),
        select,
        orderBy,
        take: spec.limit,
      });
    case 'PAYROLL_ITEM':
      return prisma.payrollItem.findMany({
        where: scoped(scopePayrollItems(user)),
        select,
        orderBy,
        take: spec.limit,
      });
    case 'PAYROLL_RUN':
      return prisma.payrollRun.findMany({
        where: scoped(scopePayrollRuns(user)),
        select,
        orderBy,
        take: spec.limit,
      });
    case 'APPLICATION':
      return prisma.application.findMany({
        where: scoped(scopeApplications(user)),
        select,
        orderBy,
        take: spec.limit,
      });
    case 'EXPENSE':
      // Expense table doesn't exist yet (Phase 97 — punted to /reimbursements).
      throw new HttpError(
        501,
        'not_implemented',
        'EXPENSE reports require Phase 97 to ship reimbursements.',
      );
    case 'CANDIDATE':
      return prisma.candidate.findMany({
        where: scoped(scopeCandidates(user)),
        select,
        orderBy,
        take: spec.limit,
      });
    default:
      throw new HttpError(400, 'invalid_entity', 'Unknown report entity.');
  }
}

// ----- Reports CRUD ------------------------------------------------------

reports96Router.get('/reports', VIEW, async (req, res) => {
  const rows = await prisma.report.findMany({
    take: 1000,
    where: {
      deletedAt: null,
      OR: [{ isPublic: true }, { createdById: req.user!.id }],
    },
    orderBy: { name: 'asc' },
  });
  res.json({
    reports: rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      entity: r.entity,
      isPublic: r.isPublic,
      createdAt: r.createdAt.toISOString(),
    })),
  });
});

reports96Router.get('/reports/:id', VIEW, async (req, res) => {
  const r = await prisma.report.findUnique({ where: { id: req.params.id } });
  if (!r || r.deletedAt) throw new HttpError(404, 'not_found', 'Report not found.');
  if (!r.isPublic && r.createdById !== req.user!.id) {
    throw new HttpError(403, 'forbidden', 'This report is private.');
  }
  res.json({
    id: r.id,
    name: r.name,
    description: r.description,
    entity: r.entity,
    spec: r.spec,
    isPublic: r.isPublic,
    createdAt: r.createdAt.toISOString(),
  });
});

reports96Router.post('/reports', VIEW, async (req, res) => {
  const input = ReportInputSchema.parse(req.body);
  // Validate the spec against the whitelist — fail early so saved reports
  // don't ship with invalid columns.
  buildSelect(input.entity, input.spec.columns);
  buildWhere(input.entity, input.spec.filters);
  buildOrderBy(input.entity, input.spec.sort);

  const created = await prisma.report.create({
    data: {
      name: input.name,
      description: input.description ?? null,
      entity: input.entity,
      spec: input.spec as unknown as Prisma.InputJsonValue,
      isPublic: input.isPublic ?? false,
      createdById: req.user!.id,
    },
  });
  res.status(201).json({ id: created.id });
});

reports96Router.delete('/reports/:id', VIEW, async (req, res) => {
  const r = await prisma.report.findUnique({ where: { id: req.params.id } });
  if (!r || r.deletedAt) throw new HttpError(404, 'not_found', 'Report not found.');
  if (r.createdById !== req.user!.id) {
    throw new HttpError(403, 'forbidden', 'Only the author can delete a report.');
  }
  await prisma.report.update({
    where: { id: r.id },
    data: { deletedAt: new Date() },
  });
  res.status(204).end();
});

// ----- Run --------------------------------------------------------------

reports96Router.post('/reports/:id/run', VIEW, async (req, res) => {
  const r = await prisma.report.findUnique({ where: { id: req.params.id } });
  if (!r || r.deletedAt) throw new HttpError(404, 'not_found', 'Report not found.');
  if (!r.isPublic && r.createdById !== req.user!.id) {
    throw new HttpError(403, 'forbidden', 'This report is private.');
  }
  const spec = SpecSchema.parse(r.spec);
  const rows = await runReport(r.entity, spec, req.user!);
  res.json({ entity: r.entity, columns: spec.columns, rows });
});

/**
 * Ad-hoc preview: run a spec without saving it. Useful for the builder
 * UI's "Preview" button.
 */
reports96Router.post('/reports/preview', VIEW, async (req, res) => {
  const input = ReportInputSchema.parse(req.body);
  const rows = await runReport(input.entity, input.spec, req.user!);
  res.json({ entity: input.entity, columns: input.spec.columns, rows });
});

// ----- Schedules --------------------------------------------------------

const ScheduleInputSchema = z.object({
  cadence: z.enum(['DAILY', 'WEEKLY', 'MONTHLY']),
  recipients: z.string().min(1),
});

function nextRunFor(cadence: 'DAILY' | 'WEEKLY' | 'MONTHLY'): Date {
  const now = new Date();
  if (cadence === 'DAILY') {
    return new Date(now.getTime() + 24 * 3600 * 1000);
  }
  if (cadence === 'WEEKLY') {
    return new Date(now.getTime() + 7 * 24 * 3600 * 1000);
  }
  // MONTHLY: roughly 30 days.
  return new Date(now.getTime() + 30 * 24 * 3600 * 1000);
}

reports96Router.post('/reports/:id/schedules', VIEW, async (req, res) => {
  const r = await prisma.report.findUnique({ where: { id: req.params.id } });
  if (!r || r.deletedAt) throw new HttpError(404, 'not_found', 'Report not found.');
  const input = ScheduleInputSchema.parse(req.body);

  // Recipients must be existing, active platform users. A report schedule
  // is a recurring data egress: left free-form, it turns the report
  // builder into "email this roster to any address, forever."
  const addresses = input.recipients
    .split(/[,;]/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (addresses.length === 0) {
    throw new HttpError(400, 'no_recipients', 'At least one recipient is required.');
  }
  const known = await prisma.user.findMany({
    where: { email: { in: addresses }, status: 'ACTIVE', deletedAt: null },
    select: { email: true },
  });
  const knownSet = new Set(known.map((u) => u.email.toLowerCase()));
  const unknown = addresses.filter((e) => !knownSet.has(e));
  if (unknown.length > 0) {
    throw new HttpError(
      400,
      'unknown_recipient',
      `Not an active Alto user: ${unknown.join(', ')}`,
    );
  }

  const created = await prisma.reportSchedule.create({
    data: {
      reportId: r.id,
      cadence: input.cadence,
      recipients: addresses.join(','),
      nextRunAt: nextRunFor(input.cadence),
    },
  });
  res.status(201).json({ id: created.id });
});

reports96Router.get('/reports/:id/schedules', VIEW, async (req, res) => {
  const rows = await prisma.reportSchedule.findMany({
    take: 500,
    where: { reportId: req.params.id },
    orderBy: { createdAt: 'desc' },
  });
  res.json({
    schedules: rows.map((s) => ({
      id: s.id,
      cadence: s.cadence,
      recipients: s.recipients,
      isActive: s.isActive,
      lastRunAt: s.lastRunAt?.toISOString() ?? null,
      nextRunAt: s.nextRunAt.toISOString(),
    })),
  });
});

reports96Router.delete('/report-schedules/:id', VIEW, async (req, res) => {
  await prisma.reportSchedule.delete({ where: { id: req.params.id } });
  res.status(204).end();
});

// ----- Schema discovery -------------------------------------------------

reports96Router.get('/reports/_columns/:entity', VIEW, async (req, res) => {
  const cols = ENTITY_COLUMNS[req.params.entity];
  if (!cols) throw new HttpError(404, 'invalid_entity', 'Unknown entity.');
  res.json({ entity: req.params.entity, columns: Object.keys(cols) });
});
