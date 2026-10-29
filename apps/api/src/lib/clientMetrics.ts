import type { Prisma } from '@prisma/client';
import { toDateOnly } from '@alto-people/shared';
import { prisma } from '../db.js';
import { activeBreakdown, placements } from './activeDefinition.js';
import { bucketFor, daysPastDue, dueOnFor } from './books/aging.js';
import { statementBalances } from './books/posting/receivables.js';
import { statementAmounts } from './books/posting/statements.js';
import { splitByPerson } from './laborRules/hours.js';
import { loadPayContext, type PayContext } from './laborRules/payContext.js';
import { isEngineDoubleTime, overtimeRateOf, premiumCost } from './payBillLink.js';
import { tenantIdForWrite } from './tenant.js';
import { orgDateKey } from './timeAnomalies.js';
import { companyWorkweek, dateKeyInZone, startOfWeekInZone, startOfWeekUTC, utcInstantOfLocalMidnight } from './timeAnomalies.js';
import { loadPaidHours } from './paidHours.js';

/**
 * How each client account is doing, in a few numbers (Clients rebuild,
 * 2026-10-22). The clients list and a client's overview both read this, so
 * the row and the record never disagree.
 *
 *   onAssignment   the one definition of active (lib/activeDefinition), by
 *                  placement: the same count the Headcount screen shows.
 *   shiftsNext7    published, not cancelled shifts starting in the next 7
 *                  days; filled = someone is assigned. fillRatePct is null
 *                  when there are none (never a fake 0%).
 *   hoursThisWeek  paid hours (lib/paidHours: approved and completed closed
 *   hoursLastWeek  punches, every break out, split by the labor engine)
 *                  at the client, on the COMPANY week (its start day, in the
 *                  company's time zone) — the metric dictionary's "Hours this
 *                  week" (packages/shared metrics.ts). Each client's own
 *                  weekStartsOn summed to 384.6h on the Clients page beside
 *                  537h and 552h for the same question (LEAD-21); a
 *                  client's own week is the Performance tab's (clientWeeks).
 *   overtimePct    (overtime + double time) ÷ worked hours at the client in
 *                  its last complete week, as the labor engine splits them
 *                  (each person's whole week, at every client — the split
 *                  the paycheck pays). Null when no hours.
 *   money          only when includeMoney (statements readers):
 *                    billedInRange      FINAL statements whose period ends
 *                                       in the range (calendar days)
 *                    outstanding/aging  open balances net of payments, aged
 *                                       by the one definition (books/aging)
 *                    lastStatement*     the newest FINAL statement
 *                    marginPct          hours billed in range against the
 *                                       wages and employer taxes paid for
 *                                       those same hours; null while any of
 *                                       them is not paid yet or nothing
 *                                       was billed.
 *   health         risk / watch / good with short reasons (see healthFor).
 *                  Money signals count only when includeMoney, so a reason
 *                  is never hidden behind a colour.
 *
 * Batched: a fixed number of queries whatever the number of clients (no
 * per-client reads), so a 200-client list answers in one pass.
 */

export interface ClientMoneyMetrics {
  billedInRange: number;
  outstanding: number;
  aging: { current: number; d1_30: number; d31_60: number; d61_90: number; d90plus: number };
  lastStatementTotal: number | null;
  lastStatementAt: string | null;
  marginPct: number | null;
}

export type ClientHealth = 'good' | 'watch' | 'risk';

export interface ClientMetrics {
  clientId: string;
  onAssignment: number;
  shiftsNext7: { total: number; filled: number };
  fillRatePct: number | null;
  hoursThisWeek: number;
  hoursLastWeek: number;
  overtimePct: number | null;
  money?: ClientMoneyMetrics;
  health: ClientHealth;
  healthReasons: string[];
}

export interface ClientMetricsOptions {
  range: { from: Date; to: Date };
  includeMoney: boolean;
  now?: Date;
}

