/**
 * The company QuickBooks Online, as the sync sees it: a small client
 * interface over the v3 accounting API, implemented over HTTP (http.ts) and
 * in memory (fake.ts — tests, and local development without Intuit keys).
 *
 * Entities are QuickBooks' own JSON shapes (PascalCase), kept loose: the
 * sync reads the fields it maps and passes the rest through untouched.
 */

/** A QuickBooks entity as the API returns it (Id + SyncToken + the rest). */
export type QboEntity = { Id: string; SyncToken?: string; MetaData?: { CreateTime?: string; LastUpdatedTime?: string }; [k: string]: unknown };

/** The entity names the sync reads and writes. */
export type QboType =
  | 'Account'
  | 'Vendor'
  | 'Customer'
  | 'Class'
  | 'Department'
  | 'Item'
  | 'JournalEntry'
  | 'Bill'
  | 'BillPayment'
  | 'Purchase'
  | 'Deposit'
  | 'Transfer'
  | 'Invoice'
  | 'Payment';

/** What change-data-capture returns per entity: the current record, or a deletion. */
export interface QboChange {
  type: QboType;
  id: string;
  deleted: boolean;
  entity: QboEntity | null;
  lastUpdated: string | null;
}

export interface QboCompanyInfo {
  companyName: string;
  /** QuickBooks' books-closing date (Preferences.AccountingInfoPrefs.BookCloseDate), YYYY-MM-DD. */
  bookCloseDate: string | null;
}

export interface QboClient {
  readonly realmId: string;
  companyInfo(): Promise<QboCompanyInfo>;
  /** A QuickBooks query ("SELECT * FROM Account WHERE Active IN (true,false)"), all pages. */
  query(type: QboType, where?: string): Promise<QboEntity[]>;
  get(type: QboType, id: string): Promise<QboEntity | null>;
  create(type: QboType, body: Record<string, unknown>): Promise<QboEntity>;
  /** A full update: body carries Id and SyncToken. */
  update(type: QboType, body: Record<string, unknown>): Promise<QboEntity>;
  /** Delete (Id + SyncToken). Bills, bill payments, journal entries, purchases, deposits, transfers. */
  remove(type: QboType, id: string, syncToken: string): Promise<void>;
  /** Void (Id + SyncToken). Invoices and payments. */
  voidTxn(type: QboType, id: string, syncToken: string): Promise<QboEntity>;
  /** Everything changed since a time (at most 30 days back). */
  cdc(types: QboType[], changedSince: Date): Promise<QboChange[]>;
}

/** An error QuickBooks answered with. `status` is the HTTP status; `code` QuickBooks' own. */
export class QboError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null = null,
    readonly detail: string | null = null,
  ) {
    super(message);
    this.name = 'QboError';
  }
  /** The connection itself is gone (revoked, expired refresh): reconnect, don't retry. */
  get needsReconnect(): boolean {
    return this.status === 401 || this.status === 403;
  }
  /** Worth trying again later (throttled, their outage, a stale SyncToken). */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500 || this.code === '5010';
  }
}
