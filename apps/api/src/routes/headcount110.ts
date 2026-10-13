import { Router } from 'express';
import { z } from 'zod';
import type { HeadcountOverview, HeadcountRow } from '@alto-people/shared';
import { prisma } from '../db.js';
import { requireCapability } from '../middleware/auth.js';
import { activeBreakdown, EMPLOYED_WHERE, placements } from '../lib/activeDefinition.js';
import { endOfWeekUTC, startOfWeekUTC } from '../lib/timeAnomalies.js';
import { associatesWithoutRate } from '../lib/rateCards.js';

/**
 * Headcount (Brief 1A-2).
 *
 *   GET /headcount/overview        every number is the one definition of active, beside what payroll last said
 *   GET /headcount/snapshot        kept for the older page: the same numbers in the old shape
 *   GET /headcount/turnover?days=  hires, separations and annualized turnover over the active base
 */
export const headcount110Router = Router();

const VIEW = requireCapability('view:org');

async function overview(now: Date): Promise<HeadcountOverview> {
  const active = await activeBreakdown(now, prisma);
  const placed = await placements({}, prisma);
  const withoutRate = await associatesWithoutRate(prisma, now);
  const noRateByClient = new Map<string, number>();
  const noRateByLocation = new Map<string, number>();
  for (const w of withoutRate) {
    noRateByClient.set(w.clientId, (noRateByClient.get(w.clientId) ?? 0) + 1);
    if (w.locationId) noRateByLocation.set(w.locationId, (noRateByLocation.get(w.locationId) ?? 0) + 1);
  }
  const weekStart = startOfWeekUTC(now);
  const weekEnd = endOfWeekUTC(now);

  const [scheduledRows, clients, locations, departments, assocRows, lastRun, snapshot, counts] = await Promise.all([
    prisma.shift.findMany({
      where: { status: 'ASSIGNED', assignedAssociateId: { not: null }, startsAt: { gte: weekStart, lt: weekEnd } },
      select: { assignedAssociateId: true, clientId: true, locationId: true },
      distinct: ['assignedAssociateId', 'clientId', 'locationId'],
      take: 20_000,
    }),
    prisma.client.findMany({ where: { deletedAt: null }, select: { id: true, name: true }, orderBy: { name: 'asc' }, take: 2_000 }),
    prisma.site.findMany({ where: { deletedAt: null }, select: { id: true, name: true, clientId: true }, orderBy: { name: 'asc' }, take: 5_000 }),
    prisma.department.findMany({ select: { id: true, name: true }, take: 1_000 }),
    active.total
      ? prisma.associate.findMany({ where: { id: { in: [...active.ids] } }, select: { id: true, departmentId: true, employmentType: true }, take: 20_000 })
      : Promise.resolve([] as { id: string; departmentId: string | null; employmentType: string }[]),
    prisma.payrollRun.findFirst({
      where: { status: { in: ['FINALIZED', 'DISBURSED'] } },
      orderBy: { periodEnd: 'desc' },
      select: { periodStart: true, periodEnd: true, _count: { select: { items: true } } },
    }),
    prisma.reconciliationSnapshot.findFirst({ orderBy: [{ periodEnd: 'desc' }, { ranAt: 'desc' }] }),
    Promise.all([
      prisma.associate.count({ where: { ...EMPLOYED_WHERE, applications: { some: { status: { in: ['DRAFT', 'SUBMITTED', 'IN_REVIEW'] }, deletedAt: null } }, assignments: { none: { endedAt: null } } } }),
      prisma.associate.count({ where: { deletedAt: null, separatedAt: { not: null } } }),
      prisma.associate.count({ where: { deletedAt: null, separatedAt: null, deactivatedAt: { not: null } } }),
      prisma.associate.count({ where: EMPLOYED_WHERE }),
    ]),
  ]);
  const [onboarding, separated, deactivated, employed] = counts;

  const scheduledIds = new Set<string>();
  const scheduledByClient = new Map<string, Set<string>>();
  const scheduledByLocation = new Map<string, Set<string>>();
  for (const s of scheduledRows) {
    if (!s.assignedAssociateId) continue;
    scheduledIds.add(s.assignedAssociateId);
    if (s.clientId) {
      if (!scheduledByClient.has(s.clientId)) scheduledByClient.set(s.clientId, new Set());
      scheduledByClient.get(s.clientId)!.add(s.assignedAssociateId);
    }
    if (s.locationId) {
      if (!scheduledByLocation.has(s.locationId)) scheduledByLocation.set(s.locationId, new Set());
      scheduledByLocation.get(s.locationId)!.add(s.assignedAssociateId);
    }
  }

  const clientName = new Map(clients.map((c) => [c.id, c.name]));
  const byClient: HeadcountRow[] = clients
    .map((c) => ({ id: c.id, name: c.name, active: active.byClient.get(c.id) ?? 0, scheduledThisWeek: scheduledByClient.get(c.id)?.size ?? 0, withoutRate: noRateByClient.get(c.id) ?? 0 }))
    .filter((r) => r.active > 0 || r.scheduledThisWeek > 0 || r.withoutRate > 0)
    .sort((a, b) => b.active - a.active || a.name.localeCompare(b.name));
  const byStore: HeadcountRow[] = locations
    .map((l) => ({ id: l.id, name: l.name, clientName: (l.clientId ? clientName.get(l.clientId) : undefined) ?? '', active: active.byLocation.get(l.id) ?? 0, scheduledThisWeek: scheduledByLocation.get(l.id)?.size ?? 0, withoutRate: noRateByLocation.get(l.id) ?? 0 }))
    .filter((r) => r.active > 0 || r.scheduledThisWeek > 0 || r.withoutRate > 0)
    .sort((a, b) => b.active - a.active || a.name.localeCompare(b.name));

  const deptName = new Map(departments.map((d) => [d.id, d.name]));
  const byDept = new Map<string | null, number>();
  const byType = new Map<string, number>();
  for (const a of assocRows) {
    byDept.set(a.departmentId, (byDept.get(a.departmentId) ?? 0) + 1);
    byType.set(a.employmentType, (byType.get(a.employmentType) ?? 0) + 1);
  }

  const placedNoRecentWork = [...placed.keys()].filter((id) => !active.ids.has(id)).length;
  const employedNotPlaced = Math.max(0, employed - placed.size - onboarding);

  return {
    asOf: now.toISOString(),
    windowDays: active.windowDays,
    active: active.total,
    scheduledThisWeek: scheduledIds.size,
    onPayrollLastPeriod: lastRun ? { count: lastRun._count.items, periodStart: lastRun.periodStart.toISOString().slice(0, 10), periodEnd: lastRun.periodEnd.toISOString().slice(0, 10) } : null,
    inHousing: null,
    notActive: { employedNotPlaced, placedNoRecentWork, separated, deactivated, onboarding },
    byClient,
    byStore,
    byDepartment: [...byDept.entries()].map(([id, n]) => ({ id, name: id ? (deptName.get(id) ?? '(unknown)') : 'Unassigned', active: n })).sort((a, b) => b.active - a.active),
    byEmploymentType: [...byType.entries()].map(([employmentType, n]) => ({ employmentType, active: n })).sort((a, b) => b.active - a.active),
    reconciliation: snapshot
      ? {
          periodStart: snapshot.periodStart.toISOString().slice(0, 10),
          periodEnd: snapshot.periodEnd.toISOString().slice(0, 10),
          ranAt: snapshot.ranAt.toISOString(),
          platformActive: snapshot.platformActive,
          platformPaid: snapshot.platformPaid,
          payrollPaid: snapshot.payrollPaid,
          headcountVariance: snapshot.payrollPaid == null ? null : snapshot.platformPaid - snapshot.payrollPaid,
          hoursVariance: snapshot.payrollHours == null ? null : Number(snapshot.platformHours) - Number(snapshot.payrollHours),
          grossVariance: snapshot.payrollGross == null ? null : Number(snapshot.platformGross) - Number(snapshot.payrollGross),
          varianceLines: snapshot.varianceLines,
          payrollProvided: snapshot.payrollProvided,
          notes: snapshot.notes,
        }
      : null,
  };
}

