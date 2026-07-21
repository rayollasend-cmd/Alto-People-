import PDFDocument from 'pdfkit';
import { createHash } from 'node:crypto';

/**
 * Paystub PDF renderer.
 *
 * A single earnings statement for one PayrollItem, rendered to a Buffer
 * (hashed for immutability + streamed to the client). Uses pdfkit's
 * built-in Helvetica so no font file ships in the repo.
 *
 * Layout is modeled on the premium payroll providers (ADP / Gusto /
 * Rippling): a branded header with a net-pay hero, current + YTD columns
 * on every money table, an earnings breakdown by kind, pre/post-tax
 * deductions, a summary bar, and a pay-distribution line. A running
 * y-cursor drives vertical flow so sections stack cleanly instead of the
 * old hard-coded offsets.
 */

// ----- Public data shape --------------------------------------------------

export interface PaystubEarningLine {
  label: string;
  /** Null for flat-amount earnings (salary, bonus, tips…). */
  hours: number | null;
  rate: number | null;
  amount: number;
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
  /** Non-taxable reimbursements folded into net (accountable-plan rule). */
  reimbursements?: { current: number; ytd: number };
  net: { current: number; ytd: number };
  /** Employer-paid taxes — informational, never deducted from the worker. */
  employer: { fica: number; medicare: number; futa: number; suta: number };
  /** How the money was paid — direct deposit account or check. */
  payDistribution?: { label: string; detail?: string | null };
  meta: { runId: string; itemId: string; issuedAt: string };
  /** AMENDMENT runs — corrected-paystub banner with the HR reason. */
  amendment?: { reason: string; sourceRunId: string };
  /** VOIDED items — diagonal watermark + audit footer. */
  voided?: { voidedAt: string; reason: string | null };
}

// ----- Palette + geometry -------------------------------------------------

const INK = '#1a2233'; // near-navy body text
const MUTED = '#5b6472';
const FAINT = '#8a91a0';
const ACCENT = '#0f2a4a'; // deep navy header
const GOLD = '#b8862b'; // brand accent rule
const HAIR = '#d8dce3'; // hairline rules
const ZEBRA = '#f5f6f8'; // alternating row tint
const HERO_BG = '#f0f4f9';

const PAGE_L = 48;
const PAGE_R = 564; // 612 - 48
const CONTENT_W = PAGE_R - PAGE_L;

const money = (n: number) =>
  (n < 0 ? '-' : '') +
  '$' +
  Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function hashPdf(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export async function renderPaystubPdf(data: PaystubData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: PAGE_L, bufferPages: true });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    let y = renderHeader(doc, data);
    y = renderPartiesAndHero(doc, data, y);
    y = renderEarnings(doc, data, y);
    y = renderTaxes(doc, data, y);
    y = renderDeductions(doc, data, y);
    y = renderReimbursements(doc, data, y);
    y = renderSummary(doc, data, y);
    y = renderDistribution(doc, data, y);
    renderEmployerAndFooter(doc, data, y);
    if (data.voided) renderVoided(doc, data);

    doc.end();
  });
}

// ----- Sections -----------------------------------------------------------

function renderHeader(doc: PDFKit.PDFDocument, data: PaystubData): number {
  // Deep-navy band with the company on the left and the statement title on
  // the right, capped by a thin gold rule — the brand anchor.
  doc.rect(0, 0, 612, 74).fill(ACCENT);
  doc.rect(0, 74, 612, 3).fill(GOLD);

  doc
    .fillColor('#ffffff')
    .font('Helvetica-Bold')
    .fontSize(17)
    .text(data.company.name, PAGE_L, 22, { width: 330 });
  const companyLoc = [data.company.city, data.company.state, data.company.zip]
    .filter(Boolean)
    .join(', ');
  const companyLine = [data.company.addressLine1, companyLoc].filter(Boolean).join(' · ');
  if (companyLine || data.company.ein) {
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor('#c7d2e0')
      .text(
        [companyLine, data.company.ein ? `EIN ${data.company.ein}` : null]
          .filter(Boolean)
          .join('   ·   '),
        PAGE_L,
        46,
        { width: 330 },
      );
  }

  const title = data.amendment ? 'CORRECTED EARNINGS STATEMENT' : 'EARNINGS STATEMENT';
  doc
    .font('Helvetica-Bold')
    .fontSize(12)
    .fillColor('#ffffff')
    .text(title, PAGE_R - 240, 26, { width: 240, align: 'right' });
  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor('#c7d2e0')
    .text(
      `Pay date  ${data.period.payDate ?? data.meta.issuedAt.slice(0, 10)}`,
      PAGE_R - 240,
      46,
      { width: 240, align: 'right' },
    );

  return 96;
}

