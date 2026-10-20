import type { BooksBalanceSheet, BooksCashFlow, BooksProfitAndLoss, BooksReportRow, BooksTrialBalance } from '@alto-people/shared';
import { COLOR, createDoc, fmt, type Brand } from '../../lib/docKit/index.js';
import { XL, XL_FMT, tableSheet, titleBlock, toBuffer, workbook, styleHeader, styleTotal } from '../../lib/docKit/xlsx.js';

/**
 * The financial statements as documents, in the house style: a PDF to read,
 * print or hand the CPA (masthead, sections, a totals line under each, the
 * check figures at the bottom), and a workbook to tie out (real numbers,
 * money formats, frozen headers, SUM totals).
 */

export interface ExportMeta {
  company: string;
  brand: Brand;
  /** "Company" or "Coastal Resort · Housekeeping". */
  scope: string;
  generatedAt: Date;
}

const LAND = 'landscape' as const;

/* ---- PDF -------------------------------------------------------------------- */

type K = ReturnType<typeof createDoc>['k'];

function rowsTable(k: K, y: number, title: string, rows: BooksReportRow[], totalLabel: string, total: number, hint?: string): number {
  y = k.ensure(y, 60);
  y = k.section(title, y, hint);
  return k.table({
    y,
    rowH: 15,
    rows,
    empty: 'Nothing in this period.',
    columns: [
      { key: 'c', header: 'Account', width: 1.2, value: (r) => r.code },
      { key: 'n', header: '', width: 6, value: (r) => r.name },
      { key: 'a', header: 'Amount', width: 2, align: 'right', value: (r) => fmt.money(r.amount) },
    ],
    totals: { c: totalLabel, a: fmt.money(total) },
    onNewPage: (ny) => ny,
  });
}

function head(k: K, meta: ExportMeta, title: string, period: string): number {
  return k.masthead({
    title,
    brand: { ...meta.brand, name: meta.company, lines: [`Prepared ${fmt.dateTime(meta.generatedAt)}`] },
    subtitle: meta.scope,
    meta: [
      { label: 'Period', value: period },
      { label: 'Basis', value: 'Accrual' },
    ],
  });
}

export async function profitAndLossPdf(r: BooksProfitAndLoss, meta: ExportMeta): Promise<Buffer> {
  const { k } = createDoc({ title: `Profit and loss ${r.from} to ${r.to}`, author: meta.company, layout: LAND, margin: 36 });
  let y = head(k, meta, 'Profit and loss', fmt.dateRange(r.from, r.to));
  const t = r.totals;
  y = k.figures(
    [
      { label: 'Income', value: fmt.money(t.income) },
      { label: 'Gross profit', value: fmt.money(t.grossProfit), hint: t.grossMarginPct == null ? '' : `${t.grossMarginPct}% margin` },
      { label: 'Operating expenses', value: fmt.money(t.expenses) },
      { label: 'Net income', value: fmt.money(t.netIncome), tone: t.netIncome < 0 ? 'bad' : 'good', emphasis: true },
    ],
    y,
  );
  y = rowsTable(k, y, 'Income', r.sections.income, 'Total income', t.income);
  y = rowsTable(k, y, 'Cost of services', r.sections.costOfServices, 'Total cost of services', t.costOfServices);
  y = k.ensure(y, 24);
  k.text(`Gross profit  ${fmt.money(t.grossProfit)}`, k.L, y + 4, { size: 10, weight: 'semibold', width: k.width(), align: 'right' });
  y += 24;
  y = rowsTable(k, y, 'Operating expenses', r.sections.expenses, 'Total operating expenses', t.expenses);
  if (r.sections.otherIncome.length) y = rowsTable(k, y, 'Other income', r.sections.otherIncome, 'Total other income', t.otherIncome);
  if (r.sections.otherExpenses.length) y = rowsTable(k, y, 'Other expenses', r.sections.otherExpenses, 'Total other expenses', t.otherExpenses);
  y = k.ensure(y, 30);
  k.hr(y + 2, k.L, k.width(), COLOR.ink, 1);
  k.text('Net income', k.L, y + 8, { size: 11, weight: 'semibold' });
  k.text(fmt.money(t.netIncome), k.L, y + 8, { size: 11, weight: 'semibold', width: k.width(), align: 'right' });
  return k.finish({ reference: `Profit and loss · ${r.from} to ${r.to}` });
}

