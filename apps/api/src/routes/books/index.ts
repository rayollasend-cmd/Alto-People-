import { Router } from 'express';
import { requireCapability } from '../../middleware/auth.js';
import { booksLedgerRouter } from './ledger.js';
import { booksReceivablesRouter } from './receivables.js';
import { booksPayablesRouter } from './payables.js';
import { booksBankRouter } from './bank.js';
import { booksCloseRouter } from './close.js';
import { booksBudgetsRouter } from './budgets.js';
import { booksAssetsRouter } from './assets.js';
import { booksQuickbooksRouter } from './quickbooks.js';

/**
 * /books — the company's own finance engine (lib/books). Everything here
 * needs view:books; each router gates its writes on manage:books.
 *
 *   /books                      overview, accounts, journal, reports   (ledger.ts)
 *   /books/receivables          client payments, AR aging              (receivables.ts)
 *   /books/vendors, /books/bills, /books/bill-payments                 (payables.ts)
 *   /books/bank                 feeds, transactions, rules, reconcile  (bank.ts)
 *   /books/close                periods, checklist, lock, accruals     (close.ts)
 *   /books/budgets              budgets, budget vs actual, forecast    (budgets.ts)
 *   /books/assets               fixed assets, depreciation             (assets.ts)
 *   /books/quickbooks           the company QuickBooks sync            (quickbooks.ts)
 */
export const booksRouter = Router();
booksRouter.use(requireCapability('view:books'));
booksRouter.use('/receivables', booksReceivablesRouter);
booksRouter.use('/bank', booksBankRouter);
booksRouter.use('/close', booksCloseRouter);
booksRouter.use('/budgets', booksBudgetsRouter);
booksRouter.use('/assets', booksAssetsRouter);
booksRouter.use('/quickbooks', booksQuickbooksRouter);
booksRouter.use('/', booksPayablesRouter);
booksRouter.use('/', booksLedgerRouter);
