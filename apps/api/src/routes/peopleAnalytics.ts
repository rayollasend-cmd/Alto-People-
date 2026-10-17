import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireCapability } from '../middleware/auth.js';
import { activeAssociateIds } from '../lib/activeDefinition.js';
import { tenantIdForWrite } from '../lib/tenant.js';

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
 *   "Active" is the one definition (lib/activeDefinition); a separation is
 *   Associate.separatedAt, never a deleted row.
 */

export const peopleAnalyticsRouter = Router();

const DAY = 86_400_000;
const VIEW = requireCapability('view:analytics');

const monthStart = (now: Date, offset: number) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1));
const monthKey = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
const pct = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);

const TENURE_BANDS: Array<{ label: string; minDays: number; maxDays: number | null }> = [
  { label: 'Under 90 days', minDays: 0, maxDays: 90 },
  { label: '90 days to 1 year', minDays: 90, maxDays: 365 },
  { label: '1 to 3 years', minDays: 365, maxDays: 3 * 365 },
  { label: '3 years and more', minDays: 3 * 365, maxDays: null },
];

peopleAnalyticsRouter.get('/people-analytics', VIEW, async (req, res) => {
  const months = z.coerce.number().int().min(3).max(36).default(12).parse(req.query.months);
  const now = new Date();
  const since = monthStart(now, months - 1);
  const tenantId = tenantIdForWrite();
  const activeIds = await activeAssociateIds({}, now);

  const [associates, separations, positions, timeOff, shifts] = await Promise.all([
    prisma.associate.findMany({
      where: { deletedAt: null, tenantId },
      select: {
        id: true,
        hireDate: true,
        createdAt: true,
        separatedAt: true,
        managerId: true,
        manager: { select: { firstName: true, lastName: true } },
        assignments: { orderBy: { startedAt: 'asc' }, take: 1, select: { location: { select: { id: true, name: true } } } },
      },
      take: 20_000,
    }),
    prisma.separation.findMany({ where: { tenantId }, select: { associateId: true, reason: true }, take: 20_000 }),
    prisma.position.findMany({
      where: { deletedAt: null, status: 'FILLED', filledAt: { not: null, gte: since } },
      select: { id: true, title: true, createdAt: true, targetStartDate: true, filledAt: true, department: { select: { name: true } } },
      take: 5000,
    }),
    prisma.timeOffRequest.findMany({
      where: { tenantId, status: 'APPROVED', startDate: { gte: since } },
      select: { category: true, startDate: true, endDate: true, requestedMinutes: true },
      take: 20_000,
    }),
    prisma.shift.count({ where: { tenantId, status: { in: ['ASSIGNED', 'COMPLETED'] }, startsAt: { gte: since, lt: now } } }),
  ]);
  const reasonBy = new Map(separations.map((s) => [s.associateId, s.reason]));
  const rows = associates.map((a) => ({
    id: a.id,
    hired: a.hireDate ?? a.createdAt,
    separatedAt: a.separatedAt,
    reason: reasonBy.get(a.id) ?? null,
    managerId: a.managerId,
    managerName: a.manager ? `${a.manager.firstName} ${a.manager.lastName}`.trim() : null,
    site: a.assignments[0]?.location ?? null,
    active: activeIds.has(a.id),
  }));

  // Headcount month by month.
  const headcount = [];
  for (let i = months - 1; i >= 0; i--) {
    const start = monthStart(now, i);
    const end = monthStart(now, i - 1);
    const atEnd = rows.filter((r) => r.hired < end && (r.separatedAt === null || r.separatedAt >= end)).length;
    const seps = rows.filter((r) => r.separatedAt !== null && r.separatedAt >= start && r.separatedAt < end);
    headcount.push({
      month: monthKey(start),
      headcount: atEnd,
      hires: rows.filter((r) => r.hired >= start && r.hired < end).length,
      separations: seps.length,
      voluntary: seps.filter((r) => r.reason?.startsWith('VOLUNTARY')).length,
      involuntary: seps.filter((r) => r.reason?.startsWith('INVOLUNTARY')).length,
    });
  }

  // Turnover over the window: separations against the average headcount, annualized.
  const windowDays = Math.max(1, Math.round((now.getTime() - since.getTime()) / DAY));
  const sepsInWindow = rows.filter((r) => r.separatedAt !== null && r.separatedAt >= since);
  const avgHead = headcount.length ? headcount.reduce((s, m) => s + m.headcount, 0) / headcount.length : 0;
  const annualize = (seps: number, base: number) => (base > 0 ? Math.round((seps / base) * (365 / windowDays) * 1000) / 10 : null);
  const group = <K extends string>(key: (r: (typeof rows)[number]) => K | null, label: (k: K, r: (typeof rows)[number]) => string) => {
    const m = new Map<K, { key: K; label: string; separations: number; headcount: number }>();
    for (const r of rows) {
      const k = key(r);
      if (k === null) continue;
      const g = m.get(k) ?? { key: k, label: label(k, r), separations: 0, headcount: 0 };
      if (r.active) g.headcount += 1;
      if (r.separatedAt !== null && r.separatedAt >= since) g.separations += 1;
      m.set(k, g);
    }
    return [...m.values()].map((g) => ({ ...g, annualizedTurnoverPct: annualize(g.separations, g.headcount + g.separations / 2) })).sort((a, b) => (b.annualizedTurnoverPct ?? -1) - (a.annualizedTurnoverPct ?? -1));
  };
  const tenureDays = (r: (typeof rows)[number]) => ((r.separatedAt ?? now).getTime() - r.hired.getTime()) / DAY;
  const byTenure = TENURE_BANDS.map((b) => {
    const inBand = rows.filter((r) => {
      const d = tenureDays(r);
      return d >= b.minDays && (b.maxDays === null || d < b.maxDays);
    });
    const seps = inBand.filter((r) => r.separatedAt !== null && r.separatedAt >= since).length;
    const head = inBand.filter((r) => r.active).length;
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

  // Time to fill: a seat opens when it is created (or its target start, when earlier) and fills at filledAt.
  const fills = positions.map((p) => {
    const opened = p.targetStartDate && p.targetStartDate < p.createdAt ? p.targetStartDate : p.createdAt;
    return { department: p.department?.name ?? 'No department', days: Math.max(0, Math.round((p.filledAt!.getTime() - opened.getTime()) / DAY)) };
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

  res.json({
    months,
    since: since.toISOString().slice(0, 10),
    headcount,
    turnover: {
      annualizedPct: annualize(sepsInWindow.length, avgHead),
      separations: sepsInWindow.length,
      averageHeadcount: Math.round(avgHead),
      byTenure,
      bySite: group((r) => r.site?.id ?? null, (_k, r) => r.site?.name ?? '—'),
      byManager: group((r) => r.managerId, (_k, r) => r.managerName ?? '—'),
    },
    cohorts,
    timeToFill,
    absence,
  });
});
