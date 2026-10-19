import { createHash } from 'node:crypto';
import { getBrandingSync } from './branding.js';
import { COLOR, SIZE, createDoc, fmt, type Brand, type Column, type Kit } from './docKit/index.js';

/**
 * The paystub — the earnings statement a person keeps for every paycheck.
 *
 * Read the way an employee reads it: what they were paid and how (net pay
 * and the account or check it went to), then where the gross went
 * (earnings, every tax by jurisdiction, every deduction by name), what
 * the employer paid on top, and the balances and figures kept for the
 * record. Current and year-to-date on every money line.
 *
 * It carries what state wage-statement laws require (Cal. Labor Code
 * §226(a): gross and net wages, total hours, every rate with its hours,
 * all deductions, the inclusive pay-period dates, the employee's name and
 * ID, the employer's legal name and address, paid sick leave available;
 * N.Y. Labor Law §195(3) adds the pay basis and the employer's phone;
 * most other states ask for a subset of these). Rendered on docKit, in
 * English or Spanish.
 */

// ----- Public data shape --------------------------------------------------

export interface PaystubEarningLine {
  label: string;
  /** Null for flat-amount earnings (salary, bonus, tips…). */
  hours: number | null;
  rate: number | null;
  amount: number;
  /** Year to date for this kind of earning, when known. */
  ytd?: number | null;
}

export interface PaystubLine {
  label: string;
  current: number;
  ytd: number;
}

export interface PaystubData {
  company: {
    name: string;
    addressLine1?: string | null;
    city?: string | null;
    state?: string | null;
    zip?: string | null;
    ein?: string | null;
    phone?: string | null;
  };
  associate: {
    firstName: string;
    lastName: string;
    email: string | null;
    addressLine1: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
    /** Short display id (e.g. last 6 of the UUID) for the employee block. */
    employeeId?: string | null;
    /** Last four of the SSN, shown masked (Cal. Labor Code §226(a)(7) allows last four or an employee ID). */
    ssnLast4?: string | null;
  };
  period: { start: string; end: string; payDate?: string | null };
  /** Per-kind earning lines (regular / OT / bonus / tips …). */
  earnings: PaystubEarningLine[];
  gross: { current: number; ytd: number };
  /** Employee-withheld taxes, each with a YTD figure. */
  taxes: PaystubLine[];
  taxesTotal: { current: number; ytd: number };
  /** Pre-tax deductions (Section 125 / retirement). Empty when none. */
  preTaxDeductions: PaystubLine[];
  /** Post-tax deductions (garnishments, Roth…). Empty when none. */
  postTaxDeductions: PaystubLine[];
  /** What the employer paid on top of the check (401(k) match, health premium share, HSA seed). */
  employerContributions?: PaystubLine[];
  /** Non-taxable reimbursements folded into net (accountable-plan rule). */
  reimbursements?: { current: number; ytd: number };
  net: { current: number; ytd: number };
  /** Employer-paid taxes — informational, never deducted from the worker. */
  employer: { fica: number; medicare: number; futa: number; suta: number };
  /** How the money was paid — direct deposit account or check. */
  payDistribution?: { label: string; detail?: string | null };
  /** Every place the net went, when it was split across accounts (or a check). */
  payDistributions?: Array<{ label: string; detail?: string | null; amount: number }>;
  /** How this check was paid; decides the "non-negotiable" marking. Inferred from payDistribution when absent. */
  payMethod?: 'DIRECT_DEPOSIT' | 'PAY_CARD' | 'CHECK' | 'OTHER';
  /** Hourly, salary, daily … (N.Y. Labor Law §195(3)). */
  payBasis?: string | null;
  /** Statement language; English when absent. */
  language?: 'en' | 'es';
  meta: { runId: string; itemId: string; issuedAt: string };
  /** AMENDMENT runs — corrected-paystub banner with the HR reason. */
  amendment?: { reason: string; sourceRunId: string };
  /** VOIDED items — diagonal watermark + audit footer. */
  voided?: { voidedAt: string; reason: string | null };
  /** Total hours worked this period (CA Labor Code §226(a)(2)). */
  hoursTotal?: number | null;
  /**
   * Amounts shown for the record and not deducted — the 2026 W-2 Box 12
   * figures (TP tips, TT qualified overtime premium, TA employer Trump
   * account contribution).
   */
  informational?: PaystubLine[];
  /** Paid sick leave available (CA Labor Code §246(i) and similar state rules). */
  sickLeave?: { availableHours: number };
  /** Other time-off balances (vacation, PTO), in hours. */
  timeOff?: Array<{ label: string; availableHours: number; usedHours?: number | null }>;
  /** Plain notes about this check (an annual limit reached, a Roth catch-up). */
  notes?: string[];
}

