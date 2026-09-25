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

export interface PacketRenderOpts {
  watermark: string;
}

function fmtWhen(d: Date): string {
  return d.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export async function renderExternalPayrollSheetXlsx(
  data: ExternalPayrollSheetResult,
  generatedAt: Date,
  opts: PacketRenderOpts = { watermark: `Generated ${fmtWhen(generatedAt)}` },
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
    ['Download', opts.watermark],
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

  // Printed on every page of every sheet.
  ws.headerFooter = { oddFooter: `&L&8${opts.watermark}&R&8Page &P of &N`, evenFooter: `&L&8${opts.watermark}&R&8Page &P of &N` };

  // ---- Changes since last packet ---------------------------------------
  const cs = wb.addWorksheet('Changes since last packet', {
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  cs.headerFooter = { oddFooter: `&L&8${opts.watermark}&R&8Page &P of &N` };
  cs.mergeCells('A1:K1');
  cs.getCell('A1').value = `Changes since last packet${data.sinceLastPacket ? ` (${fmtWhen(data.sinceLastPacket)})` : ' (since the period start)'}`;
  cs.getCell('A1').font = { bold: true, size: 14, color: { argb: INK } };
  cs.mergeCells('A2:K2');
  cs.getCell('A2').value =
    'Every bank, pay card, W-4, legal name, SSN/TIN and home address change, with who made it and whether Finance verified it by phone. UNVERIFIED and HELD rows must not be paid to the new account.';
  cs.getCell('A2').font = { size: 9, color: { argb: MUTED } };
  const CH = [
    ['Associate', 26], ['In packet', 10], ['Change', 18], ['Before', 30], ['After', 30], ['By', 22], ['On behalf', 10],
    ['When', 20], ['Status', 14], ['Verified by / when', 30], ['Risk flags', 36],
  ] as const;
  const h = cs.getRow(4);
  CH.forEach(([label, width], i) => {
    h.getCell(i + 1).value = label;
    cs.getColumn(i + 1).width = width;
  });
  h.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
  h.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BAND } };
    cell.border = THIN;
  });
  data.changes.forEach((c, i) => {
    const r = cs.getRow(5 + i);
    const unverified = c.status === 'PENDING' || c.status === 'HELD';
    const values = [
      c.associateName,
      c.inPacket ? 'Yes' : 'No',
      c.kindLabel + (c.highRisk ? ' (HIGH RISK)' : ''),
      c.oldSummary,
      c.newSummary,
      c.by,
      c.onBehalf ? 'Yes' : 'No',
      fmtWhen(c.at),
      c.status === 'PENDING' ? 'UNVERIFIED' : c.status,
      c.verifiedBy ? `${c.verifiedBy} · ${c.verifiedAt ? fmtWhen(c.verifiedAt) : ''}` : '',
      c.riskFlags.join(', '),
    ];
    values.forEach((v, j) => {
      const cell = r.getCell(j + 1);
      cell.value = v;
      cell.border = THIN;
      cell.alignment = { vertical: 'middle', wrapText: true };
      if (unverified) cell.font = { bold: j === 8, color: { argb: WARN } };
    });
  });
  if (data.changes.length === 0) {
    cs.getCell('A5').value = 'No financial changes.';
    cs.getCell('A5').font = { color: { argb: MUTED } };
  }
  cs.views = [{ state: 'frozen', ySplit: 4 }];

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
