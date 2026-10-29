import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { requireCapability } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { enqueueAudit, recordCriticalAudit } from '../lib/audit.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { assertAssociateInScope, scopeActiveAssociates, scopeWhere } from '../lib/scope.js';
import type { SessionUser } from '../types/express.js';
import {
  addMonths,
  basisOn,
  codesForMonth,
  exposure,
  loadAcaConfig,
  loadHours,
  measure,
  penaltyAmounts,
  validateAcaConfig,
  type AcaConfig,
  type Measurement,
  type PersonInput,
} from '../lib/acaMeasurement.js';
import { addDaysToKey, dateColumnKey } from '../lib/timezone.js';
import { orgDateKey } from '../lib/timeAnomalies.js';

/**
 * ACA hours tracking (TAXCOMP 2026-10).
 *
 *   GET|PUT /aca/settings                       measurement / admin / stability periods
 *   GET  /aca/workers                           everyone measured: status, average, offer due
 *   PUT  /aca/workers/:associateId/classification
 *   POST /aca/offers  ·  PATCH /aca/offers/:id  offers of coverage and the answer
 *   GET  /aca/summary                           counts, offers due, 4980H exposure by client
 *   POST /aca/sync-1095c { year }               writes the AcaMonth rows the 1095-C reads
 */

export const acaRouter = Router();

const VIEW = requireCapability('view:payroll');
const MANAGE = requireCapability('process:payroll');
/** A DATE column's day (hire date, stability period); "today" is the company's (orgDateKey). */
const ymd = (d: Date) => dateColumnKey(d);

const SettingsInput = z.object({
  measurementMonths: z.number().int(),
  adminDays: z.number().int(),
  stabilityMonths: z.number().int(),
  initialMeasurementMonths: z.number().int(),
  stabilityStartMonth: z.number().int(),
  stabilityStartDay: z.number().int(),
  fullTimeHoursPerMonth: z.number().min(100).max(200),
  breakInServiceWeeks: z.number().int().min(4).max(52),
  ruleOfParity: z.boolean(),
  defaultOfferCode: z.enum(['CODE_1A', 'CODE_1B', 'CODE_1C', 'CODE_1D', 'CODE_1E', 'CODE_1F', 'CODE_1G', 'CODE_1H']),
  affordabilitySafeHarbor: z.enum(['2F', '2G', '2H']).nullable(),
  lowestPremiumCents: z.number().int().min(0).max(1_000_000).nullable(),
});

acaRouter.get('/aca/settings', VIEW, async (_req, res) => {
  res.json({ settings: await loadAcaConfig(prisma) });
});

acaRouter.put('/aca/settings', MANAGE, async (req, res) => {
  const input = SettingsInput.parse(req.body ?? {});
  const problems = validateAcaConfig(input);
  if (problems.length) throw new HttpError(400, 'invalid_periods', problems.join(' '));
  const tenantId = tenantIdForWrite();
  await prisma.acaSettings.upsert({ where: { tenantId }, create: { tenantId, ...input, updatedById: req.user!.id }, update: { ...input, updatedById: req.user!.id } });
  await recordCriticalAudit({ actorUserId: req.user!.id, action: 'aca.settings_changed', entityType: 'AcaSettings', entityId: tenantId, metadata: input }, 'aca.settings');
  res.json({ settings: await loadAcaConfig(prisma) });
});

interface WorkerRow {
  associateId: string;
  name: string;
  clientId: string | null;
  clientName: string | null;
  siteName: string | null;
  hireDate: string | null;
  measurement: Measurement;
  offer: { id: string; stabilityStart: string; response: string; offeredAt: string } | null;
  offerState: 'not_due' | 'due' | 'overdue' | 'offered';
}

const LOOKBACK_MONTHS = 27;

