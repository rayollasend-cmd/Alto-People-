import webpush from 'web-push';
import { env } from '../config/env.js';
import { prisma } from '../db.js';

/**
 * Web-push sender. Fires a lock-screen notification at every device the
 * user has subscribed (a user can have several: phone + tablet).
 *
 * - No VAPID keys configured → hard no-op (dev/test default).
 * - Dead endpoints (404/410 from the push service) are pruned inline, so
 *   the table self-cleans as devices unsubscribe or reinstall.
 * - Never throws: like email, push must not fail the mutation that
 *   triggered it. Callers fire-and-forget.
 */

export interface PushPayload {
  title: string;
  body: string;
  /** Relative in-app path the notification opens (sw.js notificationclick). */
  url?: string;
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

export async function sendPushToUser(userId: string, payload: PushPayload): Promise<void> {
  if (!pushConfigured()) return;
  ensureVapid();
  const subs = await prisma.pushSubscription.findMany({ where: { userId } });
  if (subs.length === 0) return;
  const body = JSON.stringify(payload);
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
}
