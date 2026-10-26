// Associate earnings motivation — the paycheck made visible:
//   · GET /time/me/earnings: this org week (Sat→Fri) as money — earned
//     so far (approved + completed + live on-the-clock minutes), what
//     the rest of the schedule is worth, today's shift as a number, a
//     per-day breakdown, last week as the pace to beat, and what the
//     week's eligible open shifts are worth.
//   · Clock-out moment: "You just added ~$112 to your week" pushed to
//     the associate's OWN phone/bell — deliberately not the shared kiosk
//     screen, where a dollar figure would leak their pay rate to the
//     next person in line.
// OVERTIME-AWARE: every hour here is split by the labor-rules engine
// (lib/laborRules/hours.splitHours) — the split the paycheck pays: the
// weekly 40 at 1.5× across all clients, plus a live jurisdiction's daily
// overtime and double time, with the paycheck's punch rounding. A widget
// that shows an associate LESS than their paycheck isn't motivation, it's a
// bug; one that splits differently from the check is the same bug.
// All figures are ESTIMATES: gross, before taxes, at the associate's
// hourly comp record (else the org default rate). Payroll remains the
// source of truth.

import type { PrismaClient } from '@prisma/client';
import { paidMinutesForRange } from '@alto-people/shared';
import { env } from '../config/env.js';
import { notifyAssociate } from './notify.js';
import { listEligibleOpenShiftSlots } from '../routes/qualifications.js';
import { endOfWeekUTC, startOfWeekUTC } from './timeAnomalies.js';
import { estimateTakeHome, type TakeHomeEstimate } from './takeHome.js';
import { payFor, penaltyAmount, plannedEntry, splitHours, type EntryHours, type HoursEntry, type HoursSplit, type LaborSite } from './laborRules/hours.js';
import { loadPayContext } from './laborRules/payContext.js';

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The weekly overtime line every rule set shares (FLSA); live daily rules may start overtime sooner. */
const WEEKLY_THRESHOLD_HOURS = 40;
const DAY_MS = 24 * 3600_000;
/** A forgotten clock-out can't paint a fantasy number. */
const LIVE_CAP_MS = 16 * 3600_000;

const SITE_SELECT = { select: { id: true, state: true, city: true, timezone: true } } as const;

/** An entry's (or a planned shift's) money: its share of each bucket at the rate, at the split's multipliers. */
const moneyOf = (share: EntryHours, rate: number, split: HoursSplit) => payFor(share, rate, split);

async function hourlyRateFor(
  prisma: PrismaClient,
  associateId: string,
): Promise<{ rate: number; source: 'comp' | 'default' }> {
  const comp = await prisma.compensationRecord.findFirst({
    where: { associateId, payType: 'HOURLY', effectiveTo: null },
    orderBy: { effectiveFrom: 'desc' },
    select: { amount: true },
  });
  if (comp) return { rate: Number(comp.amount), source: 'comp' };
  return { rate: env.DEFAULT_ASSOCIATE_PAY_RATE, source: 'default' };
}

export interface EarningsDay {
  /** YYYY-MM-DD (UTC week bucket, Sat→Fri). */
  date: string;
  workedMinutes: number;
  workedAmount: number;
  scheduledMinutes: number;
  scheduledAmount: number;
}

