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
import { Prisma, type PrismaClient } from '@prisma/client';
import { send } from './notifications.js';
import { renderPaystubPdf, type PaystubData } from './paystub.js';
import { env } from '../config/env.js';

type PrismaSlice = Pick<
  PrismaClient,
  'payrollItem' | 'notification' | 'user'
>;

const ITEM_INCLUDE = {
  payrollRun: { include: { client: { select: { name: true } } } },
  associate: true,
} satisfies Prisma.PayrollItemInclude;

type LoadedItem = Prisma.PayrollItemGetPayload<{ include: typeof ITEM_INCLUDE }>;

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function fmtMoney(n: number): string {
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  });
}

/**
 * Build the PaystubData payload for a fully-loaded PayrollItem. Pure —
 * no DB hits. Mirrors the inline builder in the GET /paystub.pdf route so
 * the on-demand download and the email-on-disburse PDF are byte-identical.
 */
export function buildPaystubData(
  item: LoadedItem,
  issuedAt: Date = new Date(),
): PaystubData {
  const stateLabel = item.taxState
    ? `${item.taxState} state withholding`
    : 'State withholding';

  const totalEmployeeTax =
    Math.round(
      (Number(item.federalWithholding) +
        Number(item.fica) +
        Number(item.medicare) +
        Number(item.stateWithholding)) *
        100,
    ) / 100;

  return {
    company: { name: item.payrollRun.client?.name ?? 'Alto Etho LLC' },
    associate: {
      firstName: item.associate.firstName,
      lastName: item.associate.lastName,
      email: item.associate.email,
      addressLine1: item.associate.addressLine1,
      city: item.associate.city,
      state: item.associate.state,
      zip: item.associate.zip,
    },
    period: {
      start: ymd(item.payrollRun.periodStart),
      end: ymd(item.payrollRun.periodEnd),
    },
    earnings: {
      hours: Number(item.hoursWorked),
      rate: Number(item.hourlyRate),
      gross: Number(item.grossPay),
    },
    taxes: {
      federalIncomeTax: Number(item.federalWithholding),
      socialSecurity: Number(item.fica),
      medicare: Number(item.medicare),
      stateIncomeTax: Number(item.stateWithholding),
      stateLabel,
    },
    totals: {
      totalEmployeeTax,
      netPay: Number(item.netPay),
    },
    ytd: {
      wages: Number(item.ytdWages),
      medicareWages: Number(item.ytdMedicareWages),
    },
    employer: {
      fica: Number(item.employerFica),
      medicare: Number(item.employerMedicare),
      futa: Number(item.employerFuta),
      suta: Number(item.employerSuta),
    },
    meta: {
      runId: item.payrollRunId,
      itemId: item.id,
      issuedAt: issuedAt.toISOString(),
    },
    ...(Number(item.reimbursementsTotal) > 0
      ? { reimbursements: { total: Number(item.reimbursementsTotal) } }
      : {}),
    ...(item.payrollRun.kind === 'AMENDMENT' && item.payrollRun.amendsRunId
      ? {
          amendment: {
            reason: item.payrollRun.amendmentReason ?? '',
            sourceRunId: item.payrollRun.amendsRunId,
          },
        }
      : {}),
    ...(item.payrollRun.status === 'CANCELLED' || item.status === 'VOIDED'
      ? {
          voided: {
            voidedAt: (
              item.payrollRun.cancelledAt ?? item.voidedAt ?? new Date()
            ).toISOString(),
            reason: item.payrollRun.cancelReason,
          },
        }
      : {}),
  };
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

    const data = buildPaystubData(item);
    const pdf = await renderPaystubPdf(data);

    const period = `${data.period.start} → ${data.period.end}`;
    const subject = data.amendment
      ? `Amended paystub for ${period}`
      : `Your paystub for ${period}`;
    const body =
      `Hi ${item.associate.firstName},\n\n` +
      `Your paystub for the period ${period} is attached as a PDF.\n\n` +
      `Net pay: ${fmtMoney(netPay)}\n\n` +
      `You can also download the latest copy any time from ` +
      `${env.APP_BASE_URL}/me/paystubs.\n\n` +
      `— Alto People`;
    const html =
      `<p>Hi ${escapeHtml(item.associate.firstName)},</p>` +
      `<p>Your paystub for the period <strong>${escapeHtml(period)}</strong> is attached as a PDF.</p>` +
      `<p><strong>Net pay:</strong> ${escapeHtml(fmtMoney(netPay))}</p>` +
      `<p>You can also download the latest copy any time from ` +
      `<a href="${escapeHtml(env.APP_BASE_URL)}/me/paystubs">your paystubs page</a>.</p>` +
      `<p>— Alto People</p>`;

    const filename = `paystub-${data.period.start}-${item.id.slice(0, 8)}.pdf`;

    let externalRef: string | null = null;
    let failureReason: string | null = null;
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
    } catch (err) {
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
        status: failureReason ? 'FAILED' : 'SENT',
        recipientUserId: portalUser?.id ?? null,
        recipientEmail: recipient,
        subject,
        body,
        category: 'payroll.paystub_emailed',
        externalRef,
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
        skipped: 'send_failed',
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
          body: `Net pay: ${fmtMoney(netPay)} for ${period}. Check your inbox or open /me/paystubs.`,
          category: 'payroll.paystub_emailed',
          linkUrl: '/me/paystubs',
          sentAt: new Date(),
        },
      });
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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
