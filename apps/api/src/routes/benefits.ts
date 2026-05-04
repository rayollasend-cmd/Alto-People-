import { Router } from 'express';
import {
  BenefitsEnrollInputSchema,
  BenefitsPlanCreateInputSchema,
  BenefitsPlanUpdateInputSchema,
  BenefitsTerminateInputSchema,
  type BenefitsEnrollment,
  type BenefitsEnrollmentListResponse,
  type BenefitsPlan,
  type BenefitsPlanListResponse,
} from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';

export const benefitsRouter = Router();

const MANAGE_PAYROLL = requireCapability('process:payroll');

/* ===== Plans (HR-managed catalog) ====================================== */

/**
 * GET /benefits/plans?clientId=...
 * Lists plans. Without clientId returns nothing — the catalog is per-client
 * by design and a "show me everything" view would mislead HR for a
 * multi-client org.
 */
benefitsRouter.get('/plans', async (req, res, next) => {
  try {
    const clientId = req.query.clientId;
    if (typeof clientId !== 'string' || clientId.length === 0) {
      const empty: BenefitsPlanListResponse = { plans: [] };
      res.json(empty);
      return;
    }
    const includeInactive = req.query.includeInactive === 'true';
    const rows = await prisma.benefitsPlan.findMany({
      take: 1000,
      where: {
        clientId,
        ...(includeInactive ? {} : { isActive: true }),
      },
      orderBy: [{ kind: 'asc' }, { name: 'asc' }],
    });
    const plans: BenefitsPlan[] = rows.map(toPlan);
    const body: BenefitsPlanListResponse = { plans };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

benefitsRouter.post('/plans', MANAGE_PAYROLL, async (req, res, next) => {
  try {
    const parsed = BenefitsPlanCreateInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const input = parsed.data;
    const client = await prisma.client.findFirst({
      where: { id: input.clientId, deletedAt: null },
      select: { id: true },
    });
    if (!client) throw new HttpError(404, 'client_not_found', 'Client not found');

    const created = await prisma.benefitsPlan.create({
      data: {
        clientId: input.clientId,
        kind: input.kind,
        name: input.name,
        description: input.description ?? null,
        employerContributionCentsPerPeriod: input.employerContributionCentsPerPeriod,
        employeeContributionDefaultCentsPerPeriod: input.employeeContributionDefaultCentsPerPeriod,
      },
    });
    res.status(201).json(toPlan(created));
  } catch (err) {
    next(err);
  }
});

benefitsRouter.patch('/plans/:id', MANAGE_PAYROLL, async (req, res, next) => {
  try {
    const parsed = BenefitsPlanUpdateInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const found = await prisma.benefitsPlan.findUnique({ where: { id: req.params.id } });
    if (!found) throw new HttpError(404, 'plan_not_found', 'Plan not found');

    const updated = await prisma.benefitsPlan.update({
      where: { id: req.params.id },
      data: {
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
        ...(parsed.data.employerContributionCentsPerPeriod !== undefined
          ? { employerContributionCentsPerPeriod: parsed.data.employerContributionCentsPerPeriod }
          : {}),
        ...(parsed.data.employeeContributionDefaultCentsPerPeriod !== undefined
          ? {
              employeeContributionDefaultCentsPerPeriod:
                parsed.data.employeeContributionDefaultCentsPerPeriod,
            }
          : {}),
        ...(parsed.data.isActive !== undefined ? { isActive: parsed.data.isActive } : {}),
      },
    });
    res.json(toPlan(updated));
  } catch (err) {
    next(err);
  }
});

/* ===== Enrollments ===================================================== */

/**
 * GET /benefits/me/enrollments
 * Associate's own active + historical elections. Active = no terminationDate
 * or terminationDate in the future.
 */
benefitsRouter.get('/me/enrollments', async (req, res, next) => {
  try {
    if (!req.user!.associateId) {
      const body: BenefitsEnrollmentListResponse = { enrollments: [] };
      res.json(body);
      return;
    }
    const rows = await prisma.benefitsEnrollment.findMany({
      take: 500,
      where: { associateId: req.user!.associateId },
      orderBy: { effectiveDate: 'desc' },
      include: { plan: { select: { kind: true, name: true } } },
    });
    const body: BenefitsEnrollmentListResponse = {
      enrollments: rows.map(toEnrollment),
    };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /benefits/me/enrollments
 * Associate self-enrolls in a plan offered by their employer. Refuses if
 * the plan is inactive or doesn't belong to the associate's client.
 */
benefitsRouter.post('/me/enrollments', async (req, res, next) => {
  try {
    if (!req.user!.associateId) {
      throw new HttpError(404, 'no_associate', 'This account has no associate profile');
    }
    const parsed = BenefitsEnrollInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const created = await enrollAssociate(req.user!.associateId, parsed.data, true);
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

benefitsRouter.post(
  '/me/enrollments/:id/terminate',
  async (req, res, next) => {
    try {
      if (!req.user!.associateId) {
        throw new HttpError(404, 'no_associate', 'This account has no associate profile');
      }
      const parsed = BenefitsTerminateInputSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
      }
      const found = await prisma.benefitsEnrollment.findUnique({
        where: { id: req.params.id },
      });
      if (!found || found.associateId !== req.user!.associateId) {
        throw new HttpError(404, 'enrollment_not_found', 'Enrollment not found');
      }
      const terminated = await prisma.benefitsEnrollment.update({
        where: { id: req.params.id },
        data: { terminationDate: new Date(parsed.data.terminationDate) },
        include: { plan: { select: { kind: true, name: true } } },
      });
      res.json(toEnrollment(terminated));
    } catch (err) {
      next(err);
    }
  }
);

/* ===== Helpers ========================================================== */

async function enrollAssociate(
  associateId: string,
  input: { planId: string; electedAmountCentsPerPeriod: number; effectiveDate: string },
  selfService: boolean
): Promise<BenefitsEnrollment> {
  const plan = await prisma.benefitsPlan.findUnique({ where: { id: input.planId } });
  if (!plan) throw new HttpError(404, 'plan_not_found', 'Plan not found');
  if (!plan.isActive) {
    throw new HttpError(409, 'plan_inactive', 'This plan is no longer offered');
  }
  // For self-service, the plan must belong to the associate's client.
  // (HR-side enrollment can override later when we add admin endpoints.)
  if (selfService) {
    const associate = await prisma.associate.findUnique({
      where: { id: associateId },
      include: {
        applications: { select: { clientId: true }, take: 1, orderBy: { createdAt: 'desc' } },
      },
    });
    const clientId = associate?.applications[0]?.clientId;
    if (clientId && plan.clientId !== clientId) {
      throw new HttpError(
        403,
        'plan_not_offered',
        "This plan is not offered by this associate's employer"
      );
    }
  }

  const created = await prisma.benefitsEnrollment.create({
    data: {
      associateId,
      planId: input.planId,
      electedAmountCentsPerPeriod: input.electedAmountCentsPerPeriod,
      effectiveDate: new Date(input.effectiveDate),
    },
    include: { plan: { select: { kind: true, name: true } } },
  });
  return toEnrollment(created);
}

function toPlan(p: {
  id: string;
  clientId: string;
  kind: string;
  name: string;
  description: string | null;
  employerContributionCentsPerPeriod: number;
  employeeContributionDefaultCentsPerPeriod: number;
  isActive: boolean;
}): BenefitsPlan {
  return {
    id: p.id,
    clientId: p.clientId,
    kind: p.kind as BenefitsPlan['kind'],
    name: p.name,
    description: p.description,
    employerContributionCentsPerPeriod: p.employerContributionCentsPerPeriod,
    employeeContributionDefaultCentsPerPeriod: p.employeeContributionDefaultCentsPerPeriod,
    isActive: p.isActive,
  };
}

function toEnrollment(e: {
  id: string;
  associateId: string;
  planId: string;
  electedAmountCentsPerPeriod: number;
  effectiveDate: Date;
  terminationDate: Date | null;
  plan: { kind: string; name: string };
}): BenefitsEnrollment {
  return {
    id: e.id,
    associateId: e.associateId,
    planId: e.planId,
    electedAmountCentsPerPeriod: e.electedAmountCentsPerPeriod,
    effectiveDate: e.effectiveDate.toISOString(),
    terminationDate: e.terminationDate ? e.terminationDate.toISOString() : null,
    planKind: e.plan.kind as BenefitsEnrollment['planKind'],
    planName: e.plan.name,
  };
}
