import type { DeliveryMode, PrismaClient } from '@prisma/client';
import { NOTIFICATION_CATEGORIES, bucketForCategory } from '@alto-people/shared';
import { prisma } from '../db.js';
import { getBrandingSync } from './branding.js';
import { send } from './notifications.js';
import { tenantIdForWrite } from './tenant.js';
import { tenantJob } from './tenantJobs.js';
import { isPushMuted, sendPushToUser } from './webPush.js';

/**
 * Access pack — when a notification reaches a person, not only whether.
 *
 *   The bell row always lands at once. The OUTSIDE channels (email, push,
 *   WhatsApp) answer to two per-person choices:
 *
 *     quiet hours   — nothing buzzes between, say, 22:00 and 07:00 in the
 *                     person's own time zone; what arrived waits for the
 *                     morning, as one message;
 *     digest        — per channel, "tell me as it happens" or "once an
 *                     hour, together".
 *
 *   What cannot wait, does not: mandatory buckets (formal HR notices,
 *   account security), short-staffing alerts, and anything about safety,
 *   an incident, an emergency, pay or a disbursement goes out now, quiet
 *   hours or not. A caller can also say `urgent: true`.
 *
 *   A held notification is a DeferredNotification row; the digest job
 *   (every ten minutes, per tenant) sends what has come due, one message
 *   per person and channel, and marks the rows sent.
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
  reason: 'QUIET_HOURS' | 'DIGEST';
  dueAt: Date;
}

const MANDATORY = new Set(NOTIFICATION_CATEGORIES.filter((c) => c.mandatory).map((c) => c.key));
const ALWAYS_NOW_BUCKETS = new Set<string>(['security', 'store_alerts', ...MANDATORY]);
const URGENT_RAW = /safety|emergency|incident|sos|panic|payroll|paystub|disburs|garnish|pay_|break_glass|security|hotline|osha/i;

/** True when this notification must not wait, whatever the person chose. */
export function mustGoNow(opts: { category?: string; urgent?: boolean }): boolean {
  if (opts.urgent) return true;
  const raw = opts.category;
  if (!raw) return false;
  const bucket = bucketForCategory(raw);
  if (bucket && ALWAYS_NOW_BUCKETS.has(bucket)) return true;
  return URGENT_RAW.test(raw);
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

/** The instant quiet hours end next, from `at`. */
function quietEndsAt(at: Date, tz: string | null, end: number): Date {
  const nowMin = localMinutes(at, tz);
  const wait = ((end - nowMin) % 1440 + 1440) % 1440 || 1440;
  return new Date(at.getTime() + wait * 60_000);
}

/** The next top of the hour (the digest's cadence). */
function nextHour(at: Date): Date {
  const d = new Date(at);
  d.setUTCMinutes(0, 0, 0);
  return new Date(d.getTime() + 3_600_000);
}

function modeFor(prefs: DeliveryPrefs, channel: OutsideChannel): DeliveryMode {
  return channel === 'EMAIL' ? prefs.deliveryEmail : channel === 'PUSH' ? prefs.deliveryPush : prefs.deliverySms;
}

/** Null = send now; else how long it waits and why (pure). */
export function deferralFor(prefs: DeliveryPrefs, channel: OutsideChannel, opts: { category?: string; urgent?: boolean }, at: Date = new Date()): Deferral | null {
  if (mustGoNow(opts)) return null;
  const quiet = inQuietHours(localMinutes(at, prefs.timezone), prefs.quietHoursStart, prefs.quietHoursEnd);
  const digest = modeFor(prefs, channel) === 'DIGEST';
  if (!quiet && !digest) return null;
  const quietEnd = quiet ? quietEndsAt(at, prefs.timezone, prefs.quietHoursEnd!) : null;
  const digestAt = digest ? nextHour(at) : null;
  if (quietEnd && digestAt) return { reason: 'QUIET_HOURS', dueAt: new Date(Math.max(quietEnd.getTime(), digestAt.getTime())) };
  if (quietEnd) return { reason: 'QUIET_HOURS', dueAt: quietEnd };
  return { reason: 'DIGEST', dueAt: digestAt! };
}

const prefsCache = new Map<string, { at: number; prefs: DeliveryPrefs }>();
const PREFS_MS = 30_000;

export function resetDeliveryPrefsCache(): void {
  prefsCache.clear();
}

export async function deliveryPrefsFor(userId: string, db: PrismaClient = prisma): Promise<DeliveryPrefs> {
  const hit = prefsCache.get(userId);
  if (hit && process.env.NODE_ENV !== 'test' && Date.now() - hit.at < PREFS_MS) return hit.prefs;
  const u = await db.user.findUnique({ where: { id: userId }, select: { quietHoursStart: true, quietHoursEnd: true, deliveryEmail: true, deliveryPush: true, deliverySms: true, timezone: true } });
  const prefs: DeliveryPrefs = u ?? { quietHoursStart: null, quietHoursEnd: null, deliveryEmail: 'REALTIME', deliveryPush: 'REALTIME', deliverySms: 'REALTIME', timezone: null };
  prefsCache.set(userId, { at: Date.now(), prefs });
  return prefs;
}

/**
 * Hold this channel's copy for later, or say "send it now" (false). The
 * caller sends when this returns false; when true the row is queued.
 */
export async function holdIfDeferred(
  userId: string,
  channel: OutsideChannel,
  opts: { subject: string | null; body: string; linkUrl?: string | null; category?: string; urgent?: boolean },
  db: PrismaClient = prisma,
): Promise<boolean> {
  const prefs = await deliveryPrefsFor(userId, db);
  const d = deferralFor(prefs, channel, opts);
  if (!d) return false;
  await db.deferredNotification.create({
    data: { userId, channel, reason: d.reason, subject: opts.subject?.slice(0, 300) ?? null, body: opts.body, linkUrl: opts.linkUrl?.slice(0, 500) ?? null, category: opts.category ?? null, dueAt: d.dueAt },
  });
  return true;
}

/* ------------------------------------------------------------ the digest */

/** Send everything due for this tenant: one message per person and channel. */
export async function runNotificationDigest(db: PrismaClient = prisma, now: Date = new Date()): Promise<number> {
  const tenantId = tenantIdForWrite();
  const due = await db.deferredNotification.findMany({
    where: { tenantId, sentAt: null, dueAt: { lte: now } },
    orderBy: { createdAt: 'asc' },
    take: 2000,
  });
  if (due.length === 0) return 0;
  const groups = new Map<string, typeof due>();
  for (const row of due) {
    const k = `${row.userId}:${row.channel}`;
    groups.set(k, [...(groups.get(k) ?? []), row]);
  }
  const brand = getBrandingSync(tenantId);
  let sent = 0;
  for (const [key, held] of groups) {
    const [userId, channel] = key.split(':') as [string, OutsideChannel];
    const user = await db.user.findUnique({ where: { id: userId }, select: { email: true, status: true } });
    const ids = held.map((r) => r.id);
    if (!user || user.status !== 'ACTIVE') {
      await db.deferredNotification.updateMany({ where: { id: { in: ids } }, data: { sentAt: now } });
      continue;
    }
    // A held push whose category the person has since muted is dropped
    // here, by the same gate every push passes (lib/webPush isPushMuted).
    const rows: typeof held = [];
    if (channel === 'PUSH') {
      const mutedBy = new Map<string, boolean>();
      for (const r of held) {
        const k = r.category ?? '';
        if (!mutedBy.has(k)) mutedBy.set(k, await isPushMuted(userId, r.category));
        if (!mutedBy.get(k)) rows.push(r);
      }
    } else {
      rows.push(...held);
    }
    if (rows.length === 0) {
      await db.deferredNotification.updateMany({ where: { id: { in: ids } }, data: { sentAt: now } });
      continue;
    }
    const n = rows.length;
    const subject = n === 1 ? (rows[0]!.subject ?? `An update from ${brand.orgName}`) : `${n} updates from ${brand.orgName}`;
    const body = rows.map((r) => `• ${r.subject ? `${r.subject}: ` : ''}${r.body}`).join('\n');
    try {
      if (channel === 'EMAIL' && user.email) {
        await send({ channel: 'EMAIL', recipient: { userId, phone: null, email: user.email }, subject, body, category: 'digest' });
      } else if (channel === 'PUSH') {
        // category null: each bundled row passed the Push switch above.
        await sendPushToUser(userId, { title: subject, body: n === 1 ? rows[0]!.body : `${rows[0]!.body}${n > 1 ? ` and ${n - 1} more` : ''}`, url: n === 1 ? (rows[0]!.linkUrl ?? undefined) : '/inbox', category: null });
      }
      // WHATSAPP digests are not sent: the template catalogue is per event, so a held WhatsApp copy is dropped and the bell (and email digest) carries it.
      sent += 1;
    } catch (err) {
      console.warn('[notificationDigest] send failed:', err instanceof Error ? err.message : err);
    }
    await db.deferredNotification.updateMany({ where: { id: { in: ids } }, data: { sentAt: now } });
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
