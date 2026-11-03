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
import { getBrandingSync } from './branding.js';
import { loadTenantProfile } from './tenantProfile.js';
import {
  NOTIFICATION_CATEGORIES,
  bucketForCategory,
  notificationTier,
  roleWantsCategory,
  rolesWithCapability,
  type NotificationCategory,
  type NotificationTier,
} from '@alto-people/shared';
import { prisma } from '../db.js';
import { activeDelegationsFrom } from './delegations.js';
import { EmailSuppressedError, anyPushConfigured, send, type SendAttachment } from './notifications.js';
import { isPushMuted, sendPushToUser } from './webPush.js';
import { routeOutside, type OutsideNotice } from './notificationDelivery.js';
import { emitLiveEvent } from './liveEvents.js';
import { sendWhatsAppForUser } from './whatsapp.js';
import type { WaLang, WaTemplateKey } from './whatsappContent.js';
import {
  genericNotificationTemplate,
  onboardingCompleteTemplate,
} from './emailTemplates.js';
import { supervisorRecipients } from './shiftWindows.js';
import { publicBaseUrl } from './emailLayout.js';
import { fmtMomentInZone } from './humanDates.js';

// Snapshot at module load. Drives the notifyAllAdmins recipient query.
// Capability-based (not a hardcoded role list) so a future role gaining
// manage:onboarding automatically gets in the loop without code changes here.
// The recruiter holds manage:recruiting, not manage:onboarding, since it got
// its own charter (audit #16); the routing table still sends it the hiring
// events, so it stays in the pool the fan-out selects from.
const ONBOARDING_ADMIN_ROLES = [...new Set([...rolesWithCapability('manage:onboarding'), ...rolesWithCapability('manage:recruiting')])];

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
/** True when the user muted this category's bucket (never for mandatory
 *  ones). For senders that mail directly — attachments, digests — and so
 *  can't go through notifyUser. */
export function isEmailMuted(userId: string, rawCategory: string | undefined): Promise<boolean> {
  return isEmailMutedForCategory(userId, rawCategory);
}

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

/**
 * True when the user muted this category's BELL. Same bucket resolution and
 * same mandatory exemption as the email check — a formal HR notice or a
 * security alert is still undeniable.
 */
async function isInAppMutedForCategory(
  userId: string,
  rawCategory: string | undefined,
): Promise<boolean> {
  const bucket = bucketForRawCategory(rawCategory);
  if (!bucket || MANDATORY_CATEGORIES.has(bucket)) return false;
  const pref = await prisma.notificationPreference.findUnique({
    where: { userId_category: { userId, category: bucket } },
    select: { inAppEnabled: true },
  });
  return pref ? !pref.inAppEnabled : false;
}

/**
 * Drop the users who muted this category's bell, in one query rather than
 * one per recipient — the fan-outs below resolve a whole admin roster.
 */
async function withBellUnmuted<T extends { id: string }>(
  users: readonly T[],
  rawCategory: string | undefined,
): Promise<T[]> {
  const bucket = bucketForRawCategory(rawCategory);
  if (!bucket || MANDATORY_CATEGORIES.has(bucket) || users.length === 0) {
    return [...users];
  }
  const muted = await prisma.notificationPreference.findMany({
    where: {
      userId: { in: users.map((u) => u.id) },
      category: bucket,
      inAppEnabled: false,
    },
    select: { userId: true },
  });
  if (muted.length === 0) return [...users];
  const off = new Set(muted.map((m) => m.userId));
  return users.filter((u) => !off.has(u.id));
}

/**
 * The lock-screen copy of a notice, through the person's own Push switch:
 * muted for this category → nothing (not even a held copy); quiet hours or
 * the push digest → held for later; otherwise sent now. sendPushToUser
 * checks the switch again (it is the funnel every push passes); asking
 * first here keeps a muted push out of the held queue.
 */
async function pushFor(userId: string, opts: NotifyOpts, title: string, bellId: string | null = null): Promise<'muted' | 'held' | 'sent' | 'never'> {
  if (await isPushMuted(userId, opts.category)) return 'muted';
  const route = await routeOutside(userId, 'PUSH', noticeOf(opts), { bellId });
  if (route !== 'now') return route;
  return sendPushToUser(userId, {
    title,
    body: opts.body,
    url: opts.linkUrl,
    category: opts.category,
    renotify: notificationTier(opts.category, opts) === 'critical',
  });
}

