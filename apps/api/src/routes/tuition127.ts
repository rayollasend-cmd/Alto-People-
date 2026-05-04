import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireAuth, requireCapability } from '../middleware/auth.js';

/**
 * Phase 127 — Tuition reimbursement.
 *
 * Submit / view-mine: open to authenticated associates.
 * Approve / reject / mark-paid: gated by process:payroll (the same audience
 * that runs reimbursements).
 *
 * Status machine: SUBMITTED → APPROVED | REJECTED. APPROVED → PAID.
 */

export const tuition127Router = Router();

const PROCESS_PAYROLL = requireCapability('process:payroll');

// ----- Submit (associate) ---------------------------------------------------

const SubmitInputSchema = z.object({
  schoolName: z.string().min(1).max(200),
  programName: z.string().max(200).optional().nullable(),
  courseName: z.string().min(1).max(200),
  termStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  termEndDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amount: z.coerce.number().positive().max(1_000_000),
  currency: z.string().length(3).optional().default('USD'),
  receiptUrl: z.string().url().max(500).optional().nullable(),
});

tuition127Router.post('/tuition-requests', requireAuth, async (req, res) => {
  if (!req.user!.associateId) {
    throw new HttpError(
      403,
      'no_associate_record',
      'Only associates can submit tuition requests.',
    );
  }
  const input = SubmitInputSchema.parse(req.body);
  if (input.termEndDate < input.termStartDate) {
    throw new HttpError(
      400,
      'invalid_dates',
      'Term end must be on or after start.',
    );
  }
  const created = await prisma.tuitionRequest.create({
    data: {
      associateId: req.user!.associateId,
      schoolName: input.schoolName,
      programName: input.programName ?? null,
      courseName: input.courseName,
      termStartDate: new Date(input.termStartDate),
      termEndDate: new Date(input.termEndDate),
      amount: input.amount,
      currency: input.currency.toUpperCase(),
      receiptUrl: input.receiptUrl ?? null,
    },
  });
  res.status(201).json({ id: created.id });
});

// ----- My requests ----------------------------------------------------------

tuition127Router.get('/my/tuition-requests', requireAuth, async (req, res) => {
  if (!req.user!.associateId) {
    return res.json({ requests: [] });
  }
  const rows = await prisma.tuitionRequest.findMany({
    take: 100,
    where: { associateId: req.user!.associateId },
    orderBy: { createdAt: 'desc' },
  });
  res.json({
    requests: rows.map((r) => ({
      id: r.id,
      schoolName: r.schoolName,
      programName: r.programName,
      courseName: r.courseName,
      termStartDate: r.termStartDate.toISOString().slice(0, 10),
      termEndDate: r.termEndDate.toISOString().slice(0, 10),
      amount: r.amount.toString(),
      currency: r.currency,
      status: r.status,
      receiptUrl: r.receiptUrl,
      gradeReceived: r.gradeReceived,
      reviewerNotes: r.reviewerNotes,
      reviewedAt: r.reviewedAt?.toISOString() ?? null,
      paidAt: r.paidAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    })),
  });
});

// ----- Update grade after term --------------------------------------------

const GradeInputSchema = z.object({
  gradeReceived: z.string().min(1).max(20),
});

tuition127Router.post(
  '/tuition-requests/:id/grade',
  requireAuth,
  async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const input = GradeInputSchema.parse(req.body);
    const r = await prisma.tuitionRequest.findUnique({ where: { id } });
    if (!r) {
      throw new HttpError(404, 'not_found', 'Request not found.');
    }
    if (req.user!.associateId !== r.associateId) {
      throw new HttpError(403, 'not_owner', 'Only the requester can update.');
    }
    await prisma.tuitionRequest.update({
      where: { id },
      data: { gradeReceived: input.gradeReceived },
    });
    res.json({ ok: true });
  },
);

// ----- HR queue -------------------------------------------------------------

