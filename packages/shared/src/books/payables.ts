import { z } from 'zod';

/**
 * The books — payables: vendors, bills, the second person who approves a
 * bill before it's owed, payments, recurring bills, AP aging and vendor
 * 1099s. API: apps/api/src/routes/books/payables.ts (mounted at /books).
 *
 *   GET    /books/vendors?q&active                  → { vendors: BooksVendor[] }
 *   POST   /books/vendors                            BooksVendorInput → { vendor }
 *   GET    /books/vendors/:id                        → { vendor, bills, payments }
 *   PATCH  /books/vendors/:id                        BooksVendorUpdate → { vendor } | 202 pending (bank change)
 *   GET    /books/bills?status&vendorId&tab          → { bills: BooksBill[] }
 *   POST   /books/bills                              BooksBillInput → { bill }        (DRAFT)
 *   GET    /books/bills/:id                          → { bill }
 *   PATCH  /books/bills/:id                          BooksBillInput → { bill }        (DRAFT only)
 *   POST   /books/bills/:id/submit                   → 202 { pending, approvalId }    (BILL_APPROVAL)
 *   POST   /books/bills/approve                      { ids } → BooksBillsApproveResult (each still second-person)
 *   POST   /books/bills/:id/withdraw                 → { bill }                       (back to DRAFT)
 *   POST   /books/bills/:id/reopen                   { reason } → { bill }            (APPROVED, unpaid → DRAFT; entry voided)
 *   POST   /books/bills/:id/void                     { reason } → { bill }
 *   POST   /books/bills/:id/attachment               multipart file → { bill }
 *   GET    /books/bills/:id/attachment               → the invoice file
 *   GET    /books/bill-payments?vendorId             → { payments: BooksBillPayment[] }
 *   POST   /books/bill-payments                      BooksBillPaymentInput → { payment }
 *   POST   /books/bill-payments/batch                BooksBillPaymentBatchInput → { payments, cashAfter } (finance walk 8)
 *   POST   /books/bill-payments/:id/void             { reason } → { payment }
 *   GET    /books/bank-sources                       → { accounts: BooksPayFromAccount[], ownAch: boolean }
 *   GET    /books/payables/options                   → BooksPayablesOptions (the forms' pickers)
 *   GET    /books/recurring-bills                    → { recurring: BooksRecurringBill[] }
 *   POST   /books/recurring-bills                    BooksRecurringBillInput → { recurring }
 *   PATCH  /books/recurring-bills/:id                Partial<BooksRecurringBillInput> & { isActive? } → { recurring }
 *   GET    /books/payables/aging?asOf                → BooksApAging
 *   GET    /books/payables/1099?year[&format=csv]    → BooksVendor1099Report
 */

const Ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Money = z.number().finite();

export const BooksVendorPaymentMethodSchema = z.enum(['ACH', 'CHECK', 'CARD', 'OTHER']);
export type BooksVendorPaymentMethod = z.infer<typeof BooksVendorPaymentMethodSchema>;

export const BooksVendorSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  addressLine1: z.string().nullable(),
  addressLine2: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  zip: z.string().nullable(),
  is1099: z.boolean(),
  hasTaxId: z.boolean(),
  taxIdLast4: z.string().nullable(),
  defaultExpenseAccountId: z.string().nullable(),
  defaultExpenseAccountName: z.string().nullable(),
  paymentMethod: BooksVendorPaymentMethodSchema,
  hasBank: z.boolean(),
  accountLast4: z.string().nullable(),
  termsDays: z.number().int(),
  notes: z.string().nullable(),
  isActive: z.boolean(),
  /** Open bills owed (approved, not yet paid). */
  balance: Money,
  /** Paid to this vendor this calendar year, every method, voids left out. */
  paidThisYear: Money,
  /** The newest payment's date, voids left out; null when never paid. */
  lastPaidOn: Ymd.nullable(),
  /** A change to the bank details waiting on a second person. */
  pendingBankChange: z.object({ approvalId: z.string(), accountLast4: z.string(), requestedAt: z.string(), requestedByName: z.string().nullable() }).nullable(),
  createdAt: z.string(),
});
export type BooksVendor = z.infer<typeof BooksVendorSchema>;

