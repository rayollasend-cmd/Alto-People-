import { tenantIdForWrite } from '../../tenant.js';
import { postEntry } from '../ledger.js';
import { LineBook, cents, dayOf, voidByKey, ymd, type Db } from './common.js';
import { labelWords, quarterWords } from '../words.js';

/**
 * Money payroll owes others leaving the payroll account:
 *
 *   tax-payment:<id>          a tax desk payment (lib/payrollTaxLedger),
 *       Dr the liabilities it paid — federal income tax, Social Security
 *       and Medicare, FUTA, state withholding, SUTA and state programs,
 *       local — Cr payroll checking. A payment that differs from the
 *       liabilities it covers (a penalty, interest) books the difference
 *       to Uncategorized expense, named in the memo.
 *   tax-deposit:<id>          the older per-run deposit, only for a run the
 *       tax desk never itemized (so nothing is paid twice in the books).
 *   garnishment-remit:<id>    Dr Garnishments payable, Cr payroll checking.
 *   wage-advance:<id>         an earned-wage advance paid out before payday:
 *       Dr Employee advances (what the paycheck recovers), Cr payroll
 *       checking (what was sent), Cr Other income (the fee).
 */

const KIND_ACCOUNT: Record<string, string> = {
  FEDERAL_WITHHOLDING: 'FIT_PAYABLE',
  FEDERAL_UNEMPLOYMENT: 'FUTA_PAYABLE',
  STATE_WITHHOLDING: 'SIT_PAYABLE',
  STATE_UNEMPLOYMENT: 'SUTA_PAYABLE',
  LOCAL: 'LOCAL_TAX_PAYABLE',
};

export const taxPaymentKey = (id: string) => `tax-payment:${id}`;
export const taxDepositKey = (id: string) => `tax-deposit:${id}`;
export const garnishmentKey = (id: string) => `garnishment-remit:${id}`;
export const advanceKey = (id: string) => `wage-advance:${id}`;

/** Book a liability's amount to its payables (federal splits income tax from Social Security / Medicare). */
function bookLiability(book: LineBook, kind: string, amount: number, breakdown: Record<string, unknown>): void {
  if (kind === 'FEDERAL_WITHHOLDING') {
    const fit = cents(breakdown.federalIncomeTax as number | undefined);
    const fica = amount - fit;
    book.debit('FIT_PAYABLE', fit);
    book.debit('FICA_PAYABLE', fica);
    return;
  }
  book.debit(KIND_ACCOUNT[kind] ?? 'UNCATEGORIZED_EXPENSE', amount);
}

export async function postTaxPayment(db: Db, paymentId: string): Promise<'posted' | 'voided' | 'skipped'> {
  const p = await db.taxPayment.findFirst({ where: { id: paymentId, tenantId: tenantIdForWrite() }, include: { liabilities: true, account: { select: { agencyName: true } } } });
  if (!p) return 'skipped';
  if (p.status !== 'PAID') {
    return (await voidByKey(db, taxPaymentKey(p.id), `The tax payment is ${p.status.toLowerCase()}`)) > 0 ? 'voided' : 'skipped';
  }
  const total = cents(p.amount);
  if (total === 0) return 'skipped';
  const book = new LineBook();
  let covered = 0;
  if (p.liabilities.length > 0) {
    for (const l of p.liabilities) {
      const amt = cents(l.amount);
      bookLiability(book, l.kind, amt, (l.breakdown ?? {}) as Record<string, unknown>);
      covered += amt;
    }
  } else {
    bookLiability(book, p.kind, total, {});
    covered = total;
  }
  const extra = total - covered;
  if (extra !== 0) book.debit('UNCATEGORIZED_EXPENSE', extra, {}, 'Tax payment beyond the liabilities it covers (penalty or interest?) — review');
  book.credit('CASH_PAYROLL', total);
  await postEntry(db, {
    date: p.paidAt ? dayOf(p.paidAt) : ymd(p.dueDate),
    memo: `Tax payment · ${p.account?.agencyName ?? (p.jurisdiction === 'US' ? 'Internal Revenue Service' : p.jurisdiction)} · ${quarterWords(p.periodLabel)}${p.confirmationNumber ? ` · conf. ${p.confirmationNumber}` : ''}`,
    source: 'TAX_PAYMENT',
    sourceType: 'TaxPayment',
    sourceId: p.id,
    sourceKey: taxPaymentKey(p.id),
    lines: book.lines(),
  });
  return 'posted';
}

