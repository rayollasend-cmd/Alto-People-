import { Router } from 'express';
import { z } from 'zod';
import {
  BankAccountCreateInputSchema,
  BankAccountUpdateInputSchema,
  BankBulkInputSchema,
  BankCategorizeInputSchema,
  BankImportInputSchema,
  BankImportPreviewInputSchema,
  BankMatchInputSchema,
  BankReconcileStartInputSchema,
  BankRuleInputSchema,
  BankSuggestionsBatchInputSchema,
  BankUndoInputSchema,
  BankTickInputSchema,
  patchSchema,
} from '@alto-people/shared';
import { prisma } from '../../db.js';
import { requireCapability } from '../../middleware/auth.js';
import { enqueueAudit } from '../../lib/audit.js';
import { getBrandingSync } from '../../lib/branding.js';
import { tableSheet, toBuffer, workbook } from '../../lib/docKit/xlsx.js';
import {
  applyRules,
  bulkDecide,
  categorize,
  categoryAccounts,
  completeReconciliation,
  createFeedAccount,
  createRule,
  deleteRule,
  exclude,
  getFeedAccount,
  importFile,
  listFeedAccounts,
  listReconciliations,
  listRules,
  listTransactions,
  match,
  plaidExchange,
  plaidLinkToken,
  plaidStatus,
  previewImport,
  reconciliationDetail,
  startReconciliation,
  suggestionsFor,
  suggestionsForMany,
  syncFeed,
  tick,
  transactionView,
  undo,
  undoReconciliation,
  updateFeedAccount,
  updateRule,
} from '../../lib/books/bank/service.js';

/**
 * /books/bank — bank and card accounts in the books: feeds, imports,
 * review (match / categorize / exclude / undo), rules, Plaid, and
 * reconciliation. The contract: packages/shared/src/books/bank.ts.
 * Reading needs view:books (the books router); every change manage:books.
 */
export const booksBankRouter = Router();
const MANAGE = requireCapability('manage:books');
const Uuid = z.string().uuid();
const Ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

function audit(userId: string, action: string, entityType: string, entityId: string, metadata: Record<string, unknown> = {}) {
  enqueueAudit({ actorUserId: userId, action, entityType, entityId, metadata: metadata as object }, 'books.bank');
}

/* ---- Accounts ---------------------------------------------------------------- */

/** The chart, for the category and transfer pickers. */
booksBankRouter.get('/ledger-accounts', async (_req, res) => {
  res.json({ accounts: await categoryAccounts(prisma) });
});

booksBankRouter.get('/accounts', async (_req, res) => {
  res.json({ accounts: await listFeedAccounts(prisma) });
});

booksBankRouter.post('/accounts', MANAGE, async (req, res) => {
  const input = BankAccountCreateInputSchema.parse(req.body ?? {});
  const account = await createFeedAccount(prisma, input, req.user!.id);
  audit(req.user!.id, 'books.bank.account_added', 'BankFeedAccount', account.id, { name: account.name, feed: account.feed, ledgerCode: account.ledgerCode });
  res.status(201).json({ account });
});

booksBankRouter.get('/accounts/:id', async (req, res) => {
  res.json({ account: await getFeedAccount(prisma, Uuid.parse(req.params.id)) });
});

booksBankRouter.patch('/accounts/:id', MANAGE, async (req, res) => {
  const account = await updateFeedAccount(prisma, Uuid.parse(req.params.id), BankAccountUpdateInputSchema.parse(req.body ?? {}));
  audit(req.user!.id, 'books.bank.account_updated', 'BankFeedAccount', account.id, { fields: Object.keys(req.body ?? {}) });
  res.json({ account });
});

booksBankRouter.get('/accounts/:id/transactions', async (req, res) => {
  const q = z
    .object({
      status: z.enum(['UNMATCHED', 'MATCHED', 'CATEGORIZED', 'EXCLUDED']).optional(),
      q: z.string().max(120).optional(),
      from: Ymd.optional(),
      to: Ymd.optional(),
      limit: z.coerce.number().int().min(1).max(2000).optional(),
    })
    .parse(req.query);
  res.json(await listTransactions(prisma, Uuid.parse(req.params.id), q));
});

booksBankRouter.post('/accounts/:id/import/preview', MANAGE, async (req, res) => {
  const body = BankImportPreviewInputSchema.extend({ mapping: BankImportInputSchema.shape.mapping }).parse(req.body ?? {});
  res.json(await previewImport(prisma, Uuid.parse(req.params.id), body.filename, body.content, body.mapping));
});

booksBankRouter.post('/accounts/:id/import', MANAGE, async (req, res) => {
  const body = BankImportInputSchema.parse(req.body ?? {});
  const id = Uuid.parse(req.params.id);
  const result = await importFile(prisma, id, body.filename, body.content, body.mapping, req.user!.id);
  audit(req.user!.id, 'books.bank.imported', 'BankFeedAccount', id, { filename: body.filename.slice(0, 120), added: result.added, duplicates: result.duplicates, autoCategorized: result.autoCategorized });
  res.json(result);
});