function renderPartiesAndHero(doc: PDFKit.PDFDocument, data: PaystubData, top: number): number {
  // Amendment banner (if any) above the parties block.
  let y = top;
  if (data.amendment) {
    doc.roundedRect(PAGE_L, y, CONTENT_W, 22, 3).fill('#fff7e6');
    doc.fillColor('#a05a00').font('Helvetica-Bold').fontSize(8).text('CORRECTION', PAGE_L + 8, y + 7);
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor('#5a3a00')
      .text(`Reason: ${data.amendment.reason}`, PAGE_L + 78, y + 7, {
        width: CONTENT_W - 88,
        lineBreak: false,
        ellipsis: true,
      });
    y += 32;
  }

  // Left: employee. Right: a tinted net-pay hero.
  const heroW = 200;
  const heroX = PAGE_R - heroW;
  const heroH = 66;

  doc.fillColor(FAINT).font('Helvetica-Bold').fontSize(7.5).text('PAY TO', PAGE_L, y);
  doc
    .fillColor(INK)
    .font('Helvetica-Bold')
    .fontSize(12)
    .text(`${data.associate.firstName} ${data.associate.lastName}`.trim(), PAGE_L, y + 12);
  const empLines: string[] = [];
  if (data.associate.addressLine1) empLines.push(data.associate.addressLine1);
  const csz = [data.associate.city, data.associate.state, data.associate.zip]
    .filter(Boolean)
    .join(', ');
  if (csz) empLines.push(csz);
  doc.font('Helvetica').fontSize(8.5).fillColor(MUTED);
  let ey = y + 28;
  for (const line of empLines) {
    doc.text(line, PAGE_L, ey, { width: heroX - PAGE_L - 20 });
    ey += 12;
  }
  doc
    .fontSize(8)
    .fillColor(FAINT)
    .text(
      [
        `Pay period  ${data.period.start} – ${data.period.end}`,
        data.associate.employeeId ? `Employee ID  ${data.associate.employeeId}` : null,
      ]
        .filter(Boolean)
        .join('        '),
      PAGE_L,
      Math.max(ey + 2, y + 52),
      { width: heroX - PAGE_L - 20 },
    );

  // Net-pay hero.
  doc.roundedRect(heroX, y, heroW, heroH, 4).fill(HERO_BG);
  doc.roundedRect(heroX, y, 3.5, heroH, 2).fill(GOLD);
  doc
    .fillColor(MUTED)
    .font('Helvetica-Bold')
    .fontSize(7.5)
    .text('NET PAY THIS PERIOD', heroX + 14, y + 12);
  doc
    .fillColor(ACCENT)
    .font('Helvetica-Bold')
    .fontSize(24)
    .text(money(data.net.current), heroX + 14, y + 24, { width: heroW - 24 });
  doc
    .fillColor(FAINT)
    .font('Helvetica')
    .fontSize(7.5)
    .text(`YTD net  ${money(data.net.ytd)}`, heroX + 14, y + 52);

  return Math.max(ey, y + heroH) + 18;
}

// Column geometry for the money tables: label | hours | rate | current | ytd.
const COL = {
  label: PAGE_L,
  hours: 296,
  rate: 356,
  current: 416,
  ytd: 490,
};
const COLW = { hours: 52, rate: 52, current: 66, ytd: 74 };

function tableHeader(
  doc: PDFKit.PDFDocument,
  y: number,
  title: string,
  cols: { hours?: boolean; rate?: boolean } = {},
): number {
  doc.fillColor(ACCENT).font('Helvetica-Bold').fontSize(9).text(title, COL.label, y);
  const hy = y + 13;
  doc.font('Helvetica-Bold').fontSize(7).fillColor(FAINT);
  if (cols.hours) doc.text('HOURS', COL.hours, hy, { width: COLW.hours, align: 'right' });
  if (cols.rate) doc.text('RATE', COL.rate, hy, { width: COLW.rate, align: 'right' });
  doc.text('CURRENT', COL.current, hy, { width: COLW.current, align: 'right' });
  doc.text('YTD', COL.ytd, hy, { width: COLW.ytd, align: 'right' });
  doc.moveTo(PAGE_L, hy + 11).lineTo(PAGE_R, hy + 11).lineWidth(0.6).strokeColor(INK).stroke();
  return hy + 15;
}