export async function postTaxDeposit(db: Db, depositId: string): Promise<'posted' | 'voided' | 'skipped'> {
  const d = await db.taxDeposit.findFirst({ where: { id: depositId, tenantId: tenantIdForWrite() } });
  if (!d) return 'skipped';
  // The tax desk's itemized liabilities are the record where they exist; don't pay it twice.
  const deskCovers = d.payrollRunId
    ? (await db.taxLiability.count({ where: { payrollRunId: d.payrollRunId } })) > 0
    : (await db.taxLiability.count({ where: { tenantId: tenantIdForWrite(), kind: 'FEDERAL_UNEMPLOYMENT', periodLabel: { startsWith: d.periodLabel.slice(0, 4) } } })) > 0;
  if (deskCovers) {
    return (await voidByKey(db, taxDepositKey(d.id), 'Paid through the tax desk')) > 0 ? 'voided' : 'skipped';
  }
  if (d.status !== 'PAID') return (await voidByKey(db, taxDepositKey(d.id), 'The deposit is no longer paid')) > 0 ? 'voided' : 'skipped';
  const total = cents(d.amount);
  if (total === 0) return 'skipped';
  const book = new LineBook();
  const kind = String(d.kind);
  if (kind === 'FUTA') book.debit('FUTA_PAYABLE', total);
  else {
    // A 941 deposit: income tax withheld, then Social Security and Medicare (both halves).
    const fit = cents(((d.breakdown ?? {}) as { fit?: number }).fit ?? 0);
    book.debit('FIT_PAYABLE', fit);
    book.debit('FICA_PAYABLE', total - fit);
  }
  book.credit('CASH_PAYROLL', total);
  await postEntry(db, {
    date: dayOf(d.paidAt ?? new Date()),
    memo: `Tax deposit · ${kind === 'FUTA' ? 'FUTA' : 'Form 941'} · ${labelWords(d.periodLabel)}${d.confirmationNumber ? ` · conf. ${d.confirmationNumber}` : ''}`,
    source: 'TAX_PAYMENT',
    sourceType: 'TaxDeposit',
    sourceId: d.id,
    sourceKey: taxDepositKey(d.id),
    lines: book.lines(),
  });
  return 'posted';
}

export async function postGarnishmentRemittance(db: Db, remittanceId: string): Promise<'posted' | 'voided' | 'skipped'> {
  const r = await db.garnishmentRemittance.findFirst({ where: { id: remittanceId, tenantId: tenantIdForWrite() } });
  if (!r) return 'skipped';
  if (r.status !== 'SENT') return (await voidByKey(db, garnishmentKey(r.id), 'The remittance is no longer sent')) > 0 ? 'voided' : 'skipped';
  const total = cents(r.amount);
  if (total === 0) return 'skipped';
  const book = new LineBook();
  book.debit('GARNISHMENTS_PAYABLE', total);
  book.credit('CASH_PAYROLL', total);
  await postEntry(db, {
    date: dayOf(r.sentAt ?? new Date()),
    memo: `Garnishment remittance · ${r.method.toLowerCase()}`,
    source: 'GARNISHMENT',
    sourceType: 'GarnishmentRemittance',
    sourceId: r.id,
    sourceKey: garnishmentKey(r.id),
    lines: book.lines(),
  });
  return 'posted';
}

export async function postWageAdvance(db: Db, advanceId: string): Promise<'posted' | 'voided' | 'skipped'> {
  const a = await db.earnedWageAdvance.findFirst({ where: { id: advanceId, tenantId: tenantIdForWrite() } });
  if (!a) return 'skipped';
  const paidOut = ['PAID', 'RECOVERED'].includes(String(a.status)) && !!a.paidAt;
  if (!paidOut) return (await voidByKey(db, advanceKey(a.id), 'The advance was not paid out')) > 0 ? 'voided' : 'skipped';
  if (a.amountCents <= 0) return 'skipped';
  const book = new LineBook();
  book.debit('EMPLOYEE_ADVANCES', a.amountCents + a.feeCents);
  book.credit('CASH_PAYROLL', a.amountCents);
  book.credit('OTHER_INCOME', a.feeCents, {}, 'Earned-wage advance fees');
  await postEntry(db, {
    date: dayOf(a.paidAt!),
    memo: 'Earned-wage advance paid before payday',
    source: 'PAYROLL_DISBURSEMENT',
    sourceType: 'EarnedWageAdvance',
    sourceId: a.id,
    sourceKey: advanceKey(a.id),
    lines: book.lines(),
  });
  return 'posted';
}