export async function balanceSheetPdf(r: BooksBalanceSheet, meta: ExportMeta): Promise<Buffer> {
  const { k } = createDoc({ title: `Balance sheet ${r.asOf}`, author: meta.company, layout: LAND, margin: 36 });
  let y = head(k, meta, 'Balance sheet', `As of ${fmt.date(r.asOf)}`);
  y = k.figures(
    [
      { label: 'Total assets', value: fmt.money(r.totals.assets) },
      { label: 'Total liabilities', value: fmt.money(r.totals.liabilities) },
      { label: 'Total equity', value: fmt.money(r.totals.equity) },
      { label: 'Balanced', value: r.totals.balanced ? 'Yes' : 'No', tone: r.totals.balanced ? 'good' : 'bad', emphasis: true },
    ],
    y,
  );
  y = rowsTable(k, y, 'Assets', r.assets, 'Total assets', r.totals.assets);
  y = rowsTable(k, y, 'Liabilities', r.liabilities, 'Total liabilities', r.totals.liabilities);
  y = rowsTable(k, y, 'Equity', r.equity, 'Total equity', r.totals.equity, `Fiscal year from ${fmt.date(r.fiscalYearStart)}`);
  y = k.ensure(y, 30);
  k.hr(y + 2, k.L, k.width(), COLOR.ink, 1);
  k.text('Total liabilities and equity', k.L, y + 8, { size: 11, weight: 'semibold' });
  k.text(fmt.money(r.totals.liabilitiesAndEquity), k.L, y + 8, { size: 11, weight: 'semibold', width: k.width(), align: 'right' });
  return k.finish({ reference: `Balance sheet · as of ${r.asOf}` });
}

export async function cashFlowPdf(r: BooksCashFlow, meta: ExportMeta): Promise<Buffer> {
  const { k } = createDoc({ title: `Cash flow ${r.from} to ${r.to}`, author: meta.company, layout: LAND, margin: 36 });
  let y = head(k, meta, 'Cash flow', fmt.dateRange(r.from, r.to));
  y = k.figures(
    [
      { label: 'Operating', value: fmt.money(r.totals.operating) },
      { label: 'Investing', value: fmt.money(r.totals.investing) },
      { label: 'Financing', value: fmt.money(r.totals.financing) },
      { label: 'Net change in cash', value: fmt.money(r.totals.netChange), emphasis: true },
    ],
    y,
  );
  const ops: BooksReportRow[] = [{ accountId: 'ni', code: '', name: 'Net income', type: '', subtype: '', amount: r.netIncome }, ...r.operating];
  y = rowsTable(k, y, 'Operating activities', ops, 'Cash from operations', r.totals.operating);
  y = rowsTable(k, y, 'Investing activities', r.investing, 'Cash from investing', r.totals.investing);
  y = rowsTable(k, y, 'Financing activities', r.financing, 'Cash from financing', r.totals.financing);
  y = k.ensure(y, 50);
  k.callout(
    r.totals.reconciles
      ? { tone: 'good', body: `Ties out: the bank accounts changed by ${fmt.money(r.totals.cashChange)} over the period.` }
      : { tone: 'bad', body: `Does not tie out: the bank accounts changed by ${fmt.money(r.totals.cashChange)}.` },
    y,
  );
  return k.finish({ reference: `Cash flow · ${r.from} to ${r.to}` });
}