function moneyRow(
  doc: PDFKit.PDFDocument,
  y: number,
  label: string,
  opts: {
    hours?: number | null;
    rate?: number | null;
    current?: number | null;
    ytd?: number | null;
    zebra?: boolean;
    bold?: boolean;
    sign?: '' | '-' | '+';
  } = {},
): number {
  const H = 16;
  if (opts.zebra) doc.rect(PAGE_L, y - 3, CONTENT_W, H).fill(ZEBRA);
  const f = opts.bold ? 'Helvetica-Bold' : 'Helvetica';
  doc.font(f).fontSize(8.5).fillColor(opts.bold ? INK : MUTED).text(label, COL.label, y, { width: 240 });
  doc.fillColor(INK).font(f).fontSize(8.5);
  const sign = opts.sign ?? '';
  if (opts.hours != null)
    doc.text(opts.hours.toFixed(2), COL.hours, y, { width: COLW.hours, align: 'right' });
  if (opts.rate != null)
    doc.text(money(opts.rate), COL.rate, y, { width: COLW.rate, align: 'right' });
  if (opts.current != null)
    doc.text(sign + money(opts.current), COL.current, y, { width: COLW.current, align: 'right' });
  if (opts.ytd != null)
    doc
      .fillColor(opts.bold ? INK : FAINT)
      .text(sign + money(opts.ytd), COL.ytd, y, { width: COLW.ytd, align: 'right' });
  return y + H;
}

function totalRule(doc: PDFKit.PDFDocument, y: number): number {
  doc.moveTo(COL.current, y).lineTo(PAGE_R, y).lineWidth(0.6).strokeColor(HAIR).stroke();
  return y + 4;
}

function renderEarnings(doc: PDFKit.PDFDocument, data: PaystubData, top: number): number {
  let y = tableHeader(doc, top, 'EARNINGS', { hours: true, rate: true });
  data.earnings.forEach((e, i) => {
    y = moneyRow(doc, y, e.label, {
      hours: e.hours,
      rate: e.rate,
      current: e.amount,
      zebra: i % 2 === 1,
    });
  });
  y = totalRule(doc, y + 1);
  y = moneyRow(doc, y, 'Gross pay', {
    current: data.gross.current,
    ytd: data.gross.ytd,
    bold: true,
  });
  return y + 12;
}

function renderTaxes(doc: PDFKit.PDFDocument, data: PaystubData, top: number): number {
  let y = tableHeader(doc, top, 'TAXES WITHHELD');
  data.taxes.forEach((t, i) => {
    y = moneyRow(doc, y, t.label, { current: t.current, ytd: t.ytd, zebra: i % 2 === 1, sign: '-' });
  });
  y = totalRule(doc, y + 1);
  y = moneyRow(doc, y, 'Total taxes', {
    current: data.taxesTotal.current,
    ytd: data.taxesTotal.ytd,
    bold: true,
    sign: '-',
  });
  return y + 12;
}

function renderDeductions(doc: PDFKit.PDFDocument, data: PaystubData, top: number): number {
  const all = [...data.preTaxDeductions, ...data.postTaxDeductions];
  if (all.length === 0) return top;
  let y = tableHeader(doc, top, 'DEDUCTIONS');
  let i = 0;
  for (const d of data.preTaxDeductions) {
    y = moneyRow(doc, y, `${d.label} (pre-tax)`, {
      current: d.current,
      ytd: d.ytd,
      zebra: i++ % 2 === 1,
      sign: '-',
    });
  }
  for (const d of data.postTaxDeductions) {
    y = moneyRow(doc, y, d.label, { current: d.current, ytd: d.ytd, zebra: i++ % 2 === 1, sign: '-' });
  }
  return y + 12;
}

function renderReimbursements(doc: PDFKit.PDFDocument, data: PaystubData, top: number): number {
  if (!data.reimbursements || data.reimbursements.current <= 0) return top;
  let y = tableHeader(doc, top, 'REIMBURSEMENTS (NON-TAXABLE)');
  y = moneyRow(doc, y, 'Expense reimbursements', {
    current: data.reimbursements.current,
    ytd: data.reimbursements.ytd,
    sign: '+',
  });
  doc
    .font('Helvetica')
    .fontSize(7)
    .fillColor(FAINT)
    .text(
      'Added to net pay after taxes — not part of gross wages or any tax base (accountable-plan rule).',
      COL.label,
      y + 1,
      { width: CONTENT_W },
    );
  return y + 16;
}