/** What the delivery rules need to know about a notice (lib/notificationDelivery). */
function noticeOf(opts: NotifyOpts): OutsideNotice {
  return { subject: opts.subject, body: opts.body, linkUrl: opts.linkUrl, category: opts.category, urgent: opts.urgent, tier: opts.tier, actBy: opts.actBy };
}

/**
 * The outside channels for one person — push, email, WhatsApp — each behind
 * its own switch for the category and the person's delivery rules: now,
 * held, or not at all (lib/notificationDelivery routeOutside). `bellId` is
 * the bell copy, so a held email can be dropped once that has been seen.
 * `push: false` keeps someone the email list narrowed away bell-only.
 *
 * Calm notifications (owner, 2026-11-02): this used to be three channels
 * at once for every notice, around the clock, and the staff fan-outs
 * skipped quiet hours altogether. One path now, for everyone.
 */
function deliverOutside(userId: string, email: string | null, opts: NotifyOpts, bellId: string | null, channels: { push?: boolean } = {}): void {
  if (channels.push !== false) {
    void track(
      pushFor(userId, opts, opts.subject ?? getBrandingSync().orgName, bellId).catch((err: unknown) => {
        console.warn('[notify] push failed:', err instanceof Error ? err.message : err);
      }),
    );
  }
  void track(
    (async () => {
      // WhatsApp rides the email switch for the category, as it always has.
      if (await isEmailMutedForCategory(userId, opts.category)) return;
      await Promise.all([
        (async () => {
          if (!email || opts.skipEmail) return;
          // A packet that belongs with the message can't be folded into a
          // summary later: it goes now, or not at all.
          if (opts.attachments?.length) {
            await sendEmailNotification(userId, email, opts);
            return;
          }
          const branded = brandedEmail(opts);
          if ((await routeOutside(userId, 'EMAIL', { ...noticeOf(opts), html: branded.html, text: branded.text }, { bellId })) === 'now') {
            await sendEmailNotification(userId, email, opts);
          }
        })(),
        (async () => {
          if ((await routeOutside(userId, 'WHATSAPP', noticeOf(opts), { bellId })) === 'now') await sendWhatsAppForUser(userId, opts);
        })(),
      ]);
    })().catch((err: unknown) => {
      console.warn('[notify] email/whatsapp failed:', err instanceof Error ? err.message : err);
    }),
  );
}

const inFlight: Set<Promise<unknown>> = new Set();

function track<T>(p: Promise<T>): Promise<T> {
  inFlight.add(p);
  // .finally() makes a new promise that rejects when p does, and nobody holds
  // it: without this catch a failed notice was an unhandled rejection even when
  // the caller caught p — which exits Node when no handler is installed (audit
  // 2026-10-29 CODE-22). The caller still gets p, rejection and all.
  p.finally(() => inFlight.delete(p)).catch(() => undefined);
  return p;
}

/** Test-only: resolves once every fire-and-forget notification has settled. */
export async function flushPendingNotifications(): Promise<void> {
  while (inFlight.size > 0) {
    await Promise.allSettled(Array.from(inFlight));
  }
}

/**
 * Register outside async notification work (a fire-and-forget helper that
 * does its own reads before notifying) with the in-flight set, so tests
 * can await it via flushPendingNotifications like any notifyUser call.
 */
