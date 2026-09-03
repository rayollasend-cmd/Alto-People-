import { prisma } from '../db.js';
import { env } from '../config/env.js';

/**
 * Notification retention sweep.
 *
 * The Notification table used to grow forever: every bell row AND every
 * email-delivery audit row accumulated indefinitely behind six indexes,
 * and the only delete anywhere was the GDPR ghost purge. This sweep
 * enforces two retention windows:
 *
 *   - IN_APP rows that have been READ for 90+ days — the recipient acted
 *     on them months ago; the bell caps at 100 rows anyway. UNREAD rows
 *     are never touched: an unread notification is still a pending
 *     communication, however old.
 *   - Non-IN_APP rows (EMAIL/SMS/PUSH delivery audit) older than 365
 *     days. A year covers deliverability disputes and the Resend webhook
 *     matching window many times over.
 *
 * Deletes are chunked so a first run against years of backlog can't hold
 * a giant lock or bloat one transaction.
 */

const IN_APP_READ_RETENTION_DAYS = 90;
const DELIVERY_AUDIT_RETENTION_DAYS = 365;
const DELETE_CHUNK = 5_000;

export interface NotificationRetentionResult {
  inAppDeleted: number;
  auditDeleted: number;
}

async function deleteChunked(
  where: NonNullable<Parameters<typeof prisma.notification.deleteMany>[0]>['where'],
): Promise<number> {
  let total = 0;
  // Bounded loop: at most ~40 chunks per tick (200k rows) so a pathological
  // backlog drains across ticks instead of running unbounded.
  for (let i = 0; i < 40; i++) {
    const batch = await prisma.notification.findMany({
      where,
      select: { id: true },
      take: DELETE_CHUNK,
    });
    if (batch.length === 0) break;
    const r = await prisma.notification.deleteMany({
      where: { id: { in: batch.map((b) => b.id) } },
    });
    total += r.count;
    if (batch.length < DELETE_CHUNK) break;
  }
  return total;
}

export async function runNotificationRetention(
  now = new Date(),
): Promise<NotificationRetentionResult> {
  const inAppCutoff = new Date(
    now.getTime() - IN_APP_READ_RETENTION_DAYS * 86_400_000,
  );
  const auditCutoff = new Date(
    now.getTime() - DELIVERY_AUDIT_RETENTION_DAYS * 86_400_000,
  );

  const inAppDeleted = await deleteChunked({
    channel: 'IN_APP',
    readAt: { not: null, lt: inAppCutoff },
  });
  const auditDeleted = await deleteChunked({
    channel: { not: 'IN_APP' },
    createdAt: { lt: auditCutoff },
  });

  if (inAppDeleted > 0 || auditDeleted > 0) {
    console.log(
      `[alto-people/api] notification retention: removed ${inAppDeleted} read ` +
        `bell rows (>${IN_APP_READ_RETENTION_DAYS}d) and ${auditDeleted} ` +
        `delivery-audit rows (>${DELIVERY_AUDIT_RETENTION_DAYS}d)`,
    );
  }
  return { inAppDeleted, auditDeleted };
}

let timer: NodeJS.Timeout | null = null;

export function startNotificationRetentionCron(): void {
  if (timer) return;
  const seconds = env.NOTIFICATION_RETENTION_INTERVAL_SECONDS;
  if (seconds <= 0) return;
  const tick = () => {
    void runNotificationRetention().catch((err) => {
      console.error('[alto-people/api] notification retention failed:', err);
    });
  };
  tick();
  timer = setInterval(tick, seconds * 1000);
  timer.unref();
  console.log(
    `[alto-people/api] notification retention cron armed (every ${seconds}s; ` +
      `read bell rows ${IN_APP_READ_RETENTION_DAYS}d, delivery audit ${DELIVERY_AUDIT_RETENTION_DAYS}d)`,
  );
}

export function stopNotificationRetentionCron(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
