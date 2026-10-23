import type { Prisma } from '@prisma/client';
import { registerApplyHandler } from './approvalRequests.js';
import { completeSeparation } from './separationComplete.js';
import { applyRoleChange } from './accessChanges.js';
import { dropHeldInvite, releaseHeldInvite } from './staffInvite.js';
import { applyPromotion, rejectPromotion } from './promotions.js';
import { openPosition } from './requisitions.js';
import { recordFinancialChange, addressSummary } from './financialChanges.js';
import { enqueueAudit } from './audit.js';
import { notifyAssociate } from './notify.js';

/**
 * The apply step for every approval kind whose change lives in another
 * module. Imported once (by the approvals router) so the registry is
 * complete before the first decision; keeps lib/approvalRequests free of
 * imports back into the domains it serves.
 */

registerApplyHandler('SEPARATION_COMPLETE', async (_db, row, decider) => {
  await completeSeparation(row.subjectId, decider.id, { approvalRequestId: row.id });
});

registerApplyHandler(
  'ROLE_CHANGE',
  async (db, row, decider) => {
    const p = row.proposed as { userId: string; role?: string; additionalRoles?: string[]; invite?: boolean };
    await applyRoleChange(db, p.userId, { role: p.role as never, additionalRoles: p.additionalRoles as never }, decider.id, { approvalRequestId: row.id, requestedByUserId: row.requesterUserId });
    // A held invite (lib/staffInvite): the role has landed; open the account and send the link.
    if (p.invite) await releaseHeldInvite(db, p.userId, decider.id);
  },
  async (db, row) => {
    const p = row.proposed as { userId: string; invite?: boolean };
    if (p.invite) await dropHeldInvite(db, p.userId);
  },
);

registerApplyHandler(
  'PROMOTION',
  async (db, row, decider) => {
    const p = row.proposed as { promotionId: string };
    await applyPromotion(db, p.promotionId, decider, row.id);
  },
  async (db, row) => {
    const p = row.proposed as { promotionId: string };
    await rejectPromotion(db, p.promotionId);
  },
);

registerApplyHandler('REQUISITION', async (db, row, decider) => {
  await openPosition(db, row.subjectId, decider.id, { approvalRequestId: row.id });
});

type SelfServiceProposal =
  | { op: 'profile'; associateId: string; data: Record<string, string | null> }
  | { op: 'dependent.create'; associateId: string; data: Record<string, unknown> }
  | { op: 'dependent.update'; associateId: string; dependentId: string; data: Record<string, unknown> }
  | { op: 'dependent.delete'; associateId: string; dependentId: string };

registerApplyHandler(
  'SELF_SERVICE_CHANGE',
  async (db, row, decider) => {
    const p = row.proposed as SelfServiceProposal;
    if (p.op === 'profile') {
      const before = await db.associate.findUniqueOrThrow({ where: { id: p.associateId }, select: { addressLine1: true, addressLine2: true, city: true, state: true, zip: true, phone: true } });
      const next = { ...before, ...p.data } as typeof before;
      const addressTouched = (['addressLine1', 'addressLine2', 'city', 'state', 'zip'] as const).some((k) => (next[k] ?? null) !== (before[k] ?? null));
      await db.$transaction(async (tx) => {
        if (addressTouched) {
          await recordFinancialChange(tx, {
            associateId: p.associateId,
            kind: 'HOME_ADDRESS',
            source: 'SELF',
            actor: { id: decider.id, role: decider.role, associateId: null },
            oldSummary: addressSummary(before),
            newSummary: addressSummary(next),
          });
        }
        await tx.associate.update({ where: { id: p.associateId }, data: p.data as Prisma.AssociateUncheckedUpdateInput });
      });
    } else if (p.op === 'dependent.create') {
      const d = p.data as { firstName: string; lastName: string; relation: 'SPOUSE' | 'CHILD' | 'DOMESTIC_PARTNER' | 'OTHER'; dob?: string | null; ssnLast4?: string | null; isCovered?: boolean };
      await db.dependent.create({ data: { associateId: p.associateId, firstName: d.firstName, lastName: d.lastName, relation: d.relation, dob: d.dob ? new Date(d.dob) : null, ssnLast4: d.ssnLast4 ?? null, isCovered: d.isCovered ?? true } });
    } else if (p.op === 'dependent.update') {
      const d = p.data as { firstName?: string; lastName?: string; relation?: 'SPOUSE' | 'CHILD' | 'DOMESTIC_PARTNER' | 'OTHER'; dob?: string | null; ssnLast4?: string | null; isCovered?: boolean };
      await db.dependent.updateMany({
        where: { id: p.dependentId, associateId: p.associateId, deletedAt: null },
        data: {
          firstName: d.firstName ?? undefined,
          lastName: d.lastName ?? undefined,
          relation: d.relation ?? undefined,
          dob: d.dob === undefined ? undefined : d.dob ? new Date(d.dob) : null,
          ssnLast4: d.ssnLast4 === undefined ? undefined : d.ssnLast4,
          isCovered: d.isCovered ?? undefined,
        },
      });
    } else if (p.op === 'dependent.delete') {
      await db.dependent.updateMany({ where: { id: p.dependentId, associateId: p.associateId, deletedAt: null }, data: { deletedAt: new Date() } });
    }
    enqueueAudit({ actorUserId: decider.id, action: 'self.change_applied', entityType: 'Associate', entityId: p.associateId, metadata: { op: p.op, approvalRequestId: row.id } }, 'approvalApply.selfService');
    void notifyAssociate(p.associateId, { subject: 'Your change was approved', body: `${row.title} — approved and applied.`, category: 'profile', linkUrl: '/me' });
  },
  async (_db, row) => {
    const p = row.proposed as SelfServiceProposal;
    void notifyAssociate(p.associateId, { subject: 'Your change was not approved', body: `${row.title}${row.reason ? ` — “${row.reason}”` : ''}`, category: 'profile', linkUrl: '/me' });
  },
);
