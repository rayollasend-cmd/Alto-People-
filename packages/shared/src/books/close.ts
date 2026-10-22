import { z } from 'zod';

/**
 * The books — the month-end close, budgets and fixed assets.
 *
 *   GET    /books/close                                   → CloseListResponse (the last 12 months + the current)
 *   GET    /books/close/:periodKey                        → ClosePeriodDetail (the month and its checklist, auto checks live)
 *   POST   /books/close/:periodKey/tasks/:key             CloseTaskUpdateInput → ClosePeriodDetail (manage:books)
 *   POST   /books/close/:periodKey/ready                  → ClosePeriodDetail (the preparer; every task done or skipped)
 *   POST   /books/close/:periodKey/unready                → ClosePeriodDetail (the preparer takes it back)
 *   POST   /books/close/:periodKey/sign-off               → ClosePeriodDetail (a SECOND manage:books holder → CLOSED)
 *   POST   /books/close/:periodKey/reopen                 CloseReopenInput → 202 pending (a PERIOD_REOPEN approval)
 *   GET    /books/close/:periodKey/accruals               → CloseAccrualsResponse
 *   POST   /books/close/accruals                          AccrualCreateInput → { entryId } (manage:books)
 *
 *   GET    /books/budgets                                 → BudgetListResponse
 *   POST   /books/budgets                                 BudgetCreateInput → { budget: BudgetDetail }
 *   GET    /books/budgets/:id                             → { budget: BudgetDetail }
 *   PATCH  /books/budgets/:id                             BudgetUpdateInput → { budget: BudgetDetail }
 *   DELETE /books/budgets/:id                             (a DRAFT only)
 *   PUT    /books/budgets/:id/lines                       BudgetLinesInput → { budget: BudgetDetail } (the whole grid)
 *   POST   /books/budgets/:id/from-actuals                BudgetFromActualsInput → { budget: BudgetDetail }
 *   GET    /books/budgets/:id/vs-actual?through=YYYY-MM   → BudgetVsActual
 *   GET    /books/budgets/:id/vs-actual.xlsx?through=     the same as a workbook
 *
 *   GET    /books/assets                                  → FixedAssetListResponse (the register + suggestions)
 *   POST   /books/assets                                  FixedAssetCreateInput → { asset: FixedAssetDetail }
 *   GET    /books/assets/:id                              → { asset: FixedAssetDetail }
 *   PATCH  /books/assets/:id                              FixedAssetUpdateInput → { asset: FixedAssetDetail }
 *   POST   /books/assets/:id/dispose                      FixedAssetDisposeInput → { asset: FixedAssetDetail }
 *   POST   /books/assets/depreciation/run?through=YYYY-MM → DepreciationRunResult (manage:books)
 */

const Ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const PeriodKey = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const Id = z.string().uuid();

/* ---- Close --------------------------------------------------------------- */

export type CloseTaskStatus = 'OPEN' | 'DONE' | 'SKIPPED';
export type ClosePeriodStatus = 'OPEN' | 'READY' | 'CLOSED';

export interface CloseCheckItem {
  label: string;
  link: string | null;
}

/** A step done from the checklist itself (finance walk 16): one click, no page change. */
export interface CloseTaskAction {
  kind: 'finalize_statements' | 'post_history';
  label: string;
}

export interface CloseTaskView {
  key: string;
  title: string;
  detail: string | null;
  /** Checked by the books themselves (bank reconciled, nothing left to post …) — not ticked by hand. */
  auto: boolean;
  status: CloseTaskStatus;
  /** For an auto task: does the check pass right now. */
  passing: boolean | null;
  /** What the check found ("2 accounts not reconciled through Oct 31"). */
  summary: string | null;
  /** What's left, each with where to fix it. */
  items: CloseCheckItem[];
  /** Where the whole task is done. */
  link: string | null;
  /** The step's own button, when it can be done right here. */
  action?: CloseTaskAction | null;
  note: string | null;
  doneAt: string | null;
  doneByName: string | null;
}

