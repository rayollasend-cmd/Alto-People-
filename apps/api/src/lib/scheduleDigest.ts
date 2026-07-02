// Daily schedule digest for admins — the Sling-style morning summary.
//
// Once per local day (after SCHEDULE_DIGEST_HOUR in the deployment
// timezone), every ACTIVE user whose role grants manage:scheduling gets
// one notification (bell + email + push, mute-aware via the "scheduling"
// bucket): every non-draft shift starting today, who's working it, and
// the headline counts (filled / open / unconfirmed / scheduled hours).
//
// Send-at-most-once is enforced by the digest's own IN_APP rows: the
// claim transaction takes an advisory lock, checks whether a
// schedule_digest row already exists for today, and writes ALL of
// today's IN_APP rows before releasing the lock — a competing sweep
// can't read "not sent" mid-send. Email/push fan out after commit.
//
// A day with zero shifts sends nothing AND claims nothing, so a
// schedule published later the same morning still gets its digest on
// the next sweep. That's deliberate: the digest fires as soon as there
// is something to report, not "empty report at 6am, silence after".

import type { PrismaClient } from '@prisma/client';
import { rolesWithCapability } from '@alto-people/shared';
import { prisma as defaultPrisma } from '../db.js';
import { env } from '../config/env.js';
import {
  DEFAULT_TIMEZONE,
  formatDateInZone,
  formatTimeInZone,
  zonedMinutes,
} from './timezone.js';
import { emailUserForCategory } from './notify.js';

const DIGEST_CATEGORY = 'schedule_digest';
// Bell/email bodies stay readable; past this the digest defers to the page.
const MAX_LISTED_SHIFTS = 60;

const SCHEDULING_ADMIN_ROLES = rolesWithCapability('manage:scheduling');

// One en-CA (YYYY-MM-DD) formatter per timezone, cached like timezone.ts.
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

export interface ScheduleDigestSweepResult {
  sent: boolean;
  recipients: number;
  shifts: number;
  /** Why nothing was sent (undefined when sent=true). */
  skipped?: 'disabled_hour' | 'already_sent' | 'no_shifts' | 'no_recipients';
}

interface DigestShift {
  position: string;
  clientName: string | null;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  status: string;
  associateName: string | null;
  unconfirmed: boolean;
}

function buildBody(shifts: DigestShift[], todayLabel: string): {
  subject: string;
  body: string;
} {
  const filled = shifts.filter((s) => s.status === 'ASSIGNED').length;
  const open = shifts.filter((s) => s.status === 'OPEN').length;
  const unconfirmed = shifts.filter((s) => s.unconfirmed).length;
  const hours =
    shifts.reduce(
      (sum, s) => sum + Math.max(0, s.endsAt.getTime() - s.startsAt.getTime()),
      0,
    ) / 3_600_000;

  const counts = [
    `${shifts.length} shift${shifts.length === 1 ? '' : 's'}`,
    `${filled} filled`,
    ...(open > 0 ? [`${open} open`] : []),
    ...(unconfirmed > 0 ? [`${unconfirmed} unconfirmed`] : []),
    `${hours.toFixed(1)}h scheduled`,
  ].join(' · ');

  // Group by client so multi-site admins can scan one site at a time.
  const byClient = new Map<string, DigestShift[]>();
  for (const s of shifts) {
    const key = s.clientName ?? 'Unassigned client';
    (byClient.get(key) ?? byClient.set(key, []).get(key)!).push(s);
  }

  const lines: string[] = [];
  let listed = 0;
  for (const [clientName, group] of byClient) {
    if (listed >= MAX_LISTED_SHIFTS) break;
    lines.push('', clientName);
    for (const s of group) {
      if (listed >= MAX_LISTED_SHIFTS) break;
      const range = `${formatTimeInZone(s.startsAt, s.timezone)}–${formatTimeInZone(s.endsAt, s.timezone)}`;
      const who =
        s.status === 'OPEN'
          ? 'OPEN — needs someone'
          : (s.associateName ?? '—') + (s.unconfirmed ? ' (unconfirmed)' : '');
      lines.push(`  ${range} · ${s.position} · ${who}`);
      listed++;
    }
  }
  if (shifts.length > listed) {
    lines.push('', `…and ${shifts.length - listed} more — see the full schedule.`);
  }

  return {
    subject: `Today's schedule — ${counts}`,
    body: `Schedule for ${todayLabel}\n${counts}\n${lines.join('\n')}`,
  };
}

