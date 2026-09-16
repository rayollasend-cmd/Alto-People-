import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';
import { env } from '../config/env.js';
import { notifyUser } from './notify.js';
import { orgDateKey } from './timeAnomalies.js';
import { formatTimeInZone } from './timezone.js';

/**
 * "Your 6am shift is 5 short and it's 6:15" — an alert, not a dashboard
 * state, and only when it matters.
 *
 * Every few minutes: find shifts (same start + end, per store) that
 * started more than the grace period ago and are still running, count
 * assigned people with no punch and slots still unfilled, and ring when
 * the shift is MEANINGFULLY short — at least
 * PORTAL_COVERAGE_ALERT_MIN_SHORT_PCT of its headcount (default 10%, and
 * always at least one person). One person late on a 47-person overnight
 * is not an alert; five missing is.
 *
 * Who hears it:
 *   - store managers: their own store's shifts only, one alert per shift;
 *   - market accounts (client-wide) and region accounts: ONE roll-up per
 *     sweep listing every newly short shift across their stores — never
 *     an alert per store;
 *   - the client's shift supervisors and workforce managers: one alert per
 *     shift, linked to their live floor.
 *
 * Each person hears about a given shift once (PortalAlertLog), however
 * many sweeps see it and across midnight for an overnight shift.
 */

const CATEGORY = 'portal.coverage';
const ORG_TZ = 'America/New_York';
const DAY = 24 * 3_600_000;

export interface CoverageAlertResult {
  waves: number;
  rung: number;
}

type ShortWave = {
  key: string;
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
  short: number;
};

