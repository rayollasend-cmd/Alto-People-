import { describe, expect, it } from 'vitest';
import { csvCell, toCsv } from '../csv.js';
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
