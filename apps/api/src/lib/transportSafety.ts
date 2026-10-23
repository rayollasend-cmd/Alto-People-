import { createHmac, timingSafeEqual } from 'node:crypto';
import { prisma } from '../db.js';
import { env } from '../config/env.js';
import { enqueueAudit } from './audit.js';
import type { GeoPoint } from './geocode.js';
import { emitLiveEvent } from './liveEvents.js';
import { notifyUser, trackNotificationWork } from './notify.js';
import { haversineM, computeRunLive, liveRunInclude, type LiveRunRow, type RunLive } from './transportLive.js';

/**
 * Safety on the road — the toolkit Uber and Lyft put behind one shield, in
 * the shape a shuttle for people we employ needs:
 *
 *   watchForTrouble  on every ping: a van that has sat still for
 *                    STALL_MINUTES nowhere near a stop, or drifted
 *                    DRIFT_M farther from its next stop than it had got,
 *                    asks the driver "everything OK?" (once). No answer in
 *                    ESCALATE_AFTER_MIN → the desk is told. Moving again,
 *                    or the driver's OK, clears it.
 *   raiseSos / ackSos  the driver's red button: the desk hears at once,
 *                    with the van's position; the desk acknowledges.
 *   share links      a signed, expiring link to a public page that shows
 *                    the van and its next stop — no rider names, no
 *                    addresses — for the driver's family or a supervisor
 *                    waiting at the door.
 *
 * Nothing here moves money or changes a ride; it only gets a person's eyes
 * on the van sooner.
 */

export const STALL_MINUTES = 8;
export const STALL_RADIUS_M = 60;
export const NEAR_STOP_M = 150;
export const ESCALATE_AFTER_MIN = 5;
export const DRIFT_M = 2_500;
/** A driver's "I'm OK" quiets the watch for this long. */
const OK_QUIET_MS = 20 * 60_000;
const SHARE_TTL_MS = 6 * 3_600_000;

export type Trouble = 'stalled' | 'off_route';

/**
 * Judge the van against its plan. Pure: `pings` are the last few minutes
 * of positions, newest first; `next` the first stop still ahead that has a
 * point; `minDistToNextM` the closest the van has come to it so far.
 */
export function judgeTrouble(opts: {
  now: Date;
  van: GeoPoint;
  pings: Array<{ lat: number; lng: number; at: Date }>;
  stops: GeoPoint[];
  next: GeoPoint | null;
  minDistToNextM: number | null;
}): { trouble: Trouble | null; distToNextM: number | null } {
  const distToNext = opts.next ? Math.round(haversineM(opts.van, opts.next)) : null;
  const nearAStop = opts.stops.some((s) => haversineM(opts.van, s) < NEAR_STOP_M);
  if (distToNext !== null && opts.minDistToNextM !== null && distToNext > opts.minDistToNextM + DRIFT_M) {
    return { trouble: 'off_route', distToNextM: distToNext };
  }
  const since = opts.now.getTime() - STALL_MINUTES * 60_000;
  const recent = opts.pings.filter((p) => p.at.getTime() >= since);
  const oldest = recent[recent.length - 1];
  const stalled =
    !nearAStop &&
    recent.length >= 3 &&
    !!oldest &&
    oldest.at.getTime() <= since + 60_000 &&
    recent.every((p) => haversineM(opts.van, p) < STALL_RADIUS_M);
  return { trouble: stalled ? 'stalled' : null, distToNextM: distToNext };
}

function nextStop(live: RunLive): GeoPoint | null {
  return live.plan.waypoints.find((w) => w.point)?.point ?? null;
}

