import { Router, raw } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { env } from '../config/env.js';
import { verifyResendWebhookSignature } from '../lib/resendWebhook.js';
import { enqueueAudit } from '../lib/audit.js';

export const resendWebhookRouter = Router();

/**
 * POST /resend/webhook  (public, Svix-signed)
 *
 * Resend fires this when an email we sent changes delivery state. This is
 * the only path that learns about hard bounces and spam complaints — the
 * synchronous send only knows Resend ACCEPTED the message.
 *
 * Handled event types:
 *   - email.delivered  → matched + logged; the Notification row already
 *     says SENT and there is no separate DELIVERED status, so no state
 *     change — the event row itself is the delivery receipt.
 *   - email.bounced    → Notification.status = BOUNCED, and (unless the
 *     provider marked the bounce transient) the address is upserted onto
 *     the EmailSuppression do-not-email list.
 *   - email.complained → Notification.status = COMPLAINED + suppression.
 *   Everything else → 200 with ignored: 'unhandled_event_type' (Svix
 *   retries on non-2xx; unknown types must not thrash).
 *
 * Matching: by Notification.providerMessageId (stamped by the central send
 * paths), falling back to externalRef — which holds the same Resend id for
 * every real send made by call sites that predate providerMessageId.
 *
 * Idempotency (mirrors /branch/webhook):
 *   - Svix retries on non-2xx and can double-deliver. We INSERT a
 *     ResendWebhookEvent row keyed by the svix-id header (UNIQUE); a
 *     duplicate POST collides at INSERT time and short-circuits to 200.
 *   - The whole flow runs inside a transaction so a partial failure rolls
 *     the event row back too, leaving the event eligible for reprocessing
 *     on Svix's automatic retry.
 *
 * Failure modes:
 *   - Missing RESEND_WEBHOOK_SECRET → 503 (never accept unsigned webhooks).
 *   - Bad signature / stale timestamp → 401, no body parse, no DB write.
 *   - Unknown message id → 200 ignored (logged with status=IGNORED) — the
 *     Resend account may serve other environments; don't thrash retries.
 */
