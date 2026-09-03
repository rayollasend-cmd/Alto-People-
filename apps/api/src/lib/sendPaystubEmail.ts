/**
 * Email-on-disburse for paystubs.
 *
 * When a PayrollItem flips to DISBURSED (either synchronously in the
 * /disburse handler or asynchronously via the Branch webhook), this helper
 * renders the paystub PDF and emails it to the associate as an attachment,
 * writes audit Notification rows, and stamps PayrollItem.paystubEmailedAt
 * so a duplicate webhook delivery (or a retry) doesn't double-send.
 *
 * Idempotency model:
 *   - Re-entrancy guard: if PayrollItem.paystubEmailedAt is already set,
 *     skip silently. The HR resend route bypasses this via `force: true`.
 *   - The stamp lands AFTER the Resend call returns so a transient Resend
 *     failure leaves the item unstamped and eligible for retry on the
 *     next webhook redelivery.
 *
 * Skips (no error, no stamp):
 *   - associate has no email on file
 *   - item is VOIDED or HELD (paystub itself is invalid)
 *   - net pay is non-positive (amendment with zero/negative net — there's
 *     no actual paystub the associate would expect to see)
 *
 * This module is intentionally fire-and-forget from the caller's side.
 * Callers should `void sendPaystubEmail(...)` and never await the result —
 * a Resend hiccup must not roll back a successful disbursement.
 */
import { type PrismaClient } from '@prisma/client';
import { EmailSuppressedError, send } from './notifications.js';
import { renderPaystubPdf } from './paystub.js';
import { buildPaystubDataFromItem, paystubItemInclude } from './paystubData.js';
import { env } from '../config/env.js';
import { paystubTemplate } from './emailTemplates.js';
import { emitLiveEvent } from './liveEvents.js';

type PrismaSlice = Pick<
  PrismaClient,
  'payrollItem' | 'notification' | 'user'
>;

const ITEM_INCLUDE = paystubItemInclude();

function fmtMoney(n: number): string {
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  });
}

export interface SendPaystubEmailInput {
  payrollItemId: string;
  /**
   * When true, send even if paystubEmailedAt is already set. Used by the
   * HR-only resend route. Defaults to false (skip silently if already sent).
   */
  force?: boolean;
}

export type SendPaystubSkipReason =
  | 'item_not_found'
  | 'already_emailed'
  | 'no_recipient_email'
  | 'voided_or_held'
  | 'non_positive_net'
  | 'suppressed'
  | 'send_failed';

export interface SendPaystubEmailResult {
  sent: boolean;
  /** Why we didn't send. Null when sent=true. */
  skipped: SendPaystubSkipReason | null;
  externalRef: string | null;
  failureReason: string | null;
}

/**
 * Render and email the paystub PDF. Always resolves — never throws — so
 * callers can `void sendPaystubEmail(...)` from a hot path. Failures are
 * logged to the Notification row (status=FAILED) and to the console.
 */
