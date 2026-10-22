import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  ChecklistRunInputSchema,
  ChecklistTemplateInputSchema,
  CommissioningInputSchema,
  MaintenanceInputSchema,
  RobotIncidentInputSchema,
  RobotProfileInputSchema,
  RobotStopInputSchema,
  SafetyZoneInputSchema,
  ZoneOccupiedInputSchema,
} from '@alto-people/shared';
import { prisma } from '../db.js';
import { requireCapability } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import {
  addMaintenance,
  completeChecklist,
  createZone,
  emergencyStop,
  getIncident,
  getRobot,
  listChecklistRuns,
  listChecklistTemplates,
  listEvents,
  listIncidents,
  listMaintenance,
  listRobots,
  listSamples,
  listZones,
  reportIncident,
  resumeRobot,
  sampleRobots,
  setZoneOccupied,
  signOffCommissioning,
  startRobotShift,
  updateRobotProfile,
  updateZone,
  upsertChecklistTemplate,
  upsertCommissioning,
} from '../lib/robots.js';

/**
 * Brief 3-1 — /robots. Reads need view:org (the roster's own gate); the
 * fleet's own facts (profile, commissioning, checklist templates) need
 * manage:org; the floor's actions (checklists, zones, stop, resume, shift
 * start, incidents) need manage:scheduling so a crew lead can act without
 * holding the organization.
 */
export const robotsRouter = Router();

const VIEW = requireCapability('view:org');
const MANAGE = requireCapability('manage:org');
const FLOOR = requireCapability('manage:scheduling');

const Uuid = z.string().uuid();

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new HttpError(400, 'validation_error', r.error.issues.map((i) => i.message).join('; '), r.error.flatten());
  return r.data;
}

function idParam(req: Request, name = 'id'): string {
  const r = Uuid.safeParse(req.params[name]);
  if (!r.success) throw new HttpError(400, 'validation_error', `${name} must be a uuid`);
  return r.data;
}

