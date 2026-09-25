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

export interface PacketRenderOpts {
  /** "Downloaded by Dana Ortiz · Sep 24, 2026 10:14 AM ET · PKT-…" — on every page. */
  watermark: string;
}

function fmtWhen(d: Date): string {
  return d.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export async function renderExternalPayrollSheetPdf(
  data: ExternalPayrollSheetResult,
  generatedAt: Date,
  opts: PacketRenderOpts = { watermark: `Generated ${fmtWhen(generatedAt)}` },
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
      ['Download', opts.watermark],
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

    // ---- Changes since last packet -----------------------------------------
    // Every bank, pay-card, W-4, name, SSN and address change since the
    // previous download, with who made it and whether Finance verified it.
    // The bureau reads this before the roster; an unverified change is
    // printed in the warning colour.
    doc.font('Helvetica-Bold').fontSize(11).fillColor(INK);
    doc.text(
      `Changes since last packet${data.sinceLastPacket ? ` (${fmtWhen(data.sinceLastPacket)})` : ' (since the period start)'}`,
      MARGIN,
      doc.y,
      { width: pageW },
    );
    doc.moveDown(0.3);
    if (data.changes.length === 0) {
      doc.font('Helvetica').fontSize(9).fillColor(MUTED);
      doc.text('No financial changes.', MARGIN, doc.y, { width: pageW });
    } else {
      for (const c of data.changes) {
        if (doc.y + LINE_H * 3 > doc.page.height - MARGIN - 24) doc.addPage();
        const unverified = c.status === 'PENDING' || c.status === 'HELD';
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(unverified ? WARN : INK);
        doc.text(
          `${c.associateName}${c.inPacket ? '' : ' (not in this packet)'} — ${c.kindLabel}${c.highRisk ? ' — HIGH RISK' : ''}`,
          MARGIN,
          doc.y,
          { width: pageW },
        );
        doc.font('Helvetica').fontSize(8).fillColor(INK);
        doc.text(`${c.oldSummary}  ->  ${c.newSummary}`, MARGIN + 10, doc.y, { width: pageW - 10 });
        doc.font('Helvetica').fontSize(7.5).fillColor(unverified ? WARN : MUTED);
        const state =
          c.status === 'VERIFIED'
            ? `Verified by ${c.verifiedBy ?? 'Finance'} on ${c.verifiedAt ? fmtWhen(c.verifiedAt) : '—'}`
            : c.status === 'REJECTED'
              ? 'Rejected — previous account restored'
              : c.status === 'HELD'
                ? 'HELD — not verified; do not pay to the new account'
                : 'UNVERIFIED — acknowledged by the downloader; verify before paying';
        doc.text(
          `By ${c.by}${c.onBehalf ? ' (on behalf)' : ''} on ${fmtWhen(c.at)} · ${state}${c.riskFlags.length ? ` · Flags: ${c.riskFlags.join(', ')}` : ''}`,
          MARGIN + 10,
          doc.y,
          { width: pageW - 10 },
        );
        doc.moveDown(0.35);
      }
    }
    doc.moveDown(0.6);

    if (data.rows.length === 0) {
      doc.font('Helvetica').fontSize(10).fillColor(MUTED);
      doc.text('No approved time in this range.', MARGIN, doc.y, { width: pageW });
    }

    // ---- One card per employee --------------------------------------------
    const baseCardH = CARD_PAD * 2 + LINE_H * 6 + 6;
    const flagsW = pageW - CARD_PAD * 2;
    for (const r of data.rows) {
      doc.font('Helvetica-Bold').fontSize(7.5);
      const flagsH = r.flags ? doc.heightOfString(r.flags, { width: flagsW }) + 8 : 0;
      const cardH = baseCardH + flagsH;
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
      if (r.flags) {
        // Holds, fallbacks and changes, in full — the bureau acts on these.
        const fy = top + baseCardH - CARD_PAD + 2;
        const urgent = /HOLD|UNVERIFIED|HELD|HIGH RISK/.test(r.flags);
        doc.font('Helvetica').fontSize(6.5).fillColor(MUTED);
        doc.text('FLAGS', MARGIN + CARD_PAD, fy, { width: flagsW, lineBreak: false });
        doc.font('Helvetica-Bold').fontSize(7.5).fillColor(urgent ? WARN : INK);
        doc.text(r.flags, MARGIN + CARD_PAD, fy + 7, { width: flagsW });
      }

      doc.y = top + cardH + 8;
    }

    // ---- Footers -----------------------------------------------------------
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i += 1) {
      doc.switchToPage(range.start + i);
      // Writing below the bottom margin would otherwise open a new page.
      doc.page.margins.bottom = 0;
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
      doc.font('Helvetica').fontSize(6.5).fillColor(MUTED);
      doc.text(opts.watermark, MARGIN, footY + 9, { width: pageW, lineBreak: false, ellipsis: true });
      // A faint diagonal stamp across the page: a photo of a page still
      // says who downloaded it and when.
      doc.save();
      doc.rotate(-32, { origin: [doc.page.width / 2, doc.page.height / 2] });
      doc.font('Helvetica-Bold').fontSize(22).fillColor(MUTED).fillOpacity(0.08);
      doc.text(opts.watermark, MARGIN - 60, doc.page.height / 2 - 12, { width: pageW + 120, align: 'center', lineBreak: false });
      doc.restore();
    }

    doc.end();
  });
}
