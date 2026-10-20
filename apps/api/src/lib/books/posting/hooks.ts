import { prisma } from '../../../db.js';
import { bookLater, voidByKey } from './common.js';
import { disburseKey, postPayrollRun, runKey } from './payroll.js';
import { postGarnishmentRemittance, postTaxDeposit, postTaxPayment, postWageAdvance } from './remittances.js';
import { postStatement } from './statements.js';

/**
 * The calls the operational code makes after its own work commits — one
 * line each, never awaited for its outcome, never able to fail the thing
 * that triggered it (lib/books/posting/common bookLater). What doesn't post
 * shows on the close checklist (postingGaps) and the backfill catches it.
 */
export const booksAfterPayrollRun = (runId: string): void => bookLater(`payroll run ${runId}`, () => postPayrollRun(prisma, runId));
/** A run deleted outright (a finalized run thrown away before it paid): its entries come off. */
export const booksAfterRunDeleted = (runId: string): void =>
  bookLater(`deleted payroll run ${runId}`, async () => {
    await voidByKey(prisma, disburseKey(runId), 'The payroll run was deleted');
    await voidByKey(prisma, runKey(runId), 'The payroll run was deleted');
  });
export const booksAfterStatement = (statementId: string): void => bookLater(`statement ${statementId}`, () => postStatement(prisma, statementId));
export const booksAfterTaxPayment = (paymentId: string): void => bookLater(`tax payment ${paymentId}`, () => postTaxPayment(prisma, paymentId));
export const booksAfterTaxDeposit = (depositId: string): void => bookLater(`tax deposit ${depositId}`, () => postTaxDeposit(prisma, depositId));
export const booksAfterGarnishmentRemittance = (id: string): void => bookLater(`garnishment remittance ${id}`, () => postGarnishmentRemittance(prisma, id));
export const booksAfterWageAdvance = (id: string): void => bookLater(`wage advance ${id}`, () => postWageAdvance(prisma, id));
export { flushPendingBooks } from './common.js';
