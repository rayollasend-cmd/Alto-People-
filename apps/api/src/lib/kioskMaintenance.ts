import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';
import { env } from '../config/env.js';

/**
 * Hourly kiosk maintenance sweep.
 *
 * Runs two jobs in sequence on a single setInterval — both are
 * idempotent so missed runs are fine:
 *
 *   1. closeForgottenClockOuts — auto-closes ACTIVE TimeEntry rows
 *      whose clockInAt is more than FORGOTTEN_CLOCKOUT_AFTER_HOURS old.
 *      Sets clockOutAt to clockInAt + DEFAULT_SHIFT_HOURS (capped) and
 *      stamps FORGOT_CLOCKOUT onto anomalies so the entry lands in
 *      HR's time-anomaly review queue. Without this, a forgotten
 *      clock-out racks up hours indefinitely and payroll runs against
 *      stale ACTIVE rows that silently break.
 *
 *   2. purgeOldSelfies — null-out KioskPunch.selfie bytes for punches
 *      older than SELFIE_RETENTION_DAYS. The punch row stays for audit
 *      (anomaly counts, face_distance, geofence drift); only the JPEG
 *      blob is removed. GDPR / storage hygiene.
 *
 * Start: env.KIOSK_MAINTENANCE_INTERVAL_SECONDS > 0 (hourly is
 * sensible). Tests call the individual functions directly.
 */

export const FORGOTTEN_CLOCKOUT_AFTER_HOURS = 18;
export const DEFAULT_SHIFT_HOURS = 8;
export const SELFIE_RETENTION_DAYS = 90;

export interface MaintenanceResult {
  forgottenClockOutsClosed: number;
  selfiesPurged: number;
  errors: { kind: string; entityId: string; error: string }[];
}

export async function closeForgottenClockOuts(
  prisma: PrismaClient = defaultPrisma,
  now: Date = new Date(),
): Promise<{ closed: number; errors: { entityId: string; error: string }[] }> {
  const cutoff = new Date(
    now.getTime() - FORGOTTEN_CLOCKOUT_AFTER_HOURS * 60 * 60 * 1000,
  );
  const stuck = await prisma.timeEntry.findMany({
    where: {
      status: 'ACTIVE',
      clockInAt: { lt: cutoff },
    },
    select: { id: true, clockInAt: true, anomalies: true },
    take: 500,
  });

  const errors: { entityId: string; error: string }[] = [];
  let closed = 0;
  for (const entry of stuck) {
    try {
      // Cap the inferred clock-out at clockInAt + DEFAULT_SHIFT_HOURS. We
      // never know what time they actually walked out, but this is a
      // sensible upper bound that doesn't burn payroll while still
      // surfacing the anomaly for HR to adjudicate.
      const inferredClockOut = new Date(
        entry.clockInAt.getTime() + DEFAULT_SHIFT_HOURS * 60 * 60 * 1000,
      );
      const priorAnomalies = Array.isArray(entry.anomalies)
        ? (entry.anomalies as string[])
        : [];
      const nextAnomalies = priorAnomalies.includes('FORGOT_CLOCKOUT')
        ? priorAnomalies
        : [...priorAnomalies, 'FORGOT_CLOCKOUT'];

      await prisma.timeEntry.update({
        where: { id: entry.id },
        data: {
          clockOutAt: inferredClockOut,
          status: 'COMPLETED',
          anomalies: nextAnomalies,
        },
      });
      closed++;
    } catch (err) {
      errors.push({
        entityId: entry.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { closed, errors };
}

export async function purgeOldSelfies(
  prisma: PrismaClient = defaultPrisma,
  now: Date = new Date(),
): Promise<{ purged: number }> {
  const cutoff = new Date(
    now.getTime() - SELFIE_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );
  // Null out the blob but keep the punch row — distance, face_distance,
  // anomaly flags, and the timeEntry link remain for audit and reporting.
  const result = await prisma.kioskPunch.updateMany({
    where: {
      selfie: { not: null },
      createdAt: { lt: cutoff },
    },
    data: { selfie: null },
  });
  return { purged: result.count };
}

/**
 * One-shot: run all maintenance jobs and aggregate the result. Safe to
 * call from a cron, a request handler, or tests.
 */
export async function runKioskMaintenance(
  prisma: PrismaClient = defaultPrisma,
  now: Date = new Date(),
): Promise<MaintenanceResult> {
  const closeResult = await closeForgottenClockOuts(prisma, now);
  const purgeResult = await purgeOldSelfies(prisma, now);
  return {
    forgottenClockOutsClosed: closeResult.closed,
    selfiesPurged: purgeResult.purged,
    errors: closeResult.errors.map((e) => ({
      kind: 'forgotten_clockout',
      entityId: e.entityId,
      error: e.error,
    })),
  };
}

let timer: NodeJS.Timeout | null = null;

export function startKioskMaintenanceCron(): void {
  if (timer) return;
  const seconds = env.KIOSK_MAINTENANCE_INTERVAL_SECONDS;
  if (seconds <= 0) return;
  void runKioskMaintenance().catch((err) => {
    console.error('[alto-people/api] kiosk maintenance failed:', err);
  });
  timer = setInterval(() => {
    void runKioskMaintenance().catch((err) => {
      console.error('[alto-people/api] kiosk maintenance failed:', err);
    });
  }, seconds * 1000);
  timer.unref();
  console.log(
    `[alto-people/api] kiosk maintenance cron armed (every ${seconds}s; ` +
      `forgotten-shift threshold ${FORGOTTEN_CLOCKOUT_AFTER_HOURS}h, ` +
      `selfie retention ${SELFIE_RETENTION_DAYS}d)`,
  );
}

export function stopKioskMaintenanceCron(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