booksBankRouter.post('/accounts/:id/sync', MANAGE, async (req, res) => {
  const id = Uuid.parse(req.params.id);
  const result = await syncFeed(prisma, id);
  audit(req.user!.id, 'books.bank.synced', 'BankFeedAccount', id, { added: result.added, updated: result.updated, removed: result.removed });
  res.json(result);
});

/* ---- Review ------------------------------------------------------------------ */

/** A page of suggestions in one call. A read — POST only for the list of ids. */
booksBankRouter.post('/transactions/suggestions', async (req, res) => {
  const { ids } = BankSuggestionsBatchInputSchema.parse(req.body ?? {});
  res.json({ suggestions: await suggestionsForMany(prisma, ids) });
});

booksBankRouter.post('/transactions/bulk', MANAGE, async (req, res) => {
  const { action, ids } = BankBulkInputSchema.parse(req.body ?? {});
  const verb = action === 'ACCEPT' ? 'categorized' : action === 'MATCH' ? 'matched' : 'excluded';
  // Each one audited as it finishes — a later failure doesn't lose the record of the ones done.
  const result = await bulkDecide(prisma, action, ids, req.user!.id, (id) => audit(req.user!.id, `books.bank.${verb}`, 'BankTransaction', id, { bulk: true }));
  res.json(result);
});

booksBankRouter.get('/transactions/:id', async (req, res) => {
  res.json({ transaction: await transactionView(prisma, Uuid.parse(req.params.id)) });
});

booksBankRouter.get('/transactions/:id/suggestions', async (req, res) => {
  res.json(await suggestionsFor(prisma, Uuid.parse(req.params.id)));
});

booksBankRouter.post('/transactions/:id/categorize', MANAGE, async (req, res) => {
  const id = Uuid.parse(req.params.id);
  const transaction = await categorize(prisma, id, BankCategorizeInputSchema.parse(req.body ?? {}), req.user!.id);
  audit(req.user!.id, 'books.bank.categorized', 'BankTransaction', id, { accountId: transaction.category?.accountId, amount: transaction.amount });
  res.json({ transaction });
});

booksBankRouter.post('/transactions/:id/match', MANAGE, async (req, res) => {
  const id = Uuid.parse(req.params.id);
  const { lineId } = BankMatchInputSchema.parse(req.body ?? {});
  const transaction = await match(prisma, id, lineId, req.user!.id);
  audit(req.user!.id, 'books.bank.matched', 'BankTransaction', id, { lineId });
  res.json({ transaction });
});

booksBankRouter.post('/transactions/:id/exclude', MANAGE, async (req, res) => {
  const id = Uuid.parse(req.params.id);
  const transaction = await exclude(prisma, id, req.user!.id);
  audit(req.user!.id, 'books.bank.excluded', 'BankTransaction', id);
  res.json({ transaction });
});

booksBankRouter.post('/transactions/:id/undo', MANAGE, async (req, res) => {
  const id = Uuid.parse(req.params.id);
  const body = BankUndoInputSchema.parse(req.body ?? {});
  const { paymentKept, paymentUndone, ...transaction } = await undo(prisma, id, req.user!.id, body);
  audit(req.user!.id, 'books.bank.undone', 'BankTransaction', id, paymentUndone ? { paymentUndone: true } : undefined);
  res.json({ transaction, paymentKept: paymentKept ?? null, paymentUndone: !!paymentUndone });
});

/* ---- Rules ------------------------------------------------------------------- */

booksBankRouter.get('/rules', async (_req, res) => {
  res.json({ rules: await listRules(prisma) });
});

booksBankRouter.post('/rules', MANAGE, async (req, res) => {
  const rule = await createRule(prisma, BankRuleInputSchema.parse(req.body ?? {}), req.user!.id);
  audit(req.user!.id, 'books.bank.rule_added', 'BankRule', rule.id, { name: rule.name, contains: rule.contains, autoApply: rule.autoApply });
  res.status(201).json({ rule });
});

booksBankRouter.post('/rules/apply', MANAGE, async (req, res) => {
  const body = z.object({ feedAccountId: Uuid.optional() }).parse(req.body ?? {});
  const categorized = await applyRules(prisma, { feedAccountId: body.feedAccountId, autoOnly: false, userId: req.user!.id });
  res.json({ categorized });
});

booksBankRouter.patch('/rules/:id', MANAGE, async (req, res) => {
  const rule = await updateRule(prisma, Uuid.parse(req.params.id), patchSchema(BankRuleInputSchema).parse(req.body ?? {}));
  audit(req.user!.id, 'books.bank.rule_updated', 'BankRule', rule.id, { fields: Object.keys(req.body ?? {}) });
  res.json({ rule });
});