export function trackNotificationWork<T>(p: Promise<T>): Promise<T> {
  return track(p);
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
  /**
   * The plain-text twin of `html`. When set, the email's text part is this
   * and `body` stays the short line the bell shows; when absent the email's
   * text part is `body`.
   */
  text?: string;
  /** Tag for filtering in the bell ("onboarding", "documents", etc.). */
  category?: string;
  /**
   * Optional in-app deeplink. The topbar bell renders rows with this set
   * as clickable — `navigate(linkUrl)` on click. Use a relative path
   * (e.g. "/onboarding/me/<id>") not a full URL; the email template
   * builds its own absolute link separately.
   */
  linkUrl?: string;
  /** EMAIL only — a packet that belongs with the message (the bell shows the text). */
  attachments?: SendAttachment[];
  /**
   * Bell-only delivery: skip the email AND the push. For routine-positive
   * confirmations ("hours approved") where the event is self-evident and
   * an inbox interruption reads as spam. Anything that requires action or
   * changes what someone gets paid must NOT be quiet.
   */
  quiet?: boolean;
  /**
   * Access pack: goes out now whatever the person's quiet hours or digest
   * choice says (lib/notificationDelivery). Mandatory buckets, safety and
   * pay are urgent by category already; set this for the rest.
   */
  urgent?: boolean;
  /**
   * How urgent this notice is, when its category alone doesn't say
   * (@alto-people/shared notificationTier): 'info' for a receipt like
   * "Hours approved" in a category that also carries rejections. `urgent`
   * still wins.
   */
  tier?: NotificationTier;
  /**
   * When the notice stops being useful — a shift's start, the van's
   * arrival. Quiet hours or a summary never deliver it later than this; it
   * goes now instead (lib/notificationDelivery planOutside).
   */
  actBy?: Date;
  /**
   * Bell and push only, no email this time: a sender that already emailed
   * the person about the same kind of thing today (open-shift invites:
   * at most one email a day).
   */
  skipEmail?: boolean;
  /**
   * WhatsApp (Brief 1C-4): the registered template this notice goes out
   * as, with its positional parameters rendered per language. Without it
   * the subject and body ride the generic template.
   */
  wa?: { template: WaTemplateKey; params: (lang: WaLang) => string[] };
  /**
   * AI disclosure (lib/agentDisclosure): the agent (Worker id) whose action
   * this notice reports. Stored on the Notification row so the bell can
   * badge it; the body itself carries the disclosure line.
   */
  byAgentId?: string | null;
}

/** notifyAllAdmins email tiers — the bell row still reaches every admin
 *  role; these narrow who ALSO gets the email. Pass via `emailRoles`. */
export const ADMIN_EMAIL_HIRING = ['HR_ADMINISTRATOR', 'INTERNAL_RECRUITER'] as const;
export const ADMIN_EMAIL_HR_ONLY = ['HR_ADMINISTRATOR'] as const;

/**
 * Every email leaves in the branded layout. Callers that built a full
 * template pass html; everyone else (the generic notify* fan-outs) used to
 * go out as bare unstyled text with no logo, company block, or disclaimer —
 * indistinguishable from phishing, which is exactly what the standard
 * footer exists to prevent.
 */
function brandedEmail(opts: NotifyOpts): { html: string; text: string } {
  if (opts.html) return { html: opts.html, text: opts.text ?? opts.body };
  const tpl = genericNotificationTemplate({
    subject: opts.subject ?? `Notification from ${getBrandingSync().orgName}`,
    body: opts.body,
    linkUrl: opts.linkUrl ?? null,
  });
  return { html: tpl.html, text: tpl.text };
}

/**
 * Send a transactional email to one user and record the result as an
 * EMAIL Notification row (status SENT or FAILED). Tracked so tests can
 * await it via flushPendingNotifications.
 */
function sendEmailNotification(
  userId: string,
  email: string,
  opts: NotifyOpts,
): Promise<'SENT' | 'FAILED' | 'SUPPRESSED'> {
  return track(
    (async (): Promise<'SENT' | 'FAILED' | 'SUPPRESSED'> => {
      let externalRef: string | null = null;
      let providerMessageId: string | null = null;
      let failureReason: string | null = null;
      let suppressed = false;
      const branded = brandedEmail(opts);
      try {
        const r = await send({
          channel: 'EMAIL',
          // This caller writes its own Notification row for the attempt.
          audit: false,
          recipient: { userId, phone: null, email },
          subject: opts.subject,
          body: branded.text,
          html: branded.html,
          // Announcements keep their one-click unsubscribe; since 2026-11-02
          // every other notice that can be muted says how to stop just its
          // kind (lib/notifications drops a mandatory bucket on its own). An
          // urgent notice never offers a way out of the next one.
          includeUnsubscribe: bucketForRawCategory(opts.category) === 'broadcast',
          ...(() => {
            const bucket = bucketForRawCategory(opts.category);
            return bucket && notificationTier(opts.category, opts) !== 'critical' ? { unsubscribe: { bucket } } : {};
          })(),
          attachments: opts.attachments,
        });
        externalRef = r.externalRef;
        providerMessageId = r.providerMessageId;
      } catch (err) {
        if (err instanceof EmailSuppressedError) {
          suppressed = true;
        }
        failureReason = err instanceof Error ? err.message : String(err);
      }
      const status = suppressed ? 'SUPPRESSED' : failureReason ? 'FAILED' : 'SENT';
      await prisma.notification.create({
        data: {
          channel: 'EMAIL',
          status,
          recipientUserId: userId,
          recipientEmail: email,
          subject: opts.subject,
          body: opts.body,
          category: opts.category ?? null,
          byAgentId: opts.byAgentId ?? null,
          externalRef,
          providerMessageId,
          failureReason,
          sentAt: failureReason ? null : new Date(),
        },
      });
      return status;
    })().catch((err: unknown): 'FAILED' => {
      console.warn(
        '[notify] sendEmailNotification failed:',
        err instanceof Error ? err.message : err,
      );
      return 'FAILED';
    }),
  );
}

