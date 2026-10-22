import type { PrismaClient } from '@prisma/client';
import { accrueDepositsForRun } from './taxDeposits.js';
import { postLiabilitiesForRun } from './payrollTaxLedger.js';
import { accrueRemittancesForRun } from './garnishmentRemittance.js';

/**
 * What a payroll run owes the moment it is paid, whichever path paid it.
 *
 * A run settles on four paths: the disburse route when every paycheck
 * succeeds at once, the retry route when the last held paycheck clears, the
 * daily-pay settlement, and "Mark uploaded" on the company's own ACH file.
 * Each used to decide for itself whether to accrue the obligations; the
 * own-account path never did, so a run paid by file owed taxes the system
 * did not know about (system audit 2026-10-21, Tier 1 #2).
 *
 * This is the one place those obligations are created:
 *   - the federal/state tax deposit on its IRS deadline (lib/taxDeposits),
 *   - the per-jurisdiction tax liabilities (lib/payrollTaxLedger),
 *   - the garnishment remittances to each payee (lib/garnishmentRemittance).
 *
 * Every step is idempotent on its own rows, so calling this twice for the
 * same run changes nothing. Failures are advisory: bookkeeping never fails
 * a disbursement, but each is logged with the run so it can be redone from
 * the tax desk (POST /payroll/runs/:id/tax-deposit).
 */
export interface RunSettledResult {
  runId: string;
  deposits: 'ok' | 'failed';
  liabilities: 'ok' | 'failed';
  remittances: 'ok' | 'failed';
}

export async function afterRunSettled(db: PrismaClient, runId: string): Promise<RunSettledResult> {
  const out: RunSettledResult = { runId, deposits: 'ok', liabilities: 'ok', remittances: 'ok' };
  try {
    await accrueDepositsForRun(db, runId);
  } catch (err) {
    out.deposits = 'failed';
    console.warn(`[payroll] tax-deposit accrual failed for run ${runId} (advisory):`, err);
  }
  try {
    await postLiabilitiesForRun(db, runId);
  } catch (err) {
    out.liabilities = 'failed';
    console.warn(`[payroll] tax-liability posting failed for run ${runId} (advisory):`, err);
  }
  try {
    await accrueRemittancesForRun(db, runId);
  } catch (err) {
    out.remittances = 'failed';
    console.warn(`[payroll] garnishment-remittance accrual failed for run ${runId} (advisory):`, err);
  }
  return out;
}

/** Fire-and-forget form for request handlers: the response never waits on bookkeeping. */
export function settleRunObligations(db: PrismaClient, runId: string): void {
  void afterRunSettled(db, runId).catch((err) => console.warn(`[payroll] settle obligations failed for run ${runId}:`, err));
}
