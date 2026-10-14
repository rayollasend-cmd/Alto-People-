// The auto-fill engine — automation acts first, humans handle only the
// exceptions. Every sweep: each published OPEN shift starting within 48
// hours gets broadcast to the eligible bench (active associates placed
// at that client, no overlapping assigned shift, with a portal login),
// each invited exactly once per shift, with a one-tap pickup link into
// the open-shifts marketplace. The supervisor's queue item only remains
// for shifts the machine couldn't fill — and says the bench was already
// asked.

import type { PrismaClient } from '@prisma/client';
import { tenantJob } from './tenantJobs.js';
import { prisma as defaultPrisma } from '../db.js';
import { benchFor } from './scope.js';
import { notifyUser } from './notify.js';
import { DEFAULT_TIMEZONE, formatTimeInZone } from './timezone.js';
import { runShiftFill } from './workforceAgent.js';

const SWEEP_SECONDS = 15 * 60;
const HORIZON_MS = 48 * 3600_000;
const MAX_INVITES_PER_SHIFT_PER_SWEEP = 20;
const CATEGORY = 'shift_autofill';

export interface AutofillResult {
  shiftsScanned: number;
  invitesSent: number;
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
      locationRel: { select: { name: true } },
    },
    take: 100,
  });
  let invitesSent = 0;

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
      select: { id: true },
      take: 60,
    });
    if (candidates.length === 0) continue;
    // Invite each person once per shift — the notification itself is the
    // dedup record.
    const already = await prisma.notification.findMany({
      where: {
        recipientUserId: { in: candidates.map((c) => c.id) },
        category: CATEGORY,
        linkUrl,
      },
      select: { recipientUserId: true },
    });
    const invited = new Set(already.map((n) => n.recipientUserId));
    let sentForShift = 0;
    for (const c of candidates) {
      if (invited.has(c.id)) continue;
      if (sentForShift >= MAX_INVITES_PER_SHIFT_PER_SWEEP) break;
      await notifyUser(c.id, {
        subject: `Open shift: ${shift.position} at ${shift.client?.name ?? shift.locationRel?.name ?? shift.location ?? ''}`,
        body: `${formatTimeInZone(shift.startsAt, DEFAULT_TIMEZONE)}–${formatTimeInZone(shift.endsAt, DEFAULT_TIMEZONE)}${shift.location ? ` · ${shift.location}` : ''}. First come, first served — tap to claim it.`,
        category: CATEGORY,
        linkUrl,
      });
      sentForShift += 1;
      invitesSent += 1;
    }
  }
  return { shiftsScanned: shifts.length, invitesSent };
}

let timer: NodeJS.Timeout | null = null;

/** One tick per tenant: the broadcast asks the bench, then the Workforce agent proposes for what is still open (shift.fill). */
async function autofillTick(): Promise<void> {
  await runShiftAutofillSweep();
  await runShiftFill();
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
  console.log(
    `[alto-people/api] shift auto-fill cron armed (every ${SWEEP_SECONDS}s, 48h horizon)`,
  );
}

export function stopShiftAutofillCron(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