const DAY_MS = 86_400_000;
const round1 = (n: number) => Math.round((n + Number.EPSILON) * 10) / 10;
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
/** A DATE column's day (Prisma reads it as UTC midnight). */
const ymd = (d: Date) => toDateOnly(d)!;
const dollars = (cents: number) => round2(cents / 100);
const usd = (amount: number) => `$${Math.round(amount).toLocaleString('en-US')}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
function pushTo<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}
/** At or under this many clients the active count reads only their people, not the whole tenant. */
const SCOPED_ACTIVE_MAX = 5;

/** Signals the health rules read, kept apart so the rules are testable on their own. */
export interface HealthSignals {
  shiftsNext7: { total: number; filled: number };
  fillRatePct: number | null;
  /** Calendar date (YYYY-MM-DD) the contract ends, when one is on file. */
  contractEndDate: string | null;
  /** Detractor scores (0–6) in the last 90 days. */
  detractorScores: number[];
  /** Open money by how late it is, in dollars; omitted when money doesn't count. */
  pastDue?: { d1_30: number; d31plus: number; oldestDays: number; oldestD1_30: number };
  now: Date;
}

const fmtDay = (key: string) => {
  const d = new Date(`${key}T12:00:00Z`);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
};

/**
 * The health rules:
 *   risk   anything 31+ days past due · fill rate under 80% with 5+ shifts
 *          ahead · the contract ended or ends within 30 days · a detractor
 *          (NPS 0–6) in the last 90 days
 *   watch  1–30 days past due · fill rate 80–94% · under 80% with fewer
 *          than 5 shifts · the contract ends within 60 days
 *   good   none of these
 */
export function healthFor(s: HealthSignals): { health: ClientHealth; reasons: string[] } {
  const risk: string[] = [];
  const watch: string[] = [];

  if (s.pastDue) {
    if (s.pastDue.d31plus > 0) risk.push(`${usd(s.pastDue.d31plus)} is ${s.pastDue.oldestDays} days past due`);
    if (s.pastDue.d1_30 > 0) (s.pastDue.d31plus > 0 ? risk : watch).push(`${usd(s.pastDue.d1_30)} is ${s.pastDue.oldestD1_30} day${s.pastDue.oldestD1_30 === 1 ? '' : 's'} past due`);
  }

  if (s.fillRatePct !== null) {
    const { total, filled } = s.shiftsNext7;
    const line = `${filled} of ${plural(total, 'shift')} in the next 7 days filled (${Math.round(s.fillRatePct)}%)`;
    if (s.fillRatePct < 80 && total >= 5) risk.push(line);
    else if (s.fillRatePct < 95) watch.push(line);
  }

  if (s.contractEndDate) {
    // The company's calendar, as the overview and Performance tab count it.
    const today = orgDateKey(s.now);
    const days = Math.round((Date.parse(`${s.contractEndDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS);
    if (days < 0) risk.push(`Contract ended ${fmtDay(s.contractEndDate)}`);
    else if (days <= 30) risk.push(days === 0 ? 'Contract ends today' : `Contract ends in ${plural(days, 'day')} (${fmtDay(s.contractEndDate)})`);
    else if (days <= 60) watch.push(`Contract ends in ${days} days (${fmtDay(s.contractEndDate)})`);
  }

  if (s.detractorScores.length > 0) {
    const low = Math.min(...s.detractorScores);
    risk.push(s.detractorScores.length === 1 ? `NPS detractor (scored ${low}) in the last 90 days` : `${s.detractorScores.length} NPS detractors in the last 90 days (lowest ${low})`);
  }

  if (risk.length > 0) return { health: 'risk', reasons: [...risk, ...watch] };
  if (watch.length > 0) return { health: 'watch', reasons: watch };
  return { health: 'good', reasons: [] };
}

