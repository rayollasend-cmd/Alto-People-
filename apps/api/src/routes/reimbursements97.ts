import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { hasCapability } from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { recordReimbursementEvent } from '../lib/audit.js';

/**
 * Gap 10 — Reimbursement two-step approval + payroll-fold integration.
 *
 * Lifecycle:
 *   ASSOCIATE creates DRAFT → adds expense lines → submits
 *     ↓
 *   MANAGER reviews   → manager-approve (→ MANAGER_APPROVED)
 *                     → reject          (→ REJECTED)
 *     ↓
 *   HR / FINANCE      → settle           (→ SETTLED, queued for next run)
 *                     → reject           (→ REJECTED)
 *     ↓
 *   payrollRun.create() drains SETTLED rows → status PAID, payrollItemId
 *   stamped, amount added to PayrollItem.reimbursementsTotal (non-taxable
 *   net pay addition; never affects grossPay or any wage base).
 *
 * The Phase 97 single-step /decide and /mark-paid endpoints are removed —
 * the new flow uses /manager-approve, /settle, and /reject. Payment is
 * auto-stamped by payrollAggregator when the next REGULAR run is created.
 */

export const reimbursements97Router = Router();

// View list / detail. Associates always scoped to their own.
const VIEW = requireCapability('view:payroll');
// Submit / draft / add lines. Associates implicit via their associateId.
const SUBMIT = requireCapability('submit:reimbursement');
// Manager-approval step. Granted to MANAGER, OPERATIONS_MANAGER, HR_ADMINISTRATOR.
const APPROVE = requireCapability('approve:reimbursement');
// HR/Finance settle step. Granted to HR_ADMINISTRATOR, FINANCE_ACCOUNTANT.
const SETTLE = requireCapability('settle:reimbursement');

const ReimbursementInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(4000).optional().nullable(),
  currency: z.string().length(3).optional(),
});

const LineInputSchema = z.object({
  kind: z.enum(['RECEIPT', 'MILEAGE', 'PER_DIEM', 'OTHER']),
  description: z.string().trim().min(1).max(500),
  incurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'incurredOn must be YYYY-MM-DD'),
  amount: z.number().nonnegative(),
  miles: z.number().nonnegative().optional().nullable(),
  ratePerMile: z.number().nonnegative().optional().nullable(),
  receiptUrl: z.string().url().optional().nullable(),
  merchant: z.string().max(200).optional().nullable(),
  category: z.string().max(80).optional().nullable(),
});

const round2 = (n: number) => Math.round(n * 100) / 100;

async function recomputeTotal(reimbursementId: string): Promise<number> {
  const lines = await prisma.expenseLine.findMany({
    take: 100,
    where: { reimbursementId },
    select: { amount: true },
  });
  const total = round2(lines.reduce((sum, l) => sum + Number(l.amount), 0));
  await prisma.reimbursement.update({
    where: { id: reimbursementId },
    data: { totalAmount: new Prisma.Decimal(total) },
  });
  return total;
}

/**
 * GET /reimbursements — list. Associate scope is enforced server-side
 * (associates can never see another's row regardless of query params).
 */
reimbursements97Router.get('/reimbursements', VIEW, async (req, res) => {
  const associateId = z.string().uuid().optional().parse(req.query.associateId);
  const status = z
    .enum(['DRAFT', 'SUBMITTED', 'MANAGER_APPROVED', 'SETTLED', 'REJECTED', 'PAID'])
    .optional()
    .parse(req.query.status);
  const isAssociate = req.user!.role === 'ASSOCIATE';
  const myAssociateId = req.user!.associateId;
  const where: Prisma.ReimbursementWhereInput = {
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
      managerApprovedAt: r.managerApprovedAt?.toISOString() ?? null,
      settledAt: r.settledAt?.toISOString() ?? null,
      decidedAt: r.decidedAt?.toISOString() ?? null,
      paidAt: r.paidAt?.toISOString() ?? null,
      rejectionReason: r.rejectionReason,
      createdAt: r.createdAt.toISOString(),
    })),
  });
});

/**
 * POST /reimbursements — associate creates a new DRAFT.
 */
reimbursements97Router.post('/reimbursements', SUBMIT, async (req, res) => {
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
  await recordReimbursementEvent({
    actorUserId: req.user!.id,
    action: 'reimbursement.draft_created',
    reimbursementId: created.id,
    associateId,
    metadata: { title: input.title },
    req,
  });
  res.status(201).json({ id: created.id });
});

/**
 * GET /reimbursements/:id — full detail incl. lines.
 */
