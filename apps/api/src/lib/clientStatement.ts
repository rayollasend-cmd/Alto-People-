import type { Prisma, PrismaClient } from '@prisma/client';
import { currentRateCards } from './rateCards.js';
import { env } from '../config/env.js';
import { startOfWeekUTC } from './timeAnomalies.js';
import { readyAdjustments, termsFor, type SnapshotAdjustment } from './payBillLink.js';

type Db = Prisma.TransactionClient | PrismaClient;

/**
 * Client billing/SLA statement computation.
 *
 * Approved time in the period, priced with the same resolution chain the
 * labor-cost report uses (shift's own bill rate → per-(client, position)
 * default → org SOW standards), with the weekly CROSS-CLIENT 40h overtime
 * rule: hours an associate worked anywhere count toward the threshold, and
 * the over-threshold tail billed to this client goes at 1.5×.
 *
 * The result is a plain-JSON snapshot: DRAFT statements recompute it on
 * demand; FINAL statements freeze it forever.
 */

export interface StatementLine {
  label: string;
  hours: number;
  /** Blended rate (amount ÷ hours) — uniform in practice, honest when not. */
  rate: number;
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
const ymd = (d: Date) => d.toISOString().slice(0, 10);

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

function netMinutes(e: {
  clockInAt: Date;
  clockOutAt: Date | null;
  breaks: Array<{ startedAt: Date; endedAt: Date | null }>;
}): number {
  if (!e.clockOutAt) return 0;
  let ms = e.clockOutAt.getTime() - e.clockInAt.getTime();
  for (const b of e.breaks) {
    const bEnd = (b.endedAt ?? e.clockOutAt).getTime();
    ms -= Math.max(0, bEnd - b.startedAt.getTime());
  }
  return Math.max(0, ms / 60_000);
}

export async function computeStatementSnapshot(
  db: Db,
  clientId: string,
  periodStart: Date,
  periodEndExclusive: Date,
): Promise<StatementSnapshot> {
  const [client, entries, rateDefaults, positions, locations] = await Promise.all([
    db.client.findUniqueOrThrow({ where: { id: clientId }, select: { name: true, salesTaxable: true, salesTaxRatePct: true } }),
    db.timeEntry.findMany({
      where: {
        clientId,
        status: 'APPROVED',
        clockInAt: { gte: periodStart, lt: periodEndExclusive },
      },
      select: {
        associateId: true,
        locationId: true,
        clockInAt: true,
        clockOutAt: true,
        breaks: { select: { startedAt: true, endedAt: true } },
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
  ]);

  // The contract in force at the period's end: overtime at the multiplier or straight time.
  const terms = await termsFor(db, clientId, new Date(periodEndExclusive.getTime() - 1));
  const otMult = terms.overtimeBilling === 'STRAIGHT' ? 1 : 1.5;
  const otLabel = otMult === 1 ? 'overtime (straight time per contract)' : 'overtime (1.5×)';

  const billDefault = new Map(
    rateDefaults
      .filter((r) => r.billRate != null)
      .map((r) => [r.position, Number(r.billRate)]),
  );
  const isLead = new Map(positions.map((p) => [p.name, p.isLead]));
  const locationName = new Map(locations.map((l) => [l.id, l.name]));

  // Cross-client weekly totals: every approved minute the period's
  // associates worked ANYWHERE in the covering weeks feeds the threshold.
  const associateIds = [...new Set(entries.map((e) => e.associateId))];
  const weekStarts = new Set(entries.map((e) => startOfWeekUTC(e.clockInAt).getTime()));
  const minWeek = weekStarts.size ? new Date(Math.min(...weekStarts)) : periodStart;
  const allEntries = associateIds.length
    ? await db.timeEntry.findMany({
        where: {
          associateId: { in: associateIds },
          status: 'APPROVED',
          clockInAt: { gte: minWeek, lt: periodEndExclusive },
        },
        select: {
          associateId: true,
          clockInAt: true,
          clockOutAt: true,
          breaks: { select: { startedAt: true, endedAt: true } },
        },
        take: 100_000,
      })
    : [];
  const weekTotals = new Map<string, number>(); // `${associateId}:${weekStart}` → min
  for (const e of allEntries) {
    const k = `${e.associateId}:${startOfWeekUTC(e.clockInAt).getTime()}`;
    weekTotals.set(k, (weekTotals.get(k) ?? 0) + netMinutes(e));
  }

  const OT_MIN = 40 * 60;
  // Per (associate, week): this client's minutes, and the over-40h tail
  // attributable to this client (bounded by this client's own minutes).
  const clientWeekMin = new Map<string, number>();
  for (const e of entries) {
    const k = `${e.associateId}:${startOfWeekUTC(e.clockInAt).getTime()}`;
    clientWeekMin.set(k, (clientWeekMin.get(k) ?? 0) + netMinutes(e));
  }
  const otShare = new Map<string, number>();
  for (const [k, cMin] of clientWeekMin) {
    const total = weekTotals.get(k) ?? cMin;
    otShare.set(k, Math.max(0, Math.min(cMin, total - OT_MIN)));
  }

  // Walk each (associate, week)'s entries chronologically; the OT tail is
  // the LAST minutes worked, so later entries absorb the 1.5× first from
  // the end. Aggregate lines per (position band, reg/OT).
  const lineAgg = new Map<string, { hours: number; amount: number }>();
  const storeAgg = new Map<string, { hours: number; amount: number }>();
  let regularMin = 0;
  let otMin = 0;
  let totalAmount = 0;

  // Group entries by (associate, week), keep chronological order.
  const byWeek = new Map<string, typeof entries>();
  for (const e of entries) {
    const k = `${e.associateId}:${startOfWeekUTC(e.clockInAt).getTime()}`;
    const arr = byWeek.get(k) ?? [];
    arr.push(e);
    byWeek.set(k, arr);
  }
  for (const [k, weekEntries] of byWeek) {
    let otLeft = otShare.get(k) ?? 0;
    // Absorb OT from the end of the week backwards.
    for (let i = weekEntries.length - 1; i >= 0; i--) {
      const e = weekEntries[i];
      const min = netMinutes(e);
      if (min <= 0) continue;
      const entryOt = Math.min(min, otLeft);
      otLeft -= entryOt;
      const entryReg = min - entryOt;

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
      for (const [suffix, minutes, mult] of [
        ['regular', entryReg, 1],
        [otLabel, entryOt, otMult],
      ] as const) {
        if (minutes <= 0) continue;
        const hours = minutes / 60;
        const amount = hours * rate * mult;
        const key = `${band} — ${posLabel} — ${suffix}`;
        const agg = lineAgg.get(key) ?? { hours: 0, amount: 0 };
        agg.hours += hours;
        agg.amount += amount;
        lineAgg.set(key, agg);
        totalAmount += amount;
      }
      regularMin += entryReg;
      otMin += entryOt;

      const store = e.locationId
        ? (locationName.get(e.locationId) ?? 'Unknown site')
        : 'No site recorded';
      const s = storeAgg.get(store) ?? { hours: 0, amount: 0 };
      s.hours += min / 60;
      const entryRate = rate;
      s.amount += (entryReg / 60) * entryRate + (entryOt / 60) * entryRate * otMult;
      storeAgg.set(store, s);
    }
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

  return {
    clientName: client.name,
    periodStart: ymd(periodStart),
    periodEnd: ymd(new Date(periodEndExclusive.getTime() - 24 * 3_600_000)),
    generatedAt: new Date().toISOString(),
    lines: [...lineAgg.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([label, v]) => ({
        label,
        hours: round2(v.hours),
        rate: v.hours > 0 ? round2(v.amount / v.hours) : 0,
        amount: round2(v.amount),
      })),
    stores: [...storeAgg.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, v]) => ({
        locationName: name,
        hours: round2(v.hours),
        amount: round2(v.amount),
      })),
    ...(adjustments.length ? { adjustments } : {}),
    overtimeBilling: terms.overtimeBilling,
    totals: {
      hours: round2((regularMin + otMin) / 60),
      regularHours: round2(regularMin / 60),
      otHours: round2(otMin / 60),
      ...totalsWithTax({ hoursAmount: totalAmount, adjustmentsAmount, salesTaxRatePct: client.salesTaxable && client.salesTaxRatePct != null ? Number(client.salesTaxRatePct) : null }),
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
