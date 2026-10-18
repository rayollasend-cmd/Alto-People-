import type { AcaClassification, AcaCoverageOffer, Prisma, PrismaClient } from '@prisma/client';
import { tenantIdForWrite } from './tenant.js';

/**
 * ACA look-back measurement (TAXCOMP 2026-10) — Treas. Reg. §54.4980H-3.
 *
 * Variable-hour, seasonal and part-time workers are measured over a
 * standard measurement period (SMP); whoever averages the full-time
 * threshold (130 hours a month) is treated as full-time — and must be
 * offered coverage — for the stability period (SP) that follows an
 * administrative period. A new hire who isn't expected to be full-time is
 * measured over an initial measurement period (IMP) from the first of the
 * month after hire, with its own administrative and stability periods; the
 * months before that stability period are a limited non-assessment period
 * (line 16 code 2D). A worker hired as full-time is full-time from the first
 * day of the fourth calendar month (the 90-day window is the LNAP).
 *
 * A break in service of 13 weeks or more (or, with the rule of parity, at
 * least 4 weeks and longer than the employment before it) makes the return
 * a new hire.
 *
 * Everything here works in UTC calendar dates.
 */

type Db = Prisma.TransactionClient | PrismaClient;
const DAY = 86_400_000;

export interface AcaConfig {
  measurementMonths: number;
  adminDays: number;
  stabilityMonths: number;
  initialMeasurementMonths: number;
  stabilityStartMonth: number;
  stabilityStartDay: number;
  fullTimeHoursPerMonth: number;
  breakInServiceWeeks: number;
  ruleOfParity: boolean;
  defaultOfferCode: AcaCoverageOffer;
  affordabilitySafeHarbor: string | null;
  lowestPremiumCents: number | null;
}

export const DEFAULT_ACA_CONFIG: AcaConfig = {
  measurementMonths: 12,
  adminDays: 60,
  stabilityMonths: 12,
  initialMeasurementMonths: 12,
  stabilityStartMonth: 1,
  stabilityStartDay: 1,
  fullTimeHoursPerMonth: 130,
  breakInServiceWeeks: 13,
  ruleOfParity: true,
  defaultOfferCode: 'CODE_1E',
  affordabilitySafeHarbor: '2H',
  lowestPremiumCents: null,
};

/** The rules the settings must meet (§54.4980H-3(d)). Returns the problems, empty when valid. */
export function validateAcaConfig(c: AcaConfig): string[] {
  const out: string[] = [];
  if (c.measurementMonths < 3 || c.measurementMonths > 12) out.push('The measurement period is 3 to 12 months.');
  if (c.initialMeasurementMonths < 3 || c.initialMeasurementMonths > 12) out.push('The initial measurement period is 3 to 12 months.');
  if (c.adminDays < 0 || c.adminDays > 90) out.push('The administrative period is at most 90 days.');
  if (c.stabilityMonths < 6 || c.stabilityMonths < c.measurementMonths) out.push('The stability period is at least 6 months and at least as long as the measurement period.');
  if (c.stabilityStartMonth < 1 || c.stabilityStartMonth > 12 || c.stabilityStartDay < 1 || c.stabilityStartDay > 28) out.push('The stability period starts on a day from the 1st to the 28th.');
  return out;
}

export const utcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
export function addMonths(d: Date, n: number): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + n;
  const target = new Date(Date.UTC(y, m, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(d.getUTCDate(), last)));
}
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY);
const firstOfNextMonth = (d: Date) => (d.getUTCDate() === 1 ? utcDay(d) : new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)));

export interface Window {
  measurementStart: Date;
  /** Exclusive. */
  measurementEnd: Date;
  stabilityStart: Date;
  /** Exclusive. */
  stabilityEnd: Date;
}

/** The standard cycle whose stability period contains `date`. */
export function standardWindowFor(c: AcaConfig, date: Date): Window {
  const d = utcDay(date);
  let start = new Date(Date.UTC(d.getUTCFullYear(), c.stabilityStartMonth - 1, c.stabilityStartDay));
  while (start > d) start = addMonths(start, -c.stabilityMonths);
  while (addMonths(start, c.stabilityMonths) <= d) start = addMonths(start, c.stabilityMonths);
  return windowEndingAt(c, start, c.measurementMonths);
}

function windowEndingAt(c: AcaConfig, stabilityStart: Date, months: number): Window {
  const measurementEnd = addDays(stabilityStart, -c.adminDays);
  return { measurementStart: addMonths(measurementEnd, -months), measurementEnd, stabilityStart, stabilityEnd: addMonths(stabilityStart, c.stabilityMonths) };
}

