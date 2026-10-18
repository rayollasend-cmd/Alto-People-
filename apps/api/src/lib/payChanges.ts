import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';
import { enqueueAudit } from './audit.js';
import { notifyAssociate, notifyManager } from './notify.js';
import { setRateCard, type RateCard } from './rateCards.js';
import { issuePayNoticeInBackground } from './payNotices.js';

/**
 * Every pay change on one path, with its own audit row. Finance reads
 * these rows as "Pay changes" (actor, before, after, effective date, and
 * the approval that let it through) — the generic request audit never
 * said what the rate was before.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export const PAY_RATE_AUDIT_ACTION = 'pay.rate_changed';
export const BILL_RATE_AUDIT_ACTION = 'pay.bill_rate_changed';

export type CompReason = 'HIRE' | 'MERIT' | 'PROMOTION' | 'MARKET_ADJUSTMENT' | 'CORRECTION' | 'OTHER';

export interface PayRateChange {
  associateId: string;
  effectiveFrom: Date;
  payType: 'HOURLY' | 'SALARY';
  amount: number;
  reason: CompReason;
  notes?: string | null;
  /** The person whose name the record carries (the decider, when approved). */
  actorUserId: string;
  /** The approval that let it through, when one was needed. */
  approvalRequestId?: string | null;
  /** Who asked for it, when that is not the actor. */
  requestedByUserId?: string | null;
  /** "No second approver was available" — written to the audit row. */
  note?: string | null;
}

/** The current record, as the comparison base and the audit's "before". */
export async function currentComp(db: Db, associateId: string): Promise<{ id: string; payType: 'HOURLY' | 'SALARY'; amount: number; effectiveFrom: Date } | null> {
  const row = await db.compensationRecord.findFirst({ where: { associateId, effectiveTo: null }, orderBy: { effectiveFrom: 'desc' } });
  return row ? { id: row.id, payType: row.payType, amount: Number(row.amount), effectiveFrom: row.effectiveFrom } : null;
}

/** Close the current record on the date and open the new one; audit; tell the person and their manager. */
export async function applyPayRateChange(db: Db, change: PayRateChange): Promise<{ id: string }> {
  const before = await currentComp(db, change.associateId);
  const created = await (async () => {
    const run = async (tx: Db) => {
      await tx.compensationRecord.updateMany({ where: { associateId: change.associateId, effectiveTo: null }, data: { effectiveTo: change.effectiveFrom } });
      return tx.compensationRecord.create({
        data: {
          associateId: change.associateId,
          effectiveFrom: change.effectiveFrom,
          payType: change.payType,
          amount: new Prisma.Decimal(change.amount),
          reason: change.reason,
          notes: change.notes ?? null,
          actorUserId: change.actorUserId,
        },
      });
    };
    return 'compensationRecord' in db && '$transaction' in db ? (db as PrismaClient).$transaction(run) : run(db);
  })();
  const effectiveDate = change.effectiveFrom.toISOString().slice(0, 10);
  enqueueAudit(
    {
      actorUserId: change.actorUserId,
      action: PAY_RATE_AUDIT_ACTION,
      entityType: 'CompensationRecord',
      entityId: created.id,
      metadata: {
        associateId: change.associateId,
        before: before ? { payType: before.payType, amount: before.amount } : null,
        after: { payType: change.payType, amount: change.amount },
        effectiveFrom: effectiveDate,
        reason: change.reason,
        approvalRequestId: change.approvalRequestId ?? null,
        requestedByUserId: change.requestedByUserId ?? null,
        note: change.note ?? null,
      },
    },
    'payChanges.rate',
  );
  // A state pay notice of the new rate where the work state requires one (NY §195(2), CA §2810.5(b), IL).
  issuePayNoticeInBackground({ associateId: change.associateId, trigger: 'RATE_CHANGE', effectiveDate: change.effectiveFrom, actorUserId: change.actorUserId });
  const associate = await db.associate.findUnique({ where: { id: change.associateId }, select: { firstName: true, lastName: true } });
  void notifyAssociate(change.associateId, {
    subject: 'Your pay rate was updated',
    body: `New rate effective ${effectiveDate}. Open your profile for details.`,
    category: 'compensation',
    linkUrl: '/me',
    emailFallback: true,
  });
  if (associate) {
    void notifyManager(change.associateId, {
      subject: 'Pay rate updated on your team',
      body: `${associate.firstName} ${associate.lastName} has a new rate effective ${effectiveDate}.`,
      category: 'compensation',
      linkUrl: `/people?associateId=${change.associateId}`,
    });
  }
  return { id: created.id };
}

