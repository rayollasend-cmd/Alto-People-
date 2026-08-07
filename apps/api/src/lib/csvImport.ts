/**
 * Bulk associate CSV import — header mapping + per-row validation.
 *
 * Deliberately DB-free: callers hand in the client list and the set of
 * already-taken emails, so this stays unit-testable and both the preview
 * and commit endpoints share exactly one validation implementation
 * (preview must never disagree with what commit would do).
 */
import { z } from 'zod';
import type { CsvImportPreviewRow, CsvImportRowData } from '@alto-people/shared';
import type { CsvRecord } from './csv.js';

/** Data-row hard cap per file. Beyond this, ask for a split upload —
 *  parsing is cheap but per-row commit work (and the preview table) isn't. */
export const CSV_IMPORT_MAX_ROWS = 2000;

export type CsvColumn =
  | 'firstName'
  | 'lastName'
  | 'email'
  | 'phone'
  | 'hireDate'
  | 'clientName'
  | 'clientId'
  | 'position';

// Header cells are matched case-insensitively with punctuation/whitespace
// stripped, so "First Name", "first_name", and "firstName" all land on the
// same column. Order-free; unknown columns are ignored.
const HEADER_ALIASES: Record<string, CsvColumn> = {
  firstname: 'firstName',
  lastname: 'lastName',
  email: 'email',
  phone: 'phone',
  hiredate: 'hireDate',
  clientname: 'clientName',
  client: 'clientName',
  clientid: 'clientId',
  position: 'position',
};

