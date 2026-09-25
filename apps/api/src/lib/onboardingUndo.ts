import type { ApplicationStatus, Prisma } from '@prisma/client';
import type { Request } from 'express';
import { prisma } from '../db.js';
import { env } from '../config/env.js';
import { HttpError } from '../middleware/error.js';
import { recordOnboardingEvent } from './audit.js';
import { revertCandidateHire } from './candidateHire.js';
import { generateInviteToken } from './inviteToken.js';
import { invitesAreEmailed, sendInviteEmail } from './inviteDelivery.js';
import { hasProtectedHistory, purgeGhost } from './onboardingPurge.js';

/**
 * Taking things back: a hire, a mistaken onboarding invite, and invites
 * nobody answered.
 *
 * Nothing here was possible before. A recruiter who hired the wrong
 * person, or sent an invite to the wrong address or client, could only
 * "reject" the application — which emails the person a decline — and the
 * link kept working. A hire could never be undone at all.
 *
 * The line that can't be crossed is the person having STARTED: completed
 * any onboarding task, submitted, signed, been scheduled, clocked in or
 * been paid since this invite. After that it is employment, and it ends
 * with a separation, not an undo — records stay intact.
 *
 * Someone who never did anything is removed outright (the onboarding ghost
 * purge — their login, application and uploads; their email is free for
 * a correct invite; a permanent audit row keeps who and why). Anyone with
 * history from before — a rehire, a second invite beside a live one — is
 * kept, their application CANCELLED and their link revoked instead.
 */

const LIVE: ApplicationStatus[] = ['DRAFT', 'SUBMITTED', 'IN_REVIEW'];
const DAY = 86_400_000;

/** How long an invite nobody touched stays open after its last reminder. */
export const INVITE_EXPIRE_AFTER_DAYS = 14;

export const CANCEL_REASONS = [
  'SENT_IN_ERROR',
  'WRONG_PERSON',
  'WRONG_CLIENT',
  'DUPLICATE',
  'NOT_JOINING',
  'OTHER',
] as const;
export type CancelReason = (typeof CANCEL_REASONS)[number] | 'HIRE_UNDONE' | 'EXPIRED';

/**
 * What the person has done since this invite, in words for the refusal —
 * or null when they haven't started.
 */
export async function startedSince(associateId: string, applicationId: string, since: Date): Promise<string | null> {
  const app = await prisma.application.findUnique({ where: { id: applicationId }, select: { status: true, submittedAt: true } });
  if (app && (app.status !== 'DRAFT' || app.submittedAt)) return 'submitted their onboarding';
  if (await prisma.onboardingTask.count({ where: { checklist: { applicationId }, status: 'DONE' }, take: 1 })) {
    return 'started their onboarding paperwork';
  }
  if (await prisma.esignAgreement.count({ where: { applicationId, signedAt: { not: null } }, take: 1 })) {
    return 'signed their agreement';
  }
  if (await prisma.timeEntry.count({ where: { associateId, clockInAt: { gte: since } }, take: 1 })) return 'clocked in';
  if (await prisma.kioskPunch.count({ where: { associateId, createdAt: { gte: since } }, take: 1 })) return 'clocked in';
  if (await prisma.payrollItem.count({ where: { associateId, createdAt: { gte: since } }, take: 1 })) return 'been paid';
  if (await prisma.externalPayment.count({ where: { associateId, createdAt: { gte: since } }, take: 1 })) return 'been paid';
  if (await prisma.shift.count({ where: { assignedAssociateId: associateId, startsAt: { gte: since } }, take: 1 })) {
    return 'been scheduled for a shift';
  }
  return null;
}

/**
 * Close one application: CANCELLED, with why and by whom. When it was the
 * person's only open invite and they aren't an employee, their link dies
 * with it — every open token consumed and the login disabled (a disabled
 * account's link is refused even if unused). A second, still-open invite
 * for the same person keeps working.
 */
