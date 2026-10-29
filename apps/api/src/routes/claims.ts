import { Router, type Request } from 'express';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { enqueueAudit } from '../lib/audit.js';
import { notifyAssociate } from '../lib/notify.js';
import { assertAssociateInScope, internalSites, scopeAssociatesIncludingFormer, scopeWhere } from '../lib/scope.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { safeContentDisposition } from '../lib/uploads.js';
import { fmtDay } from '../lib/claimsPdf.js';
import { leaveSettings } from '../lib/leaveOfAbsence.js';
import { orgDateKey } from '../lib/timeAnomalies.js';
import { assembleEvidence, estimatedSuiImpact, finalOutcome, responsePacketPdf } from '../lib/unemploymentClaims.js';
import { froiPdf, froiWindowDays, modifiedDutyMatches, prefillFroi, syncOshaFromClaim, type FroiFields, type RestrictionRules } from '../lib/workersComp.js';

/**
 * Claims (manage:claims — HR only; these carry medical facts and the
 * employer's case against a former worker).
 *
 *   /claims/unemployment/*   intake from the state notice, the evidence
 *                            packet, contest / don't contest, hearings,
 *                            appeals, charges, the estimated tax impact.
 *   /claims/work-offers/*    offers of suitable work (recorded with or
 *                            without a claim — they decide many claims).
 *   /claims/workers-comp/*   from an OSHA incident to the FROI, the carrier,
 *                            lost/restricted days (synced to the OSHA log),
 *                            restrictions and modified-duty offers.
 *
 * Every list is the tenant's and inside the caller's reach; claims are about
 * people who may have left, so reach includes former workers.
 */

export const claimsRouter = Router();

const MANAGE = requireCapability('manage:claims');
const DAY_MS = 86_400_000;
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
// The company's day (CODE-14): after 5 PM Pacific the UTC date is already tomorrow.
const todayUtc = () => day(orgDateKey(new Date()));
const money = (d: Prisma.Decimal | null) => (d === null ? null : Number(d));
// CODE-24: a page number is a whole number in a range Prisma's skip can hold — `?page=1e9` is a 400, not a 500.
const PageParam = z.coerce.number().int().min(1).max(100_000).default(1);

const inReach = (req: Request): Prisma.AssociateWhereInput => ({ AND: [{ tenantId: tenantIdForWrite() }, scopeAssociatesIncludingFormer(req.user!)] });

/* ===== Unemployment ======================================================== */

const UI_INCLUDE = {
  associate: { select: { id: true, firstName: true, lastName: true, ssnLast4: true } },
  client: { select: { id: true, name: true } },
} satisfies Prisma.UnemploymentClaimInclude;
type UiRow = Prisma.UnemploymentClaimGetPayload<{ include: typeof UI_INCLUDE }>;

function uiNext(c: UiRow, now: Date) {
  const due = (d: Date | null) => (d ? { dueAt: fmtDay(d), overdue: d.getTime() < now.getTime() - DAY_MS } : { dueAt: null, overdue: false });
  if (c.status === 'NEW') return { key: 'respond', label: 'Respond to the state', ...due(c.responseDueAt) };
  if (c.status === 'HEARING_SCHEDULED' && c.hearingAt) return { key: 'hearing', label: 'Prepare for the hearing', ...due(c.hearingAt) };
  if (c.status === 'RESPONDED') return { key: 'determination', label: 'Waiting on the state’s determination', dueAt: null, overdue: false };
  return null;
}

function uiView(c: UiRow, now = new Date()) {
  return {
    id: c.id,
    associateId: c.associateId,
    associateName: `${c.associate.firstName} ${c.associate.lastName}`,
    clientId: c.clientId,
    clientName: c.client?.name ?? null,
    separationId: c.separationId,
    state: c.state,
    claimDate: fmtDay(c.claimDate),
    noticeReceivedAt: fmtDay(c.noticeReceivedAt),
    responseDueAt: fmtDay(c.responseDueAt),
    stateClaimNumber: c.stateClaimNumber,
    status: c.status,
    decision: c.decision,
    decisionReason: c.decisionReason,
    respondedAt: c.respondedAt?.toISOString() ?? null,
    determination: c.determination,
    determinationAt: c.determinationAt ? fmtDay(c.determinationAt) : null,
    chargesAmount: money(c.chargesAmount),
    hearingAt: c.hearingAt?.toISOString() ?? null,
    hearingOutcome: c.hearingOutcome,
    appealFiledAt: c.appealFiledAt ? fmtDay(c.appealFiledAt) : null,
    appealOutcome: c.appealOutcome,
    outcome: finalOutcome(c),
    notes: c.notes,
    next: uiNext(c, now),
    createdAt: c.createdAt.toISOString(),
  };
}

async function loadUi(req: Request, id: string): Promise<UiRow> {
  const c = await prisma.unemploymentClaim.findFirst({ where: { id, tenantId: tenantIdForWrite(), associate: inReach(req) }, include: UI_INCLUDE });
  if (!c) throw new HttpError(404, 'claim_not_found', 'Claim not found.');
  return c;
}

