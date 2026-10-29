import type { PayrollFrequency } from '@prisma/client';
import { prisma } from '../db.js';
import { placedClientIds } from './openShiftEligibility.js';
import { orgDateKey } from './timeAnomalies.js';
import { nextPaydayOn, periodAfter, periodContaining, scheduleMembershipFor } from './payScheduleMembership.js';
import { tenantIdForWrite } from './tenant.js';

/**
 * An associate's next payday and the period it pays for — on the pay
 * schedule they are a MEMBER of (lib/payScheduleMembership
 * scheduleMembershipFor: the one rule, the same a run pays by). Null for
 * someone on no schedule: no run would pay them, so no date is promised
 * (F500 SH-4 — My pay used to fall back to the client's or the first org
 * schedule and show a payday nobody would pay). (Alto: biweekly Sat→Fri
 * periods paid the Friday after.)
 *
 * "Next" is strictly after today: on a payday the associate is being paid
 * today, and the date they're waiting on is the following one (Fri Sep 18
 * pays Aug 29–Sep 11 → next payday Fri Oct 2 for Sep 12–25). And "today"
 * is the org's calendar day, not UTC's — from 8 PM Eastern the UTC date is
 * already tomorrow, which flipped the answer a few hours early.
 */
export interface ResolvedPaySchedule {
  name: string;
  frequency: PayrollFrequency;
  anchorDate: Date;
  payDateOffsetDays: number;
}

const scheduleSelect = { name: true, frequency: true, anchorDate: true, payDateOffsetDays: true } as const;

/**
 * The pay schedule an associate is paid on: their membership today, else a
 * booked move. Null when they are on none.
 *
 * `orLikely` is for readers that must describe a pay pattern before the
 * person is on a schedule (the W-4 estimator's withholding frequency, a
 * pay notice's "paid every other week", a timesheet's period): their
 * client's schedule, else the org's first, as the likely one. Never for
 * saying when someone WILL be paid.
 */
export async function payScheduleFor(associateId: string, opts: { orLikely?: boolean } = {}): Promise<ResolvedPaySchedule | null> {
  const today = orgDateKey(new Date());
  const m = (await scheduleMembershipFor(prisma, [associateId], today)).get(associateId) ?? null;
  if (m) {
    const s = await prisma.payrollSchedule.findUnique({ where: { id: m.scheduleId }, select: scheduleSelect });
    if (s) return s;
  }
  if (!opts.orLikely) return null;
  const live = { isActive: true, deletedAt: null } as const;
  const clientIds = await placedClientIds(associateId);
  return (
    (clientIds.length
      ? await prisma.payrollSchedule.findFirst({
          where: { ...live, clientId: { in: clientIds } },
          orderBy: { createdAt: 'asc' },
          select: scheduleSelect,
        })
      : null) ??
    (await prisma.payrollSchedule.findFirst({
      where: { ...live, clientId: null },
      orderBy: { createdAt: 'asc' },
      select: scheduleSelect,
    }))
  );
}

export async function nextPaydayFor(
  associateId: string,
  now: Date = new Date(),
): Promise<{
  payDate: string;
  periodStart: string;
  periodEnd: string;
  schedule: string;
  /** Today is a payday: the days it pays for (until midnight). */
  paidToday: { periodStart: string; periodEnd: string } | null;
} | null> {
  const today = orgDateKey(now);
  const m = (await scheduleMembershipFor(prisma, [associateId], today)).get(associateId) ?? null;
  if (!m) return null;
  const schedule = await prisma.payrollSchedule.findUnique({ where: { id: m.scheduleId }, include: { versions: true } });
  if (!schedule) return null;
  // Version-aware (a pattern change and its bridge period are on the calendar it will run).
  let w = nextPaydayOn(schedule, today);
  const paidToday = w.payDate === today && w.periodEnd >= m.from ? { periodStart: w.periodStart, periodEnd: w.periodEnd } : null;
  if (w.payDate <= today) w = periodAfter(schedule, w);
  // A booked move: the first period of the new schedule that pays any of their days.
  for (let guard = 0; w.periodEnd < m.from && guard < 60; guard += 1) w = periodAfter(schedule, w);
  return { payDate: w.payDate, periodStart: w.periodStart, periodEnd: w.periodEnd, schedule: schedule.name, paidToday };
}

/**
 * The pay period running on `today` (a company calendar day) for an
 * associate, on the schedule they are a member of that day, and the payday
 * that pays it. Null when they are on none. "This pay period" on every
 * associate screen is this window (ASSOC-17) — never the period that just
 * closed and is waiting for its payday (that one is "paid Fri, Oct 30").
 */
export async function currentPayPeriodFor(
  associateId: string,
  today: string,
): Promise<{ periodStart: string; periodEnd: string; payDate: string; frequency: PayrollFrequency } | null> {
  const m = (await scheduleMembershipFor(prisma, [associateId], today)).get(associateId) ?? null;
  if (!m) return null;
  const schedule = await prisma.payrollSchedule.findUnique({ where: { id: m.scheduleId }, include: { versions: true } });
  if (!schedule) return null;
  const w = periodContaining(schedule, today);
  return { periodStart: w.periodStart, periodEnd: w.periodEnd, payDate: w.payDate, frequency: schedule.frequency };
}

/** Whether the tenant pays by schedules at all (any live schedule) — "not on one yet" only means something then. */
export async function anyLiveSchedule(): Promise<boolean> {
  return (await prisma.payrollSchedule.count({ where: { tenantId: tenantIdForWrite(), isActive: true, deletedAt: null } })) > 0;
}
