import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import {
  ENTITY_COLUMNS,
  SpecSchema,
  buildOrderBy,
  buildSelect,
  buildWhere,
  runReport,
} from '../lib/reportRun.js';

/**
 * Phase 96 — Reporting builder.
 *
 * Spec compilation + execution live in lib/reportRun.ts (shared with the
 * scheduled-report runner in lib/reportScheduleRunner.ts). These routes
 * are the HTTP surface: CRUD, run/preview, schedules, column discovery.
 */

export const reports96Router = Router();

// view:analytics, NOT view:dashboard — the column whitelist includes
// payroll gross/net figures, so any associate or supervisor could build
// an org-wide payroll report through the API while the web nav hid the
// button. Report building is an analytics-tier surface.
const VIEW = requireCapability('view:analytics');

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
  // `spec` is a raw Json column. Returning it unvalidated meant the web —
  // which types it as a fully-required ReportSpec and dereferences
  // `.columns` — white-screened on any legacy or hand-edited row. Parse
  // it here so a malformed spec is a clean 422 naming the report, not a
  // crash in the builder.
  const spec = SpecSchema.safeParse(r.spec);
  if (!spec.success) {
    throw new HttpError(
      422,
      'invalid_spec',
      `"${r.name}" has a saved definition this version can't read. Rebuild it from the report builder.`,
      spec.error.flatten(),
    );
  }
  res.json({
    id: r.id,
    name: r.name,
    description: r.description,
    entity: r.entity,
    spec: spec.data,
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
      lastStatus: s.lastStatus,
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
