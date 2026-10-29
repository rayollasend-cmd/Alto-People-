import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireCapability } from '../middleware/auth.js';
import { countStandings, hiresBetween, onTheBooksAt, peopleStandings, turnoverBetween } from '../lib/peopleStatus.js';
import { isOnTheBooks } from '@alto-people/shared';
import { tenantIdForWrite } from '../lib/tenant.js';
import { dateColumnKey } from '../lib/timezone.js';
import { HttpError } from '../middleware/error.js';
import { internalSites, isClientBoundedRole, scopeAssociates, scopeShifts, scopeWhere } from '../lib/scope.js';
import { orgDateKey } from '../lib/timeAnomalies.js';

/**
 * People analytics (HR pack 2026-10): the canned reports the builder's
 * group-by can't express on its own, computed from the records, no storage.
 *
 *   GET /people-analytics?months=12
 *     headcount: month by month, hires and separations
 *     turnover: annualized, by tenure band, by site (first assignment), by manager
 *     cohorts: hiring cohorts' 30/60/90/180-day survival
 *     timeToFill: days from a position opening to its fill, by department
 *     absence: approved time-off days against scheduled days, by category
 *
 *   Where people stand, who counts as hired and when, and the turnover
 *   formula are the one reading in lib/peopleStatus — the same the
 *   Headcount screen and the People directory show: "On the books" is
 *   hired and not separated; a separation is Associate.separatedAt, never
 *   a deleted row.
 */

export const peopleAnalyticsRouter = Router();

const DAY = 86_400_000;
const VIEW = requireCapability('view:analytics');

// The company's month: on the evening of the last day UTC is already in the next month.
const monthStart = (now: Date, offset: number) => {
  const [y, m] = orgDateKey(now).split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 - offset, 1));
};
const monthKey = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
const pct = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);

const TENURE_BANDS: Array<{ label: string; minDays: number; maxDays: number | null }> = [
  { label: 'Under 90 days', minDays: 0, maxDays: 90 },
  { label: '90 days to 1 year', minDays: 90, maxDays: 365 },
  { label: '1 to 3 years', minDays: 365, maxDays: 3 * 365 },
  { label: '3 years and more', minDays: 3 * 365, maxDays: null },
];

/** The id every closed site's row shares: one "Inactive sites" row, not ten rows of the same old name. */
export const INACTIVE_SITES_KEY = 'inactive';

/**
 * The site a person is counted under, as a report row names it. An active
 * site is its own row, labelled "Client · Site" so two clients' same-named
 * stores read apart. Every inactive site folds into one "Inactive sites"
 * row (F500 G4: "The Grand Hotel" eight times over, each a closed site).
 */
function siteOf(loc: { id: string; name: string; isActive: boolean; client: { id: string; name: string } | null } | null) {
  if (!loc) return null;
  if (!loc.isActive) return { id: INACTIVE_SITES_KEY, name: 'Inactive sites', label: 'Inactive sites', inactive: true, siteId: loc.id };
  return { id: loc.id, name: loc.name, label: loc.client ? `${loc.client.name} · ${loc.name}` : loc.name, inactive: false, siteId: loc.id };
}