export interface AssociateEarnings {
  weekStart: string;
  weekEnd: string;
  hourlyRate: number;
  rateSource: 'comp' | 'default';
  /** Net worked this week so far, incl. live on-the-clock minutes. OT-aware. */
  earnedSoFar: number;
  workedHours: number;
  /** earnedSoFar + the rest of this week's assigned schedule. OT-aware. */
  projectedWeek: number;
  remainingHours: number;
  /** Clocked in right now — the client ticks the number live while true. */
  onClock: boolean;
  /** What the NEXT minute pays: the base rate, or 1.5× once past 40h. */
  currentRatePerHour: number;
  /** On the clock: what this punch has earned so far (OT-aware) — the
   *  shift card ticks it live from here at currentRatePerHour. */
  currentShiftEarned: number | null;
  overtime: {
    /** The weekly overtime line (40); a live jurisdiction's daily rule can start overtime sooner. */
    thresholdHours: number;
    multiplier: number;
    /** Already past 40h — every remaining minute pays 1.5×. */
    unlocked: boolean;
    otHoursSoFar: number;
    /** worked + remaining schedule crosses 40h by this many hours. */
    projectedOtHours: number;
  };
  /** This week's worked hours as the paycheck splits them (lib/laborRules/hours). */
  hours: { regular: number; overtime: number; doubleTime: number; premium: number };
  /** Last completed week's total (same rate, OT-aware) — the pace to beat. */
  lastWeekEarned: number;
  /** Sat→Fri, always 7 entries — the shape of the week as money. */
  days: EarningsDay[];
  /** Eligible OPEN shifts before week's end, priced on top of the
   *  projection (so they show 1.5× when they'd land in overtime). */
  openShifts: { count: number; estAmount: number };
  /** The next assigned shift within 24h (or the one in progress). */
  /** BEYOND — earnedSoFar after taxes, deductions and advances drawn (lib/takeHome). */
  takeHome: TakeHomeEstimate | null;
  todayShift: {
    startsAt: string;
    endsAt: string;
    estAmount: number;
    inProgress: boolean;
  } | null;
}

