import type { PrismaClient } from '@prisma/client';
import { assertSafeOutboundUrl } from './safeOutboundUrl.js';
import { newWebhookSecret, openWebhookSecret, sealWebhookSecret, signatureV2 } from './webhookSecrets.js';
import { platformJob } from './tenantJobs.js';

/**
 * Brief 2-3 step 4 — the SIEM sink (decision 9: HTTPS JSON lines on the
 * 2-4 delivery rails). A tenant registers one https endpoint; its audit
 * trail is POSTed in chain order (`seq`), newest-last, as
 * `application/x-ndjson`, signed exactly like a webhook (X-Alto-Signature:
 * t=…,v1=HMAC-SHA256 of "t.body"). The cursor only moves on a 2xx, so a
 * receiver that was down gets everything it missed; failures back off
 * 1m/5m/30m/2h/12h and keep retrying (an audit stream never gives up).
 *
 * Rows are the audit rows as stored (metadata is already masked at write);
 * the chain columns ride along so the receiver can verify them too.
 */

type Db = PrismaClient;

type Sender = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ status: number; ok: boolean }>;
let sender: Sender = (url, init) => fetch(url, init);
export function setAuditSinkSenderForTests(fn: Sender | null): void {
  sender = fn ?? ((url, init) => fetch(url, init));
}

export const SINK_BATCH = 500;
const BACKOFF_MINUTES = [1, 5, 30, 120, 720];

export async function createAuditSink(db: Db, tenantId: string, url: string, actorUserId: string): Promise<{ id: string; secret: string }> {
  await assertSafeOutboundUrl(url);
  const secret = newWebhookSecret();
  // A new sink starts at the chain's current head: it streams from now on.
  const [head] = await db.$queryRawUnsafe<Array<{ seq: bigint | null }>>(`SELECT max("seq") AS "seq" FROM "AuditLog" WHERE "tenantId" = $1::uuid`, tenantId);
  const row = await db.auditSink.upsert({
    where: { tenantId },
    create: { tenantId, url, secretEnc: sealWebhookSecret(secret), cursorSeq: head?.seq ?? 0n, createdById: actorUserId },
    update: { url, secretEnc: sealWebhookSecret(secret), enabled: true, failures: 0, nextAttemptAt: null, lastError: null },
  });
  return { id: row.id, secret };
}

const seal = (raw: Uint8Array) => ({ secret: '', secretEnc: raw });

/** One POST for one sink: up to SINK_BATCH rows after its cursor. Returns the rows delivered. */
export async function deliverAuditSink(db: Db, sinkId: string, now: Date = new Date()): Promise<number> {
  const sink = await db.auditSink.findUnique({ where: { id: sinkId } });
  if (!sink || !sink.enabled || !sink.tenantId) return 0;
  if (sink.nextAttemptAt && sink.nextAttemptAt > now) return 0;
  const rows = await db.auditLog.findMany({
    where: { tenantId: sink.tenantId, seq: { gt: sink.cursorSeq } },
    orderBy: { seq: 'asc' },
    take: SINK_BATCH,
  });
  if (!rows.length) return 0;
  const body =
    rows
      .map((r) =>
        JSON.stringify({
          id: r.id,
          seq: String(r.seq),
          tenantId: r.tenantId,
          action: r.action,
          entityType: r.entityType,
          entityId: r.entityId,
          actorUserId: r.actorUserId,
          clientId: r.clientId,
          workerId: r.workerId,
          apiClientId: r.apiClientId,
          metadata: r.metadata,
          createdAt: r.createdAt.toISOString(),
          prevHash: r.prevHash,
          hash: r.hash,
        }),
      )
      .join('\n') + '\n';
  const fromSeq = rows[0]!.seq!;
  const toSeq = rows[rows.length - 1]!.seq!;
  let status: number | null = null;
  let error: string | null = null;
  try {
    await assertSafeOutboundUrl(sink.url);
    const res = await sender(sink.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-ndjson',
        'User-Agent': 'AltoPeople-AuditSink/1',
        'X-Alto-Signature': signatureV2(openWebhookSecret(seal(sink.secretEnc)), body, now),
        'X-Alto-Seq-Range': `${fromSeq}-${toSeq}`,
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    status = res.status;
    if (!res.ok) error = `HTTP ${res.status}`;
  } catch (err) {
    error = (err instanceof Error ? err.message : String(err)).slice(0, 500);
  }
  const ok = error === null;
  await db.auditSinkDelivery.create({ data: { sinkId, fromSeq, toSeq, rows: rows.length, status, ok, error } });
  if (ok) {
    await db.auditSink.update({ where: { id: sinkId }, data: { cursorSeq: toSeq, failures: 0, nextAttemptAt: null, lastError: null, lastDeliveredAt: now } });
    return rows.length;
  }
  const failures = sink.failures + 1;
  const wait = BACKOFF_MINUTES[Math.min(failures, BACKOFF_MINUTES.length) - 1]!;
  await db.auditSink.update({ where: { id: sinkId }, data: { failures, lastError: error, nextAttemptAt: new Date(now.getTime() + wait * 60_000) } });
  return 0;
}

/** The cron body: every enabled sink, until each is caught up or fails (bounded per tick). */
export async function deliverAuditSinks(db: Db, now: Date = new Date()): Promise<number> {
  const sinks = await db.auditSink.findMany({ where: { enabled: true }, select: { id: true } });
  let total = 0;
  for (const s of sinks) {
    for (let i = 0; i < 20; i++) {
      const n = await deliverAuditSink(db, s.id, now);
      total += n;
      if (n < SINK_BATCH) break;
    }
  }
  return total;
}

let timer: NodeJS.Timeout | null = null;
export function startAuditSinkCron(db: Db): void {
  if (timer) return;
  const tick = () => void platformJob('auditSink', () => deliverAuditSinks(db))().catch((err) => console.error('[alto-people/api] audit sink delivery failed:', err));
  timer = setInterval(tick, 60_000);
  timer.unref();
}
