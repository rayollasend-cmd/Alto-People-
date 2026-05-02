/**
 * Thin helpers for creating IN_APP Notification rows the topbar bell renders.
 *
 * Why a small helper rather than reusing the broadcast/send endpoints:
 * those are user-triggered (HR composing a message). System-triggered
 * notifications (event hooks) skip the auth + delivery-channel layers and
 * just write a row — the inbox endpoint surfaces it on the next poll.
 *
 * Every helper here is fire-and-forget from the caller's perspective:
 * notification failures must NEVER fail the underlying request that
 * triggered them (e.g. a doc-rejection still rejects even if the inbox
 * write hiccups). Wrap calls in try/catch + console.warn.
 *
 * Each helper also registers its in-flight promise so tests can call
 * `flushPendingNotifications()` to wait for the writes to land before
 * asserting on the Notification table — same pattern as audit.ts.
 */
import type { PrismaClient } from '@prisma/client';
import { prisma } from '../db.js';

const inFlight: Set<Promise<unknown>> = new Set();

function track<T>(p: Promise<T>): Promise<T> {
  inFlight.add(p);
  p.finally(() => inFlight.delete(p));
  return p;
}

/** Test-only: resolves once every fire-and-forget notification has settled. */
export async function flushPendingNotifications(): Promise<void> {
  while (inFlight.size > 0) {
    await Promise.allSettled(Array.from(inFlight));
  }
}

export interface NotifyOpts {
  /** Topbar shows this in bold; keep it short. */
  subject: string | null;
  /** One-to-three-line description of what happened and what to do. */
  body: string;
  /** Tag for filtering in the bell ("onboarding", "documents", etc.). */
  category?: string;
}

/**
 * Create one IN_APP notification for a single user. Returns silently on
 * any failure (the bell will pick it up next poll if it lands; if the
 * write itself failed, the underlying event still happened — we don't
 * want to mask that with a "couldn't notify" error).
 */
export function notifyUser(
  userId: string,
  opts: NotifyOpts,
  client: Pick<PrismaClient, 'notification'> = prisma,
): Promise<void> {
  return track(
    client.notification
      .create({
        data: {
          channel: 'IN_APP',
          status: 'SENT',
          recipientUserId: userId,
          subject: opts.subject,
          body: opts.body,
          category: opts.category ?? null,
          sentAt: new Date(),
        },
      })
      .then(() => undefined)
      .catch((err: unknown) => {
        console.warn('[notify] notifyUser failed:', err instanceof Error ? err.message : err);
      }),
  );
}

/**
 * Fan-out IN_APP notifications to every ACTIVE HR_ADMINISTRATOR. Pass
 * `excludeUserId` to skip the actor (HR rarely needs a "you just did X"
 * notification for their own action).
 *
 * Single bulk insert via createMany so 50 HR users doesn't mean 50 round-trips.
 */
export function notifyAllHR(
  opts: NotifyOpts & { excludeUserId?: string | null },
): Promise<void> {
  return track(
    (async () => {
      const recipients = await prisma.user.findMany({
        where: {
          role: 'HR_ADMINISTRATOR',
          status: 'ACTIVE',
          ...(opts.excludeUserId ? { NOT: { id: opts.excludeUserId } } : {}),
        },
        select: { id: true },
      });
      if (recipients.length === 0) return;
      const now = new Date();
      await prisma.notification.createMany({
        data: recipients.map((u) => ({
          channel: 'IN_APP' as const,
          status: 'SENT' as const,
          recipientUserId: u.id,
          subject: opts.subject,
          body: opts.body,
          category: opts.category ?? null,
          sentAt: now,
        })),
      });
    })().catch((err: unknown) => {
      console.warn('[notify] notifyAllHR failed:', err instanceof Error ? err.message : err);
    }),
  );
}

/**
 * Notify the associate (via their User row, if one exists). No-op if the
 * associate has no User account yet — invited but unaccepted associates
 * have no one to notify.
 */
export function notifyAssociate(associateId: string, opts: NotifyOpts): Promise<void> {
  return track(
    (async () => {
      const user = await prisma.user.findFirst({
        where: { associateId, status: 'ACTIVE' },
        select: { id: true },
      });
      if (!user) return;
      await notifyUser(user.id, opts);
    })().catch((err: unknown) => {
      console.warn('[notify] notifyAssociate failed:', err instanceof Error ? err.message : err);
    }),
  );
}

/**
 * If `applicationId`'s checklist is now fully complete (every task DONE or
 * SKIPPED) AND the app hasn't been marked submitted yet, stamp `submittedAt`
 * and notify all HR. The submittedAt stamp is the dedupe — same call on a
 * subsequent request is a no-op, so HR gets exactly one "ready for review"
 * notification per application.
 *
 * Call this after any endpoint that marks a checklist task DONE.
 */
export function notifyHrOnApplicationComplete(applicationId: string): Promise<void> {
  return track(
    (async () => {
      const app = await prisma.application.findUnique({
        where: { id: applicationId },
        select: {
          id: true,
          submittedAt: true,
          status: true,
          associate: { select: { firstName: true, lastName: true } },
          client: { select: { name: true } },
          checklist: {
            select: { tasks: { select: { status: true } } },
          },
        },
      });
      if (!app) return;
      if (app.submittedAt) return; // already fired once
      if (app.status === 'APPROVED' || app.status === 'REJECTED') return;

      const tasks = app.checklist?.tasks ?? [];
      if (tasks.length === 0) return;
      const allDone = tasks.every((t) => t.status === 'DONE' || t.status === 'SKIPPED');
      if (!allDone) return;

      // Stamp first; if the stamp succeeds we own the notification fan-out.
      await prisma.application.update({
        where: { id: applicationId },
        data: { submittedAt: new Date() },
      });

      const who = `${app.associate.firstName} ${app.associate.lastName}`;
      await notifyAllHR({
        subject: 'Onboarding complete — ready for review',
        body: `${who} (${app.client.name}) finished every onboarding task. Open the application to approve or reject.`,
        category: 'onboarding',
      });
    })().catch((err: unknown) => {
      console.warn(
        '[notify] notifyHrOnApplicationComplete failed:',
        err instanceof Error ? err.message : err,
      );
    }),
  );
}
