/**
 * Thin helpers for system-triggered notifications (bell + email).
 *
 * Every helper writes an IN_APP Notification row (the topbar bell) AND
 * fires a parallel EMAIL via Resend so the recipient gets the same news
 * even if they're not currently logged in. Both writes land as separate
 * Notification rows (channel='IN_APP' and channel='EMAIL') so the bell
 * view and the email-deliverability audit stay independent.
 *
 * Helper inventory:
 *   - notifyUser         – one user (any role) gets bell + email
 *   - notifyAllAdmins    – fan out to every ACTIVE role with manage:onboarding
 *                          (HR_ADMINISTRATOR + the FULL_ADMIN sibling roles —
 *                          OPERATIONS_MANAGER, INTERNAL_RECRUITER, MANAGER,
 *                          WORKFORCE_MANAGER, MARKETING_MANAGER). Excludes
 *                          the optional excludeUserId (typically the actor).
 *   - notifyAssociate    – the affected employee (no-op if they have no
 *                          active User account yet — invited-but-unaccepted
 *                          accounts have no confirmed inbox to mail)
 *   - notifyManager      – the affected employee's direct manager (no-op
 *                          if Associate.managerId is null or the manager has
 *                          no active User)
 *   - notifyHrOnApplicationComplete – when a checklist hits 100%, stamp
 *                          submittedAt (dedupe gate) and call notifyAllAdmins
 *
 * Why a small helper rather than reusing the broadcast/send endpoints:
 * those are user-triggered (HR composing a message). System-triggered
 * notifications skip the auth + delivery-channel layers and just write
 * a row + fire an email.
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
import {
  NOTIFICATION_CATEGORIES,
  bucketForCategory,
  rolesWithCapability,
  type NotificationCategory,
} from '@alto-people/shared';
import { prisma } from '../db.js';
import { EmailSuppressedError, send } from './notifications.js';
import { sendPushToUser } from './webPush.js';
import { emitLiveEvent } from './liveEvents.js';
import {
  genericNotificationTemplate,
  onboardingCompleteTemplate,
} from './emailTemplates.js';
import { env } from '../config/env.js';

// Snapshot at module load. Drives the notifyAllAdmins recipient query.
// Capability-based (not a hardcoded role list) so a future role gaining
// manage:onboarding automatically gets in the loop without code changes here.
const ONBOARDING_ADMIN_ROLES = rolesWithCapability('manage:onboarding');

const MANDATORY_CATEGORIES = new Set<NotificationCategory>(
  NOTIFICATION_CATEGORIES.filter((c) => c.mandatory).map((c) => c.key),
);

// Raw-category → settings-bucket mapping lives in shared/contracts
// (bucketForCategory) so the web bell and this email-mute check can
// never drift apart.
const bucketForRawCategory = bucketForCategory;

/**
 * True iff the user has explicitly muted the bucket this raw category
 * resolves to. Always false for mandatory buckets and unknown raw
 * strings — see bucketForRawCategory comment.
 */
async function isEmailMutedForCategory(
  userId: string,
  rawCategory: string | undefined,
): Promise<boolean> {
  const bucket = bucketForRawCategory(rawCategory);
  if (!bucket || MANDATORY_CATEGORIES.has(bucket)) return false;
  const pref = await prisma.notificationPreference.findUnique({
    where: { userId_category: { userId, category: bucket } },
    select: { emailEnabled: true },
  });
  return pref ? !pref.emailEnabled : false;
}

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
  /**
   * Optional HTML version of the body, sent to Resend alongside `body` (text
   * fallback). Most email clients render the HTML; the text body is what
   * spam classifiers read and what shows in plain-text-only clients.
   * IN_APP rows always store the text body — the bell never renders HTML.
   */
  html?: string;
  /** Tag for filtering in the bell ("onboarding", "documents", etc.). */
  category?: string;
  /**
   * Optional in-app deeplink. The topbar bell renders rows with this set
   * as clickable — `navigate(linkUrl)` on click. Use a relative path
   * (e.g. "/onboarding/me/<id>") not a full URL; the email template
   * builds its own absolute link separately.
   */
  linkUrl?: string;
  /**
   * Bell-only delivery: skip the email AND the push. For routine-positive
   * confirmations ("hours approved") where the event is self-evident and
   * an inbox interruption reads as spam. Anything that requires action or
   * changes what someone gets paid must NOT be quiet.
   */
  quiet?: boolean;
}

