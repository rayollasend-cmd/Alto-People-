import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireAuth, requireCapability } from '../middleware/auth.js';

/**
 * Phase 129 — Equity grants & vesting.
 *
 * Create / cancel / view-all: gated by manage:compensation (HR + Finance).
 * Self-view: any authenticated associate sees their own grants and vesting
 * events. Vesting schedule is materialized to one row per event at grant
 * time so reports query directly without recomputation; manual edits to a
 * single tranche just touch one row.
 *
 * Status machine: PROPOSED → GRANTED. GRANTED → CANCELLED | EXERCISED.
 * EXPIRED is set by an internal job (not implemented this phase) when an
 * option grant's expirationDate passes; for now we just expose the column.
 */

export const equity129Router = Router();

const MANAGE_COMP = requireCapability('manage:comp');

// ----- Vesting schedule generator ------------------------------------------

/**
 * Standard 4-year monthly cadence with a configurable cliff. The cliff
 * tranche covers months [0, cliffMonths) at once; subsequent tranches each
 * cover one month. We use the LAST day of the calendar month so a Feb 29
 * grant date doesn't drift to March 1.
 */
function generateSchedule(input: {
  totalShares: number;
  vestingStartDate: Date;
  cliffMonths: number;
  vestingMonths: number;
}): Array<{
  eventIndex: number;
  vestDate: Date;
  shares: number;
  isCliff: boolean;
}> {
  const { totalShares, vestingStartDate, cliffMonths, vestingMonths } = input;
  const events: Array<{
    eventIndex: number;
    vestDate: Date;
    shares: number;
    isCliff: boolean;
  }> = [];

  const monthlyTrancheCount = vestingMonths - cliffMonths;
  // Cliff tranche: floor(cliffMonths / vestingMonths × totalShares).
  const cliffShares =
    cliffMonths > 0
      ? Math.floor((totalShares * cliffMonths) / vestingMonths)
      : 0;
  const remainingShares = totalShares - cliffShares;
  const baseMonthly =
    monthlyTrancheCount > 0
      ? Math.floor(remainingShares / monthlyTrancheCount)
      : 0;
  const remainder =
    monthlyTrancheCount > 0
      ? remainingShares - baseMonthly * monthlyTrancheCount
      : 0;

  let idx = 0;
  if (cliffMonths > 0 && cliffShares > 0) {
    const d = new Date(vestingStartDate);
    d.setUTCMonth(d.getUTCMonth() + cliffMonths);
    events.push({
      eventIndex: idx++,
      vestDate: d,
      shares: cliffShares,
      isCliff: true,
    });
  }

  for (let m = 0; m < monthlyTrancheCount; m++) {
    const d = new Date(vestingStartDate);
    d.setUTCMonth(d.getUTCMonth() + cliffMonths + m + 1);
    // Distribute the remainder across the LAST tranches so totals always sum.
    const extra = m >= monthlyTrancheCount - remainder ? 1 : 0;
    const shares = baseMonthly + extra;
    if (shares <= 0) continue;
    events.push({
      eventIndex: idx++,
      vestDate: d,
      shares,
      isCliff: false,
    });
  }

  return events;
}

// ----- Create grant (HR) ---------------------------------------------------

const CreateInputSchema = z.object({
  associateId: z.string().uuid(),
  grantType: z.enum(['RSU', 'NSO', 'ISO', 'PHANTOM', 'PERFORMANCE_RSU']),
  totalShares: z.coerce.number().int().positive().max(10_000_000),
  strikePrice: z.coerce.number().positive().max(1_000_000).optional().nullable(),
  currency: z.string().length(3).optional().default('USD'),
  grantDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  vestingStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  cliffMonths: z.coerce.number().int().min(0).max(120).optional().default(12),
  vestingMonths: z.coerce.number().int().positive().max(120).optional().default(48),
  expirationDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .nullable(),
  notes: z.string().max(2000).optional().nullable(),
});

