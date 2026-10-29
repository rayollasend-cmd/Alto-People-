import { z } from 'zod';

/**
 * The books — ledger, statements and overview contract.
 *
 *   GET    /books/overview                       → BooksOverview
 *   GET    /books/dimensions                     → BooksDimensions (filter pickers)
 *   GET    /books/accounts?asOf                  → { accounts: LedgerAccountRow[] }
 *   POST   /books/accounts                       LedgerAccountCreateInput → { account }
 *   PATCH  /books/accounts/:id                   LedgerAccountUpdateInput → { account }
 *   DELETE /books/accounts/:id                   → 204 (only with no entries)
 *   GET    /books/accounts/:id/detail?from&to&clientId&siteId&departmentId&costCenterId → LedgerAccountDetail
 *   GET    /books/journal?from&to&source&origin&status&accountId&q&sort&dir&limit&offset → BooksJournalList
 *   GET    /books/journal.csv?(the same filters and sort) → every matching entry as CSV
 *   GET    /books/journal/:id                    → { entry: BooksJournalEntryDetail }
 *   POST   /books/journal                        BooksManualEntryInput → { entry }
 *   POST   /books/journal/:id/void               { reason } → { voided, reversalId }
 *   GET    /books/opening-balances               → { date, lines } (the current opening entry, if any)
 *   POST   /books/opening-balances               BooksOpeningBalancesInput → { entry }
 *   GET    /books/reports/trial-balance[.xlsx|.pdf]?asOf&dims
 *   GET    /books/reports/profit-and-loss[.xlsx|.pdf]?from&to&columns&dims&compare=prior|yoy
 *   GET    /books/reports/balance-sheet[.xlsx|.pdf]?asOf&dims&compare=prior|yoy
 *   GET    /books/reports/cash-flow[.xlsx|.pdf]?from&to&dims&compare=prior|yoy
 */

const Ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Id = z.string().uuid();

export const LEDGER_ACCOUNT_TYPES = ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'] as const;
export const LedgerAccountTypeSchema = z.enum(LEDGER_ACCOUNT_TYPES);
export type LedgerAccountType = z.infer<typeof LedgerAccountTypeSchema>;

/** The subtypes each type may take — the statements group by them. */
export const LEDGER_SUBTYPES: Record<LedgerAccountType, readonly string[]> = {
  ASSET: ['BANK', 'AR', 'CURRENT_ASSET', 'FIXED_ASSET', 'ACCUMULATED_DEPRECIATION', 'OTHER_ASSET'],
  LIABILITY: ['AP', 'CREDIT_CARD', 'CURRENT_LIABILITY', 'PAYROLL_LIABILITY', 'TAX_LIABILITY', 'LONG_TERM_LIABILITY'],
  EQUITY: ['EQUITY', 'RETAINED_EARNINGS'],
  INCOME: ['INCOME', 'OTHER_INCOME'],
  EXPENSE: ['COST_OF_SERVICES', 'EXPENSE', 'OTHER_EXPENSE'],
};

export const LEDGER_TYPE_LABELS: Record<LedgerAccountType, string> = {
  ASSET: 'Assets',
  LIABILITY: 'Liabilities',
  EQUITY: 'Equity',
  INCOME: 'Income',
  EXPENSE: 'Expenses',
};

export const LEDGER_SUBTYPE_LABELS: Record<string, string> = {
  BANK: 'Bank',
  AR: 'Accounts receivable',
  CURRENT_ASSET: 'Current asset',
  FIXED_ASSET: 'Fixed asset',
  ACCUMULATED_DEPRECIATION: 'Accumulated depreciation',
  OTHER_ASSET: 'Other asset',
  AP: 'Accounts payable',
  CREDIT_CARD: 'Credit card',
  CURRENT_LIABILITY: 'Current liability',
  PAYROLL_LIABILITY: 'Payroll liability',
  TAX_LIABILITY: 'Tax liability',
  LONG_TERM_LIABILITY: 'Long-term liability',
  EQUITY: 'Equity',
  RETAINED_EARNINGS: 'Retained earnings',
  INCOME: 'Income',
  OTHER_INCOME: 'Other income',
  COST_OF_SERVICES: 'Cost of services',
  EXPENSE: 'Operating expense',
  OTHER_EXPENSE: 'Other expense',
};