/** notifyAllAdmins email tiers — the bell row still reaches every admin
 *  role; these narrow who ALSO gets the email. Pass via `emailRoles`. */
export const ADMIN_EMAIL_HIRING = ['HR_ADMINISTRATOR', 'INTERNAL_RECRUITER'] as const;
export const ADMIN_EMAIL_HR_ONLY = ['HR_ADMINISTRATOR'] as const;

/**
 * Send a transactional email to one user and record the result as an
 * EMAIL Notification row (status SENT or FAILED). Tracked so tests can
 * await it via flushPendingNotifications.
 */
function sendEmailNotification(
  userId: string,
  email: string,
  opts: NotifyOpts,
): Promise<void> {
  return track(
    (async () => {
      let externalRef: string | null = null;
      let providerMessageId: string | null = null;
      let failureReason: string | null = null;
      let suppressed = false;
      // Every email leaves in the branded layout. Callers that built a
      // full template pass html; everyone else (the generic notify*
      // fan-outs) used to go out as bare unstyled text with no logo,
      // company block, or disclaimer — indistinguishable from phishing,
      // which is exactly what the standard footer exists to prevent.
      const branded = opts.html
        ? { html: opts.html, text: opts.body }
        : (() => {
            const tpl = genericNotificationTemplate({
              subject: opts.subject ?? 'Notification from Alto HR',
              body: opts.body,
              linkUrl: opts.linkUrl ?? null,
            });
            return { html: tpl.html, text: tpl.text };
          })();
      try {
        const r = await send({
          channel: 'EMAIL',
          recipient: { userId, phone: null, email },
          subject: opts.subject,
          body: branded.text,
          html: branded.html,
          // Only the broadcast/announcement bucket carries the one-click
          // unsubscribe headers. Everything else routed through here is
          // transactional and must NOT advertise an unsubscribe.
          includeUnsubscribe: bucketForRawCategory(opts.category) === 'broadcast',
        });
        externalRef = r.externalRef;
        providerMessageId = r.providerMessageId;
      } catch (err) {
        if (err instanceof EmailSuppressedError) {
          suppressed = true;
        }
        failureReason = err instanceof Error ? err.message : String(err);
      }
      await prisma.notification.create({
        data: {
          channel: 'EMAIL',
          status: suppressed ? 'SUPPRESSED' : failureReason ? 'FAILED' : 'SENT',
          recipientUserId: userId,
          recipientEmail: email,
          subject: opts.subject,
          body: opts.body,
          category: opts.category ?? null,
          externalRef,
          providerMessageId,
          failureReason,
          sentAt: failureReason ? null : new Date(),
        },
      });
    })().catch((err: unknown) => {
      console.warn(
        '[notify] sendEmailNotification failed:',
        err instanceof Error ? err.message : err,
      );
    }),
  );
}

/**
 * Email-only companion for callers that already wrote their own IN_APP row
 * (notifyShift in scheduling). Honors the same per-category mute prefs as
 * notifyUser; fire-and-forget and tracked for flushPendingNotifications.
 */
export function emailUserForCategory(
  userId: string,
  email: string,
  opts: NotifyOpts,
): Promise<void> {
  return track(
    (async () => {
      const muted = await isEmailMutedForCategory(userId, opts.category);
      if (muted) return;
      // Email + push ride the same mute switch: "don't bother me about
      // this category" means neither inbox nor lock screen.
      await Promise.all([
        sendEmailNotification(userId, email, opts),
        sendPushToUser(userId, {
          title: opts.subject ?? 'Alto People',
          body: opts.body,
          url: opts.linkUrl,
        }),
      ]);
    })().catch((err: unknown) => {
      console.warn(
        '[notify] emailUserForCategory failed:',
        err instanceof Error ? err.message : err,
      );
    }),
  );
}

/**
 * Create one IN_APP notification for a single user AND email them. Returns
 * silently on any failure — the bell will pick it up next poll if it lands;
 * if writes fail, the underlying event still happened, we don't mask that.
 */
