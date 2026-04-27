import { Router, raw } from 'express';
import { prisma } from '../db.js';
import { env } from '../config/env.js';
import { mapBranchStatus, verifyWebhookSignature } from '../lib/branch.js';
import type { BranchWebhookPayload } from '../lib/branch.js';
import { recordPayrollEvent } from '../lib/audit.js';

export const branchWebhookRouter = Router();

/**
 * POST /branch/webhook  (public, HMAC-signed)
 *
 * Branch fires this when a payment changes lifecycle state. The disburse
 * loop initially marks an item PENDING when Branch returns PROCESSING;
 * this handler is the only path that flips it to DISBURSED (on COMPLETED)
 * or HELD (on FAILED/CANCELLED) without HR action.
 *
 * Why a dedicated router with `raw()`:
 *   - HMAC verification needs the *exact* bytes Branch signed, before any
 *     JSON parser has touched them. The global express.json() parser
 *     would consume the stream and we'd be left re-serializing — which
 *     fails on whitespace differences.
 *   - We mount this router BEFORE express.json() in app.ts.
 *
 * Failure modes:
 *   - Missing BRANCH_WEBHOOK_SECRET → 503 (we will not accept unsigned
 *     webhooks under any circumstance).
 *   - Bad signature → 401, no body parse, no DB write.
 *   - Unknown payment id → 200 (Branch retries on non-2xx; we don't want
 *     to thrash on a payment that belongs to a different environment).
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

    const paymentId = payload?.payment?.id;
    const branchStatus = payload?.payment?.status;
    if (typeof paymentId !== 'string' || !paymentId || !branchStatus) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }

    // PayrollItem.disbursementRef holds the Branch payment id we got back
    // from createPayment(). One row per item — narrow lookup.
    const item = await prisma.payrollItem.findFirst({
      where: { disbursementRef: paymentId },
      include: { payrollRun: { select: { id: true, clientId: true } } },
    });
    if (!item) {
      // Acknowledge so Branch doesn't retry forever — most often this is
      // a webhook from a different environment hitting the same endpoint.
      res.status(200).json({ ok: true, ignored: 'unknown_payment_id' });
      return;
    }

    const mapped = mapBranchStatus(branchStatus);
    const failureReason = payload.payment.failure_reason ?? null;

    // Always log the event regardless of state — finance reconciles off
    // the attempt log, not the current PayrollItem.status.
    await prisma.payrollDisbursementAttempt.create({
      data: {
        payrollItemId: item.id,
        provider: 'BRANCH',
        status: mapped,
        externalRef: paymentId,
        failureReason,
        attemptedById: null, // webhook is unauthenticated by design
      },
    });

    if (mapped === 'SUCCESS' && item.status !== 'DISBURSED') {
      await prisma.payrollItem.update({
        where: { id: item.id },
        data: {
          status: 'DISBURSED',
          disbursedAt: new Date(),
          failureReason: null,
        },
      });
    } else if (mapped === 'FAILED' && item.status !== 'DISBURSED') {
      await prisma.payrollItem.update({
        where: { id: item.id },
        data: {
          status: 'HELD',
          failureReason: failureReason ?? 'branch_reported_failure',
        },
      });
    }

    await recordPayrollEvent({
      actorUserId: null,
      action: 'payroll.branch_webhook',
      payrollRunId: item.payrollRunId,
      clientId: item.payrollRun.clientId,
      metadata: {
        paymentId,
        branchStatus,
        mapped,
        event: payload.event,
      },
      req,
    });

    res.status(200).json({ ok: true });
  }
);
