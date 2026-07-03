// Associate week-ahead digest — "here's your week" the evening before
// each client's scheduling week begins.
//
// The week is a CLIENT concept (Client.weekStartsOn, 0=Sun…6=Sat: some
// clients run Sun–Sat weeks, others Wed–Tue). After WEEK_AHEAD_SEND_HOUR
// local time, the sweep looks at clients whose week starts TOMORROW,
// collects every published assigned shift in that client's coming week
// [tomorrow 00:00, +7d), groups by associate, and sends each associate
// one digest (bell + email + push via the scheduling mute bucket).
//
// Send-once: same claim pattern as the admin daily digest — an advisory
// lock plus the digest's own IN_APP rows written inside the claim
// transaction, keyed per user per local send-day (a user gets at most
// one week-ahead per day; multi-client associates whose clients share a
// week start get ONE combined digest, and clients with different week
// starts alert on different evenings by design).

import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';
import { env } from '../config/env.js';
import {
  DEFAULT_TIMEZONE,
  formatDateInZone,
  formatTimeInZone,
  zonedDayOfWeek,
  zonedMinutes,
} from './timezone.js';
import { emailUserForCategory } from './notify.js';
import { emitLiveEvent } from './liveEvents.js';

const DIGEST_CATEGORY = 'week_ahead';
const MAX_LINES = 20;

// One en-CA (YYYY-MM-DD) formatter per timezone (same pattern as the
// admin daily digest).
const dayKeyCache = new Map<string, Intl.DateTimeFormat>();
function dayKey(date: Date, timeZone: string): string {
  let fmt = dayKeyCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dayKeyCache.set(timeZone, fmt);
  }
  return fmt.format(date);
}

export interface WeekAheadSweepResult {
  sent: number;
  shifts: number;
  skipped?: 'before_hour' | 'no_shifts';
}

interface DigestShift {
  position: string;
  clientName: string | null;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
}

function buildBody(shifts: DigestShift[], tz: string): { subject: string; body: string } {
  const lines = shifts
    .slice(0, MAX_LINES)
    .map(
      (s) =>
        `${formatDateInZone(s.startsAt, s.timezone)} · ${formatTimeInZone(s.startsAt, s.timezone)}–${formatTimeInZone(s.endsAt, s.timezone)} · ${s.position}${s.clientName ? ` at ${s.clientName}` : ''}`,
    );
  if (shifts.length > MAX_LINES) {
    lines.push(`…and ${shifts.length - MAX_LINES} more — see your schedule.`);
  }
  const hours =
    shifts.reduce(
      (sum, s) => sum + Math.max(0, s.endsAt.getTime() - s.startsAt.getTime()),
      0,
    ) / 3_600_000;
  const first = shifts[0];
  return {
    subject: `Your week ahead — ${shifts.length} shift${shifts.length === 1 ? '' : 's'} · ${hours.toFixed(1)}h`,
    body: `Your week starting ${formatDateInZone(first.startsAt, tz)}:\n\n${lines.join('\n')}`,
  };
}

export async function runWeekAheadSweep(
  prisma: PrismaClient = defaultPrisma,
  now: Date = new Date(),
): Promise<WeekAheadSweepResult> {
  const tz = DEFAULT_TIMEZONE;
  const localHour = Math.floor(zonedMinutes(now, tz) / 60);
  if (localHour < env.WEEK_AHEAD_SEND_HOUR) {
    return { sent: 0, shifts: 0, skipped: 'before_hour' };
  }

  // Tomorrow's local day-of-week — the clients whose week starts then.
  const tomorrowProbe = new Date(now.getTime() + 24 * 3_600_000);
  const tomorrowDow = zonedDayOfWeek(tomorrowProbe, tz);
  const todayKey = dayKey(now, tz);

  // Published assigned shifts at those clients in a generous UTC window,
  // trimmed to the exact 7 local days starting tomorrow.
  const windowStart = now;
  const windowEnd = new Date(now.getTime() + 9 * 24 * 3_600_000);
  const rows = await prisma.shift.findMany({
    where: {
      status: 'ASSIGNED',
      publishedAt: { not: null },
      assignedAssociateId: { not: null },
      client: { is: { weekStartsOn: tomorrowDow } },
      startsAt: { gte: windowStart, lt: windowEnd },
    },
    orderBy: { startsAt: 'asc' },
    include: {
      client: { select: { name: true } },
      locationRel: { select: { timezone: true } },
    },
  });

  const weekKeys = new Set<string>();
  for (let i = 1; i <= 7; i++) {
    weekKeys.add(dayKey(new Date(now.getTime() + i * 24 * 3_600_000), tz));
  }
  const inWeek = rows.filter((s) => weekKeys.has(dayKey(s.startsAt, tz)));
  if (inWeek.length === 0) {
    return { sent: 0, shifts: 0, skipped: 'no_shifts' };
  }

  const byAssociate = new Map<string, DigestShift[]>();
  for (const s of inWeek) {
    const arr = byAssociate.get(s.assignedAssociateId!) ?? [];
    arr.push({
      position: s.position,
      clientName: s.client?.name ?? null,
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      timezone: s.locationRel?.timezone ?? tz,
    });
    byAssociate.set(s.assignedAssociateId!, arr);
  }

  const users = await prisma.user.findMany({
    where: {
      associateId: { in: [...byAssociate.keys()] },
      status: 'ACTIVE',
    },
    select: { id: true, email: true, associateId: true },
  });

  let sent = 0;
  for (const u of users) {
    const shifts = byAssociate.get(u.associateId!);
    if (!shifts) continue;
    const { subject, body } = buildBody(shifts, tz);

    // Claim: one week-ahead per user per local send-day, decided and
    // written inside an advisory-locked transaction so overlapping
    // sweeps can't double-send.
    const claimed = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`week_ahead:${u.id}`}, 0))`;
      const last = await tx.notification.findFirst({
        where: {
          category: DIGEST_CATEGORY,
          channel: 'IN_APP',
          recipientUserId: u.id,
        },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      if (last && dayKey(last.createdAt, tz) === todayKey) return false;
      await tx.notification.create({
        data: {
          channel: 'IN_APP',
          status: 'SENT',
          recipientUserId: u.id,
          recipientEmail: u.email,
          subject,
          body,
          category: DIGEST_CATEGORY,
          linkUrl: '/scheduling',
          sentAt: now,
        },
      });
      return true;
    });
    if (!claimed) continue;

    emitLiveEvent(u.id, 'notification');
    void emailUserForCategory(u.id, u.email, {
      subject,
      body,
      category: DIGEST_CATEGORY,
      linkUrl: '/scheduling',
    });
    sent++;
  }

  return { sent, shifts: inWeek.length };
}

let timer: NodeJS.Timeout | null = null;

export function startWeekAheadCron(): void {
  if (timer) return;
  const seconds = env.WEEK_AHEAD_INTERVAL_SECONDS;
  if (seconds <= 0) return;
  void runWeekAheadSweep().catch((err) => {
    console.error('[alto-people/api] week-ahead sweep failed:', err);
  });
  timer = setInterval(() => {
    void runWeekAheadSweep().catch((err) => {
      console.error('[alto-people/api] week-ahead sweep failed:', err);
    });
  }, seconds * 1000);
  timer.unref();
  console.log(
    `[alto-people/api] week-ahead cron armed (every ${seconds}s, sends after ${env.WEEK_AHEAD_SEND_HOUR}:00 ${DEFAULT_TIMEZONE} the evening before each client's week)`,
  );
}

export function stopWeekAheadCron(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