async function closeApplication(
  tx: Prisma.TransactionClient,
  app: { id: string; associateId: string },
  opts: { reason: CancelReason; note: string | null; actorUserId: string | null; now: Date },
): Promise<void> {
  await tx.application.update({
    where: { id: app.id },
    data: {
      status: 'CANCELLED',
      cancelledAt: opts.now,
      cancelReason: opts.reason,
      cancelNote: opts.note,
      cancelledById: opts.actorUserId,
      inviteEmailDueAt: null,
    },
  });
  const [otherLive, employed] = await Promise.all([
    tx.application.count({ where: { associateId: app.associateId, id: { not: app.id }, status: { in: LIVE }, deletedAt: null } }),
    tx.application.count({ where: { associateId: app.associateId, status: 'APPROVED', deletedAt: null } }),
  ]);
  if (otherLive || employed) return;
  const user = await tx.user.findFirst({ where: { associateId: app.associateId, deletedAt: null } });
  if (!user) return;
  await tx.inviteToken.updateMany({ where: { userId: user.id, consumedAt: null }, data: { consumedAt: opts.now } });
  if (user.status !== 'DISABLED') {
    await tx.user.update({ where: { id: user.id }, data: { status: 'DISABLED', tokenVersion: { increment: 1 } } });
  }
}

/** A rehire's undone hire leaves them separated again, as they were. */
async function restoreSeparation(tx: Prisma.TransactionClient, associateId: string): Promise<void> {
  const last = await tx.separation.findFirst({
    where: { associateId },
    orderBy: { lastDayWorked: 'desc' },
    select: { lastDayWorked: true, completedAt: true },
  });
  if (last) {
    await tx.associate.update({ where: { id: associateId }, data: { separatedAt: last.completedAt ?? last.lastDayWorked } });
  }
}

/* ===== Undo hire ========================================================== */

export async function undoHire(input: {
  candidateId: string;
  actorUserId: string;
  reason: string;
  req?: Request;
}): Promise<{ mode: 'removed' | 'cancelled' | 'candidate_only' }> {
  const now = new Date();
  const c = await prisma.candidate.findFirst({ where: { id: input.candidateId, deletedAt: null } });
  if (!c) throw new HttpError(404, 'candidate_not_found', 'Candidate not found');
  if (c.stage !== 'HIRED') throw new HttpError(409, 'not_hired', 'Only a hire can be undone.');
  const revert = { reason: input.reason, actorUserId: input.actorUserId };

  const assoc = c.hiredAssociateId
    ? await prisma.associate.findUnique({
        where: { id: c.hiredAssociateId },
        select: { id: true, email: true, firstName: true, lastName: true },
      })
    : null;
  // Their onboarding is already gone (purged, or a hire from before the
  // link was kept): only the candidate goes back.
  if (!assoc) {
    await prisma.$transaction((tx) => revertCandidateHire(tx, { candidateId: c.id }, revert));
    return { mode: 'candidate_only' };
  }

  // The invite this hire sent — named on the Hired event.
  const hiredEvent = await prisma.candidateEvent.findFirst({
    where: { candidateId: c.id, kind: 'HIRED' },
    orderBy: { createdAt: 'desc' },
    select: { metadata: true, createdAt: true },
  });
  const meta = (hiredEvent?.metadata ?? {}) as { applicationId?: string };
  const app = meta.applicationId
    ? await prisma.application.findUnique({ where: { id: meta.applicationId } })
    : await prisma.application.findFirst({ where: { associateId: assoc.id, deletedAt: null }, orderBy: { createdAt: 'desc' } });
  const since = app?.invitedAt ?? hiredEvent?.createdAt ?? c.hiredAt ?? now;
  const started = app ? await startedSince(assoc.id, app.id, since) : null;
  if (started) {
    throw new HttpError(
      409,
      'already_started',
      `${c.firstName} has already ${started} — end their employment with a separation instead of undoing the hire.`,
    );
  }

  const user = await prisma.user.findFirst({ where: { associateId: assoc.id }, select: { id: true } });
  if (!(await hasProtectedHistory(prisma, assoc.id))) {
    // Never did anything: removed, as the onboarding clean-up would, and
    // the candidate goes back in the same transaction.
    await purgeGhost(
      prisma,
      { associateId: assoc.id, userId: user?.id ?? null, email: assoc.email, firstName: assoc.firstName, lastName: assoc.lastName },
      'hire_undone',
      now,
      revert,
    );
    return { mode: 'removed' };
  }

  // Someone with history (a rehire): keep them, cancel this invite.
  await prisma.$transaction(async (tx) => {
    if (app && LIVE.includes(app.status)) {
      await closeApplication(tx, app, { reason: 'HIRE_UNDONE', note: input.reason, actorUserId: input.actorUserId, now });
    }
    await restoreSeparation(tx, assoc.id);
    await revertCandidateHire(tx, { candidateId: c.id }, revert);
  });
  if (app) {
    await recordOnboardingEvent({
      actorUserId: input.actorUserId,
      action: 'onboarding.application_cancelled',
      applicationId: app.id,
      clientId: app.clientId,
      metadata: { reason: 'HIRE_UNDONE', note: input.reason, candidateId: c.id },
      req: input.req,
    });
  }
  return { mode: 'cancelled' };
}