export async function computeAssociateEarnings(
  prisma: PrismaClient,
  associateId: string,
  now: Date = new Date(),
): Promise<AssociateEarnings> {
  const weekStart = startOfWeekUTC(now);
  const weekEnd = endOfWeekUTC(now);
  // The rate query used to run on its own before the batch below, which
  // put a whole round trip in front of everything else. It depends on
  // nothing here, so it rides along with the rest.
  const [{ rate, source }, entries, shifts, lastWeekEntries, openEligible, pay] =
    await Promise.all([
      hourlyRateFor(prisma, associateId),
      prisma.timeEntry.findMany({
        where: {
          associateId,
          status: { in: ['APPROVED', 'COMPLETED', 'ACTIVE'] },
          clockInAt: { gte: weekStart, lt: weekEnd },
        },
        // Chronological — the OT split walks the week in order.
        orderBy: { clockInAt: 'asc' },
        select: {
          id: true,
          locationId: true,
          clockInAt: true,
          clockOutAt: true,
          status: true,
          breaks: { select: { type: true, startedAt: true, endedAt: true } },
          location: SITE_SELECT,
        },
        take: 100,
      }),
      prisma.shift.findMany({
        where: {
          assignedAssociateId: associateId,
          status: 'ASSIGNED',
          endsAt: { gt: now },
          startsAt: { lt: weekEnd },
        },
        orderBy: { startsAt: 'asc' },
        select: { startsAt: true, endsAt: true, locationRel: SITE_SELECT },
        take: 30,
      }),
      prisma.timeEntry.findMany({
        where: {
          associateId,
          status: { in: ['APPROVED', 'COMPLETED'] },
          clockInAt: {
            gte: new Date(weekStart.getTime() - 7 * DAY_MS),
            lt: weekStart,
          },
        },
        select: {
          id: true,
          locationId: true,
          clockInAt: true,
          clockOutAt: true,
          breaks: { select: { type: true, startedAt: true, endedAt: true } },
          location: SITE_SELECT,
        },
        take: 100,
      }),
      listEligibleOpenShiftSlots(associateId, { before: weekEnd }),
      loadPayContext(prisma),
    ]);

  const days: EarningsDay[] = Array.from({ length: 7 }, (_, i) => ({
    date: new Date(weekStart.getTime() + i * DAY_MS).toISOString().slice(0, 10),
    workedMinutes: 0,
    workedAmount: 0,
    scheduledMinutes: 0,
    scheduledAmount: 0,
  }));
  const dayIndex = (d: Date) =>
    Math.max(0, Math.min(6, Math.floor((d.getTime() - weekStart.getTime()) / DAY_MS)));

  // Worked time, as pay counts it: closed punches (rounded where a policy
  // says so) and the running one up to now.
  let onClock = false;
  let activeIndex = -1;
  const worked: HoursEntry[] = [];
  for (const raw of entries) {
    const e = pay.forPay(raw);
    if (!e.clockOutAt && e.status !== 'ACTIVE') continue;
    if (!e.clockOutAt) {
      onClock = true;
      activeIndex = worked.length;
    }
    const out = e.clockOutAt ?? new Date(Math.max(e.clockInAt.getTime(), Math.min(now.getTime(), e.clockInAt.getTime() + LIVE_CAP_MS)));
    worked.push({ id: e.id, clockInAt: e.clockInAt, clockOutAt: out, breaks: e.breaks, site: e.location });
  }
  const workedSplit = splitHours(pay.rules, worked);
  let earnedSoFar = 0;
  let currentShiftEarned: number | null = null;
  workedSplit.entries.forEach((share, i) => {
    if (share.workedHours <= 0) return;
    const amount = moneyOf(share, rate, workedSplit);
    if (i === activeIndex) currentShiftEarned = round2(amount);
    const d = days[dayIndex(worked[i]!.clockInAt)];
    d.workedMinutes += Math.round(share.workedHours * 60);
    d.workedAmount = round2(d.workedAmount + amount);
    earnedSoFar += amount;
  });
  const workedHours = workedSplit.entries.reduce((a, e) => a + e.workedHours, 0);
  // Premiums the check will carry for these hours (a live jurisdiction's
  // meal, rest, spread-of-hours…), at this rate — on the day they belong to.
  let premiumHours = 0;
  for (const p of workedSplit.penalties) {
    const amount = penaltyAmount(p, rate);
    if (amount < 0.005) continue;
    premiumHours += p.hours;
    earnedSoFar += amount;
    const d = days.find((x) => x.date === p.date) ?? days[dayIndex(now)]!;
    d.workedAmount = round2(d.workedAmount + amount);
  }

  // The rest of the schedule: future shifts fully; an in-progress shift
  // only from now to its end (the walked part is already counted above).
  // Split together with the worked week, so hours landing in overtime
  // project at the overtime rate. Paid minutes (unpaid-break rule) —
  // never promise money for the meal hour: a 9h overnight projects 8.
  const lastSite: LaborSite | null = worked.length ? (worked[worked.length - 1]!.site ?? null) : null;
  const planned = shifts
    .map((s) => {
      const from = s.startsAt > now ? s.startsAt : now;
      return { s, from, entry: plannedEntry({ startsAt: from, endsAt: s.endsAt, paidMinutes: paidMinutesForRange(from, s.endsAt), site: s.locationRel }) };
    })
    .filter((p) => p.s.endsAt > p.from);
  const projSplit = splitHours(pay.rules, [...worked, ...planned.map((p) => p.entry)]);
  let remainingHours = 0;
  let remainingAmount = 0;
  planned.forEach((p, i) => {
    const share = projSplit.entries[worked.length + i]!;
    if (share.workedHours <= 0) return;
    const amount = moneyOf(share, rate, projSplit);
    const d = days[dayIndex(p.from)];
    d.scheduledMinutes += Math.round(share.workedHours * 60);
    d.scheduledAmount = round2(d.scheduledAmount + amount);
    remainingHours += share.workedHours;
    remainingAmount += amount;
  });

  // Last week, the same split — the pace to beat.
  const lastSplit = splitHours(
    pay.rules,
    lastWeekEntries.map((raw) => {
      const e = pay.forPay(raw);
      return { id: e.id, clockInAt: e.clockInAt, clockOutAt: e.clockOutAt, breaks: e.breaks, site: e.location };
    }),
  );
  const lastWeekEarned = round2(payFor(lastSplit, rate, lastSplit));

  // Eligible open shifts, priced ON TOP of the projection: if picking one
  // up would land in overtime, it honestly shows the overtime value.
  const open = openEligible
    .map((s) => plannedEntry({ startsAt: s.startsAt, endsAt: s.endsAt, paidMinutes: paidMinutesForRange(s.startsAt, s.endsAt), site: lastSite }))
    .filter((e) => e.clockOutAt! > e.clockInAt);
  const base = [...worked, ...planned.map((p) => p.entry)];
  const openSplit = splitHours(pay.rules, [...base, ...open]);
  const openAmount = open.reduce((a, _e, i) => a + moneyOf(openSplit.entries[base.length + i]!, rate, openSplit), 0);

  const next = shifts.find(
    (s) => s.endsAt > now && s.startsAt.getTime() < now.getTime() + 24 * 3600_000,
  );
  const todayShift = next
    ? (() => {
        const from = new Date(
          Math.max(
            next.startsAt.getTime(),
            onClock ? now.getTime() : next.startsAt.getTime(),
          ),
        );
        // The next shift is first on the remaining clock, so its OT split
        // starts right where the worked week left off.
        const entry = plannedEntry({ startsAt: from, endsAt: next.endsAt, paidMinutes: paidMinutesForRange(from, next.endsAt), site: next.locationRel });
        const split = splitHours(pay.rules, [...worked, entry]);
        return {
          startsAt: next.startsAt.toISOString(),
          endsAt: next.endsAt.toISOString(),
          estAmount: round2(moneyOf(split.entries[worked.length]!, rate, split)),
          inProgress: next.startsAt <= now,
        };
      })()
    : null;

  // What the next minute pays: a minute more at the running punch's site
  // (or the last one's), split with the week.
  const probeSite = (activeIndex >= 0 ? worked[activeIndex]!.site : null) ?? lastSite;
  const probe = plannedEntry({ startsAt: now, endsAt: new Date(now.getTime() + 60_000), site: probeSite });
  const probeSplit = splitHours(pay.rules, [...worked.filter((w) => w.clockInAt <= now), probe]);
  const nextShare = probeSplit.entries[probeSplit.entries.length - 1]!;
  // A minute in overtime is 0.0167 h of it; anything under a millionth is float residue.
  const EPS = 1e-6;
  const nextMultiplier = nextShare.doubleTimeHours > EPS ? probeSplit.doubleMultiplier : nextShare.overtimeHours > EPS ? probeSplit.overtimeMultiplier : 1;

  return {
    weekStart: weekStart.toISOString(),
    weekEnd: weekEnd.toISOString(),
    hourlyRate: rate,
    rateSource: source,
    earnedSoFar: round2(earnedSoFar),
    workedHours: round2(workedHours),
    projectedWeek: round2(earnedSoFar + remainingAmount),
    remainingHours: round2(remainingHours),
    onClock,
    currentRatePerHour: round2(rate * nextMultiplier),
    currentShiftEarned: onClock ? (currentShiftEarned ?? 0) : null,
    overtime: {
      thresholdHours: WEEKLY_THRESHOLD_HOURS,
      multiplier: workedSplit.overtimeMultiplier,
      // "Every hour now pays 1.5×" is about the hours still to work: on the
      // clock, the next minute's rate; off it, only once the week itself is
      // past the threshold. A probe minute appended after a long day read as
      // "Overtime unlocked" with 0 overtime hours in the same answer.
      unlocked: onClock ? nextMultiplier > 1 : workedHours >= WEEKLY_THRESHOLD_HOURS,
      otHoursSoFar: round2(workedSplit.overtimeHours + workedSplit.doubleTimeHours),
      projectedOtHours: round2(projSplit.overtimeHours + projSplit.doubleTimeHours),
    },
    hours: {
      regular: workedSplit.regularHours,
      overtime: workedSplit.overtimeHours,
      doubleTime: workedSplit.doubleTimeHours,
      premium: round2(premiumHours),
    },
    lastWeekEarned,
    days,
    openShifts: {
      count: openEligible.length,
      estAmount: round2(openAmount),
    },
    todayShift,
    // Never fails the card: no estimate is better than no earnings.
    takeHome: await estimateTakeHome(prisma, associateId, round2(earnedSoFar), now).catch(() => null),
  };
}

