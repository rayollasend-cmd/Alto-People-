import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireCapability } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { scopeAssociates, scopeWhere } from '../lib/scope.js';
import { shiftTimezone } from '../lib/shiftZone.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { enqueueAudit } from '../lib/audit.js';
import { ATTESTATION_TEXT, CORRECTION_KINDS, breakQuestionsFor, decideCorrection, submitCorrection } from '../lib/timeCorrections.js';
import type { Prisma } from '@prisma/client';

/**
 * Punch corrections and break answers (lib/timeCorrections).
 *
 *   Worker (their own):
 *     GET  /time-corrections/mine              their requests, prompts to finish, recent shifts and places
 *     POST /time-corrections                   ask to fix a punch (attested)
 *     POST /time-corrections/:id/finish        finish one the kiosk prompted
 *     POST /time-corrections/:id/withdraw      take a waiting one back
 *     GET  /time-corrections/break-questions   what clock-out asks here (meal, rest)
 *   Approvers (manage:time, in reach):
 *     GET  /time-corrections                   waiting requests (or ?status=)
 *     POST /time-corrections/:id/decide        approve (applies the edit) or deny with a reason
 *     GET  /time-corrections/break-flags       missed breaks workers reported where the rules aren't paid live
 *     POST /time-corrections/break-flags/:id/ack
 */

export const timeCorrectionsRouter = Router();
const MANAGE = requireCapability('manage:time');
const Id = z.string().uuid();

const SubmitBody = z.object({
  kind: z.enum(CORRECTION_KINDS),
  timeEntryId: z.string().uuid().nullable().optional(),
  siteId: z.string().uuid().nullable().optional(),
  proposedClockIn: z.string().datetime({ offset: true }).nullable().optional(),
  proposedClockOut: z.string().datetime({ offset: true }).nullable().optional(),
  reason: z.string().max(1000),
  attested: z.boolean(),
});

function ownAssociate(req: { user?: { associateId?: string | null } }): string {
  const id = req.user?.associateId;
  if (!id) throw new HttpError(403, 'not_a_worker', 'Corrections are for your own time.');
  return id;
}

const shape = (r: Prisma.TimeCorrectionRequestGetPayload<{ include: { associate: { select: { firstName: true; lastName: true } } } }>, sites: SiteMap, names: Map<string, string>) => ({
  id: r.id,
  associateId: r.associateId,
  name: `${r.associate.firstName} ${r.associate.lastName}`.trim(),
  kind: r.kind,
  status: r.status,
  workDate: r.workDate?.toISOString().slice(0, 10) ?? null,
  siteName: r.siteId ? sites.get(r.siteId) ?? null : null,
  // The site's clock: the proposed punches are read the way the site reads them.
  timezone: r.siteId ? sites.zoneOf(r.siteId) : null,
  timeEntryId: r.timeEntryId,
  proposedClockIn: r.proposedClockIn?.toISOString() ?? null,
  proposedClockOut: r.proposedClockOut?.toISOString() ?? null,
  reason: r.reason,
  attestationText: r.attestationText,
  attestedAt: r.attestedAt?.toISOString() ?? null,
  before: r.before,
  after: r.after,
  decidedBy: r.decidedById ? names.get(r.decidedById) ?? null : null,
  decidedAt: r.decidedAt?.toISOString() ?? null,
  decisionReason: r.decisionReason,
  createdAt: r.createdAt.toISOString(),
});

/** Site names, and each site's zone (one punch, one time: lib/shiftZone). */
type SiteMap = Map<string, string> & { zoneOf: (id: string) => string | null };
async function siteNames(ids: Array<string | null>): Promise<SiteMap> {
  const want = [...new Set(ids.filter((x): x is string => !!x))];
  const rows = want.length ? await prisma.site.findMany({ where: { id: { in: want } }, select: { id: true, name: true, timezone: true } }) : [];
  const zones = new Map(rows.map((s) => [s.id, s.timezone]));
  return Object.assign(new Map(rows.map((s) => [s.id, s.name])), { zoneOf: (id: string) => (zones.has(id) ? shiftTimezone({ timezone: zones.get(id) ?? null }) : null) });
}
async function userNames(ids: Array<string | null>): Promise<Map<string, string>> {
  const want = [...new Set(ids.filter((x): x is string => !!x))];
  if (!want.length) return new Map();
  const users = await prisma.user.findMany({ where: { id: { in: want } }, select: { id: true, email: true, displayName: true, associate: { select: { firstName: true, lastName: true } } } });
  return new Map(users.map((u) => [u.id, u.associate ? `${u.associate.firstName} ${u.associate.lastName}` : u.displayName?.trim() || u.email]));
}

