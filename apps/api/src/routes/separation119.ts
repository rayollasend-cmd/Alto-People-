import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { notifyAllAdmins, notifyManager } from '../lib/notify.js';
import { assertCanCloseAssignments } from '../lib/assignmentDates.js';
import { getLaborPolicy } from '../lib/stateLaborPolicy.js';
import { enqueueAudit } from '../lib/audit.js';
import { assertAssetsReturned, completeSeparation } from '../lib/separationComplete.js';
import { loadApprovalPolicy, secondPersonExists } from '../lib/approvalPolicy.js';
import { createApprovalRequest, pendingResponse } from '../lib/approvalRequests.js';

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
    if (next === 'IN_PROGRESS') {
      await prisma.separation.update({ where: { id }, data: { status: next } });
      res.json({ ok: true, status: next });
      return;
    }
    // Offboarding (HR pack 2026-10): nothing completes while company property
    // is still out, unless HR waives it with a reason that stays on the record.
    await assertAssetsReturned(existing.associateId, existing.assetsWaivedAt);
    // Approval engine: completing a separation is the termination event, so
    // it takes a second person where one exists (the tenant's switch).
    const policy = await loadApprovalPolicy(prisma);
    const who = `${existing.associate.firstName} ${existing.associate.lastName}`;
    if (policy.separationSecondPerson && (await secondPersonExists(prisma, 'manage:onboarding', req.user!.id))) {
      const open = await prisma.approvalRequest.findFirst({ where: { kind: 'SEPARATION_COMPLETE', subjectId: id, status: 'PENDING' } });
      if (open) throw new HttpError(409, 'approval_pending', 'This separation is already waiting on a second person.');
      const request = await createApprovalRequest(prisma, {
        kind: 'SEPARATION_COMPLETE',
        subjectType: 'Separation',
        subjectId: id,
        title: `Complete ${who}'s separation`,
        summary: `${existing.reason.replace(/_/g, ' ').toLowerCase()} · last day ${existing.lastDayWorked.toISOString().slice(0, 10)}. Completing revokes access, ends the employment record and purges biometrics.`,
        proposed: { separationId: id, status: 'COMPLETE' },
        before: { status: existing.status },
        requesterUserId: req.user!.id,
        approver: { capability: 'manage:onboarding' },
        associateId: existing.associateId,
      });
      res.status(202).json(pendingResponse(request));
      return;
    }
    await completeSeparation(id, req.user!.id, { note: policy.separationSecondPerson ? 'No second approver was available.' : null });
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

// ----- Offboarding: final pay preview + asset return (HR pack 2026-10) -------
//
// Final pay is a PREVIEW, not a payment: unpaid approved hours and hours
// still awaiting approval, the leave balances (vacation and PTO are paid out
// where the policy says so; sick is not), the current rate, and the day the
// state requires the last check by. The snapshot is kept on the separation
// so the packet shows what HR saw.

/** State final-paycheck deadlines, in days after the last day worked, by how the person left.
 *  Null = the next regular payday. The states Alto runs in are named; the rest fall to federal (next payday). */
const FINAL_PAY_DEADLINE: Record<string, { involuntary: number | null; voluntary: number | null; note: string }> = {
  CA: { involuntary: 0, voluntary: 3, note: 'California: immediately on discharge; within 72 hours of a resignation without notice.' },
  CO: { involuntary: 0, voluntary: null, note: 'Colorado: immediately on discharge; next payday on resignation.' },
  MA: { involuntary: 0, voluntary: null, note: 'Massachusetts: the day of discharge; next payday on resignation.' },
  NV: { involuntary: 3, voluntary: 7, note: 'Nevada: within 3 days of discharge; 7 days or next payday on resignation.' },
  IL: { involuntary: null, voluntary: null, note: 'Illinois: by the next regular payday.' },
  NY: { involuntary: null, voluntary: null, note: 'New York: by the next regular payday.' },
  TX: { involuntary: 6, voluntary: null, note: 'Texas: within 6 days of discharge; next payday on resignation.' },
  AZ: { involuntary: 7, voluntary: null, note: 'Arizona: within 7 working days or the next payday, whichever is sooner, on discharge.' },
  FL: { involuntary: null, voluntary: null, note: 'Florida sets no deadline; federal law requires the next regular payday.' },
  AL: { involuntary: null, voluntary: null, note: 'Alabama sets no deadline; federal law requires the next regular payday.' },
  GA: { involuntary: null, voluntary: null, note: 'Georgia sets no deadline; federal law requires the next regular payday.' },
};