export async function runScheduleDigestSweep(
  prisma: PrismaClient = defaultPrisma,
  now: Date = new Date(),
): Promise<ScheduleDigestSweepResult> {
  const tz = DEFAULT_TIMEZONE;
  const todayKey = dayKey(now, tz);
  const localHour = Math.floor(zonedMinutes(now, tz) / 60);
  if (localHour < env.SCHEDULE_DIGEST_HOUR) {
    return { sent: false, recipients: 0, shifts: 0, skipped: 'disabled_hour' };
  }

  // Generous UTC prefilter; exact membership is the LOCAL calendar day.
  const windowStart = new Date(now.getTime() - 36 * 3_600_000);
  const windowEnd = new Date(now.getTime() + 36 * 3_600_000);
  const rows = await prisma.shift.findMany({
    where: {
      status: { in: ['ASSIGNED', 'OPEN', 'COMPLETED'] },
      startsAt: { gte: windowStart, lte: windowEnd },
    },
    orderBy: [{ startsAt: 'asc' }],
    include: {
      client: { select: { name: true } },
      locationRel: { select: { timezone: true } },
      assignedAssociate: { select: { firstName: true, lastName: true } },
    },
  });
  const shifts: DigestShift[] = rows
    .filter((s) => dayKey(s.startsAt, tz) === todayKey)
    .map((s) => ({
      position: s.position,
      clientName: s.client?.name ?? null,
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      timezone: s.locationRel?.timezone ?? tz,
      status: s.status,
      associateName: s.assignedAssociate
        ? `${s.assignedAssociate.firstName} ${s.assignedAssociate.lastName}`
        : null,
      unconfirmed:
        s.status === 'ASSIGNED' && s.publishedAt !== null && s.acknowledgedAt === null,
    }));
  if (shifts.length === 0) {
    return { sent: false, recipients: 0, shifts: 0, skipped: 'no_shifts' };
  }

  const recipients = await prisma.user.findMany({
    where: { role: { in: SCHEDULING_ADMIN_ROLES }, status: 'ACTIVE' },
    select: { id: true, email: true },
  });
  if (recipients.length === 0) {
    return { sent: false, recipients: 0, shifts: shifts.length, skipped: 'no_recipients' };
  }

  const { subject, body } = buildBody(shifts, formatDateInZone(now, tz));

  // Claim + IN_APP writes in one advisory-locked transaction: a competing
  // sweep blocks on the lock, then sees today's rows and backs off.
  const claimed = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${DIGEST_CATEGORY}, 0))`;
    const last = await tx.notification.findFirst({
      where: { category: DIGEST_CATEGORY, channel: 'IN_APP' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (last && dayKey(last.createdAt, tz) === todayKey) return false;
    await tx.notification.createMany({
      data: recipients.map((u) => ({
        channel: 'IN_APP' as const,
        status: 'SENT' as const,
        recipientUserId: u.id,
        recipientEmail: u.email,
        subject,
        body,
        category: DIGEST_CATEGORY,
        linkUrl: '/scheduling',
        sentAt: now,
      })),
    });
    return true;
  });
  if (!claimed) {
    return { sent: false, recipients: 0, shifts: shifts.length, skipped: 'already_sent' };
  }

  // Email + push after commit — mute-aware ("scheduling" bucket), fire-and-
  // forget, never fails the sweep.
  for (const u of recipients) {
    if (!u.email) continue;
    void emailUserForCategory(u.id, u.email, {
      subject,
      body,
      category: DIGEST_CATEGORY,
      linkUrl: '/scheduling',
    });
  }
  return { sent: true, recipients: recipients.length, shifts: shifts.length };
}

let timer: NodeJS.Timeout | null = null;

export function startScheduleDigestCron(): void {
  if (timer) return;
  const seconds = env.SCHEDULE_DIGEST_INTERVAL_SECONDS;
  if (seconds <= 0) return;
  void runScheduleDigestSweep().catch((err) => {
    console.error('[alto-people/api] schedule digest sweep failed:', err);
  });
  timer = setInterval(() => {
    void runScheduleDigestSweep().catch((err) => {
      console.error('[alto-people/api] schedule digest sweep failed:', err);
    });
  }, seconds * 1000);
  timer.unref();
  console.log(
    `[alto-people/api] schedule digest cron armed (every ${seconds}s, sends after ${env.SCHEDULE_DIGEST_HOUR}:00 ${DEFAULT_TIMEZONE})`,
  );
}

export function stopScheduleDigestCron(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
