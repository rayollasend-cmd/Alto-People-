// Saturday-morning executive digest — the week-in-review email nobody
// had: the org week closed Friday midnight, so Saturday morning every
// EXECUTIVE_CHAIRMAN gets last week's numbers in plain prose (hours, OT,
// est. billed/margin, workforce movement, attendance, placements).
//
// Send-at-most-once per org week per recipient, enforced by the digest's
// own IN_APP notification row (category below, createdAt >= this week's
// start). The sweep runs on an interval and only fires on the org week's
// first day (Saturday, Florida-local) after SEND_AFTER_HOUR local time.

import { prisma as defaultPrisma } from '../db.js';
import type { PrismaClient } from '@prisma/client';
import { startOfWeekUTC } from './timeAnomalies.js';
import { computeExecutiveSummary, executiveDigestBody } from './executiveSummary.js';
import { notifyUser } from './notify.js';
import { DEFAULT_TIMEZONE } from './timezone.js';

const DIGEST_CATEGORY = 'executive_digest';
const SEND_AFTER_HOUR = 8;
const SWEEP_SECONDS = 15 * 60;

function localParts(now: Date, timeZone: string): { weekday: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: 'numeric',
    hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { weekday: get('weekday'), hour: Number(get('hour')) || 0 };
}

export interface ExecutiveDigestResult {
  sent: number;
  skipped?: 'not_saturday' | 'too_early' | 'no_recipients' | 'already_sent';
}

export async function runExecutiveDigestSweep(
  prisma: PrismaClient = defaultPrisma,
  now: Date = new Date(),
): Promise<ExecutiveDigestResult> {
  const { weekday, hour } = localParts(now, DEFAULT_TIMEZONE);
  if (weekday !== 'Sat') return { sent: 0, skipped: 'not_saturday' };
  if (hour < SEND_AFTER_HOUR) return { sent: 0, skipped: 'too_early' };

  const recipients = await prisma.user.findMany({
    where: { role: 'EXECUTIVE_CHAIRMAN', status: 'ACTIVE', deletedAt: null },
    select: { id: true },
  });
  if (recipients.length === 0) return { sent: 0, skipped: 'no_recipients' };

  const weekStart = startOfWeekUTC(now);
  const alreadySent = await prisma.notification.findMany({
    where: {
      recipientUserId: { in: recipients.map((r) => r.id) },
      category: DIGEST_CATEGORY,
      createdAt: { gte: weekStart },
    },
    select: { recipientUserId: true },
  });
  const sentSet = new Set(alreadySent.map((n) => n.recipientUserId));
  const pending = recipients.filter((r) => !sentSet.has(r.id));
  if (pending.length === 0) return { sent: 0, skipped: 'already_sent' };

  const summary = await computeExecutiveSummary(prisma, now);
  const body = executiveDigestBody(summary);
  for (const r of pending) {
    await notifyUser(r.id, {
      subject: 'Your weekly executive digest',
      body,
      category: DIGEST_CATEGORY,
      linkUrl: '/',
    });
  }
  return { sent: pending.length };
}

let timer: NodeJS.Timeout | null = null;

export function startExecutiveDigestCron(): void {
  if (timer) return;
  void runExecutiveDigestSweep().catch((err) => {
    console.error('[alto-people/api] executive digest sweep failed:', err);
  });
  timer = setInterval(() => {
    void runExecutiveDigestSweep().catch((err) => {
      console.error('[alto-people/api] executive digest sweep failed:', err);
    });
  }, SWEEP_SECONDS * 1000);
  timer.unref();
  console.log(
    `[alto-people/api] executive digest cron armed (every ${SWEEP_SECONDS}s, sends Saturdays after ${SEND_AFTER_HOUR}:00 ${DEFAULT_TIMEZONE})`,
  );
}

export function stopExecutiveDigestCron(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
