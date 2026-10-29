import { Router } from 'express';
import { z } from 'zod';
import type { HeadcountOverview, HeadcountRow } from '@alto-people/shared';
import { prisma } from '../db.js';
import { requireCapability } from '../middleware/auth.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { activeBreakdown } from '../lib/activeDefinition.js';
import { countStandings, peopleStandings, turnoverBetween } from '../lib/peopleStatus.js';
import { endOfWeekUTC, orgDateKey, startOfWeekUTC } from '../lib/timeAnomalies.js';
import { associatesWithoutRate } from '../lib/rateCards.js';
import { internalSites, scopeAssociates } from '../lib/scope.js';
import type { Prisma } from '@prisma/client';
import type { SessionUser } from '../types/express.js';
import { dateColumnKey } from '../lib/timezone.js';

/**
 * A site/region-bound office account counts its own sites' people only:
 * the ids in reach, and the sites. Null for everyone else (the tenant).
 */
async function reachOf(user: SessionUser, tenantId: string): Promise<{ ids: string[]; sites: Prisma.SiteWhereInput } | null> {
  const sites = internalSites(user);
  if (!sites) return null;
  const rows = await prisma.associate.findMany({ where: { AND: [{ tenantId }, scopeAssociates(user)] }, select: { id: true } });
  return { ids: rows.map((r) => r.id), sites };
}

/**
 * Headcount (Brief 1A-2).
 *
 *   GET /headcount/overview        every number is the one definition of active, beside what payroll last said
 *   GET /headcount/snapshot        kept for the older page: the same numbers in the old shape
 *   GET /headcount/turnover?days=  hires, separations and annualized turnover over the active base
 */
export const headcount110Router = Router();

const VIEW = requireCapability('view:org');

