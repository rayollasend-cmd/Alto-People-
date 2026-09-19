import type { OpsPeriod, OpsShift, Prisma, PrismaClient } from '@prisma/client';
import { fmtShiftWindow, inShiftWindow, minuteOfDayInZone } from '@alto-people/shared';
import { prisma as defaultPrisma } from '../db.js';
import { env } from '../config/env.js';
import { enqueueAudit } from './audit.js';
import { notifyAllAdmins, notifyUser } from './notify.js';
import { currentStoreWindows, ledWindows } from './shiftWindows.js';
import { dateKeyInZone, orgDateKey } from './timeAnomalies.js';
import { dueInstants } from './sopDue.js';
import { ensureOpsSeed } from './opsSops.js';
import { DEFAULT_TIMEZONE } from './timezone.js';
import {
  activeCoverFor,
  firstName,
  notifyWorkforce,
  personName,
  validLead,
} from './floorLeads.js';

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
 *
 * Floor supervisors (lib/floorLeads): they help on their shift's SOP, and
 * run it — gate included — when it's theirs:
 *   handed the shift  → on a day their shift supervisor handed them
 *                       (ShiftCover), their clock-in — at the store
 *                       tablet; they never punch in the app — opens it
 *                       for them
 *   lead not on clock → 30 minutes into the shift, with no shift
 *                       supervisor for it on the clock, the sweep opens it
 *                       for the floor supervisor who is
 *   lead clocks in    → the shift supervisor takes it back; items stay
 *                       checked, the floor supervisor's gate lifts
 * A store shift occurrence is (store, window, end): a floor supervisor's
 * clock-in and the sweep never open a second SOP for one that has an SOP,
 * running or submitted. (Two shift supervisors on one shift still each run
 * their own, as before.)
 */

type Db = PrismaClient | Prisma.TransactionClient;

/** Clocking in up to half an hour early belongs to the coming window. */
const EARLY_MIN = 30;
const MIN_MS = 60_000;
/** How long a shift runs without its shift supervisor before the SOP
 *  moves to a floor supervisor who is on the clock. */
export const FALLBACK_MIN = 30;

/** Roles whose clock-out an SOP can gate — whoever is running one. */
const SOP_ROLES: ReadonlySet<string> = new Set(['SHIFT_SUPERVISOR', 'FLOOR_SUPERVISOR']);

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
    /** A floor supervisor running it for this shift supervisor. */
    coveringForId?: string | null;
    /** Scheduled headcount window; default: the org day. */
    scheduledBetween?: { from: Date; to: Date };
    scheduledPosition?: string | null;
    /** When the shift starts — its blocks' due times count from here;
     *  default: now. */
    startsAt?: Date;
    now?: Date;
  },
): Promise<OpsShift> {
  const now = input.now ?? new Date();
  const dateKey = orgDateKey(now);
  const [scheduledHeadcount, actualHeadcount, template, location] = await Promise.all([
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
    input.locationId
      ? db.location.findUnique({ where: { id: input.locationId }, select: { timezone: true } })
      : Promise.resolve(null),
  ]);
  // "By 9:00 AM" becomes 9:00 AM on this shift's clock, at the store.
  const due = template
    ? dueInstants(
        template.tasks.map((task) => task.dueTime),
        input.startsAt ?? now,
        location?.timezone ?? DEFAULT_TIMEZONE,
      )
    : [];
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
      coveringForId: input.coveringForId ?? null,
      tasks: template
        ? {
            create: template.tasks.map((task, i) => ({
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
              dueAt: due[i] ?? null,
            })),
          }
        : undefined,
    },
  });
}

/** The SOP of one store shift occurrence — (store, window, end) — newest
 *  first, whoever runs it. */
function occurrenceSops(db: Db, ss: Pick<StoreShift, 'locationId' | 'label'>, end: Date) {
  return db.opsShift.findMany({
    where: { locationId: ss.locationId, windowLabel: ss.label, dueAt: end },
    orderBy: { openedAt: 'desc' },
    select: {
      id: true,
      status: true,
      openedById: true,
      coveringForId: true,
      openedBy: {
        select: { role: true, email: true, associate: { select: { firstName: true, lastName: true } } },
      },
    },
  });
}

/** Open a store shift's SOP for whoever runs it — the clock-in and the
 *  cover sweep both land here. */