/** A new variable-hour hire's initial cycle. */
export function initialWindowFor(c: AcaConfig, hireDate: Date): Window {
  const measurementStart = firstOfNextMonth(hireDate);
  const measurementEnd = addMonths(measurementStart, c.initialMeasurementMonths);
  // The initial administrative period runs at most adminDays and ends at a month's start,
  // keeping IMP + admin within 13 months and a fraction (§54.4980H-3(d)(1)(vi)).
  const stabilityStart = new Date(Math.min(firstOfNextMonth(addDays(measurementEnd, c.adminDays)).getTime(), addMonths(measurementStart, 13).getTime()));
  return { measurementStart, measurementEnd, stabilityStart, stabilityEnd: addMonths(stabilityStart, c.stabilityMonths) };
}

export interface HourEntry {
  /** When the shift started. */
  at: Date;
  hours: number;
}

export function hoursBetween(entries: HourEntry[], from: Date, toExclusive: Date): number {
  let n = 0;
  for (const e of entries) if (e.at >= from && e.at < toExclusive) n += e.hours;
  return Math.round(n * 100) / 100;
}

/**
 * The hire date that counts for measurement: the original hire, or the
 * return after the most recent break in service long enough to restart it.
 */
export function effectiveHireDate(c: AcaConfig, hireDate: Date, entries: HourEntry[], asOf: Date): Date {
  const sorted = entries.filter((e) => e.at <= asOf).map((e) => utcDay(e.at)).sort((a, b) => a.getTime() - b.getTime());
  let hire = utcDay(hireDate);
  // Gaps are measured between worked shifts only: hours are loaded for a
  // look-back window, so the stretch from an old hire date to the first
  // loaded shift is missing data, not a break.
  const first = sorted.find((day) => day >= hire);
  if (!first) return hire;
  let last = first;
  for (const day of sorted) {
    if (day < first) continue;
    const gapWeeks = (day.getTime() - last.getTime()) / (7 * DAY);
    const priorWeeks = (last.getTime() - hire.getTime()) / (7 * DAY);
    const restart = gapWeeks >= c.breakInServiceWeeks || (c.ruleOfParity && gapWeeks >= 4 && gapWeeks > priorWeeks);
    if (restart && day.getTime() - last.getTime() > 7 * DAY) hire = day;
    last = day;
  }
  return hire;
}

export type MonthBasis = 'not_employed' | 'lnap' | 'full_time' | 'not_full_time';

export interface PersonInput {
  hireDate: Date | null;
  /** Classification history, oldest first. */
  classes: Array<{ classification: AcaClassification; effectiveFrom: Date }>;
  entries: HourEntry[];
  separatedAt?: Date | null;
}

export function classificationOn(p: PersonInput, date: Date): AcaClassification {
  let current: AcaClassification = 'VARIABLE_HOUR';
  for (const k of p.classes) if (utcDay(k.effectiveFrom) <= utcDay(date)) current = k.classification;
  return current;
}

