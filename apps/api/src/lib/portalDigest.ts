import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';
import { env } from '../config/env.js';
import { notifyUser } from './notify.js';
import { orgDateKey, utcInstantOfLocalMidnight } from './timeAnomalies.js';

/**
 * The morning note — the push side of the client portal.
 *
 * Once per org-day, after PORTAL_DIGEST_HOUR (default 6am org time), every
 * ACTIVE portal account gets one short message for its scope:
 *   - a store account: its store's today and tomorrow;
 *   - a market (client-wide) account: the whole client;
 *   - a region account: one roll-up, a line per store in the region.
 * Silent when nothing is scheduled today or tomorrow — a note that says
 * "nothing" is noise.
 *
 * Dedupe is "already told today": a digest row for this person created
 * since org midnight. Nothing technical leaks into the message itself.
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

type DayShift = { status: string; acknowledgedAt: Date | null };
type Counts = { tFilled: number; tOpen: number; mFilled: number; mOpen: number; mUnconfirmed: number; any: boolean };

function countsOf(today: DayShift[], tomorrow: DayShift[]): Counts {
  const tFilled = today.filter((s) => s.status !== 'OPEN').length;
  const mOpen = tomorrow.filter((s) => s.status === 'OPEN').length;
  return {
    tFilled,
    tOpen: today.length - tFilled,
    mFilled: tomorrow.length - mOpen,
    mOpen,
    mUnconfirmed: tomorrow.filter((s) => s.status === 'ASSIGNED' && s.acknowledgedAt === null).length,
    any: today.length + tomorrow.length > 0,
  };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

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
    where: {
      role: 'CLIENT_PORTAL',
      status: 'ACTIVE',
      deletedAt: null,
      OR: [{ clientId: { not: null } }, { regionId: { not: null } }],
    },
    select: {
      id: true,
      clientId: true,
      locationId: true,
      regionId: true,
      client: { select: { name: true } },
      location: { select: { name: true } },
      region: { select: { name: true } },
    },
    take: 500,
  });
  if (recipients.length === 0) return { sent: 0, skipped: 0, reason: 'no_recipients' };

  const shiftsFor = async (where: { clientId: string; locationId?: string }) => {
    const scope = {
      ...where,
      publishedAt: { not: null },
      status: { in: ['OPEN', 'ASSIGNED', 'COMPLETED'] as ('OPEN' | 'ASSIGNED' | 'COMPLETED')[] },
    };
    const [today, tomorrow] = await Promise.all([
      prisma.shift.findMany({
        where: { ...scope, startsAt: { lt: tomorrowStart }, endsAt: { gt: todayStart } },
        select: { status: true, acknowledgedAt: true },
        take: 2000,
      }),
      prisma.shift.findMany({
        where: { ...scope, startsAt: { gte: tomorrowStart, lt: dayAfterStart } },
        select: { status: true, acknowledgedAt: true },
        take: 2000,
      }),
    ]);
    return countsOf(today, tomorrow);
  };

  let sent = 0;
  let skipped = 0;
  for (const u of recipients) {
    const already = await prisma.notification.findFirst({
      where: { recipientUserId: u.id, category: CATEGORY, channel: 'IN_APP', createdAt: { gte: todayStart } },
      select: { id: true },
    });
    if (already) {
      skipped += 1;
      continue;
    }

    /* ---- region account: one roll-up, a line per store ------------------- */
    if (!u.clientId && u.regionId) {
      const stores = await prisma.location.findMany({
        where: { regionId: u.regionId, deletedAt: null, isActive: true },
        select: { id: true, name: true, clientId: true },
        orderBy: { name: 'asc' },
        take: 50,
      });
      const rows = await Promise.all(stores.map(async (s) => ({ store: s, c: await shiftsFor({ clientId: s.clientId, locationId: s.id }) })));
      const active = rows.filter((r) => r.c.any);
      if (active.length === 0) {
        skipped += 1;
        continue;
      }
      const openToday = active.reduce((a, r) => a + r.c.tOpen, 0);
      const openTomorrow = active.reduce((a, r) => a + r.c.mOpen, 0);
      const unconfirmed = active.reduce((a, r) => a + r.c.mUnconfirmed, 0);
      const risk = openToday + openTomorrow;
      const regionName = u.region?.name ?? 'Your region';
      const lines = active.map(
        ({ store, c }) =>
          `${store.name}: today ${c.tFilled} scheduled${c.tOpen > 0 ? `, ${c.tOpen} open` : ''}; tomorrow ${c.mFilled} filled${c.mOpen > 0 ? `, ${c.mOpen} open` : ''}${c.mUnconfirmed > 0 ? `, ${c.mUnconfirmed} unconfirmed` : ''}.`,
      );
      await notifyUser(
        u.id,
        {
          subject:
            risk > 0
              ? `${regionName}: ${plural(risk, 'open slot')} across ${plural(active.length, 'store')}`
              : unconfirmed > 0
                ? `${regionName}: staffed · ${unconfirmed} awaiting confirmation tomorrow`
                : `${regionName}: every store staffed and confirmed`,
          body: `${lines.join('\n')}\n\nYour command center has every store on one screen.`,
          category: CATEGORY,
          linkUrl: '/',
        },
        prisma,
      );
      sent += 1;
      continue;
    }

    /* ---- store or market account ---------------------------------------- */
    const c = await shiftsFor({ clientId: u.clientId!, ...(u.locationId ? { locationId: u.locationId } : {}) });
    if (!c.any) {
      skipped += 1;
      continue;
    }
    const storeName = u.location?.name ?? u.client?.name ?? 'your store';
    const todayLine =
      c.tFilled + c.tOpen === 0
        ? 'Nothing scheduled today.'
        : `Today: ${c.tFilled} on the schedule${c.tOpen > 0 ? `, ${c.tOpen} still open` : ' — fully staffed'}.`;
    const tomorrowLine =
      c.mFilled + c.mOpen === 0
        ? 'Nothing scheduled tomorrow.'
        : `Tomorrow: ${c.mFilled} filled${c.mOpen > 0 ? `, ${c.mOpen} open` : ''}${
            c.mUnconfirmed > 0 ? `, ${c.mUnconfirmed} awaiting confirmation` : ''
          }${c.mOpen === 0 && c.mUnconfirmed === 0 ? ' — all confirmed' : ''}.`;
    const risk = c.tOpen + c.mOpen;

    await notifyUser(
      u.id,
      {
        subject:
          risk > 0
            ? `${storeName}: ${plural(risk, 'open slot')} need cover`
            : c.mUnconfirmed > 0
              ? `${storeName}: staffed · ${c.mUnconfirmed} awaiting confirmation tomorrow`
              : `${storeName}: staffed and confirmed`,
        body:
          `${todayLine}\n${tomorrowLine}\n\n` +
          (risk > 0
            ? 'Need cover? Open the link and the request is pre-filled for the Workforce desk.'
            : "Your store site has the roster, the lead on site, and last night's checklist."),
        category: CATEGORY,
        // One tap from the email into a pre-filled staffing request.
        linkUrl:
          risk > 0
            ? `/portal/requests?new=STAFFING&subject=${encodeURIComponent(`Cover for ${plural(risk, 'open slot')} (${todayKey})`)}`
            : '/portal',
      },
      prisma,
    );
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