async function overview(now: Date, tenantId: string, reach: { ids: string[]; sites: Prisma.SiteWhereInput } | null = null): Promise<HeadcountOverview> {
  // Brief 2-1: explicit tenant until enforce mode (cross-tenant suite); the
  // active totals and the without-rate rows count this tenant's people only
  // — and, for a site/region-bound caller, only the people in reach.
  const T = { tenantId };
  const ids = reach?.ids;
  const active = await activeBreakdown(now, prisma, undefined, { tenantId, ...(ids ? { associateIds: ids } : {}) });
  // Where everyone stands, by the one rule (lib/peopleStatus): the same
  // counts the People directory's tiles and Analytics show.
  const standings = await peopleStandings({ tenantId, ...(ids ? { associateIds: ids } : {}) }, now, prisma);
  const standing = countStandings(standings);
  const withoutRate = await associatesWithoutRate(prisma, now, { tenantId, ...(ids ? { associateIds: ids } : {}) });
  const noRateByClient = new Map<string, number>();
  const noRateByLocation = new Map<string, number>();
  for (const w of withoutRate) {
    if (w.clientId) noRateByClient.set(w.clientId, (noRateByClient.get(w.clientId) ?? 0) + 1);
    if (w.locationId) noRateByLocation.set(w.locationId, (noRateByLocation.get(w.locationId) ?? 0) + 1);
  }
  const weekStart = startOfWeekUTC(now);
  const weekEnd = endOfWeekUTC(now);

  const [scheduledRows, clients, locations, departments, assocRows, lastRun, snapshot] = await Promise.all([
    prisma.shift.findMany({
      where: { ...T, status: 'ASSIGNED', assignedAssociateId: ids ? { in: ids } : { not: null }, startsAt: { gte: weekStart, lt: weekEnd } },
      select: { assignedAssociateId: true, clientId: true, locationId: true },
      distinct: ['assignedAssociateId', 'clientId', 'locationId'],
      take: 20_000,
    }),
    prisma.client.findMany({ where: { ...T, deletedAt: null, ...(reach ? { locations: { some: reach.sites } } : {}) }, select: { id: true, name: true }, orderBy: { name: 'asc' }, take: 2_000 }),
    prisma.site.findMany({ where: { AND: [{ ...T, deletedAt: null }, reach?.sites ?? {}] }, select: { id: true, name: true, clientId: true }, orderBy: { name: 'asc' }, take: 5_000 }),
    prisma.department.findMany({ where: T, select: { id: true, name: true }, take: 1_000 }),
    active.total
      ? prisma.associate.findMany({ where: { ...T, id: { in: [...active.ids] } }, select: { id: true, departmentId: true, employmentType: true }, take: 20_000 })
      : Promise.resolve([] as { id: string; departmentId: string | null; employmentType: string }[]),
    // Org-wide payroll and reconciliation figures are the whole company's: not for a bounded caller.
    reach ? Promise.resolve(null) : prisma.payrollRun.findFirst({
      where: { ...T, status: { in: ['FINALIZED', 'DISBURSED'] } },
      orderBy: { periodEnd: 'desc' },
      select: { periodStart: true, periodEnd: true, finalizedAt: true, _count: { select: { items: true } } },
    }),
    reach ? Promise.resolve(null) : prisma.reconciliationSnapshot.findFirst({ where: T, orderBy: [{ periodEnd: 'desc' }, { ranAt: 'desc' }] }),
  ]);

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

  return {
    asOf: now.toISOString(),
    windowDays: active.windowDays,
    active: standing.ACTIVE,
    onTheBooks: standing.onTheBooks,
    statusCounts: standing,
    scheduledThisWeek: scheduledIds.size,
    // Scheduled this week but not Working — had a shift earlier this week
    // and no work in the window — so "Working 0 · Scheduled 2" explains itself.
    scheduledNotWorking: [...scheduledIds].filter((id) => standings.people.get(id)?.status !== 'ACTIVE').length,
    onPayrollLastPeriod: lastRun
      ? {
          count: lastRun._count.items,
          periodStart: dateColumnKey(lastRun.periodStart),
          periodEnd: dateColumnKey(lastRun.periodEnd),
          finalizedOn: lastRun.finalizedAt ? orgDateKey(lastRun.finalizedAt) : null, // a moment: the company's day
        }
      : null,
    inHousing: null,
    notActive: {
      employedNotPlaced: standing.NOT_PLACED,
      placedNoRecentWork: standing.PLACED_NOT_ACTIVE,
      separated: standing.SEPARATED,
      deactivated: standing.DEACTIVATED,
      onboarding: standing.ONBOARDING,
    },
    byClient,
    byStore,
    byDepartment: [...byDept.entries()].map(([id, n]) => ({ id, name: id ? (deptName.get(id) ?? '(unknown)') : 'Unassigned', active: n })).sort((a, b) => b.active - a.active),
    byEmploymentType: [...byType.entries()].map(([employmentType, n]) => ({ employmentType, active: n })).sort((a, b) => b.active - a.active),
    reconciliation: snapshot
      ? {
          periodStart: dateColumnKey(snapshot.periodStart),
          periodEnd: dateColumnKey(snapshot.periodEnd),
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

headcount110Router.get('/headcount/overview', VIEW, async (req, res) => {
  const tenantId = tenantIdForWrite();
  res.json(await overview(new Date(), tenantId, await reachOf(req.user!, tenantId)));
});

/** Brief 1A-2: every placed associate whose role has no rate card at their client today. */
headcount110Router.get('/headcount/without-rate', VIEW, async (req, res) => {
  // Brief 2-1: only this tenant's people (cross-tenant suite) — and the caller's reach.
  const tenantId = tenantIdForWrite();
  const reach = await reachOf(req.user!, tenantId);
  const rows = await associatesWithoutRate(prisma, new Date(), { tenantId, ...(reach ? { associateIds: reach.ids } : {}) });
  res.json({ associates: rows });
});

/** The older page's shape, now fed by the one definition. */
headcount110Router.get('/headcount/snapshot', VIEW, async (req, res) => {
  const tenantId = tenantIdForWrite();
  const o = await overview(new Date(), tenantId, await reachOf(req.user!, tenantId));
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
  const now = new Date();
  const since = new Date(now.getTime() - days * 86_400_000);
  // Brief 2-1: hires, separations and the base are this tenant's own — and
  // the caller's reach. One reading and one formula (lib/peopleStatus), the
  // same People analytics uses: hires by hire date, separations over the
  // average on the books, annualized.
  const tenantId = tenantIdForWrite();
  const reach = await reachOf(req.user!, tenantId);
  const ids = reach?.ids;
  const standings = await peopleStandings({ tenantId, ...(ids ? { associateIds: ids } : {}) }, now, prisma);
  const counts = countStandings(standings);
  const t = turnoverBetween(standings, since, now);
  res.json({
    days,
    hires: t.hires,
    terminations: t.separations,
    netChange: t.hires - t.separations,
    annualizedTurnoverRate: t.annualizedPct ?? 0, // % with 1 decimal
    averageOnTheBooks: t.averageOnTheBooks,
    currentActive: counts.ACTIVE,
    onTheBooks: counts.onTheBooks,
  });
});
