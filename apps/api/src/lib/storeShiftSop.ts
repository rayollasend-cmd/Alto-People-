import type { OpsPeriod, OpsShift, Prisma, PrismaClient } from '@prisma/client';
import { fmtShiftWindow, inShiftWindow, minuteOfDayInZone } from '@alto-people/shared';
import { prisma as defaultPrisma } from '../db.js';
import { env } from '../config/env.js';
import { enqueueAudit } from './audit.js';
import { notifyAllAdmins, notifyUser } from './notify.js';
import { currentStoreWindows, ledWindows } from './shiftWindows.js';
import { orgDateKey } from './timeAnomalies.js';

/**
 * Store-shift SOP — every supervisor completes their shift's SOP and hands
 * over, every shift.
 *
 *   clock in   → the SOP assigned to the store shift they're working opens
 *                itself (StoreShiftSop: store + window label → template),
 *                with the previous shift's handover waiting in it
 *   the shift  → they work the checklist; a reminder lands 30 minutes
 *                before the window ends
 *   submit     → required items done — or submitted incomplete with a
 *                written reason — plus a handover note (or an explicit
 *                "nothing to hand over")
 *   clock out  → refused, in the app and at the kiosk, while it's open
 *
 * Still open 30 minutes after the window ends: escalated to leadership.
 * The gate always has a way out — "submit incomplete" with a reason — so
 * a supervisor who must leave is never trapped on the clock.
 */

type Db = PrismaClient | Prisma.TransactionClient;

/** Clocking in up to half an hour early belongs to the coming window. */
const EARLY_MIN = 30;
const MIN_MS = 60_000;

export interface StoreShift {
  locationId: string;
  locationName: string;
  timezone: string;
  label: string;
  startMinute: number;
  endMinute: number;
  templateId: string;
  templateName: string;
  department: string;
  period: OpsPeriod;
}

/** The occurrence of a window that `at` falls in (early arrivals included):
 *  its start and end instants. Wraps past midnight. */
export function windowOccurrence(
  at: Date,
  w: { startMinute: number; endMinute: number },
  timezone: string,
): { start: Date; end: Date } {
  const minute = minuteOfDayInZone(at, timezone);
  let sinceStart = (minute - w.startMinute + 1440) % 1440;
  // Early for the coming window, not late for the last one.
  if (sinceStart > 1440 - EARLY_MIN) sinceStart -= 1440;
  const start = new Date(Math.floor(at.getTime() / MIN_MS) * MIN_MS - sinceStart * MIN_MS);
  const length = (w.endMinute - w.startMinute + 1440) % 1440 || 1440;
  return { start, end: new Date(start.getTime() + length * MIN_MS) };
}

/**
 * The store shift a supervisor is working when they punch in at a store:
 * a window of theirs there that the punch falls in, else — covering for
 * someone — any of the store's windows it falls in. Only windows with an
 * SOP assigned count; none → nothing opens automatically.
 */
export async function storeShiftAt(
  db: Db,
  input: { userId: string; locationId: string; at: Date },
): Promise<StoreShift | null> {
  const [loc, defs, assigned] = await Promise.all([
    db.location.findUnique({
      where: { id: input.locationId },
      select: { id: true, name: true, timezone: true },
    }),
    currentStoreWindows(db, [input.locationId], input.at),
    db.storeShiftSop.findMany({
      where: { locationId: input.locationId },
      select: {
        label: true,
        template: { select: { id: true, name: true, department: true, period: true, active: true, retiredAt: true } },
      },
    }),
  ]);
  if (!loc) return null;
  const sopByLabel = new Map(
    assigned
      .filter((a) => a.template.active && !a.template.retiredAt)
      .map((a) => [a.label, a.template]),
  );
  const minute = minuteOfDayInZone(new Date(input.at.getTime() + EARLY_MIN * MIN_MS), loc.timezone);
  const candidates = [...defs.values()].filter((w) => sopByLabel.has(w.label) && inShiftWindow(minute, w));
  if (candidates.length === 0) return null;
  const mine = new Set(
    (await ledWindows(db, { userId: input.userId }, input.at))
      .filter((w) => w.locationId === input.locationId)
      .map((w) => w.label),
  );
  const pick = candidates.find((w) => mine.has(w.label)) ?? candidates[0]!;
  const t = sopByLabel.get(pick.label)!;
  return {
    locationId: loc.id,
    locationName: loc.name,
    timezone: loc.timezone,
    label: pick.label,
    startMinute: pick.startMinute,
    endMinute: pick.endMinute,
    templateId: t.id,
    templateName: t.name,
    department: t.department,
    period: t.period,
  };
}

