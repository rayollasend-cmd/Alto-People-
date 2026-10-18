import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireCapability } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { scopeAssociates, scopeShifts } from '../lib/scope.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { equalizationReport, offerOvertime, rankForShift, respondToOffer } from '../lib/overtimeRotation.js';

/**
 * Overtime offered fewest-overtime-first (lib/overtimeRotation).
 *
 *   GET  /overtime-offers/shifts/:shiftId          who could take it, in turn
 *   POST /overtime-offers/shifts/:shiftId          offer it to someone (out of turn needs a reason)
 *   POST /overtime-offers/:id/respond              record their answer (manager)
 *   GET  /overtime-offers/report                   overtime and offers per person, last four weeks
 *   GET  /overtime-offers/mine                     a worker's open offers
 *   POST /overtime-offers/mine/:id/respond         a worker answers their own
 */
export const overtimeOffersRouter = Router();
const MANAGE = requireCapability('manage:scheduling');
const Id = z.string().uuid();

overtimeOffersRouter.get('/shifts/:shiftId', MANAGE, async (req, res) => {
  const out = await rankForShift(prisma, tenantIdForWrite(), Id.parse(req.params.shiftId), scopeShifts(req.user!));
  res.json({ shiftId: out.shift.id, open: out.shift.status === 'OPEN' && !out.shift.assignedAssociateId, enabled: out.enabled, candidates: out.candidates });
});

overtimeOffersRouter.post('/shifts/:shiftId', MANAGE, async (req, res) => {
  const body = z.object({ associateId: z.string().uuid(), overrideReason: z.string().max(500).nullable().optional() }).parse(req.body ?? {});
  const out = await offerOvertime(prisma, { tenantId: tenantIdForWrite(), actorUserId: req.user!.id, scope: scopeShifts(req.user!) }, { shiftId: Id.parse(req.params.shiftId), ...body });
  res.status(201).json({ shiftId: out.shift.id, enabled: out.enabled, candidates: out.candidates });
});

overtimeOffersRouter.post('/:id/respond', MANAGE, async (req, res) => {
  const { status } = z.object({ status: z.enum(['ACCEPTED', 'DECLINED']) }).parse(req.body ?? {});
  const id = Id.parse(req.params.id);
  // The offer's shift must be one this manager can see.
  const offer = await prisma.overtimeOffer.findFirst({ where: { id, tenantId: tenantIdForWrite(), shift: scopeShifts(req.user!) }, select: { id: true } });
  if (!offer) throw new HttpError(404, 'offer_not_found', 'Offer not found.');
  const row = await respondToOffer(prisma, { tenantId: tenantIdForWrite(), actorUserId: req.user!.id, asWorker: null }, id, status);
  res.json({ id: row.id, status: row.status });
});

overtimeOffersRouter.get('/report', MANAGE, async (req, res) => {
  const { weeks } = z.object({ weeks: z.coerce.number().int().min(1).max(13).optional() }).parse(req.query);
  res.json(await equalizationReport(prisma, tenantIdForWrite(), scopeAssociates(req.user!), weeks));
});

overtimeOffersRouter.get('/mine', async (req, res) => {
  const associateId = req.user?.associateId;
  if (!associateId) throw new HttpError(403, 'not_a_worker', 'Offers are for your own shifts.');
  const rows = await prisma.overtimeOffer.findMany({
    where: { associateId, tenantId: tenantIdForWrite(), status: 'OFFERED', shift: { startsAt: { gt: new Date() } } },
    orderBy: { offeredAt: 'desc' },
    take: 20,
    include: { shift: { select: { id: true, position: true, startsAt: true, endsAt: true, locationRel: { select: { name: true, timezone: true } } } } },
  });
  res.json({
    offers: rows.map((o) => ({ id: o.id, wouldAddOvertimeHours: Number(o.wouldAddOvertimeHours), offeredAt: o.offeredAt.toISOString(), shift: { id: o.shift.id, position: o.shift.position, startsAt: o.shift.startsAt.toISOString(), endsAt: o.shift.endsAt.toISOString(), siteName: o.shift.locationRel?.name ?? null, timezone: o.shift.locationRel?.timezone ?? null } })),
  });
});

overtimeOffersRouter.post('/mine/:id/respond', async (req, res) => {
  const associateId = req.user?.associateId;
  if (!associateId) throw new HttpError(403, 'not_a_worker', 'Offers are for your own shifts.');
  const { status } = z.object({ status: z.enum(['ACCEPTED', 'DECLINED']) }).parse(req.body ?? {});
  const row = await respondToOffer(prisma, { tenantId: tenantIdForWrite(), actorUserId: req.user!.id, asWorker: associateId }, Id.parse(req.params.id), status);
  res.json({ id: row.id, status: row.status });
});
