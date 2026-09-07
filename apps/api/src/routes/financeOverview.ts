import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import {
  netWorkedMinutes,
  orgDateKey,
  startOfWeekUTC,
  utcInstantOfLocalMidnight,
} from '../lib/timeAnomalies.js';
import { nextPayDate } from '../lib/payday.js';
import { notifyUser } from '../lib/notify.js';

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

financeOverviewRouter.get(
  '/finance/overview',
  requireCapability('process:payroll'),
  async (req, res, next) => {
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
          // clientId powers the Nudge button — the in-product chase.
          clientId: key === 'none' ? null : key,
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
              email: true,
              phone: true,
              hireDate: true,
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
      // TRANSFERS: registered under one client, currently assigned to
      // another → "close old account, open new one". Not windowed — a
      // two-year associate can transfer.
      const regs = await prisma.fieldglassRegistration.findMany({
        where: { clientId: { not: null } },
        take: 500,
        select: {
          associateId: true,
          clientId: true,
          client: { select: { name: true } },
          associate: {
            select: {
              firstName: true,
              lastName: true,
              email: true,
              phone: true,
              hireDate: true,
              deletedAt: true,
              assignments: {
                where: { endedAt: null },
                orderBy: { startedAt: 'desc' },
                take: 1,
                select: {
                  location: {
                    select: { client: { select: { id: true, name: true } } },
                  },
                },
              },
            },
          },
        },
      });
      const transferRows = regs
        .filter((r) => {
          const cur = r.associate.assignments[0]?.location.client;
          return (
            r.associate.deletedAt === null &&
            cur !== undefined &&
            r.clientId !== null &&
            cur.id !== r.clientId
          );
        })
        .map((r) => {
          const cur = r.associate.assignments[0]!.location.client!;
          return {
            kind: 'transfer' as const,
            associateId: r.associateId,
            name: `${r.associate.firstName} ${r.associate.lastName}`.trim(),
            clientName: cur.name,
            fromClientName: r.client?.name ?? null,
            position: null as string | null,
            firstShiftAt: null as string | null,
            approvedAt: null as string | null,
            email: r.associate.email,
            phone: r.associate.phone,
            hireDate: r.associate.hireDate
              ? r.associate.hireDate.toISOString().slice(0, 10)
              : null,
          };
        });
      // Earliest upcoming shift at the NEW client — the transfer deadline.
      if (transferRows.length > 0) {
        const upcoming = await prisma.shift.findMany({
          where: {
            assignedAssociateId: { in: transferRows.map((r) => r.associateId) },
            status: 'ASSIGNED',
            startsAt: { gte: now },
          },
          orderBy: { startsAt: 'asc' },
          take: 200,
          select: { assignedAssociateId: true, startsAt: true, position: true },
        });
        for (const row of transferRows) {
          const s = upcoming.find((u) => u.assignedAssociateId === row.associateId);
          if (s) {
            row.firstShiftAt = s.startsAt.toISOString();
            row.position = s.position;
          }
        }
      }

      const addRows = fgCandidates
        .map((a) => {
          const shift = firstShiftByAssociate.get(a.associateId);
          if (!shift) return null; // approved but not yet scheduled
          return {
            kind: 'add' as const,
            associateId: a.associateId,
            name: `${a.associate.firstName} ${a.associate.lastName}`.trim(),
            clientName: shift.client?.name ?? a.client?.name ?? null,
            fromClientName: null as string | null,
            position: shift.position as string | null,
            firstShiftAt: shift.startsAt.toISOString() as string | null,
            approvedAt: a.approvedAt ? a.approvedAt.toISOString() : null,
            // The Fieldglass entry facts — on the row, so most workers
            // never require leaving the dashboard at all.
            email: a.associate.email,
            phone: a.associate.phone,
            hireDate: a.associate.hireDate
              ? a.associate.hireDate.toISOString().slice(0, 10)
              : null,
          };
        })
        .filter((row): row is NonNullable<typeof row> => row !== null);

      // Transfers outrank adds (a live worker with a dead account beats a
      // new one not yet started); within each, soonest shift first.
      const shiftTime = (v: string | null) =>
        v ? new Date(v).getTime() : Number.MAX_SAFE_INTEGER;
      const fieldglassQueue = [...transferRows, ...addRows]
        .sort((x, y) => {
          if (x.kind !== y.kind) return x.kind === 'transfer' ? -1 : 1;
          return shiftTime(x.firstShiftAt) - shiftTime(y.firstShiftAt);
        })
        .slice(0, 12);

      const billed = weekBilled.reduce((sum, s) => sum + stAmount(s.snapshot), 0);
      const paidGross = weekRuns.reduce((sum, r) => sum + Number(r.totalGross), 0);
      const thisWeekStart = startOfWeekUTC(now);

      // The payroll case desk — PAYROLL-category HR cases are Finance's
      // tickets (missing paychecks, deduction questions). Open = anything
      // not yet resolved; assignedToMe = routed to this accountant.
      const CASE_OPEN = ['OPEN', 'IN_PROGRESS', 'WAITING_ASSOCIATE'] as const;
      const [casesOpen, casesMine] = await Promise.all([
        prisma.hrCase.count({
          where: { category: 'PAYROLL', status: { in: [...CASE_OPEN] } },
        }),
        prisma.hrCase.count({
          where: {
            category: 'PAYROLL',
            status: { in: [...CASE_OPEN] },
            assignedToId: req.user!.id,
          },
        }),
      ]);

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
        payrollCases: { open: casesOpen, assignedToMe: casesMine },
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
      // Stamp the client the worker is registered under NOW — completing
      // a transfer moves the stamp to the new client, which is exactly
      // what clears the transfer row from the queue.
      const { currentClientOf } = await import('../lib/fieldglassNotify.js');
      const current = await currentClientOf(associate.id);
      await prisma.fieldglassRegistration.upsert({
        where: { associateId: associate.id },
        create: {
          associateId: associate.id,
          addedById: req.user!.id,
          clientId: current?.id ?? null,
        },
        update: {
          addedById: req.user!.id,
          addedAt: new Date(),
          clientId: current?.id ?? null,
        },
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

// ----- The chase nudge -----------------------------------------------------
//
// Finance's hours-approval chase, without the phone call: one click on a
// chase bar pings the people who OWN those approvals — every Workforce
// Manager (field-wide) plus the shift supervisors bound to that client —
// with a deep link straight to the timesheet queue. Deduped to one nudge
// per client per org-day so a stressed accountant can't accidentally
// spam the field.

const NudgeInputSchema = z.object({
  clientId: z.string().uuid().nullable().optional(),
});

financeOverviewRouter.post(
  '/finance/close/nudge',
  requireCapability('process:payroll'),
  async (req, res, next) => {
    try {
      const input = NudgeInputSchema.parse(req.body ?? {});
      const clientId = input.clientId ?? null;
      const now = new Date();

      const client = clientId
        ? await prisma.client.findUnique({
            where: { id: clientId },
            select: { name: true },
          })
        : null;
      if (clientId && !client) {
        throw new HttpError(404, 'client_not_found', 'Client not found');
      }

      // Recompute the pending picture server-side — the nudge carries
      // live facts, not whatever the dashboard had cached.
      const pending = await prisma.timeEntry.findMany({
        where: {
          status: 'COMPLETED',
          clockOutAt: { not: null },
          ...(clientId ? { clientId } : {}),
        },
        select: {
          clockInAt: true,
          clockOutAt: true,
          breaks: { select: { type: true, startedAt: true, endedAt: true } },
        },
        take: 2000,
      });
      if (pending.length === 0) {
        return res.json({ notified: 0, deduped: false, pendingEntries: 0 });
      }
      let minutes = 0;
      for (const e of pending) {
        minutes += netWorkedMinutes(
          { clockInAt: e.clockInAt, clockOutAt: e.clockOutAt! },
          e.breaks,
        );
      }
      const hours = Math.round((minutes / 60) * 10) / 10;

      // One nudge per client per org-day. The linkUrl doubles as the
      // dedupe key carrier (same pattern as the Fieldglass notifications).
      const linkUrl = `/time-attendance?closeNudge=${clientId ?? 'all'}`;
      const dayStart = utcInstantOfLocalMidnight(orgDateKey(now), 'America/New_York');
      const already = await prisma.notification.findFirst({
        where: {
          category: 'finance.close_nudge',
          linkUrl,
          createdAt: { gte: dayStart },
        },
        select: { id: true },
      });
      if (already) {
        return res.json({ notified: 0, deduped: true, pendingEntries: pending.length });
      }

      const recipients = await prisma.user.findMany({
        where: {
          status: 'ACTIVE',
          OR: [
            { role: 'WORKFORCE_MANAGER' },
            ...(clientId
              ? [{ role: 'SHIFT_SUPERVISOR' as const, clientId }]
              : []),
          ],
          id: { not: req.user!.id },
        },
        select: { id: true },
      });
      const where = client ? ` at ${client.name}` : '';
      await Promise.all(
        recipients.map((r) =>
          notifyUser(r.id, {
            subject: 'Payroll close: timesheet approvals needed',
            body:
              `Finance is waiting on ${pending.length} completed timesheet${pending.length === 1 ? '' : 's'}` +
              ` (~${hours}h)${where} to close payroll. Please review and approve them today.`,
            category: 'finance.close_nudge',
            linkUrl,
          }),
        ),
      );
      res.json({ notified: recipients.length, deduped: false, pendingEntries: pending.length });
    } catch (err) {
      next(err);
    }
  },
);
