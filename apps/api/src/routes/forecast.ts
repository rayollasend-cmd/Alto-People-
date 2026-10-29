import { Router } from 'express';
import { z } from 'zod';
import { ForecastPlanInputSchema, ForecastSignalInputSchema } from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { enqueueAudit } from '../lib/audit.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { computeForecastRun, forecastForSite, forecastSites, planFromForecast, scoreForecastAccuracy } from '../lib/forecast/run.js';
import { dateColumnKey } from '../lib/timezone.js';

/**
 * Labor-demand forecasting (Brief 3-4).
 *
 *   GET    /forecast/sites                every active site: the next four weeks and the accuracy so far   (view:org)
 *   GET    /forecast/sites/:locationId    26 weeks of band with drivers, the actuals behind, accuracy, signals
 *   POST   /forecast/runs                 compute now (scores past runs first)                              (manage:org)
 *   PUT    /forecast/signals              a client signal for a site-week (upsert by site, week, kind)      (manage:org)
 *   DELETE /forecast/signals/:id
 *   POST   /forecast/plan                 a season plan whose demand is the forecast                        (manage:org)
 */
export const forecastRouter = Router();

const VIEW = requireCapability('view:org');
const MANAGE = requireCapability('manage:org');
const Id = z.string().uuid();
const atUtc = (key: string) => new Date(`${key}T00:00:00.000Z`);

forecastRouter.get('/sites', VIEW, async (_req, res, next) => {
  try {
    res.json(await forecastSites(prisma));
  } catch (err) {
    next(err);
  }
});

forecastRouter.get('/sites/:locationId', VIEW, async (req, res, next) => {
  try {
    res.json(await forecastForSite(prisma, Id.parse(req.params.locationId)));
  } catch (err) {
    next(err);
  }
});

forecastRouter.post('/runs', MANAGE, async (req, res, next) => {
  try {
    const tenantId = tenantIdForWrite();
    const scored = await scoreForecastAccuracy(prisma, { tenantId });
    const run = await computeForecastRun(prisma, { tenantId, trigger: 'manual', createdById: req.user!.id });
    enqueueAudit(
      { actorUserId: req.user!.id, clientId: null, action: 'forecast.run', entityType: 'ForecastRun', entityId: run.runId, metadata: { sites: run.sites, weeks: run.weeks, mapePct: run.weights.mapePct, lastYearWeight: run.weights.lastYearWeight, scored: scored.scored } },
      'forecast',
    );
    res.status(201).json({ ...run, scored: scored.scored });
  } catch (err) {
    next(err);
  }
});

forecastRouter.put('/signals', MANAGE, async (req, res, next) => {
  try {
    const input = ForecastSignalInputSchema.parse(req.body);
    const tenantId = tenantIdForWrite();
    const site = await prisma.site.findFirst({ where: { id: input.locationId, tenantId, deletedAt: null }, select: { id: true } });
    if (!site) throw new HttpError(404, 'site_not_found', 'That site does not exist.');
    const row = await prisma.forecastSignal.upsert({
      where: { locationId_weekStart_kind: { locationId: input.locationId, weekStart: atUtc(input.weekStart), kind: input.kind } },
      create: { tenantId, locationId: input.locationId, weekStart: atUtc(input.weekStart), kind: input.kind, factor: input.factor, source: input.source ?? null, note: input.note ?? null, createdById: req.user!.id },
      update: { factor: input.factor, source: input.source ?? null, note: input.note ?? null },
      select: { id: true, weekStart: true, kind: true, factor: true, source: true, note: true },
    });
    enqueueAudit(
      { actorUserId: req.user!.id, clientId: null, action: 'forecast.signal_set', entityType: 'ForecastSignal', entityId: row.id, metadata: { locationId: input.locationId, weekStart: input.weekStart, kind: input.kind, factor: input.factor } },
      'forecast',
    );
    res.json({ signal: { ...row, weekStart: dateColumnKey(row.weekStart) } });
  } catch (err) {
    next(err);
  }
});

forecastRouter.delete('/signals/:id', MANAGE, async (req, res, next) => {
  try {
    const id = Id.parse(req.params.id);
    const tenantId = tenantIdForWrite();
    const gone = await prisma.forecastSignal.deleteMany({ where: { id, tenantId } });
    if (!gone.count) throw new HttpError(404, 'signal_not_found', 'That signal does not exist.');
    enqueueAudit({ actorUserId: req.user!.id, clientId: null, action: 'forecast.signal_removed', entityType: 'ForecastSignal', entityId: id, metadata: {} }, 'forecast');
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

forecastRouter.post('/plan', MANAGE, async (req, res, next) => {
  try {
    const input = ForecastPlanInputSchema.parse(req.body);
    const plan = await planFromForecast(prisma, input, req.user!.id);
    enqueueAudit(
      { actorUserId: req.user!.id, clientId: plan.clientId, action: 'season_plan.created', entityType: 'SeasonPlan', entityId: plan.id, metadata: { name: plan.name, sites: plan.sites.length, from: 'forecast' } },
      'forecast',
    );
    res.status(201).json(plan);
  } catch (err) {
    next(err);
  }
});
