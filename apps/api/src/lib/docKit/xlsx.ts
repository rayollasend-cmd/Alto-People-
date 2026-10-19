import ExcelJS from 'exceljs';

/**
 * The house style for every workbook the platform exports: a title block
 * (what, whose, which period, when it was made), a navy header row that
 * stays frozen, real numbers with money/hours/percent formats so Excel
 * can SUM and pivot, an autofilter, a totals row built from formulas, and
 * print setup (landscape, fit to width, the header repeated, "Page x of
 * y" in the footer).
 *
 *   const wb = workbook({ company: 'Alto HR' });
 *   tableSheet(wb, { name: 'Register', title: 'Payroll register', subtitle: 'Sep 26 – Oct 9, 2026',
 *     columns: [{ header: 'Person', key: 'name', width: 26 }, { header: 'Net', key: 'net', type: 'money', total: true }],
 *     rows });
 *   return toBuffer(wb);
 */

export const XL = {
  ink: 'FF0B1832',
  muted: 'FF6B7588',
  band: 'FF0F1F3D',
  brand: 'FFB8862B',
  wash: 'FFF4F6F9',
  subtotal: 'FFEAEDF1',
  rule: 'FFDCE1E8',
  good: 'FF1E7B4F',
  bad: 'FFB42318',
  zebra: 'FFFAFBFC',
} as const;

export const XL_FMT = {
  money: '"$"#,##0.00;[Red]-"$"#,##0.00',
  hours: '#,##0.00',
  number: '#,##0',
  decimal: '#,##0.00',
  percent: '0.0%',
  date: 'mmm d, yyyy',
} as const;

export type XlType = 'text' | 'money' | 'hours' | 'number' | 'decimal' | 'percent' | 'date';

export interface XlColumn<R> {
  header: string;
  key: string;
  width?: number;
  type?: XlType;
  /** A SUM in the totals row (numeric columns). */
  total?: boolean;
  value?: (row: R) => string | number | Date | null | undefined;
}

const THIN: Partial<ExcelJS.Borders> = {
  top: { style: 'thin', color: { argb: XL.rule } },
  left: { style: 'thin', color: { argb: XL.rule } },
  bottom: { style: 'thin', color: { argb: XL.rule } },
  right: { style: 'thin', color: { argb: XL.rule } },
};

export function workbook(o: { company: string; created?: Date }): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = o.company;
  wb.company = o.company;
  wb.created = o.created ?? new Date();
  return wb;
}

/** Title block on rows 1–3; returns the first free row. */
export function titleBlock(ws: ExcelJS.Worksheet, o: { title: string; subtitle?: string; note?: string; lastCol: number }): number {
  const end = ws.getColumn(Math.max(1, o.lastCol)).letter;
  ws.mergeCells(`A1:${end}1`);
  ws.getCell('A1').value = o.title;
  ws.getCell('A1').font = { bold: true, size: 16, color: { argb: XL.ink } };
  ws.getRow(1).height = 24;
  let row = 2;
  if (o.subtitle) {
    ws.mergeCells(`A${row}:${end}${row}`);
    ws.getCell(`A${row}`).value = o.subtitle;
    ws.getCell(`A${row}`).font = { color: { argb: XL.muted } };
    row += 1;
  }
  if (o.note) {
    ws.mergeCells(`A${row}:${end}${row}`);
    ws.getCell(`A${row}`).value = o.note;
    ws.getCell(`A${row}`).font = { size: 9, color: { argb: XL.muted } };
    row += 1;
  }
  return row + 1;
}

export function styleHeader(row: ExcelJS.Row): void {
  row.eachCell((c) => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL.band } };
    c.alignment = { vertical: 'middle', wrapText: true };
    c.border = THIN;
  });
  row.height = 22;
}

export function styleTotal(row: ExcelJS.Row): void {
  row.eachCell((c) => {
    c.font = { bold: true, color: { argb: XL.ink } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL.subtotal } };
    c.border = { ...THIN, top: { style: 'medium', color: { argb: XL.ink } } };
  });
}

/**
 * One sheet holding one table, in the house style. Returns the sheet.
 */
export function tableSheet<R>(
  wb: ExcelJS.Workbook,
  o: { name: string; title: string; subtitle?: string; note?: string; columns: XlColumn<R>[]; rows: R[]; totalsLabel?: string; landscape?: boolean },
): ExcelJS.Worksheet {
  const ws = wb.addWorksheet(o.name.slice(0, 31), { views: [{ showGridLines: false }] });
  const start = titleBlock(ws, { title: o.title, subtitle: o.subtitle, note: o.note, lastCol: o.columns.length });
  o.columns.forEach((c, i) => {
    ws.getColumn(i + 1).width = c.width ?? (c.type && c.type !== 'text' ? 14 : 22);
  });
  const head = ws.getRow(start);
  head.values = o.columns.map((c) => c.header);
  styleHeader(head);
  o.rows.forEach((r, ri) => {
    const row = ws.getRow(start + 1 + ri);
    o.columns.forEach((c, i) => {
      const v = c.value ? c.value(r) : (r as Record<string, unknown>)[c.key];
      const cell = row.getCell(i + 1);
      cell.value = v instanceof Date ? v : (v as ExcelJS.CellValue) ?? null;
      if (c.type && c.type !== 'text') cell.numFmt = XL_FMT[c.type];
      cell.border = THIN;
      if (ri % 2 === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFAFBFC' } };
    });
  });
  const last = start + o.rows.length;
  if (o.columns.some((c) => c.total) && o.rows.length > 0) {
    const tr = ws.getRow(last + 1);
    tr.getCell(1).value = o.totalsLabel ?? `Total · ${o.rows.length}`;
    o.columns.forEach((c, i) => {
      if (!c.total) return;
      const col = ws.getColumn(i + 1).letter;
      const cell = tr.getCell(i + 1);
      cell.value = { formula: `SUM(${col}${start + 1}:${col}${last})` };
      if (c.type && c.type !== 'text') cell.numFmt = XL_FMT[c.type];
    });
    styleTotal(tr);
  }
  ws.views = [{ state: 'frozen', ySplit: start, xSplit: 1, showGridLines: false }];
  if (o.rows.length) ws.autoFilter = { from: { row: start, column: 1 }, to: { row: last, column: o.columns.length } };
  ws.pageSetup = { orientation: o.landscape === false ? 'portrait' : 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: `${start}:${start}` };
  ws.headerFooter = { oddFooter: `&L${o.title.replace(/&/g, '&&')}&RPage &P of &N` };
  return ws;
}

export async function toBuffer(wb: ExcelJS.Workbook): Promise<Buffer> {
  return Buffer.from(await wb.xlsx.writeBuffer());
}
