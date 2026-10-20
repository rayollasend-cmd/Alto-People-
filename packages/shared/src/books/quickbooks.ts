import { z } from 'zod';

/**
 * The books — the company's QuickBooks Online, kept in step both ways.
 *
 *   GET    /books/quickbooks/status                 → QboSyncStatus
 *   GET    /books/quickbooks/connect                → { authorizeUrl }      (manage:books)
 *   GET    /books/quickbooks/callback?code&state&realmId → redirect to /books/quickbooks?connected=1
 *   POST   /books/quickbooks/disconnect | /pause | /resume                  (manage:books)
 *   POST   /books/quickbooks/sync-now               → QboSyncRunResult      (manage:books)
 *   POST   /books/quickbooks/link                   → QboLinkSummary        (manage:books; match the charts again)
 *   POST   /books/quickbooks/import-history { since } → QboSyncRunResult['pulled'] (manage:books)
 *   GET    /books/quickbooks/outbox?status          → { rows: QboOutboxRow[] }
 *   POST   /books/quickbooks/outbox/:id/retry | /outbox/retry-failed        (manage:books)
 *   GET    /books/quickbooks/events?cursor&limit&result → { events: QboSyncEventRow[], nextCursor }
 *   GET    /books/quickbooks/conflicts?status       → { conflicts: QboConflictRow[] }
 *   POST   /books/quickbooks/conflicts/:id/resolve { keep } → QboConflictRow (manage:books)
 *   GET    /books/quickbooks/mappings?kind=accounts|vendors|customers → { rows: QboMappingRow[] }
 *   GET    /books/quickbooks/qbo-accounts           → { accounts: QboAccountOption[] }
 *   PUT    /books/quickbooks/mappings/accounts/:accountId { qboId }         (manage:books)
 *   GET|PUT /books/quickbooks/settings              QboSyncSettings
 *   POST   /books/quickbooks/webhook                Intuit's change notifications (intuit-signature)
 */

const Id = z.string().uuid();

export const QboConnectionStatusSchema = z.enum(['CONNECTED', 'NEEDS_RECONNECT', 'PAUSED', 'DISCONNECTED']);
export type QboConnectionStatus = z.infer<typeof QboConnectionStatusSchema>;

export const QboSyncSettingsSchema = z.object({
  /** QuickBooks Class: the client, the department, or nothing. */
  classMode: z.enum(['CLIENT', 'DEPARTMENT', 'NONE']),
  /** QuickBooks Location: the site, or nothing. */
  locationMode: z.enum(['SITE', 'NONE']),
});
export type QboSyncSettings = z.infer<typeof QboSyncSettingsSchema>;

export const QboSyncStatusSchema = z.object({
  /** Null until QuickBooks is connected. */
  connection: z
    .object({
      realmId: z.string(),
      companyName: z.string().nullable(),
      status: QboConnectionStatusSchema,
      connectedAt: z.string(),
      lastPushAt: z.string().nullable(),
      lastPullAt: z.string().nullable(),
      pulledThrough: z.string().nullable(),
      lastError: z.string().nullable(),
      /** QuickBooks' own books-closing date. */
      qboClosingDate: z.string().nullable(),
    })
    .nullable(),
  counts: z.object({ pending: z.number().int(), failed: z.number().int(), conflicts: z.number().int(), linked: z.number().int() }),
  /** No Intuit keys here: QuickBooks is simulated end to end. */
  sandboxOnly: z.boolean(),
  /** Intuit's webhooks are verified (else the five-minute pull carries every change). */
  webhooksOn: z.boolean(),
  settings: QboSyncSettingsSchema,
});
export type QboSyncStatus = z.infer<typeof QboSyncStatusSchema>;

export const QboSyncRunResultSchema = z.object({
  connected: z.boolean(),
  pushed: z.object({ sent: z.number(), skipped: z.number(), failed: z.number(), conflicts: z.number() }),
  pulled: z.object({ ok: z.number(), conflicts: z.number(), errors: z.number(), skipped: z.number() }),
  error: z.string().nullable(),
});
export type QboSyncRunResult = z.infer<typeof QboSyncRunResultSchema>;

export const QboLinkSummarySchema = z.object({
  accounts: z.object({ matched: z.number(), created: z.number(), imported: z.number() }),
  vendors: z.object({ matched: z.number(), created: z.number(), imported: z.number() }),
  customers: z.object({ matched: z.number(), created: z.number() }),
});
export type QboLinkSummary = z.infer<typeof QboLinkSummarySchema>;

export const QboOutboxRowSchema = z.object({
  id: Id,
  localType: z.string(),
  localId: z.string(),
  /** "Bill 1043 — Shell Fleet", "Journal entry #27". */
  label: z.string(),
  link: z.string().nullable(),
  op: z.enum(['UPSERT', 'DELETE']),
  status: z.enum(['PENDING', 'DONE', 'FAILED', 'SKIPPED']),
  attempts: z.number().int(),
  nextAttemptAt: z.string(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
});
export type QboOutboxRow = z.infer<typeof QboOutboxRowSchema>;

export const QboSyncEventRowSchema = z.object({
  id: Id,
  direction: z.enum(['PUSH', 'PULL']),
  result: z.enum(['OK', 'ERROR', 'CONFLICT', 'SKIPPED']),
  localType: z.string().nullable(),
  localId: z.string().nullable(),
  qboType: z.string().nullable(),
  qboId: z.string().nullable(),
  message: z.string().nullable(),
  createdAt: z.string(),
});
export type QboSyncEventRow = z.infer<typeof QboSyncEventRowSchema>;

export const QboConflictRowSchema = z.object({
  id: Id,
  localType: z.string(),
  localId: z.string(),
  summary: z.string(),
  /** Plain-language reason: changed on both sides, deleted in QuickBooks, a closed month… */
  reason: z.enum(['BOTH_CHANGED', 'DELETED_IN_QUICKBOOKS', 'SITE_PERIOD_CLOSED', 'BOOKS_CLOSED']),
  /** Field-by-field: what each side says. */
  fields: z.array(z.object({ label: z.string(), site: z.string().nullable(), quickbooks: z.string().nullable(), differs: z.boolean() })),
  qboType: z.string(),
  qboId: z.string(),
  status: z.enum(['OPEN', 'KEPT_SITE', 'KEPT_QUICKBOOKS', 'DISMISSED']),
  resolvedByName: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  createdAt: z.string(),
  link: z.string().nullable(),
});
export type QboConflictRow = z.infer<typeof QboConflictRowSchema>;

export const QboResolveInputSchema = z.object({ keep: z.enum(['SITE', 'QUICKBOOKS', 'DISMISS']) });
export type QboResolveInput = z.infer<typeof QboResolveInputSchema>;

export const QboMappingRowSchema = z.object({
  localId: Id,
  /** "1000 Operating checking", a vendor's or client's name. */
  siteName: z.string(),
  siteDetail: z.string().nullable(),
  qboId: z.string().nullable(),
  qboName: z.string().nullable(),
  owner: z.enum(['SITE', 'QUICKBOOKS']).nullable(),
  lastSyncedAt: z.string().nullable(),
});
export type QboMappingRow = z.infer<typeof QboMappingRowSchema>;

export const QboAccountOptionSchema = z.object({ id: z.string(), name: z.string(), number: z.string().nullable(), type: z.string(), active: z.boolean() });
export type QboAccountOption = z.infer<typeof QboAccountOptionSchema>;

export const QboImportHistoryInputSchema = z.object({ since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
export const QboRelinkInputSchema = z.object({ qboId: z.string().min(1).max(40) });