/** What one chosen channel of a broadcast did for one person (lib/broadcastDelivery). */
export type ChannelOutcome = 'sent' | 'failed' | 'muted' | 'suppressed' | 'not_configured' | 'held' | 'skipped';

/**
 * Deliver on exactly the channels asked for — the broadcast composer's
 * choice, honoured per recipient (the audit of 2026-10-21: channels were
 * stored and ignored; everyone got bell + email regardless). Mute
 * preferences, quiet hours and the mandatory buckets apply as in
 * notifyUser; a channel with no provider behind it answers
 * 'not_configured' instead of pretending. Tracked for
 * flushPendingNotifications.
 */
export function notifyUserOn(
  userId: string,
  opts: NotifyOpts,
  channels: ReadonlyArray<'IN_APP' | 'EMAIL' | 'PUSH'>,
): Promise<Record<'IN_APP' | 'EMAIL' | 'PUSH', ChannelOutcome>> {
  return track(
    (async () => {
      const out: Record<'IN_APP' | 'EMAIL' | 'PUSH', ChannelOutcome> = { IN_APP: 'skipped', EMAIL: 'skipped', PUSH: 'skipped' };
      const want = new Set(channels);
      const u = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, status: true } });
      if (!u || u.status !== 'ACTIVE') {
        for (const c of want) out[c] = 'failed';
        return out;
      }
      let bellId: string | null = null;
      if (want.has('IN_APP')) {
        if (await isInAppMutedForCategory(userId, opts.category)) out.IN_APP = 'muted';
        else {
          const bell = await prisma.notification.create({
            data: {
              channel: 'IN_APP',
              status: 'SENT',
              recipientUserId: userId,
              subject: opts.subject,
              body: opts.body,
              category: opts.category ?? null,
              linkUrl: opts.linkUrl ?? null,
              byAgentId: opts.byAgentId ?? null,
              sentAt: new Date(),
            },
            select: { id: true },
          });
          bellId = bell.id;
          emitLiveEvent(userId, 'notification');
          out.IN_APP = 'sent';
        }
      }
      // Email and push each answer to their own switch for the category.
      if (want.has('EMAIL')) {
        if (await isEmailMutedForCategory(userId, opts.category)) out.EMAIL = 'muted';
        else if (!u.email) out.EMAIL = 'failed';
        else {
          const branded = brandedEmail(opts);
          const route = await routeOutside(userId, 'EMAIL', { ...noticeOf(opts), html: branded.html, text: branded.text }, { bellId });
          if (route === 'held') out.EMAIL = 'held';
          // Their delivery choice leaves email out for this one (only urgent
          // notices, or bell-only information on "only what needs me").
          else if (route === 'never') out.EMAIL = 'skipped';
          else {
            const status = await sendEmailNotification(userId, u.email, opts);
            out.EMAIL = status === 'SENT' ? 'sent' : status === 'SUPPRESSED' ? 'suppressed' : 'failed';
          }
        }
      }
      if (want.has('PUSH')) {
        out.PUSH = anyPushConfigured()
          ? await pushFor(userId, opts, opts.subject ?? getBrandingSync().orgName, bellId).then((r) => (r === 'never' ? 'skipped' : r))
          : (await isPushMuted(userId, opts.category))
            ? 'muted'
            : 'not_configured';
      }
      return out;
    })().catch((err: unknown) => {
      console.warn('[notify] notifyUserOn failed:', err instanceof Error ? err.message : err);
      const failed: Record<'IN_APP' | 'EMAIL' | 'PUSH', ChannelOutcome> = { IN_APP: 'skipped', EMAIL: 'skipped', PUSH: 'skipped' };
      for (const c of channels) failed[c] = 'failed';
      return failed;
    }),
  );
}

