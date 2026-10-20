import type { PrismaClient, QboCompanyConnection, QboOutbox } from '@prisma/client';
import { prisma } from '../../../db.js';
import { tenantIdForWrite } from '../../tenant.js';
import { onBooksChange, type BooksChange } from '../events.js';
import { logEvent } from './connection.js';
import { pushRecord, QBO_TYPE, SOURCES_SYNCED_AS_OBJECTS, type LocalType, type PushCtx } from './push.js';
import { QboError } from './types.js';

/**
 * The queue of changes waiting to go to QuickBooks. Every site change the
 * books announce (events.ts) lands here — at most one waiting row per
 * record — when the company QuickBooks is connected. A change that came
 * FROM QuickBooks is never queued back (no echo). The job drains it:
 * dependencies first (accounts, vendors and customers before the
 * transactions that use them), a failure retried with backoff, FAILED with
 * QuickBooks' own words after six tries.
 */

export const MAX_ATTEMPTS = 6;
const QUEUED: ReadonlySet<string> = new Set(['LedgerAccount', 'Vendor', 'Client', 'JournalEntry', 'Bill', 'BillPayment', 'ClientStatement', 'ClientPayment']);
const PRIORITY: Record<string, number> = { LedgerAccount: 0, Vendor: 1, Client: 2, JournalEntry: 3, Bill: 3, ClientStatement: 3, BillPayment: 4, ClientPayment: 4 };

/** Whether a change goes to QuickBooks at all. */
export function shouldQueue(change: BooksChange): boolean {
  if (change.origin === 'QUICKBOOKS') return false;
  if (!QUEUED.has(change.localType)) return false;
  if (change.localType === 'JournalEntry' && change.source && SOURCES_SYNCED_AS_OBJECTS.has(change.source)) return false;
  if (change.localType === 'JournalEntry' && change.source === 'QUICKBOOKS') return false;
  return true;
}

/** Put a record in the queue (or freshen the row already waiting for it). */
export async function enqueue(db: PrismaClient, localType: string, localId: string, op: 'UPSERT' | 'DELETE'): Promise<QboOutbox> {
  const tenantId = tenantIdForWrite();
  const waiting = await db.qboOutbox.findFirst({ where: { tenantId, localType, localId, status: 'PENDING' } });
  if (waiting) return db.qboOutbox.update({ where: { id: waiting.id }, data: { op, nextAttemptAt: new Date() } });
  return db.qboOutbox.create({ data: { tenantId, localType, localId, op, status: 'PENDING', nextAttemptAt: new Date() } });
}

/** The listener: queue site changes while the company QuickBooks is connected (or paused — they wait). */
export async function queueChange(change: BooksChange, db: PrismaClient = prisma): Promise<void> {
  if (!shouldQueue(change)) return;
  const conn = await db.qboCompanyConnection.findFirst({ where: { tenantId: tenantIdForWrite() }, select: { status: true } });
  if (!conn || conn.status === 'DISCONNECTED') return;
  await enqueue(db, change.localType, change.localId, change.op);
}

let registered = false;
const queueing = new Set<Promise<unknown>>();
/** Registered once, when the QuickBooks routes are loaded. Queue writes are tracked so a sync (or a test) can wait for them. */
export function registerOutboxListener(): void {
  if (registered) return;
  registered = true;
  onBooksChange((c) => {
    const p = queueChange(c).catch((err) => console.error('[books] couldn’t queue a change for QuickBooks', err));
    queueing.add(p);
    void p.finally(() => queueing.delete(p));
    return p;
  });
}

/** Wait for changes still being written to the queue. */
export async function flushOutboxQueue(): Promise<void> {
  while (queueing.size > 0) await Promise.allSettled([...queueing]);
}

const backoffMs = (attempts: number) => Math.min(6 * 60 * 60_000, 60_000 * 2 ** Math.max(0, attempts - 1));

/**
 * Send what's waiting. Stops early when QuickBooks says the connection is
 * gone (the connection is marked NEEDS_RECONNECT; rows keep waiting).
 */
export async function processOutbox(ctx: PushCtx, conn: QboCompanyConnection, opts: { limit?: number; now?: Date } = {}): Promise<{ sent: number; skipped: number; failed: number; conflicts: number; stopped: boolean }> {
  await flushOutboxQueue();
  const tenantId = tenantIdForWrite();
  const now = opts.now ?? new Date();
  const rows = await ctx.db.qboOutbox.findMany({ where: { tenantId, status: 'PENDING', nextAttemptAt: { lte: now } }, orderBy: { createdAt: 'asc' }, take: opts.limit ?? 200 });
  rows.sort((a, b) => (PRIORITY[a.localType] ?? 9) - (PRIORITY[b.localType] ?? 9));
  const tally = { sent: 0, skipped: 0, failed: 0, conflicts: 0, stopped: false };
  for (const row of rows) {
    // A row may already have gone out as another record's dependency.
    const fresh = await ctx.db.qboOutbox.findUnique({ where: { id: row.id } });
    if (!fresh || fresh.status !== 'PENDING') continue;
    try {
      const out = await pushRecord(ctx, row.localType as LocalType, row.localId);
      await ctx.db.qboOutbox.update({ where: { id: row.id }, data: { status: out.result === 'OK' || (out.result === 'SKIPPED' && out.qboId) ? 'DONE' : 'SKIPPED', attempts: { increment: 1 }, lastError: out.result === 'OK' ? null : out.message.slice(0, 1000) } });
      await logEvent(ctx.db, { direction: 'PUSH', result: out.result, localType: row.localType, localId: row.localId, qboType: QBO_TYPE[row.localType as LocalType], qboId: out.qboId ?? null, message: out.message });
      if (out.result === 'OK') tally.sent += 1;
      else if (out.result === 'CONFLICT') tally.conflicts += 1;
      else tally.skipped += 1;
    } catch (err) {
      const message = err instanceof QboError ? `${err.message}${err.detail ? ` — ${err.detail}` : ''}` : err instanceof Error ? err.message : String(err);
      if (err instanceof QboError && err.needsReconnect) {
        await ctx.db.qboCompanyConnection.update({ where: { id: conn.id }, data: { status: 'NEEDS_RECONNECT', lastError: 'QuickBooks refused the connection. Reconnect QuickBooks.' } });
        await logEvent(ctx.db, { direction: 'PUSH', result: 'ERROR', localType: row.localType, localId: row.localId, message: `QuickBooks refused the connection: ${message}` });
        tally.stopped = true;
        break;
      }
      const attempts = row.attempts + 1;
      const failed = attempts >= MAX_ATTEMPTS;
      await ctx.db.qboOutbox.update({
        where: { id: row.id },
        data: { attempts, lastError: message.slice(0, 1000), status: failed ? 'FAILED' : 'PENDING', nextAttemptAt: new Date(now.getTime() + backoffMs(attempts)) },
      });
      await logEvent(ctx.db, { direction: 'PUSH', result: 'ERROR', localType: row.localType, localId: row.localId, qboType: QBO_TYPE[row.localType as LocalType], message: failed ? `Gave up after ${attempts} tries: ${message}` : `Will try again: ${message}` });
      if (failed) tally.failed += 1;
    }
  }
  return tally;
}

/** Send a FAILED (or waiting) row again now. */
export async function retryOutbox(db: PrismaClient, id: string): Promise<QboOutbox | null> {
  const row = await db.qboOutbox.findFirst({ where: { id, tenantId: tenantIdForWrite() } });
  if (!row) return null;
  return db.qboOutbox.update({ where: { id }, data: { status: 'PENDING', attempts: 0, nextAttemptAt: new Date(), lastError: null } });
}
