import type { Prisma, PrismaClient } from '@prisma/client';
import { currentRateCards } from './rateCards.js';
import { env } from '../config/env.js';
import { startOfWeekUTC } from './timeAnomalies.js';
import { splitByPerson } from './laborRules/hours.js';
import { loadPayContext } from './laborRules/payContext.js';
import { readyAdjustments, termsFor, type SnapshotAdjustment } from './payBillLink.js';

type Db = Prisma.TransactionClient | PrismaClient;

/**
 * Client billing/SLA statement computation.
 *
 * Approved time in the period, priced with the same resolution chain the
 * labor-cost report uses (shift's own bill rate → per-(client, position)
 * default → org SOW standards).
 *
 * WHICH hours are overtime is the labor-rules engine's answer — the split
 * the paycheck pays (lib/laborRules/hours.splitHours), over everything the
 * person worked in the week, at every client (cross-client), with punch
 * rounding and live jurisdictions exactly as pay applies them. The client is
 * never billed on a different overtime split than the associate is paid on.
 *
 * HOW those hours are billed is the client's contract (lib/payBillLink
 * BillingTerms), not labor law: the law decides what the worker is owed; the
 * contract decides what the client pays for it.
 *   - MULTIPLIED (the default): overtime hours at the engine's overtime
 *     multiplier (1.5×) of the bill rate; STRAIGHT: at straight time.
 *   - Double-time hours (a live jurisdiction's daily rule, CA past 12 h) are
 *     hours worked beyond overtime and are billed like overtime; what double
 *     time pays beyond the overtime rate is a premium the contract bills or
 *     not (the DOUBLE_TIME premium rule), as an adjustment when payroll
 *     finalizes (payBillLink.linkPremiums) — never twice.
 *
 * The result is a plain-JSON snapshot: DRAFT statements recompute it on
 * demand; FINAL statements freeze it forever.
 */

export interface StatementLine {
  label: string;
  /** Hours to the hundredth; a statement's lines add up to its hours total. */
  hours: number;
  /** The billed rate to the cent — one rate per line (older snapshots: amount ÷ hours). */
  rate: number;
  /** hours × rate, rounded to the cent; the lines add up to the services total. */
  amount: number;
}

export interface StatementSnapshot {
  clientName: string;
  periodStart: string;
  periodEnd: string;
  /** When this snapshot was computed — drafts show their staleness. */
  generatedAt?: string;
  lines: StatementLine[];
  stores: Array<{ locationName: string; hours: number; amount: number }>;
  /** Lines payroll owes this bill (lib/payBillLink): retro pay rebilled, premiums billed by contract. */
  adjustments?: SnapshotAdjustment[];
  /** How the contract bills overtime: at 1.5× the bill rate, or straight time. */
  overtimeBilling?: 'MULTIPLIED' | 'STRAIGHT';
  /** A standalone statement billing only adjustments (its hours' period already closed). */
  adjustmentsOnly?: boolean;
  totals: {
    hours: number;
    regularHours: number;
    otHours: number;
    /** Hours past a live jurisdiction's double-time line, billed like overtime (absent on older snapshots). */
    doubleTimeHours?: number;
    /** What the client owes: subtotal + sales tax (hours + adjustments before 2026-10-21). */
    amount: number;
    /** The hours alone, and the adjustments alone (absent on older snapshots). */
    hoursAmount?: number;
    adjustmentsAmount?: number;
    /** Hours + adjustments, before tax (absent on snapshots that predate sales tax: then equal to amount). */
    subtotal?: number;
    /** The client's sales tax rate on this statement (percent) and the tax it adds; absent or 0 = not taxable. */
    salesTaxRatePct?: number;
    salesTax?: number;
  };
  sla: {
    publishedShifts: number;
    assignedShifts: number;
    fillRatePct: number | null;
    punctualPct: number | null;
    noShows: number;
    /** COMPLETED-but-unapproved entries in the period — the "this draft is
     *  provisional" honesty counter. */
    pendingEntries: number;
  };
}

const round2 = (v: number) => Math.round(v * 100) / 100;
// eslint-disable-next-line no-restricted-syntax -- UTC on purpose: statement period bounds are day keys (a company midnight or UTC midnight).
const ymd = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Largest-remainder rounding (audit 2026-10-29 CODE-13): whole units (cents,
 * hundredths of an hour) that add up to `target` exactly, each within one
 * unit of its exact share. Deterministic: the biggest remainders take the
 * spare units first, ties in the order given (callers sort their rows).
 * Lines rounded one by one drifted from the total: three 20-minute lines at
 * $10 printed 3.33 + 3.33 + 3.33 under a $10.00 total.
 */
