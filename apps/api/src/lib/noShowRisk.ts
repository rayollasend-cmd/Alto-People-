// No-show risk radar — prediction instead of reaction. Tomorrow's
// assigned shifts are scored against each holder's 90-day unexcused
// attendance record (no-call no-show ×2, call-out ×1, late ×0.5); a
// holder at 2.5+ points flags the shift as high-risk COVERAGE, the
// evening before, with suggested bench backups — so the 6 AM surprise
// gets pre-arranged out of existence the night before.

import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';
import { notifyUser } from './notify.js';
import { orgDateKey, utcInstantOfLocalMidnight } from './timeAnomalies.js';
import { DEFAULT_TIMEZONE, formatTimeInZone } from './timezone.js';

const DAY_MS = 24 * 3600_000;
const RISK_THRESHOLD = 2.5;
const CATEGORY = 'noshow_risk';
const SEND_AFTER_HOUR = 17;
const SWEEP_SECONDS = 60 * 60;

export interface RiskyShift {
  shiftId: string;
  clientId: string;
  clientName: string;
  position: string;
  startsAt: Date;
  holderName: string;
  points: number;
}

/** Tomorrow's (org-local) assigned shifts held by high-risk attendees.
 *  clientId clamps for site-scoped callers; null = org-wide. */
