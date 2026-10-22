import type { Prisma, PrismaClient } from '@prisma/client';
import { tenantIdForWrite } from '../tenant.js';

/**
 * The starting chart of accounts for a staffing company — every account the
 * automatic posting needs, named by a systemKey so the posting code never
 * depends on a code or a name the accountant may change. Seeded once per
 * tenant (ensureChart); after that the chart is the company's to edit.
 *
 * Direct labor (associates placed at clients) is a cost of services, so
 * gross margin reads true; internal staff wages are operating expenses.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'EXPENSE';

export interface ChartSeed {
  code: string;
  name: string;
  type: AccountType;
  subtype: string;
  systemKey: string;
  description?: string;
}

export const DEFAULT_CHART: readonly ChartSeed[] = [
  // Assets
  { code: '1000', name: 'Operating checking', type: 'ASSET', subtype: 'BANK', systemKey: 'CASH_OPERATING', description: 'Where client payments land and bills are paid from.' },
  { code: '1010', name: 'Payroll checking', type: 'ASSET', subtype: 'BANK', systemKey: 'CASH_PAYROLL', description: 'Funded before each payroll; paychecks and tax deposits leave from here.' },
  { code: '1050', name: 'Undeposited funds', type: 'ASSET', subtype: 'CURRENT_ASSET', systemKey: 'UNDEPOSITED', description: 'Checks received and not yet deposited.' },
  { code: '1100', name: 'Accounts receivable', type: 'ASSET', subtype: 'AR', systemKey: 'AR', description: 'Finalized client statements not yet paid.' },
  { code: '1200', name: 'Prepaid expenses', type: 'ASSET', subtype: 'CURRENT_ASSET', systemKey: 'PREPAID' },
  { code: '1300', name: 'Employee advances', type: 'ASSET', subtype: 'CURRENT_ASSET', systemKey: 'EMPLOYEE_ADVANCES', description: 'Earned-wage advances paid out before payday, recovered from the paycheck.' },
  { code: '1500', name: 'Vehicles', type: 'ASSET', subtype: 'FIXED_ASSET', systemKey: 'FA_VEHICLES' },
  { code: '1510', name: 'Equipment', type: 'ASSET', subtype: 'FIXED_ASSET', systemKey: 'FA_EQUIPMENT' },
  { code: '1520', name: 'Computers and software', type: 'ASSET', subtype: 'FIXED_ASSET', systemKey: 'FA_COMPUTERS' },
  { code: '1530', name: 'Leasehold improvements', type: 'ASSET', subtype: 'FIXED_ASSET', systemKey: 'FA_LEASEHOLD' },
  { code: '1590', name: 'Accumulated depreciation', type: 'ASSET', subtype: 'ACCUMULATED_DEPRECIATION', systemKey: 'ACCUM_DEPRECIATION' },
  // Liabilities
  { code: '2000', name: 'Accounts payable', type: 'LIABILITY', subtype: 'AP', systemKey: 'AP', description: 'Approved vendor bills not yet paid.' },
  { code: '2050', name: 'Company credit card', type: 'LIABILITY', subtype: 'CREDIT_CARD', systemKey: 'CREDIT_CARD' },
  { code: '2100', name: 'Net pay payable', type: 'LIABILITY', subtype: 'PAYROLL_LIABILITY', systemKey: 'NET_PAY_PAYABLE', description: 'Paychecks approved and not yet paid out.' },
  { code: '2110', name: 'Federal income tax withheld', type: 'LIABILITY', subtype: 'TAX_LIABILITY', systemKey: 'FIT_PAYABLE' },
  { code: '2120', name: 'Social Security and Medicare payable', type: 'LIABILITY', subtype: 'TAX_LIABILITY', systemKey: 'FICA_PAYABLE', description: 'Employee and employer halves.' },
  { code: '2130', name: 'State income tax withheld', type: 'LIABILITY', subtype: 'TAX_LIABILITY', systemKey: 'SIT_PAYABLE' },
  { code: '2140', name: 'Local taxes payable', type: 'LIABILITY', subtype: 'TAX_LIABILITY', systemKey: 'LOCAL_TAX_PAYABLE' },
  { code: '2150', name: 'Federal unemployment payable', type: 'LIABILITY', subtype: 'TAX_LIABILITY', systemKey: 'FUTA_PAYABLE' },
  { code: '2160', name: 'State unemployment and programs payable', type: 'LIABILITY', subtype: 'TAX_LIABILITY', systemKey: 'SUTA_PAYABLE', description: 'SUTA, state disability and paid-leave programs.' },
  { code: '2200', name: 'Benefit deductions payable', type: 'LIABILITY', subtype: 'PAYROLL_LIABILITY', systemKey: 'BENEFITS_PAYABLE' },
  { code: '2210', name: 'Retirement contributions payable', type: 'LIABILITY', subtype: 'PAYROLL_LIABILITY', systemKey: 'RETIREMENT_PAYABLE' },
  { code: '2220', name: 'Garnishments payable', type: 'LIABILITY', subtype: 'PAYROLL_LIABILITY', systemKey: 'GARNISHMENTS_PAYABLE' },
  { code: '2230', name: 'Other payroll deductions payable', type: 'LIABILITY', subtype: 'PAYROLL_LIABILITY', systemKey: 'DEDUCTIONS_PAYABLE' },
  { code: '2250', name: 'Sales tax payable', type: 'LIABILITY', subtype: 'CURRENT_LIABILITY', systemKey: 'SALES_TAX_PAYABLE', description: 'Sales tax billed on client statements, owed to the state.' },
  { code: '2300', name: 'Accrued expenses', type: 'LIABILITY', subtype: 'CURRENT_LIABILITY', systemKey: 'ACCRUED_EXPENSES' },
  { code: '2310', name: 'Accrued wages', type: 'LIABILITY', subtype: 'CURRENT_LIABILITY', systemKey: 'ACCRUED_WAGES' },
  { code: '2500', name: 'Loans payable', type: 'LIABILITY', subtype: 'LONG_TERM_LIABILITY', systemKey: 'LOANS_PAYABLE' },
  // Equity
  { code: '3000', name: 'Owner’s equity', type: 'EQUITY', subtype: 'EQUITY', systemKey: 'OWNER_EQUITY' },
  { code: '3100', name: 'Retained earnings', type: 'EQUITY', subtype: 'RETAINED_EARNINGS', systemKey: 'RETAINED_EARNINGS' },
  { code: '3200', name: 'Opening balance equity', type: 'EQUITY', subtype: 'EQUITY', systemKey: 'OPENING_BALANCE' },
  // Income
  { code: '4000', name: 'Staffing services revenue', type: 'INCOME', subtype: 'INCOME', systemKey: 'REVENUE_STAFFING', description: 'Client statements, by client.' },
  { code: '4100', name: 'Billing adjustments', type: 'INCOME', subtype: 'INCOME', systemKey: 'REVENUE_ADJUSTMENTS', description: 'Credits and rebills on client statements.' },
  { code: '4200', name: 'Transportation income', type: 'INCOME', subtype: 'OTHER_INCOME', systemKey: 'REVENUE_TRANSPORT', description: 'Van ride fares and no-show fees taken from pay.' },
  { code: '4900', name: 'Other income', type: 'INCOME', subtype: 'OTHER_INCOME', systemKey: 'OTHER_INCOME' },
  { code: '4950', name: 'Uncategorized income', type: 'INCOME', subtype: 'OTHER_INCOME', systemKey: 'UNCATEGORIZED_INCOME' },
  // Cost of services
  { code: '5000', name: 'Direct labor wages', type: 'EXPENSE', subtype: 'COST_OF_SERVICES', systemKey: 'WAGES_DIRECT', description: 'Gross pay of associates working at clients.' },
  { code: '5010', name: 'Direct labor employer taxes', type: 'EXPENSE', subtype: 'COST_OF_SERVICES', systemKey: 'EMPLOYER_TAX_DIRECT' },
  { code: '5020', name: 'Direct labor benefits', type: 'EXPENSE', subtype: 'COST_OF_SERVICES', systemKey: 'BENEFITS_DIRECT' },
  { code: '5030', name: 'Workers’ compensation insurance', type: 'EXPENSE', subtype: 'COST_OF_SERVICES', systemKey: 'WORKERS_COMP' },
  { code: '5100', name: 'Contractor payments', type: 'EXPENSE', subtype: 'COST_OF_SERVICES', systemKey: 'CONTRACTORS_DIRECT' },
  // Operating expenses
  { code: '6000', name: 'Staff wages', type: 'EXPENSE', subtype: 'EXPENSE', systemKey: 'WAGES_INTERNAL', description: 'Gross pay of the company’s own staff.' },
  { code: '6010', name: 'Staff employer taxes', type: 'EXPENSE', subtype: 'EXPENSE', systemKey: 'EMPLOYER_TAX_INTERNAL' },
  { code: '6100', name: 'Rent', type: 'EXPENSE', subtype: 'EXPENSE', systemKey: 'RENT' },
  { code: '6110', name: 'Utilities', type: 'EXPENSE', subtype: 'EXPENSE', systemKey: 'UTILITIES' },
  { code: '6200', name: 'Vehicle fuel', type: 'EXPENSE', subtype: 'EXPENSE', systemKey: 'FUEL' },
  { code: '6210', name: 'Vehicle repairs and maintenance', type: 'EXPENSE', subtype: 'EXPENSE', systemKey: 'VEHICLE_MAINTENANCE' },
  { code: '6220', name: 'Vehicle insurance', type: 'EXPENSE', subtype: 'EXPENSE', systemKey: 'VEHICLE_INSURANCE' },
  { code: '6300', name: 'Insurance', type: 'EXPENSE', subtype: 'EXPENSE', systemKey: 'INSURANCE' },
  { code: '6400', name: 'Software and subscriptions', type: 'EXPENSE', subtype: 'EXPENSE', systemKey: 'SOFTWARE' },
  { code: '6500', name: 'Professional fees', type: 'EXPENSE', subtype: 'EXPENSE', systemKey: 'PROFESSIONAL_FEES' },
  { code: '6600', name: 'Advertising and recruiting', type: 'EXPENSE', subtype: 'EXPENSE', systemKey: 'ADVERTISING' },
  { code: '6700', name: 'Office supplies', type: 'EXPENSE', subtype: 'EXPENSE', systemKey: 'OFFICE_SUPPLIES' },
  { code: '6800', name: 'Bank and payment fees', type: 'EXPENSE', subtype: 'EXPENSE', systemKey: 'BANK_FEES' },
  { code: '6850', name: 'Employee reimbursements', type: 'EXPENSE', subtype: 'EXPENSE', systemKey: 'REIMBURSEMENTS' },
  { code: '6900', name: 'Depreciation', type: 'EXPENSE', subtype: 'EXPENSE', systemKey: 'DEPRECIATION_EXPENSE' },
  { code: '6950', name: 'Uncategorized expense', type: 'EXPENSE', subtype: 'EXPENSE', systemKey: 'UNCATEGORIZED_EXPENSE' },
  { code: '7000', name: 'Interest expense', type: 'EXPENSE', subtype: 'OTHER_EXPENSE', systemKey: 'INTEREST_EXPENSE' },
  { code: '7100', name: 'Gain or loss on asset disposal', type: 'EXPENSE', subtype: 'OTHER_EXPENSE', systemKey: 'ASSET_DISPOSAL_GAIN_LOSS' },
];

/** Debit-normal types grow with debits; the rest with credits. */
export const DEBIT_NORMAL: ReadonlySet<AccountType> = new Set(['ASSET', 'EXPENSE']);

