import PDFDocument from 'pdfkit';
import type { ExternalPayrollSheetResult } from './externalPayrollSheet.js';
import { describeGaps } from './externalPayrollSheetXlsx.js';

/**
 * External payroll sheet PDF.
 *
 * The spreadsheet is the machine handoff; this is the human/archival copy.
 * Sixteen columns will not fit legibly across a landscape page, so instead of
 * shrinking type to 5pt this renders one bordered CARD per employee with the
 * fields in labelled pairs. That keeps every value readable when the file is
 * printed — which, being a payroll document, it will be.
 *
 * Every page carries a CONFIDENTIAL rule and the page number, because a
 * printed page of this file separated from its cover sheet is still a stack
 * of SSNs and bank accounts.
 */

const MARGIN = 42;
const INK = '#111827';
const MUTED = '#6B7280';
const RULE = '#D1D5DB';
const BAND = '#1F2A37';
const WARN = '#B5360F';

const CARD_PAD = 10;
const LINE_H = 13;

function usd(n: number | null): string {
  if (n === null) return '—';
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

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

export async function renderExternalPayrollSheetPdf(
  data: ExternalPayrollSheetResult,
  generatedAt: Date,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: MARGIN, bufferPages: true });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageW = doc.page.width - MARGIN * 2;

    // ---- Letterhead --------------------------------------------------------
    doc.font('Helvetica-Bold').fontSize(18).fillColor(INK);
    doc.text('External Payroll Sheet', MARGIN, MARGIN);
    doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED);
    doc.text('ALTO PEOPLE', MARGIN, doc.y + 2);

    doc.moveDown(0.6);
    doc.font('Helvetica-Bold').fontSize(8).fillColor(WARN);
    doc.text(
      'CONFIDENTIAL — contains Social Security numbers and bank account details. Handle per your data-protection policy.',
      MARGIN,
      doc.y,
      { width: pageW },
    );

    doc.moveDown(0.5);
    const meta: Array<[string, string]> = [
      ['Employer', data.clientName ?? 'All clients'],
      ['Pay period', fmtRange(data.from, data.to)],
      ['Status', 'Approved time only'],
      ['Employees', String(data.rows.length)],
      ['Generated', generatedAt.toLocaleString('en-US')],
    ];
    for (const [label, value] of meta) {
      doc.font('Helvetica').fontSize(8).fillColor(MUTED);
      doc.text(label.toUpperCase(), MARGIN, doc.y, { continued: true, width: pageW });
      doc.font('Helvetica-Bold').fontSize(9).fillColor(INK);
      doc.text(`   ${value}`);
    }

    const gapNote = describeGaps(data);
    if (gapNote) {
      doc.moveDown(0.4);
      doc.font('Helvetica-Bold').fontSize(8).fillColor(WARN);
      doc.text(gapNote, MARGIN, doc.y, { width: pageW });
    }
    if (data.truncated) {
      doc.moveDown(0.3);
      doc.font('Helvetica-Bold').fontSize(8).fillColor(WARN);
      doc.text(
        'INCOMPLETE — the time-entry scan hit its cap. Narrow the range and regenerate before sending.',
        MARGIN,
        doc.y,
        { width: pageW },
      );
    }

    doc.moveDown(0.8);

    if (data.rows.length === 0) {
      doc.font('Helvetica').fontSize(10).fillColor(MUTED);
      doc.text('No approved time in this range.', MARGIN, doc.y, { width: pageW });
    }

    // ---- One card per employee --------------------------------------------
    const cardH = CARD_PAD * 2 + LINE_H * 6 + 6;
    for (const r of data.rows) {
      if (doc.y + cardH > doc.page.height - MARGIN - 24) {
        doc.addPage();
      }
      const top = doc.y;

      doc.save();
      doc.roundedRect(MARGIN, top, pageW, cardH, 3).lineWidth(0.7).strokeColor(RULE).stroke();
      doc.restore();

      // Name band
      doc.font('Helvetica-Bold').fontSize(10).fillColor(BAND);
      doc.text(r.fullName || '—', MARGIN + CARD_PAD, top + CARD_PAD, {
        width: pageW - CARD_PAD * 2,
      });

      const colW = (pageW - CARD_PAD * 2) / 3;
      const pairs: Array<[string, string]> = [
        ['DOB', r.dob || '—'],
        ['SSN', r.ssn || '— missing'],
        ['W-4 filing status', r.w4FilingStatus || '—'],
        ['Email', r.email || '—'],
        ['Phone', r.phone || '—'],
        ['Client', r.clientName || '—'],
        ['Payment method', r.paymentMethod || '—'],
        ['Bank name', r.bankName || '—'],
        ['Account type', r.accountType || '—'],
        ['Routing number', r.routingNumber || '— missing'],
        ['Account number', r.accountNumber || '— missing'],
        ['Pay rate', usd(r.payRate)],
        ['Regular hours', r.regularHours.toFixed(2)],
        ['Overtime', r.overtimeHours.toFixed(2)],
        ['Address', r.fullAddress || '—'],
      ];

      let y = top + CARD_PAD + LINE_H;
      pairs.forEach(([label, value], i) => {
        const col = i % 3;
        if (col === 0 && i > 0) y += LINE_H;
        const x = MARGIN + CARD_PAD + col * colW;
        doc.font('Helvetica').fontSize(6.5).fillColor(MUTED);
        doc.text(label.toUpperCase(), x, y, { width: colW - 6, lineBreak: false });
        doc.font('Helvetica-Bold').fontSize(8).fillColor(INK);
        doc.text(value, x, y + 6, { width: colW - 6, lineBreak: false, ellipsis: true });
      });

      doc.y = top + cardH + 8;
    }

    // ---- Footers -----------------------------------------------------------
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i += 1) {
      doc.switchToPage(range.start + i);
      const footY = doc.page.height - MARGIN + 6;
      doc.font('Helvetica').fontSize(7).fillColor(WARN);
      doc.text('CONFIDENTIAL — contains SSN and bank account data', MARGIN, footY, {
        width: pageW / 2,
        lineBreak: false,
      });
      doc.font('Helvetica').fontSize(7).fillColor(MUTED);
      doc.text(`Page ${i + 1} of ${range.count}`, MARGIN + pageW / 2, footY, {
        width: pageW / 2,
        align: 'right',
        lineBreak: false,
      });
    }

    doc.end();
  });
}
