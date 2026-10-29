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
import { toDateOnly } from '@alto-people/shared';
import type { Prisma } from '@prisma/client';
import { can } from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireAnyCapability, requireCapability } from '../middleware/auth.js';
import { primaryClientsForAssociates } from '../lib/associateClients.js';
import { scopeActiveAssociates, scopeClients, scopeWhere } from '../lib/scope.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { orgDateKey } from '../lib/timeAnomalies.js';
import { dateColumnKey } from '../lib/timezone.js';

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

/**
 * The client whose plans an associate may elect: where they work today
 * (an open assignment), else their most recently approved application's
 * client (lib/associateClients), else their newest application's. One
 * rule for what the page offers and what enrolling allows.
 */
export async function benefitsClientFor(associateId: string): Promise<{ clientId: string; clientName: string } | null> {
  const primary = (await primaryClientsForAssociates([associateId])).get(associateId);
  if (primary) return primary;
  const app = await prisma.application.findFirst({
    where: { associateId, deletedAt: null, clientId: { not: null } },
    orderBy: { createdAt: 'desc' },
    select: { client: { select: { id: true, name: true } } },
  });
  return app?.client ? { clientId: app.client.id, clientName: app.client.name } : null;
}

/**
 * GET /benefits/plans/mine — the plans the signed-in associate can elect,
 * resolved on the server from their placement. The page used to ask
 * /scheduling/clients for a client id first, which an associate may not
 * read (403), so associates never saw a plan.
 */
