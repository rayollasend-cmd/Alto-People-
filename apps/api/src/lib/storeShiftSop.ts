import type { OpsPeriod, OpsShift, Prisma, PrismaClient } from '@prisma/client';
import { tenantJob } from './tenantJobs.js';
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

/** One SOP a supervisor is carrying on this window. */
export interface StoreShiftSopRef {
  templateId: string;
  templateName: string;
  department: string;
  period: OpsPeriod;
}

export interface StoreShift {
  locationId: string;
  locationName: string;
  timezone: string;
  label: string;
  startMinute: number;
  endMinute: number;
  /**
   * EVERY SOP on this window — one per department Alto staffs in this
   * store. A supervisor works one shift across all of them; this used to
   * be a single template, which made the rest structurally impossible.
   */
  sops: StoreShiftSopRef[];
  /** The first, for the shift's filed department and display name. */
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
 *
 * WHICH STORE, THOUGH.
 *
 * The locationId handed in comes from the punch, and the punch gets it
 * from resolveAssociateGeofence: the associate's open assignment, or —
 * when they have none — the client's OLDEST active Location. For a
 * supervisor that is a guess, and at a client with more than one store it
 * is usually the wrong one: the SOP is assigned to a store
 * (StoreShiftSop), the supervisor's shift is assigned to a store
 * (SupervisorShiftWindow), and nothing reconciled either with the store
 * the punch happened to name. The SOP was assigned, the supervisor
 * clocked in, and nothing opened — a null return here reads as "no SOP
 * configured at this store", which was true of the store we looked at and
 * not of the one they were standing in.
 *
 * So: try the punch's store first, and only if that yields nothing, fall
 * back to a store this user is assigned to lead a live window at. Second,
 * not first — a supervisor covering a sibling store today is punched in
 * THERE, and that punch should keep winning over their usual assignment.
 * Changing behaviour only where the answer was previously null means this
 * cannot break a case that already worked.
 */
export async function storeShiftAt(
  db: Db,
  input: { userId: string; locationId: string; at: Date },
): Promise<StoreShift | null> {
  const here = await storeShiftAtLocation(db, input);
  if (here) return here;

  for (const w of await ledWindows(db, { userId: input.userId }, input.at)) {
    if (w.locationId === input.locationId) continue; // already tried
    const minute = minuteOfDayInZone(new Date(input.at.getTime() + EARLY_MIN * MIN_MS), w.timezone);
    if (!inShiftWindow(minute, w)) continue;
    const led = await storeShiftAtLocation(db, { ...input, locationId: w.locationId });
    if (led) return led;
  }
  return null;
}

async function storeShiftAtLocation(
  db: Db,
  input: { userId: string; locationId: string; at: Date },
): Promise<StoreShift | null> {
  const [loc, defs, assigned] = await Promise.all([
    db.site.findUnique({
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
  // A label can now carry several SOPs — one per department.
  const sopsByLabel = new Map<string, typeof assigned[number]['template'][]>();
  for (const a of assigned) {
    if (!a.template.active || a.template.retiredAt) continue;
    const list = sopsByLabel.get(a.label);
    if (list) list.push(a.template);
    else sopsByLabel.set(a.label, [a.template]);
  }
  const minute = minuteOfDayInZone(new Date(input.at.getTime() + EARLY_MIN * MIN_MS), loc.timezone);
  const candidates = [...defs.values()].filter((w) => sopsByLabel.has(w.label) && inShiftWindow(minute, w));
  if (candidates.length === 0) return null;
  const mine = new Set(
    (await ledWindows(db, { userId: input.userId }, input.at))
      .filter((w) => w.locationId === input.locationId)
      .map((w) => w.label),
  );
  const pick = candidates.find((w) => mine.has(w.label)) ?? candidates[0]!;
  // Every SOP on the window they are working, ordered so the shift is
  // filed under the same department run to run rather than whichever row
  // the database happened to return first.
  const sops = [...sopsByLabel.get(pick.label)!]
    .sort((a, b) => a.department.localeCompare(b.department))
    .map((t) => ({
      templateId: t.id,
      templateName: t.name,
      department: t.department,
      period: t.period,
    }));
  const primary = sops[0]!;
  return {
    locationId: loc.id,
    locationName: loc.name,
    timezone: loc.timezone,
    label: pick.label,
    startMinute: pick.startMinute,
    endMinute: pick.endMinute,
    sops,
    templateId: primary.templateId,
    templateName: primary.templateName,
    department: primary.department,
    period: primary.period,
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
    /**
     * Every SOP this shift carries — one per department the supervisor is
     * covering in this store. Supersedes `templateId` when present; the
     * first is the primary the shift is filed under.
     */
    templateIds?: string[] | null;
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
  const [scheduledHeadcount, actualHeadcount, templates, location] = await Promise.all([
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
    input.templateIds?.length
      ? db.opsSopTemplate
          .findMany({
            where: { id: { in: input.templateIds } },
            include: { tasks: { orderBy: { order: 'asc' } } },
          })
          // findMany does not preserve the order asked for, and the order
          // decides which department the shift is filed under.
          .then((rows) =>
            input
              .templateIds!.map((id) => rows.find((r) => r.id === id))
              .filter((r): r is (typeof rows)[number] => !!r),
          )
      : input.templateId
        ? db.opsSopTemplate
            .findUnique({
              where: { id: input.templateId },
              include: { tasks: { orderBy: { order: 'asc' } } },
            })
            .then((t) => (t ? [t] : []))
        : db.opsSopTemplate
            .findFirst({
              where: { department: input.department, period: input.period, active: true, retiredAt: null },
              orderBy: { createdAt: 'asc' },
              include: { tasks: { orderBy: { order: 'asc' } } },
            })
            .then((t) => (t ? [t] : [])),
    input.locationId
      ? db.site.findUnique({ where: { id: input.locationId }, select: { timezone: true } })
      : Promise.resolve(null),
  ]);
  const primary = templates[0] ?? null;
  const multi = templates.length > 1;

  /**
   * One checklist, sectioned by department.
   *
   * The tasks of every SOP the supervisor is carrying are merged into a
   * single shift — one open, one close, one handover, because that is
   * what actually happens: one person, one tour of the floor. The section
   * carries the department so the list reads as "Grocery / Front End"
   * rather than an undifferentiated pile, and `order` is offset per
   * template so the merged list is stable instead of interleaved by
   * whatever each template numbered its own rows.
   */
  const tz = location?.timezone ?? DEFAULT_TIMEZONE;
  const startsAt = input.startsAt ?? now;
  const taskRows: Record<string, unknown>[] = [];
  let orderBase = 0;
  for (const t of templates) {
    // "By 9:00 AM" becomes 9:00 AM on this shift's clock, at the store.
    const due = dueInstants(t.tasks.map((task) => task.dueTime), startsAt, tz);
    t.tasks.forEach((task, i) => {
      taskRows.push({
        source: 'SOP' as const,
        templateTaskId: task.id,
        // Only qualify when there is something to tell apart; a
        // single-department shift keeps the template's own sections.
        section: multi
          ? task.section
            ? `${t.department} · ${task.section}`
            : t.department
          : task.section,
        order: orderBase + task.order,
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
      });
    });
    orderBase += 1000;
  }

  // The coverage ledger. Sorted and de-duplicated so the same tour reads
  // the same way every night.
  const departments = [...new Set(templates.map((t) => t.department))].sort();
  return db.opsShift.create({
    data: {
      clientId: input.clientId,
      department: primary?.department ?? input.department,
      departments: departments.length > 0 ? departments : [input.department],
      period: input.period,
      position: input.position,
      dateKey,
      openedById: input.openedById,
      scheduledHeadcount,
      actualHeadcount,
      templateId: primary?.id ?? null,
      // Shown to the client portal, so it must describe what ran. One
      // template's name on a shift that carried three is a quiet lie.
      templateName: multi
        ? `${primary!.name} +${templates.length - 1} more`
        : (primary?.name ?? null),
      locationId: input.locationId ?? null,
      windowLabel: input.windowLabel ?? null,
      timeEntryId: input.timeEntryId ?? null,
      dueAt: input.dueAt ?? null,
      coveringForId: input.coveringForId ?? null,
      tasks: taskRows.length > 0 ? { create: taskRows as never } : undefined,
    },
  });
}

/** The SOP of one store shift occurrence — (store, window, end) — newest
 *  first, whoever runs it. */
function occurrenceSops(db: Db, ss: Pick<StoreShift, 'locationId' | 'label'>, end: Date) {
  return db.opsShift.findMany({
    // A cancelled one never happened. Counting it here would mean HR
    // voiding a mistake permanently blocks that occurrence from ever
    // getting its real SOP — the opposite of why they cancelled it.
    where: {
      locationId: ss.locationId,
      windowLabel: ss.label,
      dueAt: end,
      status: { not: 'CANCELLED' },
    },
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
export async function openStoreShiftSop(
  db: Db,
  input: {
    ss: StoreShift;
    occ: { start: Date; end: Date };
    clientId: string;
    userId: string;
    timeEntryId?: string | null;
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
    // Every department this supervisor is covering on this window, not
    // just whichever SOP happened to be found first.
    templateIds: ss.sops.map((x) => x.templateId),
    locationId: ss.locationId,
    windowLabel: ss.label,
    timeEntryId: input.timeEntryId ?? null,
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
        // The coverage ledger, in the audit trail too: what this shift
        // was actually carrying when it opened.
        departments: ss.sops.map((x) => x.department),
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
  if (!ss) {
    // Say so. This returned a bare null for every reason at once — the
    // store has no SOPs, the window is not running, the punch named the
    // wrong store, the template was retired — and the supervisor just saw
    // nothing open. It took someone noticing and asking to find out which.
    // One line, only when the client HAS store shifts configured, so a
    // client that simply does not use SOPs stays quiet.
    const configured = await db.storeShiftSop.count({
      where: { location: { is: { clientId: input.clientId } } },
    });
    if (configured > 0) {
      console.warn(
        '[ops] no store shift SOP opened on clock-in',
        JSON.stringify({
          userId: input.userId,
          role: input.role,
          punchLocationId: input.locationId,
          clientId: input.clientId,
          at: input.at.toISOString(),
          clientHasAssignedSops: configured,
        }),
      );
    }
    return null;
  }
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

/** An SOP still open this long after its shift ended is closed by the
 *  expiry sweep as "Expired — not submitted": nobody is waiting on a
 *  handover from a shift that ended yesterday, and it must never hold a
 *  later clock-out hostage. */
export const SOP_EXPIRY_MS = 12 * 60 * MIN_MS;
/** An SOP opened by hand has no window end; it counts as ended this long
 *  after it opened. */
const MANUAL_SOP_SPAN_MS = 12 * 60 * MIN_MS;

/** When this SOP's shift ended (or, opened by hand, is taken to have). */
function sopShiftEnd(s: { dueAt: Date | null; openedAt: Date }): Date {
  return s.dueAt ?? new Date(s.openedAt.getTime() + MANUAL_SOP_SPAN_MS);
}

/** Whether an open SOP is past the point the sweep expires it. */
export function sopExpired(s: { dueAt: Date | null; openedAt: Date }, now: Date = new Date()): boolean {
  return now.getTime() >= sopShiftEnd(s).getTime() + SOP_EXPIRY_MS;
}

export interface BlockingSop {
  id: string;
  windowLabel: string | null;
  position: string;
  /** For the kiosk's "submit it incomplete" screen. */
  dateKey: string;
  dueAt: Date | null;
}

/** The SOP a supervisor must submit before they may clock out, if any —
 *  for a floor supervisor, only one they're running (covering).
 *
 *  Only THIS shift's SOP holds the clock: one whose window ends after the
 *  clock-in being closed began (or that this clock-in opened). An earlier
 *  shift's SOP left open — the supervisor forgot it last week — never
 *  traps today's clock-out; the escalation and the expiry sweep chase it.
 *  With no open clock-in (a role switch, a sign-out), any SOP not yet
 *  expired still counts, as before. */
export async function sopBlockingClockOut(
  db: Db,
  user: { id: string; role: string },
  now: Date = new Date(),
): Promise<BlockingSop | null> {
  if (!SOP_ROLES.has(user.role)) return null;
  const open = await db.opsShift.findMany({
    where: { openedById: user.id, status: 'ACTIVE' },
    select: { id: true, windowLabel: true, position: true, dateKey: true, dueAt: true, openedAt: true, timeEntryId: true },
    orderBy: { openedAt: 'desc' },
    take: 20,
  });
  const live = open.filter((s) => !sopExpired(s, now));
  if (live.length === 0) return null;
  const me = await db.user.findUnique({ where: { id: user.id }, select: { associateId: true } });
  const entry = me?.associateId
    ? await db.timeEntry.findFirst({
        where: { associateId: me.associateId, status: 'ACTIVE' },
        orderBy: { clockInAt: 'desc' },
        select: { id: true, clockInAt: true },
      })
    : null;
  const mine = entry
    ? live.filter(
        (s) =>
          s.timeEntryId === entry.id ||
          (s.dueAt
            ? s.dueAt.getTime() > entry.clockInAt.getTime()
            : s.openedAt.getTime() >= entry.clockInAt.getTime() - EARLY_MIN * MIN_MS),
      )
    : live;
  const s = mine[0];
  return s ? { id: s.id, windowLabel: s.windowLabel, position: s.position, dateKey: s.dateKey, dueAt: s.dueAt } : null;
}

async function sopCounts(db: Db, shiftId: string) {
  const rows = await db.opsTask.groupBy({
    by: ['source', 'status'],
    where: { opsShiftId: shiftId },
    _count: { _all: true },
  });
  let sopTotal = 0;
  let sopDone = 0;
  let taskTotal = 0;
  let taskDone = 0;
  for (const r of rows) {
    const n = r._count._all;
    taskTotal += n;
    if (r.status === 'DONE') taskDone += n;
    if (r.source === 'SOP') {
      sopTotal += n;
      if (r.status === 'DONE') sopDone += n;
    }
  }
  return { sopTotal, sopDone, taskTotal, taskDone };
}

/** What the kiosk shows on its "your SOP is still open" screen. */
export async function sopBlockSummary(db: Db, sop: BlockingSop) {
  const [requiredOpen, counts] = await Promise.all([
    db.opsTask.count({ where: { opsShiftId: sop.id, required: true, status: { not: 'DONE' } } }),
    sopCounts(db, sop.id),
  ]);
  return {
    sopId: sop.id,
    label: sop.windowLabel ? `${sop.windowLabel} SOP` : `SOP for ${sop.position}`,
    windowLabel: sop.windowLabel,
    dateKey: sop.dateKey,
    requiredOpen,
    sopDone: counts.sopDone,
    sopTotal: counts.sopTotal,
  };
}

/**
 * The kiosk's way out of the clock-out gate: submit the SOP as it stands,
 * with a written reason (and, optionally, a note for the next shift). The
 * same record the app's "submit incomplete" writes — counts stamped, the
 * reason kept, leadership told — so a supervisor at the tablet with no
 * phone is never trapped on the clock. Unread handover notes from the
 * previous shift don't block here (they do in the app): this is the exit.
 */
export async function submitSopAtKiosk(
  db: Db,
  input: { sopId: string; userId: string; reason: string; handoverNote?: string | null; at?: Date },
): Promise<{ closedIncomplete: boolean }> {
  const at = input.at ?? new Date();
  const shift = await db.opsShift.findFirst({
    where: { id: input.sopId, openedById: input.userId, status: 'ACTIVE' },
    select: {
      id: true,
      clientId: true,
      locationId: true,
      windowLabel: true,
      position: true,
      department: true,
      dateKey: true,
      coveringForId: true,
      location: { select: { name: true } },
    },
  });
  if (!shift) return { closedIncomplete: false };
  const note = input.handoverNote?.trim() ?? '';
  if (note) {
    await db.opsHandoverItem.create({ data: { fromShiftId: shift.id, kind: 'NOTE', body: note.slice(0, 1000), priority: 'MEDIUM' } });
  }
  const [counts, requiredOpen, handoverCount] = await Promise.all([
    sopCounts(db, shift.id),
    db.opsTask.count({ where: { opsShiftId: shift.id, required: true, status: { not: 'DONE' } } }),
    db.opsHandoverItem.count({ where: { fromShiftId: shift.id } }),
  ]);
  const closedIncomplete = requiredOpen > 0;
  const reason = input.reason.trim();
  // Conditional close: a second tablet (or the app) submitting at the same
  // moment leaves one record, not two.
  const closed = await db.opsShift.updateMany({
    where: { id: shift.id, status: 'ACTIVE' },
    data: {
      status: 'CLOSED',
      closedById: input.userId,
      closedAt: at,
      closingSummary: closedIncomplete ? `Submitted incomplete at the kiosk. ${reason}`.slice(0, 2000) : 'Submitted at the kiosk.',
      incompleteReason: closedIncomplete ? reason.slice(0, 1000) : null,
      handoverNone: handoverCount === 0,
      sopTotal: counts.sopTotal,
      sopDone: counts.sopDone,
      taskTotal: counts.taskTotal,
      taskDone: counts.taskDone,
      closedIncomplete,
    },
  });
  if (closed.count === 0) return { closedIncomplete: false };
  enqueueAudit(
    {
      actorUserId: input.userId,
      clientId: shift.clientId,
      action: 'ops.shift_closed',
      entityType: 'OpsShift',
      entityId: shift.id,
      metadata: {
        via: 'kiosk',
        department: shift.department,
        sop: `${counts.sopDone}/${counts.sopTotal}`,
        tasks: `${counts.taskDone}/${counts.taskTotal}`,
        closedIncomplete,
      },
    },
    'ops.shifts',
  );
  const label = shift.windowLabel ? `${shift.windowLabel} SOP` : `SOP for ${shift.position}`;
  if (closedIncomplete) {
    void notifyAllAdmins({
      subject: `Ops shift closed incomplete — ${shift.position}`,
      body:
        `${label} (${shift.dateKey}${shift.location?.name ? ` · ${shift.location.name}` : ''}) was submitted at the kiosk ` +
        `with ${requiredOpen} required item${requiredOpen === 1 ? '' : 's'} unfinished. SOP ${counts.sopDone}/${counts.sopTotal}. ` +
        `Reason: ${reason}`,
      category: 'ops.incomplete_close',
      linkUrl: `/ops?tab=board&record=${shift.id}`,
    });
  }
  if (shift.coveringForId && shift.coveringForId !== input.userId) {
    void notifyUser(shift.coveringForId, {
      subject: `Your ${label} was submitted at the kiosk`,
      body:
        `${shift.dateKey}: ${counts.sopDone} of ${counts.sopTotal} done` +
        (closedIncomplete ? `, submitted incomplete — ${reason}` : '') +
        `. ${handoverCount === 0 ? 'Nothing handed over.' : `${handoverCount} note${handoverCount === 1 ? '' : 's'} handed over.`}`,
      category: 'ops.sop',
      linkUrl: `/ops?tab=shift&record=${shift.id}`,
    });
  }
  return { closedIncomplete };
}

/**
 * SOPs still open long after their shift ended (end + 12h) close as
 * "Expired — not submitted": counts stamped as they stood, marked
 * incomplete with that reason, the supervisor told, and the store's
 * leadership (their lead, the Workforce desk) flagged — the record shows
 * the SOP was never submitted, and a stale SOP no longer reads as "live"
 * on the ops board or holds anyone's clock.
 */
export async function runSopExpirySweep(
  db: PrismaClient = defaultPrisma,
  now: Date = new Date(),
): Promise<{ expired: number }> {
  const open = await db.opsShift.findMany({
    where: {
      status: 'ACTIVE',
      OR: [
        { dueAt: { lte: new Date(now.getTime() - SOP_EXPIRY_MS) } },
        { dueAt: null, openedAt: { lte: new Date(now.getTime() - SOP_EXPIRY_MS - MANUAL_SOP_SPAN_MS) } },
      ],
    },
    select: {
      id: true,
      clientId: true,
      windowLabel: true,
      position: true,
      department: true,
      dateKey: true,
      openedById: true,
      coveringForId: true,
      location: { select: { name: true } },
      openedBy: { select: { email: true, associate: { select: { firstName: true, lastName: true } } } },
    },
    take: 500,
  });
  let expired = 0;
  for (const s of open) {
    try {
      const counts = await sopCounts(db, s.id);
      const closed = await db.opsShift.updateMany({
        where: { id: s.id, status: 'ACTIVE' },
        data: {
          status: 'CLOSED',
          closedAt: now,
          closedById: null,
          closedIncomplete: true,
          incompleteReason: 'Expired — not submitted. Closed automatically 12 hours after the shift ended.',
          handoverNone: true,
          sopTotal: counts.sopTotal,
          sopDone: counts.sopDone,
          taskTotal: counts.taskTotal,
          taskDone: counts.taskDone,
        },
      });
      if (closed.count === 0) continue;
      expired += 1;
      enqueueAudit(
        {
          actorUserId: null,
          clientId: s.clientId,
          action: 'ops.shift_expired',
          entityType: 'OpsShift',
          entityId: s.id,
          metadata: { department: s.department, sop: `${counts.sopDone}/${counts.sopTotal}`, dateKey: s.dateKey },
        },
        'ops.shifts',
      );
      const label = s.windowLabel ? `${s.windowLabel} SOP` : `SOP for ${s.position}`;
      const where = `${s.location?.name ?? 'the store'} · ${s.dateKey}`;
      const who = s.openedBy.associate ? `${s.openedBy.associate.firstName} ${s.openedBy.associate.lastName}` : s.openedBy.email;
      const link = `/ops?tab=board&record=${s.id}`;
      void notifyUser(s.openedById, {
        subject: `Your ${label} expired without being submitted`,
        body: `${where}: it was still open 12 hours after the shift ended, so it closed as "Expired — not submitted" (${counts.sopDone} of ${counts.sopTotal} done). It no longer holds your clock.`,
        category: 'ops.sop',
        linkUrl: link,
      });
      const flag = {
        subject: `SOP expired, never submitted — ${where}`,
        body: `${who}'s ${label} was never submitted (${counts.sopDone} of ${counts.sopTotal} done) and closed automatically 12 hours after the shift ended. No handover reached the next shift.`,
        category: 'ops.sop_expired',
        linkUrl: link,
      };
      if (s.coveringForId) void notifyUser(s.coveringForId, flag);
      void notifyWorkforce(flag);
    } catch (err) {
      console.warn('[ops] SOP expiry sweep:', s.id, err instanceof Error ? err.message : err);
    }
  }
  return { expired };
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
        linkUrl: `/ops?tab=board&record=${shift.id}`, // that shift's record, not the whole board
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
        linkUrl: `/ops?tab=board&record=${s.id}`,
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
    void tenantJob('storeShiftSop', () =>
      runSopCoverSweep()
        .then(() => runOpsSopSweep())
        .then(() => runSopExpirySweep()),
    )()
      .catch((err) => {
        console.error('[alto-people/api] store-shift SOP sweep failed:', err);
      });
  };
  timer = setInterval(run, seconds * 1000);
  timer.unref();
  console.log(`[alto-people/api] store-shift SOP sweep armed (every ${seconds}s)`);
}