claimsRouter.get('/claims/unemployment/summary', MANAGE, async (req, res) => {
  const t = todayUtc();
  const base: Prisma.UnemploymentClaimWhereInput = { tenantId: tenantIdForWrite(), associate: inReach(req) };
  const [all, settings] = await Promise.all([
    prisma.unemploymentClaim.findMany({
      where: { ...base, claimDate: { gte: new Date(t.getTime() - 3 * 365 * DAY_MS) } },
      select: { status: true, decision: true, responseDueAt: true, hearingAt: true, determination: true, hearingOutcome: true, appealOutcome: true, chargesAmount: true, clientId: true, client: { select: { name: true } } },
    }),
    leaveSettings(),
  ]);
  const open = all.filter((c) => c.status !== 'CLOSED' && finalOutcome(c) === null);
  const responsesDue = all.filter((c) => c.status === 'NEW');
  const dueThisWeek = responsesDue.filter((c) => c.responseDueAt.getTime() <= t.getTime() + 7 * DAY_MS).length;
  const overdue = responsesDue.filter((c) => c.responseDueAt.getTime() < t.getTime()).length;
  const contestedDecided = all.filter((c) => c.decision === 'CONTEST' && finalOutcome(c) !== null);
  const won = contestedDecided.filter((c) => finalOutcome(c) === 'DENIED').length;
  const byClient = new Map<string, { clientId: string | null; clientName: string; claims: number; allowed: number; charges: number }>();
  for (const c of all) {
    const key = c.clientId ?? 'none';
    const row = byClient.get(key) ?? { clientId: c.clientId, clientName: c.client?.name ?? 'No client', claims: 0, allowed: 0, charges: 0 };
    row.claims += 1;
    if (finalOutcome(c) === 'ALLOWED') {
      row.allowed += 1;
      row.charges += Number(c.chargesAmount ?? 0);
    }
    byClient.set(key, row);
  }
  const factor = Number(settings.suiImpactFactor);
  res.json({
    open: open.length,
    responsesDueThisWeek: dueThisWeek,
    overdue,
    hearingsNext14Days: all.filter((c) => c.hearingAt && c.hearingAt.getTime() >= t.getTime() && c.hearingAt.getTime() <= t.getTime() + 14 * DAY_MS).length,
    contestedDecided: contestedDecided.length,
    winRate: contestedDecided.length ? Math.round((won / contestedDecided.length) * 100) : null,
    estimatedSuiImpact: estimatedSuiImpact(all, factor),
    suiImpactFactor: factor,
    byClient: [...byClient.values()].sort((a, b) => b.claims - a.claims),
  });
});

const UiListQuery = z.object({
  status: z.enum(['open', 'all', 'NEW', 'RESPONDED', 'DETERMINED', 'HEARING_SCHEDULED', 'APPEALED', 'CLOSED']).default('open'),
  q: z.string().trim().max(100).optional(),
  page: PageParam,
});

claimsRouter.get('/claims/unemployment', MANAGE, async (req, res) => {
  const q = UiListQuery.parse(req.query);
  const where = scopeWhere<Prisma.UnemploymentClaimWhereInput>(
    { tenantId: tenantIdForWrite() },
    { associate: inReach(req) },
    q.status === 'open' ? { status: { not: 'CLOSED' } } : q.status === 'all' ? null : { status: q.status },
    q.q ? { associate: { OR: [{ firstName: { contains: q.q, mode: 'insensitive' } }, { lastName: { contains: q.q, mode: 'insensitive' } }] } } : null,
  );
  const PAGE = 50;
  const [rows, total] = await Promise.all([
    prisma.unemploymentClaim.findMany({ where, include: UI_INCLUDE, orderBy: [{ responseDueAt: 'asc' }], skip: (q.page - 1) * PAGE, take: PAGE }),
    prisma.unemploymentClaim.count({ where }),
  ]);
  res.json({ claims: rows.map((r) => uiView(r)), total, page: q.page, pageSize: PAGE, hasMore: q.page * PAGE < total });
});

const UiCreate = z.object({
  associateId: z.string().uuid(),
  state: z.string().trim().length(2).toUpperCase(),
  claimDate: dateOnly,
  noticeReceivedAt: dateOnly,
  responseDueAt: dateOnly.optional(),
  stateClaimNumber: z.string().trim().max(60).nullable().optional(),
  notes: z.string().trim().max(4000).nullable().optional(),
});

claimsRouter.post('/claims/unemployment', MANAGE, async (req, res) => {
  const input = UiCreate.parse(req.body ?? {});
  await assertAssociateInScope(prisma, req.user!, input.associateId, { former: true });
  const settings = await leaveSettings();
  const [separation, lastAssignment] = await Promise.all([
    prisma.separation.findFirst({ where: { associateId: input.associateId }, orderBy: { lastDayWorked: 'desc' }, select: { id: true } }),
    prisma.associateAssignment.findFirst({ where: { associateId: input.associateId }, orderBy: { startedAt: 'desc' }, select: { location: { select: { clientId: true } } } }),
  ]);
  const notice = day(input.noticeReceivedAt);
  const created = await prisma.unemploymentClaim.create({
    data: {
      tenantId: tenantIdForWrite(),
      associateId: input.associateId,
      separationId: separation?.id ?? null,
      clientId: lastAssignment?.location.clientId ?? null,
      state: input.state,
      claimDate: day(input.claimDate),
      noticeReceivedAt: notice,
      responseDueAt: input.responseDueAt ? day(input.responseDueAt) : new Date(notice.getTime() + settings.uiResponseDays * DAY_MS),
      stateClaimNumber: input.stateClaimNumber ?? null,
      notes: input.notes ?? null,
      createdById: req.user!.id,
    },
    include: UI_INCLUDE,
  });
  enqueueAudit({ actorUserId: req.user!.id, action: 'ui_claim.opened', entityType: 'UnemploymentClaim', entityId: created.id, metadata: { associateId: input.associateId, state: input.state } }, 'claims');
  res.status(201).json({ claim: uiView(created) });
});

