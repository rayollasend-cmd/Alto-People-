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
import { enqueueAudit } from '../lib/audit.js';
import { buildFieldglassPacket } from '../lib/fieldglassPacket.js';
import { buildFieldglassQueue, buildFieldglassRoster } from '../lib/fieldglassQueue.js';

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

      // The Fieldglass setup queue — the dashboard shows the top of it;
      // the Fieldglass setup page works all of it.
      const fullFieldglassQueue = await buildFieldglassQueue(now);
      const fieldglassQueue = fullFieldglassQueue.slice(0, 12);

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
        fieldglassQueueTotal: fullFieldglassQueue.length,
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

/**
 * GET /finance/fieldglass[?view=count] — the Fieldglass setup page: the
 * whole queue (add / transfer / close) and the roster of everyone
 * registered. `view=count` is just the queue's size, for the sidebar.
 */
financeOverviewRouter.get(
  '/finance/fieldglass',
  requireCapability('process:payroll'),
  async (req, res, next) => {
    try {
      const queue = await buildFieldglassQueue();
      if (req.query.view === 'count') {
        res.json({ count: queue.length });
        return;
      }
      res.json({ generatedAt: new Date().toISOString(), queue, roster: await buildFieldglassRoster() });
    } catch (err) {
      next(err);
    }
  },
);

/** A Fieldglass Worker ID — letters, digits and dashes ("WKR00012345"). */
const WorkerIdSchema = z.object({
  workerId: z
    .string()
    .trim()
    .max(40)
    .regex(/^[A-Za-z0-9._-]*$/, 'Letters, numbers and dashes only.')
    .transform((v) => v || undefined)
    .optional(),
});

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
      // The Worker ID Fieldglass gave them — what ties our hours to their
      // account. Optional here (it can come later, or from the import).
      const { workerId } = WorkerIdSchema.parse(req.body ?? {});
      const existing = await prisma.fieldglassRegistration.findUnique({
        where: { associateId: associate.id },
        select: { clientId: true, workerId: true },
      });
      // Same client: keep the ID on file unless a new one is given. A
      // transfer is a new Fieldglass account — its ID, or none yet.
      const sameClient = !!existing && existing.clientId === (current?.id ?? null);
      await prisma.fieldglassRegistration.upsert({
        where: { associateId: associate.id },
        create: {
          associateId: associate.id,
          addedById: req.user!.id,
          clientId: current?.id ?? null,
          workerId: workerId ?? null,
        },
        update: {
          addedById: req.user!.id,
          addedAt: new Date(),
          clientId: current?.id ?? null,
          workerId: workerId ?? (sameClient ? existing!.workerId : null),
        },
      });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /finance/fieldglass/:associateId/packet — everything the Fieldglass
 * "new worker" form asks for, in its order, and what's still missing. Date
 * of birth and SSN last 4 ride along, so every look is audited.
 */
financeOverviewRouter.get(
  '/finance/fieldglass/:associateId/packet',
  requireCapability('process:payroll'),
  async (req, res, next) => {
    try {
      const packet = await buildFieldglassPacket(z.string().uuid().parse(req.params.associateId));
      if (!packet) throw new HttpError(404, 'associate_not_found', 'Associate not found');
      enqueueAudit(
        {
          actorUserId: req.user!.id,
          action: 'associate.pii_viewed',
          entityType: 'Associate',
          entityId: packet.associateId,
          metadata: {
            purpose: 'fieldglass_registration',
            fields: ['dob', 'ssnLast4', 'travelDocLast4', 'securityId', 'address'],
          },
        },
        'associate.pii',
      );
      res.json({ packet });
    } catch (err) {
      next(err);
    }
  },
);

/** PATCH /finance/fieldglass/:associateId — { workerId }: record (or fix)
 *  the Fieldglass Worker ID on a registered worker. */
financeOverviewRouter.patch(
  '/finance/fieldglass/:associateId',
  requireCapability('process:payroll'),
  async (req, res, next) => {
    try {
      const { workerId } = WorkerIdSchema.parse(req.body ?? {});
      const updated = await prisma.fieldglassRegistration.updateMany({
        where: { associateId: z.string().uuid().parse(req.params.associateId) },
        data: { workerId: workerId ?? null },
      });
      if (updated.count === 0) {
        throw new HttpError(409, 'not_registered', 'Mark them added to Fieldglass first.');
      }
      res.json({ ok: true, workerId: workerId ?? null });
    } catch (err) {
      next(err);
    }
  },
);

/** PATCH /finance/fieldglass/:associateId/travel-doc — { last4 }: the last
 *  4 of a passport / travel document, for a worker with no SSN — what
 *  their Fieldglass Security ID ends in. Empty clears it. Audited. */
const TravelDocSchema = z.object({
  last4: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^([A-Z0-9]{3,4})?$/, 'The last 3 or 4 letters or digits of the document number.'),
});

financeOverviewRouter.patch(
  '/finance/fieldglass/:associateId/travel-doc',
  requireCapability('process:payroll'),
  async (req, res, next) => {
    try {
      const associateId = z.string().uuid().parse(req.params.associateId);
      const parsed = TravelDocSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new HttpError(400, 'invalid_body', parsed.error.issues[0]?.message ?? 'Invalid request body');
      }
      const updated = await prisma.associate.updateMany({
        where: { id: associateId, deletedAt: null },
        data: { travelDocLast4: parsed.data.last4 || null },
      });
      if (updated.count === 0) throw new HttpError(404, 'associate_not_found', 'Associate not found');
      enqueueAudit(
        {
          actorUserId: req.user!.id,
          action: 'associate.travel_doc_set',
          entityType: 'Associate',
          entityId: associateId,
          // Never the value itself — only that it changed.
          metadata: { cleared: !parsed.data.last4 },
        },
        'associate.pii',
      );
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