async function measureEveryone(user: SessionUser, opts: { clientId?: string | null; associateId?: string } = {}): Promise<{ config: AcaConfig; rows: WorkerRow[]; truncated: boolean }> {
  const config = await loadAcaConfig(prisma);
  const now = new Date();
  // The company's day as a calendar date: after 8 PM Eastern the UTC date is already tomorrow.
  const today = new Date(`${orgDateKey(now)}T00:00:00.000Z`);
  const people = await prisma.associate.findMany({
    where: scopeWhere<Prisma.AssociateWhereInput>(
      scopeActiveAssociates(user),
      { employmentType: 'W2_EMPLOYEE' },
      opts.associateId ? { id: opts.associateId } : {},
      opts.clientId ? { assignments: { some: { endedAt: null, location: { clientId: opts.clientId } } } } : {},
    ),
    take: 5_001,
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    select: {
      id: true,
      firstName: true,
      lastName: true,
      hireDate: true,
      createdAt: true,
      acaWorkerClasses: { orderBy: { effectiveFrom: 'asc' }, select: { classification: true, effectiveFrom: true } },
      acaOffers: { orderBy: { stabilityStart: 'desc' }, select: { id: true, stabilityStart: true, stabilityEnd: true, response: true, offeredAt: true } },
      assignments: { where: { endedAt: null }, take: 1, orderBy: { startedAt: 'desc' }, select: { location: { select: { name: true, client: { select: { id: true, name: true } } } } } },
    },
  });
  const truncated = people.length > 5_000;
  const list = people.slice(0, 5_000);
  const hours = await loadHours(prisma, list.map((p) => p.id), addMonths(today, -LOOKBACK_MONTHS));
  const rows = list.map((p): WorkerRow => {
    const input: PersonInput = { hireDate: p.hireDate ?? p.createdAt, classes: p.acaWorkerClasses, entries: hours.get(p.id) ?? [] };
    const m = measure(config, input, today);
    const offer = m.offerDue ? p.acaOffers.find((o) => ymd(o.stabilityStart) <= m.offerDue!.stabilityStart && ymd(o.stabilityEnd) > m.offerDue!.stabilityStart) ?? null : (p.acaOffers[0] ?? null);
    const offerState: WorkerRow['offerState'] = !m.offerDue ? 'not_due' : offer ? 'offered' : m.offerDue.dueBy < orgDateKey(now) ? 'overdue' : 'due';
    const place = p.assignments[0]?.location ?? null;
    return {
      associateId: p.id,
      name: `${p.firstName} ${p.lastName}`,
      clientId: place?.client?.id ?? null,
      clientName: place?.client?.name ?? null,
      siteName: place?.name ?? null,
      hireDate: p.hireDate ? ymd(p.hireDate) : null,
      measurement: m,
      offer: offer ? { id: offer.id, stabilityStart: ymd(offer.stabilityStart), response: offer.response, offeredAt: offer.offeredAt.toISOString() } : null,
      offerState,
    };
  });
  return { config, rows, truncated };
}

acaRouter.get('/aca/workers', VIEW, async (req, res) => {
  const clientId = typeof req.query.clientId === 'string' && req.query.clientId ? req.query.clientId : null;
  const { rows, truncated, config } = await measureEveryone(req.user!, { clientId });
  res.json({ workers: rows, truncated, fullTimeHoursPerMonth: config.fullTimeHoursPerMonth });
});

acaRouter.get('/aca/summary', VIEW, async (req, res) => {
  const { rows, truncated, config } = await measureEveryone(req.user!);
  const year = Number(orgDateKey(new Date()).slice(0, 4));
  const ft = rows.filter((r) => r.measurement.today === 'full_time');
  const offered = ft.filter((r) => !!r.offer);
  const byClient = new Map<string, { clientId: string | null; clientName: string | null; fullTime: number; offered: number; due: number; overdue: number }>();
  for (const r of rows) {
    const key = r.clientId ?? '-';
    const b = byClient.get(key) ?? { clientId: r.clientId, clientName: r.clientName, fullTime: 0, offered: 0, due: 0, overdue: 0 };
    if (r.measurement.today === 'full_time') {
      b.fullTime += 1;
      if (r.offer) b.offered += 1;
    }
    if (r.offerState === 'due') b.due += 1;
    if (r.offerState === 'overdue') b.overdue += 1;
    byClient.set(key, b);
  }
  const amounts = penaltyAmounts(year);
  const total = exposure(ft.length, offered.length, year);
  res.json({
    truncated,
    year,
    threshold: config.fullTimeHoursPerMonth,
    counts: {
      measured: rows.length,
      fullTime: rows.filter((r) => r.measurement.status === 'full_time').length,
      approaching: rows.filter((r) => r.measurement.status === 'approaching').length,
      onTrack: rows.filter((r) => r.measurement.status === 'on_track').length,
      newHires: rows.filter((r) => r.measurement.status === 'new_hire').length,
      crossingThreshold: rows.filter((r) => r.measurement.inProgress && r.measurement.inProgress.averageHours >= config.fullTimeHoursPerMonth && r.measurement.today !== 'full_time').length,
      offersDue: rows.filter((r) => r.offerState === 'due').length,
      offersOverdue: rows.filter((r) => r.offerState === 'overdue').length,
    },
    exposure: { ...total, amounts, fullTime: ft.length, offered: offered.length },
    // Under 50 full-time (plus equivalents) the employer mandate doesn't apply.
    likelyAle: ft.length >= 50,
    byClient: [...byClient.values()]
      .map((b) => {
        const e = exposure(b.fullTime, b.offered, year);
        return { ...b, exposureB: e.b };
      })
      .sort((a, b) => b.exposureB - a.exposureB || b.fullTime - a.fullTime),
  });
});

