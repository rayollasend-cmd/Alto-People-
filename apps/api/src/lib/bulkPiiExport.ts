import type { Request } from 'express';
import { env } from '../config/env.js';
import { HttpError } from '../middleware/error.js';

/**
 * Who may carry the whole roster's SSNs out of the building.
 *
 * `export:payroll-pii` answers "does this job need SSNs at all" — HR admin
 * and finance both genuinely do, because Synchros and the payroll cycle
 * run on them. It does not answer "should every holder of that role be
 * able to download every associate's SSN, bank account, date of birth and
 * home address in one file". Reading one record in the UI and exporting
 * two thousand are different risks wearing the same capability.
 *
 * So bulk export is additionally restricted to named people, listed in
 * PII_BULK_EXPORT_USERS as comma-separated emails. Single-record reveals
 * are untouched: they stay masked behind a per-record, audited click.
 *
 * When the list is unset the capability alone still decides, because a
 * blank env var on a deploy must not be able to stop payday. It says so
 * loudly in the logs and stamps `allowlist: 'unset'` on the audit row, so
 * "we never configured it" can never look like "it was configured and
 * allowed this".
 */

function allowlist(): string[] {
  return (env.PII_BULK_EXPORT_USERS ?? '')
    .split(',')
    .map((e: string) => e.trim().toLowerCase())
    .filter(Boolean);
}

export type BulkExportAuthority = 'allowlist' | 'unset';

/**
 * Throws 403 unless this user is named for bulk PII export. Call AFTER the
 * capability guard — this narrows that audience, it does not replace it.
 * Returns which rule let them through, for the audit row.
 */
export function assertBulkPiiExporter(req: Request): BulkExportAuthority {
  const allowed = allowlist();
  const email = (req.user?.email ?? '').trim().toLowerCase();
  if (allowed.length === 0) {
    console.warn(
      '[bulkPiiExport] PII_BULK_EXPORT_USERS is not set — a bulk SSN export ' +
        'was authorized by capability alone. Set it to the named people who ' +
        'do this work, comma-separated, to close it down.',
      JSON.stringify({ actor: email || null, path: req.originalUrl ?? req.path }),
    );
    return 'unset';
  }
  if (!email || !allowed.includes(email)) {
    throw new HttpError(
      403,
      'not_a_named_exporter',
      'Bulk export of SSN and bank data is limited to named people. Ask an ' +
        'administrator to add you to PII_BULK_EXPORT_USERS if this is your work.',
    );
  }
  return 'allowlist';
}
