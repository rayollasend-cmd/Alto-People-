import { Router } from 'express';
import {
  DashboardKPIsSchema,
  type DashboardKPIs,
} from '@alto-people/shared';
import { prisma } from '../db.js';

export const analyticsRouter = Router();

/**
 * One-shot dashboard payload. Each chunk is a single COUNT or aggregate;
 * Promise.all parallelizes them. If any single query fails, the whole
 * response fails — that's acceptable for v1 since these queries are simple.
 */
analyticsRouter.get('/dashboard', async (_req, res, next) => {
  try {
    const now = new Date();
    const in30 = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const minus30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [
      activeAssociates,
      openShiftsNext30d,
      associatesClockedIn,
      pendingOnboardingApplications,
      pendingI9Section2,
      pendingDocumentReviews,
      paidAggregate,
      pendingDisbursementAggregate,
      applicationStatusGroups,
    ] = await Promise.all([
      prisma.associate.count({ where: { deletedAt: null } }),
      prisma.shift.count({
        where: {
          status: { in: ['OPEN', 'ASSIGNED'] },
          startsAt: { gte: now, lte: in30 },
        },
      }),
      prisma.timeEntry.count({ where: { status: 'ACTIVE' } }),
      prisma.application.count({
        where: { deletedAt: null, status: { in: ['DRAFT', 'SUBMITTED', 'IN_REVIEW'] } },
      }),
      prisma.i9Verification.count({ where: { section2CompletedAt: null } }),
      prisma.documentRecord.count({
        where: { deletedAt: null, status: 'UPLOADED' },
      }),
      prisma.payrollRun.aggregate({
        where: { status: 'DISBURSED', disbursedAt: { gte: minus30 } },
        _sum: { totalNet: true },
      }),
      prisma.payrollRun.aggregate({
        where: { status: { in: ['DRAFT', 'FINALIZED'] } },
        _sum: { totalNet: true },
      }),
      prisma.application.groupBy({
        by: ['status'],
        where: { deletedAt: null },
        _count: { _all: true },
      }),
    ]);

    const applicationStatusCounts: Record<string, number> = {};
    for (const g of applicationStatusGroups) {
      applicationStatusCounts[g.status] = g._count._all;
    }

    const payload: DashboardKPIs = DashboardKPIsSchema.parse({
      activeAssociates,
      openShiftsNext30d,
      associatesClockedIn,
      pendingOnboardingApplications,
      pendingI9Section2,
      pendingDocumentReviews,
      netPaidLast30d: Number(paidAggregate._sum.totalNet ?? 0),
      netPendingDisbursement: Number(pendingDisbursementAggregate._sum.totalNet ?? 0),
      applicationStatusCounts,
    });
    res.json(payload);
  } catch (err) {
    next(err);
  }
});