export const BooksVendorInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  email: z.string().trim().email().max(200).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  addressLine1: z.string().trim().max(200).nullable().optional(),
  addressLine2: z.string().trim().max(200).nullable().optional(),
  city: z.string().trim().max(100).nullable().optional(),
  state: z.string().trim().length(2).nullable().optional(),
  zip: z.string().trim().max(10).nullable().optional(),
  is1099: z.boolean().optional(),
  /** EIN or SSN, digits only (9). Stored encrypted; only the last 4 come back. */
  taxId: z.string().trim().regex(/^\d{9}$/, 'A tax ID is 9 digits.').nullable().optional(),
  defaultExpenseAccountId: z.string().uuid().nullable().optional(),
  paymentMethod: BooksVendorPaymentMethodSchema.optional(),
  routingNumber: z.string().trim().regex(/^\d{9}$/, 'A routing number is 9 digits.').optional(),
  accountNumber: z.string().trim().min(4).max(17).optional(),
  termsDays: z.number().int().min(0).max(365).optional(),
  notes: z.string().max(1000).nullable().optional(),
});
export type BooksVendorInput = z.infer<typeof BooksVendorInputSchema>;

export const BooksVendorUpdateSchema = BooksVendorInputSchema.partial().extend({ isActive: z.boolean().optional() });
export type BooksVendorUpdate = z.infer<typeof BooksVendorUpdateSchema>;

export const BooksBillStatusSchema = z.enum(['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PARTIALLY_PAID', 'PAID', 'VOID']);
export type BooksBillStatus = z.infer<typeof BooksBillStatusSchema>;

export const BooksBillLineInputSchema = z.object({
  accountId: z.string().uuid(),
  description: z.string().trim().max(300).nullable().optional(),
  amount: z.number().positive().max(100_000_000),
  clientId: z.string().uuid().nullable().optional(),
  siteId: z.string().uuid().nullable().optional(),
  departmentId: z.string().uuid().nullable().optional(),
  costCenterId: z.string().uuid().nullable().optional(),
});
export type BooksBillLineInput = z.infer<typeof BooksBillLineInputSchema>;

export const BooksBillInputSchema = z.object({
  vendorId: z.string().uuid(),
  billNumber: z.string().trim().max(60).nullable().optional(),
  billDate: Ymd,
  /** Defaults to billDate + the vendor's terms. */
  dueDate: Ymd.nullable().optional(),
  memo: z.string().trim().max(500).nullable().optional(),
  lines: z.array(BooksBillLineInputSchema).min(1).max(100),
});
export type BooksBillInput = z.infer<typeof BooksBillInputSchema>;

export const BooksBillLineSchema = z.object({
  id: z.string(),
  lineNo: z.number().int(),
  accountId: z.string(),
  accountCode: z.string(),
  accountName: z.string(),
  description: z.string().nullable(),
  amount: Money,
  clientId: z.string().nullable(),
  clientName: z.string().nullable(),
  siteId: z.string().nullable(),
  departmentId: z.string().nullable(),
  costCenterId: z.string().nullable(),
});
export type BooksBillLine = z.infer<typeof BooksBillLineSchema>;

