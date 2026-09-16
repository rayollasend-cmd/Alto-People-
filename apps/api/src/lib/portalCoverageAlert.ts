import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';
import { env } from '../config/env.js';
import { notifyUser } from './notify.js';
import { orgDateKey, utcInstantOfLocalMidnight } from './timeAnomalies.js';
import { formatTimeInZone } from './timezone.js';

/**
 * "Your 6am wave is 2 short and it's 6:15" — a push, not a dashboard state.
 *
 * Every few minutes: for every client with portal accounts, find waves
 * (same start + end) that started more than the grace period ago and
 * are still running, count assigned people with no punch on record and
 * slots still unfilled, and if the wave is short ring the store's portal
 * accounts (store-scoped ones only for their store) and the client's
 * shift supervisors — once per wave per org-day. A wave that recovers
 * never rings again; one that stays short rang once already.
 */

const CATEGORY = 'portal.coverage';
const ORG_TZ = 'America/New_York';

export interface CoverageAlertResult {
  waves: number;
  rung: number;
}

export async function runPortalCoverageAlertSweep(
  prisma: PrismaClient = defaultPrisma,
  now: Date = new Date(),
): Promise<CoverageAlertResult> {
  const grace = env.PORTAL_COVERAGE_ALERT_GRACE_MINUTES * 60_000;
  const cutoff = new Date(now.getTime() - grace);
  const dayKey = orgDateKey(now);
  const dayStart = utcInstantOfLocalMidnight(dayKey, ORG_TZ);

  const portalUsers = await prisma.user.findMany({
    where: { role: 'CLIENT_PORTAL', status: 'ACTIVE', deletedAt: null, clientId: { not: null } },
    select: { id: true, clientId: true, locationId: true },
    take: 500,
  });
  if (portalUsers.length === 0) return { waves: 0, rung: 0 };
  const clientIds = [...new Set(portalUsers.map((u) => u.clientId!))];

  // Waves under way: started ≥ grace ago, not yet ended.
  const shifts = await prisma.shift.findMany({
    where: {
      clientId: { in: clientIds },
      publishedAt: { not: null },
      status: { in: ['OPEN', 'ASSIGNED'] },
      startsAt: { lte: cutoff, gte: new Date(now.getTime() - 16 * 3_600_000) },
      endsAt: { gt: now },
    },
    select: {
      id: true,
      clientId: true,
      locationId: true,
      startsAt: true,
      endsAt: true,
      status: true,
      assignedAssociateId: true,
      client: { select: { name: true } },
      locationRel: { select: { name: true, timezone: true } },
    },
    take: 5000,
  });
  if (shifts.length === 0) return { waves: 0, rung: 0 };

  // Punch evidence: a live or completed entry linked to the shift, or by
  // the assigned associate overlapping it.
  const entries = await prisma.timeEntry.findMany({
    where: {
      clientId: { in: clientIds },
      status: { in: ['ACTIVE', 'COMPLETED', 'APPROVED'] },
      clockInAt: { gte: new Date(now.getTime() - 24 * 3_600_000) },
    },
    select: { shiftId: true, associateId: true, clockInAt: true, clockOutAt: true },
    take: 20000,
  });
  const byShift = new Set(entries.map((e) => e.shiftId).filter(Boolean));
  const byAssociate = new Map<string, typeof entries>();
  for (const e of entries) {
    const list = byAssociate.get(e.associateId) ?? [];
    list.push(e);
    byAssociate.set(e.associateId, list);
  }
  const punched = (s: (typeof shifts)[number]) =>
    byShift.has(s.id) ||
    (!!s.assignedAssociateId &&
      (byAssociate.get(s.assignedAssociateId) ?? []).some(
        (e) => e.clockInAt < s.endsAt && (e.clockOutAt ?? now) > s.startsAt,
      ));

  // Group into waves per client + location.
  const waves = new Map<
    string,
    {
      clientId: string;
      clientName: string;
      locationId: string | null;
      locationName: string | null;
      timezone: string;
      startsAt: Date;
      endsAt: Date;
      expected: number;
      present: number;
      open: number;
    }
  >();
  for (const s of shifts) {
    const key = `${s.clientId}|${s.locationId ?? ''}|${s.startsAt.toISOString()}|${s.endsAt.toISOString()}`;
    let w = waves.get(key);
    if (!w) {
      w = {
        clientId: s.clientId,
        clientName: s.client.name,
        locationId: s.locationId,
        locationName: s.locationRel?.name ?? null,
        timezone: s.locationRel?.timezone ?? ORG_TZ,
        startsAt: s.startsAt,
        endsAt: s.endsAt,
        expected: 0,
        present: 0,
        open: 0,
      };
      waves.set(key, w);
    }
    if (s.status === 'OPEN') {
      w.open += 1;
      continue;
    }
    w.expected += 1;
    if (punched(s)) w.present += 1;
  }

  let rung = 0;
  for (const [key, w] of waves) {
    const short = w.expected - w.present + w.open;
    if (short <= 0) continue;
    const linkUrl = `/portal/today?date=${dayKey}#${encodeURIComponent(key)}`;
    const already = await prisma.notification.findFirst({
      where: { category: CATEGORY, linkUrl, createdAt: { gte: dayStart } },
      select: { id: true },
    });
    if (already) continue;

    const storeName = w.locationName ?? w.clientName;
    const startLabel = formatTimeInZone(w.startsAt, w.timezone);
    const subject = `${storeName}: the ${startLabel} wave is ${short} short`;
    const body =
      `${w.present} of ${w.expected} expected are on the floor for the ${startLabel} shift` +
      (w.open > 0 ? `, and ${w.open} slot${w.open === 1 ? '' : 's'} ${w.open === 1 ? 'is' : 'are'} unfilled` : '') +
      `. Alto's supervisors have been alerted too. Open Today to see who is in.`;

    const recipients = new Set<string>();
    for (const u of portalUsers) {
      if (u.clientId !== w.clientId) continue;
      if (u.locationId && w.locationId && u.locationId !== w.locationId) continue;
      recipients.add(u.id);
    }
    const sups = await prisma.user.findMany({
      where: {
        clientId: w.clientId,
        status: 'ACTIVE',
        deletedAt: null,
        role: { in: ['SHIFT_SUPERVISOR', 'WORKFORCE_MANAGER'] },
      },
      select: { id: true },
      take: 50,
    });
    for (const s of sups) recipients.add(s.id);
    await Promise.all(
      [...recipients].map((id) => notifyUser(id, { subject, body, category: CATEGORY, linkUrl }, prisma)),
    );
    rung += recipients.size;
  }
  return { waves: waves.size, rung };
}

let timer: NodeJS.Timeout | null = null;

export function startPortalCoverageAlertCron(): void {
  if (timer) return;
  const seconds = env.PORTAL_COVERAGE_ALERT_INTERVAL_SECONDS;
  if (seconds <= 0) return;
  const run = () => {
    void runPortalCoverageAlertSweep().catch((err) => {
      console.error('[alto-people/api] portal coverage alert sweep failed:', err);
    });
  };
  run();
  timer = setInterval(run, seconds * 1000);
  timer.unref();
  console.log(
    `[alto-people/api] portal coverage alert cron armed (every ${seconds}s; ${env.PORTAL_COVERAGE_ALERT_GRACE_MINUTES} min grace)`,
  );
}

export function stopPortalCoverageAlertCron(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
