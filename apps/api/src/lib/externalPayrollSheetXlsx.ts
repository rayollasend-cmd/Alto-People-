import ExcelJS from 'exceljs';
import {
  EXTERNAL_PAYROLL_COLUMNS,
  type ExternalPayrollSheetResult,
} from './externalPayrollSheet.js';

/**
 * External payroll sheet as .xlsx — the file that gets sent to an outside
 * payroll bureau.
 *
 * Two formatting decisions matter more than they look:
 *
 *  - SSN, routing and account numbers are written as TEXT, not numbers.
 *    Excel treats a numeric-looking string as a number, which strips leading
 *    zeros (a routing number starting 0-something silently loses a digit) and
 *    switches long account numbers to scientific notation. Either one makes
 *    the file fail at the bank. Explicit '@' number format plus string cell
 *    values keeps them intact through a round-trip.
 *  - The confidentiality banner is the first thing in the sheet, because this
 *    file gets forwarded and printed and left in inboxes.
 */

const BAND = 'FF1F2A37';
const MUTED = 'FF6B7280';
const INK = 'FF111827';
const WARN = 'FFB5360F';
const TEXT_FMT = '@';
const USD_FMT = '"$"#,##0.00';
const HOURS_FMT = '0.00';

const THIN: Partial<ExcelJS.Borders> = {
  top: { style: 'thin', color: { argb: 'FFD1D5DB' } },
  left: { style: 'thin', color: { argb: 'FFD1D5DB' } },
  bottom: { style: 'thin', color: { argb: 'FFD1D5DB' } },
  right: { style: 'thin', color: { argb: 'FFD1D5DB' } },
};

/** Columns whose values must survive as literal digit strings. */
const TEXT_KEYS = new Set(['ssn', 'routingNumber', 'accountNumber', 'phone', 'dob']);

function fmtRange(from: Date, toExclusive: Date): string {
  const last = new Date(toExclusive.getTime() - 1);
  const opts: Intl.DateTimeFormatOptions = {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  };
  return `${from.toLocaleDateString('en-US', opts)} – ${last.toLocaleDateString('en-US', opts)}`;
}

export async function renderExternalPayrollSheetXlsx(
  data: ExternalPayrollSheetResult,
  generatedAt: Date,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Alto People';
  wb.created = generatedAt;

  const ws = wb.addWorksheet('External Payroll', {
    views: [{ state: 'frozen', ySplit: 0 }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  const lastCol = String.fromCharCode(64 + EXTERNAL_PAYROLL_COLUMNS.length);

  ws.mergeCells(`A1:${lastCol}1`);
  const title = ws.getCell('A1');
  title.value = 'External Payroll Sheet';
  title.font = { bold: true, size: 18, color: { argb: INK } };
  ws.getRow(1).height = 24;

  ws.mergeCells(`A2:${lastCol}2`);
  const conf = ws.getCell('A2');
  conf.value =
    'CONFIDENTIAL — contains Social Security numbers and bank account details. Transmit only over an encrypted channel to the designated payroll provider.';
  conf.font = { bold: true, size: 9, color: { argb: WARN } };

  const meta: Array<[string, string]> = [
    ['Employer', data.clientName ?? 'All clients'],
    ['Pay period', fmtRange(data.from, data.to)],
    ['Status', 'Approved time only'],
    ['Employees', String(data.rows.length)],
    ['Generated', generatedAt.toLocaleString('en-US')],
  ];
  let row = 4;
  for (const [label, value] of meta) {
    ws.getCell(`A${row}`).value = label.toUpperCase();
    ws.getCell(`A${row}`).font = { size: 8, color: { argb: MUTED } };
    ws.mergeCells(`B${row}:${lastCol}${row}`);
    ws.getCell(`B${row}`).value = value;
    ws.getCell(`B${row}`).font = { bold: true, size: 10, color: { argb: INK } };
    row += 1;
  }

  const gapNotes = describeGaps(data);
  if (gapNotes) {
    ws.mergeCells(`A${row}:${lastCol}${row}`);
    const warn = ws.getCell(`A${row}`);
    warn.value = gapNotes;
    warn.font = { bold: true, size: 9, color: { argb: WARN } };
    row += 1;
  }
  if (data.truncated) {
    ws.mergeCells(`A${row}:${lastCol}${row}`);
    const warn = ws.getCell(`A${row}`);
    warn.value =
      'INCOMPLETE — the time-entry scan hit its cap. Narrow the range or filter by client and regenerate before sending.';
    warn.font = { bold: true, size: 9, color: { argb: WARN } };
    row += 1;
  }

  const headerRowIdx = row + 1;
  const headerRow = ws.getRow(headerRowIdx);
  EXTERNAL_PAYROLL_COLUMNS.forEach((col, i) => {
    headerRow.getCell(i + 1).value = col.label;
    ws.getColumn(i + 1).width = col.width;
  });
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
  headerRow.height = 18;
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BAND } };
    cell.alignment = { vertical: 'middle', wrapText: true };
    cell.border = THIN;
  });

  data.rows.forEach((r, rIdx) => {
    const excelRow = ws.getRow(headerRowIdx + 1 + rIdx);
    EXTERNAL_PAYROLL_COLUMNS.forEach((col, cIdx) => {
      const cell = excelRow.getCell(cIdx + 1);
      const value = r[col.key];
      if (TEXT_KEYS.has(col.key)) {
        // Force text so leading zeros survive and long account numbers don't
        // flip to scientific notation.
        cell.numFmt = TEXT_FMT;
        cell.value = value === null || value === undefined ? '' : String(value);
      } else if (col.key === 'payRate') {
        cell.numFmt = USD_FMT;
        cell.value = value as number | null;
      } else if (col.key === 'regularHours' || col.key === 'overtimeHours') {
        cell.numFmt = HOURS_FMT;
        cell.value = value as number;
      } else {
        cell.value = (value ?? '') as string;
      }
      cell.border = THIN;
      cell.alignment = { vertical: 'middle' };
    });
  });

  // Freeze through the header and add an autofilter over the table only.
  ws.views = [{ state: 'frozen', ySplit: headerRowIdx }];
  if (data.rows.length > 0) {
    ws.autoFilter = {
      from: { row: headerRowIdx, column: 1 },
      to: { row: headerRowIdx + data.rows.length, column: EXTERNAL_PAYROLL_COLUMNS.length },
    };
  }

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

/** One-line summary of blank cells, or null when the sheet is complete. */
export function describeGaps(data: ExternalPayrollSheetResult): string | null {
  const { gaps } = data;
  const parts: string[] = [];
  if (gaps.missingW4 > 0) parts.push(`${gaps.missingW4} without a W-4 on file`);
  if (gaps.unreadableSsn > 0) parts.push(`${gaps.unreadableSsn} with no readable SSN`);
  if (gaps.missingBankDetails > 0)
    parts.push(`${gaps.missingBankDetails} without complete bank details`);
  if (gaps.missingPayRate > 0) parts.push(`${gaps.missingPayRate} with no pay rate`);
  if (parts.length === 0) return null;
  return `INCOMPLETE ROWS — ${parts.join(', ')}. These will be rejected or unpaid by the provider; fix before sending.`;
}
