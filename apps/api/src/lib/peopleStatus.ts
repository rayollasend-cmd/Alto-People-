import type { Prisma, PrismaClient } from '@prisma/client';
import { ON_THE_BOOKS_STATUSES, WORK_STATUSES, type WorkStatus, type WorkStatusCounts } from '@alto-people/shared';
import { prisma as defaultPrisma } from '../db.js';
import { activeAndPlaced } from './activeDefinition.js';

/**
 * ONE STATUS PER PERSON, and the two headline numbers read from it
 * (Fortune 500 fix-up, SH-4; the vocabulary is packages/shared peopleStatus).
 *
 *   SEPARATED          a separation is recorded (or the record was erased),
 *                      and no rehire is in flight
 *   DEACTIVATED        paused by hand; still employed ("Paused")
 *   ACTIVE             the one definition of active (lib/activeDefinition):
 *                      placed, and worked in the window or has a shift ahead ("Working")
 *   ONBOARDING         an application in flight (draft, submitted, in review)
 *                      and none approved: not hired yet, including a rehire
 *                      whose new application is in flight
 *   PLACED_NOT_ACTIVE  placed at a site (an open assignment, or an approved
 *                      application with no assignment anywhere), no work in
 *                      the window and nothing scheduled ("No recent shifts")
 *   NOT_PLACED         hired, placed nowhere
 *
 *   On the books = hired and not separated = ACTIVE + PLACED_NOT_ACTIVE +
 *   NOT_PLACED + DEACTIVATED. Working = ACTIVE.
 *
 * A person's HIRE DATE is Associate.hireDate, else their first approved
 * application, else (someone on the books with neither, an older record)
 * the day the record was made. Hires in a window and the headcount on a
 * past day both read it, so the Headcount screen's hires and People
 * analytics' month-by-month hires are the same count.
 *
 * Every page that shows where people stand reads this module: the people
 * directory (row badge and tiles), Headcount, Analytics, People analytics.
 */

type Db = PrismaClient | Prisma.TransactionClient;
const DAY_MS = 86_400_000;
const IN_FLIGHT = ['DRAFT', 'SUBMITTED', 'IN_REVIEW'] as const;

export interface PeopleScope {
  tenantId: string;
  /** Only these people (a page of a list, or a bounded caller's reach). */
  associateIds?: string[];
}

export interface Standing {
  id: string;
  status: WorkStatus;
  /** When they were hired; null for someone never hired (onboarding). Never after `now` for someone on the books. */
  hiredOn: Date | null;
  /** When they left (separation or erasure); null while on the books. Never after `now`. */
  leftAt: Date | null;
}

export interface Standings {
  people: Map<string, Standing>;
  windowDays: number;
  now: Date;
}

/** Where everyone in scope stands, by the one rule. */
export async function peopleStandings(scope: PeopleScope, now: Date = new Date(), db: Db = defaultPrisma): Promise<Standings> {
  const idFilter = scope.associateIds ? { id: { in: scope.associateIds } } : {};
  const [associates, apps, reading] = await Promise.all([
    db.associate.findMany({
      where: { tenantId: scope.tenantId, deletedAt: null, ...idFilter },
      select: { id: true, hireDate: true, createdAt: true, separatedAt: true, deactivatedAt: true, erasedAt: true },
    }),
    db.application.findMany({
      where: {
        deletedAt: null,
        status: { in: [...IN_FLIGHT, 'APPROVED'] },
        associate: { tenantId: scope.tenantId, deletedAt: null, ...idFilter },
      },
      select: { associateId: true, status: true, approvedAt: true },
    }),
    activeAndPlaced({ tenantId: scope.tenantId, ...(scope.associateIds ? { associateIds: scope.associateIds } : {}) }, now, db),
  ]);
  const inFlight = new Set<string>();
  const firstApproved = new Map<string, Date | null>();
  for (const a of apps) {
    if (a.status === 'APPROVED') {
      const prev = firstApproved.get(a.associateId);
      const at = a.approvedAt ?? null;
      if (prev === undefined || (at && (!prev || at < prev))) firstApproved.set(a.associateId, at);
    } else {
      inFlight.add(a.associateId);
    }
  }
  const people = new Map<string, Standing>();
  const clamp = (d: Date) => (d.getTime() > now.getTime() ? now : d);
  for (const a of associates) {
    const approved = firstApproved.has(a.id);
    const flying = inFlight.has(a.id);
    let status: WorkStatus;
    if (a.erasedAt) status = 'SEPARATED';
    else if (a.separatedAt) status = flying ? 'ONBOARDING' : 'SEPARATED';
    else if (a.deactivatedAt) status = 'DEACTIVATED';
    else if (reading.active.has(a.id)) status = 'ACTIVE';
    else if (flying && !approved) status = 'ONBOARDING';
    else if (reading.placed.has(a.id)) status = 'PLACED_NOT_ACTIVE';
    else status = 'NOT_PLACED';

    const left = a.separatedAt ?? a.erasedAt ?? null;
    const leftAt = status === 'SEPARATED' || (status === 'ONBOARDING' && left) ? clamp(left ?? now) : null;
    const hireEvidence = a.hireDate ?? firstApproved.get(a.id) ?? null;
    let hiredOn: Date | null;
    if (ON_THE_BOOKS_STATUSES.includes(status)) hiredOn = clamp(hireEvidence ?? a.createdAt);
    else if (leftAt) hiredOn = hireEvidence ?? a.createdAt; // someone who left was hired once
    else hiredOn = null; // onboarding for the first time: not hired yet
    if (hiredOn && leftAt && hiredOn > leftAt) hiredOn = leftAt;
    people.set(a.id, { id: a.id, status, hiredOn, leftAt });
  }
  return { people, windowDays: reading.windowDays, now };
}