/* ----- The worker -------------------------------------------------------------- */

timeCorrectionsRouter.get('/mine', async (req, res) => {
  const associateId = ownAssociate(req);
  const since = new Date(Date.now() - 21 * 86_400_000);
  const [rows, entries, placements] = await Promise.all([
    prisma.timeCorrectionRequest.findMany({ where: { associateId }, orderBy: { createdAt: 'desc' }, take: 50, include: { associate: { select: { firstName: true, lastName: true } } } }),
    prisma.timeEntry.findMany({ where: { associateId, clockInAt: { gte: since } }, orderBy: { clockInAt: 'desc' }, take: 40, select: { id: true, clockInAt: true, clockOutAt: true, status: true, locationId: true } }),
    prisma.associateAssignment.findMany({ where: { associateId, endedAt: null }, select: { locationId: true } }),
  ]);
  const sites = await siteNames([...rows.map((r) => r.siteId), ...entries.map((e) => e.locationId), ...placements.map((p) => p.locationId)]);
  const names = await userNames(rows.map((r) => r.decidedById));
  res.json({
    attestation: ATTESTATION_TEXT,
    requests: rows.map((r) => shape(r, sites, names)),
    entries: entries.map((e) => ({ id: e.id, clockInAt: e.clockInAt.toISOString(), clockOutAt: e.clockOutAt?.toISOString() ?? null, status: e.status, siteName: e.locationId ? sites.get(e.locationId) ?? null : null, timezone: e.locationId ? sites.zoneOf(e.locationId) : null })),
    sites: placements.map((p) => ({ id: p.locationId, name: sites.get(p.locationId) ?? 'Site' })),
  });
});

timeCorrectionsRouter.post('/', async (req, res) => {
  const associateId = ownAssociate(req);
  const row = await submitCorrection(prisma, { tenantId: tenantIdForWrite(), associateId, userId: req.user!.id, ip: req.ip, ua: req.get('user-agent') ?? null }, SubmitBody.parse(req.body ?? {}));
  res.status(201).json({ id: row.id, status: row.status });
});

timeCorrectionsRouter.post('/:id/finish', async (req, res) => {
  const associateId = ownAssociate(req);
  const id = Id.parse(req.params.id);
  const prompted = await prisma.timeCorrectionRequest.findFirst({ where: { id, associateId, status: 'PROMPTED' }, select: { id: true, timeEntryId: true } });
  if (!prompted) throw new HttpError(404, 'prompt_not_found', 'Nothing to finish here.');
  const body = SubmitBody.parse({ ...req.body, kind: 'MISSED_CLOCK_OUT', timeEntryId: prompted.timeEntryId });
  const row = await submitCorrection(prisma, { tenantId: tenantIdForWrite(), associateId, userId: req.user!.id, ip: req.ip, ua: req.get('user-agent') ?? null }, body, prompted.id);
  res.json({ id: row.id, status: row.status });
});

timeCorrectionsRouter.post('/:id/withdraw', async (req, res) => {
  const associateId = ownAssociate(req);
  const id = Id.parse(req.params.id);
  const n = await prisma.timeCorrectionRequest.updateMany({ where: { id, associateId, status: { in: ['SUBMITTED', 'PROMPTED'] } }, data: { status: 'WITHDRAWN' } });
  if (!n.count) throw new HttpError(409, 'not_waiting', 'This one isn’t waiting any more.');
  enqueueAudit({ actorUserId: req.user!.id, clientId: null, action: 'time.correction_withdrawn', entityType: 'TimeCorrectionRequest', entityId: id, metadata: {} }, 'timeCorrections');
  res.json({ id, status: 'WITHDRAWN' });
});

timeCorrectionsRouter.get('/break-questions', async (req, res) => {
  const associateId = ownAssociate(req);
  const active = await prisma.timeEntry.findFirst({ where: { associateId, status: 'ACTIVE' }, select: { clockInAt: true, locationId: true, associate: { select: { state: true } } } });
  if (!active) {
    res.json({ meal: false, rest: false, mealAfterHours: null });
    return;
  }
  const site = active.locationId ? await prisma.site.findFirst({ where: { id: active.locationId }, select: { state: true } }) : null;
  const q = breakQuestionsFor(site?.state ?? active.associate.state);
  // Asked only when the shift is long enough for the law to require the meal.
  const workedHours = (Date.now() - active.clockInAt.getTime()) / 3_600_000;
  res.json({ meal: q.meal && q.mealAfterHours !== null && workedHours > q.mealAfterHours, rest: q.rest, mealAfterHours: q.mealAfterHours });
});

