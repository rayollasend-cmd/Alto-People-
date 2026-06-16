import ExcelJS from 'exceljs';
import type { PayrollSheet } from './payrollSheet.js';
import type { PayrollSheetReportData } from './payrollSheetPdf.js';

/**
 * Payroll-ready sheet as a real .xlsx workbook with two tabs:
 *   - "Summary": one row per associate (regular / OT / total hours) + a TOTAL
 *     row. This is the payroll-ready figure a processor keys off.
 *   - "Detail": one row per associate per date worked, with that day's
 *     duration — the supporting "dates worked" breakdown.
 * Hours are real numbers (2-decimal format) so Excel can SUM/pivot them.
 */

function hours(min: number): number {
  return Math.round((min / 60) * 100) / 100;
}

function fmtRange(from: Date, toExclusive: Date): string {
  const last = new Date(toExclusive.getTime() - 1);
  const opts: Intl.DateTimeFormatOptions = {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  };
  return `${from.toLocaleDateString([], opts)} – ${last.toLocaleDateString([], opts)}`;
}

function dayLabel(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

const HEADER_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FF1F2A37' },
};
const HOURS_FMT = '0.00';

export async function renderPayrollSheetXlsx(
  data: PayrollSheetReportData,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Alto People';
  wb.created = data.generatedAt;

  buildSummarySheet(wb, data);
  buildDetailSheet(wb, data.sheet);

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

function buildSummarySheet(wb: ExcelJS.Workbook, data: PayrollSheetReportData) {
  const ws = wb.addWorksheet('Summary');
  ws.columns = [
    { key: 'associate', width: 32 },
    { key: 'regular', width: 14 },
    { key: 'overtime', width: 14 },
    { key: 'total', width: 14 },
    { key: 'days', width: 12 },
  ];

  ws.addRow(['Payroll sheet']).getCell(1).font = { bold: true, size: 16 };
  ws.addRow([data.clientName ?? 'All clients']);
  ws.addRow([fmtRange(data.rangeFrom, data.rangeTo)]);
  ws.addRow(['APPROVED time only · Overtime = over 40 hours per week (federal)']).getCell(
    1,
  ).font = { italic: true, color: { argb: 'FF666666' } };
  if (data.pendingCount > 0) {
    const warn = ws.addRow([
      `WARNING: ${data.pendingCount} entr${data.pendingCount === 1 ? 'y' : 'ies'} still pending review — totals are PROVISIONAL.`,
    ]);
    warn.getCell(1).font = { bold: true, color: { argb: 'FFB5360F' } };
  }
  ws.addRow([]);

  const header = ws.addRow([
    'Associate',
    'Regular (h)',
    'Overtime (h)',
    'Total (h)',
    'Days',
  ]);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.eachCell((cell) => {
    cell.fill = HEADER_FILL;
  });

  for (const a of data.sheet.associates) {
    const row = ws.addRow([
      a.name,
      hours(a.regularMinutes),
      hours(a.overtimeMinutes),
      hours(a.totalMinutes),
      a.days.length,
    ]);
    row.getCell(2).numFmt = HOURS_FMT;
    row.getCell(3).numFmt = HOURS_FMT;
    row.getCell(4).numFmt = HOURS_FMT;
  }

  const totalRow = ws.addRow([
    'TOTAL',
    hours(data.sheet.totalRegularMinutes),
    hours(data.sheet.totalOvertimeMinutes),
    hours(data.sheet.totalMinutes),
    '',
  ]);
  totalRow.font = { bold: true };
  totalRow.getCell(2).numFmt = HOURS_FMT;
  totalRow.getCell(3).numFmt = HOURS_FMT;
  totalRow.getCell(4).numFmt = HOURS_FMT;
}

function buildDetailSheet(wb: ExcelJS.Workbook, sheet: PayrollSheet) {
  const ws = wb.addWorksheet('Detail');
  ws.columns = [
    { key: 'associate', width: 32 },
    { key: 'date', width: 22 },
    { key: 'duration', width: 14 },
  ];

  const header = ws.addRow(['Associate', 'Date worked', 'Duration (h)']);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.eachCell((cell) => {
    cell.fill = HEADER_FILL;
  });

  for (const a of sheet.associates) {
    for (const d of a.days) {
      const row = ws.addRow([a.name, dayLabel(d.date), hours(d.minutes)]);
      row.getCell(3).numFmt = HOURS_FMT;
    }
  }
}