export async function runPortalCoverageAlertSweep(
  prisma: PrismaClient = defaultPrisma,
  now: Date = new Date(),
): Promise<CoverageAlertResult> {
  const grace = env.PORTAL_COVERAGE_ALERT_GRACE_MINUTES * 60_000;
  const cutoff = new Date(now.getTime() - grace);
  // The once-per-person log only needs to outlive the longest shift.
  await prisma.portalAlertLog.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 3 * DAY) } } });

  const portalUsers = await prisma.user.findMany({
    where: {
      role: 'CLIENT_PORTAL',
      status: 'ACTIVE',
      deletedAt: null,
      OR: [{ clientId: { not: null } }, { regionId: { not: null } }],
    },
    select: { id: true, clientId: true, locationId: true, regionId: true },
    take: 500,
  });
  if (portalUsers.length === 0) return { waves: 0, rung: 0 };
  const regionIds = [...new Set(portalUsers.filter((u) => !u.clientId && u.regionId).map((u) => u.regionId!))];
  const regionStores = regionIds.length
    ? await prisma.location.findMany({
        where: { regionId: { in: regionIds }, deletedAt: null },
        select: { id: true, clientId: true, regionId: true },
        take: 1000,
      })
    : [];
  const regionOfLocation = new Map(regionStores.map((l) => [l.id, l.regionId]));
  const clientIds = [
    ...new Set([...portalUsers.filter((u) => u.clientId).map((u) => u.clientId!), ...regionStores.map((l) => l.clientId)]),
  ];
  if (clientIds.length === 0) return { waves: 0, rung: 0 };

  // Shifts under way: started ≥ grace ago, not yet ended.
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
      clockInAt: { gte: new Date(now.getTime() - DAY) },
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
      (byAssociate.get(s.assignedAssociateId) ?? []).some((e) => e.clockInAt < s.endsAt && (e.clockOutAt ?? now) > s.startsAt));

  // Group into shifts per client + store + start + end.
  const waves = new Map<string, ShortWave>();
  for (const s of shifts) {
    const key = `coverage:${s.clientId}|${s.locationId ?? '-'}|${s.startsAt.toISOString()}|${s.endsAt.toISOString()}`;
    let w = waves.get(key);
    if (!w) {
      w = {
        key,
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
        short: 0,
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
  const minPct = env.PORTAL_COVERAGE_ALERT_MIN_SHORT_PCT;
  const shortWaves = [...waves.values()]
    .map((w) => ({ ...w, short: w.expected - w.present + w.open }))
    .filter((w) => w.short > 0 && w.short >= Math.max(1, Math.ceil(((w.expected + w.open) * minPct) / 100)))
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  if (shortWaves.length === 0) return { waves: waves.size, rung: 0 };

  /** The keys this person has not been told about yet — and log them. */
  const claim = async (userId: string, keys: string[]): Promise<Set<string>> => {
    if (keys.length === 0) return new Set();
    const seen = await prisma.portalAlertLog.findMany({ where: { userId, alertKey: { in: keys } }, select: { alertKey: true } });
    const seenSet = new Set(seen.map((r) => r.alertKey));
    const fresh = keys.filter((k) => !seenSet.has(k));
    if (fresh.length > 0) {
      await prisma.portalAlertLog.createMany({ data: fresh.map((alertKey) => ({ userId, alertKey })), skipDuplicates: true });
    }
    return new Set(fresh);
  };

  const storeName = (w: ShortWave) => w.locationName ?? w.clientName;
  const startLabel = (w: ShortWave) => formatTimeInZone(w.startsAt, w.timezone);
  const todayLink = (w: ShortWave, withStore: boolean) =>
    `/portal/today?${withStore && w.locationId ? `locationId=${w.locationId}&` : ''}date=${orgDateKey(w.startsAt)}&wave=${encodeURIComponent(w.startsAt.toISOString())}`;
  const line = (w: ShortWave) =>
    `${w.present} of ${w.expected} expected on the floor${w.open > 0 ? `, ${w.open} slot${w.open === 1 ? '' : 's'} unfilled` : ''}`;

  const supervisorsByClient = new Map<string, string[]>();
  const supervisorsOf = async (clientId: string) => {
    if (!supervisorsByClient.has(clientId)) {
      const sups = await prisma.user.findMany({
        where: { clientId, status: 'ACTIVE', deletedAt: null, role: { in: ['SHIFT_SUPERVISOR', 'WORKFORCE_MANAGER'] } },
        select: { id: true },
        take: 50,
      });
      supervisorsByClient.set(clientId, sups.map((s) => s.id));
    }
    return supervisorsByClient.get(clientId)!;
  };

  let rung = 0;
  const rollups = new Map<string, { kind: 'client' | 'region'; waves: ShortWave[] }>();

  for (const w of shortWaves) {
    const sups = await supervisorsOf(w.clientId);
    const subject = `${storeName(w)}: the ${startLabel(w)} shift is ${w.short} short`;

    // Store managers: their own store's shift, one alert each.
    const storeManagers = portalUsers.filter((u) => u.clientId === w.clientId && !!w.locationId && u.locationId === w.locationId);
    for (const u of storeManagers) {
      if (!(await claim(u.id, [w.key])).size) continue;
      await notifyUser(
        u.id,
        {
          subject,
          body: `${line(w)} for the ${startLabel(w)} shift.${sups.length > 0 ? " Alto's supervisors have been alerted too." : ''} Open Today to see who is in.`,
          category: CATEGORY,
          linkUrl: todayLink(w, false),
        },
        prisma,
      );
      rung += 1;
    }

    // Supervisors: one alert each, to their live floor.
    for (const id of sups) {
      if (!(await claim(id, [w.key])).size) continue;
      await notifyUser(
        id,
        {
          subject,
          body: `${line(w)} for the ${startLabel(w)} shift at ${storeName(w)}.`,
          category: CATEGORY,
          linkUrl: `/time-attendance?wave=${encodeURIComponent(w.startsAt.toISOString())}`,
        },
        prisma,
      );
      rung += 1;
    }

    // Market (client-wide) and region accounts: collected for one roll-up.
    for (const u of portalUsers) {
      const isClientWide = u.clientId === w.clientId && !u.locationId;
      const isRegion = !u.clientId && !!u.regionId && !!w.locationId && regionOfLocation.get(w.locationId) === u.regionId;
      if (!isClientWide && !isRegion) continue;
      const entry = rollups.get(u.id) ?? { kind: isRegion ? ('region' as const) : ('client' as const), waves: [] };
      entry.waves.push(w);
      rollups.set(u.id, entry);
    }
  }

  for (const [userId, { kind, waves: list }] of rollups) {
    const fresh = await claim(userId, list.map((w) => w.key));
    const newWaves = list.filter((w) => fresh.has(w.key));
    if (newWaves.length === 0) continue;
    const stores = new Set(newWaves.map(storeName));
    const one = newWaves.length === 1 ? newWaves[0]! : null;
    await notifyUser(
      userId,
      {
        subject: one
          ? `${storeName(one)}: the ${startLabel(one)} shift is ${one.short} short`
          : `${newWaves.length} shifts short across ${stores.size === 1 ? [...stores][0] : `${stores.size} stores`}`,
        body:
          newWaves.map((w) => `${storeName(w)}, ${startLabel(w)} shift: ${line(w)}.`).join('\n') +
          (kind === 'region' ? '\n\nOpen your command center to see every store.' : '\n\nOpen your store site to see every store.'),
        category: CATEGORY,
        linkUrl: kind === 'region' ? '/' : one ? todayLink(one, true) : '/portal',
      },
      prisma,
    );
    rung += 1;
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
    `[alto-people/api] portal coverage alert cron armed (every ${seconds}s; ${env.PORTAL_COVERAGE_ALERT_GRACE_MINUTES} min grace; ${env.PORTAL_COVERAGE_ALERT_MIN_SHORT_PCT}% short threshold)`,
  );
}

export function stopPortalCoverageAlertCron(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
