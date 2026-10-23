import webpush from 'web-push';
import { NOTIFICATION_CATEGORIES, bucketForCategory } from '@alto-people/shared';
import { env } from '../config/env.js';
import { prisma } from '../db.js';
import { apnsConfigured, fcmConfigured, sendNativePushToUser } from './nativePush.js';

/**
 * Push sender. Fires a lock-screen notification at every device the user
 * has: browsers subscribed to web push (VAPID) and phones with the native
 * app (APNs / FCM, lib/nativePush.ts).
 *
 * - No VAPID keys configured → hard no-op (dev/test default).
 * - Dead endpoints (404/410 from the push service) are pruned inline, so
 *   the table self-cleans as devices unsubscribe or reinstall.
 * - Never throws: like email, push must not fail the mutation that
 *   triggered it. Callers fire-and-forget.
 * - Honours the person's Push switch for the category (Settings ›
 *   Notifications) before any device is touched: isPushMuted below is the
 *   one gate, and this function is the one funnel every push passes.
 */

export interface PushPayload {
  title: string;
  body: string;
  /** Relative in-app path the notification opens (sw.js notificationclick). */
  url?: string;
  /**
   * The raw notification category ('shift_published', 'payroll.paid', ...).
   * Required on purpose, so no sender can forget the person's Push switch:
   * pass null only when the push is no notice of its own (the digest, whose
   * rows were each checked before they were bundled).
   */
  category: string | null | undefined;
}

/** What sendPushToUser did: 'muted' = the person turned push off for this
 *  category, nothing was sent; 'sent' = handed to every device they have. */
export type PushOutcome = 'sent' | 'muted';

const MANDATORY_BUCKETS = new Set<string>(NOTIFICATION_CATEGORIES.filter((c) => c.mandatory).map((c) => c.key));

/**
 * True when this person turned push off for the settings bucket this raw
 * category falls in. Mandatory buckets (formal notices, account security)
 * and categories outside the settings list always push, like the email and
 * bell switches. Senders that may hold a copy for later (quiet hours,
 * digest) ask this first, so a muted push is never queued either.
 */
export async function isPushMuted(userId: string, rawCategory: string | null | undefined): Promise<boolean> {
  const bucket = bucketForCategory(rawCategory);
  if (!bucket || MANDATORY_BUCKETS.has(bucket)) return false;
  const pref = await prisma.notificationPreference.findUnique({
    where: { userId_category: { userId, category: bucket } },
    select: { pushEnabled: true },
  });
  return pref ? !pref.pushEnabled : false;
}

/**
 * Where a push could reach this person now (Settings › Notifications, the
 * Push column): which transports the server has, and how many of their
 * browsers and phones one of those transports can reach. Their own rows
 * only. A phone whose platform has no key behind it is not counted.
 */
export async function pushReachFor(userId: string): Promise<{ web: boolean; native: boolean; devices: number }> {
  const web = pushConfigured();
  const ios = apnsConfigured();
  const android = fcmConfigured();
  const platforms = [...(ios ? (['IOS'] as const) : []), ...(android ? (['ANDROID'] as const) : [])];
  const [browsers, phones] = await Promise.all([
    web ? prisma.pushSubscription.count({ where: { userId } }) : Promise.resolve(0),
    platforms.length
      ? prisma.nativeDevice.count({ where: { userId, revokedAt: null, pushToken: { not: null }, platform: { in: platforms } } })
      : Promise.resolve(0),
  ]);
  return { web, native: ios || android, devices: browsers + phones };
}

let vapidApplied = false;

export function pushConfigured(): boolean {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
}

function ensureVapid(): void {
  if (vapidApplied || !pushConfigured()) return;
  webpush.setVapidDetails(
    env.VAPID_SUBJECT ?? 'mailto:hr@altohr.com',
    env.VAPID_PUBLIC_KEY!,
    env.VAPID_PRIVATE_KEY!,
  );
  vapidApplied = true;
}

export async function sendPushToUser(userId: string, payload: PushPayload): Promise<PushOutcome> {
  if (await isPushMuted(userId, payload.category)) return 'muted';
  // What goes over the wire: the words and the link, not the category.
  const message = { title: payload.title, body: payload.body, ...(payload.url ? { url: payload.url } : {}) };
  // The native apps (iOS / Android) first — independent of VAPID, so a
  // deployment with only APNs/FCM configured still reaches phones. Every
  // caller has already applied quiet hours / digest choices.
  await sendNativePushToUser(userId, message);
  if (!pushConfigured()) return 'sent';
  ensureVapid();
  const subs = await prisma.pushSubscription.findMany({ where: { userId } });
  if (subs.length === 0) return 'sent';
  const body = JSON.stringify(message);
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          body,
        );
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) {
          // Subscription expired or was revoked — prune it.
          await prisma.pushSubscription
            .delete({ where: { id: s.id } })
            .catch(() => {});
        } else {
          console.warn(
            '[webPush] send failed:',
            err instanceof Error ? err.message : err,
          );
        }
      }
    }),
  );
  return 'sent';
}
