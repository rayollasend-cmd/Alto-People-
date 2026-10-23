import { ApiError } from '@/lib/api';

/** The API's own words when it gave them, else a plain fallback. */
export const errMsg = (err: unknown, fallback = 'Something went wrong.') => (err instanceof ApiError ? err.message : fallback);

/** "3 sent to QuickBooks, 2 brought in, 1 waiting for a decision." */
export function syncSentence(r: { pushed: { sent: number; conflicts: number; failed: number }; pulled: { ok: number; conflicts: number } }): string {
  const parts: string[] = [];
  parts.push(r.pushed.sent ? `${r.pushed.sent} sent to QuickBooks` : 'nothing new to send');
  parts.push(r.pulled.ok ? `${r.pulled.ok} brought in` : 'nothing new from QuickBooks');
  const decide = r.pushed.conflicts + r.pulled.conflicts;
  if (decide) parts.push(`${decide} waiting for a decision`);
  if (r.pushed.failed) parts.push(`${r.pushed.failed} couldn’t go`);
  const t = parts.join(', ');
  return `${t.charAt(0).toUpperCase()}${t.slice(1)}.`;
}

/** What each kind of record here is called. */
export const LOCAL_WORDS: Record<string, string> = {
  LedgerAccount: 'Account',
  Vendor: 'Vendor',
  Client: 'Customer',
  JournalEntry: 'Journal entry',
  Bill: 'Bill',
  BillPayment: 'Bill payment',
  ClientStatement: 'Invoice',
  ClientPayment: 'Client payment',
};