export async function sendPaystubEmail(
  prisma: PrismaSlice,
  input: SendPaystubEmailInput,
): Promise<SendPaystubEmailResult> {
  try {
    const item = await prisma.payrollItem.findUnique({
      where: { id: input.payrollItemId },
      include: ITEM_INCLUDE,
    });
    if (!item) {
      return reasonOnly('item_not_found');
    }

    if (!input.force && item.paystubEmailedAt) {
      return reasonOnly('already_emailed');
    }

    if (item.status === 'VOIDED' || item.status === 'HELD') {
      return reasonOnly('voided_or_held');
    }

    const netPay = Number(item.netPay);
    if (!Number.isFinite(netPay) || netPay <= 0) {
      return reasonOnly('non_positive_net');
    }

    const recipient = item.associate.email;
    if (!recipient) {
      return reasonOnly('no_recipient_email');
    }

    const data = await buildPaystubDataFromItem(prisma, item);
    const pdf = await renderPaystubPdf(data);

    const period = `${data.period.start} → ${data.period.end}`;
    // The money email gets the full branded layout — it was hand-rolled
    // bare HTML signed "— Alto People" (not even the right brand name),
    // on exactly the message a payday phisher would imitate.
    const tpl = paystubTemplate({
      firstName: item.associate.firstName,
      periodLabel: period,
      netPay: fmtMoney(netPay),
      payrollUrl: `${env.APP_BASE_URL}/payroll`,
    });
    const subject = data.amendment
      ? `[For Your Records] Amended paystub for ${period}`
      : tpl.subject;
    const body = tpl.text;
    const html = tpl.html;

    const filename = `paystub-${data.period.start}-${item.id.slice(0, 8)}.pdf`;

    let externalRef: string | null = null;
    let providerMessageId: string | null = null;
    let failureReason: string | null = null;
    let suppressed = false;
    try {
      const r = await send({
        channel: 'EMAIL',
        recipient: { userId: null, phone: null, email: recipient },
        subject,
        body,
        html,
        attachments: [
          { filename, content: pdf, contentType: 'application/pdf' },
        ],
      });
      externalRef = r.externalRef;
      providerMessageId = r.providerMessageId;
    } catch (err) {
      if (err instanceof EmailSuppressedError) suppressed = true;
      failureReason = err instanceof Error ? err.message : String(err);
    }

    // Find the associate's portal user (if any) so the bell row is linked
    // correctly. Optional — Notification rows can be email-only.
    const portalUser = await prisma.user.findFirst({
      where: { associateId: item.associateId, status: 'ACTIVE' },
      select: { id: true },
    });

    await prisma.notification.create({
      data: {
        channel: 'EMAIL',
        status: suppressed ? 'SUPPRESSED' : failureReason ? 'FAILED' : 'SENT',
        recipientUserId: portalUser?.id ?? null,
        recipientEmail: recipient,
        subject,
        body,
        category: 'payroll.paystub_emailed',
        externalRef,
        providerMessageId,
        failureReason,
        sentAt: failureReason ? null : new Date(),
      },
    });

    if (failureReason) {
      console.warn(
        '[sendPaystubEmail] send failed for item',
        input.payrollItemId,
        '-',
        failureReason,
      );
      return {
        sent: false,
        skipped: suppressed ? 'suppressed' : 'send_failed',
        externalRef: null,
        failureReason,
      };
    }

    // Stamp the audit + idempotency column AFTER the send succeeds. A
    // transient Resend error leaves the row unstamped and the next webhook
    // delivery (or HR's resend) re-attempts.
    await prisma.payrollItem.update({
      where: { id: input.payrollItemId },
      data: { paystubEmailedAt: new Date() },
    });

    // Best-effort IN_APP bell row for the portal — surfaces the same event
    // in /me/paystubs so an associate who's logged in sees a live banner.
    if (portalUser) {
      await prisma.notification.create({
        data: {
          channel: 'IN_APP',
          status: 'SENT',
          recipientUserId: portalUser.id,
          subject,
          body: `Net pay: ${fmtMoney(netPay)} for ${period}. Check your inbox or open /payroll.`,
          category: 'payroll.paystub_emailed',
          linkUrl: '/payroll',
          sentAt: new Date(),
        },
      });
      emitLiveEvent(portalUser.id, 'notification');
    }

    return {
      sent: true,
      skipped: null,
      externalRef,
      failureReason: null,
    };
  } catch (err) {
    console.warn(
      '[sendPaystubEmail] unexpected error for item',
      input.payrollItemId,
      '-',
      err instanceof Error ? err.message : err,
    );
    return {
      sent: false,
      skipped: 'send_failed',
      externalRef: null,
      failureReason: err instanceof Error ? err.message : String(err),
    };
  }
}

function reasonOnly(reason: SendPaystubSkipReason): SendPaystubEmailResult {
  return { sent: false, skipped: reason, externalRef: null, failureReason: null };
}
