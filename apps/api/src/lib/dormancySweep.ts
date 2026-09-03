import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';
import { env } from '../config/env.js';
import { recordCriticalAudit } from './audit.js';
import { ADMIN_EMAIL_HR_ONLY, notifyAllAdmins } from './notify.js';
import { executeDeactivation } from './deactivation.js';

/**
 * Dormancy auto-deactivation — the self-cleaning half of the workforce
 * roster. Associates who go silent (no clock-in, no worked shift, nothing
 * on any schedule) for DORMANCY_DEACTIVATE_DAYS (default 30) are
 * auto-deactivated with the exact same transaction as the manual
 * "Deactivate" button: login disabled, kiosk punches rejected, directory
 * INACTIVE — and the one-click Reactivate on their profile restores the
 * whole record (I-9, E-Verify, banking, kiosk PIN) when they come back.
 *
 * "Silent" means ALL of, over the window:
 *   - no time entry (clock-in),
 *   - no assigned shift that either ended recently or is upcoming —
 *     someone scheduled for next week is never dormant,
 *   - no open-shift claim (pending, or filed recently),
 *   - no kiosk punch (even a rejected one is a sign of life),
 *   - no APPROVED time off ending in the window or later (people on
 *     leave are away on purpose).
 *
 * HARD GUARDS — never a candidate at all:
 *   - no hireDate (onboarding pipeline — the ghost purge owns that),
 *   - hired/created/reactivated inside the window (fresh people get a
 *     full window before the clock can even start),
 *   - a PLANNED / IN_PROGRESS separation (formal offboarding finishes as
 *     a separation, never gets preempted by this sweep),
 *   - already deactivated / separated / erased / deleted.
 *
 * Two-stage, never a silent kill: at (days − DORMANCY_WARN_DAYS) idle the
 * admins get one heads-up listing who is approaching auto-deactivation —
 * scheduling the person (or any activity) resets the clock and re-arms a
 * fresh warning. Deactivation additionally requires that standing warning
 * to be at least DORMANCY_WARN_DAYS old, so on first rollout a
 * 90-days-dormant roster gets warned first and swept a week later, never
 * same-night. The system never auto-REACTIVATES — that stays a human
 * decision, and Reactivate stamps a fresh window (reactivatedAt) so the
 * sweep doesn't undo it the same night.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface DormancySweepResult {
  scanned: number;
  warned: number;
  deactivated: number;
  skipped?: 'disabled';
  errors: { associateId: string; error: string }[];
}

export async function runDormancySweep(
  prisma: PrismaClient = defaultPrisma,
  now: Date = new Date(),
): Promise<DormancySweepResult> {
  const days = env.DORMANCY_DEACTIVATE_DAYS;
  if (days <= 0) {
    return { scanned: 0, warned: 0, deactivated: 0, skipped: 'disabled', errors: [] };
  }
  // Warning lead can't exceed the window itself (warnDays = days would
  // mean warning on day zero; clamp keeps the math sane on odd configs).
  const warnDays = Math.min(env.DORMANCY_WARN_DAYS, Math.max(1, days - 1));
  const warnCutoff = new Date(now.getTime() - (days - warnDays) * DAY_MS);

  const result: DormancySweepResult = {
    scanned: 0,
    warned: 0,
    deactivated: 0,
    errors: [],
  };

  // One relational query does the whole dormancy test; per-candidate work
  // below only decides warn-vs-deactivate. `warnCutoff` (the looser bound)
  // is the filter — anyone with activity since then is not a candidate
  // for either action.
  const candidates = await prisma.associate.findMany({
    // Runaway backstop — a four-store roster is far smaller. Next sweep
    // picks up any remainder.
    take: 500,
    where: {
      deletedAt: null,
      erasedAt: null,
      separatedAt: null,
      deactivatedAt: null,
      hireDate: { not: null, lt: warnCutoff },
      createdAt: { lt: warnCutoff },
      OR: [{ reactivatedAt: null }, { reactivatedAt: { lt: warnCutoff } }],
      separations: { none: { status: { in: ['PLANNED', 'IN_PROGRESS'] } } },
      timeEntries: { none: { clockInAt: { gt: warnCutoff } } },
      // endsAt > warnCutoff covers BOTH worked-recently and any upcoming
      // shift (a future shift's end is after any past cutoff).
      assignedShifts: {
        none: {
          status: { in: ['ASSIGNED', 'COMPLETED'] },
          endsAt: { gt: warnCutoff },
        },
      },
      shiftClaims: {
        none: { OR: [{ status: 'PENDING' }, { createdAt: { gt: warnCutoff } }] },
      },
      kioskPunches: { none: { createdAt: { gt: warnCutoff } } },
      timeOffRequests: { none: { status: 'APPROVED', endDate: { gte: warnCutoff } } },
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      hireDate: true,
      createdAt: true,
      reactivatedAt: true,
      dormancyWarnedAt: true,
      timeEntries: {
        orderBy: { clockInAt: 'desc' },
        take: 1,
        select: { clockInAt: true },
      },
      assignedShifts: {
        where: { status: { in: ['ASSIGNED', 'COMPLETED'] } },
        orderBy: { endsAt: 'desc' },
        take: 1,
        select: { endsAt: true },
      },
    },
  });
  result.scanned = candidates.length;

  const warnedNames: string[] = [];
  const deactivatedNames: string[] = [];

  for (const a of candidates) {
    try {
      // Idle clock = the newest sign of life anywhere on their record.
      let lastActivityMs = Math.max(a.createdAt.getTime(), a.hireDate!.getTime());
      if (a.reactivatedAt) {
        lastActivityMs = Math.max(lastActivityMs, a.reactivatedAt.getTime());
      }
      const lastClockIn = a.timeEntries[0]?.clockInAt;
      if (lastClockIn) lastActivityMs = Math.max(lastActivityMs, lastClockIn.getTime());
      const lastShiftEnd = a.assignedShifts[0]?.endsAt;
      if (lastShiftEnd) lastActivityMs = Math.max(lastActivityMs, lastShiftEnd.getTime());

      const idleDays = Math.floor((now.getTime() - lastActivityMs) / DAY_MS);
      if (now.getTime() - lastActivityMs < (days - warnDays) * DAY_MS) continue;

      // A warning only "stands" if it postdates the last activity —
      // activity after a warning re-arms a fresh one before any sweep.
      const warnedAt =
        a.dormancyWarnedAt && a.dormancyWarnedAt.getTime() > lastActivityMs
          ? a.dormancyWarnedAt
          : null;

      if (!warnedAt) {
        await prisma.associate.update({
          where: { id: a.id },
          data: { dormancyWarnedAt: now },
        });
        warnedNames.push(`${a.firstName} ${a.lastName} — ${idleDays} days inactive`);
        result.warned += 1;
        continue;
      }

      if (
        now.getTime() - lastActivityMs < days * DAY_MS ||
        now.getTime() - warnedAt.getTime() < warnDays * DAY_MS
      ) {
        continue;
      }

      const outcome = await executeDeactivation(prisma, {
        associateId: a.id,
        byUserId: null,
        reason: `Auto-deactivated — no clock-ins or scheduled shifts for ${idleDays} days.`,
        now,
      });
      // Same action string as the manual path so the audit trail reads as
      // one stream; `auto: true` + null actor mark the system as the actor.
      await recordCriticalAudit(
        {
          actorUserId: null,
          action: 'associate.deactivated',
          entityType: 'Associate',
          entityId: a.id,
          metadata: {
            auto: true,
            idleDays,
            releasedShifts: outcome.releasedShifts,
            expiredClaims: outcome.expiredClaims,
            disabledLogins: outcome.disabledUserIds.length,
          } as Prisma.InputJsonValue,
        },
        'dormancySweep',
      );
      deactivatedNames.push(`${a.firstName} ${a.lastName} — ${idleDays} days inactive`);
      result.deactivated += 1;
    } catch (err) {
      result.errors.push({
        associateId: a.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (warnedNames.length > 0) {
    const n = warnedNames.length;
    await notifyAllAdmins({
      subject: `Dormancy notice: ${n} associate${n === 1 ? '' : 's'} inactive ${days - warnDays}+ days`,
      body:
        `${n} associate${n === 1 ? ' has' : 's have'} had no clock-ins, worked shifts, ` +
        `or upcoming schedule for ${days - warnDays}+ days:\n\n` +
        warnedNames.map((p) => `  • ${p}`).join('\n') +
        `\n\nUnless they're scheduled, clock in, or pick up a shift, they'll be ` +
        `automatically deactivated in about ${warnDays} days (login paused, removed ` +
        `from the schedulable pool — full record kept, one-click Reactivate on ` +
        `their profile). If someone's just between assignments, schedule them and ` +
        `the clock resets.`,
      category: 'dormancy',
      linkUrl: '/people',
      emailRoles: ADMIN_EMAIL_HR_ONLY,
    });
  }

  if (deactivatedNames.length > 0) {
    const n = deactivatedNames.length;
    await notifyAllAdmins({
      subject: `Auto-deactivated ${n} dormant associate${n === 1 ? '' : 's'}`,
      body:
        `After the prior notice, ${n} associate${n === 1 ? ' was' : 's were'} ` +
        `automatically deactivated for ${days}+ days of inactivity:\n\n` +
        deactivatedNames.map((p) => `  • ${p}`).join('\n') +
        `\n\nTheir full records are intact — if anyone comes back, Reactivate on ` +
        `their profile restores everything in one click. Each deactivation is ` +
        `recorded in the audit log.`,
      category: 'dormancy',
      linkUrl: '/people',
      emailRoles: ADMIN_EMAIL_HR_ONLY,
    });
  }

  return result;
}

let timer: NodeJS.Timeout | null = null;

export function startDormancySweepCron(): void {
  if (timer) return;
  const seconds = env.DORMANCY_SWEEP_INTERVAL_SECONDS;
  if (seconds <= 0 || env.DORMANCY_DEACTIVATE_DAYS <= 0) return;
  const run = () => {
    void runDormancySweep().catch((err) => {
      console.error('[alto-people/api] dormancy sweep failed:', err);
    });
  };
  run();
  timer = setInterval(run, seconds * 1000);
  timer.unref();
  console.log(
    `[alto-people/api] dormancy sweep armed (every ${seconds}s; deactivate at ${env.DORMANCY_DEACTIVATE_DAYS}d idle, warning ${env.DORMANCY_WARN_DAYS}d ahead)`,
  );
}

export function stopDormancySweepCron(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