claimsRouter.get('/claims/unemployment/:id', MANAGE, async (req, res) => {
  const c = await loadUi(req, z.string().uuid().parse(req.params.id));
  const evidence = await assembleEvidence(c);
  res.json({ claim: uiView(c), evidence });
});

claimsRouter.post('/claims/unemployment/:id/respond', MANAGE, async (req, res) => {
  const input = z.object({ decision: z.enum(['CONTEST', 'DO_NOT_CONTEST']), reason: z.string().trim().min(3).max(2000) }).parse(req.body ?? {});
  const c = await loadUi(req, z.string().uuid().parse(req.params.id));
  if (c.status !== 'NEW') throw new HttpError(409, 'already_responded', 'The response has already been recorded.');
  const updated = await prisma.unemploymentClaim.update({
    where: { id: c.id },
    data: { decision: input.decision, decisionReason: input.reason, status: 'RESPONDED', respondedAt: new Date(), respondedById: req.user!.id },
    include: UI_INCLUDE,
  });
  enqueueAudit({ actorUserId: req.user!.id, action: 'ui_claim.responded', entityType: 'UnemploymentClaim', entityId: c.id, metadata: { decision: input.decision } }, 'claims');
  res.json({ claim: uiView(updated) });
});

const UiPatch = z.object({
  determination: z.enum(['ALLOWED', 'DENIED']).nullable().optional(),
  determinationAt: dateOnly.nullable().optional(),
  chargesAmount: z.number().min(0).max(1_000_000).nullable().optional(),
  hearingAt: z.string().datetime().nullable().optional(),
  hearingOutcome: z.enum(['ALLOWED', 'DENIED']).nullable().optional(),
  appealFiledAt: dateOnly.nullable().optional(),
  appealOutcome: z.enum(['ALLOWED', 'DENIED']).nullable().optional(),
  stateClaimNumber: z.string().trim().max(60).nullable().optional(),
  responseDueAt: dateOnly.optional(),
  notes: z.string().trim().max(4000).nullable().optional(),
  close: z.boolean().optional(),
});

claimsRouter.patch('/claims/unemployment/:id', MANAGE, async (req, res) => {
  const input = UiPatch.parse(req.body ?? {});
  const c = await loadUi(req, z.string().uuid().parse(req.params.id));
  const data: Prisma.UnemploymentClaimUpdateInput = {};
  if (input.determination !== undefined) data.determination = input.determination;
  if (input.determinationAt !== undefined) data.determinationAt = input.determinationAt ? day(input.determinationAt) : null;
  if (input.chargesAmount !== undefined) data.chargesAmount = input.chargesAmount;
  if (input.hearingAt !== undefined) data.hearingAt = input.hearingAt ? new Date(input.hearingAt) : null;
  if (input.hearingOutcome !== undefined) data.hearingOutcome = input.hearingOutcome;
  if (input.appealFiledAt !== undefined) data.appealFiledAt = input.appealFiledAt ? day(input.appealFiledAt) : null;
  if (input.appealOutcome !== undefined) data.appealOutcome = input.appealOutcome;
  if (input.stateClaimNumber !== undefined) data.stateClaimNumber = input.stateClaimNumber;
  if (input.responseDueAt !== undefined) data.responseDueAt = day(input.responseDueAt);
  if (input.notes !== undefined) data.notes = input.notes;
  // The status follows the newest fact recorded.
  const next = { ...c, ...input } as UiRow & typeof input;
  if (input.close) data.status = 'CLOSED';
  else if (next.appealFiledAt && !next.appealOutcome) data.status = 'APPEALED';
  else if (next.hearingAt && !next.hearingOutcome && !next.appealOutcome) data.status = 'HEARING_SCHEDULED';
  else if (next.determination || next.hearingOutcome || next.appealOutcome) data.status = 'DETERMINED';
  const updated = await prisma.unemploymentClaim.update({ where: { id: c.id }, data, include: UI_INCLUDE });
  enqueueAudit({ actorUserId: req.user!.id, action: 'ui_claim.updated', entityType: 'UnemploymentClaim', entityId: c.id, metadata: input }, 'claims');
  res.json({ claim: uiView(updated) });
});

claimsRouter.get('/claims/unemployment/:id/packet.pdf', MANAGE, async (req, res) => {
  const c = await loadUi(req, z.string().uuid().parse(req.params.id));
  const pdf = await responsePacketPdf(c, await assembleEvidence(c));
  enqueueAudit({ actorUserId: req.user!.id, action: 'ui_claim.packet_downloaded', entityType: 'UnemploymentClaim', entityId: c.id, metadata: {} }, 'claims');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', safeContentDisposition(`ui-response-${c.state}-${fmtDay(c.claimDate)}.pdf`, true));
  res.send(pdf);
});

/* ===== Offers of suitable work ============================================ */

const OfferCreate = z.object({
  associateId: z.string().uuid(),
  claimId: z.string().uuid().nullable().optional(),
  offeredAt: z.string().datetime(),
  description: z.string().trim().min(3).max(1000),
  clientId: z.string().uuid().nullable().optional(),
  locationId: z.string().uuid().nullable().optional(),
  payRate: z.number().min(0).max(1000).nullable().optional(),
  response: z.enum(['PENDING', 'ACCEPTED', 'DECLINED', 'NO_RESPONSE']).optional(),
  declineReason: z.string().trim().max(1000).nullable().optional(),
});

