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
 *
 * 3. **Numbers stay numbers** (audit 2026-10-29 MONEY-9/22). The guard
 *    used to fire on every negative amount (`'-205.89`), so refunds, losses
 *    and outflows exported as text a spreadsheet won't sum. A number — or
 *    text that is only a number (`-1,234.56`, `-$80.00`, `-12%`) — can't
 *    carry a formula, so it is written as is. Numbers are also written at
 *    15 significant digits, the precision a spreadsheet keeps, so float
 *    tails (`100.82000000000001`) never reach a file.
 */

const NEEDS_QUOTING = /[",\n\r]/;

// Leading characters that trigger formula evaluation in spreadsheet apps.
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

// Text that is nothing but a number: an optional minus, an optional dollar
// sign, digits with optional thousands commas, an optional decimal part and
// an optional percent. Nothing in it can be evaluated as a formula. A
// leading `+` keeps its guard: that is how phone numbers are written, and a
// spreadsheet would turn "+15551234567" into 15551234567.
const PLAIN_NUMBER = /^-?\$?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?%?$/;

/** A finite number as a spreadsheet stores it: 15 significant digits, no float tail. */
export function csvNumber(n: number): string {
  if (!Number.isFinite(n)) return '';
  if (Number.isInteger(n)) return String(n);
  return String(Number(n.toPrecision(15)));
}

/** True when text is only a number (and so needs no formula guard). */
export function isPlainNumberText(s: string): boolean {
  return /\d/.test(s) && PLAIN_NUMBER.test(s);
}

// A screen's dollar figure ("$29,885.44", "-$204.13", "−$204.13") and its
// "no value" dash. Exports that pass display strings (a chart's formatter, a
// grid column's csv accessor) still reach the file as a number and an empty
// cell (audit 2026-10-29 MONEY-29).
const DOLLARS = /^([-\u2212])?\$(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?$/;
const DASH_ONLY = /^[\u2014\u2013]$/;

/** A display dollar string as a plain number ("-$1,234.50" → "-1234.50"); null when it isn't one. */
export function dollarsAsNumber(s: string): string | null {
  const m = DOLLARS.exec(s.trim());
  if (!m) return null;
  return `${m[1] ? '-' : ''}${m[2]!.replace(/,/g, '')}${m[3] ?? ''}`;
}

export function csvCell(value: string | number | boolean | null | undefined): string {
  if (typeof value === 'number') return csvNumber(value);
  if (typeof value === 'string') {
    if (DASH_ONLY.test(value.trim())) return '';
    const n = dollarsAsNumber(value);
    if (n !== null) return n;
  }
  const raw = value === null || value === undefined ? '' : String(value);
  const guarded = FORMULA_TRIGGER.test(raw) && !isPlainNumberText(raw) ? `'${raw}` : raw;
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
  rows: Array<Array<string | number | boolean | null | undefined>>,
): string {
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}