export function hashPdf(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

// ----- Words ---------------------------------------------------------------

const EN = {
  title: 'Earnings statement',
  corrected: 'Corrected earnings statement',
  payDate: 'Pay date',
  payPeriod: 'Pay period',
  employee: 'Employee',
  employer: 'Employer',
  employeeId: 'Employee ID',
  ssn: 'SSN',
  payBasis: 'Pay basis',
  gross: 'Gross pay',
  taxes: 'Taxes',
  deductions: 'Deductions',
  net: 'Net pay',
  ytd: 'YTD',
  earnings: 'Earnings',
  hours: 'Hours',
  rate: 'Rate',
  current: 'Current',
  yearToDate: 'Year to date',
  totalHours: 'Total hours worked',
  taxesWithheld: 'Taxes withheld',
  totalTaxes: 'Total taxes',
  preTax: 'Before-tax deductions',
  preTaxHint: 'Taken out before taxes are figured',
  postTax: 'After-tax deductions',
  postTaxHint: 'Taken out after taxes',
  totalDeductions: 'Total',
  reimbursements: 'Reimbursements',
  reimbHint: 'Not wages: added to net pay, never taxed',
  expenseReimb: 'Expense reimbursements',
  employerPaid: 'Your employer also paid',
  employerHint: 'On top of your pay, not taken from it',
  socialSecurity: 'Social Security (employer share)',
  medicare: 'Medicare (employer share)',
  futa: 'Federal unemployment (FUTA)',
  suta: 'State unemployment',
  timeOff: 'Time off',
  sick: 'Paid sick leave available',
  available: 'Available',
  balance: 'Balance',
  used: 'Used',
  records: 'For your records',
  recordsHint: 'Shown for your W-2, not deducted',
  howPaid: 'How you were paid',
  amount: 'Amount',
  nonNegotiable: 'Non-negotiable · this is not a check',
  paidTo: 'Paid to',
  correction: 'Corrected statement',
  correctionBody: (reason: string) => `This statement corrects an earlier one. Reason: ${reason}`,
  voided: 'This paycheck was voided',
  voidedBody: (when: string, reason: string | null) => `Voided ${when}${reason ? `. Reason: ${reason}` : ''}. No money was paid on this statement.`,
  keep: 'Keep this statement for your records',
  ytdShort: (v: string) => `YTD ${v}`,
  ein: 'EIN',
  tel: 'Tel',
  netHint: { CHECK: 'Paid by paper check', DIRECT_DEPOSIT: 'Paid by direct deposit', PAY_CARD: 'Loaded to your pay card', OTHER: 'Paid' },
  hrs: 'hrs',
};
type Words = typeof EN;
const ES: Words = {
  title: 'Recibo de pago',
  corrected: 'Recibo de pago corregido',
  payDate: 'Fecha de pago',
  payPeriod: 'Período de pago',
  employee: 'Empleado',
  employer: 'Empleador',
  employeeId: 'ID de empleado',
  ssn: 'SSN',
  payBasis: 'Base de pago',
  gross: 'Pago bruto',
  taxes: 'Impuestos',
  deductions: 'Deducciones',
  net: 'Pago neto',
  ytd: 'Acum.',
  earnings: 'Ingresos',
  hours: 'Horas',
  rate: 'Tarifa',
  current: 'Actual',
  yearToDate: 'Acumulado',
  totalHours: 'Total de horas trabajadas',
  taxesWithheld: 'Impuestos retenidos',
  totalTaxes: 'Total de impuestos',
  preTax: 'Deducciones antes de impuestos',
  preTaxHint: 'Se descuentan antes de calcular los impuestos',
  postTax: 'Deducciones después de impuestos',
  postTaxHint: 'Se descuentan después de los impuestos',
  totalDeductions: 'Total',
  reimbursements: 'Reembolsos',
  reimbHint: 'No son salario: se suman al pago neto, sin impuestos',
  expenseReimb: 'Reembolso de gastos',
  employerPaid: 'Su empleador también pagó',
  employerHint: 'Además de su pago, no se descuenta de él',
  socialSecurity: 'Seguro Social (parte del empleador)',
  medicare: 'Medicare (parte del empleador)',
  futa: 'Desempleo federal (FUTA)',
  suta: 'Desempleo estatal',
  timeOff: 'Tiempo libre',
  sick: 'Licencia por enfermedad pagada disponible',
  available: 'Disponible',
  balance: 'Saldo',
  used: 'Usado',
  records: 'Para sus registros',
  recordsHint: 'Se muestra para su W-2, no se descuenta',
  howPaid: 'Cómo se le pagó',
  amount: 'Monto',
  nonNegotiable: 'No negociable · esto no es un cheque',
  paidTo: 'Pagado a',
  correction: 'Recibo corregido',
  correctionBody: (reason: string) => `Este recibo corrige uno anterior. Motivo: ${reason}`,
  voided: 'Este pago fue anulado',
  voidedBody: (when: string, reason: string | null) => `Anulado el ${when}${reason ? `. Motivo: ${reason}` : ''}. No se pagó dinero con este recibo.`,
  keep: 'Guarde este recibo para sus registros',
  ytdShort: (v: string) => `Acum. ${v}`,
  ein: 'EIN',
  tel: 'Tel.',
  netHint: { CHECK: 'Pagado con cheque', DIRECT_DEPOSIT: 'Pagado por depósito directo', PAY_CARD: 'Cargado a su tarjeta de pago', OTHER: 'Pagado' },
  hrs: 'h',
};
export const PAYSTUB_WORDS = { en: EN, es: ES };

// ----- Render --------------------------------------------------------------

function inferMethod(d: PaystubData): NonNullable<PaystubData['payMethod']> {
  if (d.payMethod) return d.payMethod;
  const label = `${d.payDistribution?.label ?? ''} ${d.payDistribution?.detail ?? ''}`.toLowerCase();
  if (/check|cheque/.test(label)) return 'CHECK';
  if (/card/.test(label)) return 'PAY_CARD';
  if (/deposit|account|bank|ach/.test(label)) return 'DIRECT_DEPOSIT';
  return 'OTHER';
}

function brandOf(d: PaystubData): Brand {
  const loc = [d.company.city, d.company.state].filter(Boolean).join(', ');
  const line1 = [d.company.addressLine1, [loc, d.company.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const words = d.language === 'es' ? ES : EN;
  const lines = [line1 || null, d.company.phone ? `${words.tel} ${d.company.phone}` : null, d.company.ein ? `${words.ein} ${fmt.ein(d.company.ein)}` : null].filter((x): x is string => !!x);
  let logo: Buffer | null = null;
  try {
    const uri = getBrandingSync().logoDataUri;
    const m = uri ? /^data:image\/(png|jpe?g);base64,(.+)$/i.exec(uri) : null;
    if (m) logo = Buffer.from(m[2], 'base64');
  } catch {
    logo = null;
  }
  return { name: d.company.name, logo, lines };
}

const sumLines = (lines: PaystubLine[]) => lines.reduce((a, l) => ({ current: a.current + l.current, ytd: a.ytd + l.ytd }), { current: 0, ytd: 0 });
/** A deduction shown as money taken: −$12.00, and $0.00 for zero. */
const out = (n: number) => fmt.money(-Math.abs(n));

export async function renderPaystubPdf(data: PaystubData): Promise<Buffer> {
  const w = data.language === 'es' ? ES : EN;
  // Line names in the statement's language (legal and plan names stay as written).
  const tr = (label: string) => (data.language === 'es' ? spanishLineLabel(label) : label);
  const method = inferMethod(data);
  const name = `${data.associate.firstName} ${data.associate.lastName}`.trim();
  const { k } = createDoc({ title: `${data.amendment ? w.corrected : w.title} · ${name}`, author: data.company.name, subject: `${w.payPeriod} ${fmt.dateRange(data.period.start, data.period.end)}` });
  const payDate = data.period.payDate ?? data.meta.issuedAt.slice(0, 10);

  let y = k.masthead({
    title: data.amendment ? w.corrected : w.title,
    subtitle: `${w.payDate} ${fmt.date(payDate)}`,
    brand: brandOf(data),
  });

  if (data.voided) {
    k.watermark(data.language === 'es' ? 'ANULADO' : 'VOID', COLOR.bad, 0.09);
    y = k.callout({ tone: 'bad', title: w.voided, body: w.voidedBody(fmt.date(data.voided.voidedAt), data.voided.reason) }, y);
  } else if (data.amendment) {
    k.watermark(data.language === 'es' ? 'CORREGIDO' : 'CORRECTED', COLOR.warn, 0.05);
    y = k.callout({ tone: 'warn', title: w.correction, body: w.correctionBody(data.amendment.reason) }, y);
  }

  y = parties(k, data, w, y);

  // The four numbers that matter, net pay leading.
  const pre = sumLines(data.preTaxDeductions);
  const post = sumLines(data.postTaxDeductions);
  const dist = data.payDistributions?.length ? data.payDistributions : null;
  const netHint = dist && dist.length > 1 ? `${dist.length} ${data.language === 'es' ? 'destinos' : 'accounts'}` : data.payDistribution?.detail || data.payDistribution?.label || w.netHint[method];
  y = k.figures(
    [
      { label: w.gross, value: fmt.money(data.gross.current), hint: w.ytdShort(fmt.money(data.gross.ytd)) },
      { label: w.taxes, value: out(data.taxesTotal.current), hint: w.ytdShort(out(data.taxesTotal.ytd)) },
      { label: w.deductions, value: out(pre.current + post.current), hint: w.ytdShort(out(pre.ytd + post.ytd)) },
      { label: w.net, value: fmt.money(data.net.current), hint: netHint, emphasis: true },
    ],
    y,
  );

  // Earnings: every rate with its hours (§226(a)(9)).
  y = k.section(w.earnings, y, `${w.current} · ${w.yearToDate}`);
  const earnCols: Column<PaystubEarningLine>[] = [
    { key: 'label', header: w.earnings, width: 4.2, value: (e) => tr(e.label) },
    { key: 'hours', header: w.hours, width: 1.2, align: 'right', value: (e) => (e.hours == null ? '' : fmt.hours(e.hours)) },
    { key: 'rate', header: w.rate, width: 1.3, align: 'right', value: (e) => (e.rate == null ? '' : fmt.money(e.rate)) },
    { key: 'current', header: w.current, width: 1.6, align: 'right', value: (e) => fmt.money(e.amount), strong: true },
    { key: 'ytd', header: w.yearToDate, width: 1.7, align: 'right', value: (e) => (e.ytd == null ? '' : fmt.money(e.ytd)) },
  ];
  y = k.table({
    y,
    columns: earnCols,
    rows: data.earnings,
    rowH: 16,
    totals: {
      label: w.gross,
      hours: data.hoursTotal != null && data.hoursTotal > 0 ? fmt.hours(data.hoursTotal) : '',
      current: fmt.money(data.gross.current),
      ytd: fmt.money(data.gross.ytd),
    },
  });

  // The rest flows into two balanced columns: taxes and deductions, then
  // what the employer paid, time off and the figures kept for the record.
  const blocks: Block[] = [];
  blocks.push({ title: w.taxesWithheld, rows: data.taxes.map((l) => ({ label: tr(l.label), current: out(l.current), ytd: out(l.ytd) })), total: { label: w.totalTaxes, current: out(data.taxesTotal.current), ytd: out(data.taxesTotal.ytd) } });
  if (data.preTaxDeductions.length) blocks.push({ title: w.preTax, hint: w.preTaxHint, rows: data.preTaxDeductions.map((l) => ({ label: tr(l.label), current: out(l.current), ytd: out(l.ytd) })), total: { label: w.totalDeductions, current: out(pre.current), ytd: out(pre.ytd) } });
  if (data.postTaxDeductions.length) blocks.push({ title: w.postTax, hint: w.postTaxHint, rows: data.postTaxDeductions.map((l) => ({ label: tr(l.label), current: out(l.current), ytd: out(l.ytd) })), total: { label: w.totalDeductions, current: out(post.current), ytd: out(post.ytd) } });
  if (data.reimbursements && data.reimbursements.current > 0) blocks.push({ title: w.reimbursements, hint: w.reimbHint, rows: [{ label: w.expenseReimb, current: fmt.money(data.reimbursements.current), ytd: fmt.money(data.reimbursements.ytd) }] });
  const er = data.employer;
  const erRows = [
    ...(data.employerContributions ?? []).map((l) => ({ label: tr(l.label), current: fmt.money(l.current), ytd: fmt.money(l.ytd) })),
    ...(er.fica > 0 ? [{ label: w.socialSecurity, current: fmt.money(er.fica), ytd: '' }] : []),
    ...(er.medicare > 0 ? [{ label: w.medicare, current: fmt.money(er.medicare), ytd: '' }] : []),
    ...(er.futa > 0 ? [{ label: w.futa, current: fmt.money(er.futa), ytd: '' }] : []),
    ...(er.suta > 0 ? [{ label: w.suta, current: fmt.money(er.suta), ytd: '' }] : []),
  ];
  const erTotal = (data.employerContributions ?? []).reduce((s2, l) => s2 + l.current, 0) + er.fica + er.medicare + er.futa + er.suta;
  if (erRows.length) blocks.push({ title: w.employerPaid, hint: w.employerHint, rows: erRows, total: { label: w.totalDeductions, current: fmt.money(erTotal), ytd: '' } });
  const off = [
    ...(data.sickLeave ? [{ label: w.sick, used: '', avail: data.sickLeave.availableHours }] : []),
    ...(data.timeOff ?? []).map((t) => ({ label: t.label, used: t.usedHours == null ? '' : `${fmt.hours(t.usedHours)} ${w.hrs}`, avail: t.availableHours })),
  ];
  if (off.length) blocks.push({ title: w.timeOff, rows: off.map((t) => ({ label: t.label, current: t.used, ytd: `${fmt.hours(t.avail)} ${w.hrs}` })), headers: [w.used, w.balance] });
  const info = data.informational ?? [];
  if (info.length) blocks.push({ title: w.records, hint: w.recordsHint, rows: info.map((l) => ({ label: tr(l.label), current: fmt.money(l.current), ytd: fmt.money(l.ytd) })) });
  y = flowColumns(k, blocks, w, y);

  for (const n of data.notes ?? []) {
    const h = k.para(n, k.L + 10, 0, k.width() - 10, { size: SIZE.small }, false);
    y = k.ensure(y, h + 6);
    k.text('•', k.L, y, { size: SIZE.small, color: COLOR.brand });
    k.para(n, k.L + 10, y, k.width() - 10, { size: SIZE.small, color: COLOR.ink2 });
    y += h + 5;
  }
  if (data.notes?.length) y += 8;

  // How it was paid.
  distribution(k, data, w, method, y);

  return k.finish({ reference: `${w.keep} · ${data.meta.runId.slice(0, 8)}-${data.meta.itemId.slice(0, 8)}`, note: `${name}`, confidentialLabel: data.language === 'es' ? 'Confidencial' : 'Confidential', pageLabel: data.language === 'es' ? (n, of) => `Página ${n} de ${of}` : undefined });
}

function parties(k: Kit, d: PaystubData, w: Words, y: number): number {
  const colW = k.width() / 3;
  const a = d.associate;
  const name = `${a.firstName} ${a.lastName}`.trim();
  const addr = [a.addressLine1, [[a.city, a.state].filter(Boolean).join(', '), a.zip].filter(Boolean).join(' ')].filter((s): s is string => !!s);
  const startY = y;
  k.text(w.employee, k.L, y, { size: SIZE.label, caps: true, color: COLOR.ink3 });
  k.text(name, k.L, y + 11, { size: SIZE.lead, weight: 'semibold', width: colW - 12 });
  let ly = y + 27;
  for (const l of addr) {
    k.text(l, k.L, ly, { size: SIZE.small, color: COLOR.ink2, width: colW - 12 });
    ly += 11;
  }
  const ids = [a.employeeId ? `${w.employeeId} ${a.employeeId}` : null, a.ssnLast4 ? `${w.ssn} ${fmt.ssnMasked(a.ssnLast4)}` : null].filter((s): s is string => !!s);
  ly += 2;
  for (const id of ids) {
    k.text(id, k.L, ly, { size: SIZE.small, color: COLOR.ink3, width: colW - 12 });
    ly += 11;
  }

  // Employer legal name and address (§226(a)(8)).
  const c = d.company;
  const cx = k.L + colW;
  k.text(w.employer, cx, y, { size: SIZE.label, caps: true, color: COLOR.ink3 });
  k.text(c.name, cx, y + 11, { size: SIZE.lead, weight: 'semibold', width: colW - 12 });
  let cy = y + 27;
  for (const l of [c.addressLine1, [[c.city, c.state].filter(Boolean).join(', '), c.zip].filter(Boolean).join(' ')].filter((s): s is string => !!s)) {
    k.text(l, cx, cy, { size: SIZE.small, color: COLOR.ink2, width: colW - 12 });
    cy += 11;
  }

  // The dates (§226(a)(6)) and pay basis.
  const rx = k.L + colW * 2;
  const facts: Array<[string, string]> = [
    [w.payPeriod, fmt.dateRange(d.period.start, d.period.end)],
    [w.payDate, fmt.date(d.period.payDate ?? d.meta.issuedAt.slice(0, 10))],
    ...(d.payBasis ? ([[w.payBasis, d.payBasis]] as Array<[string, string]>) : []),
  ];
  let ry = y;
  for (const [label, value] of facts) {
    k.text(label, rx, ry, { size: SIZE.label, caps: true, color: COLOR.ink3, width: colW });
    k.text(value, rx, ry + 10, { size: SIZE.body, weight: 'medium', width: colW });
    ry += 25;
  }
  const end = Math.max(ly, cy, ry) + 6;
  k.hr(end);
  void startY;
  return end + 14;
}

interface Block {
  title: string;
  hint?: string;
  rows: Array<{ label: string; current: string; ytd: string }>;
  total?: { label: string; current: string; ytd: string };
  /** Column headings when they aren't "Current / Year to date". */
  headers?: [string, string];
}

const ROW_H = 14;

/**
 * Lay blocks out in two columns like a newspaper: down the left column,
 * then the right, then on to the next page — so a normal paystub fits on
 * one page and a long one never leaves a hole. Blocks keep their order.
 */
function flowColumns(k: Kit, blocks: Block[], w: Words, y: number): number {
  if (!blocks.length) return y;
  const gap = 20;
  const cw = (k.width() - gap) / 2;
  // Long labels wrap: count the extra lines so a column never overruns the page.
  const labelW = cw * (3.9 / (3.9 + 1.9 + 2.1)) - 10;
  const extra = (b: Block) => b.rows.reduce((n, r) => n + Math.max(0, Math.ceil(k.measure(r.label, { size: SIZE.small }) / labelW) - 1), 0);
  const heightOf = (b: Block) => 27 + k.tableHeight(b.rows.length, { rowH: ROW_H, totals: !!b.total }) + extra(b) * 11;
  let i = 0;
  let top = y;
  let end = y;
  while (i < blocks.length) {
    // A block too tall for an empty column draws full width on its own.
    if (heightOf(blocks[i]) > k.bottom() - k.top) {
      end = drawBlock(k, blocks[i], w, end, k.L, k.width());
      i += 1;
      top = end;
      continue;
    }
    let placed = 0;
    for (let col = 0; col < 2 && i < blocks.length; col++) {
      let cy = top;
      while (i < blocks.length && cy + heightOf(blocks[i]) <= k.bottom()) {
        cy = drawBlock(k, blocks[i], w, cy, k.L + col * (cw + gap), cw);
        i += 1;
        placed += 1;
      }
      end = Math.max(end, cy);
    }
    if (i < blocks.length) {
      k.doc.addPage();
      top = k.top;
      end = top;
      if (placed === 0) continue;
    }
  }
  return end;
}

function drawBlock(k: Kit, b: Block, w: Words, y: number, x: number, width: number): number {
  y = k.section(b.title, y, width > 300 ? b.hint : undefined, { x, w: width });
  return k.table({
    y,
    x,
    w: width,
    rows: b.rows,
    rowH: ROW_H,
    columns: [
      { key: 'label', header: '', width: width > 300 ? 5 : 3.9, value: (r) => r.label, wrap: true },
      { key: 'current', header: b.headers?.[0] ?? w.current, width: 1.9, align: 'right', value: (r) => r.current },
      { key: 'ytd', header: b.headers?.[1] ?? (width > 300 ? w.yearToDate : w.ytd), width: 2.1, align: 'right', value: (r) => r.ytd, color: () => COLOR.ink2 },
    ],
    totals: b.total ? { label: b.total.label, current: b.total.current, ytd: b.total.ytd } : undefined,
  });
}

function distribution(k: Kit, d: PaystubData, w: Words, method: NonNullable<PaystubData['payMethod']>, y: number): number {
  const rows = d.payDistributions?.length
    ? d.payDistributions
    : d.payDistribution
      ? [{ label: d.payDistribution.label, detail: d.payDistribution.detail ?? null, amount: d.net.current }]
      : [];
  if (!rows.length) return y;
  const h = 34 + rows.length * 18 + (method !== 'CHECK' ? 20 : 0);
  y = k.ensure(y, h + 24);
  y = k.section(w.howPaid, y);
  for (const r of rows) {
    k.text(r.label, k.L, y, { size: SIZE.body, weight: 'medium', width: k.width() * 0.4 });
    if (r.detail) k.text(r.detail, k.L + k.width() * 0.4, y, { size: SIZE.body, color: COLOR.ink2, width: k.width() * 0.4 });
    k.text(fmt.money(r.amount), k.L + k.width() * 0.8, y, { size: SIZE.body, weight: 'semibold', width: k.width() * 0.2, align: 'right' });
    y += 18;
  }
  if (method !== 'CHECK') {
    // An advice of deposit, not a check: said plainly so no one tries to cash it.
    const label = w.nonNegotiable.toUpperCase();
    const lw = k.measure(label, { size: SIZE.label, weight: 'semibold' }) + 20;
    k.outline(k.L, y + 2, lw, 16, COLOR.ink3, 3);
    k.text(label, k.L + 10, y + 6.5, { size: SIZE.label, weight: 'semibold', color: COLOR.ink2 });
    y += 26;
  }
  return y + 6;
}

/**
 * Spanish names for the lines a statement prints, applied by the renderer
 * when the statement is in Spanish. Exact names first, then the patterns
 * the engine builds ("FL state income tax", "Child support — case …").
 * Anything not listed keeps its English name, which is also its legal name.
 */
const ES_LINE: Record<string, string> = {
  'Federal income tax': 'Impuesto federal sobre la renta',
  'Social Security': 'Seguro Social',
  Medicare: 'Medicare',
  'Additional Medicare': 'Medicare adicional',
  'State income tax': 'Impuesto estatal sobre la renta',
  'Local income tax': 'Impuesto local sobre la renta',
  Regular: 'Regular',
  Overtime: 'Horas extra',
  'Double time': 'Tiempo doble',
  Holiday: 'Feriado',
  PTO: 'Tiempo libre pagado',
  'Paid time off': 'Tiempo libre pagado',
  'Sick leave': 'Licencia por enfermedad',
  Bonus: 'Bono',
  Commission: 'Comisión',
  Tips: 'Propinas',
  Medical: 'Seguro médico',
  Dental: 'Seguro dental',
  Vision: 'Seguro de visión',
  'Health FSA': 'FSA de salud',
  'Dependent care FSA': 'FSA de cuidado de dependientes',
  'Health & benefits': 'Salud y beneficios',
  'Van rides': 'Transporte en van',
  'Earned-wage advance repaid': 'Adelanto de salario reembolsado',
  'Post-tax deductions': 'Deducciones después de impuestos',
  '401(k) match': 'Aporte del empleador al 401(k)',
  'Health coverage': 'Cobertura de salud',
  'Union dues': 'Cuotas sindicales',
  'Life insurance': 'Seguro de vida',
  Disability: 'Seguro por discapacidad',
};

export function spanishLineLabel(label: string): string {
  if (ES_LINE[label]) return ES_LINE[label];
  const st = /^([A-Z]{2}) state income tax$/.exec(label);
  if (st) return `Impuesto estatal sobre la renta (${st[1]})`;
  const pairs: Array<[RegExp, string]> = [
    [/^Child support/, 'Manutención infantil'],
    [/^IRS levy/, 'Embargo del IRS'],
    [/^State tax levy/, 'Embargo estatal'],
    [/^Student loan/, 'Préstamo estudiantil'],
    [/^Creditor garnishment/, 'Embargo de acreedor'],
    [/^Roth 401\(k\)/, 'Roth 401(k)'],
    [/^401\(k\) loan/, 'Préstamo del 401(k)'],
  ];
  for (const [re, es] of pairs) if (re.test(label)) return label.replace(re, es);
  return label;
}
