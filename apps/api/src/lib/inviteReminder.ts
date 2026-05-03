import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';
import { env } from '../config/env.js';
import { send } from './notifications.js';
import { generateInviteToken } from './inviteToken.js';
import { onboardingReminderTemplate, inviteTemplate } from './emailTemplates.js';

/**
 * Phase 17 — invite reminder sweep.
 *
 * An associate who got an invitation but hasn't accepted it yet is one of
 * the most common drop-off points in onboarding. After 48h we send them
 * one reminder email containing a fresh magic link.
 *
 * Token rotation: we never stored the raw token from the original invite,
 * only the sha256 hash. So the reminder generates a brand new token,
 * supersedes any open older tokens for the same user (their consumedAt
 * gets set to now), and the email body links to the new one. This keeps
 * single-use semantics intact — the original email's link is now dead.
 *
 * Idempotency: once a reminder fires for a user we mark the *new* token's
 * `reminderSentAt`. Subsequent sweeps skip it because of that marker AND
 * because the new token's createdAt is younger than the 48h cutoff.
 * HR-triggered resend (in routes/onboarding.ts) creates yet another fresh
 * token and is exempt from the 48h gate.
 *
 * The cron itself is a setInterval gated by env.INVITE_REMINDER_INTERVAL_SECONDS;
 * it's started/stopped from src/index.ts. Tests call `runInviteReminderSweep`
 * directly without arming the timer.
 */

export const INVITE_REMINDER_AFTER_HOURS = 48;

export interface SweepResult {
  scanned: number;
  reminded: number;
  errors: { userId: string; error: string }[];
}

export async function runInviteReminderSweep(
  prisma: PrismaClient = defaultPrisma,
  now: Date = new Date()
): Promise<SweepResult> {
  const cutoff = new Date(now.getTime() - INVITE_REMINDER_AFTER_HOURS * 60 * 60 * 1000);

  const candidates = await prisma.inviteToken.findMany({
    where: {
      consumedAt: null,
      reminderSentAt: null,
      expiresAt: { gt: now },
      createdAt: { lt: cutoff },
      user: { status: 'INVITED', passwordHash: null },
    },
    include: {
      user: {
        include: {
          associate: {
            include: {
              applications: {
                where: { deletedAt: null },
                include: { client: { select: { name: true } } },
                orderBy: { invitedAt: 'desc' },
                take: 1,
              },
            },
          },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
    take: 200,
  });

  const errors: { userId: string; error: string }[] = [];
  let reminded = 0;

  for (const token of candidates) {
    try {
      await sendReminderForUser(prisma, token.userId, { now });
      reminded++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ userId: token.userId, error: msg });
    }
  }

  return { scanned: candidates.length, reminded, errors };
}

/**
 * Rotate a fresh invite token for `userId`, kill any open older tokens,
 * send a reminder/resend email with the new link, and record both the
 * Notification row and the new token's reminderSentAt marker. Used by the
 * cron sweep AND by the HR-triggered `/resend-invite` admin endpoint.
 *
 * Throws if the user doesn't exist or isn't currently INVITED — the
 * caller decides how to handle that (sweep records to errors[], the HTTP
 * route returns 4xx).
 */
export async function sendReminderForUser(
  prisma: PrismaClient,
  userId: string,
  opts: { now?: Date; reason?: 'sweep' | 'manual' } = {}
): Promise<{ tokenId: string; rawToken: string; externalRef: string | null }> {
  const now = opts.now ?? new Date();
  const reason = opts.reason ?? 'sweep';

  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      associate: {
        include: {
          applications: {
            where: { deletedAt: null },
            include: { client: { select: { name: true } } },
            orderBy: { invitedAt: 'desc' },
            take: 1,
          },
        },
      },
    },
  });
  if (!user) throw new Error('user_not_found');
  if (user.status !== 'INVITED' || user.passwordHash) {
    throw new Error('user_not_invitable');
  }

  const fresh = generateInviteToken();
  const expiresAt = new Date(now.getTime() + env.INVITE_TOKEN_TTL_SECONDS * 1000);

  // Rotate atomically: kill open tokens, create new token, mark new token
  // as "reminded" so the sweep doesn't pick this person up again.
  const newToken = await prisma.$transaction(
    async (tx) => {
      await tx.inviteToken.updateMany({
        where: { userId, consumedAt: null },
        data: { consumedAt: now },
      });
      return tx.inviteToken.create({
        data: {
          tokenHash: fresh.hash,
          userId,
          expiresAt,
          reminderSentAt: now,
        },
      });
    },
    { timeout: 30_000, maxWait: 10_000 }
  );

  const firstName = user.associate?.firstName ?? 'there';
  const clientName = user.associate?.applications?.[0]?.client?.name ?? 'your employer';
  const acceptUrl = `${env.APP_BASE_URL}/accept-invite/${fresh.raw}`;
  // Manual resends are treated as a fresh invite (HR clicked Resend); the
  // 48h cron path is the actual "you forgot" reminder template.
  const tpl =
    reason === 'manual'
      ? inviteTemplate({
          firstName,
          clientName,
          magicLink: acceptUrl,
          linkExpiresAt: expiresAt.toISOString().slice(0, 10),
        })
      : onboardingReminderTemplate({
          firstName,
          clientName,
          percentComplete: 0,
          hireDate: user.associate?.hireDate ? user.associate.hireDate.toISOString().slice(0, 10) : null,
          magicLink: acceptUrl,
        });
  const subject = tpl.subject;
  const body = tpl.text;

  let externalRef: string | null = null;
  let failureReason: string | null = null;
  try {
    const r = await send({
      channel: 'EMAIL',
      recipient: { userId: user.id, phone: null, email: user.email },
      subject,
      body,
      html: tpl.html,
    });
    externalRef = r.externalRef;
  } catch (err) {
    failureReason = err instanceof Error ? err.message : String(err);
  }

  await prisma.notification.create({
    data: {
      channel: 'EMAIL',
      status: failureReason ? 'FAILED' : 'SENT',
      recipientUserId: user.id,
      recipientEmail: user.email,
      subject,
      body,
      category: 'onboarding.invite_reminder',
      externalRef,
      failureReason,
      sentAt: failureReason ? null : now,
      senderUserId: null,
    },
  });

  if (failureReason) {
    throw new Error(failureReason);
  }

  return { tokenId: newToken.id, rawToken: fresh.raw, externalRef };
}

let timer: NodeJS.Timeout | null = null;

export function startInviteReminderCron(): void {
  if (timer) return;
  const seconds = env.INVITE_REMINDER_INTERVAL_SECONDS;
  if (seconds <= 0) return;
  void runInviteReminderSweep().catch((err) => {
    console.error('[alto-people/api] invite reminder sweep failed:', err);
  });
  timer = setInterval(() => {
    void runInviteReminderSweep().catch((err) => {
      console.error('[alto-people/api] invite reminder sweep failed:', err);
    });
  }, seconds * 1000);
  timer.unref();
  console.log(
    `[alto-people/api] invite reminder cron armed (every ${seconds}s, threshold ${INVITE_REMINDER_AFTER_HOURS}h)`
  );
}

export function stopInviteReminderCron(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
