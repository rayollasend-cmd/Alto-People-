import { Router, raw } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { env } from '../config/env.js';
import { mapBranchStatus, verifyWebhookSignature } from '../lib/branch.js';
import type { BranchWebhookPayload } from '../lib/branch.js';
import { recordPayrollEvent } from '../lib/audit.js';
import { describeBranchFailure } from '../lib/achReturnCodes.js';
import { notifyHrOfPaymentFailure } from '../lib/payrollFailureNotify.js';
import { sendPaystubEmail } from '../lib/sendPaystubEmail.js';

export const branchWebhookRouter = Router();

/**
 * POST /branch/webhook  (public, HMAC-signed)
 *
 * Branch fires this when a payment changes lifecycle state. The disburse
 * loop initially marks an item PENDING when Branch returns PROCESSING;
 * this handler is the only path that flips it to DISBURSED (on COMPLETED)
 * or HELD (on FAILED / CANCELLED / RETURNED) without HR action.
 *
 * Idempotency:
 *   - Branch retries on non-2xx and may double-deliver on network blips.
 *   - We INSERT a BranchWebhookEvent row keyed by the event id (UNIQUE).
 *     A duplicate POST collides at INSERT time and we short-circuit to
 *     200 ignored without reprocessing.
 *   - The whole flow runs inside a Prisma transaction so a partial
 *     processing failure rolls back the event row too — leaving the
 *     event eligible for reprocessing on Branch's automatic retry.
 *
 * HR notification:
 *   - On FAILED / RETURNED, every active user with the process:payroll
 *     capability gets an in-app notification with the associate name,
 *     amount, plain-English failure reason (R01 → "Insufficient funds"),
 *     and a deeplink to /payroll?run={runId} so they land on the surface
 *     with the existing "Retry failed disbursements" button.
 *
 * Run rollup:
 *   - When this delivery flips an item to DISBURSED, we re-check the
 *     parent run; if every item is DISBURSED the run flips to DISBURSED
 *     too (the synchronous disburse path does the same rollup but only
 *     for items that resolved within its own request).
 *
 * Failure modes:
 *   - Missing BRANCH_WEBHOOK_SECRET → 503 (we will not accept unsigned
 *     webhooks under any circumstance).
 *   - Bad signature → 401, no body parse, no DB write.
 *   - Unknown payment id → 200 with ignored: 'unknown_payment_id'
 *     (logged to BranchWebhookEvent with status=IGNORED). Branch retries
 *     on non-2xx; we don't want to thrash on cross-environment leaks.
 *   - Duplicate event id → 200 with ignored: 'duplicate'.
 */
