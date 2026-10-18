import type { PrismaClient } from '@prisma/client';
import { tenantIdForWrite } from '../tenant.js';
import { applyAchReturn, applyNoc } from './directDeposit.js';
import type { OriginationEvent } from './origination.js';

/**
 * What a bank partner tells us about entries it sent (webhooks from
 * Modern Treasury or Increase), applied to the entries by their reference.
 */
export async function applyOriginationEvents(db: PrismaClient, events: OriginationEvent[], now = new Date()): Promise<{ applied: number; unknown: number; subjectId: string | null }> {
  let applied = 0;
  let unknown = 0;
  let subjectId: string | null = null;
  for (const e of events) {
    const entry = await db.achEntry.findFirst({ where: { tenantId: tenantIdForWrite(), externalRef: e.externalRef } });
    if (!entry) {
      unknown += 1;
      continue;
    }
    subjectId ??= entry.id;
    if (e.kind === 'SETTLED') {
      if (entry.status === 'SENT') await db.achEntry.update({ where: { id: entry.id }, data: { status: 'SETTLED' } });
      if (entry.kind === 'DEBIT') {
        await db.payrollFunding.updateMany({ where: { achEntryId: entry.id, status: 'SUBMITTED' }, data: { status: 'SETTLED', settledAt: now } });
      }
    } else if (e.kind === 'RETURNED') {
      await applyAchReturn(db, { entryId: entry.id }, e.code, null, now);
    } else if (e.kind === 'NOC') {
      await applyNoc(db, { entryId: entry.id }, e.code, e.correctedData, null, now);
    } else {
      await applyAchReturn(db, { entryId: entry.id }, e.reason, null, now);
    }
    applied += 1;
  }
  return { applied, unknown, subjectId };
}
