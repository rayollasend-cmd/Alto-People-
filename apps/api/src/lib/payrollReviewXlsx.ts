import ExcelJS from 'exceljs';
import { FLAG_LABEL, type PayrollReviewReport, type ReviewState } from './payrollReview.js';

/**
 * The pre-payroll review as a workbook an accountant can sort, filter and
 * tie out: Summary (sign-off, totals, cash, taxes, last payroll), Register
 * (every paycheck, real numbers, SUM totals, frozen header, autofilter),
 * To look at (the swings and first paychecks), and totals by department
 * and by state.
 */

const INK = 'FF111827';
const MUTED = 'FF6B7280';
const BAND = 'FF1F2A37';
const SUBTOTAL = 'FFEAEDF1';
const OK = 'FF027A48';
const ALERT = 'FFB42318';
const USD = '"$"#,##0.00;[Red]-"$"#,##0.00';
const HRS = '#,##0.00';
const PCT = '0.0%';

const THIN: Partial<ExcelJS.Borders> = {
  top: { style: 'thin', color: { argb: 'FFD1D5DB' } },
  left: { style: 'thin', color: { argb: 'FFD1D5DB' } },
  bottom: { style: 'thin', color: { argb: 'FFD1D5DB' } },
  right: { style: 'thin', color: { argb: 'FFD1D5DB' } },
};

function headerRow(row: ExcelJS.Row): void {
  row.eachCell((c) => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BAND } };
    c.alignment = { vertical: 'middle', wrapText: true };
    c.border = THIN;
  });
  row.height = 22;
}

function totalRow(row: ExcelJS.Row): void {
  row.eachCell((c) => {
    c.font = { bold: true, color: { argb: INK } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SUBTOTAL } };
    c.border = { ...THIN, top: { style: 'medium', color: { argb: INK } } };
  });
}

function signoffText(s: ReviewState): { text: string; color: string } {
  if (s.current) return { text: `Signed off by ${s.current.signedByName ?? 'a reviewer'} on ${new Date(s.current.signedAt).toUTCString()}${s.current.note ? ` — “${s.current.note}”` : ''}`, color: OK };
  if (s.stale) return { text: `Not signed: the numbers changed after ${s.stale.signedByName ?? 'the reviewer'} signed off on ${new Date(s.stale.signedAt).toUTCString()}.`, color: ALERT };
  return { text: s.required ? 'Not signed off yet. This run cannot pay out until someone signs.' : 'Sign-off is optional for this run.', color: MUTED };
}

export async function renderPayrollReviewXlsx(report: PayrollReviewReport, signoff: ReviewState): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = report.company;
  wb.created = new Date(report.generatedAt);

  summarySheet(wb, report, signoff);
  registerSheet(wb, report);
  flaggedSheet(wb, report);
  groupSheet(wb, 'By department', 'Department', report.byDepartment);
  groupSheet(wb, 'By state', 'Work state', report.byState);

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