export const BooksBillSchema = z.object({
  id: z.string(),
  vendorId: z.string(),
  vendorName: z.string(),
  billNumber: z.string().nullable(),
  billDate: Ymd,
  dueDate: Ymd,
  status: BooksBillStatusSchema,
  total: Money,
  balance: Money,
  memo: z.string().nullable(),
  hasAttachment: z.boolean(),
  attachmentName: z.string().nullable(),
  /** Days past due today (negative: due in that many days). */
  daysPastDue: z.number().int(),
  approval: z
    .object({
      id: z.string(),
      status: z.string(),
      requesterName: z.string().nullable(),
      decidedByName: z.string().nullable(),
      reason: z.string().nullable(),
      mayDecide: z.boolean(),
      createdAt: z.string(),
    })
    .nullable(),
  approvedAt: z.string().nullable(),
  approvedByName: z.string().nullable(),
  journalEntryId: z.string().nullable(),
  journalEntryNumber: z.number().int().nullable(),
  recurringName: z.string().nullable(),
  lines: z.array(BooksBillLineSchema),
  payments: z.array(z.object({ paymentId: z.string(), paidOn: Ymd, method: z.string(), amount: Money, reference: z.string().nullable(), status: z.string() })),
  createdByName: z.string().nullable(),
  createdAt: z.string(),
});
export type BooksBill = z.infer<typeof BooksBillSchema>;

/**
 * Approve several bills at once (Bills → To approve → "Approve selected").
 * Each is its own decision on its own approval — still never by the person
 * who entered it: those come back skipped, with why.
 */
export const BooksBillsApproveInputSchema = z.object({ ids: z.array(z.string().uuid()).min(1).max(100) });
export interface BooksBillsApproveResult {
  approved: Array<{ id: string; total: number; vendorName: string }>;
  skipped: Array<{ id: string; reason: string }>;
}

export const BooksBillPaymentInputSchema = z.object({
  vendorId: z.string().uuid(),
  paidOn: Ymd,
  method: BooksVendorPaymentMethodSchema,
  /** The BANK or CREDIT_CARD ledger account it comes out of. */
  bankAccountId: z.string().uuid(),
  reference: z.string().trim().max(80).nullable().optional(),
  checkNumber: z.number().int().positive().nullable().optional(),
  /** Send it over the company's own ACH to the vendor's bank (method ACH only). */
  sendAch: z.boolean().optional(),
  applications: z.array(z.object({ billId: z.string().uuid(), amount: z.number().positive() })).min(1).max(200),
});
export type BooksBillPaymentInput = z.infer<typeof BooksBillPaymentInputSchema>;

/**
 * Finance walk 8 — pay several vendors in one run: the same date, method and
 * account for all, each vendor's bills applied in full or in part. One
 * transaction: every vendor's payment lands, or none does.
 */
export const BooksBillPaymentBatchInputSchema = z.object({
  paidOn: Ymd,
  method: BooksVendorPaymentMethodSchema,
  bankAccountId: z.string().uuid(),
  sendAch: z.boolean().optional(),
  vendors: z
    .array(
      z.object({
        vendorId: z.string().uuid(),
        reference: z.string().trim().max(80).nullable().optional(),
        checkNumber: z.number().int().positive().nullable().optional(),
        applications: z.array(z.object({ billId: z.string().uuid(), amount: z.number().positive() })).min(1).max(200),
      }),
    )
    .min(1)
    .max(100),
});
export type BooksBillPaymentBatchInput = z.infer<typeof BooksBillPaymentBatchInputSchema>;

export const BooksBillPaymentSchema = z.object({
  id: z.string(),
  vendorId: z.string(),
  vendorName: z.string(),
  paidOn: Ymd,
  method: BooksVendorPaymentMethodSchema,
  amount: Money,
  bankAccountId: z.string(),
  bankAccountName: z.string(),
  reference: z.string().nullable(),
  checkNumber: z.number().int().nullable(),
  /** SCHEDULED | SENT | CLEARED | VOID */
  status: z.string(),
  achFileId: z.string().nullable(),
  journalEntryId: z.string().nullable(),
  applications: z.array(z.object({ billId: z.string(), billNumber: z.string().nullable(), amount: Money })),
  createdAt: z.string(),
});
export type BooksBillPayment = z.infer<typeof BooksBillPaymentSchema>;

