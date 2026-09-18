import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../db.js';
import { notifyUser } from './notify.js';

/**
 * Floor supervisors and the shift supervisor in charge of them.
 *
 * A FLOOR_SUPERVISOR is assigned a client, a shift (the store shift windows
 * they work — SupervisorShiftWindow, same as a shift supervisor), and ONE
 * shift supervisor at that client (User.leadUserId). The shift supervisor
 * sees their floor supervisors on My floor, hears first when one of them is
 * late, and hands them the shift — the SOP included — on days they're out
 * (ShiftCover).
 *
 * A link is only as good as what it points at: the lead must still be a
 * shift supervisor, not disabled or deleted, at the same client. One that
 * isn't reads as "no shift supervisor" everywhere — never as a stale name.
 */

type Db = PrismaClient | Prisma.TransactionClient;

/** A user row that can lead floor supervisors. INVITED counts: a lead can
 *  be assigned before they've accepted their invite. */
export const LEAD_WHERE = {
  role: 'SHIFT_SUPERVISOR',
  status: { in: ['ACTIVE', 'INVITED'] },
  deletedAt: null,
} satisfies Prisma.UserWhereInput;

/** A floor supervisor who still counts as someone's team. */
export const FLOOR_WHERE = {
  role: 'FLOOR_SUPERVISOR',
  status: { in: ['ACTIVE', 'INVITED'] },
  deletedAt: null,
} satisfies Prisma.UserWhereInput;

export function personName(u: {
  email: string;
  associate: { firstName: string; lastName: string } | null;
}): string {
  return u.associate
    ? `${u.associate.firstName} ${u.associate.lastName}`
    : (u.email.split('@')[0] ?? u.email);
}

export function firstName(u: {
  email: string;
  associate: { firstName: string; lastName: string } | null;
}): string {
  return u.associate?.firstName ?? personName(u);
}

const personSelect = {
  id: true,
  email: true,
  clientId: true,
  associateId: true,
  associate: { select: { firstName: true, lastName: true } },
} satisfies Prisma.UserSelect;

export type Person = Prisma.UserGetPayload<{ select: typeof personSelect }>;

/** The floor supervisor's shift supervisor — null when unassigned or the
 *  link no longer holds. */
export async function validLead(
  db: Db,
  floor: { leadUserId: string | null; clientId: string | null },
): Promise<Person | null> {
  if (!floor.leadUserId || !floor.clientId) return null;
  return db.user.findFirst({
    where: { id: floor.leadUserId, clientId: floor.clientId, ...LEAD_WHERE },
    select: personSelect,
  });
}

/** The floor supervisors a shift supervisor is in charge of (links that
 *  hold only), by name. */
export async function floorTeamOf(
  db: Db,
  lead: { id: string; clientId: string | null },
): Promise<Person[]> {
  if (!lead.clientId) return [];
  const rows = await db.user.findMany({
    where: { leadUserId: lead.id, clientId: lead.clientId, ...FLOOR_WHERE },
    select: personSelect,
  });
  return rows.sort((a, b) => personName(a).localeCompare(personName(b)));
}

/** The hand-over in force for a floor supervisor on a store day, if any. */
export async function activeCoverFor(
  db: Db,
  input: { coverUserId: string; dateKey: string },
) {
  return db.shiftCover.findFirst({
    where: {
      coverUserId: input.coverUserId,
      cancelledAt: null,
      fromDate: { lte: input.dateKey },
      toDate: { gte: input.dateKey },
      lead: { deletedAt: null },
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      leadUserId: true,
      fromDate: true,
      toDate: true,
      lead: { select: personSelect },
    },
  });
}

/** Is this user on the clock right now (an open time entry)? */
export async function onClockSince(
  db: Db,
  associateId: string | null,
): Promise<{ id: string; clockInAt: Date; locationId: string | null } | null> {
  if (!associateId) return null;
  return db.timeEntry.findFirst({
    where: { associateId, status: 'ACTIVE' },
    select: { id: true, clockInAt: true, locationId: true },
    orderBy: { clockInAt: 'desc' },
  });
}

/** Every active Workforce Manager — the field-leadership desk that hears
 *  when an SOP changes hands because nobody handed it over. */
export async function notifyWorkforce(opts: {
  subject: string;
  body: string;
  category: string;
  linkUrl?: string;
}): Promise<void> {
  const desk = await prisma.user.findMany({
    where: { role: 'WORKFORCE_MANAGER', status: 'ACTIVE', deletedAt: null },
    select: { id: true },
  });
  await Promise.all(desk.map((u) => notifyUser(u.id, opts)));
}

/** "Sat, Sep 20" · "Sat, Sep 20 – Mon, Sep 22" for a YYYY-MM-DD span. */
export function fmtDateSpan(from: string, to: string): string {
  const fmt = (ymd: string) => {
    const [y, m, d] = ymd.split('-').map(Number);
    return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });
  };
  return from === to ? fmt(from) : `${fmt(from)} – ${fmt(to)}`;
}

/**
 * A shift supervisor's time off was approved: ask who covers their SOP on
 * those days — unless a hand-over already spans them, or nobody reports to
 * them. The link opens My floor with the hand-over prefilled.
 */
export async function promptShiftHandover(req: {
  associateId: string;
  startDate: Date;
  endDate: Date;
}): Promise<void> {
  const lead = await prisma.user.findFirst({
    where: { associateId: req.associateId, ...LEAD_WHERE, status: 'ACTIVE' },
    select: { id: true, clientId: true },
  });
  if (!lead) return;
  const team = await floorTeamOf(prisma, lead);
  if (team.length === 0) return;
  const from = req.startDate.toISOString().slice(0, 10);
  const to = req.endDate.toISOString().slice(0, 10);
  const spanned = await prisma.shiftCover.findFirst({
    where: { leadUserId: lead.id, cancelledAt: null, fromDate: { lte: from }, toDate: { gte: to } },
    select: { id: true },
  });
  if (spanned) return;
  const names = team.map(firstName);
  const who = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
  await notifyUser(lead.id, {
    subject: `Who covers your SOP on ${fmtDateSpan(from, to)}?`,
    body:
      `Your time off is approved. Hand your shift to ${who} so the SOP opens for them when they clock in — ` +
      `otherwise it moves to whichever floor supervisor is on the clock 30 minutes into the shift.`,
    category: 'ops.sop',
    linkUrl: `/?handover=${from}..${to}`,
  });
}