function offerView(o: Prisma.WorkOfferGetPayload<object>) {
  return {
    id: o.id,
    associateId: o.associateId,
    claimId: o.claimId,
    offeredAt: o.offeredAt.toISOString(),
    description: o.description,
    payRate: money(o.payRate),
    response: o.response,
    respondedAt: o.respondedAt?.toISOString() ?? null,
    declineReason: o.declineReason,
  };
}

claimsRouter.get('/claims/work-offers', MANAGE, async (req, res) => {
  const associateId = z.string().uuid().parse(req.query.associateId);
  await assertAssociateInScope(prisma, req.user!, associateId, { former: true });
  const rows = await prisma.workOffer.findMany({ where: { tenantId: tenantIdForWrite(), associateId }, orderBy: { offeredAt: 'desc' }, take: 200 });
  res.json({ offers: rows.map(offerView) });
});

claimsRouter.post('/claims/work-offers', MANAGE, async (req, res) => {
  const input = OfferCreate.parse(req.body ?? {});
  await assertAssociateInScope(prisma, req.user!, input.associateId, { former: true });
  if (input.claimId) await loadUi(req, input.claimId);
  if (input.response === 'DECLINED' && !input.declineReason) throw new HttpError(400, 'reason_required', 'Note why they declined — it is the evidence.');
  const created = await prisma.workOffer.create({
    data: {
      tenantId: tenantIdForWrite(),
      associateId: input.associateId,
      claimId: input.claimId ?? null,
      offeredAt: new Date(input.offeredAt),
      offeredById: req.user!.id,
      description: input.description,
      clientId: input.clientId ?? null,
      locationId: input.locationId ?? null,
      payRate: input.payRate ?? null,
      response: input.response ?? 'PENDING',
      respondedAt: input.response && input.response !== 'PENDING' ? new Date() : null,
      declineReason: input.declineReason ?? null,
    },
  });
  enqueueAudit({ actorUserId: req.user!.id, action: 'work_offer.recorded', entityType: 'WorkOffer', entityId: created.id, metadata: { associateId: input.associateId, response: created.response } }, 'claims');
  res.status(201).json({ offer: offerView(created) });
});

claimsRouter.patch('/claims/work-offers/:id', MANAGE, async (req, res) => {
  const input = z.object({ response: z.enum(['PENDING', 'ACCEPTED', 'DECLINED', 'NO_RESPONSE']), declineReason: z.string().trim().max(1000).nullable().optional() }).parse(req.body ?? {});
  const o = await prisma.workOffer.findFirst({ where: { id: z.string().uuid().parse(req.params.id), tenantId: tenantIdForWrite(), associate: inReach(req) } });
  if (!o) throw new HttpError(404, 'offer_not_found', 'Offer not found.');
  if (input.response === 'DECLINED' && !(input.declineReason ?? o.declineReason)) throw new HttpError(400, 'reason_required', 'Note why they declined — it is the evidence.');
  const updated = await prisma.workOffer.update({
    where: { id: o.id },
    data: { response: input.response, declineReason: input.declineReason ?? o.declineReason, respondedAt: input.response === 'PENDING' ? null : new Date() },
  });
  enqueueAudit({ actorUserId: req.user!.id, action: 'work_offer.answered', entityType: 'WorkOffer', entityId: o.id, metadata: { response: input.response } }, 'claims');
  res.json({ offer: offerView(updated) });
});

/* ===== Workers' comp ======================================================== */

const WC_INCLUDE = {
  associate: { select: { id: true, firstName: true, lastName: true } },
  client: { select: { id: true, name: true } },
  dutyOffers: { orderBy: { offeredAt: 'desc' as const } },
} satisfies Prisma.WcClaimInclude;
type WcRow = Prisma.WcClaimGetPayload<{ include: typeof WC_INCLUDE }>;

function wcNext(c: WcRow, now: Date) {
  const due = (d: Date | null) => (d ? { dueAt: fmtDay(d), overdue: d.getTime() < now.getTime() - DAY_MS } : { dueAt: null, overdue: false });
  if (!c.froiSubmittedAt) return { key: 'froi', label: 'Send the first report to the carrier', ...due(c.froiDueAt) };
  if (c.status === 'CLOSED' || c.status === 'DENIED') return null;
  if (!c.rtwDate) return { key: 'rtw', label: c.restrictions ? 'Offer modified duty' : 'Plan the return to work', dueAt: null, overdue: false };
  return { key: 'close', label: 'Close when the carrier closes it', dueAt: null, overdue: false };
}

async function storeNames(ids: string[]) {
  if (!ids.length) return new Map<string, string>();
  const rows = await prisma.site.findMany({ where: { id: { in: ids }, tenantId: tenantIdForWrite() }, select: { id: true, name: true } });
  return new Map(rows.map((r) => [r.id, r.name]));
}