export function notifyUser(
  userId: string,
  opts: NotifyOpts,
  client: Pick<PrismaClient, 'notification'> = prisma,
): Promise<void> {
  return track(
    (async () => {
      await client.notification.create({
        data: {
          channel: 'IN_APP',
          status: 'SENT',
          recipientUserId: userId,
          subject: opts.subject,
          body: opts.body,
          category: opts.category ?? null,
          linkUrl: opts.linkUrl ?? null,
          sentAt: new Date(),
        },
      });
      // Live nudge: any open tab refetches the bell (and badge) instantly.
      emitLiveEvent(userId, 'notification');
      // Email is best-effort and fired in parallel via its own track().
      // Skip the send if the user has muted this category bucket; the
      // IN_APP row above always lands so the bell still surfaces it.
      // quiet = the bell row above is the whole delivery.
      if (opts.quiet) return;
      const u = await prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, status: true },
      });
      if (u && u.email && u.status === 'ACTIVE') {
        const muted = await isEmailMutedForCategory(userId, opts.category);
        if (!muted) {
          void sendEmailNotification(userId, u.email, opts);
          void track(
            sendPushToUser(userId, {
              title: opts.subject ?? 'Alto People',
              body: opts.body,
              url: opts.linkUrl,
            }),
          );
        }
      }
    })().catch((err: unknown) => {
      console.warn('[notify] notifyUser failed:', err instanceof Error ? err.message : err);
    }),
  );
}

/**
 * Fan-out IN_APP + EMAIL notifications to every ACTIVE user whose role
 * grants manage:onboarding. Pass `excludeUserId` to skip the actor. IN_APP
 * is one bulk insert; emails are fired one-per-recipient.
 *
 * The role set is derived from ROLE_CAPABILITIES at module load, so
 * adding a new admin role to FULL_ADMIN auto-includes them here.
 */
export function notifyAllAdmins(
  opts: NotifyOpts & {
    excludeUserId?: string | null;
    /**
     * Which admin ROLES also get the email (the bell row reaches everyone
     * regardless). Undefined = every admin role emails (the historical
     * behavior — reserve it for operational alerts everyone must see).
     * [] = bell-only. Use ADMIN_EMAIL_HIRING / ADMIN_EMAIL_HR_ONLY for
     * informational events: six roles carry manage:onboarding, and
     * blasting all of them for every routine event is how the org burned
     * through its Resend credits.
     */
    emailRoles?: readonly string[];
  },
): Promise<void> {
  return track(
    (async () => {
      const recipients = await prisma.user.findMany({
        where: {
          role: { in: ONBOARDING_ADMIN_ROLES },
          status: 'ACTIVE',
          ...(opts.excludeUserId ? { NOT: { id: opts.excludeUserId } } : {}),
        },
        select: { id: true, email: true, role: true },
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
          linkUrl: opts.linkUrl ?? null,
          sentAt: now,
        })),
      });
      for (const u of recipients) emitLiveEvent(u.id, 'notification');
      // Honour each recipient's per-category mute. Looked up serially
      // before the (still-parallel) sends fire — N+1 against a small N
      // (admin role count, typically ≤10) and indexed on (userId, category).
      for (const u of recipients) {
        if (!u.email) continue;
        if (opts.emailRoles && !opts.emailRoles.includes(u.role)) continue;
        const muted = await isEmailMutedForCategory(u.id, opts.category);
        if (!muted) void sendEmailNotification(u.id, u.email, opts);
      }
    })().catch((err: unknown) => {
      console.warn('[notify] notifyAllAdmins failed:', err instanceof Error ? err.message : err);
    }),
  );
}

/**
 * Notify every ACTIVE SHIFT_SUPERVISOR bound to `clientId`. Supervisors
 * hold no admin capability, so notifyAllAdmins never reaches them — yet
 * they're the person physically on the floor for client-attributable
 * events (shift claims, swaps, possible no-shows). Call this ALONGSIDE
 * the existing notifyManager/notifyAllAdmins fan-outs, not instead.
 */
export function notifyClientSupervisors(
  clientId: string | null | undefined,
  opts: NotifyOpts & { excludeUserId?: string | null },
): Promise<void> {
  return track(
    (async () => {
      if (!clientId) return;
      const recipients = await prisma.user.findMany({
        where: {
          role: 'SHIFT_SUPERVISOR',
          status: 'ACTIVE',
          clientId,
          ...(opts.excludeUserId ? { NOT: { id: opts.excludeUserId } } : {}),
        },
        select: { id: true, email: true },
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
          linkUrl: opts.linkUrl ?? null,
          sentAt: now,
        })),
      });
      for (const u of recipients) emitLiveEvent(u.id, 'notification');
      for (const u of recipients) {
        if (!u.email) continue;
        const muted = await isEmailMutedForCategory(u.id, opts.category);
        if (!muted) void sendEmailNotification(u.id, u.email, opts);
      }
    })().catch((err: unknown) => {
      console.warn(
        '[notify] notifyClientSupervisors failed:',
        err instanceof Error ? err.message : err,
      );
    }),
  );
}

