import { prisma } from '../db.js';
import { emitLiveEvent } from './liveEvents.js';
import { notifyUser } from './notify.js';

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

/** The client the worker CURRENTLY belongs to: their open assignment's
 *  client, else their latest APPROVED application's — the same order the
 *  migration backfill used. */
export async function currentClientOf(
  associateId: string,
): Promise<{ id: string; name: string } | null> {
  const assignment = await prisma.associateAssignment.findFirst({
    where: { associateId, endedAt: null },
    orderBy: { startedAt: 'desc' },
    select: {
      location: { select: { client: { select: { id: true, name: true } } } },
    },
  });
  if (assignment?.location.client) return assignment.location.client;
  const app = await prisma.application.findFirst({
    where: { associateId, status: 'APPROVED', deletedAt: null },
    orderBy: { approvedAt: 'desc' },
    select: { client: { select: { id: true, name: true } } },
  });
  return app?.client ?? null;
}

/** Cross-client TRANSFER: registered under client A, now working client
 *  B → tell finance to close the old Fieldglass account and open a new
 *  one. Deduped per (associate, destination client). */
async function maybeNotifyTransfer(
  associateId: string,
  registeredClientId: string,
): Promise<void> {
  const current = await currentClientOf(associateId);
  if (!current || current.id === registeredClientId) return;

  const linkUrl = `/people?associateId=${associateId}&fgClient=${current.id}`;
  const existing = await prisma.notification.findFirst({
    where: {
      category: CATEGORY,
      AND: [
        { linkUrl: { contains: associateId } },
        { linkUrl: { contains: current.id } },
      ],
    },
    select: { id: true },
  });
  if (existing) return;

  const [associate, oldClient] = await Promise.all([
    prisma.associate.findFirst({
      where: { id: associateId, deletedAt: null },
      select: { firstName: true, lastName: true, email: true, phone: true },
    }),
    prisma.client.findFirst({
      where: { id: registeredClientId },
      select: { name: true },
    }),
  ]);
  if (!associate) return;
  const name = `${associate.firstName} ${associate.lastName}`.trim();
  const contact = [associate.email, associate.phone].filter(Boolean).join(' · ');

  await sendToFinance({
    subject: `Fieldglass transfer — ${name}: ${oldClient?.name ?? '—'} → ${current.name}`,
    body:
      `${name} moved clients. ` +
      `Close their Fieldglass account under ${oldClient?.name ?? 'the previous client'} ` +
      `and open a new one under ${current.name}. ` +
      (contact ? `Contact: ${contact}. ` : '') +
      'The Fieldglass queue on your dashboard tracks this until you mark it done.',
    linkUrl,
  });
}

/** One bell/inbox row on every active Finance seat (HR admins as the
 *  fallback when no Finance account exists yet). Shared by the Fieldglass
 *  add/transfer/close notices and the other Finance-bound handoffs. */
export async function sendToFinance(opts: {
  subject: string;
  body: string;
  linkUrl: string;
  category?: string;
  /** Also email each seat (their per-category email mute still applies) —
   *  for handoffs Accounts must act on outside Alto, like a transfer. */
  email?: boolean;
}): Promise<void> {
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
  if (opts.email) {
    // notifyUser writes the same bell row AND sends the email.
    await Promise.all(
      recipients.map((u) =>
        notifyUser(u.id, {
          subject: opts.subject,
          body: opts.body,
          category: opts.category ?? CATEGORY,
          linkUrl: opts.linkUrl,
        }),
      ),
    );
    return;
  }
  await prisma.notification.createMany({
    data: recipients.map((u) => ({
      channel: 'IN_APP' as const,
      status: 'SENT' as const,
      recipientUserId: u.id,
      subject: opts.subject,
      body: opts.body,
      category: opts.category ?? CATEGORY,
      linkUrl: opts.linkUrl,
      sentAt: new Date(),
    })),
  });
  for (const u of recipients) emitLiveEvent(u.id, 'notification');
}

const CLOSE_CATEGORY = 'finance.fieldglass_close';

/**
 * The lifecycle's last chapter: a separated worker with a live Fieldglass
 * registration means an open account at the client for someone who no
 * longer works here. Tell Finance once — close the account, prepare the
 * final pay. Deactivation (a PAUSE, reversible in one click) deliberately
 * does NOT fire this.
 */
export async function maybeNotifyFinanceDeparture(
  associateId: string,
  lastDayWorked?: Date | null,
): Promise<void> {
  try {
    const registration = await prisma.fieldglassRegistration.findUnique({
      where: { associateId },
      select: { client: { select: { name: true } } },
    });
    if (!registration) return;

    const linkUrl = `/people?associateId=${associateId}`;
    const existing = await prisma.notification.findFirst({
      where: { category: CLOSE_CATEGORY, linkUrl: { contains: associateId } },
      select: { id: true },
    });
    if (existing) return;

    const associate = await prisma.associate.findUnique({
      where: { id: associateId },
      select: { firstName: true, lastName: true },
    });
    if (!associate) return;
    const name = `${associate.firstName} ${associate.lastName}`.trim();
    const clientName = registration.client?.name ?? 'their client';

    await sendToFinance({
      subject: `Fieldglass close-out — ${name} (${clientName})`,
      body:
        `${name} has separated` +
        (lastDayWorked ? ` (last day worked ${DATE_FMT.format(lastDayWorked)})` : '') +
        `. Close their Fieldglass account under ${clientName} and prepare final pay. ` +
        'The Fieldglass queue on your dashboard tracks this until you mark it closed.',
      linkUrl,
      category: CLOSE_CATEGORY,
    });
  } catch {
    // Never let the close-out nudge break a separation.
  }
}

