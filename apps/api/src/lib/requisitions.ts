import type { PrismaClient } from '@prisma/client';
import { HttpError } from '../middleware/error.js';
import { enqueueAudit } from './audit.js';
import { emitWebhookEvent } from './webhookDispatch.js';
import { emit as emitWorkflow } from './workflow.js';
import { createApprovalRequest, type Decider } from './approvalRequests.js';
import { loadApprovalPolicy, secondPersonExists } from './approvalPolicy.js';
import { fmtDay } from './humanDates.js';

/**
 * Requisition → approval → posting. A position opens (status OPEN) only
 * through here: when the tenant requires it and a second manage:org holder
 * exists, an ApprovalRequest carries the seat's budget to them; otherwise
 * it opens at once. Opening fires the POSITION_OPENED workflows and webhook.
 */

export async function openPosition(db: PrismaClient, id: string, actorUserId: string | null, opts: { approvalRequestId?: string | null; note?: string | null } = {}): Promise<void> {
  const existing = await db.position.findUnique({ where: { id } });
  if (!existing || existing.deletedAt) throw new HttpError(404, 'not_found', 'Position not found.');
  if (existing.status === 'OPEN') return;
  const updated = await db.position.update({
    where: { id },
    data: { status: 'OPEN', ...(existing.filledByAssociateId ? { filledByAssociateId: null, filledAt: null } : {}) },
  });
  enqueueAudit(
    { actorUserId, action: 'position.status', entityType: 'Position', entityId: id, metadata: { from: existing.status, to: 'OPEN', approvalRequestId: opts.approvalRequestId ?? null, note: opts.note ?? null } },
    'positions.position.status',
  );
  await emitWorkflow({
    trigger: 'POSITION_OPENED',
    entityType: 'Position',
    entityId: id,
    clientId: updated.clientId,
    context: { position: { id: updated.id, code: updated.code, title: updated.title, budgetAmount: updated.budgetAmount ? Number(updated.budgetAmount) : null, budgetPeriod: updated.budgetPeriod } },
  });
  void emitWebhookEvent('position.opened', { positionId: updated.id, clientId: updated.clientId, code: updated.code, title: updated.title }, { clientId: updated.clientId });
}

/**
 * Ask to open a seat. Returns the approval when a second person has to
 * decide, or null when it opened at once.
 */
export async function requestOpenPosition(db: PrismaClient, id: string, requester: Decider) {
  const existing = await db.position.findUnique({ where: { id } });
  if (!existing || existing.deletedAt) throw new HttpError(404, 'not_found', 'Position not found.');
  if (existing.status === 'OPEN') return null;
  const policy = await loadApprovalPolicy(db);
  const needsSecond = policy.requisitionApproval && (await secondPersonExists(db, 'manage:org', requester.id));
  if (!needsSecond) {
    await openPosition(db, id, requester.id, { note: policy.requisitionApproval ? 'No second approver was available.' : null });
    return null;
  }
  if (existing.requisitionApprovalId) {
    const open = await db.approvalRequest.findUnique({ where: { id: existing.requisitionApprovalId } });
    if (open && open.status === 'PENDING') throw new HttpError(409, 'requisition_pending', 'This requisition is already waiting on a decision.');
  }
  const budget = existing.budgetAmount ? `$${Number(existing.budgetAmount).toLocaleString('en-US', { minimumFractionDigits: 2 })} ${existing.budgetPeriod === 'MONTHLY' ? 'per month' : 'per year'}` : 'no budget set';
  const request = await createApprovalRequest(db, {
    kind: 'REQUISITION',
    subjectType: 'Position',
    subjectId: id,
    title: `Open ${existing.code} · ${existing.title}`,
    summary: `${Number(existing.fteAuthorized)} FTE, ${budget}${existing.minHourlyRate || existing.maxHourlyRate ? `, $${existing.minHourlyRate ?? '—'}–$${existing.maxHourlyRate ?? '—'}/h` : ''}${existing.targetStartDate ? `, target start ${fmtDay(existing.targetStartDate, { year: true })}` : ''}.`,
    proposed: { positionId: id, status: 'OPEN', budgetAmount: existing.budgetAmount ? Number(existing.budgetAmount) : null, budgetPeriod: existing.budgetPeriod, fteAuthorized: Number(existing.fteAuthorized) },
    before: { status: existing.status },
    requesterUserId: requester.id,
    approver: { capability: 'manage:org' },
    clientId: existing.clientId,
  });
  await db.position.update({ where: { id }, data: { requisitionApprovalId: request.id } });
  return request;
}