branchWebhookRouter.post(
  '/',
  raw({ type: 'application/json', limit: '256kb' }),
  async (req, res) => {
    if (!env.BRANCH_WEBHOOK_SECRET) {
      res.status(503).json({ error: 'webhook_not_configured' });
      return;
    }
    const sig = req.header('x-branch-signature');
    const rawBody = req.body as Buffer;
    if (!verifyWebhookSignature(rawBody, sig)) {
      res.status(401).json({ error: 'invalid_signature' });
      return;
    }

    let payload: BranchWebhookPayload;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      res.status(400).json({ error: 'invalid_json' });
      return;
    }

    const branchEventId = payload?.id;
    const eventType = payload?.event;
    const paymentId = payload?.payment?.id;
    const branchStatus = payload?.payment?.status;
    if (
      typeof branchEventId !== 'string' ||
      !branchEventId ||
      typeof eventType !== 'string' ||
      !eventType ||
      typeof paymentId !== 'string' ||
      !paymentId ||
      !branchStatus
    ) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }

    try {
      const result = await prisma.$transaction(
        async (tx) => {
        // Idempotency: try to insert the event row first. The unique index
        // on branchEventId collapses duplicate deliveries — we catch the
        // P2002 below and return early. Status is provisionally PROCESSED;
        // the IGNORED branch updates it before commit.
        let eventRow;
        try {
          eventRow = await tx.branchWebhookEvent.create({
            data: {
              branchEventId,
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

        // Match the payment to one of our items via disbursementRef
        // (set when the disburse loop's createPayment call returned).
        const item = await tx.payrollItem.findFirst({
          where: { disbursementRef: paymentId },
          include: {
            payrollRun: { select: { id: true, clientId: true, status: true } },
            associate: { select: { firstName: true, lastName: true } },
          },
        });
        if (!item) {
          await tx.branchWebhookEvent.update({
            where: { id: eventRow.id },
            data: {
              status: 'IGNORED',
              notes: `unknown_payment_id: ${paymentId}`,
              processedAt: new Date(),
            },
          });
          return { kind: 'ignored' as const };
        }

        // Always log the attempt regardless of state — finance reconciles
        // off this table, not the current PayrollItem.status.
        const mapped = mapBranchStatus(branchStatus);
        const failureReason = payload.payment.failure_reason ?? null;
        await tx.payrollDisbursementAttempt.create({
          data: {
            payrollItemId: item.id,
            provider: 'BRANCH',
            status: mapped,
            externalRef: paymentId,
            failureReason,
            attemptedById: null, // webhook is unauthenticated by design
          },
        });

        let runFlippedToDisbursed = false;
        if (mapped === 'SUCCESS' && item.status !== 'DISBURSED') {
          await tx.payrollItem.update({
            where: { id: item.id },
            data: {
              status: 'DISBURSED',
              disbursedAt: new Date(),
              failureReason: null,
            },
          });

          // Run rollup — if this was the last PENDING item, flip the run.
          // Only counts items NOT already DISBURSED; HELD items stay HELD
          // and block the rollup until HR retries (and that path is the
          // synchronous /disburse route which does its own rollup).
          if (item.payrollRun.status === 'FINALIZED') {
            const stillUndone = await tx.payrollItem.count({
              where: {
                payrollRunId: item.payrollRunId,
                status: { not: 'DISBURSED' },
              },
            });
            if (stillUndone === 0) {
              await tx.payrollRun.update({
                where: { id: item.payrollRunId },
                data: { status: 'DISBURSED', disbursedAt: new Date() },
              });
              runFlippedToDisbursed = true;
            }
          }
        } else if (mapped === 'FAILED' && item.status !== 'DISBURSED') {
          // FAILED / CANCELLED / RETURNED. The branchStatus on the event
          // row preserves which kind it was for finance reconciliation.
          await tx.payrollItem.update({
            where: { id: item.id },
            data: {
              status: 'HELD',
              failureReason: describeBranchFailure(failureReason),
            },
          });
        }

        // Stamp the event row with its final outcome + matched item.
        await tx.branchWebhookEvent.update({
          where: { id: eventRow.id },
          data: {
            payrollItemId: item.id,
            processedAt: new Date(),
          },
        });

        return {
          kind: 'processed' as const,
          item,
          mapped,
          failureReason,
          runFlippedToDisbursed,
        };
        },
        // Neon cold-start can take seconds; the default 5s interactive
        // tx timeout is too tight when several sequential round-trips
        // run inside the tx (event row INSERT, item lookup, attempt
        // INSERT, item UPDATE, count, run UPDATE, event UPDATE). Match
        // the timeout the synchronous /disburse path uses (60s).
        { timeout: 60_000, maxWait: 10_000 },
      );

      if (result.kind === 'duplicate') {
        res.status(200).json({ ok: true, ignored: 'duplicate' });
        return;
      }
      if (result.kind === 'ignored') {
        res.status(200).json({ ok: true, ignored: 'unknown_payment_id' });
        return;
      }

      // Side effects that don't need to be inside the transaction:
      //   - HR notifications (Notification rows can land in a separate
      //     write; if it fails we still want the item state correct).
      //   - Audit log (fire-and-forget by design in audit.ts).
      if (result.mapped === 'FAILED') {
        try {
          await notifyHrOfPaymentFailure(prisma, {
            associateName: `${result.item.associate.firstName} ${result.item.associate.lastName}`,
            amount: Number(result.item.netPay),
            rawReason: result.failureReason,
            payrollRunId: result.item.payrollRunId,
          });
        } catch (err) {
          console.warn(
            '[branch-webhook] HR notification fan-out failed:',
            err instanceof Error ? err.message : err,
          );
        }
      } else if (result.mapped === 'SUCCESS') {
        // Fire-and-forget paystub email. Branch can re-deliver the same
        // SUCCESS event; sendPaystubEmail's paystubEmailedAt guard ensures
        // we mail the associate exactly once per item.
        void sendPaystubEmail(prisma, { payrollItemId: result.item.id });
      }

      await recordPayrollEvent({
        actorUserId: null,
        action: 'payroll.branch_webhook',
        payrollRunId: result.item.payrollRunId,
        clientId: result.item.payrollRun.clientId,
        metadata: {
          branchEventId,
          paymentId,
          branchStatus,
          mapped: result.mapped,
          event: eventType,
          runFlippedToDisbursed: result.runFlippedToDisbursed,
        },
        req,
      });

      res.status(200).json({ ok: true });
    } catch (err) {
      // Log the failure as an ERROR row so ops can find what went wrong.
      // Use upsert keyed by branchEventId so a tx-timeout-then-partial-
      // commit (where the row was inserted but later updates rolled back)
      // doesn't double-throw on the unique constraint here.
      try {
        const notes = err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500);
        await prisma.branchWebhookEvent.upsert({
          where: { branchEventId },
          create: {
            branchEventId,
            eventType,
            payload: payload as unknown as Prisma.InputJsonValue,
            status: 'ERROR',
            notes,
            processedAt: new Date(),
          },
          update: {
            status: 'ERROR',
            notes,
            processedAt: new Date(),
          },
        });
      } catch {
        // If even the ERROR-row write fails, swallow — the original
        // error is already on its way out via the response.
      }
      console.error(
        '[branch-webhook] processing failed:',
        err instanceof Error ? err.stack : err,
      );
      // 500 so Branch retries — the row is in ERROR, not PROCESSED, so
      // a retry will see no idempotency conflict and re-attempt.
      res.status(500).json({ error: 'processing_failed' });
    }
  },
);