/** Where an entry came from, in words. */
export const JOURNAL_SOURCE_LABELS: Record<string, string> = {
  MANUAL: 'Manual entry',
  PAYROLL: 'Payroll',
  PAYROLL_DISBURSEMENT: 'Payroll paid out',
  STATEMENT: 'Client statement',
  CLIENT_PAYMENT: 'Client payment',
  TAX_PAYMENT: 'Tax deposit',
  REIMBURSEMENT: 'Reimbursement',
  GARNISHMENT: 'Garnishment',
  BILL: 'Vendor bill',
  BILL_PAYMENT: 'Bill payment',
  BANK: 'Bank activity',
  DEPRECIATION: 'Depreciation',
  ACCRUAL: 'Accrual',
  REVERSAL: 'Reversal',
  QUICKBOOKS: 'From QuickBooks',
  OPENING: 'Opening balances',
  ASSET_DISPOSAL: 'Asset disposal',
};

export const BooksDimensionsFilterSchema = z.object({
  clientId: Id.optional(),
  siteId: Id.optional(),
  departmentId: Id.optional(),
  costCenterId: Id.optional(),
});
export type BooksDimensionsFilter = z.infer<typeof BooksDimensionsFilterSchema>;

/* ---- Accounts -------------------------------------------------------------- */

export interface LedgerAccountRow {
  id: string;
  code: string;
  name: string;
  type: LedgerAccountType;
  subtype: string;
  systemKey: string | null;
  parentId: string | null;
  description: string | null;
  isActive: boolean;
  /** Signed to the account's normal side (an expense or asset positive). */
  balance: number;
  /** Has any entry: its type can't change and it can't be deleted. */
  hasEntries: boolean;
  /** Net movement from Jan 1 of the as-of year through the as-of date, signed like `balance`. */
  activityYtd: number;
}

export const LedgerAccountCreateInputSchema = z.object({
  code: z.string().trim().min(1).max(20),
  name: z.string().trim().min(1).max(160),
  type: LedgerAccountTypeSchema,
  subtype: z.string().trim().min(1).max(32),
  parentId: Id.nullable().optional(),
  description: z.string().trim().max(500).nullable().optional(),
});
export type LedgerAccountCreateInput = z.infer<typeof LedgerAccountCreateInputSchema>;

export const LedgerAccountUpdateInputSchema = z.object({
  code: z.string().trim().min(1).max(20).optional(),
  name: z.string().trim().min(1).max(160).optional(),
  type: LedgerAccountTypeSchema.optional(),
  subtype: z.string().trim().min(1).max(32).optional(),
  parentId: Id.nullable().optional(),
  description: z.string().trim().max(500).nullable().optional(),
  isActive: z.boolean().optional(),
});
export type LedgerAccountUpdateInput = z.infer<typeof LedgerAccountUpdateInputSchema>;

export interface LedgerAccountDetailRow {
  lineId: string;
  entryId: string;
  number: number;
  date: string;
  memo: string | null;
  source: string;
  origin: string;
  debit: number;
  credit: number;
  balance: number;
  clientId: string | null;
  cleared: boolean;
}

export interface LedgerAccountDetail {
  account: { id: string; code: string; name: string; type: LedgerAccountType; subtype: string };
  from: string;
  to: string;
  opening: number;
  closing: number;
  rows: LedgerAccountDetailRow[];
}

/* ---- Journal --------------------------------------------------------------- */

export interface BooksJournalRow {
  id: string;
  number: number;
  date: string;
  memo: string | null;
  source: string;
  origin: 'SITE' | 'QUICKBOOKS';
  status: 'POSTED' | 'VOID';
  amount: number;
  /** "Rent / Operating checking" or "6 accounts". */
  accounts: string;
  reverseOn: string | null;
}