export interface CloseMonthSummary {
  periodKey: string;
  label: string;
  status: ClosePeriodStatus;
  tasksTotal: number;
  tasksDone: number;
  preparedByName: string | null;
  signedOffByName: string | null;
  closedAt: string | null;
  reopenedAt: string | null;
  /** The month has ended (a close is due). */
  ended: boolean;
  pendingReopen: boolean;
}

export interface CloseListResponse {
  months: CloseMonthSummary[];
  /** The month after the last one closed (with nothing closed yet, last month). */
  nextToClose: string | null;
}

export interface CloseLiabilityRow {
  accountId: string;
  code: string;
  name: string;
  balance: number;
}

export interface ClosePeriodDetail extends CloseMonthSummary {
  tasks: CloseTaskView[];
  preparedById: string | null;
  signedOffById: string | null;
  signedOffAt: string | null;
  reopenReason: string | null;
  /** Payroll and tax liability balances at month end — the "liabilities tie to deposits" task shows them. */
  liabilities: CloseLiabilityRow[];
  /** Can the caller press each button, and if not, why. */
  can: {
    edit: boolean;
    ready: boolean;
    unready: boolean;
    signOff: boolean;
    reopen: boolean;
    why: string | null;
  };
}

export const CloseTaskUpdateInputSchema = z.object({
  status: z.enum(['OPEN', 'DONE', 'SKIPPED']),
  note: z.string().trim().max(1000).nullable().optional(),
});
export type CloseTaskUpdateInput = z.infer<typeof CloseTaskUpdateInputSchema>;

export const CloseReopenInputSchema = z.object({ reason: z.string().trim().min(5).max(500) });
export type CloseReopenInput = z.infer<typeof CloseReopenInputSchema>;

export interface CloseAccrualRow {
  entryId: string;
  number: number;
  date: string;
  memo: string | null;
  amount: number;
  reverseOn: string | null;
  reversedEntryId: string | null;
  reversedOn: string | null;
}

export interface CloseAccrualsResponse {
  periodKey: string;
  accruals: CloseAccrualRow[];
}

export const AccrualCreateInputSchema = z.object({
  date: Ymd,
  memo: z.string().trim().min(1).max(500),
  /** Defaults to the first day of the next month. */
  reverseOn: Ymd.optional(),
  lines: z
    .array(
      z.object({
        account: z.string().min(1).max(64),
        debit: z.number().nonnegative().optional(),
        credit: z.number().nonnegative().optional(),
        memo: z.string().max(300).nullable().optional(),
        clientId: Id.nullable().optional(),
        departmentId: Id.nullable().optional(),
      }),
    )
    .min(2)
    .max(100),
});
export type AccrualCreateInput = z.infer<typeof AccrualCreateInputSchema>;

/* ---- Budgets ------------------------------------------------------------- */

export type BudgetStatus = 'DRAFT' | 'ACTIVE' | 'ARCHIVED';

export interface BudgetSummary {
  id: string;
  name: string;
  fiscalYear: number;
  status: BudgetStatus;
  notes: string | null;
  totalIncome: number;
  totalExpense: number;
  net: number;
  lineCount: number;
  updatedAt: string;
}

export interface BudgetListResponse {
  budgets: BudgetSummary[];
}

export interface BudgetLineView {
  accountId: string;
  clientId: string | null;
  departmentId: string | null;
  /** 12 amounts, January → December of the fiscal year. */
  months: number[];
  total: number;
}

export interface BudgetAccountOption {
  id: string;
  code: string;
  name: string;
  type: string;
  subtype: string;
}

export interface BudgetDetail extends BudgetSummary {
  /** YYYY-MM of each of the 12 months, in order. */
  periods: string[];
  lines: BudgetLineView[];
  /** The income and expense accounts a line can use. */
  accounts: BudgetAccountOption[];
}

export const BudgetCreateInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  fiscalYear: z.number().int().min(2000).max(2100),
  notes: z.string().max(1000).nullable().optional(),
  /** Start the grid from the year before's actuals, grown by this %. */
  fromActuals: z.object({ growthPct: z.number().min(-100).max(1000) }).optional(),
});
export type BudgetCreateInput = z.infer<typeof BudgetCreateInputSchema>;