export function apportion(exact: number[], target: number): number[] {
  const base = exact.map((v) => Math.floor(v + 1e-9));
  let diff = Math.round(target) - base.reduce((a, b) => a + b, 0);
  if (exact.length === 0 || diff === 0) return base;
  const rem = exact.map((v, i) => ({ i, r: v - base[i]! }));
  const order = diff > 0 ? [...rem].sort((a, b) => b.r - a.r || a.i - b.i) : [...rem].sort((a, b) => a.r - b.r || a.i - b.i);
  const step = diff > 0 ? 1 : -1;
  for (let k = 0; diff !== 0; k = (k + 1) % order.length) {
    base[order[k]!.i]! += step;
    diff -= step;
  }
  return base;
}

/**
 * An invoice's lines as a client checks them: hours to the hundredth, a rate
 * to the cent, and amount = hours × rate rounded to the cent — so every line
 * verifies on its own and the lines add up to the services total. The hours
 * are apportioned (largest remainder) so they still add up to the period's
 * worked hours to the hundredth. Pure; the snapshot and the tests share it.
 */
export function billLines<T extends { label: string; hours: number; rate: number }>(rows: T[]): { lines: StatementLine[]; hoursCents: number[]; amountCents: number[]; source: T[] } {
  const sorted = [...rows].sort((a, b) => a.label.localeCompare(b.label) || a.rate - b.rate);
  const exactHundredths = sorted.map((r) => r.hours * 100);
  const hundredths = apportion(exactHundredths, exactHundredths.reduce((a, b) => a + b, 0));
  const lines: StatementLine[] = [];
  const hoursCents: number[] = [];
  const amountCents: number[] = [];
  const source: T[] = [];
  sorted.forEach((r, i) => {
    const h = hundredths[i]!;
    const rateCents = Math.round(r.rate * 100);
    const cents = Math.round((h * rateCents) / 100);
    // A sliver that apportions to 0.00 h bills nothing: no "0.00 h overtime" line.
    if (h === 0 && cents === 0) return;
    lines.push({ label: r.label, hours: h / 100, rate: rateCents / 100, amount: cents / 100 });
    hoursCents.push(h);
    amountCents.push(cents);
    source.push(r);
  });
  return { lines, hoursCents, amountCents, source };
}

export type StatementTotals = StatementSnapshot['totals'];

/**
 * The one place a statement's money is totalled (audit 2026-10-21 #17: the
 * invoice's sales tax was always $0.00 because nothing computed one). Given
 * the hours part, the adjustments part and the client's rate, it returns the
 * subtotal, the tax and the amount the client owes — every caller that
 * rebuilds a snapshot's totals (finalize claims adjustments, the adjustments-
 * only statement) goes through here, so the tax survives a recompute.
 */
export function totalsWithTax(parts: { hoursAmount: number; adjustmentsAmount: number; salesTaxRatePct: number | null | undefined }): Pick<StatementTotals, 'amount' | 'hoursAmount' | 'adjustmentsAmount' | 'subtotal' | 'salesTaxRatePct' | 'salesTax'> {
  const hoursAmount = round2(parts.hoursAmount);
  const adjustmentsAmount = round2(parts.adjustmentsAmount);
  const subtotal = round2(hoursAmount + adjustmentsAmount);
  const rate = parts.salesTaxRatePct && parts.salesTaxRatePct > 0 ? Number(parts.salesTaxRatePct) : 0;
  const salesTax = rate > 0 ? round2((subtotal * rate) / 100) : 0;
  return { hoursAmount, adjustmentsAmount, subtotal, salesTaxRatePct: rate, salesTax, amount: round2(subtotal + salesTax) };
}

/** The sales tax rate a client's statements carry: its rate when taxable, else nothing. */
export async function clientSalesTaxRate(db: Db, clientId: string): Promise<number | null> {
  const c = await db.client.findUnique({ where: { id: clientId }, select: { salesTaxable: true, salesTaxRatePct: true } });
  if (!c?.salesTaxable || c.salesTaxRatePct == null) return null;
  return Number(c.salesTaxRatePct);
}