function normalizeHeaderCell(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export interface HeaderMapResult {
  /** Per-column mapping; null = unrecognized column (ignored). */
  map: (CsvColumn | null)[];
  /** Required columns absent from the header. `client` is reported when
   *  neither clientName nor clientId is present. */
  missing: string[];
}

export function mapCsvHeader(headerFields: string[]): HeaderMapResult {
  const map = headerFields.map((h) => HEADER_ALIASES[normalizeHeaderCell(h)] ?? null);
  const present = new Set(map.filter((c): c is CsvColumn => c !== null));
  const missing: string[] = [];
  for (const required of ['firstName', 'lastName', 'email'] as const) {
    if (!present.has(required)) missing.push(required);
  }
  if (!present.has('clientName') && !present.has('clientId')) {
    missing.push('clientName or clientId');
  }
  return { map, missing };
}

const YMD_RX = /^\d{4}-\d{2}-\d{2}$/;

/** Strict calendar check — the regex alone lets 2026-02-30 through. */
function isValidYmd(s: string): boolean {
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// Field-level checks. Blank cells are stripped to `undefined` BEFORE this
// runs, so optional() means "column empty or absent is fine".
const RowFieldsSchema = z.object({
  firstName: z.string().min(1, 'firstName is required').max(100, 'firstName is too long'),
  lastName: z.string().min(1, 'lastName is required').max(100, 'lastName is too long'),
  email: z
    .string({ required_error: 'email is required' })
    .min(1, 'email is required')
    .max(254, 'email is too long')
    .email('invalid email'),
  phone: z.string().max(40, 'phone is too long').optional(),
  hireDate: z
    .string()
    .regex(YMD_RX, 'invalid hireDate (use YYYY-MM-DD)')
    .refine(isValidYmd, 'invalid hireDate (not a real calendar date)')
    .optional(),
  clientName: z.string().max(200, 'clientName is too long').optional(),
  clientId: z.string().uuid('invalid clientId (not a UUID)').optional(),
  position: z.string().max(120, 'position is too long').optional(),
});

export interface ClientRef {
  id: string;
  name: string;
}

export interface ValidatedCsvRow extends CsvImportPreviewRow {
  /** Email already belongs to a non-deleted associate or user. Commit maps
   *  this to skipped/already_exists — which is what makes re-running the
   *  same file safe. */
  alreadyExists: boolean;
  /** Same email appeared on an earlier line of this file. */
  duplicateInFile: boolean;
}

export interface CsvValidationResult {
  rows: ValidatedCsvRow[];
  summary: {
    total: number;
    valid: number;
    invalid: number;
    duplicateEmails: number;
  };
}

export function validateCsvRows(
  records: CsvRecord[],
  headerMap: (CsvColumn | null)[],
  clients: ClientRef[],
  existingEmails: ReadonlySet<string>,
  /** Non-null for tenant-bounded callers (SHIFT_SUPERVISOR): every row must
   *  resolve to THIS client or it's rejected. */
  boundedClientId: string | null,
): CsvValidationResult {
  const clientById = new Map(clients.map((c) => [c.id, c]));
  // name (lowercased, trimmed) → ids. Duplicated names are ambiguous and
  // must be imported by clientId instead — guessing would silently file
  // people under the wrong employer.
  const idsByName = new Map<string, string[]>();
  for (const c of clients) {
    const key = c.name.trim().toLowerCase();
    idsByName.set(key, [...(idsByName.get(key) ?? []), c.id]);
  }

  const firstLineByEmail = new Map<string, number>();
  const rows: ValidatedCsvRow[] = [];
  let valid = 0;
  let duplicateEmails = 0;

  for (const record of records) {
    const cells: Partial<Record<CsvColumn, string>> = {};
    record.fields.forEach((value, i) => {
      const col = headerMap[i];
      if (!col) return;
      const trimmed = value.trim();
      if (trimmed !== '') cells[col] = trimmed;
    });

    const errors: string[] = [];
    const parsed = RowFieldsSchema.safeParse(cells);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) errors.push(issue.message);
    }

    const email = (cells.email ?? '').toLowerCase();

    // Client resolution: an explicit clientId wins; otherwise the name is
    // looked up. Unknown or ambiguous → row error.
    let resolvedClientId: string | null = null;
    if (parsed.success) {
      const { clientId, clientName } = parsed.data;
      if (clientId) {
        if (clientById.has(clientId)) resolvedClientId = clientId;
        else errors.push(`unknown clientId "${clientId}"`);
      } else if (clientName) {
        const ids = idsByName.get(clientName.toLowerCase()) ?? [];
        if (ids.length === 1) resolvedClientId = ids[0];
        else if (ids.length === 0) errors.push(`unknown client "${clientName}"`);
        else errors.push(`ambiguous client name "${clientName}" — use the clientId column`);
      } else {
        errors.push('clientName or clientId is required');
      }
      if (resolvedClientId && boundedClientId && resolvedClientId !== boundedClientId) {
        errors.push('client is outside your account’s scope');
        resolvedClientId = null;
      }
    }

    // Duplicate detection — both flavors are counted in duplicateEmails and
    // reported as row errors so preview's "invalid" total matches what
    // commit will actually skip.
    let alreadyExists = false;
    let duplicateInFile = false;
    if (email && parsed.success) {
      if (existingEmails.has(email)) {
        alreadyExists = true;
        duplicateEmails++;
        errors.push('email already exists — this row will be skipped on commit');
      }
      const firstLine = firstLineByEmail.get(email);
      if (firstLine !== undefined) {
        duplicateInFile = true;
        // Only count each row once toward duplicateEmails.
        if (!alreadyExists) duplicateEmails++;
        errors.push(`duplicate email in file (first used on line ${firstLine})`);
      } else {
        firstLineByEmail.set(email, record.line);
      }
    }

    const data: CsvImportRowData = {
      firstName: cells.firstName ?? '',
      lastName: cells.lastName ?? '',
      email,
      phone: cells.phone ?? null,
      hireDate: cells.hireDate ?? null,
      clientId: resolvedClientId,
      clientName: cells.clientName ?? null,
      position: cells.position ?? null,
    };

    if (errors.length === 0) valid++;
    rows.push({ line: record.line, data, errors, alreadyExists, duplicateInFile });
  }

  return {
    rows,
    summary: {
      total: rows.length,
      valid,
      invalid: rows.length - valid,
      duplicateEmails,
    },
  };
}
