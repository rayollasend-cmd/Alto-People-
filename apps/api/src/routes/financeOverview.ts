import { Router } from 'express';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import {
  netWorkedMinutes,
  orgDateKey,
  startOfWeekUTC,
} from '../lib/timeAnomalies.js';

/**
 * The Finance cockpit — one round trip behind the FINANCE_ACCOUNTANT
 * dashboard, built around the finance charter's operating loop:
 *
 *   - PAYDAY IS SACRED: the next pay date (from the active schedules),
 *     the in-flight run, and the last disbursement.
 *   - THE CLOSE CHASE: every worked-but-unapproved time entry (these are
 *     what block the Tuesday-evening close), totaled and broken down by
 *     client so the chase list writes itself.
 *   - SETTLEMENTS: manager-approved reimbursements waiting on finance.
 *   - RECEIVABLES (DSO discipline): unpaid FINAL statements — total,
 *     oldest age, and the recent average days-to-pay.
 *   - BILLED VS PAID: last closed org week (Sat–Fri) — FINAL statement
 *     billing vs payroll gross overlapping that window. Period alignment
 *     is approximate by design; it flags variances to explain, it is not
 *     the reconciliation of record.
 *
 * Gated on process:payroll — the payroll operator's capability.
 */

export const financeOverviewRouter = Router();

const DAY_MS = 86_400_000;

/** Next pay date for a schedule: anchorDate treated as a period end;
 *  period ends advance by the frequency; payday = periodEnd + offset. */
function nextPayDate(
  s: { frequency: string; anchorDate: Date; payDateOffsetDays: number },
  now: Date,
): Date | null {
  const stepDays =
    s.frequency === 'WEEKLY' ? 7 : s.frequency === 'BIWEEKLY' ? 14 : null;
  if (stepDays !== null) {
    const t = new Date(s.anchorDate);
    // Jump close, then walk — bounded either way.
    const behind = Math.floor((now.getTime() - t.getTime()) / (stepDays * DAY_MS));
    if (behind > 0) t.setUTCDate(t.getUTCDate() + behind * stepDays);
    let pay = new Date(t.getTime() + s.payDateOffsetDays * DAY_MS);
    for (let i = 0; i < 5 && pay <= now; i++) {
      t.setUTCDate(t.getUTCDate() + stepDays);
      pay = new Date(t.getTime() + s.payDateOffsetDays * DAY_MS);
    }
    return pay > now ? pay : null;
  }
  if (s.frequency === 'MONTHLY' || s.frequency === 'SEMIMONTHLY') {
    const t = new Date(s.anchorDate);
    const stepMonths = s.frequency === 'MONTHLY' ? 1 : 0;
    for (let i = 0; i < 40; i++) {
      const pay = new Date(t.getTime() + s.payDateOffsetDays * DAY_MS);
      if (pay > now) return pay;
      if (stepMonths) t.setUTCMonth(t.getUTCMonth() + 1);
      else t.setUTCDate(t.getUTCDate() + 15); // semimonthly ≈ 15-day walk
    }
  }
  return null;
}