/**
 * Open an ops shift with its checklist snapshotted from the library — the
 * standard AS IT IS TODAY, so later library edits never rewrite a shift
 * already being run. Shared by the manual picker and the clock-in.
 */
export async function createOpsShift(
  db: Db,
  input: {
    clientId: string;
    openedById: string;
    department: string;
    period: OpsPeriod;
    position: string;
    /** A specific template (store shift); else the department/period default. */
    templateId?: string | null;
    locationId?: string | null;
    windowLabel?: string | null;
    timeEntryId?: string | null;
    dueAt?: Date | null;
    /** Scheduled headcount window; default: the org day. */
    scheduledBetween?: { from: Date; to: Date };
    scheduledPosition?: string | null;
    now?: Date;
  },
): Promise<OpsShift> {
  const now = input.now ?? new Date();
  const dateKey = orgDateKey(now);
  const [scheduledHeadcount, actualHeadcount, template] = await Promise.all([
    input.scheduledBetween
      ? db.shift.count({
          where: {
            clientId: input.clientId,
            ...(input.locationId ? { locationId: input.locationId } : {}),
            ...(input.scheduledPosition ? { position: input.scheduledPosition } : {}),
            status: { not: 'CANCELLED' },
            startsAt: { gte: input.scheduledBetween.from, lt: input.scheduledBetween.to },
          },
        })
      : Promise.resolve(0),
    db.timeEntry.count({
      where: {
        clientId: input.clientId,
        ...(input.locationId ? { locationId: input.locationId } : {}),
        status: 'ACTIVE',
      },
    }),
    input.templateId
      ? db.opsSopTemplate.findUnique({
          where: { id: input.templateId },
          include: { tasks: { orderBy: { order: 'asc' } } },
        })
      : db.opsSopTemplate.findFirst({
          where: { department: input.department, period: input.period, active: true, retiredAt: null },
          orderBy: { createdAt: 'asc' },
          include: { tasks: { orderBy: { order: 'asc' } } },
        }),
  ]);
  return db.opsShift.create({
    data: {
      clientId: input.clientId,
      department: input.department,
      period: input.period,
      position: input.position,
      dateKey,
      openedById: input.openedById,
      scheduledHeadcount,
      actualHeadcount,
      templateId: template?.id ?? null,
      templateName: template?.name ?? null,
      locationId: input.locationId ?? null,
      windowLabel: input.windowLabel ?? null,
      timeEntryId: input.timeEntryId ?? null,
      dueAt: input.dueAt ?? null,
      tasks: template
        ? {
            create: template.tasks.map((task) => ({
              source: 'SOP' as const,
              templateTaskId: task.id,
              section: task.section,
              order: task.order,
              title: task.title,
              instructions: task.instructions,
              responseType: task.responseType,
              required: task.required,
              photoRequired: task.photoRequired,
              tempLabel: task.tempLabel,
              tempMin: task.tempMin,
              tempMax: task.tempMax,
              metricKey: task.metricKey,
              unit: task.unit,
              followUpOn: task.followUpOn,
              followUpRequirePhoto: task.followUpRequirePhoto,
              followUpTaskTitle: task.followUpTaskTitle,
            })),
          }
        : undefined,
    },
  });
}

/**
 * A supervisor clocked in: open the SOP of the store shift they're working.
 * Resumes (never duplicates) an SOP they already have open; opens nothing
 * when the store shift has no SOP assigned, or they're not a supervisor.
 */
export async function openSopOnClockIn(
  db: PrismaClient,
  input: {
    userId: string;
    role: string;
    clientId: string | null;
    locationId: string | null;
    at: Date;
    timeEntryId: string;
  },
): Promise<{ shiftId: string; resumed: boolean } | null> {
  if (input.role !== 'SHIFT_SUPERVISOR' || !input.clientId || !input.locationId) return null;
  const existing = await db.opsShift.findFirst({
    where: { openedById: input.userId, status: 'ACTIVE' },
    select: { id: true },
  });
  if (existing) return { shiftId: existing.id, resumed: true };

  const ss = await storeShiftAt(db, { userId: input.userId, locationId: input.locationId, at: input.at });
  if (!ss) return null;
  const occ = windowOccurrence(input.at, ss, ss.timezone);
  const shift = await createOpsShift(db, {
    clientId: input.clientId,
    openedById: input.userId,
    department: ss.department,
    period: ss.period,
    position: `${ss.label} shift`,
    templateId: ss.templateId,
    locationId: ss.locationId,
    windowLabel: ss.label,
    timeEntryId: input.timeEntryId,
    dueAt: occ.end,
    scheduledBetween: { from: occ.start, to: occ.end },
    now: input.at,
  });
  enqueueAudit(
    {
      actorUserId: input.userId,
      clientId: input.clientId,
      action: 'ops.shift_auto_opened',
      entityType: 'OpsShift',
      entityId: shift.id,
      metadata: { locationId: ss.locationId, window: ss.label, template: ss.templateName, timeEntryId: input.timeEntryId },
    },
    'ops.shifts',
  );
  void notifyUser(input.userId, {
    subject: `Your ${ss.label} SOP is open`,
    body:
      `${ss.locationName} · ${ss.label} (${fmtShiftWindow(ss)}). Work through it during your shift, then ` +
      `submit it — with your handover notes for the next shift — before you clock out.`,
    category: 'ops.sop',
    linkUrl: `/ops?tab=shift&shift=${shift.id}`,
  });
  return { shiftId: shift.id, resumed: false };
}

