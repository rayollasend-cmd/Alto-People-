import { z } from 'zod';

/**
 * The books — receivables: what clients owe (statements by age), the money
 * they pay and the statements it pays, and the catch-up that posts history.
 * Amounts are dollars.
 *
 *   GET    /books/receivables                 → ReceivablesAgingResponse (?asOf=YYYY-MM-DD)
 *   GET    /books/receivables/payments        → ClientPaymentListResponse (?clientId&includeUndone)
 *   POST   /books/receivables/payments        ClientPaymentInput → { payment: ClientPaymentRow }
 *   DELETE /books/receivables/payments/:id    { reason } → 204 (undo: off the books, statements open again)
 *   GET    /books/receivables/deposit-accounts → { accounts: ReceivablesDepositAccount[] }
 *   GET    /books/receivables/clients/:clientId → ClientReceivablesResponse
 *   POST   /books/receivables/backfill        → PostingBackfillResult (manage:books)
 *   GET    /books/receivables/gaps?period=YYYY-MM → { gaps: PostingGap[] }
 */

const Ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const AGING_BUCKET_KEYS = ['current', 'days1to30', 'days31to60', 'days61to90', 'over90'] as const;
export const AgingBucketSchema = z.enum(AGING_BUCKET_KEYS);
export type AgingBucketKey = z.infer<typeof AgingBucketSchema>;
export const AGING_BUCKET_LABELS: Record<AgingBucketKey, string> = {
  current: 'Not yet due',
  days1to30: '1–30 days',
  days31to60: '31–60 days',
  days61to90: '61–90 days',
  over90: 'Over 90 days',
};

const BucketsSchema = z.object({ current: z.number(), days1to30: z.number(), days31to60: z.number(), days61to90: z.number(), over90: z.number() });

export const ReceivableStatementSchema = z.object({
  statementId: z.string(),
  clientId: z.string(),
  clientName: z.string(),
  number: z.number().int().nullable(),
  periodStart: Ymd,
  periodEnd: Ymd,
  dueOn: Ymd,
  daysPastDue: z.number().int(),
  bucket: AgingBucketSchema,
  total: z.number(),
  applied: z.number(),
  open: z.number(),
});
export type ReceivableStatement = z.infer<typeof ReceivableStatementSchema>;

export const ReceivablesAgingRowSchema = z.object({
  clientId: z.string(),
  clientName: z.string(),
  buckets: BucketsSchema,
  open: z.number(),
  statements: z.number().int(),
  oldestDaysPastDue: z.number().int(),
  /** Paid in but not yet applied to a statement. */
  unapplied: z.number(),
});
export type ReceivablesAgingRow = z.infer<typeof ReceivablesAgingRowSchema>;

export const ReceivablesAgingResponseSchema = z.object({
  asOf: Ymd,
  rows: z.array(ReceivablesAgingRowSchema),
  statements: z.array(ReceivableStatementSchema),
  totals: z.object({ buckets: BucketsSchema, open: z.number() }),
});
export type ReceivablesAgingResponse = z.infer<typeof ReceivablesAgingResponseSchema>;

export const CLIENT_PAYMENT_METHODS = ['ACH', 'CHECK', 'WIRE', 'CARD', 'OTHER'] as const;
export const ClientPaymentMethodSchema = z.enum(CLIENT_PAYMENT_METHODS);
export type ClientPaymentMethodKind = z.infer<typeof ClientPaymentMethodSchema>;
export const CLIENT_PAYMENT_METHOD_LABELS: Record<ClientPaymentMethodKind, string> = { ACH: 'ACH', CHECK: 'Check', WIRE: 'Wire', CARD: 'Card', OTHER: 'Other' };

export const ClientPaymentInputSchema = z.object({
  clientId: z.string().uuid(),
  receivedOn: Ymd,
  amount: z.number().positive().max(100_000_000),
  method: ClientPaymentMethodSchema,
  reference: z.string().trim().max(80).nullable().optional(),
  /** A bank account (or Undeposited funds); default operating checking, Undeposited funds for a check. */
  depositAccountId: z.string().uuid().nullable().optional(),
  applications: z.array(z.object({ statementId: z.string().uuid(), amount: z.number().positive() })).max(200),
  /**
   * The bank deposit this payment is (Bank → For review → "Record as payment").
   * The payment lands in that bank's account and the deposit is matched to its
   * entry, so the money isn't typed twice. Same amount, money in, not yet decided;
   * received on the deposit's date whatever receivedOn says. The answer carries
   * `depositMatched` — true only when the deposit is matched to this payment.
   */
  bankTransactionId: z.string().uuid().optional(),
});
export type ClientPaymentInput = z.infer<typeof ClientPaymentInputSchema>;

export const ClientPaymentRowSchema = z.object({
  id: z.string(),
  clientId: z.string(),
  clientName: z.string(),
  receivedOn: Ymd,
  amount: z.number(),
  method: ClientPaymentMethodSchema,
  reference: z.string().nullable(),
  depositAccount: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(),
  applied: z.number(),
  unapplied: z.number(),
  applications: z.array(z.object({ statementId: z.string(), number: z.number().int().nullable(), amount: z.number() })),
  journalEntryId: z.string().nullable(),
  undone: z.boolean(),
  createdAt: z.string(),
});
export type ClientPaymentRow = z.infer<typeof ClientPaymentRowSchema>;

export const ClientPaymentListResponseSchema = z.object({ payments: z.array(ClientPaymentRowSchema) });
export type ClientPaymentListResponse = z.infer<typeof ClientPaymentListResponseSchema>;

export const ClientReceivablesResponseSchema = z.object({
  client: z.object({ id: z.string(), name: z.string() }),
  balance: z.number(),
  unapplied: z.number(),
  openStatements: z.array(ReceivableStatementSchema),
  payments: z.array(ClientPaymentRowSchema),
});
export type ClientReceivablesResponse = z.infer<typeof ClientReceivablesResponseSchema>;

export const PostingGapSchema = z.object({
  kind: z.string(),
  sourceType: z.string(),
  sourceId: z.string(),
  label: z.string(),
  link: z.string().nullable(),
});
export type PostingGap = z.infer<typeof PostingGapSchema>;

export const PostingBackfillResultSchema = z.object({
  payrollRuns: z.number().int(),
  statements: z.number().int(),
  taxPayments: z.number().int(),
  taxDeposits: z.number().int(),
  garnishmentRemittances: z.number().int(),
  wageAdvances: z.number().int(),
  /** Payments recorded for statements that were marked paid without one (audit 2026-10-29 MONEY-3). */
  clientPayments: z.number().int().optional(),
  failed: z.array(z.object({ sourceType: z.string(), sourceId: z.string(), error: z.string() })),
});
export type PostingBackfillResult = z.infer<typeof PostingBackfillResultSchema>;

export const ReceivablesDepositAccountSchema = z.object({ id: z.string(), code: z.string(), name: z.string(), isDefault: z.boolean(), forChecks: z.boolean() });
export type ReceivablesDepositAccount = z.infer<typeof ReceivablesDepositAccountSchema>;