export interface BooksJournalList {
  entries: BooksJournalRow[];
  total: number;
}

export interface BooksJournalLine {
  id: string;
  lineNo: number;
  account: { id: string; code: string; name: string; type: LedgerAccountType };
  debit: number;
  credit: number;
  memo: string | null;
  client: { id: string; name: string } | null;
  site: { id: string; name: string } | null;
  department: { id: string; name: string } | null;
  costCenter: { id: string; name: string } | null;
  vendor: { id: string; name: string } | null;
  cleared: boolean;
}

export interface BooksJournalEntryDetail {
  id: string;
  number: number;
  date: string;
  periodKey: string;
  memo: string | null;
  source: string;
  sourceType: string | null;
  sourceId: string | null;
  /** Where the record that posted it lives, when it has a page. */
  sourceLink: { label: string; to: string } | null;
  origin: 'SITE' | 'QUICKBOOKS';
  status: 'POSTED' | 'VOID';
  reverseOn: string | null;
  reverses: { id: string; number: number } | null;
  reversedBy: Array<{ id: string; number: number }>;
  total: number;
  createdByName: string | null;
  postedAt: string;
  voidedAt: string | null;
  voidedByName: string | null;
  voidReason: string | null;
  /** The month is closed: a void posts a reversal instead. */
  periodClosed: boolean;
  lines: BooksJournalLine[];
}

const ManualLine = z.object({
  accountId: Id,
  debit: z.number().min(0).max(1e11).default(0),
  credit: z.number().min(0).max(1e11).default(0),
  memo: z.string().trim().max(300).nullable().optional(),
  clientId: Id.nullable().optional(),
  siteId: Id.nullable().optional(),
  departmentId: Id.nullable().optional(),
  costCenterId: Id.nullable().optional(),
});

export const BooksManualEntryInputSchema = z.object({
  date: Ymd,
  memo: z.string().trim().max(500).nullable().optional(),
  /** An accrual: reverse automatically on this date. */
  reverseOn: Ymd.nullable().optional(),
  lines: z.array(ManualLine).min(2).max(200),
});
export type BooksManualEntryInput = z.infer<typeof BooksManualEntryInputSchema>;

export const BooksVoidInputSchema = z.object({ reason: z.string().trim().min(3).max(300) });

export const BooksOpeningBalancesInputSchema = z.object({
  date: Ymd,
  /** Each account's balance on the date, on its normal side (an asset or a liability positive). */
  lines: z.array(z.object({ accountId: Id, amount: z.number().min(-1e11).max(1e11) })).min(1).max(500),
});
export type BooksOpeningBalancesInput = z.infer<typeof BooksOpeningBalancesInputSchema>;

/* ---- Reports --------------------------------------------------------------- */

export interface BooksReportRow {
  accountId: string;
  code: string;
  name: string;
  type: string;
  subtype: string;
  amount: number;
}

export interface BooksPnlSections {
  income: BooksReportRow[];
  costOfServices: BooksReportRow[];
  expenses: BooksReportRow[];
  otherIncome: BooksReportRow[];
  otherExpenses: BooksReportRow[];
}

export interface BooksPnlTotals {
  income: number;
  costOfServices: number;
  grossProfit: number;
  grossMarginPct: number | null;
  expenses: number;
  operatingIncome: number;
  otherIncome: number;
  otherExpenses: number;
  netIncome: number;
}

/**
 * A statement's comparison: `prior` is the same span just before (the month
 * before a month, the quarter before a quarter, last year's year-to-date
 * for a year-to-date); `yoy` is the same dates a year earlier.
 */
export const BOOKS_COMPARE_KINDS = ['prior', 'yoy'] as const;
export type BooksCompareKind = (typeof BOOKS_COMPARE_KINDS)[number];

