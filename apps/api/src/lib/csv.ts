/**
 * Minimal RFC 4180 CSV parser — no dependency on purpose (nothing else in
 * the repo needs CSV *parsing*; adding csv-parse for one import route isn't
 * worth the supply-chain surface).
 *
 * Handles:
 *   - quoted fields ("Smith, Jr."), including embedded commas and newlines
 *   - escaped quotes inside quoted fields ("Anne ""Annie"" Lee")
 *   - CRLF and LF record separators (and a lone trailing newline)
 *   - a UTF-8 BOM on the first field
 *
 * Lenient where RFC 4180 is silent: a quote inside an UNQUOTED field is
 * taken literally, and characters after a closing quote (before the next
 * delimiter) are appended — real-world exports do both.
 */

export interface CsvRecord {
  /** 1-based physical line of the file where this record STARTS. Quoted
   *  fields may span lines, so subsequent records account for that. */
  line: number;
  fields: string[];
}

export class CsvParseError extends Error {
  constructor(
    message: string,
    /** 1-based line the offending construct started on. */
    public readonly line: number,
  ) {
    super(message);
    this.name = 'CsvParseError';
  }
}

export function parseCsv(text: string): CsvRecord[] {
  // Strip a UTF-8 BOM — Excel prepends one and it would otherwise glue
  // itself onto the first header name ("﻿firstName").
  let src = text;
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);

  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = '';
  let inQuotes = false;
  let quoteStartLine = 0;
  let line = 1;
  let recordStartLine = 1;
  /** True once the current record has any content (field chars or a comma) —
   *  distinguishes a genuinely empty line from "a,," style empties. */
  let recordDirty = false;

  const endField = () => {
    fields.push(field);
    field = '';
  };
  const endRecord = () => {
    endField();
    // Drop truly empty records (blank lines, the trailing newline). A line
    // of just commas still comes through — that's a data row with empty
    // cells and should fail validation loudly, not vanish.
    if (fields.length > 1 || fields[0] !== '' || recordDirty) {
      records.push({ line: recordStartLine, fields });
    }
    fields = [];
    recordDirty = false;
    recordStartLine = line;
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === '\n') line++;
        // Keep CR inside quotes only when it isn't part of a CRLF pair —
        // a quoted field containing Windows line breaks reads back as \n.
        if (ch === '\r' && src[i + 1] === '\n') continue;
        field += ch;
      }
      continue;
    }
    switch (ch) {
      case '"':
        if (field === '') {
          inQuotes = true;
          quoteStartLine = line;
          recordDirty = true;
        } else {
          field += ch; // lenient: quote mid-unquoted-field is literal
        }
        break;
      case ',':
        endField();
        recordDirty = true;
        break;
      case '\r':
        if (src[i + 1] === '\n') i++;
        line++;
        endRecord();
        break;
      case '\n':
        line++;
        endRecord();
        break;
      default:
        field += ch;
        recordDirty = true;
    }
  }
  if (inQuotes) {
    throw new CsvParseError(
      `Unterminated quoted field (opening quote on line ${quoteStartLine}).`,
      quoteStartLine,
    );
  }
  // Flush the final record when the file doesn't end with a newline.
  if (field !== '' || fields.length > 0) endRecord();

  return records;
}