peopleAnalyticsRouter.get('/people-analytics', VIEW, async (req, res) => {
  const months = z.coerce.number().int().min(3).max(36).default(12).parse(req.query.months);
  const now = new Date();
  const since = monthStart(now, months - 1);
  // Company-wide people analytics (turnover by manager, by site, with names)
  // are the office's: a store's portal login or a supervisor holds
  // view:analytics for their own dashboards, not for this.
  if (isClientBoundedRole(req.user!)) throw new HttpError(403, 'forbidden', 'People analytics are for the office.');
  const tenantId = tenantIdForWrite();
  // A site/region-bound office account reads its own sites' people only.
  const people = scopeAssociates(req.user!);
  const sites = internalSites(req.user!);

  const [associates, separations, positions, timeOff, shifts] = await Promise.all([
    prisma.associate.findMany({
      where: scopeWhere<Prisma.AssociateWhereInput>({ deletedAt: null, tenantId }, people),
      select: {
        id: true,
        hireDate: true,
        createdAt: true,
        separatedAt: true,
        managerId: true,
        manager: { select: { firstName: true, lastName: true } },
        assignments: { orderBy: { startedAt: 'asc' }, take: 1, select: { location: { select: { id: true, name: true, isActive: true, client: { select: { id: true, name: true } } } } } },
      },
      take: 20_000,
    }),
    prisma.separation.findMany({ where: { tenantId }, select: { associateId: true, reason: true }, take: 20_000 }),
    prisma.position.findMany({
      where: { tenantId, deletedAt: null, status: 'FILLED', filledAt: { not: null, gte: since }, ...(sites ? { client: { is: { locations: { some: sites } } } } : {}) },
      select: { id: true, title: true, createdAt: true, targetStartDate: true, filledAt: true, department: { select: { name: true } }, client: { select: { name: true } } },
      take: 5000,
    }),
    prisma.timeOffRequest.findMany({
      where: { tenantId, status: 'APPROVED', startDate: { gte: since }, ...(sites ? { associate: { is: people } } : {}) },
      select: { category: true, startDate: true, endDate: true, requestedMinutes: true },
      take: 20_000,
    }),
    prisma.shift.count({ where: scopeWhere<Prisma.ShiftWhereInput>({ tenantId, status: { in: ['ASSIGNED', 'COMPLETED'] }, startsAt: { gte: since, lt: now } }, scopeShifts(req.user!)) }),
  ]);
  // Scheduled shifts per month, for the absence trend.
  const monthlyShifts = await Promise.all(
    Array.from({ length: months }, (_, k) => {
      const i = months - 1 - k;
      const start = monthStart(now, i);
      const end = i === 0 ? now : monthStart(now, i - 1);
      return prisma.shift.count({ where: scopeWhere({ tenantId, status: { in: ['ASSIGNED', 'COMPLETED'] }, startsAt: { gte: start, lt: end } }, scopeShifts(req.user!)) });
    }),
  );
  const reasonBy = new Map(separations.map((s) => [s.associateId, s.reason]));
  // Where everyone in reach stands, and when they were hired and left: the
  // one reading (lib/peopleStatus). Only people actually hired count — an
  // onboarding invite creates an Associate who never started.
  const scoped = Object.keys(people).length > 0;
  const standings = await peopleStandings({ tenantId, ...(scoped ? { associateIds: associates.map((a) => a.id) } : {}) }, now);
  const counts = countStandings(standings);
  const rows = associates.flatMap((a) => {
    const s = standings.people.get(a.id);
    if (!s?.hiredOn) return [];
    return [{
      id: a.id,
      hired: s.hiredOn,
      separatedAt: s.leftAt,
      reason: reasonBy.get(a.id) ?? null,
      managerId: a.managerId,
      managerName: a.manager ? `${a.manager.firstName} ${a.manager.lastName}`.trim() : null,
      site: siteOf(a.assignments[0]?.location ?? null),
      client: a.assignments[0]?.location?.client ?? null,
      /** On the books today (hired, not separated): the base every headcount here counts. */
      onBooks: isOnTheBooks(s.status),
    }];
  });

  // Headcount month by month: on the books at each month's end (today for
  // this month), with hires by hire date — the same counts the Headcount
  // screen's turnover tile reads.
  const headcount: Array<{ month: string; headcount: number; hires: number; separations: number; voluntary: number; involuntary: number }> = [];
  for (let i = months - 1; i >= 0; i--) {
    const start = monthStart(now, i);
    const end = monthStart(now, i - 1);
    const at = end.getTime() > now.getTime() ? now : new Date(end.getTime() - 1);
    const seps = rows.filter((r) => r.separatedAt !== null && r.separatedAt >= start && r.separatedAt < end);
    headcount.push({
      month: monthKey(start),
      headcount: onTheBooksAt(standings, at),
      hires: hiresBetween(standings, start, end),
      separations: seps.length,
      voluntary: seps.filter((r) => r.reason?.startsWith('VOLUNTARY')).length,
      involuntary: seps.filter((r) => r.reason?.startsWith('INVOLUNTARY')).length,
    });
  }

  // Turnover over the window: THE formula (lib/peopleStatus turnoverBetween).
  const windowDays = Math.max(1, Math.round((now.getTime() - since.getTime()) / DAY));
  const overall = turnoverBetween(standings, since, now);
  const annualize = (seps: number, base: number) => (base > 0 ? Math.round((seps / base) * (365 / windowDays) * 1000) / 10 : null);
  const group = <K extends string>(key: (r: (typeof rows)[number]) => K | null, label: (k: K, r: (typeof rows)[number]) => string) => {
    const m = new Map<K, { key: K; label: string; separations: number; headcount: number }>();
    for (const r of rows) {
      const k = key(r);
      if (k === null) continue;
      const g = m.get(k) ?? { key: k, label: label(k, r), separations: 0, headcount: 0 };
      if (r.onBooks) g.headcount += 1;
      if (r.separatedAt !== null && r.separatedAt >= since) g.separations += 1;
      m.set(k, g);
    }
    return [...m.values()]
      // A row with no one on the books and no one leaving in the window says nothing.
      .filter((g) => g.headcount > 0 || g.separations > 0)
      .map((g) => ({ ...g, annualizedTurnoverPct: annualize(g.separations, g.headcount + g.separations / 2) }))
      .sort((a, b) => (b.annualizedTurnoverPct ?? -1) - (a.annualizedTurnoverPct ?? -1));
  };
  /** How many closed sites the "Inactive sites" row holds. */
  const inactiveSiteCount = new Set(rows.filter((r) => r.site?.inactive).map((r) => r.site!.siteId)).size;
  const tenureDays = (r: (typeof rows)[number]) => ((r.separatedAt ?? now).getTime() - r.hired.getTime()) / DAY;
  const byTenure = TENURE_BANDS.map((b) => {
    const inBand = rows.filter((r) => {
      const d = tenureDays(r);
      return d >= b.minDays && (b.maxDays === null || d < b.maxDays);
    });
    const seps = inBand.filter((r) => r.separatedAt !== null && r.separatedAt >= since).length;
    const head = inBand.filter((r) => r.onBooks).length;
    return { label: b.label, headcount: head, separations: seps, annualizedTurnoverPct: annualize(seps, head + seps / 2) };
  });

  // Hiring cohorts: survival once the whole cohort is old enough.
  const cohorts = [];
  for (let i = months - 1; i >= 0; i--) {
    const start = monthStart(now, i);
    const end = monthStart(now, i - 1);
    const cohort = rows.filter((r) => r.hired >= start && r.hired < end);
    if (cohort.length === 0) continue;
    const survived = (days: number) => (end.getTime() + days * DAY > now.getTime() ? null : pct(cohort.filter((r) => r.separatedAt === null || r.separatedAt.getTime() - r.hired.getTime() >= days * DAY).length, cohort.length));
    cohorts.push({ month: monthKey(start), hires: cohort.length, s30: survived(30), s60: survived(60), s90: survived(90), s180: survived(180) });
  }

  const rollUp = <T extends { days: number }>(xs: T[], key: (x: T) => string) => {
    const m = new Map<string, number[]>();
    for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), x.days]);
    return [...m.entries()]
      .map(([label, days]) => ({ label, filled: days.length, medianDays: median(days) }))
      .sort((a, b) => (b.medianDays ?? 0) - (a.medianDays ?? 0));
  };

  // Time to fill: a seat opens when it is created (or its target start, when earlier) and fills at filledAt.
  const fills = positions.map((p) => {
    const opened = p.targetStartDate && p.targetStartDate < p.createdAt ? p.targetStartDate : p.createdAt;
    return { department: p.department?.name ?? 'No department', client: p.client?.name ?? null, position: p.title, days: Math.max(0, Math.round((p.filledAt!.getTime() - opened.getTime()) / DAY)) };
  });
  const byDept = new Map<string, number[]>();
  for (const f of fills) byDept.set(f.department, [...(byDept.get(f.department) ?? []), f.days]);
  const median = (xs: number[]) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)]!;
  };
  const timeToFill = {
    filled: fills.length,
    medianDays: median(fills.map((f) => f.days)),
    averageDays: fills.length ? Math.round(fills.reduce((s, f) => s + f.days, 0) / fills.length) : null,
    byDepartment: [...byDept.entries()].map(([department, days]) => ({ department, filled: days.length, medianDays: median(days), averageDays: Math.round(days.reduce((s, d) => s + d, 0) / days.length) })).sort((a, b) => (b.medianDays ?? 0) - (a.medianDays ?? 0)),
    // The staffing cut: which clients and which positions are slow to fill.
    byClient: rollUp(fills, (f) => f.client ?? 'No client'),
    byPosition: rollUp(fills, (f) => f.position).slice(0, 15),
  };

  // Absence: approved time-off days against scheduled shifts in the window.
  const daysOf = (r: { startDate: Date; endDate: Date }) => Math.max(1, Math.round((r.endDate.getTime() - r.startDate.getTime()) / DAY) + 1);
  const byCategory = new Map<string, { category: string; requests: number; days: number }>();
  for (const r of timeOff) {
    const g = byCategory.get(r.category) ?? { category: r.category, requests: 0, days: 0 };
    g.requests += 1;
    g.days += daysOf(r);
    byCategory.set(r.category, g);
  }
  const absenceDays = [...byCategory.values()].reduce((s, g) => s + g.days, 0);
  const absence = {
    scheduledShiftDays: shifts,
    absenceDays,
    absenceRatePct: pct(absenceDays, shifts + absenceDays),
    byCategory: [...byCategory.values()].sort((a, b) => b.days - a.days),
  };

  // Absence, month by month: approved days off against scheduled shifts.
  const absenceTrend = headcount.map((h, k) => {
    const days = timeOff.filter((r) => monthKey(r.startDate) === h.month).reduce((sum, r) => sum + daysOf(r), 0);
    const scheduled = monthlyShifts[k] ?? 0;
    return { month: h.month, absenceDays: days, scheduledShiftDays: scheduled, absenceRatePct: pct(days, scheduled + days) };
  });

  // Headcount by store, month by month (the store someone was hired into), top stores by today's people.
  const storeRows = new Map<string, { storeId: string; storeName: string; clientName: string | null; current: number }>();
  for (const r of rows) {
    // The trend draws the stores people work at today; closed sites stay in the tables.
    if (!r.site || r.site.inactive) continue;
    const g = storeRows.get(r.site.id) ?? { storeId: r.site.id, storeName: r.site.name, clientName: r.client?.name ?? null, current: 0 };
    if (r.onBooks) g.current += 1;
    storeRows.set(r.site.id, g);
  }
  const topStores = [...storeRows.values()].sort((a, b) => b.current - a.current).slice(0, 8);
  const headcountByStore = topStores.map((st) => ({
    storeId: st.storeId,
    storeName: st.storeName,
    clientName: st.clientName,
    series: headcount.map((_h, k) => {
      const end = monthStart(now, months - 2 - k);
      return rows.filter((r) => r.site?.id === st.storeId && r.hired < end && (r.separatedAt === null || r.separatedAt >= end)).length;
    }),
  }));

  // Where early leavers leave: separations in the window by store and how long they had been there.
  const EARLY_BANDS = [
    { key: 'week1', label: 'First week', min: 0, max: 7 },
    { key: 'weeks2to4', label: 'Weeks 2–4', min: 7, max: 28 },
    { key: 'months2to3', label: 'Months 2–3', min: 28, max: 90 },
    { key: 'later', label: '3 months and more', min: 90, max: Infinity },
  ] as const;
  const grid = new Map<string, { storeId: string; storeName: string; clientName: string | null; inactive: boolean; siteCount: number; hires: number; separations: number; bands: number[] }>();
  const gridSites = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.site) continue;
    const g = grid.get(r.site.id) ?? { storeId: r.site.id, storeName: r.site.name, clientName: r.site.inactive ? null : r.client?.name ?? null, inactive: r.site.inactive, siteCount: 0, hires: 0, separations: 0, bands: [0, 0, 0, 0] };
    const seen = gridSites.get(r.site.id) ?? new Set<string>();
    seen.add(r.site.siteId);
    gridSites.set(r.site.id, seen);
    g.siteCount = seen.size;
    if (r.hired >= since) g.hires += 1;
    if (r.separatedAt !== null && r.separatedAt >= since) {
      g.separations += 1;
      const d = (r.separatedAt.getTime() - r.hired.getTime()) / DAY;
      const b = EARLY_BANDS.findIndex((x) => d >= x.min && d < x.max);
      g.bands[b < 0 ? 3 : b]! += 1;
    }
    grid.set(r.site.id, g);
  }
  const turnoverGrid = {
    bands: EARLY_BANDS.map((b) => ({ key: b.key, label: b.label })),
    // The inactive roll-up sorts last: it is history, not a store to manage.
    rows: [...grid.values()].filter((g) => g.separations > 0 || g.hires > 0).sort((a, b) => Number(a.inactive) - Number(b.inactive) || (a.clientName ?? '').localeCompare(b.clientName ?? '') || b.separations - a.separations).slice(0, 40),
  };

  // The first 90 days, cohort by cohort: the share still here at each week.
  const SURVIVAL_DAYS = Array.from({ length: 14 }, (_, i) => i * 7).concat(90);
  const survival = cohorts.slice(-6).map((c) => {
    const [y, m] = c.month.split('-').map(Number) as [number, number];
    const start = new Date(Date.UTC(y, m - 1, 1));
    const end = new Date(Date.UTC(y, m, 1));
    const cohort = rows.filter((r) => r.hired >= start && r.hired < end);
    return {
      month: c.month,
      hires: cohort.length,
      points: SURVIVAL_DAYS.map((d) => ({
        day: d,
        // Only once the whole cohort has had the chance to reach that day.
        pct: end.getTime() + d * DAY > now.getTime() ? null : pct(cohort.filter((r) => r.separatedAt === null || r.separatedAt.getTime() - r.hired.getTime() >= d * DAY).length, cohort.length),
      })),
    };
  });

  res.json({
    months,
    since: dateColumnKey(since),
    headcountByStore,
    turnoverGrid,
    survival,
    absenceTrend,
    headcount,
    /** Hired and not separated, today — the number Headcount and Analytics show. */
    onTheBooks: counts.onTheBooks,
    /** Working today by the one definition, over activeWindowDays. */
    working: counts.ACTIVE,
    activeWindowDays: counts.windowDays,
    turnover: {
      annualizedPct: overall.annualizedPct,
      separations: overall.separations,
      hires: overall.hires,
      averageHeadcount: Math.round(overall.averageOnTheBooks),
      byTenure,
      bySite: group((r) => r.site?.id ?? null, (_k, r) => r.site?.label ?? '—').map((g) => (g.key === INACTIVE_SITES_KEY ? { ...g, inactive: true, siteCount: inactiveSiteCount } : g)),
      byManager: group((r) => r.managerId, (_k, r) => r.managerName ?? '—'),
    },
    cohorts,
    timeToFill,
    absence,
  });
});