/**
 * The outside channels for callers that already wrote their own IN_APP row
 * (notifyShift in scheduling, the schedule digests): push, email and
 * WhatsApp under the same switches and delivery rules as notifyUser. Pass
 * the bell row's id so a held email is dropped once that has been seen.
 * Fire-and-forget and tracked for flushPendingNotifications.
 */
export function emailUserForCategory(
  userId: string,
  email: string,
  opts: NotifyOpts,
  bellId: string | null = null,
): Promise<void> {
  return track(
    (async () => {
      // Push, email and WhatsApp, each behind its own switch and the
      // person's delivery rules — the same path as notifyUser.
      deliverOutside(userId, email, opts, bellId);
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
      // Bell, email and push are three switches per category (Settings ›
      // Notifications); each one silences only its own channel. Turning the
      // bell off used to drop the email and push too, so a Push column left
      // on would have promised pushes that never came.
      let bellId: string | null = null;
      if (!(await isInAppMutedForCategory(userId, opts.category))) {
        const bell = await client.notification.create({
          data: {
            channel: 'IN_APP',
            status: 'SENT',
            recipientUserId: userId,
            subject: opts.subject,
            body: opts.body,
            category: opts.category ?? null,
            linkUrl: opts.linkUrl ?? null,
            byAgentId: opts.byAgentId ?? null,
            sentAt: new Date(),
          },
          select: { id: true },
        });
        bellId = bell.id;
        // Live nudge: any open tab refetches the bell (and badge) instantly.
        emitLiveEvent(userId, 'notification');
      }
      // quiet = the bell row above is the whole delivery.
      if (opts.quiet) return;
      const u = await prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, status: true },
      });
      if (u && u.email && u.status === 'ACTIVE') deliverOutside(userId, u.email, opts, bellId);
    })().catch((err: unknown) => {
      console.warn('[notify] notifyUser failed:', err instanceof Error ? err.message : err);
    }),
  );
}

/** One bell row each, in one insert; answers recipient → bell row id. */
async function bellRowsFor(recipients: ReadonlyArray<{ id: string }>, opts: NotifyOpts): Promise<Map<string, string>> {
  const now = new Date();
  const rows = await prisma.notification.createManyAndReturn({
    data: recipients.map((u) => ({
      channel: 'IN_APP' as const,
      status: 'SENT' as const,
      recipientUserId: u.id,
      subject: opts.subject,
      body: opts.body,
      category: opts.category ?? null,
      linkUrl: opts.linkUrl ?? null,
      byAgentId: opts.byAgentId ?? null,
      sentAt: now,
    })),
    select: { id: true, recipientUserId: true },
  });
  for (const u of recipients) emitLiveEvent(u.id, 'notification');
  return new Map(rows.flatMap((r) => (r.recipientUserId ? [[r.recipientUserId, r.id] as const] : [])));
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
      const pool = await prisma.user.findMany({
        where: {
          role: { in: ONBOARDING_ADMIN_ROLES },
          status: 'ACTIVE',
          ...(opts.excludeUserId ? { NOT: { id: opts.excludeUserId } } : {}),
        },
        select: { id: true, email: true, role: true },
      });
      // Whose job is this, rather than who is allowed to see it. Six roles
      // hold manage:onboarding; that is an access answer, and using it as
      // the recipient list is why a marketing manager heard about every
      // OSHA incident in the company. An unrouted category still reaches
      // everyone (see CATEGORY_ROLE_ROUTING).
      const routed = pool.filter((u) => roleWantsCategory(u.role, opts.category));
      // ...and then whoever asked not to be told.
      const recipients = await withBellUnmuted(routed, opts.category);
      if (recipients.length === 0) return;
      const bells = await bellRowsFor(recipients, opts);
      // Each recipient's own switches and delivery rules (lib/notificationDelivery):
      // this fan-out used to email every admin at once, quiet hours or not.
      // Someone `emailRoles` narrows away stays bell-only, as before.
      // A bell-only notice (`quiet`) is bell-only here too; it used to email anyway.
      if (opts.quiet) return;
      for (const u of recipients) {
        const emailed = !opts.emailRoles || opts.emailRoles.includes(u.role);
        deliverOutside(u.id, emailed ? u.email : null, opts, bells.get(u.id) ?? null, { push: emailed });
      }
    })().catch((err: unknown) => {
      console.warn('[notify] notifyAllAdmins failed:', err instanceof Error ? err.message : err);
    }),
  );
}