acaRouter.put('/aca/workers/:associateId/classification', MANAGE, async (req, res) => {
  const associateId = z.string().uuid().parse(req.params.associateId);
  await assertAssociateInScope(prisma, req.user!, associateId);
  const input = z
    .object({ classification: z.enum(['FULL_TIME', 'VARIABLE_HOUR', 'SEASONAL', 'PART_TIME']), effectiveFrom: z.string().date(), reason: z.string().trim().max(300).optional() })
    .parse(req.body ?? {});
  const row = await prisma.acaWorkerClass.create({
    data: { tenantId: tenantIdForWrite(), associateId, classification: input.classification, effectiveFrom: new Date(`${input.effectiveFrom}T00:00:00.000Z`), reason: input.reason ?? null, setById: req.user!.id },
  });
  enqueueAudit({ actorUserId: req.user!.id, action: 'aca.classification_set', entityType: 'AcaWorkerClass', entityId: row.id, metadata: { associateId, ...input } }, 'aca.class');
  const { rows } = await measureEveryone(req.user!, { associateId });
  res.json({ worker: rows[0] ?? null });
});

acaRouter.post('/aca/offers', MANAGE, async (req, res) => {
  const input = z
    .object({
      associateId: z.string().uuid(),
      stabilityStart: z.string().date(),
      stabilityEnd: z.string().date(),
      offerCode: z.enum(['CODE_1A', 'CODE_1B', 'CODE_1C', 'CODE_1D', 'CODE_1E', 'CODE_1F', 'CODE_1G', 'CODE_1H']).optional(),
      lowestPremiumCents: z.number().int().min(0).max(1_000_000).nullable().optional(),
      note: z.string().trim().max(500).optional(),
    })
    .parse(req.body ?? {});
  await assertAssociateInScope(prisma, req.user!, input.associateId);
  const config = await loadAcaConfig(prisma);
  const start = new Date(`${input.stabilityStart}T00:00:00.000Z`);
  const offer = await prisma.acaOffer.upsert({
    where: { associateId_stabilityStart: { associateId: input.associateId, stabilityStart: start } },
    create: {
      tenantId: tenantIdForWrite(),
      associateId: input.associateId,
      stabilityStart: start,
      stabilityEnd: new Date(`${input.stabilityEnd}T00:00:00.000Z`),
      offeredById: req.user!.id,
      offerCode: input.offerCode ?? config.defaultOfferCode,
      lowestPremiumCents: input.lowestPremiumCents ?? config.lowestPremiumCents,
      note: input.note ?? null,
    },
    update: { offerCode: input.offerCode ?? config.defaultOfferCode, lowestPremiumCents: input.lowestPremiumCents ?? config.lowestPremiumCents, note: input.note ?? null },
  });
  dueMemo.clear();
  await recordCriticalAudit({ actorUserId: req.user!.id, action: 'aca.offer_recorded', entityType: 'AcaOffer', entityId: offer.id, metadata: { associateId: input.associateId, stabilityStart: input.stabilityStart } }, 'aca.offer');
  res.status(201).json({ offer: { id: offer.id, response: offer.response } });
});

acaRouter.patch('/aca/offers/:id', MANAGE, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const { response } = z.object({ response: z.enum(['PENDING', 'ENROLLED', 'WAIVED']) }).parse(req.body ?? {});
  const offer = await prisma.acaOffer.findFirst({ where: { id, tenantId: tenantIdForWrite() } });
  if (!offer) throw new HttpError(404, 'not_found', 'Offer not found.');
  await assertAssociateInScope(prisma, req.user!, offer.associateId);
  await prisma.acaOffer.update({ where: { id }, data: { response, respondedAt: response === 'PENDING' ? null : new Date() } });
  dueMemo.clear();
  enqueueAudit({ actorUserId: req.user!.id, action: 'aca.offer_answered', entityType: 'AcaOffer', entityId: id, metadata: { response } }, 'aca.offer');
  res.json({ ok: true });
});

