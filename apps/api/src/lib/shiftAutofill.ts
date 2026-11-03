// The auto-fill engine — automation acts first, humans handle only the
// exceptions. Every sweep: each published OPEN shift starting within 48
// hours gets broadcast to the eligible bench (active associates placed
// at that client, no overlapping assigned shift, with a portal login),
// each invited exactly once per shift, with a one-tap pickup link into
// the open-shifts marketplace. The supervisor's queue item only remains
// for shifts the machine couldn't fill — and says the bench was already
// asked.
//
// One message per person per sweep, however many shifts it offers them, and
// at most one invitation email a day (owner, 2026-11-02): one message per
// open shift was 2,683 emails in 14 days to 174 associates — five or more on
// 153 person-days, ten or more on 54 — often the same words for the same
// slot. Past the day's first email, the bell and the lock screen carry it.

import type { PrismaClient } from '@prisma/client';
import { tenantJob } from './tenantJobs.js';
import { prisma as defaultPrisma } from '../db.js';
import { benchFor } from './scope.js';
import { notifyUser } from './notify.js';
import { INVITE_CATEGORY, invitedByEmailToday, inviteMessage, inviteZone, recordInvites, type InviteShift } from './openShiftInvites.js';
import { formatDateInZone, formatTimeInZone } from './timezone.js';
import { runShiftFill } from './workforceAgent.js';
import { runScheduleRepair } from './scheduleRepair.js';
import { runAttendanceConfirm } from './attendanceConfirm.js';
import { runCoverageForecast } from './coverageForecast.js';
import { logger } from './logger.js';

const SWEEP_SECONDS = 15 * 60;
const HORIZON_MS = 48 * 3600_000;
const MAX_INVITES_PER_SHIFT_PER_SWEEP = 20;
const CATEGORY = INVITE_CATEGORY;
/** A batched invitation names this many shifts; the rest are "and N more". */
const LISTED_PER_MESSAGE = 3;


export interface AutofillResult {
  shiftsScanned: number;
  /** Invitations recorded this sweep: one per person per shift. */
  invitesSent: number;
  /** Messages sent this sweep: one per person, however many shifts it offers. */
  messagesSent: number;
}

/**
 * The words for every shift a person is newly offered in one sweep. One
 * shift reads exactly as the single invitation always has (inviteMessage,
 * linked to that shift); more are listed soonest first — day, time, position
 * and store, on each store's own clock — up to three, then "and N more",
 * linked to the marketplace. English only, like the single invitation.
 */
export function batchedInviteMessage(shifts: readonly InviteShift[]): { subject: string; body: string; linkUrl: string } {
  if (shifts.length === 1) return inviteMessage(shifts[0]!);
  const sorted = [...shifts].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  const lines = sorted.slice(0, LISTED_PER_MESSAGE).map((shift) => {
    const tz = inviteZone(shift);
    const where = shift.client?.name ?? shift.locationRel?.name ?? shift.location ?? '';
    const when = `${formatDateInZone(shift.startsAt, tz)}, ${formatTimeInZone(shift.startsAt, tz)}–${formatTimeInZone(shift.endsAt, tz)}`;
    const spot = shift.location && shift.location !== where ? ` · ${shift.location}` : '';
    return `• ${when} · ${shift.position}${where ? ` at ${where}` : ''}${spot}`;
  });
  const more = sorted.length - LISTED_PER_MESSAGE;
  return {
    subject: `${sorted.length} open shifts you can pick up`,
    body: `${lines.join('\n')}${more > 0 ? `\nand ${more} more` : ''}\nFirst come, first served — tap to see them.`,
    linkUrl: '/marketplace',
  };
}


