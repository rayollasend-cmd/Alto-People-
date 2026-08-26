// Shift-aware auto clock-out — the fix for "clocked in, never clocked
// out". Every 5 minutes:
//
//   1. Any ACTIVE entry whose LINKED SHIFT ended more than 10 minutes
//      ago is closed AT THE SHIFT'S SCHEDULED END (never the detection
//      instant — a 2 AM sweep must not pay four phantom hours), stamped
//      with the FORGOT_CLOCKOUT anomaly so it wears a warning chip in
//      the approval queue, noted on the entry, and the associate is told
//      ("if you actually worked later, tell your supervisor").
//   2. The legacy 18-hour fallback (kioskMaintenance) still catches
//      UNLINKED entries — walk-ins/manual adds with no scheduled end.
//
// Always-on, unlike the opt-in kiosk maintenance cron: forgotten
// punch-outs corrupt payroll whether or not an env knob was set.

import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';
import { recordAttendanceForEntry } from './attendance.js';
import { closeForgottenClockOuts } from './kioskMaintenance.js';
import { notifyAssociate } from './notify.js';
import { DEFAULT_TIMEZONE, formatTimeInZone } from './timezone.js';

export const AUTO_CLOCKOUT_GRACE_MIN = 10;
const SWEEP_SECONDS = 5 * 60;

export interface AutoClockOutResult {
  closed: number;
  fallbackClosed: number;
}

export async function runAutoClockOutSweep(
  prisma: PrismaClient = defaultPrisma,
  now: Date = new Date(),
): Promise<AutoClockOutResult> {
  const graceCutoff = new Date(now.getTime() - AUTO_CLOCKOUT_GRACE_MIN * 60_000);
  const stuck = await prisma.timeEntry.findMany({
    where: {
      status: 'ACTIVE',
      shiftId: { not: null },
      shift: { endsAt: { lt: graceCutoff } },
    },
    select: {
      id: true,
      associateId: true,
      clockInAt: true,
      anomalies: true,
      notes: true,
      shift: { select: { endsAt: true } },
      location: { select: { timezone: true } },
    },
    take: 200,
  });

  let closed = 0;
  for (const entry of stuck) {
    const shiftEnd = entry.shift!.endsAt;
    // A punch AFTER the scheduled end (late-started overnight fix-ups,
    // odd manual states) can't close before it began — skip for the
    // legacy duration-based fallback to adjudicate.
    if (shiftEnd <= entry.clockInAt) continue;
    const prior = Array.isArray(entry.anomalies) ? (entry.anomalies as string[]) : [];
    const anomalies = prior.includes('FORGOT_CLOCKOUT')
      ? prior
      : [...prior, 'FORGOT_CLOCKOUT'];
    const note = 'Auto clocked out at shift end (no punch-out).';
    await prisma.timeEntry.update({
      where: { id: entry.id },
      data: {
        clockOutAt: shiftEnd,
        status: 'COMPLETED',
        anomalies,
        notes: entry.notes ? `${entry.notes}\n${note}` : note,
      },
    });
    closed += 1;
    // Late-arrival attendance still counts; EARLY_OUT can't fire since
    // we closed exactly at the scheduled end.
    void recordAttendanceForEntry(prisma, entry.id);
    const tz = entry.location?.timezone ?? DEFAULT_TIMEZONE;
    void notifyAssociate(entry.associateId, {
      subject: `We clocked you out at ${formatTimeInZone(shiftEnd, tz)}`,
      body: `Looks like you forgot to punch out — your entry was closed at your shift's scheduled end. If you actually worked later, tell your supervisor so they can adjust it. Remember to punch out at the kiosk next time!`,
      category: 'time_entry',
      linkUrl: '/time-attendance',
    });
  }

  // Unlinked stragglers (no shift to anchor to): the 18h/8h-cap fallback.
  const fallback = await closeForgottenClockOuts(prisma, now);
  return { closed, fallbackClosed: fallback.closed };
}

let timer: NodeJS.Timeout | null = null;

export function startAutoClockOutCron(): void {
  if (timer) return;
  void runAutoClockOutSweep().catch((err) => {
    console.error('[alto-people/api] auto clock-out sweep failed:', err);
  });
  timer = setInterval(() => {
    void runAutoClockOutSweep().catch((err) => {
      console.error('[alto-people/api] auto clock-out sweep failed:', err);
    });
  }, SWEEP_SECONDS * 1000);
  timer.unref();
  console.log(
    `[alto-people/api] auto clock-out cron armed (every ${SWEEP_SECONDS}s, closes ${AUTO_CLOCKOUT_GRACE_MIN} min after shift end)`,
  );
}

export function stopAutoClockOutCron(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