/** The SOP a supervisor must submit before they may clock out, if any. */
export async function sopBlockingClockOut(
  db: Db,
  user: { id: string; role: string },
): Promise<{ id: string; windowLabel: string | null; position: string } | null> {
  if (user.role !== 'SHIFT_SUPERVISOR') return null;
  return db.opsShift.findFirst({
    where: { openedById: user.id, status: 'ACTIVE' },
    select: { id: true, windowLabel: true, position: true },
    orderBy: { openedAt: 'desc' },
  });
}

export function sopOpenMessage(sop: { windowLabel: string | null; position: string }): string {
  const name = sop.windowLabel ? `${sop.windowLabel} SOP` : `SOP for ${sop.position}`;
  return (
    `Submit your ${name} before you clock out — finish it, or submit it ` +
    `incomplete with a reason, in the Alto app.`
  );
}

/**
 * Reminder 30 minutes before a store-shift SOP is due; escalation to
 * leadership when it's still open 30 minutes after. Each fires once.
 */
export async function runOpsSopSweep(
  db: PrismaClient = defaultPrisma,
  now: Date = new Date(),
): Promise<{ reminded: number; escalated: number }> {
  const open = await db.opsShift.findMany({
    where: { status: 'ACTIVE', dueAt: { not: null } },
    select: {
      id: true,
      dueAt: true,
      remindedAt: true,
      escalatedAt: true,
      windowLabel: true,
      openedById: true,
      clientId: true,
      location: { select: { name: true } },
      openedBy: { select: { email: true, associate: { select: { firstName: true, lastName: true } } } },
    },
    take: 500,
  });
  let reminded = 0;
  let escalated = 0;
  for (const s of open) {
    const due = s.dueAt!.getTime();
    const label = s.windowLabel ?? 'shift';
    if (!s.remindedAt && now.getTime() >= due - 30 * MIN_MS && now.getTime() < due + 30 * MIN_MS) {
      await db.opsShift.update({ where: { id: s.id }, data: { remindedAt: now } });
      void notifyUser(s.openedById, {
        subject: `Submit your ${label} SOP`,
        body: `Your ${label} shift ends soon. Finish the checklist and write your handover — you can't clock out until it's submitted.`,
        category: 'ops.sop',
        linkUrl: `/ops?tab=shift&shift=${s.id}`,
      });
      reminded += 1;
    }
    if (!s.escalatedAt && now.getTime() >= due + 30 * MIN_MS) {
      await db.opsShift.update({ where: { id: s.id }, data: { escalatedAt: now } });
      const who = s.openedBy.associate
        ? `${s.openedBy.associate.firstName} ${s.openedBy.associate.lastName}`
        : s.openedBy.email;
      void notifyAllAdmins({
        subject: `SOP not submitted — ${s.location?.name ?? 'store'} · ${label}`,
        body: `${who}'s ${label} SOP is still open 30 minutes after the shift ended. The handover to the next shift is waiting on it.`,
        category: 'ops.sop_overdue',
        linkUrl: '/ops?tab=board',
      });
      escalated += 1;
    }
  }
  return { reminded, escalated };
}

let timer: NodeJS.Timeout | null = null;

export function startOpsSopCron(): void {
  if (timer) return;
  const seconds = env.OPS_SOP_SWEEP_SECONDS;
  if (seconds <= 0) return;
  const run = () => {
    void runOpsSopSweep().catch((err) => {
      console.error('[alto-people/api] store-shift SOP sweep failed:', err);
    });
  };
  timer = setInterval(run, seconds * 1000);
  timer.unref();
  console.log(`[alto-people/api] store-shift SOP sweep armed (every ${seconds}s)`);
}