/** Active people per client by the one definition; for a few clients, only their people are read. */
async function onAssignmentByClient(ids: string[], now: Date): Promise<Map<string, number>> {
  const tenantId = tenantIdForWrite();
  if (ids.length <= SCOPED_ACTIVE_MAX) {
    const placed = new Set<string>();
    for (const clientId of ids) for (const id of (await placements({ clientId, tenantId })).keys()) placed.add(id);
    if (placed.size === 0) return new Map();
    // Re-placed across every client: someone placed here and newer elsewhere counts there.
    return (await activeBreakdown(now, prisma, undefined, { tenantId, associateIds: [...placed] })).byClient;
  }
  return (await activeBreakdown(now, prisma, undefined, { tenantId })).byClient;
}

const ENTRY_SELECT = {
  id: true,
  associateId: true,
  clientId: true,
  locationId: true,
  clockInAt: true,
  clockOutAt: true,
  status: true,
  breaks: { select: { type: true, startedAt: true, endedAt: true } },
  location: { select: { id: true, state: true, city: true, timezone: true } },
} satisfies Prisma.TimeEntrySelect;

/** One worked punch at a client, as the engine splits it: its hours and the overtime among them. */
interface WorkShare {
  clientId: string;
  /** The site's clock (the company zone when the punch names no site). */
  tz: string;
  clockInAt: Date;
  workedHours: number;
  overtimeHours: number;
}

const CLOSED_WORK = { status: { in: ['COMPLETED', 'APPROVED'] }, clockOutAt: { not: null } } satisfies Prisma.TimeEntryWhereInput;

/**
 * The worked punches at these clients from `from` to `now`, each with its
 * share of the labor engine's split. The split runs over everything those
 * people worked — at any client — from a week before `from`, so a week is
 * counted once, the way their paycheck counts it. Two reads.
 */
async function workAtClients(clientIds: string[], from: Date, now: Date, pay: PayContext): Promise<WorkShare[]> {
  const tenantId = tenantIdForWrite();
  const workers = await prisma.timeEntry.findMany({
    where: { tenantId, ...CLOSED_WORK, clientId: { in: clientIds }, clockInAt: { gte: from, lte: now } },
    select: { associateId: true },
    distinct: ['associateId'],
  });
  if (workers.length === 0) return [];
  const entries = await prisma.timeEntry.findMany({
    where: { tenantId, ...CLOSED_WORK, associateId: { in: workers.map((w) => w.associateId) }, clockInAt: { gte: new Date(from.getTime() - 8 * DAY_MS), lte: now } },
    select: ENTRY_SELECT,
    take: 200_000,
  });
  const work = entries.map((raw) => ({ raw, h: { ...pay.forPay(raw), site: raw.location } }));
  const { byEntry } = splitByPerson(pay.rules, work.map((w) => w.h));
  const wanted = new Set(clientIds);
  const companyTz = companyWorkweek().timezone;
  const out: WorkShare[] = [];
  for (const { raw, h } of work) {
    if (!raw.clientId || !wanted.has(raw.clientId) || raw.clockInAt < from) continue;
    const share = byEntry.get(h);
    if (!share || share.workedHours <= 0) continue;
    out.push({ clientId: raw.clientId, tz: raw.location?.timezone ?? companyTz, clockInAt: raw.clockInAt, workedHours: share.workedHours, overtimeHours: share.overtimeHours + share.doubleTimeHours });
  }
  return out;
}

/** The local date (YYYY-MM-DD) a client week starts on, for the week containing `d` on a clock. */
function weekKey(d: Date, tz: string, weekStartsOn: number): string {
  return dateKeyInZone(startOfWeekInZone(d, tz, weekStartsOn), tz);
}

const addDays = (key: string, days: number) => {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  // eslint-disable-next-line no-restricted-syntax -- UTC on purpose: calendar arithmetic on a date key, never an instant.
  return d.toISOString().slice(0, 10);
};

