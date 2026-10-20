import type { PrismaClient, QboCompanyConnection } from '@prisma/client';
import { HttpError } from '../../../middleware/error.js';
import { tenantIdForWrite } from '../../tenant.js';
import { companyConnection, logEvent, qboClientFor } from './connection.js';
import { flushOutboxQueue, processOutbox } from './outbox.js';
import { applyChanges, PULL_TYPES } from './pull.js';
import { pushCtx } from './push.js';
import { QboError, type QboChange, type QboClient } from './types.js';

/**
 * One round of the sync for the tenant in context: read QuickBooks'
 * books-closing date, send what's waiting (outbox), then bring in what
 * changed there since the last pull. The job runs it every five minutes; a
 * webhook from Intuit or "Sync now" runs it at once.
 */

const CDC_WINDOW_MS = 29 * 24 * 60 * 60_000;

export interface SyncResult {
  connected: boolean;
  pushed: { sent: number; skipped: number; failed: number; conflicts: number };
  pulled: { ok: number; conflicts: number; errors: number; skipped: number };
  error: string | null;
}

const EMPTY: SyncResult = { connected: false, pushed: { sent: 0, skipped: 0, failed: 0, conflicts: 0 }, pulled: { ok: 0, conflicts: 0, errors: 0, skipped: 0 }, error: null };

/** What changed in QuickBooks since `since`: change-data-capture inside its 30-day window, else a query by last-updated time (deletions older than the window can't be seen). */
async function changesSince(qbo: QboClient, since: Date): Promise<QboChange[]> {
  if (Date.now() - since.getTime() < CDC_WINDOW_MS) return qbo.cdc(PULL_TYPES, since);
  const out: QboChange[] = [];
  for (const t of PULL_TYPES) {
    for (const e of await qbo.query(t, `MetaData.LastUpdatedTime >= '${since.toISOString()}'`)) out.push({ type: t, id: e.Id, deleted: false, entity: e, lastUpdated: e.MetaData?.LastUpdatedTime ?? null });
  }
  return out;
}

async function connected(db: PrismaClient): Promise<QboCompanyConnection | null> {
  const conn = await companyConnection(db);
  return conn && conn.status === 'CONNECTED' ? conn : null;
}

export async function runSync(db: PrismaClient, opts: { push?: boolean; pull?: boolean; now?: Date } = {}): Promise<SyncResult> {
  await flushOutboxQueue();
  const conn = await connected(db);
  if (!conn) return EMPTY;
  const qbo = qboClientFor(db, conn);
  const result: SyncResult = { ...EMPTY, connected: true, pushed: { ...EMPTY.pushed }, pulled: { ...EMPTY.pulled } };
  try {
    const info = await qbo.companyInfo();
    await db.qboCompanyConnection.update({ where: { id: conn.id }, data: { companyName: info.companyName, qboClosingDate: info.bookCloseDate ? new Date(`${info.bookCloseDate}T00:00:00.000Z`) : null } });
    if (opts.push !== false) {
      const ctx = await pushCtx(db, qbo, info.bookCloseDate);
      const p = await processOutbox(ctx, conn, { now: opts.now });
      result.pushed = { sent: p.sent, skipped: p.skipped, failed: p.failed, conflicts: p.conflicts };
      await db.qboCompanyConnection.update({ where: { id: conn.id }, data: { lastPushAt: new Date() } });
      if (p.stopped) return { ...result, error: 'QuickBooks refused the connection.' };
    }
    if (opts.pull !== false) {
      const started = new Date();
      const since = conn.pulledThrough ?? conn.createdAt;
      const changes = await changesSince(qbo, since);
      result.pulled = await applyChanges({ db, qbo }, changes);
      await db.qboCompanyConnection.update({ where: { id: conn.id }, data: { pulledThrough: started, lastPullAt: new Date(), lastError: null } });
    }
  } catch (err) {
    const message = err instanceof QboError ? `${err.message}${err.detail ? ` — ${err.detail}` : ''}` : err instanceof Error ? err.message : String(err);
    const reconnect = (err instanceof QboError && err.needsReconnect) || (err instanceof HttpError && err.code === 'quickbooks_reconnect_required');
    await db.qboCompanyConnection.update({ where: { id: conn.id }, data: { lastError: message.slice(0, 1000), ...(reconnect ? { status: 'NEEDS_RECONNECT' } : {}) } });
    await logEvent(db, { direction: 'PULL', result: 'ERROR', message: `Sync stopped: ${message}` });
    result.error = message;
  }
  return result;
}

/**
 * Bring QuickBooks' history in: everything dated on or after `since`
 * (accounts, vendors and customers first). Asked for explicitly — on
 * connect only changes from then on come over, so history the site already
 * has (from its own payroll and statements) isn't counted twice.
 */
export async function importHistory(db: PrismaClient, since: string): Promise<SyncResult['pulled']> {
  const conn = await connected(db);
  if (!conn) throw new HttpError(409, 'quickbooks_not_connected', 'Connect QuickBooks first.');
  const qbo = qboClientFor(db, conn);
  const changes: QboChange[] = [];
  for (const t of PULL_TYPES) {
    const where = t === 'Account' || t === 'Vendor' || t === 'Customer' ? 'Active IN (true,false)' : `TxnDate >= '${since}'`;
    for (const e of await qbo.query(t, where)) {
      if (where.startsWith('TxnDate') && String(e.TxnDate ?? '') < since) continue;
      changes.push({ type: t, id: e.Id, deleted: false, entity: e, lastUpdated: e.MetaData?.LastUpdatedTime ?? null });
    }
  }
  const tally = await applyChanges({ db, qbo }, changes);
  await logEvent(db, { direction: 'PULL', result: tally.errors ? 'ERROR' : 'OK', message: `Brought in QuickBooks history since ${since}: ${tally.ok} added or updated, ${tally.conflicts} waiting for a decision, ${tally.errors} failed.` });
  return tally;
}

/** Counts for the status header. */
export async function syncCounts(db: PrismaClient): Promise<{ pending: number; failed: number; conflicts: number }> {
  const tenantId = tenantIdForWrite();
  const [pending, failed, conflicts] = await Promise.all([
    db.qboOutbox.count({ where: { tenantId, status: 'PENDING' } }),
    db.qboOutbox.count({ where: { tenantId, status: 'FAILED' } }),
    db.qboSyncConflict.count({ where: { tenantId, status: 'OPEN' } }),
  ]);
  return { pending, failed, conflicts };
}