/** Whether the person is treated as full-time on `date`, and on what basis. */
export function basisOn(c: AcaConfig, p: PersonInput, date: Date): { basis: MonthBasis; window: Window | null; averageHours: number | null } {
  const d = utcDay(date);
  if (!p.hireDate || utcDay(p.hireDate) > d || (p.separatedAt && utcDay(p.separatedAt) < d)) return { basis: 'not_employed', window: null, averageHours: null };
  const hire = effectiveHireDate(c, p.hireDate, p.entries, d);
  if (classificationOn(p, d) === 'FULL_TIME') {
    // Full-time from the first day of the fourth calendar month after hire.
    const fullTimeFrom = new Date(Date.UTC(hire.getUTCFullYear(), hire.getUTCMonth() + 3, 1));
    return { basis: d < fullTimeFrom ? 'lnap' : 'full_time', window: null, averageHours: null };
  }
  const std = standardWindowFor(c, d);
  const threshold = c.fullTimeHoursPerMonth;
  if (hire <= std.measurementStart) {
    const avg = hoursBetween(p.entries, std.measurementStart, std.measurementEnd) / c.measurementMonths;
    // A worker still inside an initial stability period that made them full-time stays full-time.
    const init = initialWindowFor(c, hire);
    if (d >= init.stabilityStart && d < init.stabilityEnd) {
      const initAvg = hoursBetween(p.entries, init.measurementStart, init.measurementEnd) / c.initialMeasurementMonths;
      if (initAvg >= threshold) return { basis: 'full_time', window: init, averageHours: round1(initAvg) };
    }
    return { basis: avg >= threshold ? 'full_time' : 'not_full_time', window: std, averageHours: round1(avg) };
  }
  const init = initialWindowFor(c, hire);
  if (d < init.stabilityStart) return { basis: 'lnap', window: init, averageHours: null };
  const avg = hoursBetween(p.entries, init.measurementStart, init.measurementEnd) / c.initialMeasurementMonths;
  return { basis: avg >= threshold ? 'full_time' : 'not_full_time', window: init, averageHours: round1(avg) };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export type AcaStatus = 'full_time' | 'approaching' | 'on_track' | 'new_hire';

export interface Measurement {
  classification: AcaClassification;
  status: AcaStatus;
  /** The basis governing today. */
  today: MonthBasis;
  /** The measurement period in progress (or the one that governs a full-time-classed worker: none). */
  inProgress: { start: string; end: string; monthsElapsed: number; hours: number; averageHours: number; stabilityStart: string; kind: 'initial' | 'standard' } | null;
  /** The stability period an offer of coverage is owed for, and by when. */
  offerDue: { stabilityStart: string; stabilityEnd: string; dueBy: string; reason: 'measured_full_time' | 'projected_full_time' | 'hired_full_time' } | null;
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** Where one person stands today. */
export function measure(c: AcaConfig, p: PersonInput, asOf: Date): Measurement {
  const now = utcDay(asOf);
  const classification = classificationOn(p, now);
  const today = basisOn(c, p, now);
  if (classification === 'FULL_TIME' && p.hireDate) {
    const hire = effectiveHireDate(c, p.hireDate, p.entries, now);
    const fullTimeFrom = new Date(Date.UTC(hire.getUTCFullYear(), hire.getUTCMonth() + 3, 1));
    const std = standardWindowFor(c, fullTimeFrom > now ? fullTimeFrom : now);
    return {
      classification,
      status: 'full_time',
      today: today.basis,
      inProgress: null,
      offerDue: { stabilityStart: ymd(fullTimeFrom > now ? fullTimeFrom : std.stabilityStart), stabilityEnd: ymd(std.stabilityEnd), dueBy: ymd(fullTimeFrom > now ? fullTimeFrom : std.stabilityStart), reason: 'hired_full_time' },
    };
  }
  // The measurement period running now — initial for a new hire, else the standard one feeding next stability.
  let window: Window | null = null;
  let kind: 'initial' | 'standard' = 'standard';
  let months = c.measurementMonths;
  if (p.hireDate) {
    const hire = effectiveHireDate(c, p.hireDate, p.entries, now);
    const init = initialWindowFor(c, hire);
    if (now < init.measurementEnd) {
      window = init;
      kind = 'initial';
      months = c.initialMeasurementMonths;
    }
  }
  if (!window) {
    const current = standardWindowFor(c, now);
    const next = windowEndingAt(c, current.stabilityEnd, c.measurementMonths);
    window = now >= next.measurementStart ? next : current;
  }
  const elapsedEnd = now < window.measurementEnd ? now : window.measurementEnd;
  const monthsElapsed = Math.max(0, Math.min(months, monthsBetween(window.measurementStart, elapsedEnd)));
  const hours = hoursBetween(p.entries, window.measurementStart, addDays(elapsedEnd, 1));
  const averageHours = monthsElapsed > 0 ? round1(hours / monthsElapsed) : 0;
  const threshold = c.fullTimeHoursPerMonth;

  let offerDue: Measurement['offerDue'] = null;
  if (today.basis === 'full_time' && today.window) {
    offerDue = { stabilityStart: ymd(today.window.stabilityStart), stabilityEnd: ymd(today.window.stabilityEnd), dueBy: ymd(today.window.stabilityStart), reason: 'measured_full_time' };
  } else if (averageHours >= threshold && monthsElapsed >= 1) {
    offerDue = { stabilityStart: ymd(window.stabilityStart), stabilityEnd: ymd(window.stabilityEnd), dueBy: ymd(window.stabilityStart), reason: 'projected_full_time' };
  }
  const status: AcaStatus =
    today.basis === 'full_time' || averageHours >= threshold ? 'full_time' : averageHours >= threshold - 10 ? 'approaching' : today.basis === 'lnap' ? 'new_hire' : 'on_track';
  return {
    classification,
    status,
    today: today.basis,
    inProgress: { start: ymd(window.measurementStart), end: ymd(addDays(window.measurementEnd, -1)), monthsElapsed: round1(monthsElapsed), hours, averageHours, stabilityStart: ymd(window.stabilityStart), kind },
    offerDue,
  };
}

function monthsBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / (DAY * 30.4375);
}

/* ----- 4980H exposure ------------------------------------------------------ */

/**
 * Employer shared-responsibility amounts, annual, by year (IRS indexing;
 * 2025 per Rev. Proc. 2024-35, 2026 per Rev. Proc. 2025-26). (a) applies
 * to all full-time employees minus 30 when fewer than 95% are offered
 * coverage; (b) to each full-time employee not offered affordable coverage
 * who receives a premium tax credit. These are maximum exposures — the
 * actual assessment depends on who claims a credit (Letter 226-J).
 */
export const PENALTY_4980H: Record<number, { a: number; b: number }> = {
  2025: { a: 2_900, b: 4_350 },
  2026: { a: 3_340, b: 5_010 },
};
export function penaltyAmounts(year: number): { a: number; b: number } {
  return PENALTY_4980H[year] ?? PENALTY_4980H[Math.max(...Object.keys(PENALTY_4980H).map(Number))]!;
}

export function exposure(fullTime: number, offered: number, year: number): { offeredShare: number; a: number; b: number; failsNinetyFive: boolean } {
  const amounts = penaltyAmounts(year);
  const offeredShare = fullTime === 0 ? 1 : offered / fullTime;
  const failsNinetyFive = offeredShare < 0.95;
  return {
    offeredShare: Math.round(offeredShare * 1000) / 10,
    a: failsNinetyFive ? Math.max(0, fullTime - 30) * amounts.a : 0,
    b: Math.max(0, fullTime - offered) * amounts.b,
    failsNinetyFive,
  };
}

/* ----- Loading ------------------------------------------------------------- */

export async function loadAcaConfig(db: Db): Promise<AcaConfig> {
  const row = await db.acaSettings.findUnique({ where: { tenantId: tenantIdForWrite() } });
  if (!row) return DEFAULT_ACA_CONFIG;
  return {
    measurementMonths: row.measurementMonths,
    adminDays: row.adminDays,
    stabilityMonths: row.stabilityMonths,
    initialMeasurementMonths: row.initialMeasurementMonths,
    stabilityStartMonth: row.stabilityStartMonth,
    stabilityStartDay: row.stabilityStartDay,
    fullTimeHoursPerMonth: Number(row.fullTimeHoursPerMonth),
    breakInServiceWeeks: row.breakInServiceWeeks,
    ruleOfParity: row.ruleOfParity,
    defaultOfferCode: row.defaultOfferCode,
    affordabilitySafeHarbor: row.affordabilitySafeHarbor,
    lowestPremiumCents: row.lowestPremiumCents,
  };
}

/** Approved hours per shift (net of breaks) for these people since `from`. */
export async function loadHours(db: Db, associateIds: string[], from: Date): Promise<Map<string, HourEntry[]>> {
  const out = new Map<string, HourEntry[]>(associateIds.map((id) => [id, []]));
  if (associateIds.length === 0) return out;
  const rows = await db.timeEntry.findMany({
    where: { associateId: { in: associateIds }, status: 'APPROVED', clockInAt: { gte: from }, clockOutAt: { not: null } },
    select: { associateId: true, clockInAt: true, clockOutAt: true, breaks: { select: { startedAt: true, endedAt: true } } },
  });
  for (const r of rows) {
    const breakMs = r.breaks.reduce((n, b) => n + (b.endedAt ? b.endedAt.getTime() - b.startedAt.getTime() : 0), 0);
    const hours = Math.max(0, r.clockOutAt!.getTime() - r.clockInAt.getTime() - breakMs) / 3_600_000;
    out.get(r.associateId)?.push({ at: r.clockInAt, hours });
  }
  return out;
}

/** Line 14 / 16 for one month, from the basis, the offer covering it and the settings. */
export function codesForMonth(
  c: AcaConfig,
  basis: MonthBasis,
  offer: { offerCode: AcaCoverageOffer; response: 'PENDING' | 'ENROLLED' | 'WAIVED'; lowestPremiumCents: number | null } | null,
): { offerOfCoverage: AcaCoverageOffer; safeHarbor: string | null; isFullTime: boolean; lowestPremiumCents: number | null } {
  if (basis === 'not_employed') return { offerOfCoverage: 'CODE_1H', safeHarbor: '2A', isFullTime: false, lowestPremiumCents: null };
  if (basis === 'lnap') return { offerOfCoverage: 'CODE_1H', safeHarbor: '2D', isFullTime: false, lowestPremiumCents: null };
  if (basis === 'not_full_time') return { offerOfCoverage: offer ? offer.offerCode : 'CODE_1H', safeHarbor: offer?.response === 'ENROLLED' ? '2C' : '2B', isFullTime: false, lowestPremiumCents: offer ? (offer.lowestPremiumCents ?? c.lowestPremiumCents) : null };
  if (!offer) return { offerOfCoverage: 'CODE_1H', safeHarbor: null, isFullTime: true, lowestPremiumCents: null };
  return {
    offerOfCoverage: offer.offerCode,
    safeHarbor: offer.response === 'ENROLLED' ? '2C' : c.affordabilitySafeHarbor,
    isFullTime: true,
    lowestPremiumCents: offer.lowestPremiumCents ?? c.lowestPremiumCents,
  };
}