resendWebhookRouter.post(
  '/',
  raw({ type: 'application/json', limit: '256kb' }),
  async (req, res) => {
    if (!env.RESEND_WEBHOOK_SECRET) {
      res.status(503).json({ error: 'webhook_not_configured' });
      return;
    }
    const rawBody = req.body as Buffer;
    const svixId = req.header('svix-id');
    const ok = verifyResendWebhookSignature(rawBody, {
      svixId,
      svixTimestamp: req.header('svix-timestamp'),
      svixSignature: req.header('svix-signature'),
    });
    if (!ok || !svixId) {
      res.status(401).json({ error: 'invalid_signature' });
      return;
    }

    let payload: {
      type?: string;
      data?: {
        email_id?: string;
        to?: string[] | string;
        bounce?: { type?: string; subType?: string; message?: string };
      };
    };
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      res.status(400).json({ error: 'invalid_json' });
      return;
    }

    const eventType = payload?.type;
    if (typeof eventType !== 'string' || !eventType) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }

    const HANDLED = new Set(['email.delivered', 'email.bounced', 'email.complained']);

    try {
      const result = await prisma.$transaction(
        async (tx) => {
          // Idempotency: insert the event row first; the unique index on
          // svixId collapses duplicate deliveries (P2002 caught below).
          let eventRow;
          try {
            eventRow = await tx.resendWebhookEvent.create({
              data: {
                svixId,
                eventType,
                payload: payload as unknown as Prisma.InputJsonValue,
                status: 'PROCESSED',
              },
            });
          } catch (err) {
            if (
              err instanceof Prisma.PrismaClientKnownRequestError &&
              err.code === 'P2002'
            ) {
              return { kind: 'duplicate' as const };
            }
            throw err;
          }

          if (!HANDLED.has(eventType)) {
            await tx.resendWebhookEvent.update({
              where: { id: eventRow.id },
              data: {
                status: 'IGNORED',
                notes: `unhandled_event_type: ${eventType}`,
                processedAt: new Date(),
              },
            });
            return { kind: 'unhandled' as const };
          }

          const messageId = payload.data?.email_id;
          const notification =
            typeof messageId === 'string' && messageId
              ? await tx.notification.findFirst({
                  where: {
                    channel: 'EMAIL',
                    OR: [
                      { providerMessageId: messageId },
                      { externalRef: messageId },
                    ],
                  },
                  orderBy: { createdAt: 'desc' },
                })
              : null;
          if (!notification) {
            await tx.resendWebhookEvent.update({
              where: { id: eventRow.id },
              data: {
                status: 'IGNORED',
                notes: `unknown_message_id: ${messageId ?? '(missing)'}`,
                processedAt: new Date(),
              },
            });
            return { kind: 'ignored' as const };
          }

          // Recipient to suppress: prefer what WE recorded at send time;
          // fall back to the event payload's to[].
          const rawTo = payload.data?.to;
          const payloadTo = Array.isArray(rawTo) ? rawTo[0] : rawTo;
          const recipientEmail = (notification.recipientEmail ?? payloadTo ?? null)
            ?.trim()
            .toLowerCase();

          let suppressedEmail: string | null = null;
          let suppressionReason: 'BOUNCED' | 'COMPLAINED' | null = null;

          if (eventType === 'email.bounced') {
            const bounce = payload.data?.bounce;
            const bounceDesc =
              bounce?.message ??
              ([bounce?.type, bounce?.subType].filter(Boolean).join('/') || null);
            await tx.notification.update({
              where: { id: notification.id },
              data: {
                status: 'BOUNCED',
                failureReason: bounceDesc
                  ? `bounced: ${bounceDesc}`.slice(0, 500)
                  : 'bounced',
              },
            });
            // Suppress on HARD bounce only. Resend labels transient
            // (mailbox-full, greylisting) bounces "Transient"; a missing
            // type is treated as hard — safer to stop mailing and let an
            // admin un-suppress than to keep hitting a dead address.
            const transient = bounce?.type?.toLowerCase() === 'transient';
            if (!transient && recipientEmail) {
              await tx.emailSuppression.upsert({
                where: { email: recipientEmail },
                create: {
                  email: recipientEmail,
                  reason: 'BOUNCED',
                  notes: bounceDesc ? bounceDesc.slice(0, 500) : null,
                },
                update: {},
              });
              suppressedEmail = recipientEmail;
              suppressionReason = 'BOUNCED';
            }
          } else if (eventType === 'email.complained') {
            await tx.notification.update({
              where: { id: notification.id },
              data: {
                status: 'COMPLAINED',
                failureReason: 'recipient marked the message as spam',
              },
            });
            if (recipientEmail) {
              await tx.emailSuppression.upsert({
                where: { email: recipientEmail },
                create: {
                  email: recipientEmail,
                  reason: 'COMPLAINED',
                  notes: 'spam complaint via Resend webhook',
                },
                // A complaint outranks a bounce: always record the
                // stronger do-not-contact signal.
                update: { reason: 'COMPLAINED' },
              });
              suppressedEmail = recipientEmail;
              suppressionReason = 'COMPLAINED';
            }
          }
          // email.delivered: nothing to flip — SENT already covers it and
          // downgrading a later BOUNCED on out-of-order redelivery would
          // lose information. The event row is the delivery receipt.

          await tx.resendWebhookEvent.update({
            where: { id: eventRow.id },
            data: { notificationId: notification.id, processedAt: new Date() },
          });

          return {
            kind: 'processed' as const,
            notificationId: notification.id,
            suppressedEmail,
            suppressionReason,
          };
        },
        // Neon cold-start headroom, same as /branch/webhook.
        { timeout: 60_000, maxWait: 10_000 },
      );

      if (result.kind === 'duplicate') {
        res.status(200).json({ ok: true, ignored: 'duplicate' });
        return;
      }
      if (result.kind === 'unhandled') {
        res.status(200).json({ ok: true, ignored: 'unhandled_event_type' });
        return;
      }
      if (result.kind === 'ignored') {
        res.status(200).json({ ok: true, ignored: 'unknown_message_id' });
        return;
      }

      if (result.suppressedEmail) {
        enqueueAudit(
          {
            actorUserId: null, // webhook is unauthenticated by design
            action: 'email.suppressed',
            entityType: 'EmailSuppression',
            entityId: result.suppressedEmail,
            metadata: {
              reason: result.suppressionReason,
              eventType,
              svixId,
              notificationId: result.notificationId,
            },
          },
          'resendWebhook',
        );
      }

      res.status(200).json({ ok: true });
    } catch (err) {
      // Log an ERROR row so ops can find what went wrong; upsert keyed by
      // svixId in case the tx partially committed (mirrors /branch/webhook).
      try {
        const notes =
          err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500);
        await prisma.resendWebhookEvent.upsert({
          where: { svixId },
          create: {
            svixId,
            eventType,
            payload: payload as unknown as Prisma.InputJsonValue,
            status: 'ERROR',
            notes,
            processedAt: new Date(),
          },
          update: { status: 'ERROR', notes, processedAt: new Date() },
        });
      } catch {
        // If even the ERROR-row write fails, swallow — the original error
        // is already on its way out via the 500.
      }
      console.error(
        '[resend-webhook] processing failed:',
        err instanceof Error ? err.stack : err,
      );
      // 500 so Svix retries; the row is ERROR (not PROCESSED) so the retry
      // hits no idempotency conflict and re-attempts.
      res.status(500).json({ error: 'processing_failed' });
    }
  },
);
