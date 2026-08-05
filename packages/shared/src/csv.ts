/**
 * One CSV cell escaper for the whole product.
 *
 * Four independent copies existed (web `lib/csv`, and the org census,
 * time export, and audit export on the API). All four quoted correctly
 * per RFC-4180 and all four were missing the same defense, so a fix in
 * one never reached the others.
 *
 * Two jobs:
 *
 *  1. **RFC-4180 quoting** — wrap in double quotes and double any
 *     embedded quote whenever the value carries a comma, quote, CR or LF.
 *
 *  2. **Formula-injection neutralisation** — a cell whose text begins
 *     with `=`, `+`, `-`, `@`, TAB or CR is interpreted as a FORMULA by
 *     Excel, Google Sheets and LibreOffice. `=cmd|'/c calc'!A1` is the
 *     textbook DDE payload. Associate-controlled values (names, notes,
 *     addresses, audit metadata) flow into exports that payroll bureaus
 *     open in Excel, so we prefix a single quote, which those apps strip
 *     on display while refusing to evaluate the content.
 *
 * The prefix is applied BEFORE quoting so the guard survives the quote
 * wrapping.
 */

const NEEDS_QUOTING = /[",\n\r]/;

// Leading characters that trigger formula evaluation in spreadsheet apps.
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

export function csvCell(value: string | number | null | undefined): string {
  const raw = value === null || value === undefined ? '' : String(value);
  const guarded = FORMULA_TRIGGER.test(raw) ? `'${raw}` : raw;
  return NEEDS_QUOTING.test(guarded)
    ? `"${guarded.replace(/"/g, '""')}"`
    : guarded;
}

/**
 * Rows → CSV text with CRLF line endings (RFC-4180) and a UTF-8 BOM.
 *
 * The BOM is what stops Excel guessing the encoding and rendering "José"
 * as "JosÃ©". The browser export already emitted one; the server exports
 * did not, so the same person's name rendered differently depending on
 * which button produced the file.
 */
export function toCsv(
  rows: Array<Array<string | number | null | undefined>>,
): string {
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}
