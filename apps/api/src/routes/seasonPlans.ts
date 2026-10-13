import { Router } from 'express';
import { z } from 'zod';
import { SeasonPlanInputSchema, SeasonPlanUpdateSchema } from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { enqueueAudit } from '../lib/audit.js';
import { createPlan, defaultDemandFor, duplicatePlan, getPlan, listPlans, planCsv, seasonWeeks, updatePlan } from '../lib/seasonPlanner.js';
import { renderSeasonPlanSitePdf } from '../lib/seasonPlanPdf.js';
import { getBrandingSync } from '../lib/branding.js';

/**
 * Season Planner (Brief 1C-3).
 *
 *   GET   /season-plans                        scenarios                     (view:org)
 *   POST  /season-plans                        new scenario                  (manage:org)
 *   GET   /season-plans/defaults?clientId&seasonStart&seasonEnd  the stores and their current targets as demand
 *   GET   /season-plans/compare?a&b            two scenarios, computed
 *   GET   /season-plans/:id                    one scenario, computed
 *   PATCH /season-plans/:id                    inputs, sites, archive
 *   POST  /season-plans/:id/duplicate          a copy to try something on
 *   GET   /season-plans/:id/csv                site × week rows
 *   GET   /season-plans/:id/sites/:locationId/pdf   the per-store plan
 */
export const seasonPlansRouter = Router();

const VIEW = requireCapability('view:org');
const MANAGE = requireCapability('manage:org');
const Id = z.string().uuid();
const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const slug = (s: string) => s.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();

seasonPlansRouter.get('/', VIEW, async (req, res, next) => {
  try {
    res.json({ plans: await listPlans(prisma, { includeArchived: req.query.archived === '1' }) });
  } catch (err) {
    next(err);
  }
});

seasonPlansRouter.get('/defaults', VIEW, async (req, res, next) => {
  try {
    const q = z.object({ clientId: Id.optional(), seasonStart: DateOnly, seasonEnd: DateOnly }).parse(req.query);
    if (q.seasonEnd < q.seasonStart) throw new HttpError(400, 'invalid_dates', 'seasonEnd must be on or after seasonStart');
    const weeks = seasonWeeks(q.seasonStart, q.seasonEnd);
    const locations = await prisma.site.findMany({
      where: { isActive: true, deletedAt: null, ...(q.clientId ? { clientId: q.clientId } : { client: { status: 'ACTIVE', deletedAt: null } }) },
      select: { id: true, name: true, clientId: true, client: { select: { name: true } } },
      orderBy: [{ client: { name: 'asc' } }, { name: 'asc' }],
      take: 60,
    });
    const demand = await defaultDemandFor(prisma, locations.map((l) => l.id), weeks);
    const vans = await prisma.van.aggregate({ where: { isActive: true }, _max: { capacity: true }, _count: { _all: true } });
    res.json({
      weeks,
      vans: { count: vans._count._all, maxCapacity: vans._max.capacity ?? 14 },
      // A season plan is per client site; a client-less site (a direct employer) waits for step 5's org unit.
      sites: locations.flatMap((l) => (l.clientId && l.client ? [{
        locationId: l.id,
        siteName: l.name,
        clientId: l.clientId,
        clientName: l.client.name,
        bedsAvailable: 0,
        vanSeatsPerRun: vans._max.capacity ?? 14,
        runsPerShift: 1,
        routeMinutes: 45,
        demand: demand.get(l.id) ?? [],
      }] : [])),
    });
  } catch (err) {
    next(err);
  }
});

seasonPlansRouter.get('/compare', VIEW, async (req, res, next) => {
  try {
    const q = z.object({ a: Id, b: Id }).parse(req.query);
    const [a, b] = await Promise.all([getPlan(prisma, q.a), getPlan(prisma, q.b)]);
    res.json({ a, b });
  } catch (err) {
    next(err);
  }
});

seasonPlansRouter.post('/', MANAGE, async (req, res, next) => {
  try {
    const input = SeasonPlanInputSchema.parse(req.body);
    const plan = await createPlan(prisma, input, req.user!.id);
    enqueueAudit(
      { actorUserId: req.user!.id, clientId: plan.clientId, action: 'season_plan.created', entityType: 'SeasonPlan', entityId: plan.id, metadata: { name: plan.name, sites: plan.sites.length } },
      'seasonPlans',
    );
    res.status(201).json(plan);
  } catch (err) {
    next(err);
  }
});

seasonPlansRouter.get('/:id', VIEW, async (req, res, next) => {
  try {
    res.json(await getPlan(prisma, Id.parse(req.params.id)));
  } catch (err) {
    next(err);
  }
});

seasonPlansRouter.patch('/:id', MANAGE, async (req, res, next) => {
  try {
    const id = Id.parse(req.params.id);
    const input = SeasonPlanUpdateSchema.parse(req.body);
    const plan = await updatePlan(prisma, id, input);
    enqueueAudit(
      { actorUserId: req.user!.id, clientId: plan.clientId, action: 'season_plan.updated', entityType: 'SeasonPlan', entityId: plan.id, metadata: { fields: Object.keys(input) } },
      'seasonPlans',
    );
    res.json(plan);
  } catch (err) {
    next(err);
  }
});

seasonPlansRouter.post('/:id/duplicate', MANAGE, async (req, res, next) => {
  try {
    const id = Id.parse(req.params.id);
    const { name } = z.object({ name: z.string().trim().min(2).max(120) }).parse(req.body);
    const plan = await duplicatePlan(prisma, id, name, req.user!.id);
    enqueueAudit(
      { actorUserId: req.user!.id, clientId: plan.clientId, action: 'season_plan.duplicated', entityType: 'SeasonPlan', entityId: plan.id, metadata: { from: id, name } },
      'seasonPlans',
    );
    res.status(201).json(plan);
  } catch (err) {
    next(err);
  }
});

seasonPlansRouter.get('/:id/csv', VIEW, async (req, res, next) => {
  try {
    const plan = await getPlan(prisma, Id.parse(req.params.id));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="season-plan-${slug(plan.name)}.csv"`);
    res.send(planCsv(plan));
  } catch (err) {
    next(err);
  }
});

seasonPlansRouter.get('/:id/sites/:locationId/pdf', VIEW, async (req, res, next) => {
  try {
    const plan = await getPlan(prisma, Id.parse(req.params.id));
    const site = plan.sites.find((s) => s.locationId === Id.parse(req.params.locationId));
    if (!site) throw new HttpError(404, 'site_not_in_plan', 'That store is not in this plan.');
    const pdf = await renderSeasonPlanSitePdf(plan, site, getBrandingSync().orgName);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="season-plan-${slug(site.siteName)}-${slug(plan.name)}.pdf"`);
    res.send(pdf);
  } catch (err) {
    next(err);
  }
});
