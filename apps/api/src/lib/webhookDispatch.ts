import { createHmac } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';
import { assertSafeOutboundUrl } from './safeOutboundUrl.js';
import { env } from '../config/env.js';

/**
 * Phase 93 follow-up — the outbound webhook worker the route header
 * always promised.
 *
 * Two halves:
 *
 *   - emitWebhookEvent(eventType, payload, opts): domain code calls this
 *     when something noteworthy commits. It fans the event out into one
 *     PENDING WebhookDelivery row per matching subscription and NEVER
 *     throws into the caller — a webhook problem must not fail a payroll
 *     finalize or a hire approval. Call sites use `void emitWebhookEvent(...)`
 *     so nothing on the request path awaits network or even the insert.
 *
 *   - deliverPendingDeliveries(): the cron body. Claims due PENDING /
 *     RETRYING rows and POSTs them with the same HMAC-SHA256
 *     `X-Alto-Signature` scheme the test-fire endpoint established
 *     (hex digest of the raw JSON body, keyed by the webhook's secret).
 *     2xx → DELIVERED; anything else backs off 1m / 5m / 30m / 2h / 12h
 *     and gives up as FAILED after MAX_DELIVERY_ATTEMPTS attempts.
 *
 * Matching rules (mirror the admin UI): a webhook with an empty
 * eventTypes array is subscribed to ALL events (the UI renders "(all)");
 * otherwise the list must contain the eventType. A webhook with
 * clientId=null is global and hears every event; a client-scoped webhook
 * only hears events emitted with that clientId. Events emitted without a
 * clientId reach global webhooks only.
 *
 * SSRF: every attempt re-validates the destination through
 * assertSafeOutboundUrl (https-only, publicly-routable). The URL was
 * validated at subscription time too, but DNS changes — a URL that stops
 * resolving publicly is a permanent failure, not a retry.
 *
 * Concurrency: each row is claimed with a guarded updateMany on
 * (id, attemptCount), so an overlapping tick — or a second replica —
 * can't double-POST the same delivery. MULTI_REPLICA needs no extra
 * backend here; the claim is the coordination.
 */

export const MAX_DELIVERY_ATTEMPTS = 6;
/** Backoff after the Nth failed attempt (index attempt-1). */
export const RETRY_BACKOFF_MINUTES = [1, 5, 30, 120, 720] as const;
const DELIVERY_TIMEOUT_MS = 10_000;
const CLAIM_BATCH = 50;
const RESPONSE_BODY_LIMIT = 1000;

export interface EmitWebhookOpts {
  /** Scope: client-specific webhooks only hear events for their client. */
  clientId?: string | null;
  prisma?: PrismaClient;
}

/**
 * Fan an event out into PENDING delivery rows. Fire-and-forget-safe:
 * catches everything, blocks on nothing but its own two queries. Call
 * with `void emitWebhookEvent(...)` from request handlers.
 */
export async function emitWebhookEvent(
  eventType: string,
  payload: Record<string, unknown>,
  opts: EmitWebhookOpts = {},
): Promise<void> {
  const prisma = opts.prisma ?? defaultPrisma;
  try {
    const hooks = await prisma.webhook.findMany({
      where: {
        deletedAt: null,
        isActive: true,
        AND: [
          {
            OR: [
              { eventTypes: { isEmpty: true } }, // "(all)" subscription
              { eventTypes: { has: eventType } },
            ],
          },
          {
            OR: [
              { clientId: null },
              ...(opts.clientId ? [{ clientId: opts.clientId }] : []),
            ],
          },
        ],
      },
      select: { id: true },
    });
    if (hooks.length === 0) return;

    // The stored payload IS the wire body — the worker stringifies it
    // verbatim so the recorded row always matches what was signed.
    const envelope = {
      event: eventType,
      timestamp: new Date().toISOString(),
      data: payload,
    };
    await prisma.webhookDelivery.createMany({
      data: hooks.map((h) => ({
        webhookId: h.id,
        eventType,
        payload: envelope as Prisma.InputJsonValue,
        status: 'PENDING' as const,
        nextAttemptAt: new Date(),
      })),
    });
  } catch (err) {
    console.error('[webhookDispatch] emitWebhookEvent failed', {
      eventType,
      err: err instanceof Error ? err.message : err,
    });
  }
}

export interface DeliveryAttemptRow {
  id: string;
  eventType: string;
  payload: unknown;
  attemptCount: number;
}

export interface DeliveryTarget {
  url: string;
  secret: string;
}

export type AttemptOutcome = 'DELIVERED' | 'RETRYING' | 'FAILED' | 'SKIPPED';

/**
 * Perform ONE delivery attempt for a row and persist the outcome.
 * Shared by the cron worker and the synchronous test-fire endpoint so
 * both record attempts/status/backoff identically.
 *
 * Returns SKIPPED when the claim guard loses — another worker already
 * picked this row up.
 */
