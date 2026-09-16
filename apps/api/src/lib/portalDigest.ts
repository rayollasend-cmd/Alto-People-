import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';
import { env } from '../config/env.js';
import { notifyUser } from './notify.js';
import { orgDateKey, utcInstantOfLocalMidnight } from './timeAnomalies.js';

/**
 * The store manager's morning note — the push side of the client portal.
 *
 * Once per org-day, after PORTAL_DIGEST_HOUR (default 6am org time), every
 * ACTIVE CLIENT_PORTAL account gets one short message for THEIR scope
 * (store when provisioned, else the whole client): today's headcount and
 * open slots, tomorrow's open and unconfirmed slots, and a link to the
 * portal. Silent when nothing is scheduled today or tomorrow — a note
 * that says "nothing" is noise.
 *
 * Dedup is a Notification-row check on category + the day key in the
 * body, per recipient — the same convention the other once-per-day
 * sweeps use.
 */

const CATEGORY = 'portal.digest';
const ORG_TZ = 'America/New_York';

const HOUR_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: ORG_TZ,
  hour: 'numeric',
  hour12: false,
});

function nextKey(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

export interface PortalDigestResult {
  sent: number;
  skipped: number;
  reason?: 'before_send_hour' | 'no_recipients';
}

export async function runPortalDigestSweep(
  prisma: PrismaClient = defaultPrisma,
  now: Date = new Date(),
): Promise<PortalDigestResult> {
  if (Number(HOUR_FMT.format(now)) < env.PORTAL_DIGEST_HOUR) {
    return { sent: 0, skipped: 0, reason: 'before_send_hour' };
  }
  const todayKey = orgDateKey(now);
  const todayStart = utcInstantOfLocalMidnight(todayKey, ORG_TZ);
  const tomorrowStart = utcInstantOfLocalMidnight(nextKey(todayKey, 1), ORG_TZ);
  const dayAfterStart = utcInstantOfLocalMidnight(nextKey(todayKey, 2), ORG_TZ);

  const recipients = await prisma.user.findMany({
    where: { role: 'CLIENT_PORTAL', status: 'ACTIVE', deletedAt: null, clientId: { not: null } },
    select: {
      id: true,
      clientId: true,
      locationId: true,
      client: { select: { name: true } },
      location: { select: { name: true } },
    },
    take: 500,
  });
  if (recipients.length === 0) return { sent: 0, skipped: 0, reason: 'no_recipients' };

  let sent = 0;
  let skipped = 0;
  for (const u of recipients) {
    const already = await prisma.notification.findFirst({
      where: {
        recipientUserId: u.id,
        category: CATEGORY,
        body: { contains: `[${todayKey}]` },
        createdAt: { gte: new Date(now.getTime() - 36 * 3_600_000) },
      },
      select: { id: true },
    });
    if (already) {
      skipped += 1;
      continue;
    }
    const scope = {
      clientId: u.clientId!,
      publishedAt: { not: null },
      status: { in: ['OPEN', 'ASSIGNED', 'COMPLETED'] as ('OPEN' | 'ASSIGNED' | 'COMPLETED')[] },
      ...(u.locationId ? { locationId: u.locationId } : {}),
    };
    const [today, tomorrow] = await Promise.all([
      prisma.shift.findMany({
        where: { ...scope, startsAt: { lt: tomorrowStart }, endsAt: { gt: todayStart } },
        select: { status: true, acknowledgedAt: true },
        take: 1000,
      }),
      prisma.shift.findMany({
        where: { ...scope, startsAt: { gte: tomorrowStart, lt: dayAfterStart } },
        select: { status: true, acknowledgedAt: true },
        take: 1000,
      }),
    ]);
    if (today.length === 0 && tomorrow.length === 0) {
      skipped += 1;
      continue;
    }
    const storeName = u.location?.name ?? u.client?.name ?? 'your store';
    const tFilled = today.filter((s) => s.status !== 'OPEN').length;
    const tOpen = today.length - tFilled;
    const mOpen = tomorrow.filter((s) => s.status === 'OPEN').length;
    const mUnconfirmed = tomorrow.filter(
      (s) => s.status === 'ASSIGNED' && s.acknowledgedAt === null,
    ).length;
    const mFilled = tomorrow.length - mOpen;

    const todayLine =
      today.length === 0
        ? 'Nothing scheduled today.'
        : `Today: ${tFilled} on the schedule${tOpen > 0 ? `, ${tOpen} still open` : ' — fully staffed'}.`;
    const tomorrowLine =
      tomorrow.length === 0
        ? 'Nothing scheduled tomorrow.'
        : `Tomorrow: ${mFilled} filled${mOpen > 0 ? `, ${mOpen} open` : ''}${
            mUnconfirmed > 0 ? `, ${mUnconfirmed} awaiting confirmation` : ''
          }${mOpen === 0 && mUnconfirmed === 0 ? ' — all confirmed' : ''}.`;
    const risk = tOpen + mOpen;

    await notifyUser(u.id, {
      subject:
        risk > 0
          ? `${storeName}: ${risk} open slot${risk === 1 ? '' : 's'} need cover`
          : `${storeName}: staffed and confirmed`,
      body: `${todayLine}\n${tomorrowLine}\n\nYour live store view has the roster, the lead on site, and last night's checklist. [${todayKey}]`,
      category: CATEGORY,
      linkUrl: '/portal',
    });
    sent += 1;
  }
  return { sent, skipped };
}

let timer: NodeJS.Timeout | null = null;

export function startPortalDigestCron(): void {
  if (timer) return;
  const seconds = env.PORTAL_DIGEST_INTERVAL_SECONDS;
  if (seconds <= 0) return;
  const run = () => {
    void runPortalDigestSweep().catch((err) => {
      console.error('[alto-people/api] portal digest sweep failed:', err);
    });
  };
  run();
  timer = setInterval(run, seconds * 1000);
  timer.unref();
  console.log(
    `[alto-people/api] portal digest cron armed (every ${seconds}s; sends after ${env.PORTAL_DIGEST_HOUR}:00 org time)`,
  );
}

export function stopPortalDigestCron(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