export async function trialBalancePdf(r: BooksTrialBalance, meta: ExportMeta): Promise<Buffer> {
  const { k } = createDoc({ title: `Trial balance ${r.asOf}`, author: meta.company, layout: LAND, margin: 36 });
  let y = head(k, meta, 'Trial balance', `As of ${fmt.date(r.asOf)}`);
  y = k.callout(r.totals.balanced ? { tone: 'good', body: 'Debits equal credits.' } : { tone: 'bad', body: 'Debits and credits do not match.' }, y);
  k.table({
    y,
    rowH: 15,
    rows: r.rows,
    empty: 'No balances.',
    columns: [
      { key: 'c', header: 'Account', width: 1.2, value: (x) => x.code },
      { key: 'n', header: 'Name', width: 6, value: (x) => x.name },
      { key: 'd', header: 'Debit', width: 2, align: 'right', value: (x) => fmt.money(x.debit, { blankZero: true }) },
      { key: 'k', header: 'Credit', width: 2, align: 'right', value: (x) => fmt.money(x.credit, { blankZero: true }) },
    ],
    totals: { c: 'Total', d: fmt.money(r.totals.debit), k: fmt.money(r.totals.credit) },
    onNewPage: (ny) => ny,
  });
  return k.finish({ reference: `Trial balance · as of ${r.asOf}` });
}

/* ---- Excel ------------------------------------------------------------------ */

type Line = { section: string; code: string; name: string; amount: number | null; strong?: boolean };

/** One sheet of a statement: sections with their lines, subtotals in bold. */
function statementSheet(wb: ReturnType<typeof workbook>, name: string, title: string, subtitle: string, lines: Line[]): void {
  const ws = wb.addWorksheet(name.slice(0, 31), { views: [{ showGridLines: false }] });
  const start = titleBlock(ws, { title, subtitle, lastCol: 3 });
  ws.getColumn(1).width = 12;
  ws.getColumn(2).width = 48;
  ws.getColumn(3).width = 18;
  const headRow = ws.getRow(start);
  headRow.values = ['Account', 'Name', 'Amount'];
  styleHeader(headRow);
  let r = start + 1;
  let section = '';
  for (const l of lines) {
    if (l.section !== section) {
      section = l.section;
      const sr = ws.getRow(r++);
      sr.getCell(1).value = section;
      sr.getCell(1).font = { bold: true, color: { argb: XL.ink } };
    }
    const row = ws.getRow(r++);
    row.getCell(1).value = l.code;
    row.getCell(2).value = l.name;
    row.getCell(3).value = l.amount;
    row.getCell(3).numFmt = XL_FMT.money;
    if (l.strong) styleTotal(row);
  }
  ws.views = [{ state: 'frozen', ySplit: start, showGridLines: false }];
  ws.pageSetup = { orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: `${start}:${start}` };
}

const asLines = (section: string, rows: BooksReportRow[]): Line[] => rows.map((x) => ({ section, code: x.code, name: x.name, amount: x.amount }));
const total = (section: string, name: string, amount: number): Line => ({ section, code: '', name, amount, strong: true });

