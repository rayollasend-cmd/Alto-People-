import type { PrismaClient, QboSyncConflict } from '@prisma/client';
import { HttpError } from '../../../middleware/error.js';
import { tenantIdForWrite } from '../../tenant.js';
import { voidEntry } from '../ledger.js';
import { companyConnection, logEvent, qboClientFor } from './connection.js';
import { fingerprint, linkFor, linkForQbo, remoteFingerprint } from './links.js';
import { applyChange, applyQboVersion, upsertAccount, upsertVendor } from './pull.js';
import { pushCtx, pushRecord, siteVersion, type LocalType } from './push.js';
import type { QboEntity, QboType } from './types.js';

/**
 * A person decides a conflict:
 *
 *   SITE        the site's version wins — sent to QuickBooks over theirs
 *               (or, for a change QuickBooks made in a month the site has
 *               closed, that change stays out of the site's books);
 *   QUICKBOOKS  QuickBooks' version wins — applied on the site (a correcting
 *               entry where the record's truth is an operational flow);
 *   DISMISS     leave both as they are and stop asking about this difference.
 */

export type Keep = 'SITE' | 'QUICKBOOKS' | 'DISMISS';

interface QboVersion {
  type: QboType;
  id: string;
  entity: QboEntity | null;
  reason?: string;
}

export async function resolveConflict(db: PrismaClient, id: string, keep: Keep, userId: string | null): Promise<QboSyncConflict> {
  const tenantId = tenantIdForWrite();
  const c = await db.qboSyncConflict.findFirst({ where: { id, tenantId } });
  if (!c) throw new HttpError(404, 'conflict_not_found', 'Conflict not found.');
  if (c.status !== 'OPEN') throw new HttpError(409, 'conflict_decided', 'This was already decided.');
  const conn = await companyConnection(db);
  const q = c.qboVersion as unknown as QboVersion;
  let message: string;

  if (keep === 'DISMISS') {
    const link = await linkFor(db, c.localType, c.localId);
    if (link && q.entity) {
      const sv = await siteVersion(db, c.localType, c.localId);
      await db.qboSyncLink.update({ where: { id: link.id }, data: { remoteHash: remoteFingerprint(q.type, q.entity), syncToken: (q.entity.SyncToken as string | undefined) ?? link.syncToken, localHash: sv ? fingerprint(sv.payload) : link.localHash } });
    }
    message = 'Dismissed: both sides left as they are.';
  } else {
    if (!conn || conn.status !== 'CONNECTED') throw new HttpError(409, 'quickbooks_not_connected', 'QuickBooks has to be connected to settle this.');
    const qbo = qboClientFor(db, conn);
    const info = await qbo.companyInfo();
    if (keep === 'SITE') {
      if (q.reason === 'SITE_PERIOD_CLOSED') {
        // QuickBooks' change stays out of a closed month; remember we saw it.
        const link = await linkForQbo(db, q.type, q.id);
        if (link && q.entity) await db.qboSyncLink.update({ where: { id: link.id }, data: { remoteHash: remoteFingerprint(q.type, q.entity) } });
        message = 'Kept the closed month here as it is; QuickBooks’ change was left out.';
      } else {
        const ctx = await pushCtx(db, qbo, info.bookCloseDate, true);
        const out = await pushRecord(ctx, c.localType as LocalType, c.localId);
        message = `Sent the version here to QuickBooks: ${out.message}`;
      }
    } else {
      const ctx = { db, qbo, force: true };
      if (q.reason === 'BOOKS_CLOSED') {
        const link = await linkFor(db, c.localType, c.localId);
        const sv = await siteVersion(db, c.localType, c.localId);
        if (link && sv) await db.qboSyncLink.update({ where: { id: link.id }, data: { localHash: fingerprint(sv.payload) } });
        message = 'Left QuickBooks’ closed books as they are; the change made here wasn’t sent.';
      } else if (q.reason === 'SITE_PERIOD_CLOSED') {
        const out = await applyChange(ctx, { type: q.type, id: q.id, deleted: !q.entity, entity: q.entity, lastUpdated: null });
        message = `Applied QuickBooks’ change in the first open month: ${out.message}`;
      } else if (c.localType === 'LedgerAccount' && q.entity) {
        message = (await upsertAccount(ctx, q.entity)).message;
      } else if (c.localType === 'Vendor' && q.entity) {
        message = (await upsertVendor(ctx, q.entity)).message;
      } else {
        const link = await linkForQbo(db, q.type, q.id);
        if (!link) throw new HttpError(409, 'link_missing', 'The link between the two records is gone; sync again first.');
        if (!q.entity) {
          // Deleted in QuickBooks: take it off the site's books too.
          if (c.localType === 'JournalEntry') {
            const e = await db.journalEntry.findFirst({ where: { id: c.localId, tenantId } });
            if (e && e.status === 'POSTED') await voidEntry(db, e.id, { reason: 'Deleted in QuickBooks.', userId });
            message = 'Voided here — it was deleted in QuickBooks.';
          } else {
            message = (await applyQboVersion(ctx, q.type, { Id: q.id, TotalAmt: 0, Line: [] }, link)).message;
          }
          await db.qboSyncLink.update({ where: { id: link.id }, data: { deletedAt: new Date() } });
        } else {
          // The newest QuickBooks version, not the one captured with the conflict.
          const latest = (await qbo.get(q.type, q.id)) ?? q.entity;
          message = (await applyQboVersion(ctx, q.type, latest, link)).message;
        }
      }
    }
  }
  const done = await db.qboSyncConflict.update({
    where: { id: c.id },
    data: { status: keep === 'SITE' ? 'KEPT_SITE' : keep === 'QUICKBOOKS' ? 'KEPT_QUICKBOOKS' : 'DISMISSED', resolvedById: userId, resolvedAt: new Date() },
  });
  await logEvent(db, { direction: keep === 'SITE' ? 'PUSH' : 'PULL', result: 'OK', localType: c.localType, localId: c.localId, qboType: q.type, qboId: q.id, message: `Conflict decided: ${message}` });
  return done;
}

