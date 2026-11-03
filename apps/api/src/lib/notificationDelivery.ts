import type { DeliveryMode, PrismaClient } from '@prisma/client';
import { NOTIFICATION_CATEGORIES, SUMMARY_HOUR, bucketForCategory, defaultDeliveryFor, notificationTier, type NotificationTier } from '@alto-people/shared';
import { env } from '../config/env.js';
import { prisma } from '../db.js';
import { getBrandingSync } from './branding.js';
import { appLink, renderBrandedEmail, toEmailLang, type EmailLang } from './emailLayout.js';
import { genericNotificationTemplate } from './emailTemplates.js';
import { EmailSuppressedError, send } from './notifications.js';
import { orgTimeZone } from './siteDay.js';
import { tenantIdForWrite } from './tenant.js';
import { tenantJob } from './tenantJobs.js';
import { isPushMuted, pushReachFor, sendPushToUser } from './webPush.js';
import { whatsappConfigured } from './whatsapp.js';

/**
 * Access pack — when a notification reaches a person, not only whether.
 *
 *   The bell row always lands at once. The OUTSIDE channels (email, push,
 *   WhatsApp) answer to how urgent the notice is (@alto-people/shared
 *   notificationTier) and to the person's choices:
 *
 *     quiet hours   — nothing buzzes between, say, 22:00 and 07:00 in the
 *                     person's own time zone; what arrived waits for the
 *                     morning, as one message;
 *     email mode    — every update as it happens (REALTIME), once an hour
 *                     (DIGEST), one summary at 7 AM (DAILY), only what needs
 *                     them (IMPORTANT), or only urgent and required notices
 *                     (OFF);
 *     push mode     — as it happens, or once an hour.
 *
 *   Calm notifications (owner, 2026-11-02 — 27,059 emails in 30 days for
 *   250 people, 99% of them repeating a bell row; one person in 250 had
 *   ever set quiet hours): someone who never chose gets their role's
 *   defaults — quiet 21:00–07:00, the office a morning summary instead of
 *   an email per alert, the floor only what needs them. A push and a
 *   WhatsApp go only for what needs the person; what merely informs stays
 *   in the bell. On IMPORTANT, a notice that needs them is emailed only if
 *   its bell copy is still unseen four hours on — or at once when no phone
 *   or WhatsApp reaches them. Past five non-urgent emails in a day, the rest
 *   wait for the morning summary.
 *
 *   What cannot wait, does not: mandatory buckets (formal HR notices,
 *   account security), short-staffing alerts, and anything about safety,
 *   an incident, an emergency, pay or a disbursement goes out now, quiet
 *   hours or not. A caller can also say `urgent: true`.
 *
 *   A held notification is a DeferredNotification row; the digest job
 *   (every ten minutes, per tenant) sends what has come due, one message
 *   per person and channel, and drops what the person already saw in the
 *   bell.
 */

export type OutsideChannel = 'EMAIL' | 'PUSH' | 'WHATSAPP';

export interface DeliveryPrefs {
  quietHoursStart: number | null;
  quietHoursEnd: number | null;
  deliveryEmail: DeliveryMode;
  deliveryPush: DeliveryMode;
  deliverySms: DeliveryMode;
  timezone: string | null;
}

export interface Deferral {
  reason: 'QUIET_HOURS' | 'DIGEST' | 'SUMMARY' | 'UNSEEN';
  dueAt: Date;
}

/** Now, later (and why), or not on this channel at all. */
export type OutsidePlan = { send: 'now' } | { send: 'never' } | ({ send: 'later' } & Deferral);

/** True when this notification must not wait, whatever the person chose. */
export function mustGoNow(opts: { category?: string; urgent?: boolean; tier?: NotificationTier }): boolean {
  return notificationTier(opts.category, opts) === 'critical';
}

/** Minutes since local midnight in `tz` at `at`. */
export function localMinutes(at: Date, tz: string | null): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz ?? 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
    const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
    const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
    return h * 60 + m;
  } catch {
    return at.getUTCHours() * 60 + at.getUTCMinutes();
  }
}