separation119Router.get('/separations/:id/offboarding', VIEW, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const s = await prisma.separation.findUnique({
    where: { id },
    include: {
      associate: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          state: true,
          compRecords: { where: { effectiveTo: null }, take: 1, select: { payType: true, amount: true } },
          timeOffBalances: { select: { category: true, balanceMinutes: true } },
          assetAssignments: {
            where: { returnedAt: null },
            include: { asset: { select: { id: true, kind: true, label: true, serial: true } } },
          },
          payrollSchedule: { select: { name: true, frequency: true } },
        },
      },
    },
  });
  if (!s) throw new HttpError(404, 'not_found', 'Separation not found.');
  const a = s.associate;
  // Paid through the last finalized run that carried this person: approved
  // hours after it are the ones the final check still owes.
  const lastPaid = await prisma.payrollItem.findFirst({
    where: { associateId: a.id, payrollRun: { status: { in: ['FINALIZED', 'DISBURSED'] } } },
    orderBy: { payrollRun: { periodEnd: 'desc' } },
    select: { payrollRun: { select: { periodEnd: true } } },
  });
  const paidThrough = lastPaid ? new Date(lastPaid.payrollRun.periodEnd.getTime() + 86_400_000) : null;
  const [approved, awaiting] = await Promise.all([
    prisma.timeEntry.findMany({
      where: { associateId: a.id, status: 'APPROVED', clockOutAt: { not: null }, ...(paidThrough ? { clockInAt: { gte: paidThrough } } : {}) },
      select: { clockInAt: true, clockOutAt: true },
    }),
    prisma.timeEntry.findMany({ where: { associateId: a.id, status: 'COMPLETED', clockOutAt: { not: null } }, select: { clockInAt: true, clockOutAt: true } }),
  ]);
  const hours = (rows: { clockInAt: Date; clockOutAt: Date | null }[]) =>
    Math.round(rows.reduce((sum, r) => sum + ((r.clockOutAt?.getTime() ?? r.clockInAt.getTime()) - r.clockInAt.getTime()) / 3_600_000, 0) * 100) / 100;
  const comp = a.compRecords[0] ?? null;
  const hourly = comp?.payType === 'HOURLY' ? Number(comp.amount) : comp ? Number(comp.amount) / 2080 : null;
  const unpaidHours = hours(approved);
  const awaitingHours = hours(awaiting);
  const payable = a.timeOffBalances.filter((b) => (b.category === 'VACATION' || b.category === 'PTO') && b.balanceMinutes > 0);
  const leaveHours = Math.round((payable.reduce((sum, b) => sum + b.balanceMinutes, 0) / 60) * 100) / 100;
  const state = (a.state ?? '').toUpperCase();
  const rule = FINAL_PAY_DEADLINE[state] ?? { involuntary: null, voluntary: null, note: 'No state deadline on file; federal law requires the next regular payday.' };
  const involuntary = s.reason.startsWith('INVOLUNTARY');
  const days = involuntary ? rule.involuntary : rule.voluntary;
  const deadline = days === null ? null : new Date(s.lastDayWorked.getTime() + days * 86_400_000).toISOString().slice(0, 10);
  const policy = getLaborPolicy(state || null);
  const snapshot = {
    computedAt: new Date().toISOString(),
    state: state || null,
    rate: hourly,
    payType: comp?.payType ?? null,
    paidThrough: paidThrough ? paidThrough.toISOString().slice(0, 10) : null,
    unpaidApprovedHours: unpaidHours,
    awaitingApprovalHours: awaitingHours,
    leavePayoutHours: leaveHours,
    leaveBalances: a.timeOffBalances.map((b) => ({ category: b.category, hours: Math.round((b.balanceMinutes / 60) * 100) / 100, paidOut: b.category === 'VACATION' || b.category === 'PTO' })),
    estimatedGross: hourly === null ? null : Math.round((unpaidHours + leaveHours) * hourly * 100) / 100,
    deadline: { date: deadline, basis: deadline ? `${days} day${days === 1 ? '' : 's'} after the last day worked` : 'next regular payday', note: rule.note, minimumWageCents: policy.minimumWageCents },
    paySchedule: a.payrollSchedule ? { name: a.payrollSchedule.name, frequency: a.payrollSchedule.frequency } : null,
    finalPaycheckDate: s.finalPaycheckDate?.toISOString().slice(0, 10) ?? null,
    finalPaycheckLate: deadline && s.finalPaycheckDate ? s.finalPaycheckDate.toISOString().slice(0, 10) > deadline : false,
  };
  await prisma.separation.update({ where: { id }, data: { finalPaySnapshot: snapshot } });
  res.json({
    separationId: id,
    associateName: `${a.firstName} ${a.lastName}`.trim(),
    finalPay: snapshot,
    assets: {
      outstanding: a.assetAssignments.map((x) => ({ assignmentId: x.id, assetId: x.asset.id, kind: x.asset.kind, label: x.asset.label, serial: x.asset.serial, assignedAt: x.assignedAt.toISOString() })),
      waivedAt: s.assetsWaivedAt?.toISOString() ?? null,
      waiveReason: s.assetsWaiveReason,
      clear: a.assetAssignments.length === 0 || Boolean(s.assetsWaivedAt),
    },
    access: {
      // Access removal is part of completion; before that, the login is live.
      removed: s.status === 'COMPLETE',
      activeLogins: s.status === 'COMPLETE' ? 0 : await prisma.user.count({ where: { associateId: a.id, deletedAt: null, status: { not: 'DISABLED' } } }),
    },
  });
});

separation119Router.post('/separations/:id/assets/waive', MANAGE, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const reason = z.string().trim().min(3).max(500).parse(req.body?.reason);
  const s = await prisma.separation.findUnique({ where: { id } });
  if (!s) throw new HttpError(404, 'not_found', 'Separation not found.');
  if (s.status === 'COMPLETE') throw new HttpError(409, 'already_complete', 'Already complete.');
  await prisma.separation.update({ where: { id }, data: { assetsWaivedAt: new Date(), assetsWaivedById: req.user!.id, assetsWaiveReason: reason } });
  enqueueAudit(
    { actorUserId: req.user!.id, action: 'separation.assets_waived', entityType: 'Separation', entityId: id, metadata: { associateId: s.associateId, reason } },
    'separation.assets_waived',
  );
  res.json({ ok: true });
});
