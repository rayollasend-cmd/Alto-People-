import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireAuth, requireCapability } from '../middleware/auth.js';

/**
 * Phase 130 — Volunteer time off (VTO).
 *
 * Submit / view-mine / cap: any authenticated associate.
 * Approve / reject / mark-matched / set-policy: gated by manage:hr (HR admin).
 *
 * Status machine: PENDING → APPROVED | REJECTED. APPROVED → MATCHED.
 *
 * Annual cap is enforced at submit time against APPROVED + MATCHED hours
 * for the activity-date's calendar year (UTC). PENDING entries don't count
 * yet — submitting before they're approved is allowed; HR can reject if the
 * cumulative cap would be exceeded.
 */

export const vto130Router = Router();

const MANAGE_HR = requireCapability('manage:performance');

// ----- Helpers -------------------------------------------------------------

async function resolvePolicy(clientId: string | null) {
  // Per-client override, else global default. Both are optional rows; if
  // neither exists, fall back to in-code defaults.
  if (clientId) {
    const c = await prisma.vtoPolicy.findUnique({ where: { clientId } });
    if (c) return c;
  }
  const global = await prisma.vtoPolicy.findFirst({
    where: { clientId: null },
  });
  return (
    global ?? {
      annualHoursCap: 24,
      matchRatio: 0,
      matchCurrency: 'USD',
    }
  );
}

// ----- Submit (associate) ---------------------------------------------------

const SubmitInputSchema = z.object({
  activityDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  hours: z.coerce.number().positive().max(24),
  organization: z.string().min(1).max(200),
  cause: z.string().max(200).optional().nullable(),
  description: z.string().min(1).max(5000),
  evidenceUrl: z.string().url().max(500).optional().nullable(),
  matchRequested: z.boolean().optional().default(false),
});

vto130Router.post('/volunteer-entries', requireAuth, async (req, res) => {
  if (!req.user!.associateId) {
    throw new HttpError(
      403,
      'no_associate_record',
      'Only associates can submit volunteer entries.',
    );
  }
  const input = SubmitInputSchema.parse(req.body);
  const created = await prisma.volunteerEntry.create({
    data: {
      associateId: req.user!.associateId,
      activityDate: new Date(input.activityDate),
      hours: input.hours,
      organization: input.organization,
      cause: input.cause ?? null,
      description: input.description,
      evidenceUrl: input.evidenceUrl ?? null,
      matchRequested: input.matchRequested,
    },
  });
  res.status(201).json({ id: created.id });
});

// ----- My entries + cap snapshot -------------------------------------------

vto130Router.get('/my/volunteer-entries', requireAuth, async (req, res) => {
  if (!req.user!.associateId) {
    return res.json({ entries: [], year: null, capHours: 0, usedHours: 0 });
  }
  const year = z.coerce
    .number()
    .int()
    .optional()
    .parse(req.query.year) ?? new Date().getUTCFullYear();
  const start = new Date(`${year}-01-01T00:00:00Z`);
  const end = new Date(`${year + 1}-01-01T00:00:00Z`);

  const associate = await prisma.associate.findUnique({
    where: { id: req.user!.associateId },
    include: { applications: { take: 1, select: { clientId: true } } },
  });
  const clientId = associate?.applications[0]?.clientId ?? null;
  const policy = await resolvePolicy(clientId);

  const entries = await prisma.volunteerEntry.findMany({
    where: {
      associateId: req.user!.associateId,
      activityDate: { gte: start, lt: end },
    },
    orderBy: { activityDate: 'desc' },
  });
  const usedHours = entries
    .filter((e) => e.status === 'APPROVED' || e.status === 'MATCHED')
    .reduce((sum, e) => sum + Number(e.hours), 0);

  res.json({
    entries: entries.map((e) => ({
      id: e.id,
      activityDate: e.activityDate.toISOString().slice(0, 10),
      hours: e.hours.toString(),
      organization: e.organization,
      cause: e.cause,
      description: e.description,
      evidenceUrl: e.evidenceUrl,
      matchRequested: e.matchRequested,
      matchAmount: e.matchAmount?.toString() ?? null,
      matchCurrency: e.matchCurrency,
      status: e.status,
      reviewerNotes: e.reviewerNotes,
      reviewedAt: e.reviewedAt?.toISOString() ?? null,
      createdAt: e.createdAt.toISOString(),
    })),
    year,
    capHours: Number(policy.annualHoursCap),
    usedHours,
    matchRatio: Number(policy.matchRatio),
    matchCurrency: policy.matchCurrency,
  });
});

