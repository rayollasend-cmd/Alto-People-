import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { invalidateUserCache, requireCapability } from '../middleware/auth.js';
import { releaseFutureShifts } from '../lib/deactivation.js';
import { purgeAssociateBiometrics } from '../lib/kioskMaintenance.js';
import { maybeNotifyFinanceDeparture } from '../lib/fieldglassNotify.js';
import { notifyAllAdmins, notifyManager, trackNotificationWork } from '../lib/notify.js';
import { emitWebhookEvent } from '../lib/webhookDispatch.js';
import {
  assertCanCloseAssignments,
  closeOpenAssignments,
} from '../lib/assignmentDates.js';

/**
 * Phase 119 â€” Separations + exit interviews.
 *
 * Reuses onboarding caps for symmetry â€” the same audience that hires people
 * processes their leave. The state machine is one-way: PLANNED â†’ IN_PROGRESS
 * â†’ COMPLETE.
 */

export const separation119Router = Router();

// Separations + exit-interview content are org-wide HR data â€”
// gate reads on view:hr-admin so associates with view:onboarding
// can't enumerate every termination across the company.
const VIEW = requireCapability('view:hr-admin');
const MANAGE = requireCapability('manage:onboarding');

const REASON = z.enum([
  'VOLUNTARY_OTHER_OPPORTUNITY',
  'VOLUNTARY_PERSONAL',
  'VOLUNTARY_RELOCATION',
  'VOLUNTARY_RETIREMENT',
  'INVOLUNTARY_PERFORMANCE',
  'INVOLUNTARY_LAYOFF',
  'INVOLUNTARY_MISCONDUCT',
  'END_OF_CONTRACT',
  'DECEASED',
  'OTHER',
]);

// ----- List ----------------------------------------------------------------

separation119Router.get('/separations', VIEW, async (req, res) => {
  const status = z
    .enum(['PLANNED', 'IN_PROGRESS', 'COMPLETE'])
    .optional()
    .parse(req.query.status);
  const reason = REASON.optional().parse(req.query.reason);

  const rows = await prisma.separation.findMany({
    take: 100,
    where: {
      ...(status ? { status } : {}),
      ...(reason ? { reason } : {}),
    },
    include: {
      associate: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
      initiatedBy: { select: { email: true } },
      completedBy: { select: { email: true } },
    },
    orderBy: { lastDayWorked: 'desc' },
  });
  res.json({
    separations: rows.map((s) => ({
      id: s.id,
      associateId: s.associateId,
      associateName: `${s.associate.firstName} ${s.associate.lastName}`,
      associateEmail: s.associate.email,
      reason: s.reason,
      status: s.status,
      noticeDate: s.noticeDate?.toISOString().slice(0, 10) ?? null,
      lastDayWorked: s.lastDayWorked.toISOString().slice(0, 10),
      finalPaycheckDate: s.finalPaycheckDate?.toISOString().slice(0, 10) ?? null,
      rating: s.rating,
      reasonNotes: s.reasonNotes,
      feedbackPositive: s.feedbackPositive,
      feedbackImprovement: s.feedbackImprovement,
      wouldRecommend: s.wouldRecommend,
      wouldReturn: s.wouldReturn,
      exitInterviewCompletedAt:
        s.exitInterviewCompletedAt?.toISOString() ?? null,
      initiatedByEmail: s.initiatedBy?.email ?? null,
      completedByEmail: s.completedBy?.email ?? null,
      completedAt: s.completedAt?.toISOString() ?? null,
    })),
  });
});

// ----- Summary -------------------------------------------------------------

separation119Router.get('/separations/summary', VIEW, async (req, res) => {
  const days = z.coerce.number().int().min(1).max(730).default(90).parse(
    req.query.days,
  );
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const cutoff = new Date(today);
  cutoff.setUTCDate(cutoff.getUTCDate() - days);

  const [planned, inProgress, completedRecent, byReason, exitInterviewCompleted] =
    await Promise.all([
      prisma.separation.count({ where: { status: 'PLANNED' } }),
      prisma.separation.count({ where: { status: 'IN_PROGRESS' } }),
      prisma.separation.count({
        where: { status: 'COMPLETE', completedAt: { gte: cutoff } },
      }),
      prisma.separation.groupBy({
        by: ['reason'],
        where: { lastDayWorked: { gte: cutoff } },
        _count: { _all: true },
      }),
      prisma.separation.count({
        where: {
          lastDayWorked: { gte: cutoff },
          exitInterviewCompletedAt: { not: null },
        },
      }),
    ]);

  const reasons: Record<string, number> = {};
  for (const r of byReason) reasons[r.reason] = r._count._all;

  // Average exit-interview rating across the window.
  const ratingAvg = await prisma.separation.aggregate({
    where: {
      lastDayWorked: { gte: cutoff },
      rating: { not: null },
    },
    _avg: { rating: true },
  });

  res.json({
    days,
    planned,
    inProgress,
    completedInWindow: completedRecent,
    exitInterviewCompletedInWindow: exitInterviewCompleted,
    averageRating: ratingAvg._avg.rating
      ? Math.round(ratingAvg._avg.rating * 10) / 10
      : null,
    byReason: reasons,
  });
});