equity129Router.post('/equity-grants', MANAGE_COMP, async (req, res) => {
  const input = CreateInputSchema.parse(req.body);
  if (input.cliffMonths > input.vestingMonths) {
    throw new HttpError(
      400,
      'cliff_exceeds_vesting',
      'Cliff cannot exceed total vesting period.',
    );
  }
  if (
    (input.grantType === 'NSO' || input.grantType === 'ISO') &&
    (input.strikePrice == null || input.strikePrice <= 0)
  ) {
    throw new HttpError(
      400,
      'strike_required',
      'Options require a positive strike price.',
    );
  }
  const associate = await prisma.associate.findUnique({
    where: { id: input.associateId },
  });
  if (!associate) {
    throw new HttpError(404, 'associate_not_found', 'Associate not found.');
  }

  const events = generateSchedule({
    totalShares: input.totalShares,
    vestingStartDate: new Date(input.vestingStartDate),
    cliffMonths: input.cliffMonths,
    vestingMonths: input.vestingMonths,
  });

  const grant = await prisma.equityGrant.create({
    data: {
      associateId: input.associateId,
      grantType: input.grantType,
      totalShares: input.totalShares,
      strikePrice: input.strikePrice ?? null,
      currency: input.currency.toUpperCase(),
      grantDate: new Date(input.grantDate),
      vestingStartDate: new Date(input.vestingStartDate),
      cliffMonths: input.cliffMonths,
      vestingMonths: input.vestingMonths,
      expirationDate: input.expirationDate ? new Date(input.expirationDate) : null,
      notes: input.notes ?? null,
      grantedById: req.user!.id,
      vestingEvents: { create: events },
    },
  });

  res.status(201).json({ id: grant.id });
});

// ----- Status transitions --------------------------------------------------

equity129Router.post(
  '/equity-grants/:id/grant',
  MANAGE_COMP,
  async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const g = await prisma.equityGrant.findUnique({ where: { id } });
    if (!g) {
      throw new HttpError(404, 'not_found', 'Grant not found.');
    }
    if (g.status !== 'PROPOSED') {
      throw new HttpError(
        409,
        'not_proposed',
        `Grant is ${g.status}, only PROPOSED can be granted.`,
      );
    }
    await prisma.equityGrant.update({
      where: { id },
      data: { status: 'GRANTED' },
    });
    res.json({ ok: true });
  },
);

equity129Router.post(
  '/equity-grants/:id/cancel',
  MANAGE_COMP,
  async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const g = await prisma.equityGrant.findUnique({ where: { id } });
    if (!g) {
      throw new HttpError(404, 'not_found', 'Grant not found.');
    }
    if (g.status !== 'PROPOSED' && g.status !== 'GRANTED') {
      throw new HttpError(
        409,
        'not_cancellable',
        `Cannot cancel a ${g.status} grant.`,
      );
    }
    await prisma.equityGrant.update({
      where: { id },
      data: { status: 'CANCELLED' },
    });
    res.json({ ok: true });
  },
);

equity129Router.post(
  '/equity-grants/:id/exercise',
  MANAGE_COMP,
  async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const g = await prisma.equityGrant.findUnique({ where: { id } });
    if (!g) {
      throw new HttpError(404, 'not_found', 'Grant not found.');
    }
    if (g.status !== 'GRANTED') {
      throw new HttpError(
        409,
        'not_granted',
        `Only GRANTED options can be exercised; this is ${g.status}.`,
      );
    }
    if (g.grantType !== 'NSO' && g.grantType !== 'ISO') {
      throw new HttpError(
        400,
        'not_options',
        'Only options can be exercised.',
      );
    }
    await prisma.equityGrant.update({
      where: { id },
      data: { status: 'EXERCISED' },
    });
    res.json({ ok: true });
  },
);

// ----- HR list / detail ----------------------------------------------------

equity129Router.get('/equity-grants', MANAGE_COMP, async (req, res) => {
  const status = z
    .enum(['PROPOSED', 'GRANTED', 'CANCELLED', 'EXERCISED', 'EXPIRED'])
    .optional()
    .parse(req.query.status);
  const rows = await prisma.equityGrant.findMany({
    where: status ? { status } : {},
    include: {
      associate: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
      grantedBy: { select: { email: true } },
    },
    orderBy: { grantDate: 'desc' },
  });
  res.json({
    grants: rows.map(serializeGrant),
  });
});

equity129Router.get('/equity-grants/:id', MANAGE_COMP, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const g = await prisma.equityGrant.findUnique({
    where: { id },
    include: {
      associate: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
      grantedBy: { select: { email: true } },
      vestingEvents: { orderBy: { eventIndex: 'asc' } },
    },
  });
  if (!g) {
    throw new HttpError(404, 'not_found', 'Grant not found.');
  }
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  let vested = 0;
  for (const e of g.vestingEvents) {
    if (e.vestDate <= today) vested += e.shares;
  }
  res.json({
    grant: {
      ...serializeGrant(g),
      events: g.vestingEvents.map((e) => ({
        id: e.id,
        eventIndex: e.eventIndex,
        vestDate: e.vestDate.toISOString().slice(0, 10),
        shares: e.shares,
        isCliff: e.isCliff,
        vested: e.vestDate <= today,
      })),
      vestedShares: vested,
      unvestedShares: g.totalShares - vested,
    },
  });
});

