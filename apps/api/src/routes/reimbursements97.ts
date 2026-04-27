import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';

/**
 * Phase 97 — Spend management: reimbursements + expense lines.
 *
 * Lifecycle: associate creates DRAFT → adds lines → submits → manager
 * approves or rejects → finance attaches to next payroll run when paid.
 * Total is recomputed on every line add/remove/update so we never
 * trust a client-supplied total.
 */

export const reimbursements97Router = Router();

const VIEW = requireCapability('view:payroll');
const MANAGE = requireCapability('process:payroll');

const ReimbursementInputSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(4000).optional().nullable(),
  currency: z.string().length(3).optional(),
});

const LineInputSchema = z.object({
  kind: z.enum(['RECEIPT', 'MILEAGE', 'PER_DIEM', 'OTHER']),
  description: z.string().min(1).max(500),
  incurredOn: z.string(),
  amount: z.number().nonnegative(),
  miles: z.number().nonnegative().optional().nullable(),
  ratePerMile: z.number().nonnegative().optional().nullable(),
  receiptUrl: z.string().url().optional().nullable(),
  merchant: z.string().max(200).optional().nullable(),
  category: z.string().max(80).optional().nullable(),
});

async function recomputeTotal(reimbursementId: string): Promise<void> {
  const lines = await prisma.expenseLine.findMany({
    where: { reimbursementId },
    select: { amount: true },
  });
  const total = lines.reduce((sum, l) => sum + Number(l.amount), 0);
  await prisma.reimbursement.update({
    where: { id: reimbursementId },
    data: { totalAmount: total },
  });
}

