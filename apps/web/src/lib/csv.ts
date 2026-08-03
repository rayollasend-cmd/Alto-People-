/**
 * Shared CSV download helper — RFC-4180 quoting (embedded quotes doubled,
 * cells containing commas/quotes/newlines wrapped). Pages were growing
 * private copies of this (OshaWcEeoHome, AnalyticsHome, ReportsHome — the
 * last with a JSON.stringify serializer that produced malformed files);
 * every "Export CSV" button should call this instead.
 *
 * Usage:
 *   downloadCsv('people-2026-07-26.csv', [
 *     ['Name', 'Status', 'Start date'],
 *     ...rows.map((r) => [r.name, r.status, r.startDate ?? '']),
 *   ]);
 */

export function csvCell(v: string | number | null | undefined): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function downloadCsv(
  filename: string,
  rows: Array<Array<string | number | null | undefined>>,
): void {
  const text = rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
  // UTF-8 BOM: without it Excel guesses the encoding and mojibakes names
  // like "José" (the scheduling export carried this fix privately; every
  // CSV in the app deserves it).
  const blob = new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
