import PDFDocument from 'pdfkit';
import type { PayrollSheet } from './payrollSheet.js';
import { minutesToHours } from './payrollSheet.js';

/**
 * Payroll-ready sheet PDF. One block per associate listing the dates they
 * worked and the duration each day, followed by their regular / overtime /
 * total hours, then a grand-total row. Mirrors timeReport.ts conventions
 * (letter-portrait, Helvetica, page-broken).
 */

export interface PayrollSheetReportData {
  sheet: PayrollSheet;
  clientName: string | null;
  rangeFrom: Date;
  rangeTo: Date; // end-exclusive
  generatedAt: Date;
  /** Entries still pending review in the window — totals are provisional. */
  pendingCount: number;
}

const PAGE_MARGIN = 40;
const ROW_PT = 9;

function fmtDay(ymd: string): string {
  // ymd is YYYY-MM-DD (UTC). Render without re-zoning.
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
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

export async function renderPayrollSheetPdf(
  data: PayrollSheetReportData,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: PAGE_MARGIN });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const contentWidth = doc.page.width - PAGE_MARGIN * 2;
    const pageBottom = doc.page.height - PAGE_MARGIN;

    const drawTopHeader = () => {
      doc
        .fontSize(16)
        .font('Helvetica-Bold')
        .fillColor('#000')
        .text('PAYROLL SHEET', PAGE_MARGIN, PAGE_MARGIN);
      doc
        .fontSize(10)
        .font('Helvetica')
        .fillColor('#444')
        .text(data.clientName ?? 'All clients', PAGE_MARGIN, PAGE_MARGIN + 22);
      doc.text(fmtRange(data.rangeFrom, data.rangeTo), PAGE_MARGIN, PAGE_MARGIN + 36);
      doc
        .fontSize(8)
        .fillColor('#888')
        .text(
          `APPROVED time only · Overtime = over 40h/week (federal) · Generated ${data.generatedAt.toLocaleString()} · Alto People`,
          PAGE_MARGIN,
          PAGE_MARGIN + 50,
          { width: contentWidth },
        );
      let y = PAGE_MARGIN + 64;
      if (data.pendingCount > 0) {
        doc
          .fontSize(8)
          .fillColor('#B5360F')
          .text(
            `WARNING: ${data.pendingCount} entr${data.pendingCount === 1 ? 'y is' : 'ies are'} still pending review — totals are PROVISIONAL until the approval queue is cleared.`,
            PAGE_MARGIN,
            y,
            { width: contentWidth },
          );
        y += 12;
      }
      doc.fillColor('#000');
      return y + 6;
    };

    let y = drawTopHeader();

    if (data.sheet.associates.length === 0) {
      doc
        .font('Helvetica-Oblique')
        .fontSize(11)
        .fillColor('#666')
        .text('No approved time in this range.', PAGE_MARGIN, y + 8);
      doc.end();
      return;
    }

    const ensureSpace = (needed: number) => {
      if (y + needed > pageBottom) {
        doc.addPage();
        y = PAGE_MARGIN;
      }
    };

    // Column layout for an associate's day rows.
    const dateX = PAGE_MARGIN + 8;
    const hrsX = PAGE_MARGIN + contentWidth - 80;

    for (const assoc of data.sheet.associates) {
      ensureSpace(40);
      // Associate header bar.
      doc
        .save()
        .fillColor('#F0F2F5')
        .rect(PAGE_MARGIN, y, contentWidth, 18)
        .fill()
        .restore();
      doc
        .font('Helvetica-Bold')
        .fontSize(10)
        .fillColor('#111')
        .text(assoc.name, PAGE_MARGIN + 6, y + 4, { width: contentWidth - 12 });
      y += 22;

      // Day rows.
      doc.font('Helvetica').fontSize(ROW_PT).fillColor('#333');
      for (const day of assoc.days) {
        ensureSpace(14);
        doc.text(fmtDay(day.date), dateX, y, { width: hrsX - dateX - 8 });
        doc.text(`${minutesToHours(day.minutes)} h`, hrsX, y, {
          width: 72,
          align: 'right',
        });
        y += 13;
      }

      // Per-associate totals line.
      ensureSpace(16);
      doc
        .moveTo(PAGE_MARGIN + 6, y + 1)
        .lineTo(PAGE_MARGIN + contentWidth - 6, y + 1)
        .lineWidth(0.25)
        .strokeColor('#ccc')
        .stroke();
      y += 4;
      doc
        .font('Helvetica-Bold')
        .fontSize(ROW_PT)
        .fillColor('#000')
        .text(
          `Regular ${minutesToHours(assoc.regularMinutes)} h   ·   OT ${minutesToHours(assoc.overtimeMinutes)} h   ·   Total ${minutesToHours(assoc.totalMinutes)} h`,
          dateX,
          y,
          { width: contentWidth - 16, align: 'right' },
        );
      y += 18;
    }

    // Grand totals.
    ensureSpace(26);
    doc
      .save()
      .fillColor('#111')
      .rect(PAGE_MARGIN, y, contentWidth, 20)
      .fill()
      .restore();
    doc
      .font('Helvetica-Bold')
      .fontSize(10)
      .fillColor('#fff')
      .text(
        `TOTAL — Regular ${minutesToHours(data.sheet.totalRegularMinutes)} h   ·   OT ${minutesToHours(data.sheet.totalOvertimeMinutes)} h   ·   ${minutesToHours(data.sheet.totalMinutes)} h`,
        PAGE_MARGIN + 6,
        y + 5,
        { width: contentWidth - 12, align: 'right' },
      );

    doc.end();
  });
}