export interface BooksProfitAndLoss {
  from: string;
  to: string;
  sections: BooksPnlSections;
  totals: BooksPnlTotals;
  columns: Array<{ key: string; label: string; sections: BooksPnlSections; totals: BooksPnlTotals }>;
  /** With ?compare= (and no columns): the same statement for the comparison range. */
  compare?: { kind: BooksCompareKind; from: string; to: string; sections: BooksPnlSections; totals: BooksPnlTotals } | null;
}

export interface BooksBalanceSheet {
  asOf: string;
  fiscalYearStart: string;
  assets: BooksReportRow[];
  liabilities: BooksReportRow[];
  equity: BooksReportRow[];
  totals: { assets: number; liabilities: number; equity: number; liabilitiesAndEquity: number; balanced: boolean };
  /** With ?compare=: the balance sheet a month (prior) or a year (yoy) earlier. */
  compare?: { kind: BooksCompareKind; asOf: string; assets: BooksReportRow[]; liabilities: BooksReportRow[]; equity: BooksReportRow[]; totals: BooksBalanceSheet['totals'] } | null;
}

export interface BooksCashFlow {
  from: string;
  to: string;
  netIncome: number;
  operating: BooksReportRow[];
  investing: BooksReportRow[];
  financing: BooksReportRow[];
  totals: { operating: number; investing: number; financing: number; netChange: number; cashChange: number; reconciles: boolean };
  /** With ?compare=: the same statement for the comparison range. */
  compare?: { kind: BooksCompareKind; from: string; to: string; netIncome: number; operating: BooksReportRow[]; investing: BooksReportRow[]; financing: BooksReportRow[]; totals: BooksCashFlow['totals'] } | null;
}

export interface BooksTrialBalance {
  asOf: string;
  rows: Array<{ accountId: string; code: string; name: string; type: string; debit: number; credit: number }>;
  totals: { debit: number; credit: number; balanced: boolean };
}

/* ---- Dimensions and overview ---------------------------------------------- */

export interface BooksNamed {
  id: string;
  name: string;
}

export interface BooksDimensions {
  clients: BooksNamed[];
  sites: BooksNamed[];
  departments: BooksNamed[];
  costCenters: BooksNamed[];
}

export interface BooksOverview {
  asOf: string;
  cash: {
    total: number;
    accounts: Array<{ id: string; code: string; name: string; subtype: string; balance: number }>;
    /** Bank and card accounts connected to a feed (the Bank page's list) — the ledger can hold more. */
    connectedAccounts: number;
  };
  receivables: {
    /** The AR accounts' balance in the ledger. */
    total: number;
    /** What the open finalized statements add up to — the same number the aging card shows. */
    openOnStatements: number;
    /** Open finalized statements by age past due: current (not yet due), 1–30, 31–60, 61–90, over 90. */
    aging: { current: number; days1to30: number; days31to60: number; days61to90: number; over90: number };
    topClients: Array<{ clientId: string; name: string; open: number; oldestDueAt: string | null }>;
    /** Statements marked paid with no payment in the books: the books still count them as owed (MONEY-3). */
    markedPaidWithoutPayment?: { count: number; amount: number };
    /** Finalized statements receivables in the books doesn't hold yet. */
    notInBooks?: { count: number; amount: number };
  };
  payables: { total: number; dueIn7Days: number; overdue: number; awaitingApproval: number };
  profit: {
    month: BooksPnlTotals;
    yearToDate: BooksPnlTotals;
    trend: Array<{ key: string; label: string; income: number; netIncome: number }>;
    /** Last month from its 1st to the same day of the month — what this month so far compares with (MONEY-19). */
    lastMonthToDate?: { from: string; to: string; totals: BooksPnlTotals };
  };
  close: { periodKey: string; status: 'OPEN' | 'CLOSED'; closedAt: string | null; tasksDone: number; tasksTotal: number };
  quickbooks: {
    connected: boolean;
    status: string | null;
    companyName: string | null;
    lastPushAt: string | null;
    lastPullAt: string | null;
    openConflicts: number;
    pending: number;
    failed: number;
  };
  needsYou: Array<{ key: string; label: string; count: number; to: string; tone: 'warning' | 'alert' | 'info' }>;
}