financeOverviewRouter.get(
  '/finance/overview',
  requireCapability('process:payroll'),
  async (_req, res, next) => {
    try {
      const now = new Date();

      const [schedules, inFlightRun, lastDisbursed, pendingEntries, settleAgg, unpaidStatements, paidRecent, draftCount, weekBilled, weekRuns] =
        await Promise.all([
          prisma.payrollSchedule.findMany({
            where: { isActive: true, deletedAt: null },
            select: {
              name: true,
              frequency: true,
              anchorDate: true,
              payDateOffsetDays: true,
            },
          }),
          prisma.payrollRun.findFirst({
            where: { status: { in: ['DRAFT', 'FINALIZED'] } },
            orderBy: { periodEnd: 'desc' },
            select: {
              id: true,
              status: true,
              periodStart: true,
              periodEnd: true,
              totalGross: true,
            },
          }),
          prisma.payrollRun.findFirst({
            where: { status: 'DISBURSED' },
            orderBy: { periodEnd: 'desc' },
            select: { periodEnd: true, totalGross: true, updatedAt: true },
          }),
          prisma.timeEntry.findMany({
            where: { status: 'COMPLETED', clockOutAt: { not: null } },
            select: {
              clockInAt: true,
              clockOutAt: true,
              clientId: true,
              breaks: { select: { type: true, startedAt: true, endedAt: true } },
            },
            take: 2000,
          }),
          prisma.reimbursement.aggregate({
            where: { status: 'MANAGER_APPROVED' },
            _count: true,
            _sum: { totalAmount: true },
          }),
          prisma.clientStatement.findMany({
            where: { status: 'FINAL', paidAt: null },
            select: { finalizedAt: true, snapshot: true },
          }),
          prisma.clientStatement.findMany({
            where: {
              status: 'FINAL',
              paidAt: { not: null, gte: new Date(now.getTime() - 120 * DAY_MS) },
            },
            select: { finalizedAt: true, paidAt: true },
          }),
          prisma.clientStatement.count({ where: { status: 'DRAFT' } }),
          // Last CLOSED org week: [prevWeekStart, thisWeekStart)
          (async () => {
            const thisWeekStart = startOfWeekUTC(now);
            const prevWeekStart = new Date(thisWeekStart.getTime() - 7 * DAY_MS);
            return prisma.clientStatement.findMany({
              where: {
                status: 'FINAL',
                periodStart: { lt: thisWeekStart },
                periodEnd: { gte: prevWeekStart },
              },
              select: { snapshot: true },
            });
          })(),
          (async () => {
            const thisWeekStart = startOfWeekUTC(now);
            const prevWeekStart = new Date(thisWeekStart.getTime() - 7 * DAY_MS);
            return prisma.payrollRun.findMany({
              where: {
                status: { in: ['FINALIZED', 'DISBURSED'] },
                periodStart: { lt: thisWeekStart },
                periodEnd: { gte: prevWeekStart },
              },
              select: { totalGross: true },
            });
          })(),
        ]);

      // Payday: soonest upcoming pay date across active schedules.
      let payday: { date: string; schedule: string } | null = null;
      for (const s of schedules) {
        const d = nextPayDate(s, now);
        if (d && (!payday || d < new Date(payday.date))) {
          payday = { date: d.toISOString(), schedule: s.name };
        }
      }

      // The close chase — unapproved worked hours by client. TimeEntry
      // carries only the denormalized clientId; names resolve in one
      // batched lookup after the fold.
      const byClient = new Map<string, { entries: number; minutes: number }>();
      let chaseMinutes = 0;
      let oldest: Date | null = null;
      for (const e of pendingEntries) {
        const mins = netWorkedMinutes(
          { clockInAt: e.clockInAt, clockOutAt: e.clockOutAt! },
          e.breaks,
        );
        chaseMinutes += mins;
        if (!oldest || e.clockInAt < oldest) oldest = e.clockInAt;
        const key = e.clientId ?? 'none';
        const bucket = byClient.get(key) ?? { entries: 0, minutes: 0 };
        bucket.entries += 1;
        bucket.minutes += mins;
        byClient.set(key, bucket);
      }
      const clientIds = [...byClient.keys()].filter((k) => k !== 'none');
      const clientNames = new Map(
        (
          await prisma.client.findMany({
            where: { id: { in: clientIds } },
            select: { id: true, name: true },
          })
        ).map((c) => [c.id, c.name]),
      );
      const chaseByClient = [...byClient.entries()]
        .sort((a, b) => b[1].minutes - a[1].minutes)
        .slice(0, 5)
        .map(([key, c]) => ({
          clientName: clientNames.get(key) ?? 'Unassigned',
          entries: c.entries,
          hours: Math.round((c.minutes / 60) * 10) / 10,
        }));

      // Receivables.
      const stAmount = (snapshot: unknown): number => {
        const snap = snapshot as { totals?: { amount?: number } } | null;
        return typeof snap?.totals?.amount === 'number' ? snap.totals.amount : 0;
      };
      const outstandingTotal = unpaidStatements.reduce(
        (sum, s) => sum + stAmount(s.snapshot),
        0,
      );
      const oldestUnpaid = unpaidStatements.reduce<Date | null>(
        (acc, s) =>
          s.finalizedAt && (!acc || s.finalizedAt < acc) ? s.finalizedAt : acc,
        null,
      );
      const payLags = paidRecent
        .filter((s) => s.finalizedAt && s.paidAt)
        .map((s) => (s.paidAt!.getTime() - s.finalizedAt!.getTime()) / DAY_MS);
      const avgDaysToPay =
        payLags.length > 0
          ? Math.round(payLags.reduce((a, b) => a + b, 0) / payLags.length)
          : null;

      // The Fieldglass setup queue — approved+scheduled workers not yet
      // marked as registered. Windowed to recent approvals so the first
      // deploy never floods the list with historical associates.
      const fgWindowStart = new Date(now.getTime() - 60 * DAY_MS);
      const recentApproved = await prisma.application.findMany({
        where: {
          status: 'APPROVED',
          approvedAt: { gte: fgWindowStart },
          deletedAt: null,
        },
        orderBy: { approvedAt: 'desc' },
        take: 100,
        select: {
          associateId: true,
          approvedAt: true,
          client: { select: { name: true } },
          associate: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              fieldglassRegistration: { select: { associateId: true } },
            },
          },
        },
      });
      const fgCandidates = recentApproved.filter(
        (a) => a.associate.fieldglassRegistration === null,
      );
      const fgShifts =
        fgCandidates.length > 0
          ? await prisma.shift.findMany({
              where: {
                assignedAssociateId: { in: fgCandidates.map((a) => a.associateId) },
                status: { in: ['ASSIGNED', 'COMPLETED'] },
              },
              orderBy: { startsAt: 'asc' },
              take: 500,
              select: {
                assignedAssociateId: true,
                startsAt: true,
                position: true,
                client: { select: { name: true } },
              },
            })
          : [];
      const firstShiftByAssociate = new Map<string, (typeof fgShifts)[number]>();
      for (const s of fgShifts) {
        if (s.assignedAssociateId && !firstShiftByAssociate.has(s.assignedAssociateId)) {
          firstShiftByAssociate.set(s.assignedAssociateId, s);
        }
      }
      const fieldglassQueue = fgCandidates
        .map((a) => {
          const shift = firstShiftByAssociate.get(a.associateId);
          if (!shift) return null; // approved but not yet scheduled
          return {
            associateId: a.associateId,
            name: `${a.associate.firstName} ${a.associate.lastName}`.trim(),
            clientName: shift.client?.name ?? a.client?.name ?? null,
            position: shift.position,
            firstShiftAt: shift.startsAt.toISOString(),
            approvedAt: a.approvedAt ? a.approvedAt.toISOString() : null,
          };
        })
        .filter((row): row is NonNullable<typeof row> => row !== null)
        .sort(
          (x, y) =>
            new Date(x.firstShiftAt).getTime() - new Date(y.firstShiftAt).getTime(),
        )
        .slice(0, 12);

      const billed = weekBilled.reduce((sum, s) => sum + stAmount(s.snapshot), 0);
      const paidGross = weekRuns.reduce((sum, r) => sum + Number(r.totalGross), 0);
      const thisWeekStart = startOfWeekUTC(now);

      res.json({
        generatedAt: now.toISOString(),
        payday: {
          next: payday,
          inFlight: inFlightRun
            ? {
                id: inFlightRun.id,
                status: inFlightRun.status,
                periodStart: inFlightRun.periodStart.toISOString().slice(0, 10),
                periodEnd: inFlightRun.periodEnd.toISOString().slice(0, 10),
                totalGross: Number(inFlightRun.totalGross),
              }
            : null,
          lastDisbursed: lastDisbursed
            ? {
                periodEnd: lastDisbursed.periodEnd.toISOString().slice(0, 10),
                totalGross: Number(lastDisbursed.totalGross),
              }
            : null,
        },
        close: {
          pendingEntries: pendingEntries.length,
          pendingHours: Math.round((chaseMinutes / 60) * 10) / 10,
          oldestDay: oldest ? orgDateKey(oldest) : null,
          byClient: chaseByClient,
        },
        settlements: {
          count: settleAgg._count,
          total: Number(settleAgg._sum.totalAmount ?? 0),
        },
        receivables: {
          outstandingTotal: Math.round(outstandingTotal * 100) / 100,
          outstandingCount: unpaidStatements.length,
          oldestDays: oldestUnpaid
            ? Math.floor((now.getTime() - oldestUnpaid.getTime()) / DAY_MS)
            : null,
          avgDaysToPay,
          draftStatements: draftCount,
        },
        fieldglassQueue,
        billedVsPaid:
          billed > 0 || paidGross > 0
            ? {
                weekStart: orgDateKey(new Date(thisWeekStart.getTime() - 7 * DAY_MS)),
                billed: Math.round(billed * 100) / 100,
                paidGross: Math.round(paidGross * 100) / 100,
                variance: Math.round((billed - paidGross) * 100) / 100,
              }
            : null,
      });
    } catch (err) {
      next(err);
    }
  },
);

/** Mark a worker as registered in Fieldglass — clears them from the
 *  queue with attribution. Idempotent (re-marking keeps the first stamp). */
financeOverviewRouter.post(
  '/finance/fieldglass/:associateId/done',
  requireCapability('process:payroll'),
  async (req, res, next) => {
    try {
      const associate = await prisma.associate.findFirst({
        where: { id: req.params.associateId, deletedAt: null },
        select: { id: true },
      });
      if (!associate) {
        throw new HttpError(404, 'associate_not_found', 'Associate not found');
      }
      await prisma.fieldglassRegistration.upsert({
        where: { associateId: associate.id },
        create: { associateId: associate.id, addedById: req.user!.id },
        update: {},
      });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

/** Undo a mis-click — puts the worker back on the queue. */
financeOverviewRouter.delete(
  '/finance/fieldglass/:associateId/done',
  requireCapability('process:payroll'),
  async (req, res, next) => {
    try {
      await prisma.fieldglassRegistration.deleteMany({
        where: { associateId: req.params.associateId },
      });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);
