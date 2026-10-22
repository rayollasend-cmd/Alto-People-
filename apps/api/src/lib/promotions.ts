import { Prisma, type PrismaClient } from '@prisma/client';
import type { Promotion as PromotionDto, PromotionInput } from '@alto-people/shared';
import { prisma as defaultPrisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { enqueueAudit, recordDocumentEvent } from './audit.js';
import { recordChange } from './associateHistory.js';
import { getBlobStore, tenantBlobKey } from './blobStore.js';
import { renderLetterPdf } from './letterPdf.js';
import { getBrandingSync } from './branding.js';
import { notifyAssociate, notifyManager } from './notify.js';
import { tenantIdForWrite } from './tenant.js';
import { createApprovalRequest, type Decider } from './approvalRequests.js';
import { applyPayRateChange, currentComp } from './payChanges.js';

/**
 * A promotion as one record: the new seat (job profile, title, level), the
 * new pay and the date. It goes to a second person (manage:comp) and, once
 * approved, lands as a comp record (reason PROMOTION), an org assignment
 * with history, and a letter filed in the person's documents.
 */

type Db = PrismaClient | Prisma.TransactionClient;

async function nameOf(db: Db, userId: string | null): Promise<{ id: string; name: string } | null> {
  if (!userId) return null;
  const u = await db.user.findUnique({ where: { id: userId }, select: { id: true, email: true, displayName: true, associate: { select: { firstName: true, lastName: true } } } });
  return u ? { id: u.id, name: u.displayName ?? (u.associate ? `${u.associate.firstName} ${u.associate.lastName}`.trim() : u.email) } : null;
}

export async function shapePromotion(db: Db, p: Prisma.PromotionGetPayload<Record<string, never>>): Promise<PromotionDto> {
  const [associate, profile, requestedBy, current] = await Promise.all([
    db.associate.findUnique({ where: { id: p.associateId }, select: { firstName: true, lastName: true } }),
    p.jobProfileId ? db.jobProfile.findUnique({ where: { id: p.jobProfileId }, select: { title: true } }) : null,
    nameOf(db, p.requestedById),
    currentComp(db, p.associateId),
  ]);
  return {
    id: p.id,
    associateId: p.associateId,
    associateName: associate ? `${associate.firstName} ${associate.lastName}`.trim() : '',
    jobProfileId: p.jobProfileId,
    jobProfileTitle: profile?.title ?? null,
    newTitle: p.newTitle,
    level: p.level,
    payType: p.payType,
    amount: p.amount ? p.amount.toFixed(2) : null,
    currentAmount: current ? current.amount.toFixed(2) : null,
    effectiveFrom: p.effectiveFrom.toISOString().slice(0, 10),
    notes: p.notes,
    status: p.status,
    approvalRequestId: p.approvalRequestId,
    requestedBy,
    letterDocumentId: p.letterDocumentId,
    appliedAt: p.appliedAt?.toISOString() ?? null,
    createdAt: p.createdAt.toISOString(),
  };
}

/** Open a promotion: the record, and the approval that decides it. */
export async function proposePromotion(db: PrismaClient, input: PromotionInput, requester: Decider): Promise<PromotionDto> {
  const associate = await db.associate.findUnique({ where: { id: input.associateId }, select: { id: true, firstName: true, lastName: true, deletedAt: true, jobProfile: { select: { title: true } } } });
  if (!associate || associate.deletedAt) throw new HttpError(404, 'not_found', 'Associate not found.');
  if (!input.jobProfileId && !input.newTitle && !input.level && input.amount == null) {
    throw new HttpError(400, 'nothing_changes', 'A promotion changes the seat, the level or the pay — name at least one.');
  }
  if (input.jobProfileId) {
    const profile = await db.jobProfile.findFirst({ where: { id: input.jobProfileId, deletedAt: null }, select: { id: true } });
    if (!profile) throw new HttpError(404, 'not_found', 'Job profile not found.');
  }
  const open = await db.promotion.findFirst({ where: { associateId: input.associateId, status: 'PENDING' }, select: { id: true } });
  if (open) throw new HttpError(409, 'promotion_open', 'A promotion for this person is already waiting on a decision.');
  const current = await currentComp(db, input.associateId);
  const who = `${associate.firstName} ${associate.lastName}`.trim();
  const promotion = await db.promotion.create({
    data: {
      tenantId: tenantIdForWrite(),
      associateId: input.associateId,
      jobProfileId: input.jobProfileId ?? null,
      newTitle: input.newTitle ?? null,
      level: input.level ?? null,
      payType: input.payType ?? (input.amount != null ? (current?.payType ?? 'HOURLY') : null),
      amount: input.amount != null ? new Prisma.Decimal(input.amount) : null,
      effectiveFrom: new Date(`${input.effectiveFrom}T00:00:00.000Z`),
      notes: input.notes ?? null,
      requestedById: requester.id,
    },
  });
  const parts: string[] = [];
  if (input.newTitle) parts.push(`to ${input.newTitle}`);
  if (input.level) parts.push(`level ${input.level}`);
  if (input.amount != null) parts.push(`${current ? `$${current.amount.toFixed(2)} → ` : ''}$${input.amount.toFixed(2)}`);
  const request = await createApprovalRequest(db, {
    kind: 'PROMOTION',
    subjectType: 'Promotion',
    subjectId: promotion.id,
    title: `Promote ${who}${parts.length ? ` ${parts.join(', ')}` : ''}`,
    summary: `Effective ${input.effectiveFrom}.${input.notes ? ` ${input.notes}` : ''}`,
    proposed: { promotionId: promotion.id, ...input },
    before: { jobProfileTitle: associate.jobProfile?.title ?? null, amount: current?.amount ?? null, payType: current?.payType ?? null },
    requesterUserId: requester.id,
    approver: { capability: 'manage:comp' },
    associateId: input.associateId,
  });
  const linked = await db.promotion.update({ where: { id: promotion.id }, data: { approvalRequestId: request.id } });
  enqueueAudit({ actorUserId: requester.id, action: 'promotion.proposed', entityType: 'Promotion', entityId: promotion.id, metadata: { associateId: input.associateId, approvalRequestId: request.id } }, 'promotions.propose');
  return shapePromotion(db, linked);
}

function letterBody(opts: { orgName: string; who: string; title: string | null; level: string | null; amount: string | null; payType: 'HOURLY' | 'SALARY' | null; effectiveFrom: string }): string {
  const lines = [
    `Dear ${opts.who},`,
    `Congratulations. Effective ${opts.effectiveFrom}, ${opts.orgName} is pleased to confirm your promotion${opts.title ? ` to ${opts.title}` : ''}${opts.level ? ` (level ${opts.level})` : ''}.`,
  ];
  if (opts.amount) lines.push(`Your new rate of pay is $${opts.amount} ${opts.payType === 'SALARY' ? 'per year' : 'per hour'}, from the same date.`);
  lines.push('Everything else about your employment stays as it is. Thank you for the work that earned this.', `${opts.orgName}`);
  return lines.join('\n\n');
}

/** The approved promotion lands: comp record, org assignment with history, the letter. */
export async function applyPromotion(db: PrismaClient, promotionId: string, decider: Decider, approvalRequestId: string | null): Promise<void> {
  const p = await db.promotion.findUnique({ where: { id: promotionId } });
  if (!p) throw new Error('Promotion not found.');
  if (p.status === 'APPLIED') return;
  const associate = await db.associate.findUniqueOrThrow({ where: { id: p.associateId } });
  const who = `${associate.firstName} ${associate.lastName}`.trim();
  const effective = p.effectiveFrom.toISOString().slice(0, 10);

  if (p.amount != null) {
    await applyPayRateChange(db, {
      associateId: p.associateId,
      effectiveFrom: p.effectiveFrom,
      payType: p.payType ?? 'HOURLY',
      amount: Number(p.amount),
      reason: 'PROMOTION',
      notes: p.notes ?? null,
      actorUserId: decider.id,
      approvalRequestId,
      requestedByUserId: p.requestedById,
    });
  }
  if (p.jobProfileId && p.jobProfileId !== associate.jobProfileId) {
    const updated = await db.associate.update({ where: { id: p.associateId }, data: { jobProfileId: p.jobProfileId } });
    await recordChange(db, {
      associateId: p.associateId,
      managerId: updated.managerId,
      departmentId: updated.departmentId,
      costCenterId: updated.costCenterId,
      jobProfileId: updated.jobProfileId,
      state: updated.state,
      hourlyRate: null,
      reason: 'promotion',
      actorUserId: decider.id,
      effectiveFrom: p.effectiveFrom,
    });
  }
  const profile = p.jobProfileId ? await db.jobProfile.findUnique({ where: { id: p.jobProfileId }, select: { title: true } }) : null;
  const title = p.newTitle ?? profile?.title ?? null;
  const orgName = getBrandingSync().orgName;
  const pdf = await renderLetterPdf({
    title: `Promotion${title ? `: ${title}` : ''}`,
    body: letterBody({ orgName, who, title, level: p.level, amount: p.amount ? p.amount.toFixed(2) : null, payType: p.payType, effectiveFrom: effective }),
    issuedAt: new Date(),
    issuedTo: who,
  });
  const key = tenantBlobKey(`letters/promotion-${p.id}.pdf`);
  await getBlobStore().put(key, pdf, 'application/pdf');
  const filed = await db.documentRecord.create({
    data: {
      associateId: p.associateId,
      kind: 'OTHER',
      s3Key: key,
      filename: `promotion-letter-${effective}.pdf`,
      mimeType: 'application/pdf',
      size: pdf.byteLength,
      status: 'VERIFIED',
      verifiedById: decider.id,
      verifiedAt: new Date(),
    },
  });
  await recordDocumentEvent({ actorUserId: decider.id, action: 'document.generated_from_template', documentId: filed.id, associateId: p.associateId, clientId: null, metadata: { promotionId: p.id, kind: 'PROMOTION_LETTER' } });
  await db.promotion.update({ where: { id: p.id }, data: { status: 'APPLIED', appliedAt: new Date(), letterDocumentId: filed.id } });
  enqueueAudit({ actorUserId: decider.id, action: 'promotion.applied', entityType: 'Promotion', entityId: p.id, metadata: { associateId: p.associateId, approvalRequestId, letterDocumentId: filed.id } }, 'promotions.apply');
  void notifyAssociate(p.associateId, {
    subject: `Congratulations${title ? ` — ${title}` : ''}`,
    body: `Your promotion is effective ${effective}. Your letter is in your documents.`,
    category: 'compensation',
    linkUrl: '/me?tab=documents',
    emailFallback: true,
  });
  void notifyManager(p.associateId, { subject: 'Promotion applied on your team', body: `${who}: promotion effective ${effective}.`, category: 'compensation', linkUrl: `/people/${p.associateId}?tab=pay` });
}

export async function rejectPromotion(db: PrismaClient, promotionId: string): Promise<void> {
  await db.promotion.updateMany({ where: { id: promotionId, status: 'PENDING' }, data: { status: 'REJECTED' } });
}

export async function listPromotions(db: PrismaClient = defaultPrisma, opts: { associateId?: string; status?: PromotionDto['status'] } = {}): Promise<PromotionDto[]> {
  const rows = await db.promotion.findMany({
    where: { tenantId: tenantIdForWrite(), ...(opts.associateId ? { associateId: opts.associateId } : {}), ...(opts.status ? { status: opts.status } : {}) },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  return Promise.all(rows.map((r) => shapePromotion(db, r)));
}