/**
 * Notify the ACTIVE SHIFT_SUPERVISORs bound to `clientId`. Supervisors
 * hold no admin capability, so notifyAllAdmins never reaches them — yet
 * they're the person physically on the floor for client-attributable
 * events (shift claims, swaps, possible no-shows). Call this ALONGSIDE
 * the existing notifyManager/notifyAllAdmins fan-outs, not instead.
 *
 * Answers who the alert was addressed to (the roster, muted or not) — empty
 * when the client has no supervisor for it, so a caller routing to the
 * floor first knows to go straight to the office (lib/alertEscalation).
 *
 * `at` places the event on a shift (its store and start): it goes to the
 * supervisors who lead that shift window, or to every supervisor at the
 * client when nobody leads it (lib/shiftWindows). Without `at` (time off,
 * week-level signals) it reaches every supervisor at the client.
 */
export function notifyClientSupervisors(
  clientId: string | null | undefined,
  opts: NotifyOpts & {
    excludeUserId?: string | null;
    at?: { locationId: string | null; startsAt: Date } | null;
    /** About this associate — a floor supervisor's own lead hears first. */
    aboutAssociateId?: string | null;
  },
): Promise<string[]> {
  return track(
    (async (): Promise<string[]> => {
      if (!clientId) return [];
      const roster = await supervisorRecipients(prisma, clientId, opts.at, {
        excludeUserId: opts.excludeUserId,
        aboutAssociateId: opts.aboutAssociateId,
      });
      // No role filter here: this roster is already the people on that
      // floor, for that client. Only the mute applies.
      const recipients = await withBellUnmuted(roster, opts.category);
      if (recipients.length === 0) return roster.map((u) => u.id);
      const bells = await bellRowsFor(recipients, opts);
      if (!opts.quiet) for (const u of recipients) deliverOutside(u.id, u.email, opts, bells.get(u.id) ?? null);
      return roster.map((u) => u.id);
    })().catch((err: unknown): string[] => {
      console.warn(
        '[notify] notifyClientSupervisors failed:',
        err instanceof Error ? err.message : err,
      );
      return [];
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
        ? { html: opts.html, text: opts.text ?? opts.body }
        : genericNotificationTemplate({
            subject: opts.subject ?? `Notification from ${getBrandingSync().orgName}`,
            body: opts.body,
            linkUrl: opts.linkUrl ?? null,
          });
      await send({
        channel: 'EMAIL',
        // This caller writes its own Notification row for the attempt.
        audit: false,
        recipient: { userId: null, phone: null, email: associate.email },
        subject: opts.subject ?? `Notification from ${getBrandingSync().orgName}`,
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
      // Out of office: whoever is covering this manager's inbox today hears
      // it too, so the request does not sit unanswered until they are back.
      for (const d of await activeDelegationsFrom(managerUser.id)) {
        await notifyUser(d.toUserId, opts);
      }
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
      if (app.status === 'APPROVED' || app.status === 'REJECTED' || app.status === 'CANCELLED') return;

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
      // The email names the worker in the tenant's word; warm the profile for the template.
      await loadTenantProfile();
      const tpl = onboardingCompleteTemplate({
        associateName: who,
        clientName: app.client?.name ?? null,
        submittedAt: fmtMomentInZone(new Date()),
        applicationUrl: `${publicBaseUrl()}/onboarding/applications/${app.id}`,
      });
      await notifyAllAdmins({
        subject: tpl.subject,
        body: tpl.text,
        html: tpl.html,
        category: 'onboarding',
        // The email's button already opened it; now the bell row does too.
        linkUrl: `/onboarding/applications/${app.id}`,
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