export async function runShiftAutofillSweep(
  prisma: PrismaClient = defaultPrisma,
  now: Date = new Date(),
  opts: { clientId?: string } = {},
): Promise<AutofillResult> {
  const shifts = await prisma.shift.findMany({
    where: {
      publishedAt: { not: null },
      status: 'OPEN',
      assignedAssociateId: null,
      startsAt: { gt: now, lt: new Date(now.getTime() + HORIZON_MS) },
      ...(opts.clientId ? { clientId: opts.clientId } : {}),
    },
    select: {
      id: true,
      clientId: true,
      locationId: true,
      position: true,
      startsAt: true,
      endsAt: true,
      location: true,
      client: { select: { name: true } },
      locationRel: { select: { name: true, timezone: true } },
    },
    take: 100,
  });
  let invitesSent = 0;
  // Per person, every shift they are newly offered this sweep; per shift,
  // who was asked (the invite rows are written per shift, as before).
  const offers = new Map<string, InviteShift[]>();
  const askedByShift: Array<{ shiftId: string; associateIds: string[] }> = [];

  for (const shift of shifts) {
    // The bench is the client's people, or the site's for a shift that names
    // no client (a direct employer); a shift naming neither has no bench
    // (lib/scope.benchFor, fail closed).
    const bench = benchFor(shift);
    if (!bench) continue;
    const linkUrl = `/marketplace?shift=${shift.id}`;
    // Eligible bench: active-approved associates placed at this client or
    // site with a portal login, not already working an overlapping shift.
    const candidates = await prisma.user.findMany({
      where: {
        role: 'ASSOCIATE',
        status: 'ACTIVE',
        deletedAt: null,
        associate: {
          deletedAt: null,
          erasedAt: null,
          separatedAt: null,
          deactivatedAt: null,
          // At this client (or site) now — a transferred associate is
          // theirs, not the old client's (lib/scope.atClient / placedAtSite).
          AND: [bench],
          assignedShifts: {
            none: {
              status: { notIn: ['CANCELLED'] },
              startsAt: { lt: shift.endsAt },
              endsAt: { gt: shift.startsAt },
            },
          },
        },
      },
      select: { id: true, associateId: true },
      take: 60,
    });
    if (candidates.length === 0) continue;
    // Invite each person once per shift. The invite row is the record (it
    // feeds the managers' sent/declined counts); the notification stays a
    // second dedup key for invitations sent before the rows existed. Someone
    // who said "Not for me" is not asked again.
    const [already, rows] = await Promise.all([
      prisma.notification.findMany({
        where: {
          recipientUserId: { in: candidates.map((c) => c.id) },
          category: CATEGORY,
          linkUrl,
        },
        select: { recipientUserId: true },
      }),
      prisma.openShiftInvite.findMany({
        where: { shiftId: shift.id, associateId: { in: candidates.flatMap((c) => (c.associateId ? [c.associateId] : [])) } },
        select: { associateId: true, sendCount: true, declinedAt: true },
      }),
    ]);
    const invited = new Set(already.map((n) => n.recipientUserId));
    const handled = new Set(rows.filter((r) => r.sendCount > 0 || r.declinedAt).map((r) => r.associateId));
    const asked: string[] = [];
    let sentForShift = 0;
    for (const c of candidates) {
      if (invited.has(c.id) || (c.associateId && handled.has(c.associateId))) continue;
      if (sentForShift >= MAX_INVITES_PER_SHIFT_PER_SWEEP) break;
      offers.set(c.id, [...(offers.get(c.id) ?? []), shift]);
      if (c.associateId) asked.push(c.associateId);
      sentForShift += 1;
      invitesSent += 1;
    }
    askedByShift.push({ shiftId: shift.id, associateIds: asked });
  }

  // One message per person, then the invite rows per shift.
  const emailedToday = await invitedByEmailToday(prisma, [...offers.keys()], now);
  for (const [userId, theirs] of offers) {
    await notifyUser(userId, {
      ...batchedInviteMessage(theirs),
      category: CATEGORY,
      ...(emailedToday.has(userId) ? { skipEmail: true } : {}),
    });
  }
  for (const a of askedByShift) await recordInvites(prisma, a.shiftId, a.associateIds, now);
  return { shiftsScanned: shifts.length, invitesSent, messagesSent: offers.size };
}

export { invitedByEmailToday };

let timer: NodeJS.Timeout | null = null;

/**
 * One tick per tenant: the broadcast asks the bench, then the Workforce agent
 * proposes for what is still open (shift.fill), runs the repair backstop
 * (schedule.repair: leave no event reached, held approvals, moot proposals)
 * asks tomorrow's high-risk holders (attendance.confirm) and writes the day's
 * coverage forecast once per site (coverage.forecast).
 */
async function autofillTick(): Promise<void> {
  await runShiftAutofillSweep();
  await runShiftFill();
  await runScheduleRepair();
  await runAttendanceConfirm();
  await runCoverageForecast();
}

export function startShiftAutofillCron(): void {
  if (timer) return;
  void tenantJob('shiftAutofill', autofillTick)().catch((err) => {
    console.error('[alto-people/api] shift autofill sweep failed:', err);
  });
  timer = setInterval(() => {
    void tenantJob('shiftAutofill', autofillTick)().catch((err) => {
      console.error('[alto-people/api] shift autofill sweep failed:', err);
    });
  }, SWEEP_SECONDS * 1000);
  timer.unref();
  logger.info(
    `shift auto-fill cron armed (every ${SWEEP_SECONDS}s, 48h horizon)`,
  );
}

export function stopShiftAutofillCron(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