booksBankRouter.delete('/rules/:id', MANAGE, async (req, res) => {
  const id = Uuid.parse(req.params.id);
  await deleteRule(prisma, id);
  audit(req.user!.id, 'books.bank.rule_deleted', 'BankRule', id);
  res.status(204).end();
});

/* ---- Plaid ------------------------------------------------------------------- */

booksBankRouter.get('/plaid/status', async (_req, res) => {
  res.json(await plaidStatus());
});

booksBankRouter.post('/plaid/link-token', MANAGE, async (req, res) => {
  res.json({ linkToken: await plaidLinkToken(req.user!.id, getBrandingSync().orgName) });
});

booksBankRouter.post('/plaid/exchange', MANAGE, async (req, res) => {
  const { publicToken } = z.object({ publicToken: z.string().min(1).max(500) }).parse(req.body ?? {});
  const out = await plaidExchange(prisma, publicToken);
  audit(req.user!.id, 'books.bank.plaid_linked', 'PlaidItem', '00000000-0000-0000-0000-000000000000', { itemId: out.itemId, accounts: out.accounts.length });
  res.json(out);
});

/* ---- Reconciliation ---------------------------------------------------------- */

booksBankRouter.get('/accounts/:id/reconciliations', async (req, res) => {
  res.json({ reconciliations: await listReconciliations(prisma, Uuid.parse(req.params.id)) });
});

booksBankRouter.post('/accounts/:id/reconciliations', MANAGE, async (req, res) => {
  const detail = await startReconciliation(prisma, Uuid.parse(req.params.id), BankReconcileStartInputSchema.parse(req.body ?? {}), req.user!.id);
  audit(req.user!.id, 'books.bank.reconciliation_started', 'BankReconciliation', detail.id, { statementEndDate: detail.statementEndDate, statementBalance: detail.statementBalance });
  res.status(201).json(detail);
});

booksBankRouter.get('/reconciliations/:id', async (req, res) => {
  res.json(await reconciliationDetail(prisma, Uuid.parse(req.params.id)));
});

booksBankRouter.post('/reconciliations/:id/tick', MANAGE, async (req, res) => {
  const { lineIds, cleared } = BankTickInputSchema.parse(req.body ?? {});
  res.json(await tick(prisma, Uuid.parse(req.params.id), lineIds, cleared));
});

booksBankRouter.post('/reconciliations/:id/complete', MANAGE, async (req, res) => {
  const detail = await completeReconciliation(prisma, Uuid.parse(req.params.id), req.user!.id);
  audit(req.user!.id, 'books.bank.reconciled', 'BankReconciliation', detail.id, { statementEndDate: detail.statementEndDate, statementBalance: detail.statementBalance, cleared: detail.clearedCount });
  res.json(detail);
});

booksBankRouter.post('/reconciliations/:id/undo', MANAGE, async (req, res) => {
  const detail = await undoReconciliation(prisma, Uuid.parse(req.params.id));
  audit(req.user!.id, 'books.bank.reconciliation_undone', 'BankReconciliation', detail.id, { statementEndDate: detail.statementEndDate });
  res.json(detail);
});

booksBankRouter.get('/reconciliations/:id/report.xlsx', async (req, res) => {
  const d = await reconciliationDetail(prisma, Uuid.parse(req.params.id));
  const company = getBrandingSync().orgName;
  const wb = workbook({ company });
  const fmt = (n: number) => n.toFixed(2);
  tableSheet(wb, {
    name: 'Reconciliation',
    title: `${d.accountName} — reconciliation through ${d.statementEndDate}`,
    subtitle: `${company} · statement balance ${fmt(d.statementBalance)} · beginning ${fmt(d.beginningBalance)} · cleared ${fmt(d.clearedBalance)} · difference ${fmt(d.difference)}`,
    note: d.status === 'COMPLETED' ? `Completed ${d.completedAt?.slice(0, 10) ?? ''}${d.completedByName ? ` by ${d.completedByName}` : ''}.` : 'In progress — not yet complete.',
    columns: [
      { header: 'Date', key: 'date', width: 12 },
      { header: 'Entry', key: 'entryNumber', type: 'number', width: 9 },
      { header: 'Memo', key: 'memo', width: 46 },
      { header: 'Source', key: 'source', width: 16 },
      { header: 'Amount', key: 'amount', type: 'money', total: true },
      { header: 'Cleared', key: 'cleared', width: 10, value: (r: (typeof d.lines)[number]) => (r.cleared ? 'Yes' : '') },
    ],
    rows: d.lines,
  });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="reconciliation-${d.statementEndDate}.xlsx"`);
  res.send(await toBuffer(wb));
});