/**
 * The clock-out moment — fire-and-forget from the kiosk punch handler.
 * Lands on the associate's own bell/push, never the shared kiosk screen.
 * OT-aware: if the week already crossed 40h, the added amount reflects
 * the 1.5× the paycheck will actually show.
 */
export async function notifyClockOutEarnings(
  prisma: PrismaClient,
  timeEntryId: string,
): Promise<void> {
  const entry = await prisma.timeEntry.findUnique({
    where: { id: timeEntryId },
    select: {
      id: true,
      associateId: true,
      locationId: true,
      clockInAt: true,
      clockOutAt: true,
      breaks: { select: { type: true, startedAt: true, endedAt: true } },
      location: SITE_SELECT,
    },
  });
  if (!entry?.clockOutAt) return;
  const [{ rate }, pay] = await Promise.all([hourlyRateFor(prisma, entry.associateId), loadPayContext(prisma)]);

  // Where in the week did this entry land? The week's earlier entries, split
  // with it by the engine, so the straight / overtime share matches the check.
  const weekStart = startOfWeekUTC(entry.clockOutAt);
  const priors = await prisma.timeEntry.findMany({
    where: {
      associateId: entry.associateId,
      status: { in: ['APPROVED', 'COMPLETED'] },
      clockInAt: { gte: weekStart, lt: entry.clockInAt },
      id: { not: timeEntryId },
    },
    select: {
      id: true,
      locationId: true,
      clockInAt: true,
      clockOutAt: true,
      breaks: { select: { type: true, startedAt: true, endedAt: true } },
      location: SITE_SELECT,
    },
    take: 100,
  });
  const asEntry = (raw: typeof priors[number]): HoursEntry => {
    const e = pay.forPay(raw);
    return { id: e.id, clockInAt: e.clockInAt, clockOutAt: e.clockOutAt, breaks: e.breaks, site: e.location };
  };
  const list = [...priors.map(asEntry), asEntry(entry)];
  const split = splitHours(pay.rules, list);
  const mine = split.entries[list.length - 1]!;
  if (mine.workedHours <= 0) return;

  const amount = round2(moneyOf(mine, rate, split));
  const otHours = mine.overtimeHours + mine.doubleTimeHours;
  const hours = mine.workedHours.toFixed(2);
  // Awaited: the kiosk call site fire-and-forgets THIS helper, so
  // awaiting the insert here costs the punch nothing — and callers that
  // do await (tests) see the row.
  // BEYOND — the week so far as take-home, through the tax engine.
  const weekEarned = round2(payFor(split, rate, split));
  const takeHome = await estimateTakeHome(prisma, entry.associateId, weekEarned, entry.clockOutAt).catch(() => null);
  await notifyAssociate(entry.associateId, {
    subject: `You just added ~$${amount.toFixed(2)} to your week`,
    body:
      `${hours}h worked today at ~$${rate.toFixed(2)}/hr.` +
      (takeHome && takeHome.net > 0 ? ` About $${takeHome.net.toFixed(2)} take-home so far this week.` : '') +
      (otHours > 0
        ? ` Includes ${otHours.toFixed(2)}h of overtime${mine.doubleTimeHours > 0 ? ' and double time' : ` at ${split.overtimeMultiplier}×`}.`
        : '') +
      ' Estimated — the added amount is before taxes, and your paycheck is the official number. Great shift!',
    category: 'earnings',
    linkUrl: '/',
  });
}