async function openStoreShiftSop(
  db: Db,
  input: {
    ss: StoreShift;
    occ: { start: Date; end: Date };
    clientId: string;
    userId: string;
    timeEntryId: string;
    coveringForId?: string | null;
    at: Date;
    audit: string;
  },
): Promise<OpsShift> {
  const { ss, occ } = input;
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
    coveringForId: input.coveringForId ?? null,
    scheduledBetween: { from: occ.start, to: occ.end },
    startsAt: occ.start,
    now: input.at,
  });
  enqueueAudit(
    {
      actorUserId: input.userId,
      clientId: input.clientId,
      action: input.audit,
      entityType: 'OpsShift',
      entityId: shift.id,
      metadata: {
        locationId: ss.locationId,
        window: ss.label,
        template: ss.templateName,
        timeEntryId: input.timeEntryId,
        ...(input.coveringForId ? { coveringFor: input.coveringForId } : {}),
      },
    },
    'ops.shifts',
  );
  return shift;
}

/**
 * A supervisor clocked in: open the SOP of the store shift they're working.
 * Resumes (never duplicates) an SOP they already have open; opens nothing
 * when the store shift has no SOP assigned, or they're not a supervisor.
 *
 * A shift supervisor takes back an SOP a floor supervisor is running for
 * their shift. A floor supervisor's clock-in (always at the tablet) opens one only on a day
 * they've been handed the shift — otherwise they help on the lead's.
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
  if (!SOP_ROLES.has(input.role) || !input.clientId || !input.locationId) return null;
  const existing = await db.opsShift.findFirst({
    where: { openedById: input.userId, status: 'ACTIVE' },
    select: { id: true },
  });
  if (existing) return { shiftId: existing.id, resumed: true };

  const ss = await storeShiftAt(db, { userId: input.userId, locationId: input.locationId, at: input.at });
  if (!ss) return null;
  const occ = windowOccurrence(input.at, ss, ss.timezone);
  const sops = await occurrenceSops(db, ss, occ.end);

  if (input.role === 'FLOOR_SUPERVISOR') {
    // Theirs to run only when their shift supervisor handed them the day —
    // and nobody has it (or had it) already.
    const cover = await activeCoverFor(db, {
      coverUserId: input.userId,
      dateKey: dateKeyInZone(occ.start, ss.timezone),
    });
    if (!cover || sops.length > 0) return null;
    const shift = await openStoreShiftSop(db, {
      ss,
      occ,
      clientId: input.clientId,
      userId: input.userId,
      timeEntryId: input.timeEntryId,
      coveringForId: cover.leadUserId,
      at: input.at,
      audit: 'ops.shift_cover_opened',
    });
    void notifyUser(input.userId, {
      subject: `You're covering ${firstName(cover.lead)}'s ${ss.label} shift — the SOP is open`,
      body:
        `${ss.locationName} · ${ss.label} (${fmtShiftWindow(ss)}). Read the previous shift's notes, work ` +
        `the checklist, and submit it — with your handover — before you clock out.`,
      category: 'ops.sop',
      linkUrl: `/ops?tab=shift&shift=${shift.id}`,
    });
    return { shiftId: shift.id, resumed: false };
  }

  // The shift supervisor is here: an SOP a floor supervisor is running for
  // this shift comes back to them — checked items stay checked.
  const byFloor = sops.find((x) => x.status === 'ACTIVE' && x.openedBy.role === 'FLOOR_SUPERVISOR');
  if (byFloor) {
    await db.opsShift.update({
      where: { id: byFloor.id },
      data: { openedById: input.userId, coveringForId: null, timeEntryId: input.timeEntryId },
    });
    enqueueAudit(
      {
        actorUserId: input.userId,
        clientId: input.clientId,
        action: 'ops.shift_taken_back',
        entityType: 'OpsShift',
        entityId: byFloor.id,
        metadata: { from: byFloor.openedById, window: ss.label, timeEntryId: input.timeEntryId },
      },
      'ops.shifts',
    );
    const lead = await db.user.findUnique({
      where: { id: input.userId },
      select: { email: true, associate: { select: { firstName: true, lastName: true } } },
    });
    const leadName = lead ? personName(lead) : 'Your shift supervisor';
    void notifyUser(byFloor.openedById, {
      subject: `${leadName} took the ${ss.label} SOP back`,
      body:
        `${leadName} is on the clock and is running the ${ss.label} SOP now — everything you checked ` +
        `stays checked. It no longer holds your clock-out.`,
      category: 'ops.sop',
      linkUrl: `/ops?tab=shift&shift=${byFloor.id}`,
    });
    void notifyUser(input.userId, {
      subject: `The ${ss.label} SOP is back with you`,
      body:
        `${personName(byFloor.openedBy)} was running it while you were out. Pick up where they left off, ` +
        `then submit it — with your handover — before you clock out.`,
      category: 'ops.sop',
      linkUrl: `/ops?tab=shift&shift=${byFloor.id}`,
    });
    return { shiftId: byFloor.id, resumed: true };
  }
  // Their floor supervisor already ran it and submitted it for them.
  if (sops.some((x) => x.status === 'CLOSED' && x.coveringForId === input.userId)) return null;

  const shift = await openStoreShiftSop(db, {
    ss,
    occ,
    clientId: input.clientId,
    userId: input.userId,
    timeEntryId: input.timeEntryId,
    at: input.at,
    audit: 'ops.shift_auto_opened',
  });
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

/** The SOP a supervisor must submit before they may clock out, if any —
 *  for a floor supervisor, only one they're running (covering). */