function summarySheet(wb: ExcelJS.Workbook, r: PayrollReviewReport, s: ReviewState): void {
  const ws = wb.addWorksheet('Summary', { views: [{ showGridLines: false }] });
  ws.columns = [{ width: 38 }, { width: 18 }, { width: 18 }, { width: 18 }];
  ws.mergeCells('A1:D1');
  ws.getCell('A1').value = 'Pre-payroll review';
  ws.getCell('A1').font = { bold: true, size: 18, color: { argb: INK } };
  ws.mergeCells('A2:D2');
  ws.getCell('A2').value = `${r.company} · ${r.run.clientName ?? 'All clients'} · pay period ${r.run.periodStart} to ${r.run.periodEnd} · ${r.run.status.toLowerCase()}`;
  ws.getCell('A2').font = { color: { argb: MUTED } };
  ws.mergeCells('A3:D3');
  const so = signoffText(s);
  ws.getCell('A3').value = so.text;
  ws.getCell('A3').font = { bold: true, color: { argb: so.color } };
  ws.mergeCells('A4:D4');
  ws.getCell('A4').value = `Version ${r.fingerprint} · prepared ${r.generatedAt}`;
  ws.getCell('A4').font = { size: 8, color: { argb: MUTED } };

  let row = 6;
  const block = (title: string, lines: Array<[string, number | string, string?]>, total?: [string, number]) => {
    const h = ws.getRow(row);
    h.values = [title, 'Amount'];
    headerRow(h);
    row += 1;
    for (const [label, value, fmt] of lines) {
      const rr = ws.getRow(row);
      rr.values = [label, value];
      rr.getCell(2).numFmt = fmt ?? USD;
      rr.eachCell((c) => (c.border = THIN));
      row += 1;
    }
    if (total) {
      const tr = ws.getRow(row);
      tr.values = [total[0], total[1]];
      tr.getCell(2).numFmt = USD;
      totalRow(tr);
      row += 1;
    }
    row += 1;
  };
  const t = r.totals;
  block('Totals', [
    ['People paid', t.people, '0'],
    ['Contractors among them', t.contractors, '0'],
    ['Hours', t.hours, HRS],
    ['Gross pay', t.gross],
    ['Pre-tax deductions', t.preTax],
    ['Taxes withheld', t.employeeTaxes],
    ['Post-tax deductions', t.postTax],
    ['Other deductions', t.other],
    ['Reimbursements', t.reimbursements],
    ['Net pay', t.net],
    ['Employer taxes', t.employerTaxes],
    ['Employer cost', t.employerCost],
  ]);
  block('Cash required', r.cash.lines.map((l) => [l.label, l.amount] as [string, number]), ['Total cash required', r.cash.total]);
  block(
    'Taxes owed',
    [...r.taxes.employee.map((x) => [`${x.label} (withheld)`, x.amount] as [string, number]), ...r.taxes.employer.map((x) => [x.label, x.amount] as [string, number])],
    ['Total taxes', r.taxes.total],
  );
  if (r.previous) {
    const h = ws.getRow(row);
    h.values = [`Compared with ${r.previous.periodStart} to ${r.previous.periodEnd}`, 'Last payroll', 'This payroll', 'Change'];
    headerRow(h);
    row += 1;
    const cmp: Array<[string, number, number, string]> = [
      ['People paid', r.previous.people, t.people, '0'],
      ['Gross pay', r.previous.gross, t.gross, USD],
      ['Net pay', r.previous.net, t.net, USD],
      ['Employer taxes', r.previous.employerTaxes, t.employerTaxes, USD],
    ];
    for (const [label, before, now, fmt] of cmp) {
      const rr = ws.getRow(row);
      rr.values = [label, before, now, { formula: `C${row}-B${row}`, result: now - before }];
      for (const i of [2, 3, 4]) rr.getCell(i).numFmt = fmt;
      rr.eachCell((c) => (c.border = THIN));
      row += 1;
    }
  }
  ws.pageSetup = { orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
}

const REG_COLS: Array<{ header: string; key: string; width: number; fmt?: string }> = [
  { header: 'Person', key: 'name', width: 26 },
  { header: 'Department', key: 'department', width: 18 },
  { header: 'Work state', key: 'state', width: 10 },
  { header: 'Type', key: 'type', width: 11 },
  { header: 'Hours', key: 'hours', width: 9, fmt: HRS },
  { header: 'Rate', key: 'rate', width: 10, fmt: USD },
  { header: 'Gross', key: 'gross', width: 12, fmt: USD },
  { header: 'Pre-tax deductions', key: 'preTax', width: 12, fmt: USD },
  { header: 'Federal income tax', key: 'federal', width: 12, fmt: USD },
  { header: 'Social Security', key: 'socialSecurity', width: 12, fmt: USD },
  { header: 'Medicare', key: 'medicare', width: 11, fmt: USD },
  { header: 'State income tax', key: 'stateTax', width: 12, fmt: USD },
  { header: 'Local income tax', key: 'localTax', width: 11, fmt: USD },
  { header: 'Post-tax deductions', key: 'postTax', width: 12, fmt: USD },
  { header: 'Other deductions', key: 'other', width: 12, fmt: USD },
  { header: 'Reimbursements', key: 'reimbursements', width: 13, fmt: USD },
  { header: 'Net pay', key: 'net', width: 12, fmt: USD },
  { header: 'Employer taxes', key: 'employerTaxes', width: 12, fmt: USD },
  { header: 'Last net pay', key: 'priorNet', width: 12, fmt: USD },
  { header: 'Change in net', key: 'netChange', width: 12, fmt: USD },
  { header: 'Change %', key: 'netChangeShare', width: 10, fmt: PCT },
  { header: 'To look at', key: 'flags', width: 34 },
];

function registerSheet(wb: ExcelJS.Workbook, r: PayrollReviewReport): void {
  const ws = wb.addWorksheet('Register', { views: [{ state: 'frozen', ySplit: 1, xSplit: 1 }] });
  ws.columns = REG_COLS.map((c) => ({ header: c.header, key: c.key, width: c.width, style: c.fmt ? { numFmt: c.fmt } : {} }));
  headerRow(ws.getRow(1));
  const rows = [...r.rows].sort((a, b) => a.name.localeCompare(b.name));
  for (const x of rows) {
    ws.addRow({
      ...x,
      department: x.department ?? '',
      state: x.state ?? '',
      type: x.type === 'CONTRACTOR' ? 'Contractor' : 'W-2',
      priorNet: x.prior?.net ?? null,
      netChange: x.netChange,
      netChangeShare: x.netChangeShare,
      flags: x.flags.map((f) => FLAG_LABEL[f]).join(', '),
    }).eachCell((c) => (c.border = THIN));
  }
  const last = rows.length + 1;
  const tr = ws.addRow({ name: `Total · ${rows.length} people` });
  REG_COLS.forEach((c, i) => {
    if (!c.fmt || c.key === 'rate' || c.key === 'netChangeShare' || c.key === 'priorNet' || c.key === 'netChange') return;
    const col = ws.getColumn(i + 1).letter;
    const cell = tr.getCell(i + 1);
    cell.value = { formula: `SUM(${col}2:${col}${last})`, result: rows.reduce((s, x) => s + Number((x as unknown as Record<string, number>)[c.key] ?? 0), 0) };
    cell.numFmt = c.fmt;
  });
  totalRow(tr);
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: last, column: REG_COLS.length } };
  ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '1:1' };
  ws.headerFooter = { oddFooter: '&LPre-payroll review&RPage &P of &N' };
}