// ----- Initiate ------------------------------------------------------------

const InitiateInputSchema = z.object({
  associateId: z.string().uuid(),
  reason: REASON,
  noticeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  lastDayWorked: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  finalPaycheckDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .nullable(),
});

separation119Router.post('/separations', MANAGE, async (req, res) => {
  const input = InitiateInputSchema.parse(req.body);
  const associate = await prisma.associate.findUnique({
    where: { id: input.associateId },
  });
  if (!associate || associate.deletedAt) {
    throw new HttpError(404, 'associate_not_found', 'Associate not found.');
  }
  // Dates in order, checked here rather than discovered later. A last day
  // worked before the notice date (or a final paycheck before the last day)
  // is a typo every time, and left alone it propagates into assignment
  // spans, final-pay timing and the audit packet.
  if (input.noticeDate && input.noticeDate > input.lastDayWorked) {
    throw new HttpError(
      400,
      'invalid_date_range',
      `The last day worked (${input.lastDayWorked}) is before the notice date (${input.noticeDate}). Check both dates.`,
    );
  }
  if (input.finalPaycheckDate && input.finalPaycheckDate < input.lastDayWorked) {
    throw new HttpError(
      400,
      'invalid_date_range',
      `The final paycheck date (${input.finalPaycheckDate}) is before the last day worked (${input.lastDayWorked}). Check both dates.`,
    );
  }
  // The last day worked also closes their open site assignment on
  // completion — refuse now if it already can't, so the conflict surfaces
  // while the form is still open instead of weeks later.
  await assertCanCloseAssignments(prisma, {
    associateId: input.associateId,
    endedAt: new Date(input.lastDayWorked),
    endLabel: 'last day worked',
  });
  try {
    const created = await prisma.separation.create({
      data: {
        associateId: input.associateId,
        reason: input.reason,
        noticeDate: input.noticeDate ? new Date(input.noticeDate) : null,
        lastDayWorked: new Date(input.lastDayWorked),
        finalPaycheckDate: input.finalPaycheckDate
          ? new Date(input.finalPaycheckDate)
          : null,
        initiatedById: req.user!.id,
      },
    });
    // Fire-and-forget after the write â€” never inside a transaction.
    const who = `${associate.firstName} ${associate.lastName}`;
    void notifyManager(input.associateId, {
      subject: 'Separation initiated for your report',
      body: `A separation was initiated for ${who} (reason: ${input.reason}). Last day worked: ${input.lastDayWorked}.`,
      category: 'separation',
      linkUrl: '/separations',
    });
    void notifyAllAdmins({
      subject: `Separation initiated: ${who}`,
      body: `${who}'s separation was initiated (reason: ${input.reason}). Last day worked: ${input.lastDayWorked}.`,
      category: 'separation',
      linkUrl: '/separations',
      excludeUserId: req.user!.id,
    });
    res.status(201).json({ id: created.id });
  } catch (err: unknown) {
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code: string }).code === 'P2002'
    ) {
      throw new HttpError(
        409,
        'already_separating',
        'Associate already has an in-flight separation. Complete it first.',
      );
    }
    throw err;
  }
});

// ----- Advance status ------------------------------------------------------