// ----- HR queue ------------------------------------------------------------

vto130Router.get('/volunteer-entries', MANAGE_HR, async (req, res) => {
  const status = z
    .enum(['PENDING', 'APPROVED', 'REJECTED', 'MATCHED'])
    .optional()
    .parse(req.query.status);
  const rows = await prisma.volunteerEntry.findMany({
    where: status ? { status } : {},
    include: {
      associate: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
      reviewedBy: { select: { email: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  res.json({
    entries: rows.map((e) => ({
      id: e.id,
      associateId: e.associateId,
      associateName: `${e.associate.firstName} ${e.associate.lastName}`,
      associateEmail: e.associate.email,
      activityDate: e.activityDate.toISOString().slice(0, 10),
      hours: e.hours.toString(),
      organization: e.organization,
      cause: e.cause,
      description: e.description,
      evidenceUrl: e.evidenceUrl,
      matchRequested: e.matchRequested,
      matchAmount: e.matchAmount?.toString() ?? null,
      matchCurrency: e.matchCurrency,
      status: e.status,
      reviewerNotes: e.reviewerNotes,
      reviewedByEmail: e.reviewedBy?.email ?? null,
      reviewedAt: e.reviewedAt?.toISOString() ?? null,
      createdAt: e.createdAt.toISOString(),
    })),
  });
});

// ----- Decide --------------------------------------------------------------

const DecideInputSchema = z.object({
  decision: z.enum(['APPROVED', 'REJECTED']),
  notes: z.string().max(2000).optional().nullable(),
});

vto130Router.post(
  '/volunteer-entries/:id/decide',
  MANAGE_HR,
  async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const input = DecideInputSchema.parse(req.body);
    const e = await prisma.volunteerEntry.findUnique({ where: { id } });
    if (!e) {
      throw new HttpError(404, 'not_found', 'Entry not found.');
    }
    if (e.status !== 'PENDING') {
      throw new HttpError(
        409,
        'not_pending',
        `Entry is ${e.status}, cannot decide.`,
      );
    }

    if (input.decision === 'APPROVED') {
      // Cap enforcement at decision time — the user could have submitted
      // multiple PENDING entries; we approve up to the cap and leave the
      // rest for HR to reject manually.
      const associate = await prisma.associate.findUnique({
        where: { id: e.associateId },
        include: { applications: { take: 1, select: { clientId: true } } },
      });
      const clientId = associate?.applications[0]?.clientId ?? null;
      const policy = await resolvePolicy(clientId);
      const year = e.activityDate.getUTCFullYear();
      const start = new Date(`${year}-01-01T00:00:00Z`);
      const end = new Date(`${year + 1}-01-01T00:00:00Z`);
      const usedAggregate = await prisma.volunteerEntry.aggregate({
        where: {
          associateId: e.associateId,
          status: { in: ['APPROVED', 'MATCHED'] },
          activityDate: { gte: start, lt: end },
        },
        _sum: { hours: true },
      });
      const used = Number(usedAggregate._sum.hours ?? 0);
      if (used + Number(e.hours) > Number(policy.annualHoursCap)) {
        throw new HttpError(
          409,
          'cap_exceeded',
          `Approving would exceed the ${policy.annualHoursCap}-hour annual cap (${used} already approved this year).`,
        );
      }
    }

    await prisma.volunteerEntry.update({
      where: { id },
      data: {
        status: input.decision,
        reviewedById: req.user!.id,
        reviewedAt: new Date(),
        reviewerNotes: input.notes ?? null,
      },
    });
    res.json({ ok: true });
  },
);

// ----- Mark matched (record employer match payout) -------------------------

const MatchInputSchema = z.object({
  amount: z.coerce.number().positive().max(1_000_000).optional(),
});

vto130Router.post(
  '/volunteer-entries/:id/match',
  MANAGE_HR,
  async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const input = MatchInputSchema.parse(req.body);
    const e = await prisma.volunteerEntry.findUnique({ where: { id } });
    if (!e) {
      throw new HttpError(404, 'not_found', 'Entry not found.');
    }
    if (e.status !== 'APPROVED') {
      throw new HttpError(
        409,
        'not_approved',
        `Entry is ${e.status}; only APPROVED can be matched.`,
      );
    }
    if (!e.matchRequested) {
      throw new HttpError(
        400,
        'no_match_requested',
        'Associate did not request a match for this entry.',
      );
    }

    // Default match amount = hours × policy.matchRatio.
    let matchAmount = input.amount;
    if (matchAmount == null) {
      const associate = await prisma.associate.findUnique({
        where: { id: e.associateId },
        include: { applications: { take: 1, select: { clientId: true } } },
      });
      const clientId = associate?.applications[0]?.clientId ?? null;
      const policy = await resolvePolicy(clientId);
      matchAmount = Number(e.hours) * Number(policy.matchRatio);
    }

    await prisma.volunteerEntry.update({
      where: { id },
      data: {
        status: 'MATCHED',
        matchAmount,
      },
    });
    res.json({ ok: true });
  },
);

// ----- Policy CRUD ---------------------------------------------------------

vto130Router.get('/vto-policy', MANAGE_HR, async (req, res) => {
  const clientId = z.string().uuid().optional().parse(req.query.clientId);
  const policy = await prisma.vtoPolicy.findFirst({
    where: { clientId: clientId ?? null },
  });
  const fallback = await resolvePolicy(clientId ?? null);
  res.json({
    policy: policy
      ? {
          id: policy.id,
          clientId: policy.clientId,
          annualHoursCap: policy.annualHoursCap.toString(),
          matchRatio: policy.matchRatio.toString(),
          matchCurrency: policy.matchCurrency,
        }
      : null,
    effective: {
      annualHoursCap: fallback.annualHoursCap.toString(),
      matchRatio: fallback.matchRatio.toString(),
      matchCurrency: fallback.matchCurrency,
    },
  });
});

const PolicyInputSchema = z.object({
  clientId: z.string().uuid().nullable().optional(),
  annualHoursCap: z.coerce.number().positive().max(9999),
  matchRatio: z.coerce.number().min(0).max(9999),
  matchCurrency: z.string().length(3).optional().default('USD'),
});

vto130Router.put('/vto-policy', MANAGE_HR, async (req, res) => {
  const input = PolicyInputSchema.parse(req.body);
  const clientId = input.clientId ?? null;
  // Manual upsert because Prisma's upsert on a nullable unique is awkward;
  // also lets us guarantee at-most-one global policy without a unique-on-NULL.
  const existing = await prisma.vtoPolicy.findFirst({ where: { clientId } });
  const data = {
    annualHoursCap: input.annualHoursCap,
    matchRatio: input.matchRatio,
    matchCurrency: input.matchCurrency.toUpperCase(),
  };
  if (existing) {
    await prisma.vtoPolicy.update({
      where: { id: existing.id },
      data,
    });
  } else {
    await prisma.vtoPolicy.create({
      data: { ...data, clientId },
    });
  }
  res.json({ ok: true });
});

// ----- Summary -------------------------------------------------------------

vto130Router.get('/volunteer-summary', MANAGE_HR, async (_req, res) => {
  const year = new Date().getUTCFullYear();
  const start = new Date(`${year}-01-01T00:00:00Z`);
  const [pending, approvedAggregate, matchedAggregate] = await Promise.all([
    prisma.volunteerEntry.count({ where: { status: 'PENDING' } }),
    prisma.volunteerEntry.aggregate({
      where: {
        status: { in: ['APPROVED', 'MATCHED'] },
        activityDate: { gte: start },
      },
      _sum: { hours: true },
    }),
    prisma.volunteerEntry.aggregate({
      where: { status: 'MATCHED', activityDate: { gte: start } },
      _sum: { matchAmount: true },
    }),
  ]);
  res.json({
    pendingCount: pending,
    hoursYtd: approvedAggregate._sum.hours?.toString() ?? '0',
    matchedAmountYtd: matchedAggregate._sum.matchAmount?.toString() ?? '0',
  });
});