tuition127Router.get('/tuition-requests', PROCESS_PAYROLL, async (req, res) => {
  const status = z
    .enum(['SUBMITTED', 'APPROVED', 'REJECTED', 'PAID'])
    .optional()
    .parse(req.query.status);
  const rows = await prisma.tuitionRequest.findMany({
    take: 100,
    where: status ? { status } : {},
    include: {
      associate: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
      reviewedBy: { select: { email: true } },
      paidBy: { select: { email: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  res.json({
    requests: rows.map((r) => ({
      id: r.id,
      associateId: r.associateId,
      associateName: `${r.associate.firstName} ${r.associate.lastName}`,
      associateEmail: r.associate.email,
      schoolName: r.schoolName,
      programName: r.programName,
      courseName: r.courseName,
      termStartDate: r.termStartDate.toISOString().slice(0, 10),
      termEndDate: r.termEndDate.toISOString().slice(0, 10),
      amount: r.amount.toString(),
      currency: r.currency,
      status: r.status,
      receiptUrl: r.receiptUrl,
      gradeReceived: r.gradeReceived,
      reviewerNotes: r.reviewerNotes,
      reviewedByEmail: r.reviewedBy?.email ?? null,
      reviewedAt: r.reviewedAt?.toISOString() ?? null,
      paidByEmail: r.paidBy?.email ?? null,
      paidAt: r.paidAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    })),
  });
});

// ----- Decide ---------------------------------------------------------------

const DecideInputSchema = z.object({
  decision: z.enum(['APPROVED', 'REJECTED']),
  notes: z.string().max(2000).optional().nullable(),
});

tuition127Router.post(
  '/tuition-requests/:id/decide',
  PROCESS_PAYROLL,
  async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const input = DecideInputSchema.parse(req.body);
    const r = await prisma.tuitionRequest.findUnique({ where: { id } });
    if (!r) {
      throw new HttpError(404, 'not_found', 'Request not found.');
    }
    if (r.status !== 'SUBMITTED') {
      throw new HttpError(
        409,
        'not_pending',
        `Request is ${r.status}, cannot decide.`,
      );
    }
    await prisma.tuitionRequest.update({
      where: { id },
      data: {
        status: input.decision,
        reviewedById: req.user!.id,
        reviewedAt: new Date(),
        reviewerNotes: input.notes ?? null,
      },
    });
    res.json({ ok: true });
  },
);

// ----- Mark paid ------------------------------------------------------------

tuition127Router.post(
  '/tuition-requests/:id/pay',
  PROCESS_PAYROLL,
  async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const r = await prisma.tuitionRequest.findUnique({ where: { id } });
    if (!r) {
      throw new HttpError(404, 'not_found', 'Request not found.');
    }
    if (r.status !== 'APPROVED') {
      throw new HttpError(
        409,
        'not_approved',
        `Request is ${r.status}, only APPROVED can be paid.`,
      );
    }
    await prisma.tuitionRequest.update({
      where: { id },
      data: {
        status: 'PAID',
        paidById: req.user!.id,
        paidAt: new Date(),
      },
    });
    res.json({ ok: true });
  },
);

// ----- Summary --------------------------------------------------------------

tuition127Router.get('/tuition-summary', PROCESS_PAYROLL, async (_req, res) => {
  const [pending, approved, paidYtd] = await Promise.all([
    prisma.tuitionRequest.count({ where: { status: 'SUBMITTED' } }),
    prisma.tuitionRequest.count({ where: { status: 'APPROVED' } }),
    prisma.tuitionRequest.aggregate({
      where: {
        status: 'PAID',
        paidAt: { gte: new Date(`${new Date().getUTCFullYear()}-01-01`) },
      },
      _sum: { amount: true },
    }),
  ]);
  res.json({
    pendingCount: pending,
    approvedAwaitingPayment: approved,
    paidYtdAmount: paidYtd._sum.amount?.toString() ?? '0.00',
  });
});
