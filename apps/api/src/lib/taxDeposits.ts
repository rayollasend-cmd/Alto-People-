import type { Prisma, PrismaClient } from '@prisma/client';
import { round2 } from './payroll.js';

/**
 * Tier-1 — federal tax deposit accrual (Pub 15 §11).
 *
 * When a run disburses, the withheld FIT plus BOTH halves of FICA and
 * Medicare become trust-fund money the employer owes the IRS on a
 * deadline. This module turns each disbursement into a ledger row with the
 * correct due date so finance can pay through EFTPS before penalties
 * accrue, instead of discovering the obligation at quarter-end.
 *
 * Deposit-schedule math implemented:
 *   MONTHLY    — liability from any payday in month M is due the 15th of
 *                M+1 (next business day if the 15th is a weekend).
 *   SEMIWEEKLY — Wed/Thu/Fri paydays due the following Wednesday;
 *                Sat–Tue paydays due the following Friday.
 * The $100k next-day rule is flagged in the breakdown (nextDayRule: true)
 * and the due date collapses to the next business day.
 *
 * FUTA accrues per calendar quarter and is due the last day of the month
 * after the quarter once the accumulated liability exceeds $500 (below
 * that it rolls into the next quarter — we keep one PENDING row per year
 * rolling forward, matching how Form 940 settles the remainder).
 *
 * NOT done here: the actual EFTPS payment. Finance pays out-of-band (the
 * worksheet PDF has every figure) and marks the row paid with the EFTPS
 * acknowledgment number.
 */

const NEXT_DAY_THRESHOLD = 100_000;
const FUTA_DEPOSIT_FLOOR = 500;

function addDays(d: Date, days: number): Date {
  const c = new Date(d);
  c.setUTCDate(c.getUTCDate() + days);
  return c;
}

function nextBusinessDay(d: Date): Date {
  const c = new Date(d);
  while (c.getUTCDay() === 0 || c.getUTCDay() === 6) c.setUTCDate(c.getUTCDate() + 1);
  return c;
}

/** Due date for a FED_941 liability arising on `payday`. */
export function depositDueDate(
  payday: Date,
  schedule: string,
  amount: number,
): { dueDate: Date; nextDayRule: boolean } {
  if (amount >= NEXT_DAY_THRESHOLD) {
    return { dueDate: nextBusinessDay(addDays(payday, 1)), nextDayRule: true };
  }
  if (schedule === 'SEMIWEEKLY') {
    const dow = payday.getUTCDay(); // 0=Sun..6=Sat
    // Wed(3)/Thu(4)/Fri(5) → following Wednesday; Sat(6)/Sun(0)/Mon(1)/Tue(2) → following Friday.
    if (dow >= 3 && dow <= 5) {
      const daysToWed = ((3 - dow + 7) % 7) || 7;
      return { dueDate: addDays(payday, daysToWed), nextDayRule: false };
    }
    const daysToFri = ((5 - dow + 7) % 7) || 7;
    return { dueDate: addDays(payday, daysToFri), nextDayRule: false };
  }
  // MONTHLY — 15th of the following month, rolled off weekends.
  const due = new Date(Date.UTC(payday.getUTCFullYear(), payday.getUTCMonth() + 1, 15));
  return { dueDate: nextBusinessDay(due), nextDayRule: false };
}

function quarterLabel(d: Date): string {
  return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
}

/** Last day of the month following the quarter containing `d`. */
function futaDueDate(d: Date): Date {
  const q = Math.floor(d.getUTCMonth() / 3);
  // Month after quarter end: Apr(3), Jul(6), Oct(9), Jan(0 next year).
  return nextBusinessDay(new Date(Date.UTC(d.getUTCFullYear(), q * 3 + 4, 0)));
}

/**
 * Accrue deposit obligations for a disbursed run. Idempotent: the FED_941
 * row is unique on payrollRunId; FUTA re-runs recompute the open quarter
 * row in place. Failures are the caller's to swallow — accrual is
 * advisory bookkeeping and must never fail a disbursement.
 */
export async function accrueDepositsForRun(
  prisma: PrismaClient,
  runId: string,
): Promise<void> {
  const run = await prisma.payrollRun.findUnique({
    where: { id: runId },
    include: { items: { where: { status: 'DISBURSED' } } },
  });
  if (!run || run.items.length === 0) return;
  const items = run.items;
  const payday = run.disbursedAt ?? new Date();

  const profile = await prisma.submitterProfile.findUnique({
    where: { id: 'singleton' },
    select: { depositSchedule: true },
  });
  const schedule = profile?.depositSchedule ?? 'MONTHLY';

  const sum = (pick: (i: (typeof items)[number]) => Prisma.Decimal) =>
    round2(items.reduce((acc, i) => acc + Number(pick(i)), 0));
  const fit = sum((i) => i.federalWithholding);
  const ssEmployee = sum((i) => i.fica);
  const medEmployee = sum((i) => i.medicare);
  const ssEmployer = sum((i) => i.employerFica);
  const medEmployer = sum((i) => i.employerMedicare);
  const total941 = round2(fit + ssEmployee + medEmployee + ssEmployer + medEmployer);

  if (total941 > 0) {
    const { dueDate, nextDayRule } = depositDueDate(payday, schedule, total941);
    await prisma.taxDeposit.upsert({
      where: { payrollRunId: run.id },
      create: {
        kind: 'FED_941',
        scheduleUsed: schedule,
        periodLabel: `${payday.toISOString().slice(0, 10)} payday`,
        payrollRunId: run.id,
        liabilityDate: payday,
        dueDate,
        amount: total941,
        breakdown: { fit, ssEmployee, ssEmployer, medEmployee, medEmployer, nextDayRule },
      },
      // Re-disbursement (retry-failures completing the run) refreshes the
      // figures; a PAID row is left alone.
      update: {
        amount: total941,
        dueDate,
        breakdown: { fit, ssEmployee, ssEmployer, medEmployee, medEmployer, nextDayRule },
      },
    });
  }

  // FUTA — accumulate into the quarter's PENDING row.
  const futa = sum((i) => i.employerFuta);
  if (futa > 0) {
    const label = quarterLabel(payday);
    const existing = await prisma.taxDeposit.findFirst({
      where: { kind: 'FUTA', periodLabel: label, status: 'PENDING' },
    });
    // Recompute the quarter total from every disbursed run in the quarter
    // (idempotent against re-accrual of the same run).
    const qStartMonth = Math.floor(payday.getUTCMonth() / 3) * 3;
    const qStart = new Date(Date.UTC(payday.getUTCFullYear(), qStartMonth, 1));
    const qEnd = new Date(Date.UTC(payday.getUTCFullYear(), qStartMonth + 3, 1));
    const quarterItems = await prisma.payrollItem.aggregate({
      _sum: { employerFuta: true },
      where: {
        status: 'DISBURSED',
        payrollRun: { disbursedAt: { gte: qStart, lt: qEnd } },
      },
    });
    const quarterFuta = round2(Number(quarterItems._sum.employerFuta ?? 0));
    const data = {
      scheduleUsed: 'QUARTERLY',
      liabilityDate: payday,
      dueDate: futaDueDate(payday),
      amount: quarterFuta,
      breakdown: {
        futa: quarterFuta,
        belowDepositFloor: quarterFuta < FUTA_DEPOSIT_FLOOR,
      },
    };
    if (existing) {
      await prisma.taxDeposit.update({ where: { id: existing.id }, data });
    } else {
      await prisma.taxDeposit.create({
        data: { kind: 'FUTA', periodLabel: label, ...data },
      });
    }
  }
}