/**
 * POST /aca/sync-1095c { year } — for every W-2 worker in reach, the twelve
 * months of the year: employed or not, in a limited non-assessment period,
 * full-time by measurement (or hired full-time), and the offer covering the
 * month — written to AcaMonth so the 1095-C generator reads them.
 */
acaRouter.post('/aca/sync-1095c', MANAGE, async (req, res) => {
  const { year } = z.object({ year: z.number().int().min(2015).max(2100) }).parse(req.body ?? {});
  const config = await loadAcaConfig(prisma);
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const people = await prisma.associate.findMany({
    where: scopeWhere<Prisma.AssociateWhereInput>(scopeActiveAssociates(req.user!, { former: true }), { employmentType: 'W2_EMPLOYEE' }),
    select: {
      id: true,
      hireDate: true,
      createdAt: true,
      deactivatedAt: true,
      acaWorkerClasses: { orderBy: { effectiveFrom: 'asc' }, select: { classification: true, effectiveFrom: true } },
      acaOffers: { select: { stabilityStart: true, stabilityEnd: true, offerCode: true, response: true, lowestPremiumCents: true } },
    },
  });
  const hours = await loadHours(prisma, people.map((p) => p.id), addMonths(yearStart, -LOOKBACK_MONTHS));
  let written = 0;
  for (const p of people) {
    const input: PersonInput = { hireDate: p.hireDate ?? p.createdAt, classes: p.acaWorkerClasses, entries: hours.get(p.id) ?? [], separatedAt: p.deactivatedAt };
    const months = Array.from({ length: 12 }, (_, i) => {
      const monthStart = new Date(Date.UTC(year, i, 1));
      const monthEnd = new Date(Date.UTC(year, i + 1, 0));
      // Employed for the whole month counts the month's basis on its last day; otherwise not employed for line 16.
      const startBasis = basisOn(config, input, monthStart).basis;
      const endBasis = basisOn(config, input, monthEnd).basis;
      const basis = startBasis === 'not_employed' && endBasis === 'not_employed' ? 'not_employed' : endBasis === 'not_employed' ? startBasis : endBasis;
      const offer = p.acaOffers.find((o) => o.stabilityStart <= monthEnd && o.stabilityEnd > monthStart) ?? null;
      return { month: i + 1, ...codesForMonth(config, basis, offer) };
    });
    if (months.every((m) => m.safeHarbor === '2A')) continue;
    for (const m of months) {
      await prisma.acaMonth.upsert({
        where: { associateId_year_month: { associateId: p.id, year, month: m.month } },
        create: { associateId: p.id, tenantId: tenantIdForWrite(), year, month: m.month, offerOfCoverage: m.offerOfCoverage, safeHarbor: m.safeHarbor, isFullTime: m.isFullTime, lowestPremiumCents: m.lowestPremiumCents },
        update: { offerOfCoverage: m.offerOfCoverage, safeHarbor: m.safeHarbor, isFullTime: m.isFullTime, lowestPremiumCents: m.lowestPremiumCents },
      });
    }
    written += 1;
  }
  await recordCriticalAudit({ actorUserId: req.user!.id, action: 'aca.1095c_synced', entityType: 'AcaMonth', entityId: String(year), metadata: { year, people: written } }, 'aca.sync');
  res.json({ year, people: written });
});

/** For the Inbox: full-time workers with no offer recorded whose deadline is within 30 days or past.
 *  Measuring everyone is not free, and the Inbox polls — the count is kept for a minute per user. */
const dueMemo = new Map<string, { at: number; n: number }>();
export async function acaOffersDue(user: SessionUser): Promise<number> {
  const hit = dueMemo.get(user.id);
  if (hit && Date.now() - hit.at < 60_000) return hit.n;
  const { rows } = await measureEveryone(user);
  const soon = addDaysToKey(orgDateKey(new Date()), 30);
  const n = rows.filter((r) => (r.offerState === 'due' || r.offerState === 'overdue') && r.measurement.offerDue && r.measurement.offerDue.dueBy <= soon).length;
  dueMemo.set(user.id, { at: Date.now(), n });
  return n;
}

/** Test-only: forget the Inbox memo. */
export function __resetAcaMemoForTesting(): void {
  dueMemo.clear();
}
