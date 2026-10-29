import { describe, expect, it } from 'vitest';
import { toCsv } from '@alto-people/shared';
import { chartCsvCell, chartCsvRows, type ChartColumn } from '@/components/ui/ChartFrame';
import { csvCell } from '@/lib/csv';

/**
 * Exports (audit 2026-10-29 MONEY-9/22/29): one writer, numbers stay
 * numbers — a negative amount is not guarded into text, a float tail never
 * reaches the file, and a chart's CSV carries raw values, not "$29,885.44"
 * or "—".
 */

const money = (v: unknown) => (typeof v === 'number' ? `$${v.toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '—');

describe('chart CSV', () => {
  const cols: ChartColumn[] = [
    { key: 'week', label: 'Week', format: (v) => `Week of ${String(v)}` },
    { key: 'net', label: 'Net', numeric: true, format: money },
  ];

  it('exports the raw number, not the display string', () => {
    expect(chartCsvCell(cols[1]!, -29885.44)).toBe(-29885.44);
    expect(chartCsvCell(cols[1]!, null)).toBe('');
    expect(chartCsvCell(cols[1]!, undefined)).toBe('');
  });

  it('keeps a text column\'s label', () => {
    expect(chartCsvCell(cols[0]!, 'Oct 30')).toBe('Week of Oct 30');
  });

  it('writes a file a spreadsheet can sum', () => {
    const file = toCsv(chartCsvRows(cols, [{ week: 'Oct 30', net: -29885.44 }, { week: 'Nov 6', net: null }]));
    expect(file).toBe('﻿Week,Net\r\nWeek of Oct 30,-29885.44\r\nWeek of Nov 6,');
  });

  it('honors a column\'s own csv value', () => {
    expect(chartCsvCell({ key: 'p', label: 'Share', numeric: true, csv: (v) => Number(v) / 100 }, 42)).toBe(0.42);
  });
});

describe('csvCell (web re-export of the shared writer)', () => {
  it('negative amounts are numbers; formulas are still guarded', () => {
    expect(csvCell(-205.89)).toBe('-205.89');
    // A display dollar figure is written as the number it shows.
    expect(csvCell('-$3,908.97')).toBe('-3908.97');
    expect(csvCell('—')).toBe('');
    expect(csvCell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
    expect(csvCell(100.82000000000001)).toBe('100.82');
  });
});
