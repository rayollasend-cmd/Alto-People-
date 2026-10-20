import { z } from 'zod';

/**
 * The books — bank and card accounts (packages/shared). One feed account per
 * BANK or CREDIT_CARD ledger account; its transactions come from a CSV or
 * OFX upload or from Plaid, and each is matched to a ledger line already in
 * the books, categorized into a new entry, or excluded. Reconciliation ticks
 * the ledger lines a statement shows until the difference is zero.
 *
 *   GET    /books/bank/ledger-accounts                   → { accounts: BankLedgerAccountOption[] } (the pickers)
 *   GET    /books/bank/accounts                          → { accounts: BankFeedAccountView[] }
 *   POST   /books/bank/accounts                          BankAccountCreateInput → { account }
 *   PATCH  /books/bank/accounts/:id                      BankAccountUpdateInput → { account }
 *   GET    /books/bank/accounts/:id                      → { account }
 *   GET    /books/bank/accounts/:id/transactions?status&q&from&to → { transactions: BankTxnView[], counts }
 *   POST   /books/bank/accounts/:id/import/preview       BankImportPreviewInput → BankImportPreview
 *   POST   /books/bank/accounts/:id/import               BankImportInput → BankImportResult
 *   GET    /books/bank/transactions/:id/suggestions      → BankTxnSuggestions
 *   POST   /books/bank/transactions/:id/categorize       BankCategorizeInput → { transaction }
 *   POST   /books/bank/transactions/:id/match            { lineId } → { transaction }
 *   POST   /books/bank/transactions/:id/exclude          → { transaction }
 *   POST   /books/bank/transactions/:id/undo             → { transaction }
 *   GET    /books/bank/rules                             → { rules: BankRuleView[] }
 *   POST   /books/bank/rules                             BankRuleInput → { rule }
 *   PATCH  /books/bank/rules/:id                         Partial<BankRuleInput> → { rule }
 *   DELETE /books/bank/rules/:id                         → 204
 *   POST   /books/bank/rules/apply                       { feedAccountId? } → { categorized }
 *   GET    /books/bank/plaid/status                      → BankPlaidStatus
 *   POST   /books/bank/plaid/link-token                  → { linkToken }
 *   POST   /books/bank/plaid/exchange                    { publicToken } → { itemId, accounts: BankPlaidAccount[] }
 *   POST   /books/bank/accounts/:id/sync                 → BankImportResult (a Plaid feed, now)
 *   GET    /books/bank/accounts/:id/reconciliations      → { reconciliations: BankReconciliationSummary[] }
 *   POST   /books/bank/accounts/:id/reconciliations      BankReconcileStartInput → BankReconciliationDetail
 *   GET    /books/bank/reconciliations/:id               → BankReconciliationDetail
 *   POST   /books/bank/reconciliations/:id/tick          { lineIds, cleared } → BankReconciliationDetail
 *   POST   /books/bank/reconciliations/:id/complete      → BankReconciliationDetail
 *   POST   /books/bank/reconciliations/:id/undo          → BankReconciliationDetail (the most recent completed one, reopened)
 *   GET    /books/bank/reconciliations/:id/report.xlsx   → the reconciliation report
 *
 * Amounts: dollars. A transaction's amount > 0 is money into the account, < 0 money out.
 */

const Ymd = /* @__PURE__ */ (() => z.string().regex(/^\d{4}-\d{2}-\d{2}$/))();

export type BankFeedKind = 'MANUAL' | 'PLAID';

export interface BankLedgerAccountOption {
  id: string;
  code: string;
  name: string;
  type: string;
  subtype: string;
}
export type BankTxnStatus = 'UNMATCHED' | 'MATCHED' | 'CATEGORIZED' | 'EXCLUDED';

export interface BankFeedAccountView {
  id: string;
  ledgerAccountId: string;
  ledgerCode: string;
  ledgerName: string;
  /** BANK | CREDIT_CARD */
  subtype: string;
  name: string;
  institution: string | null;
  mask: string | null;
  feed: BankFeedKind;
  isActive: boolean;
  /** The ledger's balance, signed to the account's normal side (a card's balance owed is positive). */
  booksBalance: number;
  /** What the bank last said (Plaid, or an OFX ledger balance), when known. */
  bankBalance: number | null;
  lastSyncedAt: string | null;
  lastError: string | null;
  forReview: number;
  lastReconciled: { statementEndDate: string; statementBalance: number } | null;
}