export async function clientMetrics(
  clientIds: string[],
  opts: { range: { from: Date; to: Date }; includeMoney: boolean; now?: Date },
): Promise<Map<string, ClientMetrics>> {
  const out = new Map<string, ClientMetrics>();
  const ids = [...new Set(clientIds)];
  if (ids.length === 0) return out;
  const now = opts.now ?? new Date();
  const tenantId = tenantIdForWrite();

  const clients = await prisma.client.findMany({ where: { id: { in: ids }, tenantId }, select: { id: true, contractEndDate: true } });
  const contractEnds = new Map(clients.map((c) => [c.id, c.contractEndDate ? ymd(c.contractEndDate) : null]));
  const known = clients.map((c) => c.id);
  if (known.length === 0) return out;

  const in7 = new Date(now.getTime() + 7 * DAY_MS);
  const shiftWhere: Prisma.ShiftWhereInput = {
    tenantId,
    clientId: { in: known },
    startsAt: { gte: now, lt: in7 },
    status: { notIn: ['DRAFT', 'CANCELLED'] },
    publishedAt: { not: null },
  };

  // This company week and last (LEAD-21): read whole, from the start of last week.
  const thisStart = startOfWeekUTC(now);
  const lastStart = startOfWeekUTC(new Date(thisStart.getTime() - 36 * 3_600_000));
  const [active, shiftTotals, shiftFilled, detractors, workers] = await Promise.all([
    onAssignmentByClient(known, now),
    prisma.shift.groupBy({ by: ['clientId'], where: shiftWhere, _count: { _all: true } }),
    prisma.shift.groupBy({ by: ['clientId'], where: { ...shiftWhere, assignedAssociateId: { not: null } }, _count: { _all: true } }),
    prisma.clientNpsInvite.findMany({
      where: { tenantId, clientId: { in: known }, respondedAt: { gte: new Date(now.getTime() - 90 * DAY_MS), lte: now }, score: { not: null, lte: 6 } },
      select: { clientId: true, score: true },
      take: 5000,
    }),
    // Everyone who worked at these clients in the two weeks: their whole
    // weeks are read, so overtime splits over every client as pay splits it.
    prisma.timeEntry.findMany({
      where: { tenantId, ...CLOSED_WORK, clientId: { in: known }, clockInAt: { gte: lastStart, lt: now } },
      select: { associateId: true },
      distinct: ['associateId'],
    }),
  ]);

  // "Hours this week" is the metric dictionary's one definition (packages/
  // shared metrics.ts METRICS.hoursThisWeek): paid hours (lib/paidHours) on
  // the COMPANY week. Each client's own weekStartsOn summed to 384.6 h on
  // the Clients page beside 537 h and 552 h elsewhere (LEAD-21).
  const shares = workers.length
    ? await loadPaidHours(prisma, { tenantId, from: lastStart, to: now, where: { associateId: { in: workers.map((w) => w.associateId) } } })
    : [];
  const wanted = new Set(known);
  const hours = new Map<string, { thisWeek: number; lastWeek: number; lastOt: number }>();
  for (const sh of shares) {
    const cid = sh.entry.clientId;
    if (!cid || !wanted.has(cid)) continue;
    const agg = hours.get(cid) ?? { thisWeek: 0, lastWeek: 0, lastOt: 0 };
    // The punch belongs to the week its clock-in falls in (every consumer's rule).
    if (sh.entry.clockInAt >= thisStart) agg.thisWeek += sh.hours;
    else {
      agg.lastWeek += sh.hours;
      agg.lastOt += sh.otHours;
    }
    hours.set(cid, agg);
  }

  const totals = new Map(shiftTotals.map((r) => [r.clientId, r._count._all]));
  const filled = new Map(shiftFilled.map((r) => [r.clientId, r._count._all]));
  const detractorsBy = new Map<string, number[]>();
  for (const d of detractors) pushTo(detractorsBy, d.clientId, d.score!);

  const money = opts.includeMoney ? await moneyByClient(known, opts.range, now) : null;

  for (const clientId of known) {
    const total = totals.get(clientId) ?? 0;
    const shiftsNext7 = { total, filled: filled.get(clientId) ?? 0 };
    const fillRatePct = total > 0 ? round1((shiftsNext7.filled / total) * 100) : null;
    const h = hours.get(clientId);
    const m = money?.get(clientId);
    const { health, reasons } = healthFor({
      shiftsNext7,
      fillRatePct,
      contractEndDate: contractEnds.get(clientId) ?? null,
      detractorScores: detractorsBy.get(clientId) ?? [],
      ...(m ? { pastDue: m.pastDue } : {}),
      now,
    });
    out.set(clientId, {
      clientId,
      onAssignment: active.get(clientId) ?? 0,
      shiftsNext7,
      fillRatePct,
      hoursThisWeek: round2(h?.thisWeek ?? 0),
      hoursLastWeek: round2(h?.lastWeek ?? 0),
      overtimePct: h && h.lastWeek > 0 ? round1((h.lastOt / h.lastWeek) * 100) : null,
      ...(m ? { money: m.metrics } : {}),
      health,
      healthReasons: reasons,
    });
  }
  return out;
}