// ----- Self view (any authenticated associate) -----------------------------

equity129Router.get('/my/equity-grants', requireAuth, async (req, res) => {
  if (!req.user!.associateId) {
    return res.json({ grants: [] });
  }
  const rows = await prisma.equityGrant.findMany({
    where: {
      associateId: req.user!.associateId,
      status: { in: ['GRANTED', 'EXERCISED'] },
    },
    include: { vestingEvents: { orderBy: { eventIndex: 'asc' } } },
    orderBy: { grantDate: 'desc' },
  });
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  res.json({
    grants: rows.map((g) => {
      let vested = 0;
      const upcoming: { vestDate: string; shares: number }[] = [];
      for (const e of g.vestingEvents) {
        if (e.vestDate <= today) {
          vested += e.shares;
        } else if (upcoming.length < 6) {
          upcoming.push({
            vestDate: e.vestDate.toISOString().slice(0, 10),
            shares: e.shares,
          });
        }
      }
      return {
        id: g.id,
        grantType: g.grantType,
        status: g.status,
        totalShares: g.totalShares,
        vestedShares: vested,
        unvestedShares: g.totalShares - vested,
        strikePrice: g.strikePrice?.toString() ?? null,
        currency: g.currency,
        grantDate: g.grantDate.toISOString().slice(0, 10),
        vestingStartDate: g.vestingStartDate.toISOString().slice(0, 10),
        cliffMonths: g.cliffMonths,
        vestingMonths: g.vestingMonths,
        expirationDate: g.expirationDate?.toISOString().slice(0, 10) ?? null,
        upcomingTranches: upcoming,
      };
    }),
  });
});

// ----- Summary -------------------------------------------------------------

equity129Router.get(
  '/equity-grants-summary',
  MANAGE_COMP,
  async (_req, res) => {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const [grantedAggregate, vestedAggregate, proposedCount, activeRecipients] =
      await Promise.all([
        prisma.equityGrant.aggregate({
          where: { status: { in: ['GRANTED', 'EXERCISED'] } },
          _sum: { totalShares: true },
        }),
        prisma.equityVestingEvent.aggregate({
          where: {
            vestDate: { lte: today },
            grant: { status: { in: ['GRANTED', 'EXERCISED'] } },
          },
          _sum: { shares: true },
        }),
        prisma.equityGrant.count({ where: { status: 'PROPOSED' } }),
        prisma.equityGrant.findMany({
          where: { status: 'GRANTED' },
          select: { associateId: true },
          distinct: ['associateId'],
        }),
      ]);
    res.json({
      proposedCount,
      activeRecipients: activeRecipients.length,
      sharesGranted: grantedAggregate._sum.totalShares ?? 0,
      sharesVested: vestedAggregate._sum.shares ?? 0,
    });
  },
);

// ----- Helpers --------------------------------------------------------------

type GrantWithRelations = {
  id: string;
  grantType: string;
  status: string;
  totalShares: number;
  strikePrice: { toString(): string } | null;
  currency: string;
  grantDate: Date;
  vestingStartDate: Date;
  cliffMonths: number;
  vestingMonths: number;
  expirationDate: Date | null;
  notes: string | null;
  createdAt: Date;
  associate?: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
  };
  grantedBy?: { email: string } | null;
};

function serializeGrant(g: GrantWithRelations) {
  return {
    id: g.id,
    associateId: g.associate?.id ?? null,
    associateName: g.associate
      ? `${g.associate.firstName} ${g.associate.lastName}`
      : null,
    associateEmail: g.associate?.email ?? null,
    grantType: g.grantType,
    status: g.status,
    totalShares: g.totalShares,
    strikePrice: g.strikePrice?.toString() ?? null,
    currency: g.currency,
    grantDate: g.grantDate.toISOString().slice(0, 10),
    vestingStartDate: g.vestingStartDate.toISOString().slice(0, 10),
    cliffMonths: g.cliffMonths,
    vestingMonths: g.vestingMonths,
    expirationDate: g.expirationDate?.toISOString().slice(0, 10) ?? null,
    notes: g.notes,
    grantedByEmail: g.grantedBy?.email ?? null,
    createdAt: g.createdAt.toISOString(),
  };
}
