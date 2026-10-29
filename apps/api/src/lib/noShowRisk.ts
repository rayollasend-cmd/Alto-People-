// No-show risk radar — prediction instead of reaction. Tomorrow's
// assigned shifts are scored against each holder's 90-day unexcused
// attendance record (no-call no-show ×2, call-out ×1, late ×0.5); a
// holder at 2.5+ points flags the shift as high-risk COVERAGE, the
// evening before, with suggested bench backups — so the 6 AM surprise
// gets pre-arranged out of existence the night before.

import type { Prisma, PrismaClient } from '@prisma/client';
import { tenantJob } from './tenantJobs.js';
import { currentTenantId } from './tenant.js';
import { prisma as defaultPrisma } from '../db.js';
import { benchFor } from './scope.js';
import { notifyUser } from './notify.js';
import { siteSupervisorRecipients, supervisorRecipients } from './shiftWindows.js';
import { orgDateKey, utcInstantOfLocalMidnight, companyWorkweek } from './timeAnomalies.js';
import { formatTimeInZone, addDaysToKey } from './timezone.js';
import { logger } from './logger.js';

const DAY_MS = 24 * 3600_000;
/** A holder at this many unexcused points in 90 days is high-risk (the radar and attendance.confirm). */
export const RISK_THRESHOLD = 2.5;
const CATEGORY = 'noshow_risk';
const SEND_AFTER_HOUR = 17;
const SWEEP_SECONDS = 60 * 60;

export interface RiskyShift {
  shiftId: string;
  /** Null for a direct employer's shift (Brief 2-1b). */
  clientId: string | null;
  clientName: string;
  /** The store — routes the row to the lead of its shift window. */
  locationId: string | null;
  position: string;
  startsAt: Date;
  /** The store's zone (null: the company's) — the time a digest line shows. */
  timezone: string | null;
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
  // Tomorrow on the company's calendar, midnight to midnight in its zone.
  const tz = companyWorkweek().timezone;
  const tomorrow = addDaysToKey(orgDateKey(now), 1);
  const dayStart = utcInstantOfLocalMidnight(tomorrow, tz);
  const dayEnd = utcInstantOfLocalMidnight(addDaysToKey(tomorrow, 1), tz);

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
      locationId: true,
      position: true,
      startsAt: true,
      locationRel: { select: { timezone: true } },
      client: { select: { name: true } },
      assignedAssociate: { select: { id: true, firstName: true, lastName: true } },
    },
    take: 500,
  });
  if (shifts.length === 0) return [];

  const holderIds = [...new Set(shifts.map((s) => s.assignedAssociate!.id))];
  const points = await attendancePoints(prisma, holderIds, now);
  return shifts
    .filter((s) => (points.get(s.assignedAssociate!.id) ?? 0) >= RISK_THRESHOLD)
    .map((s) => ({
      shiftId: s.id,
      clientId: s.clientId,
      locationId: s.locationId,
      clientName: s.client?.name ?? '',
      position: s.position,
      startsAt: s.startsAt,
      timezone: s.locationRel?.timezone ?? null,
      holderName: `${s.assignedAssociate!.firstName} ${s.assignedAssociate!.lastName}`,
      points: Math.round((points.get(s.assignedAssociate!.id) ?? 0) * 10) / 10,
    }));
}

/**
 * Each person's unexcused attendance points over the trailing 90 days:
 * no-call no-show 2, call-out 1, late (and anything else) 0.5. The one
 * scoring rule for the radar and the Workforce agent's attendance.confirm.
 */
export async function attendancePoints(
  prisma: Pick<PrismaClient, 'attendanceEvent'>,
  associateIds: readonly string[],
  now: Date,
): Promise<Map<string, number>> {
  const points = new Map<string, number>();
  if (!associateIds.length) return points;
  const events = await prisma.attendanceEvent.findMany({
    where: {
      associateId: { in: [...associateIds] },
      excusedAt: null,
      occurredOn: { gte: new Date(now.getTime() - 90 * DAY_MS) },
    },
    select: { associateId: true, kind: true },
    take: 5_000,
  });
  for (const e of events) {
    const p =
      e.kind === 'NO_CALL_NO_SHOW' ? 2 : e.kind === 'CALL_OUT' ? 1 : e.kind === 'LATE' ? 0.5 : 0.5;
    points.set(e.associateId, (points.get(e.associateId) ?? 0) + p);
  }
  return points;
}

/** Bench suggestions for a desk: active-approved, on the shift's bench
 *  (the client's people, or for a direct employer the site's), no shift
 *  tomorrow. */