export async function deliverOne(
  prisma: PrismaClient,
  delivery: DeliveryAttemptRow,
  webhook: DeliveryTarget,
  now: Date = new Date(),
): Promise<{ outcome: AttemptOutcome; responseStatus: number | null }> {
  // Claim: guarded on attemptCount so concurrent ticks/replicas can't
  // both POST the same row.
  const claimed = await prisma.webhookDelivery.updateMany({
    where: {
      id: delivery.id,
      attemptCount: delivery.attemptCount,
      status: { in: ['PENDING', 'RETRYING'] },
    },
    data: { attemptCount: { increment: 1 }, lastAttemptAt: now },
  });
  if (claimed.count === 0) return { outcome: 'SKIPPED', responseStatus: null };
  const attempt = delivery.attemptCount + 1;

  let responseStatus: number | null = null;
  let responseBody: string | null = null;
  let ok = false;
  let permanentFailure = false;

  // SSRF guard — re-checked per attempt because DNS answers change.
  // An unsafe destination is permanent: retrying won't make 10.0.0.5
  // publicly routable.
  try {
    await assertSafeOutboundUrl(webhook.url);
  } catch (err) {
    permanentFailure = true;
    responseBody = `unsafe destination refused: ${
      err instanceof Error ? err.message : 'invalid URL'
    }`.slice(0, RESPONSE_BODY_LIMIT);
  }

  if (!permanentFailure) {
    const body = JSON.stringify(delivery.payload);
    const signature = createHmac('sha256', webhook.secret)
      .update(body)
      .digest('hex');
    try {
      const r = await fetch(webhook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Alto-Signature': signature,
          'X-Alto-Event': delivery.eventType,
          'X-Alto-Delivery': delivery.id,
        },
        body,
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
      responseStatus = r.status;
      // Recorded for the delivery log, never surfaced to API callers —
      // echoing it would turn deliveries into a read primitive against
      // anything the server can reach (same rule as the test-fire).
      responseBody = (await r.text()).slice(0, RESPONSE_BODY_LIMIT);
      ok = r.ok;
    } catch (err) {
      responseBody =
        err instanceof Error
          ? err.message.slice(0, RESPONSE_BODY_LIMIT)
          : 'unknown';
    }
  }

  let outcome: Exclude<AttemptOutcome, 'SKIPPED'>;
  let nextAttemptAt: Date | null = null;
  if (ok) {
    outcome = 'DELIVERED';
  } else if (permanentFailure || attempt >= MAX_DELIVERY_ATTEMPTS) {
    outcome = 'FAILED';
  } else {
    outcome = 'RETRYING';
    const backoffMinutes =
      RETRY_BACKOFF_MINUTES[
        Math.min(attempt - 1, RETRY_BACKOFF_MINUTES.length - 1)
      ];
    nextAttemptAt = new Date(now.getTime() + backoffMinutes * 60_000);
  }

  await prisma.webhookDelivery.update({
    where: { id: delivery.id },
    data: {
      status: outcome,
      responseStatus,
      responseBody,
      nextAttemptAt,
      deliveredAt: ok ? now : null,
    },
  });
  return { outcome, responseStatus };
}

export interface DeliverySweepResult {
  claimed: number;
  delivered: number;
  retried: number;
  failed: number;
}

/**
 * One worker tick: claim due PENDING/RETRYING rows (oldest first, capped
 * per tick so a backlog can't starve a sweep) and attempt each.
 * Idempotent — the next tick picks up whatever this one didn't finish.
 */
export async function deliverPendingDeliveries(
  prisma: PrismaClient = defaultPrisma,
  now: Date = new Date(),
): Promise<DeliverySweepResult> {
  const due = await prisma.webhookDelivery.findMany({
    where: {
      status: { in: ['PENDING', 'RETRYING'] },
      // Rows created before the nextAttemptAt column existed are due now.
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    orderBy: { createdAt: 'asc' },
    take: CLAIM_BATCH,
    include: {
      webhook: {
        select: { url: true, secret: true, isActive: true, deletedAt: true },
      },
    },
  });

  const result: DeliverySweepResult = {
    claimed: 0,
    delivered: 0,
    retried: 0,
    failed: 0,
  };
  for (const row of due) {
    // Subscription was deactivated/deleted after the row was enqueued —
    // close it out rather than leaving it PENDING forever.
    if (!row.webhook.isActive || row.webhook.deletedAt) {
      await prisma.webhookDelivery.update({
        where: { id: row.id },
        data: {
          status: 'FAILED',
          responseBody: 'webhook deactivated before delivery',
          lastAttemptAt: now,
          nextAttemptAt: null,
        },
      });
      result.failed += 1;
      continue;
    }
    const { outcome } = await deliverOne(
      prisma,
      {
        id: row.id,
        eventType: row.eventType,
        payload: row.payload,
        attemptCount: row.attemptCount,
      },
      { url: row.webhook.url, secret: row.webhook.secret },
      now,
    );
    if (outcome === 'SKIPPED') continue;
    result.claimed += 1;
    if (outcome === 'DELIVERED') result.delivered += 1;
    else if (outcome === 'RETRYING') result.retried += 1;
    else result.failed += 1;
  }
  return result;
}

let timer: NodeJS.Timeout | null = null;

export function startWebhookDeliveryCron(): void {
  if (timer) return;
  const seconds = env.WEBHOOK_DELIVERY_INTERVAL_SECONDS;
  if (seconds <= 0) return;
  const tick = () => {
    void deliverPendingDeliveries().catch((err) => {
      console.error('[alto-people/api] webhook delivery sweep failed:', err);
    });
  };
  tick();
  timer = setInterval(tick, seconds * 1000);
  timer.unref();
  console.log(
    `[alto-people/api] webhook delivery cron armed (every ${seconds}s; ` +
      `max ${MAX_DELIVERY_ATTEMPTS} attempts, backoff ${RETRY_BACKOFF_MINUTES.join('/')}min)`,
  );
}

export function stopWebhookDeliveryCron(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