async function desk(): Promise<string[]> {
  const rows = await prisma.user.findMany({
    where: { role: 'TRANSPORTATION_DIRECTOR', status: 'ACTIVE', deletedAt: null },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

export async function watchForTrouble(run: LiveRunRow, live: RunLive, now = new Date()): Promise<void> {
  if (!live.van || run.status !== 'ACTIVE') return;
  const pings = await prisma.rideRunPing.findMany({
    where: { runId: run.id, at: { gte: new Date(now.getTime() - (STALL_MINUTES + 1) * 60_000) } },
    orderBy: { at: 'desc' },
    take: 200,
    select: { lat: true, lng: true, at: true },
  });
  const judged = judgeTrouble({
    now,
    van: live.van,
    pings: pings.map((p) => ({ lat: Number(p.lat), lng: Number(p.lng), at: p.at })),
    stops: live.plan.waypoints.map((w) => w.point).filter((p): p is GeoPoint => !!p),
    next: nextStop(live),
    minDistToNextM: run.minDistToNextM,
  });
  const quiet = run.driverOkAt && now.getTime() - run.driverOkAt.getTime() < OK_QUIET_MS;

  // Remember the closest approach to the next stop (drift is measured
  // against it; the marks reset it when the next stop changes).
  if (judged.distToNextM !== null && (run.minDistToNextM === null || judged.distToNextM < run.minDistToNextM)) {
    await prisma.rideRun.update({ where: { id: run.id }, data: { minDistToNextM: judged.distToNextM } });
  }

  if (judged.trouble && !quiet) {
    if (!run.stallAlertedAt) {
      const claimed = await prisma.rideRun.updateMany({ where: { id: run.id, stallAlertedAt: null }, data: { stallAlertedAt: now } });
      if (claimed.count > 0) {
        void trackNotificationWork(
          notifyUser(run.driverUserId, {
            subject: 'Everything OK?',
            body:
              judged.trouble === 'stalled'
                ? `${run.van.name} has been still for ${STALL_MINUTES} minutes away from a stop. Tap "I'm OK" in your runs, or the shield if you need help.`
                : `${run.van.name} looks to be heading away from its next stop. Tap "I'm OK" in your runs if all is well.`,
            category: 'transport',
            linkUrl: '/',
          }),
        );
        emitLiveEvent(run.driverUserId, 'transport');
        enqueueAudit({ actorUserId: run.driverUserId, action: 'transport.safety_prompt', entityType: 'RideRun', entityId: run.id, metadata: { trouble: judged.trouble } }, 'transportSafety');
      }
    } else if (!run.stallEscalatedAt && now.getTime() - run.stallAlertedAt.getTime() >= ESCALATE_AFTER_MIN * 60_000) {
      const claimed = await prisma.rideRun.updateMany({ where: { id: run.id, stallEscalatedAt: null }, data: { stallEscalatedAt: now } });
      if (claimed.count > 0) {
        const driver = run.driver.associate ? `${run.driver.associate.firstName} ${run.driver.associate.lastName}` : run.driver.email;
        for (const id of await desk()) {
          void trackNotificationWork(
            notifyUser(id, {
              subject: `${run.van.name}: no answer from ${driver}`,
              body:
                `${judged.trouble === 'stalled' ? `The van has been still for ${STALL_MINUTES}+ minutes away from any stop` : 'The van is heading away from its next stop'} ` +
                `and ${driver} hasn't answered "everything OK?" in ${ESCALATE_AFTER_MIN} minutes. Call them, or open the live map.`,
              category: 'transport',
              linkUrl: '/transport?tab=live',
            }),
          );
          emitLiveEvent(id, 'transport');
        }
        enqueueAudit({ actorUserId: run.driverUserId, action: 'transport.safety_escalated', entityType: 'RideRun', entityId: run.id, metadata: { trouble: judged.trouble } }, 'transportSafety');
      }
    }
  } else if (run.stallAlertedAt && !judged.trouble) {
    // Moving again: the question answers itself.
    await prisma.rideRun.update({ where: { id: run.id }, data: { stallAlertedAt: null, stallEscalatedAt: null } });
  }
}

/** The driver's "I'm OK": clears the prompt and quiets the watch a while. */
export async function driverOk(runId: string, now = new Date()): Promise<void> {
  await prisma.rideRun.update({ where: { id: runId }, data: { driverOkAt: now, stallAlertedAt: null, stallEscalatedAt: null } });
  for (const id of await desk()) emitLiveEvent(id, 'transport');
}

/** The next stop changed (arrived / marked): drift starts over. */
export async function resetDrift(runId: string): Promise<void> {
  await prisma.rideRun.updateMany({ where: { id: runId }, data: { minDistToNextM: null } });
}

export async function raiseSos(
  run: { id: string; driverUserId: string; van: { name: string; plate: string | null }; lastLat: unknown; lastLng: unknown },
  actorId: string,
  input: { note?: string | null; lat?: number | null; lng?: number | null },
  now = new Date(),
): Promise<void> {
  await prisma.rideRun.update({ where: { id: run.id }, data: { sosAt: now, sosNote: input.note ?? null, sosAckAt: null, sosAckById: null } });
  const driver = await prisma.user.findUnique({
    where: { id: run.driverUserId },
    select: { email: true, associate: { select: { firstName: true, lastName: true, phone: true } } },
  });
  const name = driver?.associate ? `${driver.associate.firstName} ${driver.associate.lastName}` : (driver?.email ?? 'The driver');
  const lat = input.lat ?? (run.lastLat === null || run.lastLat === undefined ? null : Number(run.lastLat));
  const lng = input.lng ?? (run.lastLng === null || run.lastLng === undefined ? null : Number(run.lastLng));
  const where = lat !== null && lng !== null ? ` Position ${lat.toFixed(5)}, ${lng.toFixed(5)} — https://www.google.com/maps?q=${lat},${lng}` : '';
  for (const id of await desk()) {
    void trackNotificationWork(
      notifyUser(id, {
        subject: `SOS — ${name} in ${run.van.name}`,
        body: `${name} pressed the emergency button in ${run.van.name}${run.van.plate ? ` (${run.van.plate})` : ''}.${input.note ? ` "${input.note}"` : ''}${where}${driver?.associate?.phone ? ` Call ${driver.associate.phone}.` : ''} Acknowledge on the live map.`,
        category: 'transport',
        linkUrl: '/transport?tab=live',
      }),
    );
    emitLiveEvent(id, 'transport');
  }
  enqueueAudit({ actorUserId: actorId, action: 'transport.sos_raised', entityType: 'RideRun', entityId: run.id, metadata: { lat, lng, note: input.note ?? null } }, 'transportSafety');
}

export async function ackSos(runId: string, actorId: string, now = new Date()): Promise<void> {
  const run = await prisma.rideRun.update({ where: { id: runId }, data: { sosAckAt: now, sosAckById: actorId }, select: { driverUserId: true } });
  void trackNotificationWork(
    notifyUser(run.driverUserId, { subject: 'Transportation has your SOS', body: 'The desk saw your emergency and is on it. Keep your phone close.', category: 'transport', linkUrl: '/' }),
  );
  emitLiveEvent(run.driverUserId, 'transport');
  enqueueAudit({ actorUserId: actorId, action: 'transport.sos_acknowledged', entityType: 'RideRun', entityId: runId }, 'transportSafety');
}

/* ----- Share the trip: a signed, expiring link ------------------------------- */

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const unb64 = (s: string) => Buffer.from(s, 'base64url').toString('utf8');
const sign = (payload: string) => createHmac('sha256', env.JWT_SECRET).update(`transport-share:${payload}`).digest('base64url');

export function shareToken(runId: string, now = new Date()): { token: string; expiresAt: Date } {
  const expiresAt = new Date(now.getTime() + SHARE_TTL_MS);
  const payload = `${runId}.${expiresAt.getTime()}`;
  return { token: `${b64(payload)}.${sign(payload)}`, expiresAt };
}

/**
 * Why a share link doesn't open, told apart (F500 G5): a genuine link past
 * its six hours is 'expired' (410), anything else — a typo, a forged or
 * truncated token — is 'invalid' (404). The page words them differently.
 */
export function shareTokenState(token: string, now = new Date()): { runId: string } | 'expired' | 'invalid' {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return 'invalid';
  const payload = unb64(token.slice(0, dot));
  const sig = token.slice(dot + 1);
  const expected = sign(payload);
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return 'invalid';
  const [runId, exp] = payload.split('.');
  if (!runId || !exp) return 'invalid';
  return Number(exp) < now.getTime() ? 'expired' : { runId };
}

export function verifyShareToken(token: string, now = new Date()): string | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = unb64(token.slice(0, dot));
  const sig = token.slice(dot + 1);
  const expected = sign(payload);
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const [runId, exp] = payload.split('.');
  if (!runId || !exp || Number(exp) < now.getTime()) return null;
  return runId;
}

/** What a shared link shows: the van, where it is, when it reaches its next stop. Nothing about who rides. */
export async function publicTrack(runId: string, now = new Date()) {
  const run = await prisma.rideRun.findUnique({ where: { id: runId }, include: liveRunInclude });
  if (!run || run.status === 'CANCELLED') return null;
  const live = await computeRunLive(run, now);
  const next = live.plan.waypoints.find((w) => w.point);
  const driverFirst = run.driver.associate?.firstName ?? null;
  return {
    status: run.status,
    van: { name: run.van.name, plate: run.van.plate },
    driver: driverFirst,
    position: live.van,
    stale: live.stale,
    next: next
      ? {
          kind: next.kind,
          label: next.kind === 'store' ? (live.stores.get(next.locationId!)?.location.name ?? 'the store') : next.kind === 'pickup' ? 'a pickup' : 'a drop-off',
          etaAt: next.etaAt?.toISOString() ?? null,
        }
      : null,
    stopsLeft: live.plan.waypoints.length,
    endedAt: run.endedAt?.toISOString() ?? null,
    generatedAt: now.toISOString(),
  };
}