/* ----- Week by week (the Performance tab) ------------------------------------ */

export interface ClientWeek {
  /** The week's first day (YYYY-MM-DD) on the client's week (weekStartsOn), site clock. */
  start: string;
  hours: number;
  overtimeHours: number;
  /** Null when no hours. */
  overtimePct: number | null;
  /** Published, not cancelled shifts that started in the week, and how many had someone assigned. */
  shifts: number;
  filled: number;
  /** Null when no shifts. */
  fillRatePct: number | null;
}

/**
 * The client's last `weeks` complete weeks, oldest first: hours worked and
 * the overtime among them (the engine's split, as above), and the fill rate
 * of the shifts that started in each. The same definitions as
 * clientMetrics, so last week here is last week on the list.
 */
export async function clientWeeks(clientId: string, opts: { weeks: number; now?: Date }): Promise<{ weekStartsOn: number; timezone: string; weeks: ClientWeek[] } | null> {
  const now = opts.now ?? new Date();
  const tenantId = tenantIdForWrite();
  const client = await prisma.client.findFirst({ where: { id: clientId, tenantId }, select: { weekStartsOn: true, locations: { where: { deletedAt: null }, select: { timezone: true } } } });
  if (!client) return null;
  const ws = client.weekStartsOn;
  // The weeks are labelled on the client's clock: its sites' zone when they share one, else the company's.
  const zones = [...new Set(client.locations.map((l) => l.timezone).filter((z): z is string => !!z))];
  const tz = zones.length === 1 ? zones[0]! : companyWorkweek().timezone;
  const thisKey = weekKey(now, tz, ws);
  const keys = Array.from({ length: opts.weeks }, (_, i) => addDays(thisKey, -7 * (opts.weeks - i)));
  // A day of slack: a site west of the label zone starts its week later.
  const from = new Date(utcInstantOfLocalMidnight(keys[0]!, tz).getTime() - DAY_MS);
  const until = utcInstantOfLocalMidnight(thisKey, tz);

  const pay = await loadPayContext(prisma, tenantId);
  const [work, shifts] = await Promise.all([
    workAtClients([clientId], from, now, pay),
    prisma.shift.findMany({
      where: { tenantId, clientId, startsAt: { gte: from, lt: new Date(until.getTime() + DAY_MS) }, status: { notIn: ['DRAFT', 'CANCELLED'] }, publishedAt: { not: null } },
      select: { startsAt: true, assignedAssociateId: true, locationRel: { select: { timezone: true } } },
      take: 50_000,
    }),
  ]);
  const byWeek = new Map(keys.map((k) => [k, { hours: 0, ot: 0, shifts: 0, filled: 0 }]));
  for (const w of work) {
    const b = byWeek.get(weekKey(w.clockInAt, w.tz, ws));
    if (!b) continue;
    b.hours += w.workedHours;
    b.ot += w.overtimeHours;
  }
  for (const sh of shifts) {
    const b = byWeek.get(weekKey(sh.startsAt, sh.locationRel?.timezone ?? tz, ws));
    if (!b) continue;
    b.shifts += 1;
    if (sh.assignedAssociateId) b.filled += 1;
  }
  return {
    weekStartsOn: ws,
    timezone: tz,
    weeks: keys.map((start) => {
      const b = byWeek.get(start)!;
      return {
        start,
        hours: round2(b.hours),
        overtimeHours: round2(b.ot),
        overtimePct: b.hours > 0 ? round1((b.ot / b.hours) * 100) : null,
        shifts: b.shifts,
        filled: b.filled,
        fillRatePct: b.shifts > 0 ? round1((b.filled / b.shifts) * 100) : null,
      };
    }),
  };
}

