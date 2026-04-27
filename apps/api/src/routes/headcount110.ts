import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireCapability } from '../middleware/auth.js';

/**
 * Phase 110 — Headcount & turnover analytics.
 *
 * Aggregates over Associate (deletedAt = termination, in this codebase
 * the soft-delete column doubles as separation date) and Application
 * (startDate = hire date, earliest per associate). The breakdowns are
 * cheap GROUP BY queries; the only loop is in JS for stitching
 * department / client labels onto the counts.
 */

export const headcount110Router = Router();

const VIEW = requireCapability('view:org');

headcount110Router.get('/headcount/snapshot', VIEW, async (_req, res) => {
  // Active = not soft-deleted. The schema doesn't yet have a separate
  // "terminated" status, so deletedAt is the canonical separation marker.
  const [total, byDept, byClient, byEmpType] = await Promise.all([
    prisma.associate.count({ where: { deletedAt: null } }),
    prisma.associate.groupBy({
      by: ['departmentId'],
      where: { deletedAt: null },
      _count: { _all: true },
    }),
    prisma.application.groupBy({
      by: ['clientId'],
      where: { deletedAt: null, associate: { deletedAt: null } },
      _count: { _all: true },
    }),
    prisma.associate.groupBy({
      by: ['employmentType'],
      where: { deletedAt: null },
      _count: { _all: true },
    }),
  ]);

  // Resolve labels for the buckets in a single query each.
  const deptIds = byDept.map((d) => d.departmentId).filter((x): x is string => !!x);
  const clientIds = byClient.map((c) => c.clientId);
  const [depts, clients] = await Promise.all([
    deptIds.length > 0
      ? prisma.department.findMany({
          where: { id: { in: deptIds } },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
    clientIds.length > 0
      ? prisma.client.findMany({
          where: { id: { in: clientIds } },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
  ]);
  const deptName = new Map(depts.map((d) => [d.id, d.name]));
  const clientName = new Map(clients.map((c) => [c.id, c.name]));

  res.json({
    total,
    byDepartment: byDept.map((row) => ({
      departmentId: row.departmentId,
      departmentName:
        row.departmentId !== null
          ? deptName.get(row.departmentId) ?? '(unknown)'
          : 'Unassigned',
      count: row._count._all,
    })).sort((a, b) => b.count - a.count),
    byClient: byClient.map((row) => ({
      clientId: row.clientId,
      clientName: clientName.get(row.clientId) ?? '(unknown)',
      count: row._count._all,
    })).sort((a, b) => b.count - a.count),
    byEmploymentType: byEmpType.map((row) => ({
      employmentType: row.employmentType,
      count: row._count._all,
    })),
  });
});

const TurnoverWindowSchema = z.object({
  days: z.coerce.number().int().min(7).max(365 * 3).default(90),
});

headcount110Router.get('/headcount/turnover', VIEW, async (req, res) => {
  const { days } = TurnoverWindowSchema.parse(req.query);
  const since = new Date(Date.now() - days * 86_400_000);
  const [hires, terminations, currentActive] = await Promise.all([
    // Hires = Applications whose startDate fell inside the window. We
    // dedupe on associateId so re-hires count once.
    prisma.application.findMany({
      where: {
        deletedAt: null,
        startDate: { gte: since },
      },
      select: { associateId: true, startDate: true },
      orderBy: { startDate: 'asc' },
    }),
    prisma.associate.findMany({
      where: { deletedAt: { gte: since } },
      select: { id: true, deletedAt: true },
      orderBy: { deletedAt: 'asc' },
    }),
    prisma.associate.count({ where: { deletedAt: null } }),
  ]);
  const hiresDeduped = new Map<string, Date>();
  for (const h of hires) {
    if (!h.startDate) continue;
    const existing = hiresDeduped.get(h.associateId);
    if (!existing || h.startDate < existing) {
      hiresDeduped.set(h.associateId, h.startDate);
    }
  }
  // Annualized turnover rate = (terminations / avg_active) * (365/days)
  // Avg active is approximated as currentActive + termCount/2 (mid-window).
  const termCount = terminations.length;
  const avgActive = currentActive + termCount / 2;
  const annualizedTurnover =
    avgActive > 0 ? (termCount / avgActive) * (365 / days) : 0;
  res.json({
    days,
    hires: hiresDeduped.size,
    terminations: termCount,
    netChange: hiresDeduped.size - termCount,
    annualizedTurnoverRate: Math.round(annualizedTurnover * 1000) / 10, // % with 1 decimal
    currentActive,
  });
});