/**
 * Notify the associate (via their User row, if one exists). No-op if the
 * associate has no active User account yet — invited-but-unaccepted
 * accounts have no confirmed inbox to mail.
 *
 * Pass `emailFallback: true` for messages that MUST reach the person even
 * without an active account (e.g. "your application was declined" — the
 * population most likely to be rejected is exactly the one that never
 * logged in). Falls back to a direct email to Associate.email.
 */
export function notifyAssociate(
  associateId: string,
  opts: NotifyOpts & { emailFallback?: boolean },
): Promise<void> {
  return track(
    (async () => {
      const user = await prisma.user.findFirst({
        where: { associateId, status: 'ACTIVE' },
        select: { id: true },
      });
      if (user) {
        await notifyUser(user.id, opts);
        return;
      }
      if (!opts.emailFallback || opts.quiet) return;
      const associate = await prisma.associate.findUnique({
        where: { id: associateId },
        select: { email: true },
      });
      if (!associate?.email) return;
      // Same branding rule as sendEmailNotification — this account-less
      // fallback path (e.g. "your application was declined") must not be
      // the one send that leaves unbranded.
      const tpl = opts.html
        ? { html: opts.html, text: opts.body }
        : genericNotificationTemplate({
            subject: opts.subject ?? 'Notification from Alto HR',
            body: opts.body,
            linkUrl: opts.linkUrl ?? null,
          });
      await send({
        channel: 'EMAIL',
        recipient: { userId: null, phone: null, email: associate.email },
        subject: opts.subject ?? 'Notification from Alto HR',
        body: tpl.text,
        html: tpl.html,
      });
    })().catch((err: unknown) => {
      console.warn('[notify] notifyAssociate failed:', err instanceof Error ? err.message : err);
    }),
  );
}

/**
 * Notify the associate's direct manager (Associate.managerId → that
 * manager's Associate → that Associate's active User). No-op if the
 * associate has no manager assigned, or the manager has no active User.
 */
export function notifyManager(associateId: string, opts: NotifyOpts): Promise<void> {
  return track(
    (async () => {
      const associate = await prisma.associate.findUnique({
        where: { id: associateId },
        select: { managerId: true },
      });
      if (!associate?.managerId) return;
      const managerUser = await prisma.user.findFirst({
        where: { associateId: associate.managerId, status: 'ACTIVE' },
        select: { id: true },
      });
      if (!managerUser) return;
      await notifyUser(managerUser.id, opts);
    })().catch((err: unknown) => {
      console.warn('[notify] notifyManager failed:', err instanceof Error ? err.message : err);
    }),
  );
}

/**
 * If `applicationId`'s checklist is now fully complete (every task DONE or
 * SKIPPED) AND the app hasn't been marked submitted yet, stamp `submittedAt`
 * and notify all admins. The submittedAt stamp is the dedupe — same call on
 * a subsequent request is a no-op, so admins get exactly one "ready for
 * review" notification per application.
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
      // Also advance the status machine: a fully-complete DRAFT is
      // SUBMITTED — this is what the list's Submitted chip, the stale
      // banner's Review button, and the associate's status banner read.
      await prisma.application.update({
        where: { id: applicationId },
        data: {
          submittedAt: new Date(),
          // Fresh submission = fresh review cycle: clear the post-
          // submission-edit stamp so the reviewer badge/notification
          // dedupe starts over.
          updatedAfterSubmitAt: null,
          ...(app.status === 'DRAFT' ? { status: 'SUBMITTED' } : {}),
        },
      });

      const who = `${app.associate.firstName} ${app.associate.lastName}`;
      const tpl = onboardingCompleteTemplate({
        associateName: who,
        clientName: app.client.name,
        submittedAt: new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
        applicationUrl: `${env.APP_BASE_URL}/onboarding/applications/${app.id}`,
      });
      await notifyAllAdmins({
        subject: tpl.subject,
        body: tpl.text,
        html: tpl.html,
        category: 'onboarding',
        // Reviewing a submission is HR/recruiting work; the other four
        // admin roles see the bell row without the inbox hit.
        emailRoles: ADMIN_EMAIL_HIRING,
      });
    })().catch((err: unknown) => {
      console.warn(
        '[notify] notifyHrOnApplicationComplete failed:',
        err instanceof Error ? err.message : err,
      );
    }),
  );
}

/** @deprecated Use notifyAllAdmins. Kept as a thin alias during migration. */
export const notifyAllHR = notifyAllAdmins;