export const BankAccountCreateInputSchema = /* @__PURE__ */ (() =>
  z
    .object({
      /** An existing BANK / CREDIT_CARD ledger account … */
      ledgerAccountId: z.string().uuid().optional(),
      /** … or a new one made with it. */
      newAccount: z.object({ code: z.string().trim().min(1).max(20), name: z.string().trim().min(1).max(160), subtype: z.enum(['BANK', 'CREDIT_CARD']) }).optional(),
      name: z.string().trim().min(1).max(120).optional(),
      institution: z.string().trim().max(120).nullable().optional(),
      mask: z.string().trim().max(8).nullable().optional(),
      /** A Plaid account from /plaid/exchange. */
      plaid: z.object({ itemId: z.string().min(1).max(60), accountId: z.string().min(1).max(60) }).optional(),
    })
    .refine((v) => !!v.ledgerAccountId !== !!v.newAccount, { message: 'Pick a ledger account or name a new one.' }))();
export type BankAccountCreateInput = z.infer<typeof BankAccountCreateInputSchema>;

export const BankAccountUpdateInputSchema = /* @__PURE__ */ (() =>
  z.object({
    name: z.string().trim().min(1).max(120).optional(),
    institution: z.string().trim().max(120).nullable().optional(),
    mask: z.string().trim().max(8).nullable().optional(),
    isActive: z.boolean().optional(),
  }))();
export type BankAccountUpdateInput = z.infer<typeof BankAccountUpdateInputSchema>;

export interface BankTxnView {
  id: string;
  feedAccountId: string;
  postedOn: string;
  amount: number;
  description: string;
  payee: string | null;
  reference: string | null;
  importedFrom: 'FEED' | 'CSV' | 'OFX';
  status: BankTxnStatus;
  /** Where it went: the category account (or the transfer account), or the line it matched. */
  category: { accountId: string; code: string; name: string; transfer: boolean } | null;
  matched: { lineId: string; entryId: string; entryNumber: number; memo: string | null; date: string } | null;
  journalEntryId: string | null;
  ruleName: string | null;
  decidedAt: string | null;
}

export interface BankTxnCounts {
  UNMATCHED: number;
  MATCHED: number;
  CATEGORIZED: number;
  EXCLUDED: number;
}

/* ---- Import ---------------------------------------------------------------- */

export const BankCsvMappingSchema = /* @__PURE__ */ (() =>
  z.object({
    dateColumn: z.number().int().min(0),
    descriptionColumn: z.number().int().min(0),
    /** One signed amount column … */
    amountColumn: z.number().int().min(0).nullable(),
    /** … or money out and money in in two columns. */
    debitColumn: z.number().int().min(0).nullable(),
    creditColumn: z.number().int().min(0).nullable(),
    referenceColumn: z.number().int().min(0).nullable().optional(),
    /** Card exports often show a charge as a positive number: flip so money out is negative. */
    flipSign: z.boolean().default(false),
    /** MDY | DMY | YMD — how the date column is written. */
    dateOrder: z.enum(['MDY', 'DMY', 'YMD']).default('MDY'),
    hasHeader: z.boolean().default(true),
  }))();
export type BankCsvMapping = z.infer<typeof BankCsvMappingSchema>;

export const BankImportPreviewInputSchema = /* @__PURE__ */ (() =>
  z.object({ filename: z.string().max(200), content: z.string().min(1).max(1_800_000) }))();
export type BankImportPreviewInput = z.infer<typeof BankImportPreviewInputSchema>;

export interface BankImportPreview {
  format: 'CSV' | 'OFX';
  /** CSV: the header row (or "Column 1…") and the first rows, to confirm the mapping. */
  columns: string[];
  sample: string[][];
  mapping: BankCsvMapping | null;
  /** The transactions as they would import with this mapping (first 20). */
  parsed: Array<{ postedOn: string; amount: number; description: string; reference: string | null }>;
  total: number;
  /** How many of them are already on file. */
  duplicates: number;
  errors: string[];
}

export const BankImportInputSchema = /* @__PURE__ */ (() =>
  z.object({ filename: z.string().max(200), content: z.string().min(1).max(1_800_000), mapping: BankCsvMappingSchema.optional() }))();
export type BankImportInput = z.infer<typeof BankImportInputSchema>;

export interface BankImportResult {
  added: number;
  duplicates: number;
  updated: number;
  removed: number;
  autoCategorized: number;
  errors: string[];
}

/* ---- Review ---------------------------------------------------------------- */

