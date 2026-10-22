import type { Prisma, PrismaClient } from '@prisma/client';
import { round2, sumApprovedHours } from './payroll.js';
import { findInChunks } from './chunkedIn.js';
import { payFor } from './laborRules/hours.js';

/**
 * Retroactive pay.
 *
 * A compensation record dated into a period that was already paid means
 * every hour paid at the old rate since the effective date was underpaid.
 * Workday, ADP and Dayforce settle that on the next regular run as a
 * "retro" line; here it is the same: this module finds the pairs (new
 * hourly comp record × item paid at the old rate), works out the hours and
 * the delta, and the aggregator adds one RETRO earning per person. The
 * persisted RetroPayAdjustment row keeps the arithmetic and the fact that
 * the pair was settled, so it is never paid twice.
 *
 * Only increases are settled automatically. A rate dated backwards that is
 * LOWER than what was paid is an overpayment — that is a conversation and
 * an amendment, never a silent deduction.
 */

type Tx = Prisma.TransactionClient | PrismaClient;

export interface RetroCandidate {
  associateId: string;
  compensationRecordId: string;
  sourcePayrollItemId: string;
  /** The paid period the delta is owed for. */
  sourcePeriodStart: string;
  sourcePeriodEnd: string;
  effectiveFrom: string;
  regularHours: number;
  overtimeHours: number;
  oldRate: number;
  newRate: number;
  amount: number;
  /** Set when a RetroPayAdjustment row already exists for this pair. */
  persistedId: string | null;
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const DAY_MS = 86_400_000;

/**
 * Pending retro pay per associate, as of the end of the period being run.
 * Pairs already settled by another run are excluded; pairs stamped by
 * `runId` (a draft being re-aggregated) are kept so the line is stable.
 */
export async function computeRetroPay(
  tx: Tx,
  input: { associateIds: string[]; asOf: Date; runId?: string },
): Promise<Map<string, RetroCandidate[]>> {
  const out = new Map<string, RetroCandidate[]>();
  const ids = [...new Set(input.associateIds)];
  if (ids.length === 0) return out;

  const comps = await findInChunks(ids, (chunk) =>
    tx.compensationRecord.findMany({
      where: { associateId: { in: chunk }, payType: 'HOURLY', effectiveFrom: { lt: input.asOf } },
      orderBy: [{ associateId: 'asc' }, { effectiveFrom: 'asc' }],
      select: { id: true, associateId: true, amount: true, effectiveFrom: true, effectiveTo: true, createdAt: true },
    }),
  );
  if (comps.length === 0) return out;

  // A record created after it took effect is the only kind that can owe
  // anything: the runs in between were paid before anyone knew.
  const backdated = comps.filter((c) => c.createdAt.getTime() - c.effectiveFrom.getTime() > DAY_MS);
  if (backdated.length === 0) return out;
  const backdatedAssociates = [...new Set(backdated.map((c) => c.associateId))];

  const items = await findInChunks(backdatedAssociates, (chunk) => tx.payrollItem.findMany({
    where: {
      associateId: { in: chunk },
      status: { in: ['DISBURSED', 'PENDING'] },
      hourlyRate: { gt: 0 },
      payrollRun: { kind: 'REGULAR', status: { in: ['FINALIZED', 'DISBURSED'] } },
    },
    select: {
      id: true,
      associateId: true,
      hourlyRate: true,
      hoursWorked: true,
      payrollRun: { select: { id: true, periodStart: true, periodEnd: true, finalizedAt: true } },
      earnings: { select: { kind: true, hours: true, rate: true, notes: true } },
    },
  }));
  if (items.length === 0) return out;

  const existing = await findInChunks(backdatedAssociates, (chunk) =>
    tx.retroPayAdjustment.findMany({
      where: { associateId: { in: chunk } },
      select: { id: true, compensationRecordId: true, sourcePayrollItemId: true, status: true, paidRunId: true },
    }),
  );
  const existingByPair = new Map(existing.map((e) => [`${e.compensationRecordId}:${e.sourcePayrollItemId}`, e]));

  const compsByAssociate = new Map<string, typeof comps>();
  for (const c of comps) {
    const arr = compsByAssociate.get(c.associateId) ?? [];
    arr.push(c);
    compsByAssociate.set(c.associateId, arr);
  }

  for (const item of items) {
    const run = item.payrollRun;
    const periodEndExclusive = new Date(run.periodEnd.getTime() + DAY_MS);
    const mine = compsByAssociate.get(item.associateId) ?? [];
    for (let i = 0; i < mine.length; i++) {
      const comp = mine[i];
      if (comp.createdAt.getTime() - comp.effectiveFrom.getTime() <= DAY_MS) continue;
      // The run must have been finalized before the change was recorded,
      // and the change must reach into the run's period.
      if (!run.finalizedAt || run.finalizedAt >= comp.createdAt) continue;
      if (comp.effectiveFrom >= periodEndExclusive) continue;
      // The window the record governs inside this period: from its
      // effective date to the next record's (if one starts inside).
      const next = mine[i + 1] ?? null;
      const windowEnd = next && next.effectiveFrom < periodEndExclusive ? next.effectiveFrom : periodEndExclusive;
      const windowStart = comp.effectiveFrom > run.periodStart ? comp.effectiveFrom : run.periodStart;
      if (windowEnd <= windowStart) continue;

      const oldRate = Number(item.hourlyRate);
      const newRate = Number(comp.amount);
      if (newRate <= oldRate) continue;

      const key = `${comp.id}:${item.id}`;
      const prior = existingByPair.get(key);
      if (prior && prior.status === 'PAID' && prior.paidRunId !== input.runId) continue;

      // The hours as the run paid them (the labor-rules engine's split): the
      // raise reaches each at the multiplier it was paid at — overtime 1.5×
      // (or a live rule's), and double time (the engine's "Double time"
      // line, kept with the overtime hours on the record) at 2×.
      let regular = 0;
      let overtime = 0;
      let doubleTime = 0;
      let otMult = 1.5;
      let dtMult = 2;
      for (const e of item.earnings) {
        if (e.hours === null) continue;
        const paidMult = e.rate !== null && oldRate > 0 ? Number(e.rate) / oldRate : null;
        if (e.kind === 'REGULAR') regular += Number(e.hours);
        else if (e.kind === 'OVERTIME') {
          overtime += Number(e.hours);
          if (paidMult && paidMult > 1) otMult = Math.round(paidMult * 100) / 100;
        } else if (e.kind === 'DOUBLE_TIME' && e.notes === 'Double time') {
          doubleTime += Number(e.hours);
          if (paidMult && paidMult > 1) dtMult = Math.round(paidMult * 100) / 100;
        }
      }
      if (regular + overtime + doubleTime === 0) regular = Number(item.hoursWorked);
      const paidHours = regular + overtime + doubleTime;
      if (paidHours <= 0) continue;

      // Whole period at the new rate, or only the hours on and after the
      // effective date (the paid split is applied pro rata).
      if (windowStart > run.periodStart || windowEnd < periodEndExclusive) {
        const entries = await tx.timeEntry.findMany({
          where: {
            associateId: item.associateId,
            status: 'APPROVED',
            clockInAt: { gte: windowStart, lt: windowEnd },
          },
          select: { status: true, clockInAt: true, clockOutAt: true, breaks: { select: { startedAt: true, endedAt: true } } },
        });
        const inWindow = Math.min(paidHours, sumApprovedHours(entries));
        const share = inWindow / paidHours;
        regular = round2(regular * share);
        overtime = round2(overtime * share);
        doubleTime = round2(doubleTime * share);
      }
      const delta = newRate - oldRate;
      const amount = round2(payFor({ regularHours: regular, overtimeHours: overtime, doubleTimeHours: doubleTime }, delta, { overtimeMultiplier: otMult, doubleMultiplier: dtMult }));
      if (amount < 0.01) continue;

      const list = out.get(item.associateId) ?? [];
      list.push({
        associateId: item.associateId,
        compensationRecordId: comp.id,
        sourcePayrollItemId: item.id,
        sourcePeriodStart: ymd(run.periodStart),
        sourcePeriodEnd: ymd(run.periodEnd),
        effectiveFrom: ymd(comp.effectiveFrom),
        regularHours: regular,
        overtimeHours: round2(overtime + doubleTime),
        oldRate,
        newRate,
        amount,
        persistedId: prior?.id ?? null,
      });
      out.set(item.associateId, list);
    }
  }
  return out;
}

/** The one paystub line for a person's retro: amount and a label that says why. */
export function summarizeRetro(cands: RetroCandidate[]): { amount: number; note: string } {
  const amount = round2(cands.reduce((s, c) => s + c.amount, 0));
  const from = cands.map((c) => c.effectiveFrom).sort()[0];
  const periods = new Set(cands.map((c) => c.sourcePeriodStart)).size;
  const note = `Retroactive pay — rate change effective ${from}, ${periods} prior ${periods === 1 ? 'period' : 'periods'}`;
  return { amount, note };
}

/**
 * Stamp the pairs a draft run settles. Called inside the run's
 * aggregate-and-persist transaction after the item exists; the release
 * (`releaseRetroForRun`) runs first so a re-aggregation starts clean.
 */
export async function persistRetroForItem(
  tx: Tx,
  cands: RetroCandidate[],
  stamp: { runId: string; itemId: string; now?: Date },
): Promise<void> {
  const now = stamp.now ?? new Date();
  for (const c of cands) {
    await tx.retroPayAdjustment.upsert({
      where: { compensationRecordId_sourcePayrollItemId: { compensationRecordId: c.compensationRecordId, sourcePayrollItemId: c.sourcePayrollItemId } },
      create: {
        associateId: c.associateId,
        compensationRecordId: c.compensationRecordId,
        sourcePayrollItemId: c.sourcePayrollItemId,
        regularHours: c.regularHours,
        overtimeHours: c.overtimeHours,
        oldRate: c.oldRate,
        newRate: c.newRate,
        amount: c.amount,
        status: 'PAID',
        paidRunId: stamp.runId,
        paidItemId: stamp.itemId,
        paidAt: now,
      },
      update: {
        regularHours: c.regularHours,
        overtimeHours: c.overtimeHours,
        oldRate: c.oldRate,
        newRate: c.newRate,
        amount: c.amount,
        status: 'PAID',
        paidRunId: stamp.runId,
        paidItemId: stamp.itemId,
        paidAt: now,
      },
    });
  }
}

/** Un-stamp everything a run settled — before re-aggregating or deleting it. */
export async function releaseRetroForRun(tx: Tx, runId: string): Promise<void> {
  await tx.retroPayAdjustment.updateMany({
    where: { paidRunId: runId },
    data: { status: 'PENDING', paidRunId: null, paidItemId: null, paidAt: null },
  });
}