function renderSummary(doc: PDFKit.PDFDocument, data: PaystubData, top: number): number {
  const y = top + 2;
  const H = 52;
  doc.roundedRect(PAGE_L, y, CONTENT_W, H, 4).fill(ACCENT);

  const preTax = sum(data.preTaxDeductions);
  const postTax = sum(data.postTaxDeductions);
  const cells: Array<{ label: string; cur: number; ytd: number }> = [
    { label: 'Gross', cur: data.gross.current, ytd: data.gross.ytd },
    { label: 'Taxes', cur: -data.taxesTotal.current, ytd: -data.taxesTotal.ytd },
  ];
  if (preTax.current + postTax.current > 0) {
    cells.push({
      label: 'Deductions',
      cur: -(preTax.current + postTax.current),
      ytd: -(preTax.ytd + postTax.ytd),
    });
  }
  if (data.reimbursements && data.reimbursements.current > 0) {
    cells.push({ label: 'Reimb.', cur: data.reimbursements.current, ytd: data.reimbursements.ytd });
  }
  cells.push({ label: 'Net pay', cur: data.net.current, ytd: data.net.ytd });

  const cw = CONTENT_W / cells.length;
  cells.forEach((c, i) => {
    const cx = PAGE_L + i * cw;
    const last = i === cells.length - 1;
    if (i > 0) doc.moveTo(cx, y + 10).lineTo(cx, y + H - 10).lineWidth(0.4).strokeColor('#2b456a').stroke();
    doc
      .fillColor(last ? '#f3d38a' : '#9fb2ca')
      .font('Helvetica-Bold')
      .fontSize(7)
      .text(c.label.toUpperCase(), cx + 12, y + 10, { width: cw - 20 });
    doc
      .fillColor('#ffffff')
      .font('Helvetica-Bold')
      .fontSize(last ? 13 : 11)
      .text(money(c.cur), cx + 12, y + 21, { width: cw - 20 });
    doc
      .fillColor('#8ba0bd')
      .font('Helvetica')
      .fontSize(6.5)
      .text(`YTD ${money(c.ytd)}`, cx + 12, y + (last ? 40 : 38), { width: cw - 20 });
  });
  return y + H + 14;
}

function renderDistribution(doc: PDFKit.PDFDocument, data: PaystubData, top: number): number {
  if (!data.payDistribution) return top;
  let y = tableHeader(doc, top, 'PAY DISTRIBUTION');
  doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(data.payDistribution.label, COL.label, y, {
    width: 300,
  });
  doc
    .font('Helvetica-Bold')
    .fontSize(8.5)
    .fillColor(INK)
    .text(money(data.net.current), COL.current, y, { width: COLW.current + COLW.ytd + 8, align: 'right' });
  if (data.payDistribution.detail) {
    doc.font('Helvetica').fontSize(7.5).fillColor(FAINT).text(data.payDistribution.detail, COL.label, y + 12, {
      width: 300,
    });
  }
  return y + 24;
}

function renderEmployerAndFooter(doc: PDFKit.PDFDocument, data: PaystubData, top: number): void {
  const e = data.employer;
  const empTotal = e.fica + e.medicare + e.futa + e.suta;
  if (empTotal > 0) {
    doc
      .font('Helvetica')
      .fontSize(7.5)
      .fillColor(FAINT)
      .text(
        `Employer-paid taxes (not deducted from your pay): ` +
          `Social Security ${money(e.fica)} · Medicare ${money(e.medicare)} · ` +
          `FUTA ${money(e.futa)} · SUTA ${money(e.suta)}.`,
        PAGE_L,
        Math.max(top, 712),
        { width: CONTENT_W },
      );
  }
  doc
    .font('Helvetica')
    .fontSize(6.5)
    .fillColor(FAINT)
    .text(
      `Run ${data.meta.runId.slice(0, 8)} · Item ${data.meta.itemId.slice(0, 8)} · ` +
        `Generated by Alto People on ${data.meta.issuedAt.slice(0, 10)}. Retain for your records.`,
      PAGE_L,
      760,
      { width: CONTENT_W, align: 'center' },
    );
}

function renderVoided(doc: PDFKit.PDFDocument, data: PaystubData): void {
  doc.save();
  doc.rotate(-28, { origin: [306, 420] });
  doc
    .font('Helvetica-Bold')
    .fontSize(120)
    .fillColor('#dc2626')
    .opacity(0.14)
    .text('VOIDED', 40, 360, { align: 'center', width: 530 });
  doc.restore();
  doc.opacity(1);
  doc.save();
  doc.roundedRect(PAGE_L, 730, CONTENT_W, 20, 3).lineWidth(0.8).strokeColor('#dc2626').stroke();
  doc.fillColor('#991b1b').font('Helvetica-Bold').fontSize(8).text('VOIDED', PAGE_L + 8, 736);
  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor('#5a0a0a')
    .text(
      `${data.voided!.voidedAt.slice(0, 10)}${data.voided!.reason ? ` — ${data.voided!.reason}` : ''}`,
      PAGE_L + 60,
      736,
      { width: CONTENT_W - 70, lineBreak: false, ellipsis: true },
    );
  doc.restore();
  doc.fillColor(INK);
}

function sum(lines: PaystubLine[]): { current: number; ytd: number } {
  return lines.reduce(
    (a, l) => ({ current: a.current + l.current, ytd: a.ytd + l.ytd }),
    { current: 0, ytd: 0 },
  );
}