export async function computeNoShowRisk(
  prisma: PrismaClient,
  now: Date,
  clientId: string | null,
): Promise<RiskyShift[]> {
  const todayKey = orgDateKey(now);
  const t = new Date(`${todayKey}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  const dayStart = utcInstantOfLocalMidnight(t.toISOString().slice(0, 10), 'America/New_York');
  t.setUTCDate(t.getUTCDate() + 1);
  const dayEnd = utcInstantOfLocalMidnight(t.toISOString().slice(0, 10), 'America/New_York');

  const shifts = await prisma.shift.findMany({
    where: {
      publishedAt: { not: null },
      status: { notIn: ['CANCELLED', 'DRAFT'] },
      assignedAssociateId: { not: null },
      startsAt: { gte: dayStart, lt: dayEnd },
      ...(clientId ? { clientId } : {}),
    },
    select: {
      id: true,
      clientId: true,
      position: true,
      startsAt: true,
      client: { select: { name: true } },
      assignedAssociate: { select: { id: true, firstName: true, lastName: true } },
    },
    take: 500,
  });
  if (shifts.length === 0) return [];

  const holderIds = [...new Set(shifts.map((s) => s.assignedAssociate!.id))];
  const events = await prisma.attendanceEvent.findMany({
    where: {
      associateId: { in: holderIds },
      excusedAt: null,
      occurredOn: { gte: new Date(now.getTime() - 90 * DAY_MS) },
    },
    select: { associateId: true, kind: true },
    take: 5_000,
  });
  const points = new Map<string, number>();
  for (const e of events) {
    const p =
      e.kind === 'NO_CALL_NO_SHOW' ? 2 : e.kind === 'CALL_OUT' ? 1 : e.kind === 'LATE' ? 0.5 : 0.5;
    points.set(e.associateId, (points.get(e.associateId) ?? 0) + p);
  }
  return shifts
    .filter((s) => (points.get(s.assignedAssociate!.id) ?? 0) >= RISK_THRESHOLD)
    .map((s) => ({
      shiftId: s.id,
      clientId: s.clientId,
      clientName: s.client.name,
      position: s.position,
      startsAt: s.startsAt,
      holderName: `${s.assignedAssociate!.firstName} ${s.assignedAssociate!.lastName}`,
      points: Math.round((points.get(s.assignedAssociate!.id) ?? 0) * 10) / 10,
    }));
}

/** Bench suggestions for a client: active-approved, placed there, no
 *  shift tomorrow. */
async function suggestBackups(prisma: PrismaClient, clientId: string, dayStart: Date, dayEnd: Date) {
  const rows = await prisma.associate.findMany({
    where: {
      deletedAt: null,
      erasedAt: null,
      separatedAt: null,
      deactivatedAt: null,
      OR: [
        { assignments: { some: { endedAt: null, location: { clientId } } } },
        { applications: { some: { status: 'APPROVED', deletedAt: null, clientId } } },
      ],
      assignedShifts: {
        none: {
          status: { notIn: ['CANCELLED'] },
          startsAt: { gte: dayStart, lt: dayEnd },
        },
      },
    },
    select: { firstName: true, lastName: true },
    take: 3,
  });
  return rows.map((a) => `${a.firstName} ${a.lastName}`);
}

export interface NoShowRiskResult {
  sent: number;
  skipped?: 'too_early' | 'already_sent' | 'no_risk';
}

export async function runNoShowRiskSweep(
  prisma: PrismaClient = defaultPrisma,
  now: Date = new Date(),
): Promise<NoShowRiskResult> {
  const hour = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: DEFAULT_TIMEZONE,
      hour: 'numeric',
      hour12: false,
    }).format(now),
  );
  if (hour < SEND_AFTER_HOUR) return { sent: 0, skipped: 'too_early' };

  const risky = await computeNoShowRisk(prisma, now, null);
  if (risky.length === 0) return { sent: 0, skipped: 'no_risk' };

  // Once per org-local day: the day's first send claims it.
  const dayStart = utcInstantOfLocalMidnight(orgDateKey(now), 'America/New_York');
  const already = await prisma.notification.findFirst({
    where: { category: CATEGORY, createdAt: { gte: dayStart } },
    select: { id: true },
  });
  if (already) return { sent: 0, skipped: 'already_sent' };

  const byClient = new Map<string, RiskyShift[]>();
  for (const r of risky) {
    (byClient.get(r.clientId) ?? byClient.set(r.clientId, []).get(r.clientId)!).push(r);
  }
  let sent = 0;
  for (const [clientId, rows] of byClient) {
    const supervisors = await prisma.user.findMany({
      where: {
        role: 'SHIFT_SUPERVISOR',
        status: 'ACTIVE',
        deletedAt: null,
        clientId,
      },
      select: { id: true },
      take: 10,
    });
    if (supervisors.length === 0) continue;
    const t = new Date(`${orgDateKey(now)}T12:00:00Z`);
    t.setUTCDate(t.getUTCDate() + 1);
    const dStart = utcInstantOfLocalMidnight(t.toISOString().slice(0, 10), 'America/New_York');
    const backups = await suggestBackups(
      prisma,
      clientId,
      dStart,
      new Date(dStart.getTime() + 26 * 3600_000),
    );
    const lines = rows
      .map(
        (r) =>
          `${formatTimeInZone(r.startsAt, DEFAULT_TIMEZONE)} ${r.position} — held by ${r.holderName} (${r.points} attendance points, 90d)`,
      )
      .join('\n');
    const body = `Tomorrow's coverage risk at ${rows[0].clientName}:\n${lines}${backups.length > 0 ? `\n\nAvailable backups: ${backups.join(', ')}` : ''}\n\nWorth a confirmation text tonight or a pre-arranged backup.`;
    for (const s of supervisors) {
      await notifyUser(s.id, {
        subject: `Tomorrow's coverage risk — ${rows.length} shift${rows.length === 1 ? '' : 's'}`,
        body,
        category: CATEGORY,
        linkUrl: '/scheduling',
      });
      sent += 1;
    }
  }
  return { sent };
}

let timer: NodeJS.Timeout | null = null;

export function startNoShowRiskCron(): void {
  if (timer) return;
  void runNoShowRiskSweep().catch((err) => {
    console.error('[alto-people/api] no-show risk sweep failed:', err);
  });
  timer = setInterval(() => {
    void runNoShowRiskSweep().catch((err) => {
      console.error('[alto-people/api] no-show risk sweep failed:', err);
    });
  }, SWEEP_SECONDS * 1000);
  timer.unref();
  console.log(
    `[alto-people/api] no-show risk cron armed (hourly, sends evenings after ${SEND_AFTER_HOUR}:00 ${DEFAULT_TIMEZONE})`,
  );
}

export function stopNoShowRiskCron(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
