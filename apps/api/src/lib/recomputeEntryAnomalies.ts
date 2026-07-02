import type { PrismaClient } from '@prisma/client';
import {
  detectAnomalies,
  endOfWeekUTC,
  netWorkedMinutes,
  startOfWeekUTC,
} from './timeAnomalies.js';

/**
 * Load a COMPLETED entry and (re)compute its anomaly flags — breaks,
 * weekly OT, geofence carry-over, and the linked shift's window
 * (EARLY_OUT / OUTSIDE_SHIFT_WINDOW).
 *
 * Built for the kiosk clock-out path, which historically closed entries
 * with no anomaly pass at all (the flags only exist to feed the review
 * queue, so they're computed AFTER the punch transaction commits —
 * a failure here must never fail or slow a punch). Callers invoke it
 * fire-and-forget:  `void recomputeEntryAnomalies(prisma, id)`.
 */
export async function recomputeEntryAnomalies(
  prisma: PrismaClient,
  entryId: string,
): Promise<void> {
  try {
    const entry = await prisma.timeEntry.findUnique({
      where: { id: entryId },
      include: {
        breaks: true,
        associate: { select: { state: true } },
        shift: { select: { startsAt: true, endsAt: true } },
      },
    });
    if (!entry || !entry.clockOutAt) return;

    const weekStart = startOfWeekUTC(entry.clockInAt);
    const weekEnd = endOfWeekUTC(entry.clockInAt);
    const weekly = await prisma.timeEntry.findMany({
      take: 100,
      where: {
        associateId: entry.associateId,
        clockInAt: { gte: weekStart, lt: weekEnd },
        id: { not: entry.id },
      },
      include: { breaks: true },
    });
    const weeklySoFar = weekly.reduce(
      (sum, e) => sum + netWorkedMinutes(e, e.breaks),
      0,
    );
    const thisMinutes = netWorkedMinutes(entry, entry.breaks);

    const existing = Array.isArray(entry.anomalies)
      ? (entry.anomalies as string[])
      : [];
    const detected = detectAnomalies({
      entry: {
        clockInAt: entry.clockInAt,
        clockOutAt: entry.clockOutAt,
        // Kiosk geofence is advisory and lives on the KioskPunch row; the
        // entry-level flags only exist if a prior pass set them — carry
        // them over rather than clearing.
        geofenceInOk: existing.includes('GEOFENCE_VIOLATION_IN') ? false : null,
        geofenceOutOk: existing.includes('GEOFENCE_VIOLATION_OUT') ? false : null,
      },
      breaks: entry.breaks.map((b) => ({
        type: b.type,
        startedAt: b.startedAt,
        endedAt: b.endedAt,
      })),
      weeklyMinutesIncludingThis: weeklySoFar + thisMinutes,
      matchedShift: entry.shift ?? undefined,
      state: entry.associate?.state ?? null,
    });

    await prisma.timeEntry.update({
      where: { id: entry.id },
      data: { anomalies: detected },
    });
  } catch (err) {
    console.warn(
      '[time] recomputeEntryAnomalies failed (advisory only):',
      err instanceof Error ? err.message : err,
    );
  }
}