/* ----- Money ---------------------------------------------------------------- */

interface MoneyRow {
  metrics: ClientMoneyMetrics;
  pastDue: NonNullable<HealthSignals['pastDue']>;
}

const zeroAging = (): ClientMoneyMetrics['aging'] => ({ current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 });
const AGING_KEY = { current: 'current', days1to30: 'd1_30', days31to60: 'd31_60', days61to90: 'd61_90', over90: 'd90plus' } as const;

async function moneyByClient(ids: string[], range: { from: Date; to: Date }, now: Date): Promise<Map<string, MoneyRow>> {
  const tenantId = tenantIdForWrite();
  const fromDay = new Date(`${ymd(range.from)}T00:00:00.000Z`);
  const toDay = new Date(`${ymd(range.to)}T00:00:00.000Z`);
  const [open, billed, latest] = await Promise.all([
    // Unpaid FINAL statements, net of payments applied (the Books aging's own source).
    statementBalances(prisma, { clientId: { in: ids }, paidAt: null }),
    prisma.clientStatement.findMany({
      where: { tenantId, clientId: { in: ids }, status: 'FINAL', periodEnd: { gte: fromDay, lte: toDay } },
      select: { id: true, clientId: true, periodStart: true, periodEnd: true, snapshot: true },
      take: 20_000,
    }),
    prisma.clientStatement.findMany({
      where: { tenantId, clientId: { in: ids }, status: 'FINAL' },
      orderBy: [{ clientId: 'asc' }, { periodEnd: 'desc' }],
      distinct: ['clientId'],
      select: { clientId: true, periodEnd: true, finalizedAt: true, snapshot: true },
    }),
  ]);

  const agingCents = new Map<string, Record<keyof ClientMoneyMetrics['aging'], number>>();
  const pastDue = new Map<string, NonNullable<HealthSignals['pastDue']>>();
  // Statements age on the company's calendar (as /performance and the overview
  // do): a UTC day read one day later after 5 PM Pacific.
  const asOf = orgDateKey(now);
  for (const b of open) {
    if (b.open <= 0) continue;
    const days = daysPastDue(dueOnFor(b) ?? b.periodEnd, asOf);
    const a = agingCents.get(b.clientId) ?? { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 };
    a[AGING_KEY[bucketFor(days)]] += b.open;
    agingCents.set(b.clientId, a);
    if (days > 0) {
      const p = pastDue.get(b.clientId) ?? { d1_30: 0, d31plus: 0, oldestDays: 0, oldestD1_30: 0 };
      if (days > 30) {
        p.d31plus += b.open / 100;
        p.oldestDays = Math.max(p.oldestDays, days);
      } else {
        p.d1_30 += b.open / 100;
        p.oldestD1_30 = Math.max(p.oldestD1_30, days);
      }
      pastDue.set(b.clientId, p);
    }
  }

  const billedCents = new Map<string, number>();
  for (const s of billed) billedCents.set(s.clientId, (billedCents.get(s.clientId) ?? 0) + statementAmounts(s.snapshot).total);
  const last = new Map(latest.map((s) => [s.clientId, s]));
  const margin = await marginByClient(billed);

  const out = new Map<string, MoneyRow>();
  for (const clientId of ids) {
    const a = agingCents.get(clientId);
    const aging = a ? { current: dollars(a.current), d1_30: dollars(a.d1_30), d31_60: dollars(a.d31_60), d61_90: dollars(a.d61_90), d90plus: dollars(a.d90plus) } : zeroAging();
    const l = last.get(clientId);
    out.set(clientId, {
      metrics: {
        billedInRange: dollars(billedCents.get(clientId) ?? 0),
        outstanding: a ? dollars(a.current + a.d1_30 + a.d31_60 + a.d61_90 + a.d90plus) : 0,
        aging,
        lastStatementTotal: l ? dollars(statementAmounts(l.snapshot).total) : null,
        lastStatementAt: l ? (l.finalizedAt?.toISOString() ?? `${ymd(l.periodEnd)}T00:00:00.000Z`) : null,
        marginPct: margin.get(clientId) ?? null,
      },
      pastDue: pastDue.get(clientId) ?? { d1_30: 0, d31plus: 0, oldestDays: 0, oldestD1_30: 0 },
    });
  }
  return out;
}

