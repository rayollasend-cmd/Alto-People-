import PDFDocument from 'pdfkit';
import { createHash } from 'node:crypto';

/**
 * Paystub PDF renderer (Phase 18).
 *
 * Renders a single paystub for one PayrollItem. Output is a Buffer so we
 * can hash it for immutability proof and stream it to the client. Uses
 * pdfkit's built-in fonts (Helvetica family) so we don't need to ship a
 * font file in the repo. Layout is intentionally plain — Rippling's
 * paystubs look essentially the same: header with company / period,
 * earnings block, deductions block, taxes block, summary footer with YTD.
 */

export interface PaystubData {
  company: { name: string };
  associate: { firstName: string; lastName: string; email: string | null; addressLine1: string | null; city: string | null; state: string | null; zip: string | null };
  period: { start: string; end: string }; // ISO YYYY-MM-DD
  earnings: { hours: number; rate: number; gross: number };
  taxes: {
    federalIncomeTax: number;
    socialSecurity: number;
    medicare: number;
    stateIncomeTax: number;
    stateLabel: string; // e.g. "CA SIT" or "State Withholding"
  };
  totals: {
    totalEmployeeTax: number;
    netPay: number;
  };
  ytd: {
    wages: number;
    medicareWages: number;
  };
  employer: {
    fica: number;
    medicare: number;
    futa: number;
    suta: number;
  };
  meta: {
    runId: string;
    itemId: string;
    issuedAt: string; // ISO datetime
  };
}

export async function renderPaystubPdf(data: PaystubData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 50 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Header
    doc.fontSize(18).font('Helvetica-Bold').text('PAYSTUB', { align: 'right' });
    doc.fontSize(11).font('Helvetica').text(data.company.name, 50, 50);
    doc.fontSize(9).fillColor('#555').text('Issued via Alto People', 50, 68);
    doc.fillColor('#000').moveDown(2);

    // Employee + period block
    const blockTop = 110;
    doc.font('Helvetica-Bold').fontSize(10).text('EMPLOYEE', 50, blockTop);
    doc.font('Helvetica').fontSize(10).text(`${data.associate.firstName} ${data.associate.lastName}`, 50, blockTop + 14);
    if (data.associate.email) doc.fontSize(9).fillColor('#444').text(data.associate.email, 50, blockTop + 28);
    if (data.associate.addressLine1) {
      doc.fontSize(9).fillColor('#444').text(data.associate.addressLine1, 50, blockTop + 42);
      const csz = [data.associate.city, data.associate.state, data.associate.zip].filter(Boolean).join(', ');
      if (csz) doc.text(csz, 50, blockTop + 54);
    }

    doc.fillColor('#000').font('Helvetica-Bold').fontSize(10).text('PAY PERIOD', 320, blockTop);
    doc.font('Helvetica').fontSize(10).text(`${data.period.start} → ${data.period.end}`, 320, blockTop + 14);
    doc.font('Helvetica-Bold').fontSize(10).text('ISSUED', 320, blockTop + 38);
    doc.font('Helvetica').fontSize(10).text(data.meta.issuedAt.slice(0, 10), 320, blockTop + 52);

    // Earnings table
    const earningsTop = 200;
    sectionHeader(doc, 'EARNINGS', earningsTop);
    row(doc, earningsTop + 22, ['Description', 'Hours', 'Rate', 'Amount'], true);
    row(doc, earningsTop + 38, ['Regular wages', f(data.earnings.hours, 2), `$${f(data.earnings.rate, 2)}`, `$${f(data.earnings.gross, 2)}`]);
    rule(doc, earningsTop + 58);
    row(doc, earningsTop + 64, ['Gross pay', '', '', `$${f(data.earnings.gross, 2)}`], true);

    // Taxes table
    const taxesTop = earningsTop + 100;
    sectionHeader(doc, 'TAXES WITHHELD', taxesTop);
    row(doc, taxesTop + 22, ['Description', '', '', 'Amount'], true);
    row(doc, taxesTop + 38, ['Federal income tax', '', '', `-$${f(data.taxes.federalIncomeTax, 2)}`]);
    row(doc, taxesTop + 52, ['Social Security (6.2%)', '', '', `-$${f(data.taxes.socialSecurity, 2)}`]);
    row(doc, taxesTop + 66, ['Medicare (1.45%+)', '', '', `-$${f(data.taxes.medicare, 2)}`]);
    row(doc, taxesTop + 80, [data.taxes.stateLabel, '', '', `-$${f(data.taxes.stateIncomeTax, 2)}`]);
    rule(doc, taxesTop + 100);
    row(doc, taxesTop + 106, ['Total tax', '', '', `-$${f(data.totals.totalEmployeeTax, 2)}`], true);

    // Summary
    const summaryTop = taxesTop + 145;
    sectionHeader(doc, 'NET PAY', summaryTop);
    doc.font('Helvetica-Bold').fontSize(20).text(`$${f(data.totals.netPay, 2)}`, 50, summaryTop + 24);

    // YTD
    const ytdTop = summaryTop + 80;
    sectionHeader(doc, 'YEAR-TO-DATE (after this paycheck)', ytdTop);
    row(doc, ytdTop + 22, ['Wages', '', '', `$${f(data.ytd.wages + data.earnings.gross, 2)}`]);
    row(doc, ytdTop + 36, ['Medicare wages', '', '', `$${f(data.ytd.medicareWages + data.earnings.gross, 2)}`]);

    // Employer cost (small print, finance/audit reference)
    const empTop = ytdTop + 72;
    doc.fontSize(8).fillColor('#666').font('Helvetica').text(
      `Employer-side taxes (not deducted from your pay): ` +
        `FICA $${f(data.employer.fica, 2)}, Medicare $${f(data.employer.medicare, 2)}, ` +
        `FUTA $${f(data.employer.futa, 2)}, SUTA $${f(data.employer.suta, 2)}.`,
      50, empTop, { width: 500 }
    );

    // Footer
    doc.fontSize(7).fillColor('#999').text(
      `Run ${data.meta.runId.slice(0, 8)} · Item ${data.meta.itemId.slice(0, 8)} · ` +
        `Generated by Alto People at ${data.meta.issuedAt}`,
      50, 740, { align: 'center', width: 500 }
    );

    doc.end();
  });
}

export function hashPdf(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function sectionHeader(doc: PDFKit.PDFDocument, title: string, y: number): void {
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#222').text(title, 50, y);
  doc.moveTo(50, y + 14).lineTo(560, y + 14).strokeColor('#222').lineWidth(0.5).stroke();
  doc.fillColor('#000');
}

function row(doc: PDFKit.PDFDocument, y: number, cols: string[], bold = false): void {
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10);
  const xs = [50, 320, 400, 480];
  cols.forEach((c, i) => doc.text(c, xs[i], y, { width: 100 - 0, lineBreak: false }));
}

function rule(doc: PDFKit.PDFDocument, y: number): void {
  doc.moveTo(50, y).lineTo(560, y).strokeColor('#888').lineWidth(0.3).stroke();
}

function f(n: number, d: number): string {
  return n.toFixed(d);
}
