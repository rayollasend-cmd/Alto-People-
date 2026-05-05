import type { PrismaClient } from '@prisma/client';
import { describeBranchFailure } from './achReturnCodes.js';

/**
 * Fan-out an in-app notification to every active HR-admin-equivalent user
 * when a Branch payment fails or is returned. Each notification carries a
 * deeplink to the run drawer so HR can land on the surface that has the
 * existing "Retry failed disbursements" button.
 *
 * Roles notified — every role with the `process:payroll` capability per
 * shared/roles.ts: HR_ADMINISTRATOR, OPERATIONS_MANAGER, MANAGER,
 * INTERNAL_RECRUITER, WORKFORCE_MANAGER, MARKETING_MANAGER, and
 * FINANCE_ACCOUNTANT. Hard-coded here rather than computed from the
 * capability map to keep the notification module dependency-free; if the
 * role list shifts, the test will catch the drift.
 */
const NOTIFY_ROLES = [
  'HR_ADMINISTRATOR',
  'OPERATIONS_MANAGER',
  'MANAGER',
  'INTERNAL_RECRUITER',
  'WORKFORCE_MANAGER',
  'MARKETING_MANAGER',
  'FINANCE_ACCOUNTANT',
] as const;

const fmtMoney = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

export interface NotifyFailureInput {
  /** Required so the bell can show the right associate name. */
  associateName: string;
  /** Net-pay dollars on the failed paystub. */
  amount: number;
  /** Raw failure reason from Branch (NACHA code or free text). Mapped to plain English. */
  rawReason: string | null;
  /** PayrollRun id — used to deeplink the notification to /payroll?run=… */
  payrollRunId: string;
}

export async function notifyHrOfPaymentFailure(
  prisma: Pick<PrismaClient, 'user' | 'notification'>,
  input: NotifyFailureInput,
): Promise<{ notified: number }> {
  const friendly = describeBranchFailure(input.rawReason);
  const subject = `Payment failed — ${input.associateName}`;
  const body = `${input.associateName}'s payment of ${fmtMoney(input.amount)} failed: ${friendly}`;
  const linkUrl = `/payroll?run=${encodeURIComponent(input.payrollRunId)}`;

  const recipients = await prisma.user.findMany({
    where: {
      status: 'ACTIVE',
      role: { in: NOTIFY_ROLES as unknown as string[] as never },
    },
    select: { id: true },
    take: 200,
  });

  if (recipients.length === 0) return { notified: 0 };

  await prisma.notification.createMany({
    data: recipients.map((u) => ({
      channel: 'IN_APP' as const,
      status: 'SENT' as const,
      recipientUserId: u.id,
      subject,
      body,
      category: 'payroll.payment_failed',
      linkUrl,
      sentAt: new Date(),
    })),
  });

  return { notified: recipients.length };
}
