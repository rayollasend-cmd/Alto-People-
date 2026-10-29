import { tenantIdForWrite } from '../../tenant.js';
import { periodWords } from '../words.js';
import { emitBooksChange } from '../events.js';
import { postEntry } from '../ledger.js';
import { LineBook, cents, dayOf, voidByKey, ymd, type Db } from './common.js';

/**
 * A finalized client statement in the books, dated the day it was issued:
 *   Dr Accounts receivable (the client)
 *   Cr Staffing services revenue — the hours, split by store where the
 *      statement has them (a store with no site on file stays client-wide)
 *   Cr Billing adjustments — retro rebills and contract premiums it carried
 *   Cr Sales tax payable — the tax billed on top, owed to the state
 * A credit (a negative statement) posts the other way. Draft statements
 * aren't revenue yet; a statement that stops being final is taken off.
 */

interface Snapshot {
  stores?: Array<{ locationName: string; amount: number }>;
  adjustments?: Array<{ amount: number }>;
  totals?: { amount?: number; hoursAmount?: number; adjustmentsAmount?: number; subtotal?: number; salesTax?: number };
}

export const statementKey = (id: string) => `statement:${id}`;

/** The statement's total (what the client owes), its hours part, adjustments part and sales tax, cents. */
export function statementAmounts(snapshot: unknown): { total: number; hours: number; adjustments: number; salesTax: number } {
  const s = (snapshot ?? {}) as Snapshot;
  const total = cents(s.totals?.amount ?? 0);
  const salesTax = cents(s.totals?.salesTax ?? 0);
  const subtotal = total - salesTax;
  const adjustments = s.totals?.adjustmentsAmount !== undefined ? cents(s.totals.adjustmentsAmount) : (s.adjustments ?? []).reduce((n, a) => n + cents(a.amount), 0);
  const hours = s.totals?.hoursAmount !== undefined ? cents(s.totals.hoursAmount) : subtotal - adjustments;
  return { total, hours, adjustments: subtotal - hours, salesTax };
}

export async function postStatement(db: Db, statementId: string): Promise<'posted' | 'voided' | 'skipped'> {
  const st = await db.clientStatement.findFirst({ where: { id: statementId, tenantId: tenantIdForWrite() } });
  if (!st) return 'skipped';
  if (st.status !== 'FINAL') {
    const n = await voidByKey(db, statementKey(st.id), 'The statement is no longer final');
    if (n > 0) emitBooksChange({ localType: 'ClientStatement', localId: st.id, op: 'DELETE' });
    return n > 0 ? 'voided' : 'skipped';
  }
  const amounts = statementAmounts(st.snapshot);
  if (amounts.total === 0) return 'skipped';

  const snap = (st.snapshot ?? {}) as Snapshot;
  const sites = await db.site.findMany({ where: { clientId: st.clientId }, select: { id: true, name: true } });
  const siteByName = new Map(sites.map((s) => [s.name.trim().toLowerCase(), s.id]));
  const book = new LineBook();
  book.debit('AR', amounts.total, { clientId: st.clientId });

  // The hours, by store: store amounts scaled to the hours total so rounding never unbalances it.
  const stores = (snap.stores ?? []).filter((s) => cents(s.amount) !== 0);
  const storeSum = stores.reduce((n, s) => n + cents(s.amount), 0);
  if (stores.length > 0 && storeSum !== 0) {
    let left = amounts.hours;
    stores.forEach((s, idx) => {
      const share = idx === stores.length - 1 ? left : Math.round((cents(s.amount) * amounts.hours) / storeSum);
      left -= share;
      book.credit('REVENUE_STAFFING', share, { clientId: st.clientId, siteId: siteByName.get(s.locationName.trim().toLowerCase()) ?? null });
    });
  } else {
    book.credit('REVENUE_STAFFING', amounts.hours, { clientId: st.clientId });
  }
  book.credit('REVENUE_ADJUSTMENTS', amounts.adjustments, { clientId: st.clientId });
  // Sales tax billed is owed to the state, not earned.
  if (amounts.salesTax !== 0) book.credit('SALES_TAX_PAYABLE', amounts.salesTax, { clientId: st.clientId });

  const label = st.number !== null ? `Statement No. ${String(st.number).padStart(4, '0')}` : 'Statement';
  await postEntry(db, {
    date: st.finalizedAt ? dayOf(st.finalizedAt) : ymd(st.periodEnd),
    memo: `${label} · ${periodWords(ymd(st.periodStart), ymd(st.periodEnd))}`,
    source: 'STATEMENT',
    sourceType: 'ClientStatement',
    sourceId: st.id,
    sourceKey: statementKey(st.id),
    lines: book.lines(),
  });
  emitBooksChange({ localType: 'ClientStatement', localId: st.id, op: 'UPSERT' });
  return 'posted';
}
