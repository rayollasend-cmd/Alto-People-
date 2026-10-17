import type { DocumentKind, PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';
import { getBlobStore } from './blobStore.js';
import { tenantIdForWrite } from './tenant.js';

/**
 * Document retention by kind (HR pack 2026-10).
 *
 *   A policy says how many years after a person SEPARATES a kind of document
 *   is kept. Past that, the daily sweep purges the file — the row stays, with
 *   purgedAt, so the vault still shows that a document existed and when it
 *   left — and writes one audit row per file. No policy for a kind = kept
 *   forever, which is where every kind starts. A preview (dry run) lists what
 *   the next sweep would purge, so a policy is never set blind.
 *
 *   The I-9 is the floor: federal law keeps it three years after hire or one
 *   after separation, whichever is later — a policy shorter than three years
 *   is refused for I-9 kinds.
 */

export const DOCUMENT_KINDS: DocumentKind[] = [
  'ID',
  'SSN_CARD',
  'I9_SUPPORTING',
  'W4_PDF',
  'OFFER_LETTER',
  'POLICY',
  'HOUSING_AGREEMENT',
  'TRANSPORT_AGREEMENT',
  'J1_DS2019',
  'J1_VISA',
  'SIGNED_AGREEMENT',
  'BACKGROUND_CHECK_RESULT',
  'DRUG_TEST_RESULT',
  'I9_VERIFICATION_RESULT',
  'PAYSTUB',
  'OTHER',
];

/** Legal floors in years after separation, where the law sets one. */
export const RETENTION_FLOOR_YEARS: Partial<Record<DocumentKind, number>> = {
  I9_SUPPORTING: 3,
  I9_VERIFICATION_RESULT: 3,
  W4_PDF: 4,
  PAYSTUB: 3,
};

const BATCH = 500;

function cutoffFor(years: number, now: Date): Date {
  const d = new Date(now);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d;
}

export interface PurgeCandidate {
  id: string;
  kind: DocumentKind;
  filename: string;
  associateId: string;
  associateName: string;
  separatedAt: string;
  retainYears: number;
}

/** What the next sweep would purge under the current policies. */
export async function retentionPreview(db: PrismaClient = defaultPrisma, now: Date = new Date(), tenantId = tenantIdForWrite()): Promise<PurgeCandidate[]> {
  const policies = await db.documentRetentionPolicy.findMany({ where: { tenantId } });
  const out: PurgeCandidate[] = [];
  for (const p of policies) {
    const rows = await db.documentRecord.findMany({
      where: {
        tenantId,
        kind: p.kind,
        deletedAt: null,
        purgedAt: null,
        s3Key: { not: null },
        associate: { separatedAt: { not: null, lt: cutoffFor(p.retainYearsAfterSeparation, now) } },
      },
      select: { id: true, kind: true, filename: true, associateId: true, associate: { select: { firstName: true, lastName: true, separatedAt: true } } },
      take: BATCH,
    });
    for (const r of rows) {
      out.push({
        id: r.id,
        kind: r.kind,
        filename: r.filename,
        associateId: r.associateId,
        associateName: `${r.associate.firstName} ${r.associate.lastName}`.trim(),
        separatedAt: r.associate.separatedAt!.toISOString().slice(0, 10),
        retainYears: p.retainYearsAfterSeparation,
      });
    }
  }
  return out;
}

/** The sweep: purge every file past its policy, one audit row each. Idempotent. */
export async function purgeByRetention(db: PrismaClient = defaultPrisma, now: Date = new Date()): Promise<{ purged: number; errors: { entityId: string; error: string }[] }> {
  const tenantId = tenantIdForWrite();
  const candidates = await retentionPreview(db, now, tenantId);
  if (candidates.length === 0) return { purged: 0, errors: [] };
  const { enqueueAudit } = await import('./audit.js');
  const store = getBlobStore();
  const errors: { entityId: string; error: string }[] = [];
  let purged = 0;
  for (const c of candidates) {
    try {
      const row = await db.documentRecord.findUnique({ where: { id: c.id }, select: { s3Key: true } });
      if (row?.s3Key) {
        try {
          await store.delete(row.s3Key);
        } catch {
          // Blob already gone: still mark the row so it is never re-picked.
        }
      }
      await db.documentRecord.update({ where: { id: c.id }, data: { s3Key: null, purgedAt: now } });
      enqueueAudit(
        {
          actorUserId: null,
          action: 'document.purged_by_retention',
          entityType: 'DocumentRecord',
          entityId: c.id,
          metadata: { kind: c.kind, associateId: c.associateId, separatedAt: c.separatedAt, retainYears: c.retainYears, filename: c.filename },
        },
        'document.purged_by_retention',
      );
      purged += 1;
    } catch (err) {
      errors.push({ entityId: c.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { purged, errors };
}
