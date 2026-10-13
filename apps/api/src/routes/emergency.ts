import { Router } from 'express';
import { tenantIdForWrite } from '../lib/tenant.js';
import { z } from 'zod';
import { EmergencyCheckInInputSchema, EmergencyDeclareInputSchema } from '@alto-people/shared';
import { prisma } from '../db.js';
import { requireAuth, requireCapability } from '../middleware/auth.js';
import {
  checkIn,
  declareEmergency,
  emergencyBoard,
  emergencySites,
  listEmergencies,
  myEmergency,
  standDownEmergency,
} from '../lib/emergency.js';

/**
 * Emergency Mode (Brief 1C-1).
 *
 *   GET  /emergency/me                 the associate's active emergency + their check-in
 *   POST /emergency/:id/check-in       "I'm safe" / "I need help", optionally a van seat
 *   GET  /emergency                    history, newest first            (view:emergency)
 *   GET  /emergency/sites              every active store, for the scope picker (manage:emergency)
 *   GET  /emergency/:id/board          responded / not, by site, with the escalation list (view:emergency)
 *   POST /emergency                    declare                          (manage:emergency)
 *   POST /emergency/:id/stand-down     restore the schedule             (manage:emergency)
 */
export const emergencyRouter = Router();

const VIEW = requireCapability('view:emergency');
const MANAGE = requireCapability('manage:emergency');
const Id = z.string().uuid();

emergencyRouter.get('/me', requireAuth, async (req, res, next) => {
  try {
    const u = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { id: true, associateId: true, language: true } });
    res.json(await myEmergency(prisma, u ?? { id: req.user!.id, associateId: req.user!.associateId, language: null }));
  } catch (err) {
    next(err);
  }
});

emergencyRouter.post('/:id/check-in', requireAuth, async (req, res, next) => {
  try {
    const id = Id.parse(req.params.id);
    const input = EmergencyCheckInInputSchema.parse(req.body);
    res.json(await checkIn(prisma, id, { id: req.user!.id, associateId: req.user!.associateId }, input));
  } catch (err) {
    next(err);
  }
});

emergencyRouter.get('/', VIEW, async (_req, res, next) => {
  try {
    res.json({ emergencies: await listEmergencies(prisma) });
  } catch (err) {
    next(err);
  }
});

emergencyRouter.get('/sites', MANAGE, async (_req, res, next) => {
  try {
    // Explicit tenant (Brief 2-1, cross-tenant suite): the guard only observes until enforce mode.
    res.json({ sites: await emergencySites(prisma, { tenantId: tenantIdForWrite() }) });
  } catch (err) {
    next(err);
  }
});

emergencyRouter.get('/:id/board', VIEW, async (req, res, next) => {
  try {
    const id = Id.parse(req.params.id);
    res.json(await emergencyBoard(prisma, id, { role: req.user!.role, clientId: req.user!.clientId }));
  } catch (err) {
    next(err);
  }
});

emergencyRouter.post('/', MANAGE, async (req, res, next) => {
  try {
    const input = EmergencyDeclareInputSchema.parse(req.body);
    const summary = await declareEmergency(prisma, input, {
      actorUserId: req.user!.id,
      ip: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });
    res.status(201).json(summary);
  } catch (err) {
    next(err);
  }
});

emergencyRouter.post('/:id/stand-down', MANAGE, async (req, res, next) => {
  try {
    const id = Id.parse(req.params.id);
    const summary = await standDownEmergency(prisma, id, {
      actorUserId: req.user!.id,
      ip: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });
    res.json(summary);
  } catch (err) {
    next(err);
  }
});
