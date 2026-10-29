import type { PrismaClient } from '@prisma/client';
import { prisma } from '../db.js';
import { enqueueAudit } from './audit.js';
import { tenantJob } from './tenantJobs.js';
import { armJob } from './jobs.js';
import { notifyUser, trackNotificationWork } from './notify.js';
import { actsAs } from './roleScope.js';
import { fmtMomentInZone } from './humanDates.js';

/**
 * Stuck runs (transport walk 4).
 *
 * A run ends only when its driver taps Complete. One forgotten tap left a
 * run ACTIVE for 32 days: the board said the van was on the road, the
 * live map said it was "~32d late", the planner counted its van and
 * driver as busy. Nothing swept those up.
 *
 *   isRunStuck      the one rule, shared with the board and the live map:
 *                   ACTIVE and STUCK_RUN_MINUTES past its last waypoint
 *   closeStuckRuns  the daily sweep: completes them with a note and a
 *                   stamp (autoClosedAt). Riders marked on board rode and
 *                   complete normally. Riders never marked STAY SCHEDULED
 *                   for the desk to review — nobody is charged a guess
 *                   either way (a fare if we said they rode, a no-show fee
 *                   if we said they didn't; a ride taken is never waived,
 *                   and a ride we can't vouch for is never charged).
 *
 * The web's STUCK_RUN_MINUTES (lib/format.ts) is the same number.
 */

type Db = PrismaClient;

export const STUCK_RUN_MINUTES = 180;

interface StuckInput {
  status: string;
  departAt: Date;
  startedAt?: Date | null;
  rides: Array<{ status: string; targetAt: Date; pickupAt?: Date | null }>;
}

/** When the run should have been over: its last stop, else when it left. */
export function lastWaypointAt(run: StuckInput): Date {
  let last = (run.startedAt ?? run.departAt).getTime();
  for (const r of run.rides) {
    if (r.status === 'CANCELLED') continue;
    last = Math.max(last, r.targetAt.getTime(), r.pickupAt?.getTime() ?? 0);
  }
  return new Date(last);
}

export function isRunStuck(run: StuckInput, now = new Date()): boolean {
  if (run.status !== 'ACTIVE') return false;
  return now.getTime() - lastWaypointAt(run).getTime() >= STUCK_RUN_MINUTES * 60_000;
}

export interface SweepResult {
  closed: number;
  /** Riders left SCHEDULED for review, over every run closed. */
  unmarked: number;
  runIds: string[];
}

export async function closeStuckRuns(now = new Date(), db: Db = prisma): Promise<SweepResult> {
  const candidates = await db.rideRun.findMany({
    where: { status: 'ACTIVE', departAt: { lt: new Date(now.getTime() - STUCK_RUN_MINUTES * 60_000) } },
    select: {
      id: true,
      status: true,
      serviceDate: true,
      departAt: true,
      startedAt: true,
      notes: true,
      van: { select: { name: true } },
      rides: { select: { id: true, status: true, targetAt: true, pickupAt: true } },
    },
  });
  const out: SweepResult = { closed: 0, unmarked: 0, runIds: [] };
  for (const run of candidates) {
    if (!isRunStuck(run, now)) continue;
    const boarded = run.rides.filter((r) => r.status === 'BOARDED').length;
    const unmarked = run.rides.filter((r) => r.status === 'SCHEDULED').length;
    const hours = Math.round((now.getTime() - lastWaypointAt(run).getTime()) / 3_600_000);
    const note =
      `Closed automatically ${fmtMomentInZone(now)}: left open ${hours} hour${hours === 1 ? '' : 's'} past its last stop.` +
      (unmarked > 0 ? ` ${unmarked} rider${unmarked === 1 ? '' : 's'} never marked — review before charging anyone.` : '');
    await db.$transaction([
      db.ride.updateMany({ where: { runId: run.id, status: 'BOARDED' }, data: { status: 'COMPLETED', completedAt: now } }),
      db.rideRun.update({
        where: { id: run.id },
        data: { status: 'COMPLETED', endedAt: now, autoClosedAt: now, notes: [run.notes, note].filter(Boolean).join(' ').slice(0, 500) },
      }),
    ]);
    enqueueAudit(
      { actorUserId: null, action: 'transport.run_closed_stuck', entityType: 'RideRun', entityId: run.id, metadata: { boarded, unmarked, hours } },
      'transportStuckRuns',
    );
    out.closed += 1;
    out.unmarked += unmarked;
    out.runIds.push(run.id);
    if (unmarked > 0) {
      const desk = await db.user.findMany({ where: { ...actsAs('TRANSPORTATION_DIRECTOR'), status: 'ACTIVE', deletedAt: null }, select: { id: true } });
      for (const u of desk) {
        void trackNotificationWork(
          notifyUser(u.id, {
            subject: `${run.van.name}'s run was closed — ${unmarked} rider${unmarked === 1 ? '' : 's'} never marked`,
            body: `The driver never completed it, so it was closed ${hours} hours after its last stop. Nobody was charged. Review who rode before anything is charged.`,
            category: 'transport',
            // The board's day (?date= is read by /transport): the closed run and its unmarked riders.
            linkUrl: `/transport?date=${run.serviceDate}`,
          }),
        );
      }
    }
  }
  return out;
}

const SWEEP_EVERY_MS = 60 * 60_000;

/** Hourly check, daily in effect: a run is only ever stuck once. */
export function startStuckRunSweepCron(): void {
  if (process.env.NODE_ENV === 'test') return;
  armJob({
    name: 'transportStuckRuns',
    label: 'Van runs left open past their last stop',
    intervalSeconds: SWEEP_EVERY_MS / 1000,
    run: tenantJob('transportStuckRuns', () => closeStuckRuns(), { module: 'transportation' }),
  });
}