type Handler = (req: Request, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

robotsRouter.get('/', VIEW, wrap(async (_req, res) => {
  res.json(await listRobots(prisma, tenantIdForWrite()));
}));

/** A sampling pass now, for a demo or a test; the minute job does the rest. */
robotsRouter.post('/sample', MANAGE, wrap(async (_req, res) => {
  res.json(await sampleRobots(prisma, tenantIdForWrite()));
}));

/* ---- checklist templates (tenant-wide or per site) ---- */

robotsRouter.get('/checklists/templates', VIEW, wrap(async (req, res) => {
  const locationId = typeof req.query.locationId === 'string' && Uuid.safeParse(req.query.locationId).success ? req.query.locationId : null;
  res.json({ templates: await listChecklistTemplates(prisma, locationId, tenantIdForWrite(), { all: req.query.all === '1' }) });
}));

robotsRouter.post('/checklists/templates', MANAGE, wrap(async (req, res) => {
  res.status(201).json(await upsertChecklistTemplate(prisma, parse(ChecklistTemplateInputSchema, req.body), tenantIdForWrite(), req.user!.id));
}));

robotsRouter.put('/checklists/templates/:id', MANAGE, wrap(async (req, res) => {
  res.json(await upsertChecklistTemplate(prisma, parse(ChecklistTemplateInputSchema, req.body), tenantIdForWrite(), req.user!.id, idParam(req)));
}));

/* ---- safety zones per site ---- */

robotsRouter.get('/sites/:locationId/zones', VIEW, wrap(async (req, res) => {
  res.json({ zones: await listZones(prisma, idParam(req, 'locationId'), tenantIdForWrite()) });
}));

robotsRouter.post('/sites/:locationId/zones', MANAGE, wrap(async (req, res) => {
  res.status(201).json(await createZone(prisma, idParam(req, 'locationId'), parse(SafetyZoneInputSchema, req.body), tenantIdForWrite(), req.user!.id));
}));

robotsRouter.patch('/zones/:id', MANAGE, wrap(async (req, res) => {
  res.json(await updateZone(prisma, idParam(req), parse(SafetyZoneInputSchema.partial(), req.body), req.user!.id));
}));

robotsRouter.post('/zones/:id/occupied', FLOOR, wrap(async (req, res) => {
  res.json(await setZoneOccupied(prisma, idParam(req), parse(ZoneOccupiedInputSchema, req.body).occupied, req.user!.id));
}));

/* ---- incidents by id ---- */

robotsRouter.get('/incidents/:id', VIEW, wrap(async (req, res) => {
  res.json(await getIncident(prisma, idParam(req)));
}));

/* ---- one robot ---- */

robotsRouter.get('/:id', VIEW, wrap(async (req, res) => {
  res.json(await getRobot(prisma, idParam(req)));
}));

robotsRouter.patch('/:id/profile', MANAGE, wrap(async (req, res) => {
  res.json(await updateRobotProfile(prisma, idParam(req), parse(RobotProfileInputSchema, req.body), req.user!.id));
}));

robotsRouter.get('/:id/samples', VIEW, wrap(async (req, res) => {
  const hours = Math.min(24 * 14, Math.max(1, Number(req.query.hours) || 24));
  res.json({ samples: await listSamples(prisma, idParam(req), hours) });
}));

robotsRouter.get('/:id/events', VIEW, wrap(async (req, res) => {
  res.json({ events: await listEvents(prisma, idParam(req)) });
}));

robotsRouter.post('/:id/stop', FLOOR, wrap(async (req, res) => {
  res.json(await emergencyStop(prisma, idParam(req), req.user!.id, parse(RobotStopInputSchema, req.body ?? {}).note ?? null));
}));

robotsRouter.post('/:id/resume', FLOOR, wrap(async (req, res) => {
  res.json(await resumeRobot(prisma, idParam(req), req.user!.id, parse(RobotStopInputSchema, req.body ?? {}).note ?? null));
}));

robotsRouter.post('/:id/shifts/:shiftId/start', FLOOR, wrap(async (req, res) => {
  res.json(await startRobotShift(prisma, idParam(req), idParam(req, 'shiftId'), req.user!.id));
}));

robotsRouter.get('/:id/checklists', VIEW, wrap(async (req, res) => {
  res.json({ runs: await listChecklistRuns(prisma, idParam(req)) });
}));

robotsRouter.post('/:id/checklists', FLOOR, wrap(async (req, res) => {
  res.status(201).json(await completeChecklist(prisma, idParam(req), parse(ChecklistRunInputSchema, req.body), req.user!.id));
}));

robotsRouter.put('/:id/commissioning', MANAGE, wrap(async (req, res) => {
  res.json(await upsertCommissioning(prisma, idParam(req), parse(CommissioningInputSchema, req.body), req.user!.id));
}));

robotsRouter.post('/:id/commissioning/:locationId/sign-off', FLOOR, wrap(async (req, res) => {
  res.json(await signOffCommissioning(prisma, idParam(req), idParam(req, 'locationId'), req.user!.id));
}));

robotsRouter.get('/:id/maintenance', VIEW, wrap(async (req, res) => {
  res.json({ maintenance: await listMaintenance(prisma, idParam(req)) });
}));

robotsRouter.post('/:id/maintenance', MANAGE, wrap(async (req, res) => {
  res.status(201).json(await addMaintenance(prisma, idParam(req), parse(MaintenanceInputSchema, req.body), req.user!.id));
}));

robotsRouter.get('/:id/incidents', VIEW, wrap(async (req, res) => {
  res.json({ incidents: await listIncidents(prisma, idParam(req)) });
}));

robotsRouter.post('/:id/incidents', FLOOR, wrap(async (req, res) => {
  res.status(201).json(await reportIncident(prisma, idParam(req), parse(RobotIncidentInputSchema, req.body), req.user!.id));
}));
