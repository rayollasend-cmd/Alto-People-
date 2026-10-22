import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * ONE SOURCE FOR A RUN'S MONEY, AND A CHECK THAT IT HOLDS (F500 SH-4).
 *
 *   A run's totals are the ones it STORED when its numbers were locked
 *   (PayrollRun.totalGross / totalNet — what the runs grid, the close page,
 *   the drawer and the books read). Its paychecks are its non-voided
 *   PayrollItems. The two must agree to the cent: the stored totals are
 *   written as the sum of the items (aggregateAndPersistRun, manual checks,
 *   amendments), and a void cancels the whole run.
 *
 *   Every surface shows the stored totals, and every surface that shows a
 *   run's money also carries this check: when `totalsAgree` is false the
 *   page says so (the web's <RunTotalsMismatch>) instead of quietly showing
 *   one number on one card and another on the next — the payroll home once
 *   read "Net paid $0.00 · 0 paystubs" beside a grid row of $3,490.20 for
 *   the same run, and the drawer explained the gap with a false "No
 *   approved time entries fell inside this period".
 *
 *   A cancelled run is exempt (its paychecks were voided on purpose).
 */

type Db = PrismaClient | Prisma.TransactionClient;

export interface RunTotalsCheck {
  /** The run's stored totals (what every page shows). */
  totalGross: number;
  totalNet: number;
  /** The same sums over its non-voided paychecks. */
  itemsGross: number;
  itemsNet: number;
  /** Non-voided paychecks. */
  paychecks: number;
  /** Stored and paycheck totals agree to the cent (always true for a cancelled run). */
  totalsAgree: boolean;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => Number(v ?? 0);

/** The check from a run and its paychecks already in hand. */
export function runTotalsCheck(
  run: { status: string; totalGross: unknown; totalNet: unknown },
  items: ReadonlyArray<{ status: string; grossPay: unknown; netPay: unknown }>,
): RunTotalsCheck {
  const live = items.filter((i) => i.status !== 'VOIDED');
  const itemsGross = round2(live.reduce((s, i) => s + num(i.grossPay), 0));
  const itemsNet = round2(live.reduce((s, i) => s + num(i.netPay), 0));
  const totalGross = round2(num(run.totalGross));
  const totalNet = round2(num(run.totalNet));
  const agree = Math.abs(totalGross - itemsGross) < 0.005 && Math.abs(totalNet - itemsNet) < 0.005;
  return { totalGross, totalNet, itemsGross, itemsNet, paychecks: live.length, totalsAgree: run.status === 'CANCELLED' || agree };
}

/** The check for runs read by id (one grouped query for their paychecks). */
export async function runTotalsChecks(db: Db, runs: ReadonlyArray<{ id: string; status: string; totalGross: unknown; totalNet: unknown }>): Promise<Map<string, RunTotalsCheck>> {
  const out = new Map<string, RunTotalsCheck>();
  if (runs.length === 0) return out;
  const sums = await db.payrollItem.groupBy({
    by: ['payrollRunId'],
    where: { payrollRunId: { in: runs.map((r) => r.id) }, status: { not: 'VOIDED' } },
    _sum: { grossPay: true, netPay: true },
    _count: { _all: true },
  });
  const byRun = new Map(sums.map((s) => [s.payrollRunId, s]));
  for (const r of runs) {
    const s = byRun.get(r.id);
    const itemsGross = round2(num(s?._sum.grossPay));
    const itemsNet = round2(num(s?._sum.netPay));
    const totalGross = round2(num(r.totalGross));
    const totalNet = round2(num(r.totalNet));
    const agree = Math.abs(totalGross - itemsGross) < 0.005 && Math.abs(totalNet - itemsNet) < 0.005;
    out.set(r.id, { totalGross, totalNet, itemsGross, itemsNet, paychecks: s?._count._all ?? 0, totalsAgree: r.status === 'CANCELLED' || agree });
  }
  return out;
}