export const BooksPayFromAccountSchema = z.object({ id: z.string(), code: z.string(), name: z.string(), subtype: z.string() });
export type BooksPayFromAccount = z.infer<typeof BooksPayFromAccountSchema>;

export const BooksRecurringFrequencySchema = z.enum(['WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY']);
export type BooksRecurringFrequency = z.infer<typeof BooksRecurringFrequencySchema>;

export const BooksRecurringBillInputSchema = z.object({
  vendorId: z.string().uuid(),
  name: z.string().trim().min(1).max(160),
  frequency: BooksRecurringFrequencySchema,
  nextDate: Ymd,
  endDate: Ymd.nullable().optional(),
  memo: z.string().trim().max(500).nullable().optional(),
  lines: z.array(BooksBillLineInputSchema).min(1).max(50),
  /** Send each new bill straight to approval instead of leaving it a draft. */
  autoSubmit: z.boolean().optional(),
});
export type BooksRecurringBillInput = z.infer<typeof BooksRecurringBillInputSchema>;

export const BooksRecurringBillSchema = z.object({
  id: z.string(),
  vendorId: z.string(),
  vendorName: z.string(),
  name: z.string(),
  frequency: BooksRecurringFrequencySchema,
  nextDate: Ymd,
  endDate: Ymd.nullable(),
  memo: z.string().nullable(),
  amount: Money,
  lines: z.array(BooksBillLineInputSchema),
  autoSubmit: z.boolean(),
  isActive: z.boolean(),
  billsMade: z.number().int(),
});
export type BooksRecurringBill = z.infer<typeof BooksRecurringBillSchema>;

export const BooksApAgingRowSchema = z.object({
  vendorId: z.string(),
  vendorName: z.string(),
  current: Money,
  days1to30: Money,
  days31to60: Money,
  days61to90: Money,
  over90: Money,
  total: Money,
  bills: z.number().int(),
});
export type BooksApAgingRow = z.infer<typeof BooksApAgingRowSchema>;

export const BooksApAgingSchema = z.object({
  asOf: Ymd,
  rows: z.array(BooksApAgingRowSchema),
  totals: BooksApAgingRowSchema.omit({ vendorId: true, vendorName: true }),
});
export type BooksApAging = z.infer<typeof BooksApAgingSchema>;

export const BooksVendor1099RowSchema = z.object({
  vendorId: z.string(),
  name: z.string(),
  hasTaxId: z.boolean(),
  taxIdLast4: z.string().nullable(),
  address: z.string().nullable(),
  /** Paid in the year by cash, check or ACH (card payments are reported on the card network's 1099-K). */
  total: Money,
  cardTotal: Money,
  payments: z.number().int(),
  needs1099: z.boolean(),
  /** What's missing before the form can be filed. */
  missing: z.array(z.string()),
});
export type BooksVendor1099Row = z.infer<typeof BooksVendor1099RowSchema>;

export const BooksVendor1099ReportSchema = z.object({
  year: z.number().int(),
  threshold: Money,
  rows: z.array(BooksVendor1099RowSchema),
});
export type BooksVendor1099Report = z.infer<typeof BooksVendor1099ReportSchema>;

export const BooksPayablesOptionsSchema = z.object({
  accounts: z.array(z.object({ id: z.string(), code: z.string(), name: z.string(), type: z.string(), subtype: z.string() })),
  payFrom: z.array(BooksPayFromAccountSchema),
  clients: z.array(z.object({ id: z.string(), name: z.string() })),
  sites: z.array(z.object({ id: z.string(), name: z.string(), clientId: z.string().nullable() })),
  ownAch: z.boolean(),
  /** The Books cash position today (bank balances less cards); null when the books hold no bank account yet. */
  cashOnHand: z.number().nullable().optional(),
});
export type BooksPayablesOptions = z.infer<typeof BooksPayablesOptionsSchema>;