headcount110Router.get('/headcount/overview', VIEW, async (_req, res) => {
  res.json(await overview(new Date()));
});

/** Brief 1A-2: every placed associate whose role has no rate card at their client today. */
headcount110Router.get('/headcount/without-rate', VIEW, async (_req, res) => {
  res.json({ associates: await associatesWithoutRate(prisma) });
});

/** The older page's shape, now fed by the one definition. */
headcount110Router.get('/headcount/snapshot', VIEW, async (_req, res) => {
  const o = await overview(new Date());
  res.json({
    total: o.active,
    byDepartment: o.byDepartment.map((d) => ({ departmentId: d.id, departmentName: d.name, count: d.active })),
    byClient: o.byClient.map((c) => ({ clientId: c.id, clientName: c.name, count: c.active })),
    byEmploymentType: o.byEmploymentType.map((t) => ({ employmentType: t.employmentType, count: t.active })),
  });
});

const TurnoverWindowSchema = z.object({
  days: z.coerce.number().int().min(7).max(365 * 3).default(90),
});

headcount110Router.get('/headcount/turnover', VIEW, async (req, res) => {
  const { days } = TurnoverWindowSchema.parse(req.query);
  const since = new Date(Date.now() - days * 86_400_000);
  const [hires, separations, active] = await Promise.all([
    prisma.application.findMany({
      take: 500,
      where: { deletedAt: null, startDate: { gte: since } },
      select: { associateId: true, startDate: true },
      orderBy: { startDate: 'asc' },
    }),
    // Brief 1A-2: a termination is a separation, not a deleted record.
    prisma.associate.count({ where: { separatedAt: { gte: since } } }),
    activeBreakdown(new Date(), prisma),
  ]);
  const hiresDeduped = new Map<string, Date>();
  for (const h of hires) {
    if (!h.startDate) continue;
    const existing = hiresDeduped.get(h.associateId);
    if (!existing || h.startDate < existing) hiresDeduped.set(h.associateId, h.startDate);
  }
  const avgActive = active.total + separations / 2;
  const annualizedTurnover = avgActive > 0 ? (separations / avgActive) * (365 / days) : 0;
  res.json({
    days,
    hires: hiresDeduped.size,
    terminations: separations,
    netChange: hiresDeduped.size - separations,
    annualizedTurnoverRate: Math.round(annualizedTurnover * 1000) / 10, // % with 1 decimal
    currentActive: active.total,
  });
});