function wcView(c: WcRow, stores: Map<string, string>, now = new Date()) {
  return {
    id: c.id,
    oshaIncidentId: c.oshaIncidentId,
    associateId: c.associateId,
    associateName: `${c.associate.firstName} ${c.associate.lastName}`,
    clientId: c.clientId,
    clientName: c.client?.name ?? null,
    locationId: c.locationId,
    storeName: c.locationId ? stores.get(c.locationId) ?? null : null,
    jurisdiction: c.jurisdiction,
    injuryDate: c.injuryDate.toISOString(),
    reportedToEmployerAt: fmtDay(c.reportedToEmployerAt),
    froiDueAt: fmtDay(c.froiDueAt),
    froi: c.froi as unknown as FroiFields,
    froiSubmittedAt: c.froiSubmittedAt?.toISOString() ?? null,
    carrierName: c.carrierName,
    carrierClaimNumber: c.carrierClaimNumber,
    status: c.status,
    claimType: c.claimType,
    lostTimeDays: c.lostTimeDays,
    restrictedDays: c.restrictedDays,
    reserveMedical: money(c.reserveMedical),
    reserveIndemnity: money(c.reserveIndemnity),
    restrictions: c.restrictions,
    restrictionRules: (c.restrictionRules as RestrictionRules | null) ?? null,
    rtwDate: c.rtwDate ? fmtDay(c.rtwDate) : null,
    notes: c.notes,
    dutyOffers: c.dutyOffers.map((o) => ({ id: o.id, offeredAt: o.offeredAt.toISOString(), shiftId: o.shiftId, description: o.description, response: o.response, respondedAt: o.respondedAt?.toISOString() ?? null })),
    next: wcNext(c, now),
    createdAt: c.createdAt.toISOString(),
  };
}

async function loadWc(req: Request, id: string): Promise<WcRow> {
  const c = await prisma.wcClaim.findFirst({ where: { id, tenantId: tenantIdForWrite(), associate: inReach(req) }, include: WC_INCLUDE });
  if (!c) throw new HttpError(404, 'claim_not_found', 'Claim not found.');
  return c;
}

claimsRouter.get('/claims/workers-comp/summary', MANAGE, async (req, res) => {
  const t = todayUtc();
  const base: Prisma.WcClaimWhereInput = { tenantId: tenantIdForWrite(), associate: inReach(req) };
  const yearAgo = new Date(t.getTime() - 365 * DAY_MS);
  const reach = internalSites(req.user!);
  const [open, all, recordable, entries] = await Promise.all([
    prisma.wcClaim.findMany({ where: { ...base, status: { notIn: ['CLOSED', 'DENIED'] } }, select: { froiSubmittedAt: true, froiDueAt: true, lostTimeDays: true, restrictedDays: true, clientId: true, locationId: true, client: { select: { name: true } } } }),
    prisma.wcClaim.findMany({ where: { ...base, injuryDate: { gte: yearAgo } }, select: { lostTimeDays: true, clientId: true, locationId: true, client: { select: { name: true } } } }),
    prisma.oshaIncident.count({ where: { tenantId: tenantIdForWrite(), isRecordable: true, occurredAt: { gte: yearAgo }, ...(reach ? { store: { is: reach } } : {}) } }),
    prisma.timeEntry.findMany({
      where: { clockInAt: { gte: yearAgo }, clockOutAt: { not: null }, status: { in: ['COMPLETED', 'APPROVED'] }, associate: inReach(req) },
      select: { clockInAt: true, clockOutAt: true },
      take: 200_000,
    }),
  ]);
  const hours = entries.reduce((s, e) => s + (e.clockOutAt!.getTime() - e.clockInAt.getTime()), 0) / 3_600_000;
  const stores = await storeNames([...new Set(all.map((c) => c.locationId).filter((x): x is string => !!x))]);
  const byPlace = new Map<string, { clientName: string; storeName: string | null; claims: number; lostTimeDays: number }>();
  for (const c of all) {
    const key = `${c.clientId ?? 'none'}:${c.locationId ?? 'none'}`;
    const row = byPlace.get(key) ?? { clientName: c.client?.name ?? 'No client', storeName: c.locationId ? stores.get(c.locationId) ?? null : null, claims: 0, lostTimeDays: 0 };
    row.claims += 1;
    row.lostTimeDays += c.lostTimeDays;
    byPlace.set(key, row);
  }
  res.json({
    open: open.length,
    froiDue: open.filter((c) => !c.froiSubmittedAt).length,
    froiOverdue: open.filter((c) => !c.froiSubmittedAt && c.froiDueAt.getTime() < t.getTime()).length,
    lostTimeDaysOpen: open.reduce((s, c) => s + c.lostTimeDays, 0),
    restrictedDaysOpen: open.reduce((s, c) => s + c.restrictedDays, 0),
    claimsLast12Months: all.length,
    // OSHA's rate: recordable cases × 200,000 hours ÷ hours worked.
    // Below one full-time year of hours the rate is noise, so it isn't given.
    incidentRate: hours >= 2000 ? Math.round(((recordable * 200_000) / hours) * 100) / 100 : null,
    hoursWorkedLast12Months: Math.round(hours),
    byPlace: [...byPlace.values()].sort((a, b) => b.claims - a.claims),
  });
});

/** OSHA incidents that may need a claim: injuries beyond first aid, no claim yet. */
claimsRouter.get('/claims/workers-comp/incidents', MANAGE, async (req, res) => {
  const reach = internalSites(req.user!);
  const rows = await prisma.oshaIncident.findMany({
    where: {
      tenantId: tenantIdForWrite(),
      associateId: { not: null },
      severity: { in: ['MEDICAL_TREATMENT', 'RESTRICTED_DUTY', 'DAYS_AWAY', 'FATAL'] },
      occurredAt: { gte: new Date(Date.now() - 180 * DAY_MS) },
      associate: { is: inReach(req) },
      ...(reach ? { store: { is: reach } } : {}),
    },
    orderBy: { occurredAt: 'desc' },
    take: 100,
    select: { id: true, occurredAt: true, severity: true, description: true, bodyPart: true, associate: { select: { firstName: true, lastName: true } }, client: { select: { name: true } }, store: { select: { name: true } } },
  });
  const claimed = new Set((await prisma.wcClaim.findMany({ where: { oshaIncidentId: { in: rows.map((r) => r.id) } }, select: { oshaIncidentId: true } })).map((c) => c.oshaIncidentId));
  res.json({
    incidents: rows
      .filter((r) => !claimed.has(r.id))
      .map((r) => ({
        id: r.id,
        occurredAt: r.occurredAt.toISOString(),
        severity: r.severity,
        description: r.description,
        bodyPart: r.bodyPart,
        associateName: r.associate ? `${r.associate.firstName} ${r.associate.lastName}` : null,
        clientName: r.client.name,
        storeName: r.store?.name ?? null,
      })),
  });
});

