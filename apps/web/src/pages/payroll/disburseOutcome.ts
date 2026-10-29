import type { PayrollRunDetail, PayrollRunSummary } from '@alto-people/shared';

/**
 * What a disburse actually did, said the way it happened (deep audit CODE-3 /
 * CODE-21). On the company's own ACH with an in-house file, Disburse WRITES the
 * bank file and pays no one until Finance uploads it and marks it uploaded —
 * the toast used to say "Run disbursed." while nothing had moved, and the
 * button stayed, so a second press wrote a second file with the same people.
 */
export type DisburseOutcome = { tone: 'success' | 'info' | 'error'; message: string; waitingOnBank: boolean };

type RunAfter = Pick<PayrollRunDetail, 'status' | 'items'> & Partial<Pick<PayrollRunSummary, 'nextStep'>>;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The run is waiting on the bank file: written, not yet uploaded and marked uploaded. */
export const waitsOnBankUpload = (run: Partial<Pick<PayrollRunSummary, 'nextStep' | 'status'>> | null | undefined): boolean =>
  !!run && run.status === 'FINALIZED' && run.nextStep?.key === 'uploadFile';

export function disburseOutcome(run: RunAfter): DisburseOutcome {
  if (run.status === 'DISBURSED') return { tone: 'success', message: 'Run disbursed.', waitingOnBank: false };
  const held = run.items.filter((i) => i.status === 'HELD').length;
  const pending = run.items.filter((i) => i.status === 'PENDING').length;
  if (waitsOnBankUpload(run)) {
    return {
      tone: 'info',
      message: `The bank file is ready for ${plural(pending, 'paycheck')}. Nobody is paid until you upload it at the bank and mark it uploaded on Payroll banking.${held ? ` ${plural(held, 'paycheck')} held.` : ''}`,
      waitingOnBank: true,
    };
  }
  if (held === 0 && pending === 0) return { tone: 'success', message: 'Run disbursed.', waitingOnBank: false };
  const parts: string[] = [];
  if (held) parts.push(`${plural(held, 'paycheck')} held`);
  if (pending) parts.push(`${plural(pending, 'paycheck')} still on the way`);
  return { tone: held ? 'error' : 'info', message: `Not paid in full yet: ${parts.join(', ')}.`, waitingOnBank: false };
}

/** The summary toast for a bulk disburse: paid, waiting on the bank file, not paid in full, failed. */
export function bulkDisburseMessage(runs: RunAfter[], failed: number, skippedApproval: number): { tone: 'success' | 'error'; message: string } {
  const outcomes = runs.map(disburseOutcome);
  const paid = outcomes.filter((o) => o.tone === 'success').length;
  const bank = outcomes.filter((o) => o.waitingOnBank).length;
  const partial = outcomes.length - paid - bank;
  const parts = [`${paid} paid`];
  if (bank) parts.push(`${bank} waiting for the bank upload`);
  if (partial) parts.push(`${partial} not paid in full`);
  if (failed) parts.push(`${failed} failed`);
  if (skippedApproval) parts.push(`${skippedApproval} skipped (needs second approval)`);
  return { tone: failed > 0 || partial > 0 ? 'error' : 'success', message: `Disburse: ${parts.join(' · ')}.` };
}

/** A retry of held paychecks: on the in-house file it puts them in a new file that waits for its upload, rather than paying them. */
export function retryMessage(r: { retried: number; succeeded: number; awaitingBankUpload?: number }): { tone: 'success' | 'info' | 'error'; message: string } {
  if (r.retried === 0) return { tone: 'success', message: 'No failed paychecks to retry.' };
  const queued = r.awaitingBankUpload ?? 0;
  if (queued > 0) {
    return {
      tone: 'info',
      message: `${plural(queued, 'paycheck')} went into a new bank file. They're paid once you upload it at the bank and mark it uploaded.${r.retried - r.succeeded - queued > 0 ? ` ${r.retried - r.succeeded - queued} failed again.` : ''}`,
    };
  }
  const failedAgain = r.retried - r.succeeded;
  return failedAgain > 0
    ? { tone: 'error', message: `Retried ${r.retried}: ${r.succeeded} paid, ${failedAgain} failed again.` }
    : { tone: 'success', message: `Retried ${r.retried}: all paid.` };
}