/** The counts every page shows, from one reading. */
export function countStandings(s: Standings): WorkStatusCounts {
  const counts = Object.fromEntries(WORK_STATUSES.map((k) => [k, 0])) as Record<WorkStatus, number>;
  for (const p of s.people.values()) counts[p.status] += 1;
  const onTheBooks = ON_THE_BOOKS_STATUSES.reduce((n, k) => n + counts[k], 0);
  return { ...counts, onTheBooks, total: s.people.size, windowDays: s.windowDays };
}

/** People in scope by status — the directory tiles, Headcount's "Not active" card, Analytics' headline. */
export async function workStatusCounts(scope: PeopleScope, now: Date = new Date(), db: Db = defaultPrisma): Promise<WorkStatusCounts> {
  return countStandings(await peopleStandings(scope, now, db));
}

/** On the books at an instant: hired on or before it and not yet gone. At `now` this equals counts.onTheBooks. */
export function onTheBooksAt(s: Standings, at: Date): number {
  let n = 0;
  for (const p of s.people.values()) {
    if (p.hiredOn && p.hiredOn.getTime() <= at.getTime() && (!p.leftAt || p.leftAt.getTime() > at.getTime())) n += 1;
  }
  return n;
}

/** Hires in [from, to): the one count behind every "hires" number. */
export function hiresBetween(s: Standings, from: Date, to: Date): number {
  let n = 0;
  for (const p of s.people.values()) {
    if (p.hiredOn && p.hiredOn >= from && p.hiredOn < to) n += 1;
  }
  return n;
}

/** Separations in [from, to). */
export function separationsBetween(s: Standings, from: Date, to: Date): number {
  let n = 0;
  for (const p of s.people.values()) {
    if (p.leftAt && p.leftAt >= from && p.leftAt < to) n += 1;
  }
  return n;
}

/**
 * THE turnover formula: separations in the window over the average number
 * on the books during it (sampled weekly from the window's start, and at its
 * end), annualized. Null when nobody was on the books.
 */
export function turnoverBetween(s: Standings, from: Date, to: Date): { hires: number; separations: number; averageOnTheBooks: number; annualizedPct: number | null } {
  const samples: number[] = [];
  for (let t = from.getTime(); t < to.getTime(); t += 7 * DAY_MS) samples.push(onTheBooksAt(s, new Date(t)));
  samples.push(onTheBooksAt(s, to));
  const average = samples.reduce((a, b) => a + b, 0) / samples.length;
  const separations = separationsBetween(s, from, to);
  const days = Math.max(1, (to.getTime() - from.getTime()) / DAY_MS);
  return {
    hires: hiresBetween(s, from, to),
    separations,
    averageOnTheBooks: Math.round(average * 10) / 10,
    annualizedPct: annualizedTurnoverPct(separations, average, days),
  };
}

/** Separations over an average headcount, annualized, as a percent with one decimal. */
export function annualizedTurnoverPct(separations: number, averageHeadcount: number, days: number): number | null {
  if (averageHeadcount <= 0) return null;
  return Math.round((separations / averageHeadcount) * (365 / Math.max(1, days)) * 1000) / 10;
}