claimsRouter.get('/claims/workers-comp', MANAGE, async (req, res) => {
  const q = z.object({ status: z.enum(['open', 'all', 'OPEN', 'SUBMITTED', 'ACCEPTED', 'DENIED', 'CLOSED']).default('open'), page: PageParam }).parse(req.query);
  const where = scopeWhere<Prisma.WcClaimWhereInput>(
    { tenantId: tenantIdForWrite() },
    { associate: inReach(req) },
    q.status === 'open' ? { status: { notIn: ['CLOSED', 'DENIED'] } } : q.status === 'all' ? null : { status: q.status },
  );
  const PAGE = 50;
  const [rows, total] = await Promise.all([
    prisma.wcClaim.findMany({ where, include: WC_INCLUDE, orderBy: [{ froiDueAt: 'asc' }], skip: (q.page - 1) * PAGE, take: PAGE }),
    prisma.wcClaim.count({ where }),
  ]);
  const stores = await storeNames([...new Set(rows.map((r) => r.locationId).filter((x): x is string => !!x))]);
  res.json({ claims: rows.map((r) => wcView(r, stores)), total, page: q.page, pageSize: PAGE, hasMore: q.page * PAGE < total });
});

const WcCreate = z.union([
  z.object({ oshaIncidentId: z.string().uuid(), jurisdiction: z.string().trim().length(2).toUpperCase().optional() }),
  z.object({
    associateId: z.string().uuid(),
    clientId: z.string().uuid().nullable().optional(),
    locationId: z.string().uuid().nullable().optional(),
    jurisdiction: z.string().trim().length(2).toUpperCase(),
    injuryDate: z.string().datetime(),
    reportedToEmployerAt: dateOnly,
    description: z.string().trim().min(3).max(8000),
    bodyPart: z.string().trim().max(120).nullable().optional(),
  }),
]);

claimsRouter.post('/claims/workers-comp', MANAGE, async (req, res) => {
  const input = WcCreate.parse(req.body ?? {});
  let data: { associateId: string; clientId: string | null; locationId: string | null; jurisdiction: string; injuryDate: Date; reported: Date; description: string; where: string | null; bodyPart: string | null; severity: string | null; reporter: string | null; incidentId: string | null };
  if ('oshaIncidentId' in input) {
    const reach = internalSites(req.user!);
    const inc = await prisma.oshaIncident.findFirst({
      where: { id: input.oshaIncidentId, tenantId: tenantIdForWrite(), associateId: { not: null }, associate: { is: inReach(req) }, ...(reach ? { store: { is: reach } } : {}) },
      select: { id: true, associateId: true, clientId: true, locationId: true, occurredAt: true, reportedAt: true, description: true, location: true, bodyPart: true, severity: true, reportedById: true, store: { select: { state: true } } },
    });
    if (!inc) throw new HttpError(404, 'incident_not_found', 'Incident not found.');
    if (await prisma.wcClaim.findUnique({ where: { oshaIncidentId: inc.id }, select: { id: true } })) throw new HttpError(409, 'claim_exists', 'This incident already has a claim.');
    const jurisdiction = input.jurisdiction ?? inc.store?.state ?? (await prisma.associate.findUnique({ where: { id: inc.associateId! }, select: { state: true } }))?.state;
    if (!jurisdiction) throw new HttpError(400, 'jurisdiction_required', 'Which state’s workers’ comp applies? The store has no state on file.');
    data = { associateId: inc.associateId!, clientId: inc.clientId, locationId: inc.locationId, jurisdiction, injuryDate: inc.occurredAt, reported: day(orgDateKey(inc.reportedAt)), description: inc.description, where: inc.location, bodyPart: inc.bodyPart, severity: inc.severity, reporter: inc.reportedById, incidentId: inc.id };
  } else {
    await assertAssociateInScope(prisma, req.user!, input.associateId, { former: true });
    data = { associateId: input.associateId, clientId: input.clientId ?? null, locationId: input.locationId ?? null, jurisdiction: input.jurisdiction, injuryDate: new Date(input.injuryDate), reported: day(input.reportedToEmployerAt), description: input.description, where: null, bodyPart: input.bodyPart ?? null, severity: null, reporter: req.user!.id, incidentId: null };
  }
  const froi = await prefillFroi(prisma, { associateId: data.associateId, occurredAt: data.injuryDate, description: data.description, where: data.where, bodyPart: data.bodyPart, severity: data.severity, reportedByUserId: data.reporter });
  const windowDays = await froiWindowDays(data.jurisdiction);
  const created = await prisma.wcClaim.create({
    data: {
      tenantId: tenantIdForWrite(),
      oshaIncidentId: data.incidentId,
      associateId: data.associateId,
      clientId: data.clientId,
      locationId: data.locationId,
      jurisdiction: data.jurisdiction,
      injuryDate: data.injuryDate,
      reportedToEmployerAt: data.reported,
      froiDueAt: new Date(data.reported.getTime() + windowDays * DAY_MS),
      froi: froi as unknown as Prisma.InputJsonValue,
      claimType: data.severity === 'DAYS_AWAY' ? 'INDEMNITY' : 'MEDICAL_ONLY',
      createdById: req.user!.id,
    },
    include: WC_INCLUDE,
  });
  enqueueAudit({ actorUserId: req.user!.id, action: 'wc_claim.opened', entityType: 'WcClaim', entityId: created.id, metadata: { associateId: data.associateId, oshaIncidentId: data.incidentId } }, 'claims');
  res.status(201).json({ claim: wcView(created, await storeNames(created.locationId ? [created.locationId] : [])) });
});

