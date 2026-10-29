import { describe, expect, it } from 'vitest';
import { csvCell, csvNumber, dollarsAsNumber, isPlainNumberText, toCsv } from '../csv.js';
import { isHttpUrl, safeHref } from '../safeUrl.js';

describe('csvCell — formula injection', () => {
  it('neutralises every spreadsheet formula trigger', () => {
    // These execute on open in Excel / Sheets / LibreOffice. The classic
    // payload is =cmd|'/c calc'!A1.
    for (const trigger of ['=', '+', '-', '@']) {
      expect(csvCell(`${trigger}cmd|'/c calc'!A1`)).toMatch(/^'/);
    }
    expect(csvCell('\tlead-tab')).toMatch(/^'/);
  });

  it('leaves ordinary values completely alone', () => {
    expect(csvCell('Maria Lopez')).toBe('Maria Lopez');
    expect(csvCell(42)).toBe('42');
    expect(csvCell(null)).toBe('');
  });

  it('still quotes per RFC-4180 and doubles embedded quotes', () => {
    expect(csvCell('Smith, John')).toBe('"Smith, John"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
  });

  it('guards a value that is BOTH a formula and needs quoting', () => {
    // The apostrophe must survive the quote wrapping.
    expect(csvCell('=SUM(A1,A2)')).toBe('"\'=SUM(A1,A2)"');
  });
});

describe('csvCell — numbers stay numbers (audit 2026-10-29 MONEY-9/22)', () => {
  it('writes a negative number as a number, not guarded text', () => {
    // '-205.89 is text to Excel: a refund, a loss or a cash outflow that won't sum.
    expect(csvCell(-205.89)).toBe('-205.89');
    expect(csvCell(-8)).toBe('-8');
    expect(csvCell(0)).toBe('0');
  });

  it('leaves text that is only a number unguarded', () => {
    for (const v of ['-205.89', '-1,234.56', '-$80.00', '-12%', '-.5', '1234']) {
      expect(isPlainNumberText(v)).toBe(true);
      expect(csvCell(v)).not.toMatch(/^'/);
    }
    // ...but quotes one that carries a comma, per RFC-4180.
    expect(csvCell('-1,234.56')).toBe('"-1,234.56"');
  });

  it('still guards anything that is not purely a number', () => {
    for (const v of ['-1+2', '-2*3', '-A1', '-', '--5', '-1,2', '+15551234567', '=1', '@SUM(1)']) {
      expect(isPlainNumberText(v)).toBe(false);
      expect(csvCell(v).replace(/^"/, '')).toMatch(/^'/);
    }
  });

  it('drops float tails at a spreadsheet\'s 15 significant digits', () => {
    expect(csvCell(100.82000000000001)).toBe('100.82');
    expect(csvCell(0.1 + 0.2)).toBe('0.3');
    expect(csvCell(160.92000000000002)).toBe('160.92');
    expect(csvNumber(1234567.891)).toBe('1234567.891');
    expect(csvNumber(Number.NaN)).toBe('');
  });

  it('a display dollar figure reaches the file as a number, a lone dash as an empty cell (MONEY-29)', () => {
    expect(csvCell('$29,885.44')).toBe('29885.44');
    expect(csvCell('-$204.13')).toBe('-204.13');
    expect(csvCell('\u2212$3,908.97')).toBe('-3908.97');
    expect(csvCell('$0.00')).toBe('0.00');
    expect(csvCell('\u2014')).toBe('');
    // Words with money in them are words.
    expect(csvCell('Needs 1099 ($600+)')).toBe('Needs 1099 ($600+)');
    expect(csvCell('$12 per hour')).toBe('$12 per hour');
    expect(dollarsAsNumber('US$5')).toBeNull();
  });

  it('writes booleans as words', () => {
    expect(csvCell(true)).toBe('true');
  });
});

describe('toCsv', () => {
  it('emits a UTF-8 BOM and CRLF line endings', () => {
    const out = toCsv([
      ['Name', 'Hours'],
      ['José', 40],
    ]);
    // Without the BOM Excel mojibakes "José".
    expect(out.startsWith('﻿')).toBe(true);
    expect(out).toContain('\r\n');
    expect(out).toContain('José');
  });
});

describe('safeHref / isHttpUrl', () => {
  it('rejects the schemes that execute', () => {
    // zod's .url() accepts these, which is how a public careers form
    // could store a script that ran in a recruiter's session.
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(isHttpUrl('vbscript:msgbox(1)')).toBe(false);
    expect(isHttpUrl('file:///etc/passwd')).toBe(false);
  });

  it('accepts ordinary web links', () => {
    expect(isHttpUrl('https://example.com/resume.pdf')).toBe(true);
    expect(isHttpUrl('http://example.com')).toBe(true);
  });

  it('safeHref returns undefined for unsafe values so no link renders', () => {
    expect(safeHref('javascript:alert(1)')).toBeUndefined();
    expect(safeHref(null)).toBeUndefined();
    expect(safeHref('https://example.com')).toBe('https://example.com');
  });
});
