import type { PrismaClient } from '@prisma/client';
import { unlink } from 'node:fs/promises';
import { prisma as defaultPrisma } from '../db.js';
import { resolveStoragePath } from './storage.js';
import { env } from '../config/env.js';

/**
 * Daily document maintenance sweep.
 *
 * Purges the blob (file on disk + s3Key column) of REJECTED documents
 * once they've passed the retention window. The DocumentRecord row
 * itself stays for audit — only the actual file leaves disk.
 *
 * Why a retention window at all: on reject, we used to immediately
 * unlink the file. That left no recourse if HR realised a minute later
 * the rejection was wrong, and no way to dispute the "what was actually
 * submitted" question after the fact. 30 days gives a comfortable
 * review/dispute window while still bounding storage growth and limiting
 * the blast radius if the upload itself was sensitive.
 *
 * REJECTED_DOC_RETENTION_DAYS is measured from `verifiedAt`, which on
 * REJECTED rows is the rejection timestamp.
 */

export const REJECTED_DOC_RETENTION_DAYS = 30;
const PURGE_BATCH = 500;
const RETENTION_MS = REJECTED_DOC_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/**
 * True iff the doc is REJECTED and the retention window has lapsed.
 * Pure check (no DB / disk work) — pair with `purgeOneRejectedDoc` to
 * actually drop the blob. Used by:
 *   - the download route to lazy-purge on first read past retention,
 *     so a stale file can't be served between daily cron ticks;
 *   - the `toRecord` serializer to mark fileAvailable=false in
 *     listings so the UI doesn't dangle a broken click.
 */
export function isRejectedDocPastRetention(
  doc: { status: string; verifiedAt: Date | null },
  now: Date = new Date(),
): boolean {
  if (doc.status !== 'REJECTED') return false;
  if (!doc.verifiedAt) return false;
  return now.getTime() - doc.verifiedAt.getTime() > RETENTION_MS;
}

/**
 * Unlink the blob for one specific DocumentRecord and null its s3Key.
 * Inline equivalent of one iteration of `purgeRejectedDocs`. Safe to
 * call repeatedly — second call is a no-op once s3Key is already null.
 */
export async function purgeOneRejectedDoc(
  prisma: PrismaClient,
  docId: string,
  s3Key: string,
): Promise<void> {
  try {
    await unlink(resolveStoragePath(s3Key));
  } catch {
    // File already gone — proceed to null s3Key so the row stops
    // being re-picked by the cron and lazy paths.
  }
  await prisma.documentRecord.update({
    where: { id: docId },
    data: { s3Key: null },
  });
}

export async function purgeRejectedDocs(
  prisma: PrismaClient = defaultPrisma,
  now: Date = new Date(),
): Promise<{ purged: number; errors: { entityId: string; error: string }[] }> {
  const cutoff = new Date(
    now.getTime() - REJECTED_DOC_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );
  // Capped per-tick so a backlog after a long outage doesn't burn a
  // single sweep on tens of thousands of rows. Next tick picks up the
  // rest — idempotent.
  const stale = await prisma.documentRecord.findMany({
    where: {
      status: 'REJECTED',
      s3Key: { not: null },
      verifiedAt: { lt: cutoff },
    },
    select: { id: true, s3Key: true },
    take: PURGE_BATCH,
  });

  const errors: { entityId: string; error: string }[] = [];
  let purged = 0;
  for (const row of stale) {
    if (!row.s3Key) continue;
    try {
      await purgeOneRejectedDoc(prisma, row.id, row.s3Key);
      purged++;
    } catch (err) {
      errors.push({
        entityId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { purged, errors };
}

let timer: NodeJS.Timeout | null = null;

export function startDocumentMaintenanceCron(): void {
  if (timer) return;
  const seconds = env.DOCUMENT_MAINTENANCE_INTERVAL_SECONDS;
  if (seconds <= 0) return;
  void purgeRejectedDocs().catch((err) => {
    console.error('[alto-people/api] document maintenance failed:', err);
  });
  timer = setInterval(() => {
    void purgeRejectedDocs().catch((err) => {
      console.error('[alto-people/api] document maintenance failed:', err);
    });
  }, seconds * 1000);
  timer.unref();
  console.log(
    `[alto-people/api] document maintenance cron armed (every ${seconds}s; ` +
      `rejected-doc retention ${REJECTED_DOC_RETENTION_DAYS}d)`,
  );
}

export function stopDocumentMaintenanceCron(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