separation119Router.post(
  '/separations/:id/advance',
  MANAGE,
  async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const existing = await prisma.separation.findUnique({
      where: { id },
      include: {
        associate: { select: { firstName: true, lastName: true } },
      },
    });
    if (!existing) {
      throw new HttpError(404, 'not_found', 'Separation not found.');
    }
    if (existing.status === 'COMPLETE') {
      throw new HttpError(409, 'already_complete', 'Already complete.');
    }
    const next: 'IN_PROGRESS' | 'COMPLETE' =
      existing.status === 'PLANNED' ? 'IN_PROGRESS' : 'COMPLETE';
    // Completion DEACTIVATES the associate, atomically with the status
    // flip. Before this transaction existed, completing a separation
    // changed nothing outside the Separation row: the associate stayed
    // "Active" in the directory forever (status derives from having an
    // approved application) and their login kept working even though the
    // completion notice claimed "access revoked".
    const disabledUserIds: string[] = [];
    await prisma.$transaction(async (tx) => {
      await tx.separation.update({
        where: { id },
        data: {
          status: next,
          ...(next === 'COMPLETE'
            ? { completedAt: new Date(), completedById: req.user!.id }
            : {}),
        },
      });
      if (next !== 'COMPLETE') return;
      await tx.associate.update({
        where: { id: existing.associateId },
        data: { separatedAt: new Date() },
      });
      // Close any open site assignment as of the last day worked, so
      // location rosters and the audit packet's assignment spans reflect
      // reality. Guarded: a last day worked that precedes the start of the
      // assignment it closes is a 400 naming both dates, not a raw
      // constraint violation out of Postgres.
      await closeOpenAssignments(tx, {
        associateId: existing.associateId,
        endedAt: existing.lastDayWorked,
        endLabel: 'last day worked',
      });
      // Off every shift still ahead of them — completing a separation used
      // to leave the person assigned on the schedule indefinitely (same
      // rule as deactivation).
      await releaseFutureShifts(tx, existing.associateId, new Date(), 'Associate separated.');
      // Actually revoke access: disable the login and kill live sessions.
      const users = await tx.user.findMany({
        where: { associateId: existing.associateId, deletedAt: null, status: { not: 'DISABLED' } },
        select: { id: true },
      });
      if (users.length > 0) {
        await tx.user.updateMany({
          where: { id: { in: users.map((u) => u.id) } },
          data: { status: 'DISABLED', tokenVersion: { increment: 1 } },
        });
        disabledUserIds.push(...users.map((u) => u.id));
      }
    });
    for (const uid of disabledUserIds) invalidateUserCache(uid);
    // Phase 131 follow-up â€” when the offboarding completes, drop the
    // associate's selfies and face reference immediately rather than
    // waiting for the 90-day retention sweep. Punch rows stay for HR
    // audit; only the biometric bytes are removed. Best-effort: a
    // failure here is logged but doesn't block the status advance.
    if (next === 'COMPLETE') {
      try {
        await purgeAssociateBiometrics(prisma, existing.associateId);
      } catch (err) {
        console.warn(
          '[separation119] purgeAssociateBiometrics failed',
          { separationId: id, associateId: existing.associateId, err: err instanceof Error ? err.message : err },
        );
      }
      // The Finance baton: a separated worker with a live Fieldglass
      // registration is an open account at the client for someone who no
      // longer works here. Fire-and-forget — never blocks the completion.
      void trackNotificationWork(
        maybeNotifyFinanceDeparture(existing.associateId, existing.lastDayWorked),
      );
      // Outbound webhooks â€” the separation completing IS the termination
      // event (access revoked, biometrics purged). Ids + dates only.
      void emitWebhookEvent('associate.terminated', {
        associateId: existing.associateId,
        separationId: existing.id,
        reason: existing.reason,
        lastDayWorked: existing.lastDayWorked.toISOString().slice(0, 10),
      });
      const who = `${existing.associate.firstName} ${existing.associate.lastName}`;
      void notifyAllAdmins({
        subject: `Separation completed: ${who}`,
        body: `Separation completed for ${who} â€” access revoked, biometrics purged.`,
        category: 'separation',
        linkUrl: '/separations',
        excludeUserId: req.user!.id,
      });
    }
    res.json({ ok: true, status: next });
  },
);

// ----- Exit interview ------------------------------------------------------

const ExitInterviewInputSchema = z.object({
  rating: z.number().int().min(1).max(10).optional().nullable(),
  reasonNotes: z.string().max(2000).optional().nullable(),
  feedbackPositive: z.string().max(2000).optional().nullable(),
  feedbackImprovement: z.string().max(2000).optional().nullable(),
  wouldRecommend: z.boolean().optional().nullable(),
  wouldReturn: z.boolean().optional().nullable(),
});

separation119Router.post(
  '/separations/:id/exit-interview',
  MANAGE,
  async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const input = ExitInterviewInputSchema.parse(req.body);
    const existing = await prisma.separation.findUnique({ where: { id } });
    if (!existing) {
      throw new HttpError(404, 'not_found', 'Separation not found.');
    }
    await prisma.separation.update({
      where: { id },
      data: {
        rating: input.rating ?? null,
        reasonNotes: input.reasonNotes ?? null,
        feedbackPositive: input.feedbackPositive ?? null,
        feedbackImprovement: input.feedbackImprovement ?? null,
        wouldRecommend: input.wouldRecommend ?? null,
        wouldReturn: input.wouldReturn ?? null,
        exitInterviewCompletedAt: new Date(),
        exitInterviewByUserId: req.user!.id,
      },
    });
    res.json({ ok: true });
  },
);