/* ===== Cancel an invite =================================================== */

export async function cancelApplication(input: {
  applicationId: string;
  actorUserId: string;
  reason: (typeof CANCEL_REASONS)[number];
  note: string | null;
  req?: Request;
}): Promise<{ mode: 'removed' | 'cancelled'; associate: { firstName: string; lastName: string; email: string }; clientId: string }> {
  const now = new Date();
  const app = await prisma.application.findUnique({
    where: { id: input.applicationId },
    include: { associate: { select: { id: true, firstName: true, lastName: true, email: true } } },
  });
  if (!app || app.deletedAt) throw new HttpError(404, 'application_not_found', 'Application not found');
  if (!LIVE.includes(app.status)) {
    throw new HttpError(409, 'application_already_decided', `This application is already ${app.status.toLowerCase()}.`);
  }
  // A hire's invite goes back through the hire, so the candidate does too.
  const hire = await prisma.candidate.findFirst({
    where: { hiredAssociateId: app.associateId, stage: 'HIRED', deletedAt: null },
    select: { id: true, firstName: true, lastName: true },
  });
  if (hire) {
    throw new HttpError(
      409,
      'hired_in_recruiting',
      `This invite came from hiring ${hire.firstName} ${hire.lastName} in Recruiting — use Undo hire there, so their candidate record goes back too.`,
      { candidateId: hire.id },
    );
  }
  const who = { firstName: app.associate.firstName, lastName: app.associate.lastName, email: app.associate.email };

  const user = await prisma.user.findFirst({ where: { associateId: app.associateId }, select: { id: true, passwordHash: true } });
  const onlyInvite =
    (await prisma.application.count({ where: { associateId: app.associateId, id: { not: app.id }, deletedAt: null } })) === 0;
  const ghost =
    app.status === 'DRAFT' &&
    onlyInvite &&
    !user?.passwordHash &&
    !(await startedSince(app.associateId, app.id, app.invitedAt)) &&
    !(await hasProtectedHistory(prisma, app.associateId));
  if (ghost) {
    // Never accepted, nothing else of theirs: gone, email free for the
    // right invite. The purge's audit row keeps who and why.
    await purgeGhost(
      prisma,
      { associateId: app.associateId, userId: user?.id ?? null, email: who.email, firstName: who.firstName, lastName: who.lastName },
      'invite_cancelled',
      now,
    );
    await recordOnboardingEvent({
      actorUserId: input.actorUserId,
      action: 'onboarding.application_cancelled',
      applicationId: app.id,
      clientId: app.clientId,
      metadata: { reason: input.reason, note: input.note, removed: true, email: who.email },
      req: input.req,
    });
    return { mode: 'removed', associate: who, clientId: app.clientId };
  }

  await prisma.$transaction((tx) =>
    closeApplication(tx, app, { reason: input.reason, note: input.note, actorUserId: input.actorUserId, now }),
  );
  await recordOnboardingEvent({
    actorUserId: input.actorUserId,
    action: 'onboarding.application_cancelled',
    applicationId: app.id,
    clientId: app.clientId,
    metadata: { reason: input.reason, note: input.note },
    req: input.req,
  });
  return { mode: 'cancelled', associate: who, clientId: app.clientId };
}

/* ===== Reopen a cancelled invite ========================================= */