claimsRouter.get('/claims/workers-comp/:id', MANAGE, async (req, res) => {
  const c = await loadWc(req, z.string().uuid().parse(req.params.id));
  res.json({ claim: wcView(c, await storeNames(c.locationId ? [c.locationId] : [])), froiDefaultDays: await froiWindowDays(c.jurisdiction) });
});

const FroiPatch = z.object({
  employer: z.object({ name: z.string().max(200), fein: z.string().max(20).nullable(), address: z.string().max(300).nullable(), policyNumber: z.string().max(60).nullable() }).partial().optional(),
  employee: z
    .object({ name: z.string().max(200), address: z.string().max(300).nullable(), phone: z.string().max(40).nullable(), jobTitle: z.string().max(120).nullable(), wageRate: z.number().min(0).nullable(), hoursPerWeek: z.number().min(0).max(100).nullable() })
    .partial()
    .optional(),
  injury: z
    .object({
      where: z.string().max(300).nullable(),
      description: z.string().max(8000),
      bodyPart: z.string().max(120).nullable(),
      nature: z.string().max(200).nullable(),
      cause: z.string().max(300).nullable(),
      objectOrSubstance: z.string().max(200).nullable(),
      witnesses: z.string().max(500).nullable(),
      treatment: z.enum(['NONE', 'FIRST_AID', 'CLINIC', 'EMERGENCY_ROOM', 'HOSPITALIZED']).nullable(),
      physician: z.string().max(200).nullable(),
      returnedToWork: z.boolean().nullable(),
    })
    .partial()
    .optional(),
  reportedBy: z.object({ name: z.string().max(200).nullable(), title: z.string().max(120).nullable() }).partial().optional(),
});

const WcPatch = z.object({
  froi: FroiPatch.optional(),
  carrierName: z.string().trim().max(160).nullable().optional(),
  carrierClaimNumber: z.string().trim().max(80).nullable().optional(),
  status: z.enum(['OPEN', 'SUBMITTED', 'ACCEPTED', 'DENIED', 'CLOSED']).optional(),
  claimType: z.enum(['MEDICAL_ONLY', 'INDEMNITY']).optional(),
  lostTimeDays: z.number().int().min(0).max(3650).optional(),
  restrictedDays: z.number().int().min(0).max(3650).optional(),
  reserveMedical: z.number().min(0).max(10_000_000).nullable().optional(),
  reserveIndemnity: z.number().min(0).max(10_000_000).nullable().optional(),
  restrictions: z.string().trim().max(2000).nullable().optional(),
  restrictionRules: z.object({ maxHoursPerShift: z.number().min(1).max(24).nullable().optional(), liftLimitLbs: z.number().min(0).max(500).nullable().optional(), positions: z.array(z.string().trim().max(80)).max(20).optional() }).nullable().optional(),
  rtwDate: dateOnly.nullable().optional(),
  froiDueAt: dateOnly.optional(),
  notes: z.string().trim().max(4000).nullable().optional(),
});

claimsRouter.patch('/claims/workers-comp/:id', MANAGE, async (req, res) => {
  const input = WcPatch.parse(req.body ?? {});
  const c = await loadWc(req, z.string().uuid().parse(req.params.id));
  const data: Prisma.WcClaimUpdateInput = {};
  if (input.froi) {
    const f = c.froi as unknown as FroiFields;
    data.froi = {
      ...f,
      employer: { ...f.employer, ...input.froi.employer },
      employee: { ...f.employee, ...input.froi.employee },
      injury: { ...f.injury, ...input.froi.injury },
      reportedBy: { ...f.reportedBy, ...input.froi.reportedBy },
    } as unknown as Prisma.InputJsonValue;
  }
  for (const k of ['carrierName', 'carrierClaimNumber', 'status', 'claimType', 'lostTimeDays', 'restrictedDays', 'reserveMedical', 'reserveIndemnity', 'restrictions', 'notes'] as const) {
    if (input[k] !== undefined) (data as Record<string, unknown>)[k] = input[k];
  }
  if (input.restrictionRules !== undefined) data.restrictionRules = (input.restrictionRules ?? undefined) as Prisma.InputJsonValue | undefined;
  if (input.rtwDate !== undefined) data.rtwDate = input.rtwDate ? day(input.rtwDate) : null;
  if (input.froiDueAt !== undefined) data.froiDueAt = day(input.froiDueAt);
  if ((input.lostTimeDays ?? 0) > 0 && input.claimType === undefined && c.claimType === 'MEDICAL_ONLY') data.claimType = 'INDEMNITY';
  const updated = await prisma.wcClaim.update({ where: { id: c.id }, data, include: WC_INCLUDE });
  await syncOshaFromClaim(prisma, updated);
  enqueueAudit({ actorUserId: req.user!.id, action: 'wc_claim.updated', entityType: 'WcClaim', entityId: c.id, metadata: { fields: Object.keys(input) } }, 'claims');
  res.json({ claim: wcView(updated, await storeNames(updated.locationId ? [updated.locationId] : [])) });
});