export async function sopBlockingClockOut(
  db: Db,
  user: { id: string; role: string },
): Promise<{ id: string; windowLabel: string | null; position: string } | null> {
  if (!SOP_ROLES.has(user.role)) return null;
  return db.opsShift.findFirst({
    where: { openedById: user.id, status: 'ACTIVE' },
    select: { id: true, windowLabel: true, position: true },
    orderBy: { openedAt: 'desc' },
  });
}

/**
 * The store shift SOP no shift supervisor showed up for. For every floor
 * supervisor on the clock at a store, the store shift they're working:
 *   - handed the day (ShiftCover) → it opens for them now
 *   - otherwise, 30 minutes in with no shift supervisor for it on the
 *     clock (their own lead, or anyone who leads that window) → it opens
 *     for them, and their lead and the Workforce desk are told
 * Never a second SOP for a shift that has one, running or submitted.
 * First clocked in wins when several floor supervisors are on.
 */
export async function runSopCoverSweep(
  db: PrismaClient = defaultPrisma,
  now: Date = new Date(),
): Promise<{ opened: number }> {
  const onClock = await db.user.findMany({
    where: {
      role: 'FLOOR_SUPERVISOR',
      status: 'ACTIVE',
      deletedAt: null,
      clientId: { not: null },
      associate: { timeEntries: { some: { status: 'ACTIVE' } } },
    },
    select: {
      id: true,
      email: true,
      clientId: true,
      leadUserId: true,
      associate: {
        select: {
          firstName: true,
          lastName: true,
          timeEntries: {
            where: { status: 'ACTIVE' },
            select: { id: true, clientId: true, locationId: true, clockInAt: true },
            orderBy: { clockInAt: 'desc' },
            take: 1,
          },
        },
      },
    },
    take: 500,
  });
  const queue = onClock
    .map((u) => ({ u, entry: u.associate?.timeEntries[0] ?? null }))
    .filter((x): x is { u: (typeof onClock)[number]; entry: NonNullable<typeof x.entry> } => !!x.entry?.locationId)
    .sort((a, b) => a.entry.clockInAt.getTime() - b.entry.clockInAt.getTime());

  let opened = 0;
  for (const { u, entry } of queue) {
    try {
      const mine = await db.opsShift.findFirst({
        where: { openedById: u.id, status: 'ACTIVE' },
        select: { id: true },
      });
      if (mine) continue;
      const ss = await storeShiftAt(db, { userId: u.id, locationId: entry.locationId!, at: now });
      if (!ss) continue;
      const occ = windowOccurrence(now, ss, ss.timezone);
      if (now.getTime() >= occ.end.getTime()) continue;
      if ((await occurrenceSops(db, ss, occ.end)).length > 0) continue;

      const clientId = entry.clientId ?? u.clientId!;
      const cover = await activeCoverFor(db, {
        coverUserId: u.id,
        dateKey: dateKeyInZone(occ.start, ss.timezone),
      });
      const lead = cover ? cover.lead : await validLead(db, u);
      if (!cover) {
        if (now.getTime() < occ.start.getTime() + FALLBACK_MIN * MIN_MS) continue;
        // Anyone who should be running it — their lead, or a shift
        // supervisor who leads this window — on the clock? Then it's theirs.
        const windowLeads = (await ledWindows(db, { clientId }, now))
          .filter((w) => w.locationId === ss.locationId && w.label === ss.label)
          .map((w) => w.userId);
        const responsible = [...new Set([...(lead ? [lead.id] : []), ...windowLeads])];
        if (responsible.length > 0) {
          const present = await db.timeEntry.count({
            where: { status: 'ACTIVE', associate: { user: { id: { in: responsible } } } },
          });
          if (present > 0) continue;
        }
      }

      const shift = await openStoreShiftSop(db, {
        ss,
        occ,
        clientId,
        userId: u.id,
        timeEntryId: entry.id,
        coveringForId: lead?.id ?? null,
        at: now,
        audit: cover ? 'ops.shift_cover_opened' : 'ops.shift_fallback_opened',
      });
      opened += 1;
      const name = personName({ email: u.email, associate: u.associate });
      const leadName = lead ? personName(lead) : null;
      const link = `/ops?tab=shift&shift=${shift.id}`;
      if (cover) {
        void notifyUser(u.id, {
          subject: `You're covering ${firstName(cover.lead)}'s ${ss.label} shift — the SOP is open`,
          body:
            `${ss.locationName} · ${ss.label} (${fmtShiftWindow(ss)}). Read the previous shift's notes, work ` +
            `the checklist, and submit it — with your handover — before you clock out.`,
          category: 'ops.sop',
          linkUrl: link,
        });
        continue;
      }
      void notifyUser(u.id, {
        subject: `The ${ss.label} SOP is yours today`,
        body:
          `${leadName ?? 'No shift supervisor'} ${leadName ? "isn't" : 'is'} on the clock ${FALLBACK_MIN} minutes into the ` +
          `${ss.label} shift at ${ss.locationName}, so the SOP moved to you. Read the previous shift's notes, work ` +
          `the checklist, and submit it — with your handover — before you clock out.` +
          (leadName ? ` If ${firstName(lead!)} clocks in, it goes back to them.` : ''),
        category: 'ops.sop',
        linkUrl: link,
      });
      if (lead) {
        void notifyUser(lead.id, {
          subject: `${name} is running your ${ss.label} SOP`,
          body:
            `You weren't on the clock ${FALLBACK_MIN} minutes into the ${ss.label} shift at ${ss.locationName}, so ` +
            `${name} took the SOP. Clock in and it comes back to you — or hand them the shift ahead of time next time.`,
          category: 'ops.sop',
          linkUrl: link,
        });
      }
      void notifyWorkforce({
        subject: `SOP moved to a floor supervisor — ${ss.locationName} · ${ss.label}`,
        body:
          `${leadName ? `${leadName} wasn't` : 'No shift supervisor was'} on the clock ${FALLBACK_MIN} minutes into the ` +
          `${ss.label} shift, and nobody handed the shift over. ${name} (floor supervisor) is running the SOP.`,
        category: 'ops.sop_fallback',
        linkUrl: '/ops?tab=board',
      });
    } catch (err) {
      console.warn('[ops] SOP cover sweep:', u.id, err instanceof Error ? err.message : err);
    }
  }
  return { opened };
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
  // The library is current before any clock-in opens an SOP from it.
  void ensureOpsSeed(defaultPrisma).catch((err) => {
    console.error('[alto-people/api] SOP library seed failed:', err);
  });
  const seconds = env.OPS_SOP_SWEEP_SECONDS;
  if (seconds <= 0) return;
  const run = () => {
    // Covers first: an SOP that moves to a floor supervisor this tick is
    // reminded and escalated like any other from the next one.
    void runSopCoverSweep()
      .then(() => runOpsSopSweep())
      .catch((err) => {
        console.error('[alto-people/api] store-shift SOP sweep failed:', err);
      });
  };
  timer = setInterval(run, seconds * 1000);
  timer.unref();
  console.log(`[alto-people/api] store-shift SOP sweep armed (every ${seconds}s)`);
}