export async function reopenApplication(input: { applicationId: string; actorUserId: string; req?: Request }): Promise<{ emailed: boolean; inviteUrl: string | null }> {
  const app = await prisma.application.findUnique({
    where: { id: input.applicationId },
    include: { associate: { select: { firstName: true, email: true, hireDate: true } }, client: { select: { name: true } } },
  });
  if (!app || app.deletedAt) throw new HttpError(404, 'application_not_found', 'Application not found');
  if (app.status !== 'CANCELLED') throw new HttpError(409, 'not_cancelled', 'Only a cancelled application can be reopened.');
  if (app.cancelReason === 'HIRE_UNDONE') {
    throw new HttpError(409, 'rehire_in_recruiting', 'This was a hire that was undone — hire them again from Recruiting.');
  }
  const user = await prisma.user.findFirst({ where: { associateId: app.associateId, deletedAt: null } });
  const now = new Date();
  const invite = generateInviteToken();
  const expiresAt = new Date(now.getTime() + env.INVITE_TOKEN_TTL_SECONDS * 1000);
  const mintLink = Boolean(user && !user.passwordHash);
  await prisma.$transaction(async (tx) => {
    await tx.application.update({
      where: { id: app.id },
      data: {
        status: app.submittedAt ? 'SUBMITTED' : 'DRAFT',
        cancelledAt: null,
        cancelReason: null,
        cancelNote: null,
        cancelledById: null,
        // A fresh start on the reminder clock.
        invitedAt: now,
      },
    });
    if (user && user.status === 'DISABLED') {
      await tx.user.update({ where: { id: user.id }, data: { status: user.passwordHash ? 'ACTIVE' : 'INVITED' } });
    }
    if (user && mintLink) {
      await tx.inviteToken.create({ data: { tokenHash: invite.hash, userId: user.id, expiresAt } });
    }
  });
  let inviteUrl: string | null = null;
  if (user && mintLink) {
    const sent = await sendInviteEmail({
      userId: user.id,
      email: app.associate.email,
      firstName: app.associate.firstName,
      clientName: app.client.name,
      hireDate: app.associate.hireDate,
      rawToken: invite.raw,
      expiresAt,
      actorUserId: input.actorUserId,
    });
    inviteUrl = invitesAreEmailed() ? null : sent.acceptUrl;
  }
  await recordOnboardingEvent({
    actorUserId: input.actorUserId,
    action: 'onboarding.application_reopened',
    applicationId: app.id,
    clientId: app.clientId,
    req: input.req,
  });
  return { emailed: mintLink && invitesAreEmailed(), inviteUrl };
}

/* ===== Invites nobody answered ============================================ */

/**
 * Invites nobody touched for INVITE_EXPIRE_AFTER_DAYS after the last
 * reminder close as EXPIRED — link revoked, off the active list, one click
 * to reopen. The onboarding ghost purge already removes most unanswered
 * invites within days; this catches the ones it keeps (a rehire, someone
 * with history), which otherwise sat open forever. A hire among them goes
 * back to Offer on the candidate's timeline.
 */
export async function expireStaleInvites(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - INVITE_EXPIRE_AFTER_DAYS * DAY);
  const apps = await prisma.application.findMany({
    where: {
      status: 'DRAFT',
      deletedAt: null,
      inviteEmailDueAt: null,
      invitedAt: { lt: cutoff },
      updatedAt: { lt: cutoff },
      OR: [{ progressRemindedAt: null }, { progressRemindedAt: { lt: cutoff } }],
      checklist: { tasks: { none: { completedAt: { gte: cutoff } } } },
      // A link sent (or re-sent) inside the window restarts the clock.
      associate: { user: { inviteTokens: { none: { createdAt: { gte: cutoff } } } } },
    },
    select: { id: true, associateId: true, clientId: true },
    take: 200,
  });
  let expired = 0;
  for (const app of apps) {
    await prisma.$transaction(async (tx) => {
      await closeApplication(tx, app, { reason: 'EXPIRED', note: null, actorUserId: null, now });
      await revertCandidateHire(
        tx,
        { associateId: app.associateId },
        { reason: 'Onboarding invite expired unanswered — hire undone automatically', actorUserId: null, automatic: true },
      );
    });
    await recordOnboardingEvent({
      actorUserId: null,
      action: 'onboarding.application_cancelled',
      applicationId: app.id,
      clientId: app.clientId,
      metadata: { reason: 'EXPIRED', afterDays: INVITE_EXPIRE_AFTER_DAYS },
    });
    expired += 1;
  }
  return expired;
}