/** Record that the FROI went to the carrier (through its portal). */
claimsRouter.post('/claims/workers-comp/:id/submit', MANAGE, async (req, res) => {
  const input = z.object({ carrierName: z.string().trim().min(2).max(160), carrierClaimNumber: z.string().trim().max(80).nullable().optional(), submittedAt: z.string().datetime().optional() }).parse(req.body ?? {});
  const c = await loadWc(req, z.string().uuid().parse(req.params.id));
  const updated = await prisma.wcClaim.update({
    where: { id: c.id },
    data: { carrierName: input.carrierName, carrierClaimNumber: input.carrierClaimNumber ?? c.carrierClaimNumber, froiSubmittedAt: input.submittedAt ? new Date(input.submittedAt) : new Date(), submittedById: req.user!.id, status: c.status === 'OPEN' ? 'SUBMITTED' : c.status },
    include: WC_INCLUDE,
  });
  enqueueAudit({ actorUserId: req.user!.id, action: 'wc_claim.froi_submitted', entityType: 'WcClaim', entityId: c.id, metadata: { carrierName: input.carrierName } }, 'claims');
  res.json({ claim: wcView(updated, await storeNames(updated.locationId ? [updated.locationId] : [])) });
});

claimsRouter.get('/claims/workers-comp/:id/froi.pdf', MANAGE, async (req, res) => {
  const c = await loadWc(req, z.string().uuid().parse(req.params.id));
  const pdf = await froiPdf(c, c.froi as unknown as FroiFields);
  enqueueAudit({ actorUserId: req.user!.id, action: 'wc_claim.froi_downloaded', entityType: 'WcClaim', entityId: c.id, metadata: {} }, 'claims');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', safeContentDisposition(`froi-${c.jurisdiction}-${fmtDay(c.injuryDate)}.pdf`, true));
  res.send(pdf);
});

claimsRouter.get('/claims/workers-comp/:id/duty-matches', MANAGE, async (req, res) => {
  const c = await loadWc(req, z.string().uuid().parse(req.params.id));
  res.json({ rules: (c.restrictionRules as RestrictionRules | null) ?? null, shifts: await modifiedDutyMatches(prisma, c, { siteWhere: internalSites(req.user!) }) });
});

claimsRouter.post('/claims/workers-comp/:id/duty-offers', MANAGE, async (req, res) => {
  const input = z.object({ shiftId: z.string().uuid().nullable().optional(), description: z.string().trim().min(3).max(1000) }).parse(req.body ?? {});
  const c = await loadWc(req, z.string().uuid().parse(req.params.id));
  if (input.shiftId) {
    const ok = (await modifiedDutyMatches(prisma, c, { siteWhere: internalSites(req.user!) })).some((s) => s.id === input.shiftId);
    if (!ok) throw new HttpError(409, 'shift_not_suitable', 'That shift is taken or doesn’t fit the restrictions.');
  }
  await prisma.wcModifiedDutyOffer.create({ data: { tenantId: tenantIdForWrite(), wcClaimId: c.id, shiftId: input.shiftId ?? null, description: input.description, offeredById: req.user!.id } });
  void notifyAssociate(c.associateId, {
    subject: 'A modified-duty shift is offered',
    body: `${input.description} It fits the restrictions your doctor set. Reply to HR to accept.`,
    category: 'hr',
    emailFallback: true,
  });
  enqueueAudit({ actorUserId: req.user!.id, action: 'wc_claim.duty_offered', entityType: 'WcClaim', entityId: c.id, metadata: { shiftId: input.shiftId ?? null } }, 'claims');
  res.status(201).json({ claim: wcView(await loadWc(req, c.id), await storeNames(c.locationId ? [c.locationId] : [])) });
});

claimsRouter.patch('/claims/workers-comp/:id/duty-offers/:offerId', MANAGE, async (req, res) => {
  const input = z.object({ response: z.enum(['ACCEPTED', 'DECLINED', 'NO_RESPONSE', 'PENDING']) }).parse(req.body ?? {});
  const c = await loadWc(req, z.string().uuid().parse(req.params.id));
  const offer = c.dutyOffers.find((o) => o.id === req.params.offerId);
  if (!offer) throw new HttpError(404, 'offer_not_found', 'Offer not found.');
  await prisma.wcModifiedDutyOffer.update({ where: { id: offer.id }, data: { response: input.response, respondedAt: input.response === 'PENDING' ? null : new Date() } });
  // An accepted offer on a still-open shift puts them on it.
  if (input.response === 'ACCEPTED' && offer.shiftId) {
    const took = await prisma.shift.updateMany({ where: { id: offer.shiftId, tenantId: tenantIdForWrite(), status: 'OPEN', assignedAssociateId: null }, data: { status: 'ASSIGNED', assignedAssociateId: c.associateId } });
    if (took.count === 0) throw new HttpError(409, 'shift_taken', 'The shift was filled meanwhile — offer another.');
  }
  enqueueAudit({ actorUserId: req.user!.id, action: 'wc_claim.duty_answered', entityType: 'WcClaim', entityId: c.id, metadata: { offerId: offer.id, response: input.response } }, 'claims');
  res.json({ claim: wcView(await loadWc(req, c.id), await storeNames(c.locationId ? [c.locationId] : [])) });
});