export async function profitAndLossXlsx(r: BooksProfitAndLoss, meta: ExportMeta): Promise<Buffer> {
  const wb = workbook({ company: meta.company, created: meta.generatedAt });
  const sub = `${meta.scope} · ${fmt.dateRange(r.from, r.to)}`;
  const t = r.totals;
  statementSheet(wb, 'Profit and loss', 'Profit and loss', sub, [
    ...asLines('Income', r.sections.income),
    total('Income', 'Total income', t.income),
    ...asLines('Cost of services', r.sections.costOfServices),
    total('Cost of services', 'Total cost of services', t.costOfServices),
    total('Cost of services', 'Gross profit', t.grossProfit),
    ...asLines('Operating expenses', r.sections.expenses),
    total('Operating expenses', 'Total operating expenses', t.expenses),
    total('Operating expenses', 'Operating income', t.operatingIncome),
    ...asLines('Other income', r.sections.otherIncome),
    ...asLines('Other expenses', r.sections.otherExpenses),
    total('Net', 'Net income', t.netIncome),
  ]);
  if (r.columns.length) {
    // The same statement by column: one row per account, one column per month or client.
    const ids = new Map<string, { code: string; name: string; section: string }>();
    for (const c of r.columns) for (const [sec, rows] of Object.entries(c.sections)) for (const x of rows as BooksReportRow[]) ids.set(x.accountId, { code: x.code, name: x.name, section: sec });
    const rows = [...ids.entries()].map(([id, a]) => {
      const o: Record<string, string | number> = { code: a.code, name: a.name, section: a.section };
      for (const c of r.columns) {
        const hit = Object.values(c.sections).flat().find((x) => (x as BooksReportRow).accountId === id) as BooksReportRow | undefined;
        o[c.key] = hit?.amount ?? 0;
      }
      return o;
    });
    tableSheet(wb, {
      name: 'By column',
      title: 'Profit and loss by column',
      subtitle: sub,
      columns: [
        { header: 'Account', key: 'code', width: 10 },
        { header: 'Name', key: 'name', width: 36 },
        ...r.columns.map((c) => ({ header: c.label, key: c.key, type: 'money' as const, total: false })),
      ],
      rows,
    });
  }
  return toBuffer(wb);
}

export async function balanceSheetXlsx(r: BooksBalanceSheet, meta: ExportMeta): Promise<Buffer> {
  const wb = workbook({ company: meta.company, created: meta.generatedAt });
  statementSheet(wb, 'Balance sheet', 'Balance sheet', `${meta.scope} · as of ${fmt.date(r.asOf)}`, [
    ...asLines('Assets', r.assets),
    total('Assets', 'Total assets', r.totals.assets),
    ...asLines('Liabilities', r.liabilities),
    total('Liabilities', 'Total liabilities', r.totals.liabilities),
    ...asLines('Equity', r.equity),
    total('Equity', 'Total equity', r.totals.equity),
    total('Equity', 'Total liabilities and equity', r.totals.liabilitiesAndEquity),
  ]);
  return toBuffer(wb);
}

export async function cashFlowXlsx(r: BooksCashFlow, meta: ExportMeta): Promise<Buffer> {
  const wb = workbook({ company: meta.company, created: meta.generatedAt });
  statementSheet(wb, 'Cash flow', 'Cash flow', `${meta.scope} · ${fmt.dateRange(r.from, r.to)}`, [
    { section: 'Operating activities', code: '', name: 'Net income', amount: r.netIncome },
    ...asLines('Operating activities', r.operating),
    total('Operating activities', 'Cash from operations', r.totals.operating),
    ...asLines('Investing activities', r.investing),
    total('Investing activities', 'Cash from investing', r.totals.investing),
    ...asLines('Financing activities', r.financing),
    total('Financing activities', 'Cash from financing', r.totals.financing),
    total('Net', 'Net change in cash', r.totals.netChange),
  ]);
  return toBuffer(wb);
}

export async function trialBalanceXlsx(r: BooksTrialBalance, meta: ExportMeta): Promise<Buffer> {
  const wb = workbook({ company: meta.company, created: meta.generatedAt });
  tableSheet(wb, {
    name: 'Trial balance',
    title: 'Trial balance',
    subtitle: `${meta.scope} · as of ${fmt.date(r.asOf)}`,
    columns: [
      { header: 'Account', key: 'code', width: 10 },
      { header: 'Name', key: 'name', width: 40 },
      { header: 'Type', key: 'type', width: 12 },
      { header: 'Debit', key: 'debit', type: 'money', total: true },
      { header: 'Credit', key: 'credit', type: 'money', total: true },
    ],
    rows: r.rows,
    totalsLabel: 'Total',
  });
  return toBuffer(wb);
}
