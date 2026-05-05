import type { PrismaClient } from '@prisma/client';

/**
 * Gap 3 — Fan-out IN_APP notifications to every associate whose paystub
 * was just voided when an HR Admin voids a disbursed payroll run.
 *
 * Wording is associate-facing: explains the void in plain English,
 * surfaces the HR-supplied reason verbatim, and tells them to expect a
 * separate conversation with HR about the actual money — Alto does not
 * pull funds back from the rail (this is a system record correction).
 *
 * Each notification deeplinks to the paystub list so the associate can
 * see the affected paystub watermarked "VOID".
 */

const fmtPeriod = (start: Date, end: Date) =>
  `${start.toISOString().slice(0, 10)} – ${end.toISOString().slice(0, 10)}`;

export interface VoidNotifyAssociate {
  /** Associate's user-portal account id; notifications target this row. */
  userId: string;
  /** Display name only — used to log who got notified for the audit metadata. */
  name: string;
}

export interface NotifyVoidInput {
  payrollRunId: string;
  periodStart: Date;
  periodEnd: Date;
  reason: string;
  associates: VoidNotifyAssociate[];
}

export async function notifyAssociatesOfRunVoid(
  prisma: Pick<PrismaClient, 'notification'>,
  input: NotifyVoidInput,
): Promise<{ notified: number }> {
  if (input.associates.length === 0) return { notified: 0 };

  const period = fmtPeriod(input.periodStart, input.periodEnd);
  const subject = `Your paystub for ${period} was voided`;
  // Single body string used for every recipient — they all share the
  // same context (same run, same reason). Closing line tells them not to
  // expect an automatic clawback or top-up; HR will follow up directly.
  const body =
    `Your paystub for the period ${period} has been voided by HR.` +
    ` Reason: ${input.reason}.` +
    ` Your HR contact will reach out to resolve any over- or underpayment` +
    ` — Alto will not automatically pull or send funds related to this void.`;
  const linkUrl = '/me/paystubs';

  const sentAt = new Date();
  await prisma.notification.createMany({
    data: input.associates.map((a) => ({
      channel: 'IN_APP' as const,
      status: 'SENT' as const,
      recipientUserId: a.userId,
      subject,
      body,
      category: 'payroll.run_voided',
      linkUrl,
      sentAt,
    })),
  });

  return { notified: input.associates.length };
}