/** True when `minutes` falls inside [start, end), wrapping midnight when start > end. */
export function inQuietHours(minutes: number, start: number | null, end: number | null): boolean {
  if (start === null || end === null || start === end) return false;
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

/** The next instant the clock in `tz` reads `minute` (minutes from local midnight). */
function nextLocalMinute(at: Date, tz: string | null, minute: number): Date {
  const nowMin = localMinutes(at, tz);
  const wait = ((minute - nowMin) % 1440 + 1440) % 1440 || 1440;
  const d = new Date(at.getTime() + wait * 60_000);
  d.setUTCSeconds(0, 0);
  return d;
}

/** The instant quiet hours end next, from `at`. */
function quietEndsAt(at: Date, tz: string | null, end: number): Date {
  return nextLocalMinute(at, tz, end);
}

/** The next morning summary: 7:00 on the person's clock. */
export function nextSummaryAt(at: Date, tz: string | null): Date {
  return nextLocalMinute(at, tz, SUMMARY_HOUR * 60);
}

/** The next top of the hour (the digest's cadence). */
function nextHour(at: Date): Date {
  const d = new Date(at);
  d.setUTCMinutes(0, 0, 0);
  return new Date(d.getTime() + 3_600_000);
}

/** How long an email waits for its bell copy to be seen (IMPORTANT). */
const UNSEEN_WAIT_MS = 4 * 3_600_000;
/** Non-urgent emails one person gets in a day; past it the rest wait for the morning summary. */
export const DAILY_EMAIL_CAP = 5;

/**
 * Pure: what this channel does with a notice of this tier for this person.
 * `reachable` matters only to IMPORTANT email: whether a push or WhatsApp
 * reaches them, so the email can wait to see whether the bell copy gets seen.
 */
export function planOutside(prefs: DeliveryPrefs, channel: OutsideChannel, tier: NotificationTier, ctx: { reachable?: boolean } = {}, at: Date = new Date()): OutsidePlan {
  if (tier === 'critical') return { send: 'now' };
  const quiet = inQuietHours(localMinutes(at, prefs.timezone), prefs.quietHoursStart, prefs.quietHoursEnd);
  const quietEnd = quiet ? quietEndsAt(at, prefs.timezone, prefs.quietHoursEnd!) : null;
  const later = (reason: Deferral['reason'], dueAt: Date): OutsidePlan => ({ send: 'later', reason, dueAt });
  if (channel !== 'EMAIL') {
    // The lock screen and WhatsApp are for what needs the person; what
    // merely informs them, or is itself a summary, stays in the bell.
    if (tier === 'info' || tier === 'digest') return { send: 'never' };
    const mode = channel === 'PUSH' ? prefs.deliveryPush : prefs.deliverySms;
    if (mode === 'OFF') return { send: 'never' };
    const hourly = mode === 'DIGEST' ? nextHour(at) : null;
    if (quietEnd && hourly) return later('QUIET_HOURS', new Date(Math.max(quietEnd.getTime(), hourly.getTime())));
    if (quietEnd) return later('QUIET_HOURS', quietEnd);
    if (hourly) return later('DIGEST', hourly);
    return { send: 'now' };
  }
  const mode = prefs.deliveryEmail;
  if (mode === 'OFF') return { send: 'never' };
  // A scheduled summary is the email itself, whatever the mode.
  if (tier === 'digest' || mode === 'REALTIME') return quietEnd ? later('QUIET_HOURS', quietEnd) : { send: 'now' };
  if (mode === 'DAILY') return later('SUMMARY', nextSummaryAt(at, prefs.timezone));
  if (mode === 'DIGEST') {
    const hourly = nextHour(at);
    return quietEnd ? later('QUIET_HOURS', new Date(Math.max(quietEnd.getTime(), hourly.getTime()))) : later('DIGEST', hourly);
  }
  // IMPORTANT: only what needs them — and by email only when nothing else
  // reached them: at once if no phone does, else once the bell copy has
  // gone unseen for four hours (moved past quiet hours).
  if (tier === 'info') return { send: 'never' };
  if (!ctx.reachable) return quietEnd ? later('QUIET_HOURS', quietEnd) : { send: 'now' };
  const due = new Date(at.getTime() + UNSEEN_WAIT_MS);
  const dueQuiet = inQuietHours(localMinutes(due, prefs.timezone), prefs.quietHoursStart, prefs.quietHoursEnd);
  return later('UNSEEN', dueQuiet ? quietEndsAt(due, prefs.timezone, prefs.quietHoursEnd!) : due);
}

/** Null = send now (or never); else how long it waits and why (pure). */
export function deferralFor(prefs: DeliveryPrefs, channel: OutsideChannel, opts: { category?: string; urgent?: boolean; tier?: NotificationTier }, at: Date = new Date()): Deferral | null {
  const plan = planOutside(prefs, channel, notificationTier(opts.category, opts), { reachable: true }, at);
  return plan.send === 'later' ? { reason: plan.reason, dueAt: plan.dueAt } : null;
}

/**
 * The person's delivery choices as they apply: what they saved, or — when
 * they never chose — their role's defaults (@alto-people/shared
 * defaultDeliveryFor). A missing time zone is the company's, never UTC: a
 * 9 PM quiet hour read in UTC began at 4 or 5 in the afternoon.
 */
export function effectiveDeliveryPrefs(u: {
  role: string;
  quietHoursStart: number | null;
  quietHoursEnd: number | null;
  deliveryEmail: DeliveryMode;
  deliveryPush: DeliveryMode;
  deliverySms: DeliveryMode;
  timezone: string | null;
  deliveryPrefsSetAt: Date | null;
}): DeliveryPrefs & { isDefault: boolean } {
  const timezone = u.timezone ?? orgTimeZone();
  if (u.deliveryPrefsSetAt || !env.NOTIFY_ROLE_DEFAULTS) {
    return { quietHoursStart: u.quietHoursStart, quietHoursEnd: u.quietHoursEnd, deliveryEmail: u.deliveryEmail, deliveryPush: u.deliveryPush, deliverySms: u.deliverySms, timezone, isDefault: !u.deliveryPrefsSetAt };
  }
  const d = defaultDeliveryFor(u.role);
  return {
    quietHoursStart: d.quietHoursStart,
    quietHoursEnd: d.quietHoursEnd,
    deliveryEmail: d.deliveryEmail as DeliveryMode,
    deliveryPush: d.deliveryPush as DeliveryMode,
    deliverySms: d.deliverySms as DeliveryMode,
    timezone,
    isDefault: true,
  };
}

const prefsCache = new Map<string, { at: number; prefs: DeliveryPrefs }>();
const PREFS_MS = 30_000;

export function resetDeliveryPrefsCache(): void {
  prefsCache.clear();
}

export async function deliveryPrefsFor(userId: string, db: PrismaClient = prisma): Promise<DeliveryPrefs> {
  const hit = prefsCache.get(userId);
  if (hit && process.env.NODE_ENV !== 'test' && Date.now() - hit.at < PREFS_MS) return hit.prefs;
  const u = await db.user.findUnique({
    where: { id: userId },
    select: { role: true, quietHoursStart: true, quietHoursEnd: true, deliveryEmail: true, deliveryPush: true, deliverySms: true, timezone: true, deliveryPrefsSetAt: true },
  });
  const prefs: DeliveryPrefs = u
    ? effectiveDeliveryPrefs(u)
    : { quietHoursStart: null, quietHoursEnd: null, deliveryEmail: 'REALTIME', deliveryPush: 'REALTIME', deliverySms: 'REALTIME', timezone: orgTimeZone() };
  prefsCache.set(userId, { at: Date.now(), prefs });
  return prefs;
}

/** Does a push or WhatsApp reach this person for this kind of notice? (IMPORTANT email waits only if so.) */
async function reachableElsewhere(userId: string, prefs: DeliveryPrefs, category: string | undefined, db: PrismaClient): Promise<boolean> {
  if (prefs.deliveryPush !== 'OFF' && !(await isPushMuted(userId, category))) {
    if ((await pushReachFor(userId)).devices > 0) return true;
  }
  if (!whatsappConfigured() || prefs.deliverySms === 'OFF') return false;
  const u = await db.user.findUnique({ where: { id: userId }, select: { associateId: true } });
  if (!u?.associateId) return false;
  const consent = await db.whatsAppConsent.findUnique({ where: { associateId: u.associateId }, select: { status: true } });
  return consent?.status === 'OPTED_IN';
}

/** Emails this person has been sent since their own midnight. */
async function emailsToday(userId: string, prefs: DeliveryPrefs, db: PrismaClient, at: Date): Promise<number> {
  const since = new Date(at.getTime() - localMinutes(at, prefs.timezone) * 60_000 - at.getUTCSeconds() * 1000 - at.getUTCMilliseconds());
  return db.notification.count({ where: { recipientUserId: userId, channel: 'EMAIL', createdAt: { gte: since } } });
}

/** What a held copy needs to go out later as it would have now. */
export interface OutsideNotice {
  subject: string | null;
  body: string;
  linkUrl?: string | null;
  category?: string;
  urgent?: boolean;
  tier?: NotificationTier;
  /** EMAIL: the email as built, so a held copy can go out whole. */
  html?: string;
  text?: string;
}

/**
 * Decide this channel's copy: send it now ('now'), hold it ('held' — a
 * DeferredNotification row), or not on this channel at all ('never').
 * `bellId` is the bell copy of the same notice: a held email it has been
 * seen through is dropped when it comes due.
 */
export async function routeOutside(
  userId: string,
  channel: OutsideChannel,
  n: OutsideNotice,
  ctx: { bellId?: string | null } = {},
  db: PrismaClient = prisma,
  at: Date = new Date(),
): Promise<'now' | 'held' | 'never'> {
  const prefs = await deliveryPrefsFor(userId, db);
  const tier = notificationTier(n.category, n);
  const reachable = channel === 'EMAIL' && tier === 'action' && prefs.deliveryEmail === 'IMPORTANT' ? await reachableElsewhere(userId, prefs, n.category, db) : true;
  let plan = planOutside(prefs, channel, tier, { reachable }, at);
  if (plan.send === 'now' && channel === 'EMAIL' && tier !== 'critical' && tier !== 'digest' && (await emailsToday(userId, prefs, db, at)) >= DAILY_EMAIL_CAP) {
    plan = { send: 'later', reason: 'SUMMARY', dueAt: nextSummaryAt(at, prefs.timezone) };
  }
  if (plan.send !== 'later') return plan.send;
  await db.deferredNotification.create({
    data: {
      userId,
      channel,
      reason: plan.reason,
      subject: n.subject?.slice(0, 300) ?? null,
      body: n.body,
      linkUrl: n.linkUrl?.slice(0, 500) ?? null,
      category: n.category ?? null,
      dueAt: plan.dueAt,
      notificationId: ctx.bellId ?? null,
      html: channel === 'EMAIL' ? (n.html ?? null) : null,
      text: channel === 'EMAIL' ? (n.text ?? null) : null,
    },
  });
  return 'held';
}

/**
 * Hold this channel's copy for later, or say "send it now" (false). The
 * caller sends when this returns false; true means it was queued — or that
 * this channel is not for this notice at all.
 */
export async function holdIfDeferred(
  userId: string,
  channel: OutsideChannel,
  opts: OutsideNotice,
  db: PrismaClient = prisma,
): Promise<boolean> {
  return (await routeOutside(userId, channel, opts, {}, db)) !== 'now';
}

/* ------------------------------------------------------------ the digest */

const SUMMARY_CHROME: Record<EmailLang, {
  subject: (n: number) => string;
  updates: (n: number, org: string) => string;
  heading: string;
  intro: (n: number) => string;
  more: (n: number) => string;
  open: string;
}> = {
  en: {
    subject: (n) => `Your morning summary: ${n} update${n === 1 ? '' : 's'}`,
    updates: (n, org) => `${n} updates from ${org}`,
    heading: 'What came in while you were away',
    intro: (n) => `${n === 1 ? 'One update you haven’t opened yet' : `${n} updates you haven’t opened yet`}. Anything urgent was sent at once; these could wait.`,
    more: (n) => `…and ${n} more in the app.`,
    open: 'Open Alto People',
  },
  es: {
    subject: (n) => `Su resumen de la mañana: ${n} novedad${n === 1 ? '' : 'es'}`,
    updates: (n, org) => `${n} novedades de ${org}`,
    heading: 'Lo que llegó mientras no estaba',
    intro: (n) => `${n === 1 ? 'Una novedad que aún no ha abierto' : `${n} novedades que aún no ha abierto`}. Lo urgente se envió de inmediato; esto podía esperar.`,
    more: (n) => `…y ${n} más en la aplicación.`,
    open: 'Abrir Alto People',
  },
  tr: {
    subject: (n) => `Sabah özetiniz: ${n} güncelleme`,
    updates: (n, org) => `${org} kaynağından ${n} güncelleme`,
    heading: 'Siz yokken gelenler',
    intro: (n) => `Henüz açmadığınız ${n} güncelleme var. Acil olanlar hemen gönderildi; bunlar bekleyebilirdi.`,
    more: (n) => `…ve uygulamada ${n} tane daha.`,
    open: 'Alto People’ı aç',
  },
};

const SUMMARY_ROWS = 15;

/** A row with no subject is named by its settings bucket ("Scheduling"). */
function labelOf(raw: string | null): string | null {
  const bucket = bucketForCategory(raw);
  return NOTIFICATION_CATEGORIES.find((c) => c.key === bucket)?.label ?? null;
}

/** Several held notices as one branded email (the morning summary, quiet hours, the hourly digest). */
function summaryEmail(rows: Array<{ subject: string | null; body: string; category: string | null; reason: string }>, lang: EmailLang, org: string): { subject: string; html: string; text: string } {
  const c = SUMMARY_CHROME[lang];
  const n = rows.length;
  const subject = rows.some((r) => r.reason === 'SUMMARY') ? c.subject(n) : c.updates(n, org);
  const clip = (t: string) => (t.length > 160 ? `${t.slice(0, 157)}…` : t);
  const shown = rows.slice(0, SUMMARY_ROWS);
  const rendered = renderBrandedEmail({
    lang,
    subject,
    preheader: clip(shown.map((r) => r.subject ?? r.body).join(' · ')).slice(0, 110),
    greeting: null,
    heading: c.heading,
    paragraphs: [c.intro(n)],
    summary: shown.map((r) => ({ label: r.subject ?? labelOf(r.category) ?? org, value: clip(r.body.replace(/\s+/g, ' ').trim()) })),
    cta: { label: c.open, url: appLink('/inbox') },
    after: n > SUMMARY_ROWS ? [c.more(n - SUMMARY_ROWS)] : [],
  });
  return { subject, html: rendered.html, text: rendered.text };
}

/** Send one email and keep its delivery row, as every notice email does (lib/notify). */
async function emailAndRecord(db: PrismaClient, userId: string, email: string, m: { subject: string; html: string; text: string; category: string | null; bucket?: string | null }): Promise<boolean> {
  let status: 'SENT' | 'FAILED' | 'SUPPRESSED' = 'SENT';
  let failureReason: string | null = null;
  let externalRef: string | null = null;
  let providerMessageId: string | null = null;
  try {
    const r = await send({ channel: 'EMAIL', audit: false, recipient: { userId, phone: null, email }, subject: m.subject, body: m.text, html: m.html, category: m.category, ...(m.bucket ? { unsubscribe: { bucket: m.bucket } } : {}) });
    externalRef = r.externalRef;
    providerMessageId = r.providerMessageId;
  } catch (err) {
    status = err instanceof EmailSuppressedError ? 'SUPPRESSED' : 'FAILED';
    failureReason = err instanceof Error ? err.message : String(err);
  }
  await db.notification.create({
    data: {
      channel: 'EMAIL',
      status,
      recipientUserId: userId,
      recipientEmail: email,
      subject: m.subject,
      body: m.text,
      category: m.category,
      externalRef,
      providerMessageId,
      failureReason,
      sentAt: status === 'SENT' ? new Date() : null,
    },
  });
  return status === 'SENT';
}

/**
 * Send everything due for this tenant: one message per person and channel —
 * except an UNSEEN email, which goes alone, as it would have gone out. A
 * held copy whose bell twin the person has already seen or opened has done
 * its job and is dropped.
 */
export async function runNotificationDigest(db: PrismaClient = prisma, now: Date = new Date()): Promise<number> {
  const tenantId = tenantIdForWrite();
  const due = await db.deferredNotification.findMany({
    where: { tenantId, sentAt: null, dueAt: { lte: now } },
    orderBy: { createdAt: 'asc' },
    take: 2000,
  });
  if (due.length === 0) return 0;
  const bellIds = due.flatMap((r) => (r.notificationId ? [r.notificationId] : []));
  const seenBells = new Set(
    bellIds.length === 0
      ? []
      : (
          await db.notification.findMany({
            where: { id: { in: bellIds }, OR: [{ seenAt: { not: null } }, { readAt: { not: null } }] },
            select: { id: true },
          })
        ).map((b) => b.id),
  );
  const groups = new Map<string, typeof due>();
  for (const row of due) {
    const k = row.reason === 'UNSEEN' ? `${row.userId}:${row.channel}:${row.id}` : `${row.userId}:${row.channel}`;
    groups.set(k, [...(groups.get(k) ?? []), row]);
  }
  const brand = getBrandingSync(tenantId);
  let sent = 0;
  for (const [key, held] of groups) {
    const [userId, channel] = key.split(':') as [string, OutsideChannel];
    const user = await db.user.findUnique({ where: { id: userId }, select: { email: true, status: true, language: true } });
    const ids = held.map((r) => r.id);
    const markSent = () => db.deferredNotification.updateMany({ where: { id: { in: ids } }, data: { sentAt: now } });
    if (!user || user.status !== 'ACTIVE') {
      await markSent();
      continue;
    }
    const unseen = held.filter((r) => !(r.notificationId && seenBells.has(r.notificationId)));
    // A held push whose category the person has since muted is dropped
    // here, by the same gate every push passes (lib/webPush isPushMuted).
    const rows: typeof held = [];
    if (channel === 'PUSH') {
      const mutedBy = new Map<string, boolean>();
      for (const r of unseen) {
        const k = r.category ?? '';
        if (!mutedBy.has(k)) mutedBy.set(k, await isPushMuted(userId, r.category));
        if (!mutedBy.get(k)) rows.push(r);
      }
    } else {
      rows.push(...unseen);
    }
    if (rows.length === 0) {
      await markSent();
      continue;
    }
    const n = rows.length;
    try {
      if (channel === 'EMAIL' && user.email) {
        const one = rows[0]!;
        const message =
          n === 1
            ? one.html
              ? { subject: one.subject ?? brand.orgName, html: one.html, text: one.text ?? one.body }
              : (() => {
                  const tpl = genericNotificationTemplate({ subject: one.subject ?? `Notification from ${brand.orgName}`, body: one.body, linkUrl: one.linkUrl });
                  return { subject: one.subject ?? brand.orgName, html: tpl.html, text: tpl.text };
                })()
            : summaryEmail(rows, toEmailLang(user.language), brand.orgName);
        // One notice goes out as itself, with its own "stop emails like this";
        // a summary carries only the Manage link every email has.
        const bucket = n === 1 && notificationTier(one.category) !== 'critical' ? bucketForCategory(one.category) : null;
        if (await emailAndRecord(db, userId, user.email, { ...message, category: n === 1 ? one.category : 'digest', bucket })) sent += 1;
      } else if (channel === 'PUSH') {
        const title = n === 1 ? (rows[0]!.subject ?? brand.orgName) : `${n} updates from ${brand.orgName}`;
        // category null: each bundled row passed the Push switch above.
        await sendPushToUser(userId, { title, body: n === 1 ? rows[0]!.body : `${rows[0]!.body}${n > 1 ? ` and ${n - 1} more` : ''}`, url: n === 1 ? (rows[0]!.linkUrl ?? undefined) : '/inbox', category: null, tag: 'digest' });
        sent += 1;
      }
      // WHATSAPP digests are not sent: the template catalogue is per event, so a held WhatsApp copy is dropped and the bell (and email digest) carries it.
    } catch (err) {
      console.warn('[notificationDigest] send failed:', err instanceof Error ? err.message : err);
    }
    await markSent();
  }
  return sent;
}

let timer: NodeJS.Timeout | null = null;

/** Every ten minutes, per tenant: what has come due goes out together. */
export function startNotificationDigestCron(): void {
  if (timer) return;
  const tick = () => {
    void tenantJob('notificationDigest', () => runNotificationDigest())().catch((err) => {
      console.error('[alto-people/api] notification digest failed:', err);
    });
  };
  timer = setInterval(tick, 10 * 60_000);
  timer.unref();
}
