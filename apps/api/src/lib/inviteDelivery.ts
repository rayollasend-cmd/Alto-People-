import { prisma } from '../db.js';
import { env } from '../config/env.js';
import { inviteTemplate } from './emailTemplates.js';
import { generateInviteToken } from './inviteToken.js';
import { send } from './notifications.js';

/**
 * The onboarding invite email, sent now or held for the Undo window.
 *
 * Sending an invite used to be instant and final: a recruiter who hired
 * the wrong person, or invited someone to the wrong client, had already
 * emailed them a live link. Invites from a single send and from a hire
 * now wait INVITE_UNDO_SECONDS first — the application carries
 * `inviteEmailDueAt` — and the toast that says "sent" carries an Undo.
 * Undo cancels the application before the email exists.
 *
 * The link is minted at send time, never before: a held invite has no
 * token at all, so nothing can leak from it. Whoever clears the due time
 * sends it — the in-process timer set at invite time, or the due-invite
 * sweep if the server restarted in between — so it goes out exactly once.
 */

/** How long a new invite waits for an Undo. */
export const INVITE_UNDO_SECONDS = 20;

/** Email only holds when there is email to hold; locally the link is shown instead. */
export function invitesAreEmailed(): boolean {
  return Boolean(env.RESEND_API_KEY && env.RESEND_FROM);
}

/**
 * Email an invite link and record the attempt. Non-fatal: HR can resend.
 * Returns whether the provider accepted it.
 */
export async function sendInviteEmail(input: {
  userId: string;
  email: string;
  firstName: string;
  clientName: string;
  hireDate: Date | null;
  rawToken: string;
  expiresAt: Date;
  actorUserId: string | null;
}): Promise<{ acceptUrl: string; emailRef: string | null; emailFailed: string | null }> {
  const acceptUrl = `${env.APP_BASE_URL}/accept-invite/${input.rawToken}`;
  const tpl = inviteTemplate({
    firstName: input.firstName,
    clientName: input.clientName,
    hireDate: input.hireDate ? input.hireDate.toISOString().slice(0, 10) : null,
    magicLink: acceptUrl,
    linkExpiresAt: input.expiresAt.toISOString().slice(0, 10),
  });
  let emailRef: string | null = null;
  let emailFailed: string | null = null;
  try {
    const r = await send({
      channel: 'EMAIL',
      // This caller writes its own Notification row for the attempt.
      audit: false,
      recipient: { userId: input.userId, phone: null, email: input.email },
      subject: tpl.subject,
      body: tpl.text,
      html: tpl.html,
    });
    emailRef = r.externalRef;
  } catch (err) {
    emailFailed = err instanceof Error ? err.message : String(err);
  }
  // Best-effort bookkeeping: the invite has already committed. A transient
  // failure writing the Notification row used to 500 the request — HR
  // retried and minted a DUPLICATE application for the same hire.
  try {
    await prisma.notification.create({
      data: {
        channel: 'EMAIL',
        status: emailFailed ? 'FAILED' : 'SENT',
        recipientUserId: input.userId,
        recipientEmail: input.email,
        subject: tpl.subject,
        body: tpl.text,
        category: 'onboarding.invite',
        externalRef: emailRef,
        failureReason: emailFailed,
        sentAt: emailFailed ? null : new Date(),
        senderUserId: input.actorUserId,
      },
    });
  } catch (err) {
    console.error('[onboarding] invite notification row failed to persist', err);
  }
  return { acceptUrl, emailRef, emailFailed };
}

/**
 * Send one held invite if its Undo window has passed and it wasn't undone.
 * Returns true when this call sent it.
 */
export async function deliverDueInvite(applicationId: string, now = new Date()): Promise<boolean> {
  // The claim: clearing the due time is what entitles this call to send.
  const claimed = await prisma.application.updateMany({
    where: { id: applicationId, inviteEmailDueAt: { not: null, lte: now }, status: 'DRAFT', deletedAt: null },
    data: { inviteEmailDueAt: null },
  });
  if (claimed.count === 0) return false;
  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    include: {
      associate: { select: { firstName: true, email: true, hireDate: true } },
      client: { select: { name: true } },
    },
  });
  if (!app) return false;
  const user = await prisma.user.findFirst({ where: { associateId: app.associateId, deletedAt: null } });
  // Undone, or already set up another way: nothing to send.
  if (!user || user.status !== 'INVITED') return false;
  const invite = generateInviteToken();
  const expiresAt = new Date(now.getTime() + env.INVITE_TOKEN_TTL_SECONDS * 1000);
  await prisma.inviteToken.create({ data: { tokenHash: invite.hash, userId: user.id, expiresAt } });
  await sendInviteEmail({
    userId: user.id,
    email: app.associate.email,
    firstName: app.associate.firstName,
    clientName: app.client.name,
    hireDate: app.associate.hireDate,
    rawToken: invite.raw,
    expiresAt,
    actorUserId: null,
  });
  return true;
}

/** Send every held invite whose window has passed. */
export async function deliverDueInvites(now = new Date()): Promise<number> {
  const due = await prisma.application.findMany({
    where: { inviteEmailDueAt: { not: null, lte: now }, status: 'DRAFT', deletedAt: null },
    select: { id: true },
    take: 100,
  });
  let sent = 0;
  for (const a of due) if (await deliverDueInvite(a.id, now)) sent += 1;
  return sent;
}

/** Send a held invite when its window closes, without waiting for the sweep. */
export function scheduleInviteDelivery(applicationId: string, dueAt: Date): void {
  const t = setTimeout(
    () => void deliverDueInvite(applicationId).catch((err) => console.error('[onboarding] held invite failed to send', err)),
    Math.max(0, dueAt.getTime() - Date.now()) + 50,
  );
  t.unref();
}

let timer: NodeJS.Timeout | null = null;

/** The safety net for held invites: a restart can't lose one. */
export function startDueInviteCron(): void {
  if (timer) return;
  const seconds = env.DUE_INVITE_SWEEP_SECONDS;
  if (seconds <= 0) return;
  const run = () => {
    void deliverDueInvites().catch((err) => console.error('[alto-people/api] due-invite sweep failed', err));
  };
  run();
  timer = setInterval(run, seconds * 1000);
  timer.unref();
  console.log(`[alto-people/api] due-invite sweep armed (every ${seconds}s; undo window ${INVITE_UNDO_SECONDS}s)`);
}

export function stopDueInviteCron(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