/**
 * Margin on what was billed: the hours on the range's FINAL statements
 * against what pay paid for those same hours — each paycheck's wages for
 * its hours (regular and overtime lines, the engine's double time at the
 * overtime rate) spread over every hour it paid, plus that check's
 * employer taxes in proportion. Premiums and adjustments sit outside both
 * sides. A client whose billed hours are not all paid yet gets null.
 */
async function marginByClient(billed: Array<{ id: string; clientId: string; periodStart: Date; periodEnd: Date; snapshot: Prisma.JsonValue }>): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  if (billed.length === 0) return out;
  const tenantId = tenantIdForWrite();
  const revenue = new Map<string, number>();
  for (const s of billed) revenue.set(s.clientId, (revenue.get(s.clientId) ?? 0) + statementAmounts(s.snapshot).hours);
  const periods = billed.map((s) => ({ clientId: s.clientId, from: s.periodStart.getTime(), toEx: s.periodEnd.getTime() + DAY_MS }));
  const periodsOf = new Map<string, typeof periods>();
  for (const p of periods) pushTo(periodsOf, p.clientId, p);
  const minFrom = new Date(Math.min(...periods.map((p) => p.from)));
  const maxToEx = new Date(Math.max(...periods.map((p) => p.toEx)));
  const clientIds = [...new Set(billed.map((s) => s.clientId))];

  const billedEntries = (
    await prisma.timeEntry.findMany({
      where: { tenantId, clientId: { in: clientIds }, status: 'APPROVED', clockOutAt: { not: null }, clockInAt: { gte: minFrom, lt: maxToEx } },
      select: { id: true, associateId: true, clientId: true, clockInAt: true },
      take: 200_000,
    })
  ).filter((e) => (periodsOf.get(e.clientId!) ?? []).some((p) => e.clockInAt.getTime() >= p.from && e.clockInAt.getTime() < p.toEx));
  if (billedEntries.length === 0) return out;

  const associateIds = [...new Set(billedEntries.map((e) => e.associateId))];
  const items = await prisma.payrollItem.findMany({
    where: {
      associateId: { in: associateIds },
      // The regular check pays the hours; off-cycle, amendment, daily and manual runs settle around it.
      payrollRun: { tenantId, kind: 'REGULAR', status: { in: ['FINALIZED', 'DISBURSED'] }, periodStart: { lt: maxToEx }, periodEnd: { gte: minFrom } },
    },
    select: {
      associateId: true,
      grossPay: true,
      hourlyRate: true,
      employerFica: true,
      employerMedicare: true,
      employerFuta: true,
      employerSuta: true,
      payrollRun: { select: { periodStart: true, periodEnd: true } },
      earnings: { select: { kind: true, amount: true, hours: true, rate: true, notes: true } },
    },
    take: 20_000,
  });
  if (items.length === 0) {
    for (const c of clientIds) out.set(c, null);
    return out;
  }
  // Every approved hour each check paid (at any client), to spread its wages over.
  const runFrom = new Date(Math.min(...items.map((i) => i.payrollRun.periodStart.getTime())));
  const runToEx = new Date(Math.max(...items.map((i) => i.payrollRun.periodEnd.getTime())) + DAY_MS);
  const [paidEntries, pay] = await Promise.all([
    prisma.timeEntry.findMany({
      where: { tenantId, associateId: { in: associateIds }, status: 'APPROVED', clockOutAt: { not: null }, clockInAt: { gte: new Date(runFrom.getTime() - 8 * DAY_MS), lt: runToEx } },
      select: ENTRY_SELECT,
      take: 200_000,
    }),
    loadPayContext(prisma, tenantId),
  ]);
  const work = paidEntries.map((raw) => ({ raw, h: { ...pay.forPay(raw), site: raw.location } }));
  const { byEntry } = splitByPerson(pay.rules, work.map((w) => w.h));
  const workedById = new Map(work.map(({ raw, h }) => [raw.id, byEntry.get(h)?.workedHours ?? 0]));

  const workOf = new Map<string, Array<{ at: number; hours: number }>>();
  for (const { raw } of work) pushTo(workOf, raw.associateId, { at: raw.clockInAt.getTime(), hours: workedById.get(raw.id) ?? 0 });
  const checksOf = new Map<string, Array<{ from: number; toEx: number; perHour: number | null }>>();
  for (const item of items) {
    const from = item.payrollRun.periodStart.getTime();
    const toEx = item.payrollRun.periodEnd.getTime() + DAY_MS;
    const paidHours = (workOf.get(item.associateId) ?? []).reduce((n, w) => (w.at >= from && w.at < toEx ? n + w.hours : n), 0);
    const otRate = overtimeRateOf(item);
    const wages = item.earnings.reduce(
      (s, e) => s + ((e.kind === 'REGULAR' && !e.notes) || e.kind === 'OVERTIME' ? Number(e.amount) : isEngineDoubleTime(e) ? Number(e.amount) - premiumCost(e, otRate) : 0),
      0,
    );
    const gross = Number(item.grossPay);
    const taxes = Number(item.employerFica) + Number(item.employerMedicare) + Number(item.employerFuta) + Number(item.employerSuta);
    // Cost of one paid hour on this check: its wage, plus the employer taxes that wage carried.
    const perHour = paidHours > 0 ? (wages / paidHours) * (gross > 0 ? 1 + taxes / gross : 1) : null;
    pushTo(checksOf, item.associateId, { from, toEx, perHour });
  }

  const cost = new Map<string, number>();
  const unpaid = new Set<string>();
  for (const e of billedEntries) {
    const at = e.clockInAt.getTime();
    const check = (checksOf.get(e.associateId) ?? []).find((c) => at >= c.from && at < c.toEx && c.perHour !== null);
    if (!check) {
      unpaid.add(e.clientId!);
      continue;
    }
    cost.set(e.clientId!, (cost.get(e.clientId!) ?? 0) + (workedById.get(e.id) ?? 0) * check.perHour!);
  }
  for (const clientId of clientIds) {
    const rev = (revenue.get(clientId) ?? 0) / 100;
    if (unpaid.has(clientId) || rev <= 0 || !cost.has(clientId)) {
      out.set(clientId, null);
      continue;
    }
    out.set(clientId, round1(((rev - cost.get(clientId)!) / rev) * 100));
  }
  return out;
}
