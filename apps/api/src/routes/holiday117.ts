import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { effectiveClientIdFilter } from '../lib/scope.js';

/**
 * Phase 117 — Holiday calendar.
 *
 * Reuses scheduling caps for read (every shift planner needs to see
 * holidays) and admin/HR caps for write. clientId NULL means company-wide.
 *
 * The dedupe semantics live in the database via a COALESCE-based unique
 * index, so an admin importing federal holidays for the second time gets
 * a 409 — never a duplicate row.
 */

export const holiday117Router = Router();

const VIEW = requireCapability('view:scheduling');
const MANAGE = requireCapability('manage:scheduling');

const TYPE = z.enum(['FEDERAL', 'STATE', 'COMPANY', 'CLIENT_SPECIFIC']);

// ----- List ----------------------------------------------------------------

holiday117Router.get('/holidays', VIEW, async (req, res) => {
  const year = z.coerce.number().int().min(1900).max(2100).optional().parse(
    req.query.year,
  );
  const requested = z.string().uuid().optional().parse(req.query.clientId);
  const clientId = effectiveClientIdFilter(req.user!, requested);
  const type = TYPE.optional().parse(req.query.type);

  const where: Record<string, unknown> = {};
  if (year !== undefined) {
    where.date = {
      gte: new Date(`${year}-01-01`),
      lt: new Date(`${year + 1}-01-01`),
    };
  }
  if (clientId === null) {
    // Tenant-bounded caller with no clientId on file → company-wide only.
    where.clientId = null;
  } else if (clientId !== undefined) {
    // Show company-wide AND this client's holidays.
    where.OR = [{ clientId: null }, { clientId }];
  }
  if (type !== undefined) {
    where.type = type;
  }

  const rows = await prisma.holiday.findMany({
    take: 1000,
    where,
    include: { client: { select: { name: true } } },
    orderBy: { date: 'asc' },
  });
  res.json({
    holidays: rows.map((h) => ({
      id: h.id,
      name: h.name,
      date: h.date.toISOString().slice(0, 10),
      type: h.type,
      state: h.state,
      paid: h.paid,
      notes: h.notes,
      clientId: h.clientId,
      clientName: h.client?.name ?? null,
      scope: h.clientId ? 'client' : 'company',
    })),
  });
});

// ----- Upcoming feed -------------------------------------------------------

holiday117Router.get('/holidays/upcoming', VIEW, async (req, res) => {
  const days = z.coerce.number().int().min(1).max(365).default(30).parse(
    req.query.days,
  );
  const requested = z.string().uuid().optional().parse(req.query.clientId);
  const clientId = effectiveClientIdFilter(req.user!, requested);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const cutoff = new Date(today);
  cutoff.setUTCDate(cutoff.getUTCDate() + days);

  const rows = await prisma.holiday.findMany({
    take: 1000,
    where: {
      date: { gte: today, lte: cutoff },
      ...(clientId === null
        ? { clientId: null }
        : clientId
          ? { OR: [{ clientId: null }, { clientId }] }
          : {}),
    },
    include: { client: { select: { name: true } } },
    orderBy: { date: 'asc' },
  });
  res.json({
    days,
    holidays: rows.map((h) => ({
      id: h.id,
      name: h.name,
      date: h.date.toISOString().slice(0, 10),
      type: h.type,
      paid: h.paid,
      clientName: h.client?.name ?? null,
      daysUntil: Math.round(
        (h.date.getTime() - today.getTime()) / (1000 * 60 * 60 * 24),
      ),
    })),
  });
});

// ----- Create / update / delete --------------------------------------------

const CreateInputSchema = z.object({
  clientId: z.string().uuid().optional().nullable(),
  name: z.string().min(1).max(120),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  type: TYPE,
  state: z.string().length(2).optional().nullable(),
  paid: z.boolean().default(true),
  notes: z.string().max(500).optional().nullable(),
});

holiday117Router.post('/holidays', MANAGE, async (req, res) => {
  const input = CreateInputSchema.parse(req.body);
  if (input.type === 'STATE' && !input.state) {
    throw new HttpError(400, 'state_required', 'STATE holidays must include a state code.');
  }
  if (input.type === 'CLIENT_SPECIFIC' && !input.clientId) {
    throw new HttpError(
      400,
      'client_required',
      'CLIENT_SPECIFIC holidays must include a clientId.',
    );
  }
  try {
    const created = await prisma.holiday.create({
      data: {
        clientId: input.clientId ?? null,
        name: input.name,
        date: new Date(input.date),
        type: input.type,
        state: input.state ?? null,
        paid: input.paid,
        notes: input.notes ?? null,
        createdById: req.user!.id,
      },
    });
    res.status(201).json({ id: created.id });
  } catch (err: unknown) {
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code: string }).code === 'P2002'
    ) {
      throw new HttpError(
        409,
        'duplicate',
        'This holiday already exists for that scope and date.',
      );
    }
    throw err;
  }
});

const UpdateInputSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  paid: z.boolean().optional(),
  notes: z.string().max(500).optional().nullable(),
  state: z.string().length(2).optional().nullable(),
});