/* ----- Approvers ---------------------------------------------------------------- */

timeCorrectionsRouter.get('/', MANAGE, async (req, res) => {
  const q = z.object({ status: z.enum(['SUBMITTED', 'APPROVED', 'DENIED', 'WITHDRAWN', 'PROMPTED']).optional() }).parse(req.query);
  const where: Prisma.TimeCorrectionRequestWhereInput = scopeWhere<Prisma.TimeCorrectionRequestWhereInput>(
    { tenantId: tenantIdForWrite(), status: q.status ?? 'SUBMITTED' },
    { associate: scopeAssociates(req.user!) },
  );
  const rows = await prisma.timeCorrectionRequest.findMany({ where, orderBy: { createdAt: q.status && q.status !== 'SUBMITTED' ? 'desc' : 'asc' }, take: 201, include: { associate: { select: { firstName: true, lastName: true } } } });
  const sites = await siteNames(rows.map((r) => r.siteId));
  const names = await userNames(rows.map((r) => r.decidedById));
  res.json({ truncated: rows.length > 200, requests: rows.slice(0, 200).map((r) => shape(r, sites, names)) });
});

timeCorrectionsRouter.post('/:id/decide', MANAGE, async (req, res) => {
  const body = z.object({ decision: z.enum(['APPROVE', 'DENY']), reason: z.string().max(1000).nullable().optional() }).parse(req.body ?? {});
  const row = await decideCorrection(prisma, Id.parse(req.params.id), { id: req.user!.id, associateId: req.user!.associateId ?? null }, body, scopeWhere<Prisma.AssociateWhereInput>({ tenantId: tenantIdForWrite() }, scopeAssociates(req.user!)));
  res.json({ id: row.id, status: row.status });
});

timeCorrectionsRouter.get('/break-flags', MANAGE, async (req, res) => {
  const rows = await prisma.breakAttestation.findMany({
    where: scopeWhere<Prisma.BreakAttestationWhereInput>({ tenantId: tenantIdForWrite(), flagged: true }, { associate: scopeAssociates(req.user!) }),
    orderBy: { createdAt: 'desc' },
    take: 101,
    include: { associate: { select: { firstName: true, lastName: true } } },
  });
  const entries = new Map((await prisma.timeEntry.findMany({ where: { id: { in: rows.map((r) => r.timeEntryId) } }, select: { id: true, clockInAt: true, clockOutAt: true, locationId: true } })).map((e) => [e.id, e]));
  const sites = await siteNames([...entries.values()].map((e) => e.locationId));
  res.json({
    truncated: rows.length > 100,
    flags: rows.slice(0, 100).map((r) => {
      const e = entries.get(r.timeEntryId);
      return { id: r.id, associateId: r.associateId, name: `${r.associate.firstName} ${r.associate.lastName}`.trim(), meal: r.meal, rest: r.rest, note: r.note, clockInAt: e?.clockInAt.toISOString() ?? null, clockOutAt: e?.clockOutAt?.toISOString() ?? null, siteName: e?.locationId ? sites.get(e.locationId) ?? null : null, timezone: e?.locationId ? sites.zoneOf(e.locationId) : null, createdAt: r.createdAt.toISOString() };
    }),
  });
});

timeCorrectionsRouter.post('/break-flags/:id/ack', MANAGE, async (req, res) => {
  const id = Id.parse(req.params.id);
  const n = await prisma.breakAttestation.updateMany({ where: scopeWhere<Prisma.BreakAttestationWhereInput>({ id, tenantId: tenantIdForWrite() }, { associate: scopeAssociates(req.user!) }), data: { flagged: false } });
  if (!n.count) throw new HttpError(404, 'flag_not_found', 'Not found.');
  enqueueAudit({ actorUserId: req.user!.id, clientId: null, action: 'time.break_flag_acknowledged', entityType: 'BreakAttestation', entityId: id, metadata: {} }, 'timeCorrections');
  res.status(204).end();
});