export const BudgetUpdateInputSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  notes: z.string().max(1000).nullable().optional(),
  status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']).optional(),
});
export type BudgetUpdateInput = z.infer<typeof BudgetUpdateInputSchema>;

export const BudgetLinesInputSchema = z.object({
  lines: z
    .array(
      z.object({
        accountId: Id,
        clientId: Id.nullable().optional(),
        departmentId: Id.nullable().optional(),
        /** 12 monthly amounts, or an annual amount spread evenly. */
        months: z.array(z.number().finite()).length(12).optional(),
        annual: z.number().finite().optional(),
      }),
    )
    .max(2000),
});
export type BudgetLinesInput = z.infer<typeof BudgetLinesInputSchema>;

export const BudgetFromActualsInputSchema = z.object({ growthPct: z.number().min(-100).max(1000).default(0) });
export type BudgetFromActualsInput = z.infer<typeof BudgetFromActualsInputSchema>;

export interface BudgetVsActualCell {
  budget: number;
  actual: number;
  variance: number;
  /** variance / budget, as a percentage; null without a budget. */
  variancePct: number | null;
}

export interface BudgetVsActualRow {
  accountId: string;
  code: string;
  name: string;
  section: 'income' | 'costOfServices' | 'expenses' | 'otherIncome' | 'otherExpenses';
  /** Favorable when actual beats budget (more income, less cost). */
  months: BudgetVsActualCell[];
  ytd: BudgetVsActualCell & { favorable: boolean };
  annualBudget: number;
  /** Actual so far + the budget for the months left. */
  forecast: number;
  /** Actual so far, carried at its monthly pace to the year end. */
  runRate: number;
}

export interface BudgetVsActualSection {
  key: BudgetVsActualRow['section'];
  label: string;
  rows: BudgetVsActualRow[];
  ytd: BudgetVsActualCell;
  annualBudget: number;
  forecast: number;
  runRate: number;
}

export interface BudgetVsActual {
  budgetId: string;
  fiscalYear: number;
  through: string;
  periods: string[];
  /** How many of the 12 months are actuals. */
  monthsElapsed: number;
  sections: BudgetVsActualSection[];
  netIncome: { ytd: BudgetVsActualCell; annualBudget: number; forecast: number; runRate: number };
}

/* ---- Fixed assets -------------------------------------------------------- */

export type FixedAssetCategory = 'VEHICLE' | 'EQUIPMENT' | 'COMPUTERS' | 'LEASEHOLD' | 'FURNITURE' | 'OTHER';
export type FixedAssetMethod = 'STRAIGHT_LINE' | 'DECLINING_BALANCE';
export type FixedAssetStatus = 'ACTIVE' | 'FULLY_DEPRECIATED' | 'DISPOSED';

export const FIXED_ASSET_CATEGORY_LABELS: Record<FixedAssetCategory, string> = {
  VEHICLE: 'Vehicles',
  EQUIPMENT: 'Equipment',
  COMPUTERS: 'Computers and software',
  LEASEHOLD: 'Leasehold improvements',
  FURNITURE: 'Furniture and fixtures',
  OTHER: 'Other',
};

export interface FixedAssetSummary {
  id: string;
  name: string;
  category: FixedAssetCategory;
  status: FixedAssetStatus;
  method: FixedAssetMethod;
  acquiredOn: string;
  inServiceOn: string;
  cost: number;
  salvageValue: number;
  usefulLifeMonths: number;
  accumulated: number;
  netBookValue: number;
  /** This month's depreciation (or the next due). */
  monthlyDepreciation: number;
  lastPostedPeriod: string | null;
  /** Months that have ended and aren't posted yet. */
  duePeriods: number;
  assetId: string | null;
  vanId: string | null;
  linkedLabel: string | null;
}