async function suggestBackups(prisma: PrismaClient, bench: Prisma.AssociateWhereInput, dayStart: Date, dayEnd: Date) {
  const rows = await prisma.associate.findMany({
    where: {
      deletedAt: null,
      erasedAt: null,
      separatedAt: null,
      deactivatedAt: null,
      // On the shift's bench now (lib/scope.benchFor) — a transfer moves them.
      AND: [bench],
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
      timeZone: companyWorkweek().timezone,
      hour: 'numeric',
      hour12: false,
    }).format(now),
  );
  if (hour < SEND_AFTER_HOUR) return { sent: 0, skipped: 'too_early' };

  const risky = await computeNoShowRisk(prisma, now, null);
  if (risky.length === 0) return { sent: 0, skipped: 'no_risk' };

  // Once per org-local day: the day's first send claims it.
  const dayStart = utcInstantOfLocalMidnight(orgDateKey(now), companyWorkweek().timezone);
  const already = await prisma.notification.findFirst({
    // Per tenant: one tenant's evening send must not mark another's as done.
    where: { category: CATEGORY, createdAt: { gte: dayStart }, ...(currentTenantId() ? { tenantId: currentTenantId()! } : {}) },
    select: { id: true },
  });
  if (already) return { sent: 0, skipped: 'already_sent' };

  // One desk per client, as before; Brief 2-1b: a client-less shift (a
  // direct employer) goes to its site's desk; a shift with neither has no
  // desk and reaches nobody (fail closed — never every admin).
  type Desk = { clientId: string | null; locationId: string | null; rows: RiskyShift[] };
  const desks = new Map<string, Desk>();
  for (const r of risky) {
    const key = r.clientId ? `client:${r.clientId}` : r.locationId ? `site:${r.locationId}` : null;
    if (!key) continue;
    const desk = desks.get(key) ?? desks.set(key, { clientId: r.clientId, locationId: r.clientId ? null : r.locationId, rows: [] }).get(key)!;
    desk.rows.push(r);
  }
  let sent = 0;
  for (const desk of desks.values()) {
    const { clientId, locationId } = desk;
    // Each supervisor's digest holds the risky shifts in the windows they
    // lead — or every row nobody leads (lib/shiftWindows routing).
    const rowsBySupervisor = new Map<string, RiskyShift[]>();
    for (const r of desk.rows) {
      const recipients = clientId
        ? await supervisorRecipients(prisma, clientId, { locationId: r.locationId, startsAt: r.startsAt })
        : await siteSupervisorRecipients(prisma, locationId!, { startsAt: r.startsAt });
      for (const s of recipients) {
        (rowsBySupervisor.get(s.id) ?? rowsBySupervisor.set(s.id, []).get(s.id)!).push(r);
      }
    }
    if (rowsBySupervisor.size === 0) continue;
    const bench = benchFor({ clientId, locationId });
    if (!bench) continue;
    const dStart = utcInstantOfLocalMidnight(addDaysToKey(orgDateKey(now), 1), companyWorkweek().timezone);
    const backups = await suggestBackups(
      prisma,
      bench,
      dStart,
      new Date(dStart.getTime() + 26 * 3600_000),
    );
    // The desk's name in the digest: the client's, or the site's for a direct employer.
    const deskName = clientId
      ? desk.rows[0].clientName
      : ((await prisma.site.findFirst({ where: { id: locationId! }, select: { name: true } }))?.name ?? '');
    const linkUrl = clientId ? '/scheduling' : `/scheduling?location=${encodeURIComponent(locationId!)}`;
    for (const [supervisorId, rows] of rowsBySupervisor) {
      const lines = rows
        .map(
          (r) =>
            `${formatTimeInZone(r.startsAt, r.timezone ?? companyWorkweek().timezone)} ${r.position} — held by ${r.holderName} (${r.points} attendance points, 90d)`,
        )
        .join('\n');
      const body = `Tomorrow's coverage risk at ${deskName}:\n${lines}${backups.length > 0 ? `\n\nAvailable backups: ${backups.join(', ')}` : ''}\n\nWorth a confirmation text tonight or a pre-arranged backup.`;
      await notifyUser(supervisorId, {
        subject: `Tomorrow's coverage risk — ${rows.length} shift${rows.length === 1 ? '' : 's'}`,
        body,
        category: CATEGORY,
        linkUrl,
      });
      sent += 1;
    }
  }
  return { sent };
}

let timer: NodeJS.Timeout | null = null;

export function startNoShowRiskCron(): void {
  if (timer) return;
  void tenantJob('noShowRisk', runNoShowRiskSweep, { module: 'scheduling' })().catch((err) => {
    console.error('[alto-people/api] no-show risk sweep failed:', err);
  });
  timer = setInterval(() => {
    void tenantJob('noShowRisk', runNoShowRiskSweep, { module: 'scheduling' })().catch((err) => {
      console.error('[alto-people/api] no-show risk sweep failed:', err);
    });
  }, SWEEP_SECONDS * 1000);
  timer.unref();
  logger.info(
    `no-show risk cron armed (hourly, sends evenings after ${SEND_AFTER_HOUR}:00 company time)`,
  );
}

export function stopNoShowRiskCron(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