/**
 * Seed the default chart for the tenant in context, once. Accounts that
 * already exist (by systemKey or code) are left exactly as the accountant
 * made them; a systemKey added in a later release is filled in.
 */
export async function ensureChart(db: Db): Promise<number> {
  const tenantId = tenantIdForWrite();
  const existing = await db.ledgerAccount.findMany({ where: { tenantId }, select: { code: true, systemKey: true } });
  const keys = new Set(existing.map((a) => a.systemKey).filter(Boolean));
  const codes = new Set(existing.map((a) => a.code));
  const missing = DEFAULT_CHART.filter((a) => !keys.has(a.systemKey));
  const rows: Prisma.LedgerAccountCreateManyInput[] = [];
  for (const a of missing) {
    // A code the accountant already used for something else: the next free one in the hundred.
    let code = a.code;
    for (let n = Number(a.code); codes.has(code) && n < Number(a.code) + 99; n++) code = String(n + 1);
    rows.push({ tenantId, code, name: a.name, type: a.type, subtype: a.subtype, systemKey: a.systemKey, description: a.description ?? null });
    codes.add(code);
  }
  if (rows.length === 0) return 0;
  // Two first requests at once both see an empty chart: whichever lands
  // second skips what the first made instead of failing on the unique key.
  const made = await db.ledgerAccount.createMany({ data: rows, skipDuplicates: true });
  return made.count;
}