export interface FixedAssetSuggestion {
  kind: 'VAN' | 'ASSET';
  id: string;
  label: string;
  cost: number | null;
  acquiredOn: string | null;
  category: FixedAssetCategory;
}

export interface FixedAssetListResponse {
  assets: FixedAssetSummary[];
  totals: { cost: number; accumulated: number; netBookValue: number; monthly: number };
  suggestions: FixedAssetSuggestion[];
}

export interface DepreciationScheduleRow {
  periodKey: string;
  amount: number;
  accumulated: number;
  netBookValue: number;
  posted: boolean;
  entryId: string | null;
  /** Posted after its month closed, into a later month. */
  postedLate: boolean;
}

export interface FixedAssetDetail extends FixedAssetSummary {
  assetAccountId: string;
  accumulatedAccountId: string;
  expenseAccountId: string;
  accounts: { asset: string; accumulated: string; expense: string };
  clientId: string | null;
  siteId: string | null;
  departmentId: string | null;
  notes: string | null;
  disposedOn: string | null;
  disposalProceeds: number | null;
  acquisitionEntryId: string | null;
  disposalEntryId: string | null;
  schedule: DepreciationScheduleRow[];
}

const FixedAssetFields = {
  name: z.string().trim().min(1).max(160),
  category: z.enum(['VEHICLE', 'EQUIPMENT', 'COMPUTERS', 'LEASEHOLD', 'FURNITURE', 'OTHER']),
  assetId: Id.nullable().optional(),
  vanId: Id.nullable().optional(),
  acquiredOn: Ymd,
  inServiceOn: Ymd.optional(),
  cost: z.number().positive().max(100_000_000),
  salvageValue: z.number().min(0).max(100_000_000).default(0),
  usefulLifeMonths: z.number().int().min(1).max(600),
  method: z.enum(['STRAIGHT_LINE', 'DECLINING_BALANCE']).default('STRAIGHT_LINE'),
  assetAccountId: Id.optional(),
  accumulatedAccountId: Id.optional(),
  expenseAccountId: Id.optional(),
  clientId: Id.nullable().optional(),
  siteId: Id.nullable().optional(),
  departmentId: Id.nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
};

export const FixedAssetCreateInputSchema = z
  .object({
    ...FixedAssetFields,
    /** Put it on the books now: debit the asset, credit this account (cash, a loan, AP). Omit when a bill already did. */
    acquisition: z.object({ creditAccountId: Id }).optional(),
  })
  .refine((v) => v.salvageValue <= v.cost, { message: 'Salvage value can’t be more than the cost.', path: ['salvageValue'] });
export type FixedAssetCreateInput = z.infer<typeof FixedAssetCreateInputSchema>;

export const FixedAssetUpdateInputSchema = z.object({
  name: FixedAssetFields.name.optional(),
  category: FixedAssetFields.category.optional(),
  notes: FixedAssetFields.notes,
  clientId: FixedAssetFields.clientId,
  siteId: FixedAssetFields.siteId,
  departmentId: FixedAssetFields.departmentId,
  /** Changing these is only allowed before any depreciation is posted. */
  salvageValue: z.number().min(0).max(100_000_000).optional(),
  usefulLifeMonths: z.number().int().min(1).max(600).optional(),
  method: z.enum(['STRAIGHT_LINE', 'DECLINING_BALANCE']).optional(),
});
export type FixedAssetUpdateInput = z.infer<typeof FixedAssetUpdateInputSchema>;

export const FixedAssetDisposeInputSchema = z.object({
  disposedOn: Ymd,
  proceeds: z.number().min(0).max(100_000_000).default(0),
  /** Where the proceeds went (cash). Required when proceeds > 0. */
  proceedsAccountId: Id.optional(),
  note: z.string().max(500).optional(),
});
export type FixedAssetDisposeInput = z.infer<typeof FixedAssetDisposeInputSchema>;

export interface DepreciationRunResult {
  through: string;
  posted: number;
  amount: number;
  /** Months posted into a later month because theirs was closed. */
  late: number;
  assets: number;
}


export const BOOKS_PERIOD_KEY = PeriodKey;