export interface BankTxnSuggestions {
  /** Ledger lines on this account with the same amount within five days, not yet matched. */
  matches: Array<{ lineId: string; entryId: string; entryNumber: number; date: string; memo: string | null; source: string; amount: number; daysApart: number }>;
  /** The rule that fits it, if any. */
  rule: { ruleId: string; name: string; accountId: string; accountCode: string; accountName: string; vendorId: string | null; clientId: string | null; departmentId: string | null } | null;
  /** What it was categorized as the last time this payee appeared. */
  lastTime: { accountId: string; accountCode: string; accountName: string } | null;
}

export const BankCategorizeInputSchema = /* @__PURE__ */ (() =>
  z.object({
    accountId: z.string().uuid(),
    memo: z.string().trim().max(300).nullable().optional(),
    vendorId: z.string().uuid().nullable().optional(),
    clientId: z.string().uuid().nullable().optional(),
    departmentId: z.string().uuid().nullable().optional(),
  }))();
export type BankCategorizeInput = z.infer<typeof BankCategorizeInputSchema>;

export const BankMatchInputSchema = /* @__PURE__ */ (() => z.object({ lineId: z.string().uuid() }))();

/* ---- Rules ----------------------------------------------------------------- */

export interface BankRuleView {
  id: string;
  name: string;
  contains: string;
  direction: 'IN' | 'OUT' | 'ANY';
  minAmount: number | null;
  maxAmount: number | null;
  accountId: string;
  accountCode: string;
  accountName: string;
  vendorId: string | null;
  clientId: string | null;
  departmentId: string | null;
  priority: number;
  autoApply: boolean;
  isActive: boolean;
}

export const BankRuleInputSchema = /* @__PURE__ */ (() =>
  z.object({
    name: z.string().trim().min(1).max(120),
    contains: z.string().trim().min(1).max(120),
    direction: z.enum(['IN', 'OUT', 'ANY']).default('ANY'),
    minAmount: z.number().nonnegative().nullable().optional(),
    maxAmount: z.number().nonnegative().nullable().optional(),
    accountId: z.string().uuid(),
    vendorId: z.string().uuid().nullable().optional(),
    clientId: z.string().uuid().nullable().optional(),
    departmentId: z.string().uuid().nullable().optional(),
    priority: z.number().int().min(0).max(10_000).default(100),
    autoApply: z.boolean().default(false),
    isActive: z.boolean().default(true),
  }))();
export type BankRuleInput = z.infer<typeof BankRuleInputSchema>;

/* ---- Plaid ----------------------------------------------------------------- */

export interface BankPlaidStatus {
  /** A Plaid connection is set up under Integrations (BANK_FEED). */
  configured: boolean;
  environment: 'SANDBOX' | 'PRODUCTION' | null;
}

export interface BankPlaidAccount {
  accountId: string;
  name: string;
  mask: string | null;
  type: string;
  subtype: string | null;
  institution: string | null;
  /** Already a feed here. */
  linkedFeedId: string | null;
}

/* ---- Reconciliation -------------------------------------------------------- */

export const BankReconcileStartInputSchema = /* @__PURE__ */ (() =>
  z.object({ statementEndDate: Ymd, statementBalance: z.number() }))();
export type BankReconcileStartInput = z.infer<typeof BankReconcileStartInputSchema>;

export interface BankReconciliationSummary {
  id: string;
  statementEndDate: string;
  statementBalance: number;
  beginningBalance: number;
  status: 'IN_PROGRESS' | 'COMPLETED';
  completedAt: string | null;
  completedByName: string | null;
  clearedCount: number;
}

export interface BankReconLine {
  lineId: string;
  entryId: string;
  entryNumber: number;
  date: string;
  memo: string | null;
  source: string;
  /** Signed to the account's normal side: money in to a bank account is positive. */
  amount: number;
  cleared: boolean;
}

export interface BankReconciliationDetail extends BankReconciliationSummary {
  feedAccountId: string;
  accountName: string;
  subtype: string;
  lines: BankReconLine[];
  clearedBalance: number;
  /** statementBalance − (beginningBalance + cleared). Zero to complete. */
  difference: number;
  /** Only the most recent completed reconciliation can be undone. */
  canUndo: boolean;
}

export const BankTickInputSchema = /* @__PURE__ */ (() =>
  z.object({ lineIds: z.array(z.string().uuid()).min(1).max(2000), cleared: z.boolean() }))();