export async function maybeNotifyFinanceNewWorker(
  associateId: string,
): Promise<void> {
  try {
    // Already registered? Then the only possible news is a TRANSFER.
    const registration = await prisma.fieldglassRegistration.findUnique({
      where: { associateId },
      select: { clientId: true },
    });
    if (registration) {
      if (registration.clientId) {
        await maybeNotifyTransfer(associateId, registration.clientId);
      }
      return;
    }

    // ?associateId= opens the person's drawer directly in the People
    // directory — the click lands ON the worker, not on a search box.
    const linkUrl = `/people?associateId=${associateId}`;

    // Fired already? One ADD notification per worker. Matched by the
    // associateId inside the link (not the exact URL) so a link-format
    // change never re-fires old workers. Transfer notifications carry a
    // client id too, so this exact-id-only probe must exclude them.
    const existing = await prisma.notification.findFirst({
      where: {
        category: CATEGORY,
        linkUrl: { contains: associateId },
        NOT: { linkUrl: { contains: 'fgClient=' } },
      },
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
    // The client they work at NOW — after a transfer, their first shift and
    // their application both sit at the client they left.
    const current = await currentClientOf(associateId);
    const clientName = current?.name ?? firstShift.client?.name ?? application.client?.name ?? '—';
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

    await sendToFinance({ subject, body, linkUrl });
  } catch {
    // Never let the Fieldglass nudge break an approval or an assignment.
  }
}

/**
 * A cross-client transfer, told to Accounts (every Finance seat — bell AND
 * email) the moment it's recorded, so the worker moves in Fieldglass too.
 * Whatever the Fieldglass state:
 *   - registered under the client they left → close there, add under the
 *     new client;
 *   - not marked as added yet → add them under the NEW client (not the old);
 *   - already registered under the new client → make sure nothing is left
 *     open under the old one.
 * The effective date and the new store ride along. Deduped per transfer
 * (a retried request never double-sends; a second transfer is new news).
 * The old path only spoke when Fieldglass registration was already on
 * file, and only in the bell — most transfers reached nobody.
 */
export async function notifyFinanceOfTransfer(input: {
  associateId: string;
  fromClientId: string;
  toClientId: string;
  toLocationName: string;
  effectiveDate: string;
  transferId: string;
}): Promise<void> {
  try {
    const linkUrl =
      `/people?associateId=${input.associateId}&fgClient=${input.toClientId}` +
      `&fgTransfer=${input.transferId}`;
    const existing = await prisma.notification.findFirst({
      where: { category: CATEGORY, linkUrl: { contains: `fgTransfer=${input.transferId}` } },
      select: { id: true },
    });
    if (existing) return;

    const [associate, from, to, registration] = await Promise.all([
      prisma.associate.findFirst({
        where: { id: input.associateId, deletedAt: null },
        select: { firstName: true, lastName: true, email: true, phone: true },
      }),
      prisma.client.findUnique({
        where: { id: input.fromClientId },
        select: { name: true, fieldglassSiteName: true },
      }),
      prisma.client.findUnique({
        where: { id: input.toClientId },
        select: { name: true, fieldglassSiteName: true },
      }),
      prisma.fieldglassRegistration.findUnique({
        where: { associateId: input.associateId },
        select: { clientId: true },
      }),
    ]);
    if (!associate || !from || !to) return;
    const name = `${associate.firstName} ${associate.lastName}`.trim();
    const contact = [associate.email, associate.phone].filter(Boolean).join(' · ');
    // Fieldglass knows sites by their own label when the client has one.
    const site = (c: { name: string; fieldglassSiteName: string | null }) =>
      c.fieldglassSiteName ? `${c.name} (Fieldglass site "${c.fieldglassSiteName}")` : c.name;
    const [y, m, d] = input.effectiveDate.split('-').map(Number);
    const effective = DATE_FMT.format(new Date(Date.UTC(y!, m! - 1, d!, 12)));

    const todo =
      registration?.clientId === input.toClientId
        ? `They're already registered under ${to.name} in Fieldglass — make sure nothing is left open under ${site(from)}.`
        : registration
          ? `In Fieldglass: close their worker record under ${site(from)} and add them under ${site(to)}.`
          : `They aren't marked as added in Fieldglass yet — add them under ${site(to)}, not ${from.name}.`;

    await sendToFinance({
      subject: `Fieldglass transfer — ${name}: ${from.name} → ${to.name}`,
      body:
        `${name} is moving from ${from.name} to ${to.name} (${input.toLocationName}), effective ${effective}. ` +
        `${todo} ` +
        (contact ? `Contact: ${contact}. ` : '') +
        'The Fieldglass queue on your dashboard tracks this until you mark it done.',
      linkUrl,
      email: true,
    });
  } catch {
    // Never let the Fieldglass nudge break a transfer.
  }
}
