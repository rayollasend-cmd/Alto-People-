import { prisma } from '../db.js';
import { emitLiveEvent } from './liveEvents.js';

/**
 * "Add this worker to Fieldglass" — the handoff between HR and Finance.
 *
 * Finance owns Fieldglass worker onboarding (the client side of the money
 * cycle). Before this, HR approved an associate, scheduling assigned their
 * first shift, and Finance found out when unexplained hours appeared in a
 * billing period. Now the moment BOTH facts are true — application
 * APPROVED and a first shift assigned — every active Finance account gets
 * one bell/inbox notification with what Fieldglass needs: the associate's
 * name and contact, the client, the first shift, and the onboarding date.
 *
 * Call it from every place either fact can become true (application
 * approval, shift assign, open-shift claim approval, shift create with an
 * assignee) — it fires ONCE per associate, deduped by the notification's
 * category + linkUrl, and is silent while either fact is still missing.
 *
 * Fire-and-forget at every call site: a notification hiccup must never
 * fail an approval or an assignment.
 */

const CATEGORY = 'finance.fieldglass_add';

const DATE_FMT = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  timeZone: 'America/New_York',
});
const TIME_FMT = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'America/New_York',
});

export async function maybeNotifyFinanceNewWorker(
  associateId: string,
): Promise<void> {
  try {
    // ?associateId= opens the person's drawer directly in the People
    // directory — the click lands ON the worker, not on a search box.
    const linkUrl = `/people?associateId=${associateId}`;

    // Fired already? One notification per worker, ever. Matched by the
    // associateId inside the link (not the exact URL) so a link-format
    // change never re-fires old workers.
    const existing = await prisma.notification.findFirst({
      where: { category: CATEGORY, linkUrl: { contains: associateId } },
      select: { id: true },
    });
    if (existing) return;

    const [associate, application, firstShift] = await Promise.all([
      prisma.associate.findFirst({
        where: { id: associateId, deletedAt: null },
        select: { firstName: true, lastName: true, email: true, phone: true, hireDate: true },
      }),
      prisma.application.findFirst({
        where: { associateId, status: 'APPROVED', deletedAt: null },
        orderBy: { approvedAt: 'desc' },
        select: { approvedAt: true, client: { select: { name: true } } },
      }),
      prisma.shift.findFirst({
        where: {
          assignedAssociateId: associateId,
          status: { in: ['ASSIGNED', 'COMPLETED'] },
        },
        orderBy: { startsAt: 'asc' },
        select: {
          startsAt: true,
          position: true,
          client: { select: { name: true } },
        },
      }),
    ]);
    // Both halves must be true: approved AND scheduled.
    if (!associate || !application || !firstShift) return;

    const name = `${associate.firstName} ${associate.lastName}`.trim();
    const clientName = firstShift.client?.name ?? application.client?.name ?? '—';
    const onboarded = application.approvedAt ?? associate.hireDate;
    const contact = [associate.email, associate.phone].filter(Boolean).join(' · ');

    const subject = `Add to Fieldglass — ${name} (${clientName})`;
    const body =
      `${name} is onboarded and scheduled. ` +
      `Client: ${clientName}. ` +
      `First shift: ${DATE_FMT.format(firstShift.startsAt)}, ${TIME_FMT.format(firstShift.startsAt)} — ${firstShift.position}. ` +
      (onboarded ? `Onboarding approved ${DATE_FMT.format(onboarded)}. ` : '') +
      (contact ? `Contact: ${contact}. ` : '') +
      'Add the worker in Fieldglass before their first shift.';

    // Finance first; HR Administrator as the fallback so the signal never
    // vanishes in an org that hasn't provisioned a finance seat yet.
    let recipients = await prisma.user.findMany({
      where: { status: 'ACTIVE', role: 'FINANCE_ACCOUNTANT' },
      select: { id: true },
      take: 50,
    });
    if (recipients.length === 0) {
      recipients = await prisma.user.findMany({
        where: { status: 'ACTIVE', role: 'HR_ADMINISTRATOR' },
        select: { id: true },
        take: 50,
      });
    }
    if (recipients.length === 0) return;

    await prisma.notification.createMany({
      data: recipients.map((u) => ({
        channel: 'IN_APP' as const,
        status: 'SENT' as const,
        recipientUserId: u.id,
        subject,
        body,
        category: CATEGORY,
        linkUrl,
        sentAt: new Date(),
      })),
    });
    for (const u of recipients) emitLiveEvent(u.id, 'notification');
  } catch {
    // Never let the Fieldglass nudge break an approval or an assignment.
  }
}