function flaggedSheet(wb: ExcelJS.Workbook, r: PayrollReviewReport): void {
  const ws = wb.addWorksheet('To look at', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: 'Person', key: 'name', width: 26 },
    { header: 'Why', key: 'why', width: 44 },
    { header: 'Last net pay', key: 'last', width: 14, style: { numFmt: USD } },
    { header: 'This net pay', key: 'now', width: 14, style: { numFmt: USD } },
    { header: 'Change', key: 'chg', width: 14, style: { numFmt: USD } },
    { header: 'Change %', key: 'pct', width: 10, style: { numFmt: PCT } },
  ];
  headerRow(ws.getRow(1));
  const flagged = r.rows.filter((x) => x.flags.length > 0);
  for (const x of flagged) {
    ws.addRow({ name: x.name, why: x.flags.map((f) => FLAG_LABEL[f]).join(', '), last: x.prior?.net ?? null, now: x.net, chg: x.netChange, pct: x.netChangeShare }).eachCell((c) => (c.border = THIN));
  }
  if (!flagged.length) ws.addRow({ name: 'Nothing unusual this run.' });
}

function groupSheet(wb: ExcelJS.Workbook, title: string, label: string, groups: PayrollReviewReport['byDepartment']): void {
  const ws = wb.addWorksheet(title);
  ws.columns = [
    { header: label, key: 'name', width: 30 },
    { header: 'People', key: 'people', width: 10 },
    { header: 'Gross', key: 'gross', width: 14, style: { numFmt: USD } },
    { header: 'Net', key: 'net', width: 14, style: { numFmt: USD } },
    { header: 'Employer taxes', key: 'employerTaxes', width: 16, style: { numFmt: USD } },
  ];
  headerRow(ws.getRow(1));
  for (const g of groups) ws.addRow(g).eachCell((c) => (c.border = THIN));
  const last = groups.length + 1;
  const tr = ws.addRow({ name: 'Total' });
  (['B', 'C', 'D', 'E'] as const).forEach((col, i) => {
    const key = (['people', 'gross', 'net', 'employerTaxes'] as const)[i];
    tr.getCell(col).value = { formula: `SUM(${col}2:${col}${last})`, result: groups.reduce((s, g) => s + g[key], 0) };
    if (i > 0) tr.getCell(col).numFmt = USD;
  });
  totalRow(tr);
}