reimbursements97Router.get('/reimbursements/:id', VIEW, async (req, res) => {
  const r = await prisma.reimbursement.findUnique({
    where: { id: req.params.id },
    include: {
      associate: { select: { firstName: true, lastName: true, email: true } },
      lines: { orderBy: { incurredOn: 'asc' } },
    },
  });
  if (!r) throw new HttpError(404, 'not_found', 'Reimbursement not found.');
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
    managerApprovedById: r.managerApprovedById,
    managerApprovedAt: r.managerApprovedAt?.toISOString() ?? null,
    managerNote: r.managerNote,
    settledById: r.settledById,
    settledAt: r.settledAt?.toISOString() ?? null,
    settleNote: r.settleNote,
    decidedAt: r.decidedAt?.toISOString() ?? null,
    decidedById: r.decidedById,
    rejectionReason: r.rejectionReason,
    payrollItemId: r.payrollItemId,
    paidAt: r.paidAt?.toISOString() ?? null,
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

/**
 * POST /reimbursements/:id/lines — add an expense line. DRAFT or REJECTED
 * only. Mileage rows must declare miles + ratePerMile and amount is
 * server-computed as round2(miles * rate).
 */
reimbursements97Router.post('/reimbursements/:id/lines', SUBMIT, async (req, res) => {
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

  let amount = input.amount;
  if (input.kind === 'MILEAGE') {
    if (input.miles == null || input.ratePerMile == null) {
      throw new HttpError(
        400,
        'mileage_fields_required',
        'Mileage requires miles and ratePerMile.',
      );
    }
    amount = round2(input.miles * input.ratePerMile);
  }

  const created = await prisma.expenseLine.create({
    data: {
      reimbursementId: r.id,
      kind: input.kind,
      description: input.description,
      incurredOn: new Date(input.incurredOn),
      amount: new Prisma.Decimal(amount),
      miles: input.miles != null ? new Prisma.Decimal(input.miles) : null,
      ratePerMile: input.ratePerMile != null ? new Prisma.Decimal(input.ratePerMile) : null,
      receiptUrl: input.receiptUrl ?? null,
      merchant: input.merchant ?? null,
      category: input.category ?? null,
    },
  });
  const newTotal = await recomputeTotal(r.id);
  res.status(201).json({ id: created.id, totalAmount: newTotal.toFixed(2) });
});

/**
 * DELETE /expense-lines/:id — remove a line from a DRAFT/REJECTED.
 */
reimbursements97Router.delete('/expense-lines/:id', SUBMIT, async (req, res) => {
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

/**
 * POST /reimbursements/:id/submit — associate moves DRAFT/REJECTED into
 * SUBMITTED, awaiting manager approval. Total is recomputed; at least one
 * line is required.
 */
reimbursements97Router.post('/reimbursements/:id/submit', SUBMIT, async (req, res) => {
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
  await recomputeTotal(r.id);
  const updated = await prisma.reimbursement.update({
    where: { id: r.id },
    data: {
      status: 'SUBMITTED',
      submittedAt: new Date(),
      // Clear prior rejection so a resubmit isn't shown as still rejected.
      rejectionReason: null,
      decidedAt: null,
      decidedById: null,
    },
  });
  await recordReimbursementEvent({
    actorUserId: req.user!.id,
    action: 'reimbursement.submitted',
    reimbursementId: r.id,
    associateId: r.associateId,
    metadata: { totalAmount: updated.totalAmount.toString() },
    req,
  });
  res.json({ ok: true });
});

const ManagerApproveBodySchema = z.object({
  note: z.string().max(2000).trim().optional(),
});

/**
 * POST /reimbursements/:id/manager-approve — manager moves SUBMITTED into
 * MANAGER_APPROVED. Capability: approve:reimbursement.
 */
reimbursements97Router.post(
  '/reimbursements/:id/manager-approve',
  APPROVE,
  async (req, res) => {
    const input = ManagerApproveBodySchema.parse(req.body ?? {});
    const r = await prisma.reimbursement.findUnique({
      where: { id: req.params.id },
    });
    if (!r) throw new HttpError(404, 'not_found', 'Reimbursement not found.');
    if (r.status !== 'SUBMITTED') {
      throw new HttpError(409, 'invalid_state', `Cannot manager-approve ${r.status}.`);
    }
    await prisma.reimbursement.update({
      where: { id: r.id },
      data: {
        status: 'MANAGER_APPROVED',
        managerApprovedAt: new Date(),
        managerApprovedById: req.user!.id,
        managerNote: input.note?.length ? input.note : null,
      },
    });
    await recordReimbursementEvent({
      actorUserId: req.user!.id,
      action: 'reimbursement.manager_approved',
      reimbursementId: r.id,
      associateId: r.associateId,
      metadata: { note: input.note ?? null },
      req,
    });
    res.json({ ok: true });
  },
);

const SettleBodySchema = z.object({
  note: z.string().max(2000).trim().optional(),
  // HR can override the receipt-required guard on settle when a receipt
  // was lost; the waiver note carries the justification.
  waiveMissingReceipts: z.boolean().optional(),
  waiverNote: z.string().max(2000).trim().optional(),
});

/**
 * POST /reimbursements/:id/settle — HR/Finance moves MANAGER_APPROVED into
 * SETTLED. The row sits in the payroll-fold queue waiting for the next
 * REGULAR run. Capability: settle:reimbursement.
 *
 * Receipt-required guard: any RECEIPT line lacking receiptUrl blocks the
 * settle unless `waiveMissingReceipts=true` plus a `waiverNote` are
 * supplied (the note is stored on Reimbursement.receiptWaiverNote).
 */
reimbursements97Router.post(
  '/reimbursements/:id/settle',
  SETTLE,
  async (req, res) => {
    const input = SettleBodySchema.parse(req.body ?? {});
    const r = await prisma.reimbursement.findUnique({
      where: { id: req.params.id },
      include: { lines: true },
    });
    if (!r) throw new HttpError(404, 'not_found', 'Reimbursement not found.');
    if (r.status !== 'MANAGER_APPROVED') {
      throw new HttpError(409, 'invalid_state', `Cannot settle ${r.status}.`);
    }
    const linesMissingReceipt = r.lines.filter(
      (l) => l.kind === 'RECEIPT' && !l.receiptUrl,
    );
    if (linesMissingReceipt.length > 0 && !input.waiveMissingReceipts) {
      throw new HttpError(
        400,
        'receipts_required',
        `${linesMissingReceipt.length} receipt line(s) are missing a receipt. Pass waiveMissingReceipts=true with a waiverNote to override.`,
      );
    }
    if (input.waiveMissingReceipts && !input.waiverNote) {
      throw new HttpError(
        400,
        'waiver_note_required',
        'A waiver note is required when overriding the receipt-required guard.',
      );
    }
    await prisma.reimbursement.update({
      where: { id: r.id },
      data: {
        status: 'SETTLED',
        settledAt: new Date(),
        settledById: req.user!.id,
        settleNote: input.note?.length ? input.note : null,
        receiptWaiverNote: input.waiveMissingReceipts ? (input.waiverNote ?? null) : null,
      },
    });
    await recordReimbursementEvent({
      actorUserId: req.user!.id,
      action: 'reimbursement.settled',
      reimbursementId: r.id,
      associateId: r.associateId,
      metadata: {
        totalAmount: r.totalAmount.toString(),
        receiptsWaived: input.waiveMissingReceipts ? linesMissingReceipt.length : 0,
      },
      req,
    });
    res.json({ ok: true });
  },
);

const RejectBodySchema = z.object({
  reason: z.string().trim().min(1, 'reason is required').max(2000),
});

/**
 * POST /reimbursements/:id/reject — manager OR HR can reject. Manager
 * uses approve:reimbursement; HR uses settle:reimbursement. The handler
 * accepts either capability so a single endpoint serves both points in
 * the flow. Reason required.
 */
reimbursements97Router.post('/reimbursements/:id/reject', async (req, res) => {
  const user = req.user!;
  const hasApprove = hasCapability(user.role, 'approve:reimbursement');
  const hasSettle = hasCapability(user.role, 'settle:reimbursement');
  if (!hasApprove && !hasSettle) {
    throw new HttpError(403, 'forbidden', 'Insufficient capability to reject.');
  }
  const input = RejectBodySchema.parse(req.body ?? {});
  const r = await prisma.reimbursement.findUnique({
    where: { id: req.params.id },
  });
  if (!r) throw new HttpError(404, 'not_found', 'Reimbursement not found.');
  // Manager rejects SUBMITTED; HR rejects MANAGER_APPROVED. SETTLED + PAID
  // are terminal — no rejection from there (use void/amend at the payroll
  // layer if the issue is found post-settle).
  const allowed: ('SUBMITTED' | 'MANAGER_APPROVED')[] = [];
  if (hasApprove) allowed.push('SUBMITTED');
  if (hasSettle) allowed.push('MANAGER_APPROVED');
  if (!(allowed as string[]).includes(r.status)) {
    throw new HttpError(409, 'invalid_state', `Cannot reject ${r.status}.`);
  }
  await prisma.reimbursement.update({
    where: { id: r.id },
    data: {
      status: 'REJECTED',
      decidedAt: new Date(),
      decidedById: user.id,
      rejectionReason: input.reason,
    },
  });
  await recordReimbursementEvent({
    actorUserId: user.id,
    action: 'reimbursement.rejected',
    reimbursementId: r.id,
    associateId: r.associateId,
    metadata: { reason: input.reason, fromStatus: r.status },
    req,
  });
  res.json({ ok: true });
});