reimbursements97Router.get('/reimbursements', VIEW, async (req, res) => {
  const associateId = z.string().uuid().optional().parse(req.query.associateId);
  const status = z
    .enum(['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'PAID'])
    .optional()
    .parse(req.query.status);
  // ASSOCIATEs only see their own — others can pass associateId to filter,
  // or omit it for the full list.
  const isAssociate = req.user!.role === 'ASSOCIATE';
  const myAssociateId = req.user!.associateId;
  const where = {
    ...(isAssociate
      ? { associateId: myAssociateId ?? '__none__' }
      : associateId
        ? { associateId }
        : {}),
    ...(status ? { status } : {}),
  };
  const rows = await prisma.reimbursement.findMany({
    where,
    include: {
      associate: { select: { firstName: true, lastName: true, email: true } },
      _count: { select: { lines: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  res.json({
    reimbursements: rows.map((r) => ({
      id: r.id,
      associateId: r.associateId,
      associateName: `${r.associate.firstName} ${r.associate.lastName}`,
      title: r.title,
      description: r.description,
      totalAmount: r.totalAmount.toString(),
      currency: r.currency,
      status: r.status,
      lineCount: r._count.lines,
      submittedAt: r.submittedAt?.toISOString() ?? null,
      decidedAt: r.decidedAt?.toISOString() ?? null,
      paidAt: r.paidAt?.toISOString() ?? null,
      rejectionReason: r.rejectionReason,
      createdAt: r.createdAt.toISOString(),
    })),
  });
});

reimbursements97Router.post('/reimbursements', async (req, res) => {
  const input = ReimbursementInputSchema.parse(req.body);
  const associateId = req.user!.associateId;
  if (!associateId) {
    throw new HttpError(
      403,
      'no_associate',
      'Only users linked to an associate can submit reimbursements.',
    );
  }
  const created = await prisma.reimbursement.create({
    data: {
      associateId,
      title: input.title,
      description: input.description ?? null,
      currency: input.currency ?? 'USD',
    },
  });
  res.status(201).json({ id: created.id });
});

reimbursements97Router.get('/reimbursements/:id', VIEW, async (req, res) => {
  const r = await prisma.reimbursement.findUnique({
    where: { id: req.params.id },
    include: {
      associate: { select: { firstName: true, lastName: true, email: true } },
      lines: { orderBy: { incurredOn: 'asc' } },
    },
  });
  if (!r) throw new HttpError(404, 'not_found', 'Reimbursement not found.');
  // Associate can only see their own.
  if (req.user!.role === 'ASSOCIATE' && r.associateId !== req.user!.associateId) {
    throw new HttpError(404, 'not_found', 'Reimbursement not found.');
  }
  res.json({
    id: r.id,
    associateId: r.associateId,
    associateName: `${r.associate.firstName} ${r.associate.lastName}`,
    title: r.title,
    description: r.description,
    totalAmount: r.totalAmount.toString(),
    currency: r.currency,
    status: r.status,
    submittedAt: r.submittedAt?.toISOString() ?? null,
    decidedAt: r.decidedAt?.toISOString() ?? null,
    paidAt: r.paidAt?.toISOString() ?? null,
    rejectionReason: r.rejectionReason,
    lines: r.lines.map((l) => ({
      id: l.id,
      kind: l.kind,
      description: l.description,
      incurredOn: l.incurredOn.toISOString().slice(0, 10),
      amount: l.amount.toString(),
      miles: l.miles?.toString() ?? null,
      ratePerMile: l.ratePerMile?.toString() ?? null,
      receiptUrl: l.receiptUrl,
      merchant: l.merchant,
      category: l.category,
    })),
  });
});

reimbursements97Router.post('/reimbursements/:id/lines', async (req, res) => {
  const input = LineInputSchema.parse(req.body);
  const r = await prisma.reimbursement.findUnique({ where: { id: req.params.id } });
  if (!r) throw new HttpError(404, 'not_found', 'Reimbursement not found.');
  if (r.associateId !== req.user!.associateId && req.user!.role === 'ASSOCIATE') {
    throw new HttpError(403, 'forbidden', 'Not yours.');
  }
  if (r.status !== 'DRAFT' && r.status !== 'REJECTED') {
    throw new HttpError(
      409,
      'invalid_state',
      `Cannot add lines to ${r.status} reimbursement. Resubmit a new one.`,
    );
  }

  // Mileage: amount = miles * rate. Validate consistency.
  let amount = input.amount;
  if (input.kind === 'MILEAGE') {
    if (input.miles == null || input.ratePerMile == null) {
      throw new HttpError(
        400,
        'mileage_fields_required',
        'Mileage requires miles and ratePerMile.',
      );
    }
    amount = input.miles * input.ratePerMile;
  }

  const created = await prisma.expenseLine.create({
    data: {
      reimbursementId: r.id,
      kind: input.kind,
      description: input.description,
      incurredOn: new Date(input.incurredOn),
      amount,
      miles: input.miles ?? null,
      ratePerMile: input.ratePerMile ?? null,
      receiptUrl: input.receiptUrl ?? null,
      merchant: input.merchant ?? null,
      category: input.category ?? null,
    },
  });
  await recomputeTotal(r.id);
  res.status(201).json({ id: created.id });
});

reimbursements97Router.delete('/expense-lines/:id', async (req, res) => {
  const line = await prisma.expenseLine.findUnique({
    where: { id: req.params.id },
    include: { reimbursement: true },
  });
  if (!line) throw new HttpError(404, 'not_found', 'Line not found.');
  if (
    req.user!.role === 'ASSOCIATE' &&
    line.reimbursement.associateId !== req.user!.associateId
  ) {
    throw new HttpError(403, 'forbidden', 'Not yours.');
  }
  if (
    line.reimbursement.status !== 'DRAFT' &&
    line.reimbursement.status !== 'REJECTED'
  ) {
    throw new HttpError(
      409,
      'invalid_state',
      `Cannot remove lines from ${line.reimbursement.status}.`,
    );
  }
  await prisma.expenseLine.delete({ where: { id: line.id } });
  await recomputeTotal(line.reimbursementId);
  res.status(204).end();
});

reimbursements97Router.post('/reimbursements/:id/submit', async (req, res) => {
  const r = await prisma.reimbursement.findUnique({
    where: { id: req.params.id },
    include: { _count: { select: { lines: true } } },
  });
  if (!r) throw new HttpError(404, 'not_found', 'Reimbursement not found.');
  if (req.user!.role === 'ASSOCIATE' && r.associateId !== req.user!.associateId) {
    throw new HttpError(403, 'forbidden', 'Not yours.');
  }
  if (r.status !== 'DRAFT' && r.status !== 'REJECTED') {
    throw new HttpError(409, 'invalid_state', `Cannot submit ${r.status}.`);
  }
  if (r._count.lines === 0) {
    throw new HttpError(400, 'no_lines', 'Add at least one line before submitting.');
  }
  await prisma.reimbursement.update({
    where: { id: r.id },
    data: {
      status: 'SUBMITTED',
      submittedAt: new Date(),
      rejectionReason: null,
    },
  });
  res.json({ ok: true });
});

reimbursements97Router.post(
  '/reimbursements/:id/decide',
  MANAGE,
  async (req, res) => {
    const decision = z.enum(['APPROVED', 'REJECTED']).parse(req.body?.decision);
    const reason = z.string().max(2000).optional().parse(req.body?.reason);
    const r = await prisma.reimbursement.findUnique({
      where: { id: req.params.id },
    });
    if (!r) throw new HttpError(404, 'not_found', 'Reimbursement not found.');
    if (r.status !== 'SUBMITTED') {
      throw new HttpError(409, 'invalid_state', `Cannot decide ${r.status}.`);
    }
    if (decision === 'REJECTED' && !reason) {
      throw new HttpError(400, 'reason_required', 'Rejection reason is required.');
    }
    await prisma.reimbursement.update({
      where: { id: r.id },
      data: {
        status: decision,
        decidedAt: new Date(),
        decidedById: req.user!.id,
        rejectionReason: decision === 'REJECTED' ? (reason ?? null) : null,
      },
    });
    res.json({ ok: true });
  },
);

reimbursements97Router.post(
  '/reimbursements/:id/mark-paid',
  MANAGE,
  async (req, res) => {
    const payrollRunId = z
      .string()
      .uuid()
      .optional()
      .nullable()
      .parse(req.body?.payrollRunId);
    const r = await prisma.reimbursement.findUnique({
      where: { id: req.params.id },
    });
    if (!r) throw new HttpError(404, 'not_found', 'Reimbursement not found.');
    if (r.status !== 'APPROVED') {
      throw new HttpError(409, 'invalid_state', `Cannot pay ${r.status}.`);
    }
    await prisma.reimbursement.update({
      where: { id: r.id },
      data: {
        status: 'PAID',
        paidAt: new Date(),
        paidPayrollRunId: payrollRunId ?? null,
      },
    });
    res.json({ ok: true });
  },
);