export interface BillRateChange {
  clientId: string;
  position: string;
  payRate: number;
  billRate: number | null;
  /** YYYY-MM-DD; today when absent. */
  effectiveFrom?: string;
  actorUserId: string;
  approvalRequestId?: string | null;
  requestedByUserId?: string | null;
  note?: string | null;
}

/** A dated rate card, with its own audit row beside the card's. */
export async function applyBillRateChange(db: Db, change: BillRateChange, before: { payRate: number; billRate: number | null } | null): Promise<RateCard> {
  const saved = await setRateCard(db, { clientId: change.clientId, position: change.position, payRate: change.payRate, billRate: change.billRate, effectiveFrom: change.effectiveFrom }, change.actorUserId);
  enqueueAudit(
    {
      actorUserId: change.actorUserId,
      clientId: change.clientId,
      action: BILL_RATE_AUDIT_ACTION,
      entityType: 'ShiftRateDefault',
      entityId: saved.id,
      metadata: {
        position: change.position,
        before,
        after: { payRate: change.payRate, billRate: change.billRate },
        effectiveFrom: saved.effectiveFrom,
        approvalRequestId: change.approvalRequestId ?? null,
        requestedByUserId: change.requestedByUserId ?? null,
        note: change.note ?? null,
      },
    },
    'payChanges.bill',
  );
  return saved;
}

export interface PayChangeRow {
  id: string;
  at: string;
  kind: 'pay' | 'bill';
  actor: { id: string; name: string } | null;
  associateId: string | null;
  associateName: string | null;
  clientId: string | null;
  position: string | null;
  before: unknown;
  after: unknown;
  effectiveFrom: string | null;
  reason: string | null;
  approvalRequestId: string | null;
  note: string | null;
}

/** The pay-change audit as Finance reads it, newest first. */
export async function listPayChanges(db: PrismaClient = defaultPrisma, opts: { associateId?: string; clientId?: string; limit?: number } = {}): Promise<PayChangeRow[]> {
  const rows = await db.auditLog.findMany({
    where: {
      action: { in: [PAY_RATE_AUDIT_ACTION, BILL_RATE_AUDIT_ACTION] },
      ...(opts.clientId ? { clientId: opts.clientId } : {}),
      ...(opts.associateId ? { metadata: { path: ['associateId'], equals: opts.associateId } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(500, opts.limit ?? 200),
    include: { actorUser: { select: { id: true, email: true, displayName: true, associate: { select: { firstName: true, lastName: true } } } } },
  });
  const associateIds = [...new Set(rows.map((r) => (r.metadata as { associateId?: string } | null)?.associateId).filter((x): x is string => typeof x === 'string'))];
  const people = associateIds.length ? await db.associate.findMany({ where: { id: { in: associateIds } }, select: { id: true, firstName: true, lastName: true } }) : [];
  const nameOf = new Map(people.map((p) => [p.id, `${p.firstName} ${p.lastName}`.trim()]));
  return rows.map((r) => {
    const m = (r.metadata ?? {}) as Record<string, unknown>;
    const actor = r.actorUser;
    const associateId = typeof m.associateId === 'string' ? m.associateId : null;
    return {
      id: r.id,
      at: r.createdAt.toISOString(),
      kind: r.action === PAY_RATE_AUDIT_ACTION ? 'pay' : 'bill',
      actor: actor ? { id: actor.id, name: actor.displayName ?? (actor.associate ? `${actor.associate.firstName} ${actor.associate.lastName}` : actor.email) } : null,
      associateId,
      associateName: associateId ? (nameOf.get(associateId) ?? null) : null,
      clientId: r.clientId,
      position: typeof m.position === 'string' ? m.position : null,
      before: m.before ?? null,
      after: m.after ?? null,
      effectiveFrom: typeof m.effectiveFrom === 'string' ? m.effectiveFrom : null,
      reason: typeof m.reason === 'string' ? m.reason : null,
      approvalRequestId: typeof m.approvalRequestId === 'string' ? m.approvalRequestId : null,
      note: typeof m.note === 'string' ? m.note : null,
    };
  });
}