export async function computeStatementSnapshot(
  db: Db,
  clientId: string,
  periodStart: Date,
  periodEndExclusive: Date,
): Promise<StatementSnapshot> {
  const [client, entries, rateDefaults, positions, locations, pay] = await Promise.all([
    db.client.findUniqueOrThrow({ where: { id: clientId }, select: { name: true, salesTaxable: true, salesTaxRatePct: true } }),
    db.timeEntry.findMany({
      where: {
        clientId,
        status: 'APPROVED',
        clockInAt: { gte: periodStart, lt: periodEndExclusive },
      },
      select: {
        id: true,
        associateId: true,
        locationId: true,
        clockInAt: true,
        clockOutAt: true,
        breaks: { select: { type: true, startedAt: true, endedAt: true } },
        shift: { select: { position: true, hourlyRate: true, startsAt: true } },
      },
      orderBy: { clockInAt: 'asc' },
      take: 50_000,
    }),
    // Brief 1A-2: the cards in force on the period's last day.
    currentRateCards(db, clientId, new Date(periodEndExclusive.getTime() - 1)),
    db.shiftPosition.findMany({
      where: { clientId, deletedAt: null },
      select: { name: true, isLead: true },
    }),
    db.site.findMany({
      where: { clientId },
      select: { id: true, name: true },
    }),
    // What pay splits hours by: live rules and punch rounding.
    loadPayContext(db),
  ]);

  // The contract in force at the period's end: overtime at the multiplier or straight time.
  const terms = await termsFor(db, clientId, new Date(periodEndExclusive.getTime() - 1));
  const straight = terms.overtimeBilling === 'STRAIGHT';

  const billDefault = new Map(
    rateDefaults
      .filter((r) => r.billRate != null)
      .map((r) => [r.position, Number(r.billRate)]),
  );
  const isLead = new Map(positions.map((p) => [p.name, p.isLead]));
  const locationName = new Map(locations.map((l) => [l.id, l.name]));

  // Everything the period's associates worked in the covering weeks, at any
  // client: the engine counts their week once, the way their paycheck does.
  // A day of slack before the earliest week covers a site west of the
  // company zone; earlier hours sit in their own (earlier) week.
  const associateIds = [...new Set(entries.map((e) => e.associateId))];
  const weekStarts = entries.map((e) => startOfWeekUTC(e.clockInAt).getTime());
  const minWeek = weekStarts.length ? new Date(Math.min(...weekStarts) - 86_400_000) : periodStart;
  const allEntries = associateIds.length
    ? await db.timeEntry.findMany({
        where: {
          associateId: { in: associateIds },
          status: 'APPROVED',
          clockInAt: { gte: minWeek, lt: periodEndExclusive },
        },
        select: {
          id: true,
          associateId: true,
          locationId: true,
          clockInAt: true,
          clockOutAt: true,
          breaks: { select: { type: true, startedAt: true, endedAt: true } },
          location: { select: { id: true, state: true, city: true, timezone: true } },
        },
        take: 100_000,
      })
    : [];
  const { byEntry, byPerson } = splitByPerson(
    pay.rules,
    allEntries.map((raw) => {
      const e = pay.forPay(raw);
      return { id: e.id, associateId: e.associateId, clockInAt: e.clockInAt, clockOutAt: e.clockOutAt, breaks: e.breaks, site: e.location };
    }),
  );
  const shareById = new Map([...byEntry].map(([e, h]) => [e.id!, h]));

  // Aggregate lines per (position band, bucket, billed rate): one rate per
  // line, so hours × rate = amount on every line of the invoice.
  const lineAgg = new Map<string, { label: string; rate: number; hours: number; bucket: 'regular' | 'ot' | 'dt' }>();
  const storeAgg = new Map<string, { hours: number; amount: number }>();

  for (const e of entries) {
    const share = shareById.get(e.id);
    if (!share || share.workedHours <= 0) continue;
    // Overtime bills at the multiplier the paycheck paid it at (1.5× unless a live rule set says more), or straight per contract.
    const otMult = straight ? 1 : (byPerson.get(e.associateId)?.overtimeMultiplier ?? 1.5);
    const otLabel = straight ? 'overtime (straight time per contract)' : `overtime (${otMult}×)`;
    const dtLabel = straight ? 'double time (straight time per contract)' : `double time (billed at ${otMult}×)`;

    const position = e.shift?.position ?? null;
    const lead = position ? (isLead.get(position) ?? false) : false;
    const rate =
      e.shift?.hourlyRate != null
        ? Number(e.shift.hourlyRate)
        : position && billDefault.has(position)
          ? billDefault.get(position)!
          : lead
            ? env.DEFAULT_LEAD_BILL_RATE
            : env.DEFAULT_ASSOCIATE_BILL_RATE;

    const band = lead ? 'Lead' : 'Associate';
    const posLabel = position ?? 'Unscheduled work';
    let entryAmount = 0;
    for (const [suffix, hours, mult, bucket] of [
      ['regular', share.regularHours, 1, 'regular'],
      [otLabel, share.overtimeHours, otMult, 'ot'],
      [dtLabel, share.doubleTimeHours, otMult, 'dt'],
    ] as const) {
      if (hours <= 0) continue;
      // The rate an invoice prints is a cents figure: 1.5 × $17.33 bills at $26.00.
      const billed = round2(rate * mult);
      const label = `${band} — ${posLabel} — ${suffix}`;
      const key = `${label}|${billed}`;
      const agg = lineAgg.get(key) ?? { label, rate: billed, hours: 0, bucket };
      agg.hours += hours;
      lineAgg.set(key, agg);
      entryAmount += hours * billed;
    }

    const store = e.locationId
      ? (locationName.get(e.locationId) ?? 'Unknown site')
      : 'No site recorded';
    const s = storeAgg.get(store) ?? { hours: 0, amount: 0 };
    s.hours += share.workedHours;
    s.amount += entryAmount;
    storeAgg.set(store, s);
  }

  // ----- Service levels ----------------------------------------------------
  const [periodShifts, linkedEntries, noShows, pendingEntries] = await Promise.all([
    db.shift.findMany({
      where: {
        clientId,
        startsAt: { gte: periodStart, lt: periodEndExclusive },
        status: { notIn: ['DRAFT', 'CANCELLED'] },
        publishedAt: { not: null },
      },
      select: { assignedAssociateId: true },
      take: 50_000,
    }),
    db.timeEntry.findMany({
      where: {
        clientId,
        status: 'APPROVED',
        clockInAt: { gte: periodStart, lt: periodEndExclusive },
        shiftId: { not: null },
      },
      select: { clockInAt: true, shift: { select: { startsAt: true } } },
      take: 50_000,
    }),
    db.shift.count({
      where: {
        clientId,
        startsAt: { gte: periodStart, lt: periodEndExclusive },
        noShowNotifiedAt: { not: null },
        // Flagged AND never punched. The stamp alone only means nobody had
        // clocked in 15 minutes after the start, which a late arrival
        // trips; billing a client for "no-shows" they actually got the
        // labour for is not a number we can stand behind.
        timeEntries: { none: {} },
      },
    }),
    db.timeEntry.count({
      where: {
        clientId,
        status: 'COMPLETED',
        clockInAt: { gte: periodStart, lt: periodEndExclusive },
      },
    }),
  ]);
  const published = periodShifts.length;
  const assigned = periodShifts.filter((s) => s.assignedAssociateId !== null).length;
  const PUNCTUAL_GRACE_MS = 7 * 60_000;
  const punctual = linkedEntries.filter(
    (e) =>
      e.shift && e.clockInAt.getTime() <= e.shift.startsAt.getTime() + PUNCTUAL_GRACE_MS,
  ).length;

  const adjustments = await readyAdjustments(db, clientId);
  const adjustmentsAmount = round2(adjustments.reduce((t, a) => t + a.amount, 0));

  // The invoice's lines, rounded so they verify and add up (CODE-13); the
  // hours totals are the lines' own sums, so the summary agrees with them.
  const billed = billLines([...lineAgg.values()]);
  const hoursIn = (bucket: 'regular' | 'ot' | 'dt') =>
    billed.source.reduce((n, a, i) => n + (a.bucket === bucket ? billed.hoursCents[i]! : 0), 0);
  const hoursCentsTotal = billed.hoursCents.reduce((a, b) => a + b, 0);
  const amountCentsTotal = billed.amountCents.reduce((a, b) => a + b, 0);
  const regularC = hoursIn('regular');
  const otC = hoursIn('ot');
  const dtC = hoursIn('dt');

  // The work-site split, apportioned to the same totals so it adds up too.
  const storeRows = [...storeAgg.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const storeHours = apportion(storeRows.map(([, v]) => v.hours * 100), hoursCentsTotal);
  const storeAmounts = apportion(storeRows.map(([, v]) => v.amount * 100), amountCentsTotal);

  return {
    clientName: client.name,
    periodStart: ymd(periodStart),
    periodEnd: ymd(new Date(periodEndExclusive.getTime() - 24 * 3_600_000)),
    generatedAt: new Date().toISOString(),
    lines: billed.lines,
    stores: storeRows.map(([name], i) => ({
      locationName: name,
      hours: storeHours[i]! / 100,
      amount: storeAmounts[i]! / 100,
    })),
    ...(adjustments.length ? { adjustments } : {}),
    overtimeBilling: terms.overtimeBilling,
    totals: {
      hours: hoursCentsTotal / 100,
      regularHours: regularC / 100,
      otHours: otC / 100,
      ...(dtC > 0 ? { doubleTimeHours: dtC / 100 } : {}),
      ...totalsWithTax({ hoursAmount: amountCentsTotal / 100, adjustmentsAmount, salesTaxRatePct: client.salesTaxable && client.salesTaxRatePct != null ? Number(client.salesTaxRatePct) : null }),
    },
    sla: {
      publishedShifts: published,
      assignedShifts: assigned,
      fillRatePct: published > 0 ? round2((assigned / published) * 100) : null,
      punctualPct:
        linkedEntries.length > 0
          ? round2((punctual / linkedEntries.length) * 100)
          : null,
      noShows,
      pendingEntries,
    },
  };
}