holiday117Router.patch('/holidays/:id', MANAGE, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const input = UpdateInputSchema.parse(req.body);
  const existing = await prisma.holiday.findUnique({ where: { id } });
  if (!existing) {
    throw new HttpError(404, 'not_found', 'Holiday not found.');
  }
  await prisma.holiday.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.paid !== undefined ? { paid: input.paid } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      ...(input.state !== undefined ? { state: input.state } : {}),
    },
  });
  res.json({ ok: true });
});

holiday117Router.delete('/holidays/:id', MANAGE, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const existing = await prisma.holiday.findUnique({ where: { id } });
  if (!existing) {
    throw new HttpError(404, 'not_found', 'Holiday not found.');
  }
  await prisma.holiday.delete({ where: { id } });
  res.status(204).end();
});

// ----- Bulk import US federal holidays for a year --------------------------
//
// Convenience for first-time setup. Skips duplicates so re-running is safe.
const USFederalHolidays2026: { name: string; month: number; day: number }[] = [
  { name: "New Year's Day", month: 1, day: 1 },
  { name: 'Martin Luther King Jr. Day', month: 1, day: 19 }, // 3rd Mon Jan
  { name: "Presidents' Day", month: 2, day: 16 },
  { name: 'Memorial Day', month: 5, day: 25 },
  { name: 'Juneteenth', month: 6, day: 19 },
  { name: 'Independence Day', month: 7, day: 4 },
  { name: 'Labor Day', month: 9, day: 7 },
  { name: 'Columbus Day', month: 10, day: 12 },
  { name: 'Veterans Day', month: 11, day: 11 },
  { name: 'Thanksgiving Day', month: 11, day: 26 },
  { name: 'Christmas Day', month: 12, day: 25 },
];

holiday117Router.post(
  '/holidays/import-us-federal-2026',
  MANAGE,
  async (req, res) => {
    let inserted = 0;
    for (const h of USFederalHolidays2026) {
      try {
        await prisma.holiday.create({
          data: {
            clientId: null,
            name: h.name,
            date: new Date(
              Date.UTC(2026, h.month - 1, h.day),
            ),
            type: 'FEDERAL',
            paid: true,
            createdById: req.user!.id,
          },
        });
        inserted++;
      } catch (err: unknown) {
        if (
          err &&
          typeof err === 'object' &&
          'code' in err &&
          (err as { code: string }).code === 'P2002'
        ) {
          // Already imported — skip.
          continue;
        }
        throw err;
      }
    }
    res.json({ inserted, skipped: USFederalHolidays2026.length - inserted });
  },
);

// ----- Bulk import US federal holidays for ANY year ------------------------
//
// The 2026 route above froze the dates; the client then re-implemented the
// floating-holiday math in the browser and fired 11 sequential POSTs (a
// mid-loop failure left a half-seeded year). This computes the dates
// server-side for the requested year in one idempotent call.

/** Nth (1-based) occurrence of a weekday (0=Sun..6=Sat) in a month (1-12), UTC. */
function nthWeekdayUTC(year: number, month: number, weekday: number, n: number): Date {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(year, month - 1, 1 + offset + (n - 1) * 7));
}

/** Last occurrence of a weekday in a month, UTC. */
function lastWeekdayUTC(year: number, month: number, weekday: number): Date {
  const last = new Date(Date.UTC(year, month, 0)); // last day of month
  const offset = (last.getUTCDay() - weekday + 7) % 7;
  return new Date(Date.UTC(year, month - 1, last.getUTCDate() - offset));
}

function usFederalHolidays(year: number): { name: string; date: Date }[] {
  return [
    { name: "New Year's Day", date: new Date(Date.UTC(year, 0, 1)) },
    { name: 'Martin Luther King Jr. Day', date: nthWeekdayUTC(year, 1, 1, 3) },
    { name: "Presidents' Day", date: nthWeekdayUTC(year, 2, 1, 3) },
    { name: 'Memorial Day', date: lastWeekdayUTC(year, 5, 1) },
    { name: 'Juneteenth', date: new Date(Date.UTC(year, 5, 19)) },
    { name: 'Independence Day', date: new Date(Date.UTC(year, 6, 4)) },
    { name: 'Labor Day', date: nthWeekdayUTC(year, 9, 1, 1) },
    { name: 'Columbus Day', date: nthWeekdayUTC(year, 10, 1, 2) },
    { name: 'Veterans Day', date: new Date(Date.UTC(year, 10, 11)) },
    { name: 'Thanksgiving Day', date: nthWeekdayUTC(year, 11, 4, 4) },
    { name: 'Christmas Day', date: new Date(Date.UTC(year, 11, 25)) },
  ];
}

holiday117Router.post('/holidays/import-us-federal', MANAGE, async (req, res) => {
  const { year } = z
    .object({ year: z.number().int().min(2000).max(2100) })
    .parse(req.body);
  const holidays = usFederalHolidays(year);
  let inserted = 0;
  for (const h of holidays) {
    try {
      await prisma.holiday.create({
        data: {
          clientId: null,
          name: h.name,
          date: h.date,
          type: 'FEDERAL',
          paid: true,
          createdById: req.user!.id,
        },
      });
      inserted++;
    } catch (err: unknown) {
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code: string }).code === 'P2002'
      ) {
        continue; // Already imported — idempotent.
      }
      throw err;
    }
  }
  res.json({ inserted, skipped: holidays.length - inserted });
});
