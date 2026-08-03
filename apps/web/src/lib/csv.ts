import { csvCell, toCsv } from '@alto-people/shared';

/**
 * Shared CSV download helper. Cell escaping and file assembly now live in
 * @alto-people/shared so the browser and the API produce byte-identical
 * files — including formula-injection guarding, which each of the four
 * private copies was missing.
 *
 * Usage:
 *   downloadCsv('people-2026-07-26.csv', [
 *     ['Name', 'Status', 'Start date'],
 *     ...rows.map((r) => [r.name, r.status, r.startDate ?? '']),
 *   ]);
 */

export { csvCell };

export function downloadCsv(
  filename: string,
  rows: Array<Array<string | number | null | undefined>>,
): void {
  // toCsv emits the UTF-8 BOM (without it Excel mojibakes names like
  // "José") and RFC-4180 CRLF line endings.
  const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  // Attached before click and revoked on the next tick: a detached
  // anchor's click() is unreliable in Firefox, and a synchronous revoke
  // can abort the download in Safari. Matches the blob-download path
  // already used by payrollApi / timeApi.
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
