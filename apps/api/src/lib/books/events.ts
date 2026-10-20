/**
 * "Something in the books changed" — the ledger, payables, bank and the
 * rest call emitBooksChange; listeners (the QuickBooks outbox) decide what
 * to do with it. Keeps the posting code free of any knowledge of the sync.
 *
 * Listeners run after the change is committed, best-effort: a listener that
 * throws is logged, never the caller's failure.
 */

export type BooksLocalType =
  | 'LedgerAccount'
  | 'JournalEntry'
  | 'Vendor'
  | 'Bill'
  | 'BillPayment'
  | 'ClientPayment'
  | 'ClientStatement'
  | 'Client'
  | 'Site'
  | 'Department';

export interface BooksChange {
  localType: BooksLocalType;
  localId: string;
  op: 'UPSERT' | 'DELETE';
  /** For a JournalEntry: what posted it (a BILL entry syncs as the Bill, not a journal entry). */
  source?: string;
  /** QUICKBOOKS when the change was pulled from QuickBooks — never pushed back. */
  origin?: 'SITE' | 'QUICKBOOKS';
}

type Listener = (change: BooksChange) => void | Promise<void>;
const listeners: Listener[] = [];

export function onBooksChange(fn: Listener): () => void {
  listeners.push(fn);
  return () => {
    const i = listeners.indexOf(fn);
    if (i >= 0) listeners.splice(i, 1);
  };
}

export function emitBooksChange(change: BooksChange): void {
  for (const fn of listeners) {
    try {
      const r = fn(change);
      if (r && typeof (r as Promise<void>).catch === 'function') (r as Promise<void>).catch((err) => console.error('[books] listener failed', err));
    } catch (err) {
      console.error('[books] listener failed', err);
    }
  }
}