benefitsRouter.get('/plans/mine', async (req, res, next) => {
  try {
    const associateId = req.user!.associateId;
    if (!associateId) {
      res.json({ client: null, plans: [] });
      return;
    }
    const client = await benefitsClientFor(associateId);
    if (!client) {
      res.json({ client: null, plans: [] });
      return;
    }
    const rows = await prisma.benefitsPlan.findMany({
      where: { tenantId: tenantIdForWrite(), clientId: client.clientId, isActive: true },
      orderBy: [{ kind: 'asc' }, { name: 'asc' }],
      take: 200,
    });
    res.json({ client: { id: client.clientId, name: client.clientName }, plans: rows.map(toPlan) });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /benefits/overview — the benefits desk for people who run it (HR,
 * finance), not the person enrolling: plans by client with how many are
 * enrolled and what they put in each pay period, open enrollment, life
 * events waiting, COBRA offers not yet answered, and each carrier feed's
 * last file. Clients and people are the caller's reach (scopeClients,
 * scopeActiveAssociates), in the caller's tenant. Carrier feeds need
 * process:payroll (their own page's gate) and are omitted otherwise.
 */
// The desk view is for whoever runs benefits — never an associate's.
const RUNS_BENEFITS = requireAnyCapability('process:payroll', 'view:hr-admin');

benefitsRouter.get('/overview', RUNS_BENEFITS, async (req, res, next) => {
  try {
    const user = req.user!;
    const tenantId = tenantIdForWrite();
    // The company's day, not UTC's (CODE-14): an evening view must not count tomorrow's windows as open.
    const today = new Date(`${orgDateKey(new Date())}T00:00:00.000Z`);
    const clients = await prisma.client.findMany({
      where: scopeWhere<Prisma.ClientWhereInput>({ tenantId }, scopeClients(user)),
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
      take: 2000,
    });
    const clientIds = clients.map((c) => c.id);
    const people: Prisma.AssociateWhereInput = scopeActiveAssociates(user, { former: true });
    const [plans, enrollments, windows, qlesWaiting, cobraPending] = await Promise.all([
      prisma.benefitsPlan.findMany({ where: { tenantId, clientId: { in: clientIds } }, orderBy: [{ kind: 'asc' }, { name: 'asc' }], take: 2000 }),
      prisma.benefitsEnrollment.findMany({
        where: {
          tenantId,
          plan: { clientId: { in: clientIds } },
          effectiveDate: { lte: today },
          OR: [{ terminationDate: null }, { terminationDate: { gt: today } }],
          associate: people,
        },
        select: { planId: true, associateId: true, electedAmountCentsPerPeriod: true },
        take: 50_000,
      }),
      prisma.openEnrollmentWindow.findMany({
        where: { tenantId, clientId: { in: clientIds }, status: { in: ['DRAFT', 'OPEN'] }, endsOn: { gte: today } },
        include: { client: { select: { name: true } } },
        orderBy: { startsOn: 'asc' },
        take: 50,
      }),
      prisma.qualifyingLifeEvent.count({ where: { tenantId, status: 'PENDING', associate: people } }),
      prisma.cobraOffer.count({ where: { tenantId, status: 'NOTIFIED', electionDeadline: { gte: today }, associate: people } }),
    ]);
    const byPlan = new Map<string, { people: Set<string>; employeeCents: number }>();
    for (const e of enrollments) {
      const b = byPlan.get(e.planId) ?? { people: new Set<string>(), employeeCents: 0 };
      b.people.add(e.associateId);
      b.employeeCents += e.electedAmountCentsPerPeriod;
      byPlan.set(e.planId, b);
    }
    const planRows = plans.map((p) => {
      const b = byPlan.get(p.id);
      const enrolled = b?.people.size ?? 0;
      return {
        id: p.id,
        clientId: p.clientId,
        name: p.name,
        kind: p.kind,
        isActive: p.isActive,
        enrolled,
        // Per pay period, as elected — not converted to a month (pay schedules differ).
        employeeCentsPerPeriod: b?.employeeCents ?? 0,
        employerCentsPerPeriod: p.employerContributionCentsPerPeriod * enrolled,
      };
    });
    const byClient = clients
      .map((c) => {
        const mine = planRows.filter((p) => p.clientId === c.id);
        return { clientId: c.id, clientName: c.name, plans: mine };
      })
      .filter((c) => c.plans.length > 0);
    const enrolledPeople = new Set(enrollments.map((e) => e.associateId)).size;
    let carriers: Array<{ id: string; name: string; active: boolean; members: number; lastFile: { createdAt: string; mode: string; status: string; controlNumber: number; memberCount: number } | null }> | undefined;
    if (can(user, 'process:payroll')) {
      const [rows, files, carrierPlans] = await Promise.all([
        prisma.benefitCarrier.findMany({ where: { tenantId }, orderBy: { name: 'asc' } }),
        prisma.edi834File.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' }, distinct: ['carrierId'], select: { carrierId: true, createdAt: true, mode: true, status: true, controlNumber: true, memberCount: true } }),
        prisma.benefitsPlan.findMany({ where: { tenantId, carrierId: { not: null } }, select: { id: true, carrierId: true } }),
      ]);
      carriers = rows.map((c) => {
        const planIds = new Set(carrierPlans.filter((p) => p.carrierId === c.id).map((p) => p.id));
        const members = new Set(enrollments.filter((e) => planIds.has(e.planId)).map((e) => e.associateId)).size;
        const f = files.find((x) => x.carrierId === c.id);
        return { id: c.id, name: c.name, active: c.active, members, lastFile: f ? { createdAt: f.createdAt.toISOString(), mode: f.mode, status: f.status, controlNumber: f.controlNumber, memberCount: f.memberCount } : null };
      });
    }
    res.json({
      totals: {
        activePlans: plans.filter((p) => p.isActive).length,
        enrolledPeople,
        employeeCentsPerPeriod: planRows.reduce((t, p) => t + p.employeeCentsPerPeriod, 0),
        employerCentsPerPeriod: planRows.reduce((t, p) => t + p.employerCentsPerPeriod, 0),
        lifeEventsWaiting: qlesWaiting,
        cobraPending,
      },
      clients: byClient,
      openEnrollment: windows.map((w) => ({
        id: w.id,
        clientId: w.clientId,
        clientName: w.client.name,
        name: w.name,
        status: w.status,
        startsOn: dateColumnKey(w.startsOn),
        endsOn: dateColumnKey(w.endsOn),
        effectiveOn: dateColumnKey(w.effectiveOn),
      })),
      ...(carriers ? { carriers } : {}),
    });
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
        ...(input.allowsDeemedRoth !== undefined ? { allowsDeemedRoth: input.allowsDeemedRoth } : {}),
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
        ...(parsed.data.allowsDeemedRoth !== undefined ? { allowsDeemedRoth: parsed.data.allowsDeemedRoth } : {}),
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
  input: { planId: string; electedAmountCentsPerPeriod: number; effectiveDate: string; rothElection?: boolean; lifeCoverageCents?: number },
  selfService: boolean
): Promise<BenefitsEnrollment> {
  const plan = await prisma.benefitsPlan.findUnique({ where: { id: input.planId } });
  if (!plan) throw new HttpError(404, 'plan_not_found', 'Plan not found');
  if (!plan.isActive) {
    throw new HttpError(409, 'plan_inactive', 'This plan is no longer offered');
  }
  // Group-term life: the face amount is what payroll taxes over $50,000
  // (lib/groupTermLife), so a life election carries it and nothing else does.
  if (plan.kind === 'LIFE_INSURANCE' && input.lifeCoverageCents === undefined) {
    throw new HttpError(400, 'coverage_required', 'Enter the coverage amount. Payroll needs it to tax coverage over $50,000.');
  }
  if (plan.kind !== 'LIFE_INSURANCE' && input.lifeCoverageCents !== undefined) {
    throw new HttpError(400, 'coverage_not_life', 'A coverage amount goes with a life insurance plan only.');
  }
  // For self-service, the plan must belong to the associate's client.
  // (HR-side enrollment can override later when we add admin endpoints.)
  if (selfService) {
    // The same client GET /benefits/plans/mine offers plans from.
    const clientId = (await benefitsClientFor(associateId))?.clientId;
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
      // Roth applies to 401(k)/403(b) deferrals only.
      rothElection: input.rothElection === true && (plan.kind === 'RETIREMENT_401K' || plan.kind === 'RETIREMENT_403B'),
      lifeCoverageCents: plan.kind === 'LIFE_INSURANCE' ? (input.lifeCoverageCents ?? null) : null,
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
  allowsDeemedRoth?: boolean;
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
    allowsDeemedRoth: p.allowsDeemedRoth ?? true,
  };
}

function toEnrollment(e: {
  id: string;
  associateId: string;
  planId: string;
  electedAmountCentsPerPeriod: number;
  effectiveDate: Date;
  terminationDate: Date | null;
  rothElection?: boolean;
  lifeCoverageCents?: number | null;
  plan: { kind: string; name: string };
}): BenefitsEnrollment {
  return {
    id: e.id,
    associateId: e.associateId,
    planId: e.planId,
    electedAmountCentsPerPeriod: e.electedAmountCentsPerPeriod,
    effectiveDate: toDateOnly(e.effectiveDate) ?? '',
    terminationDate: toDateOnly(e.terminationDate),
    planKind: e.plan.kind as BenefitsEnrollment['planKind'],
    planName: e.plan.name,
    rothElection: e.rothElection ?? false,
    lifeCoverageCents: e.lifeCoverageCents ?? null,
  };
}
