import PDFDocument from 'pdfkit';
import { minutesToHours } from './payrollSheet.js';
import type { PayrollSheetPaid } from './payrollSheetPay.js';

/**
 * Payroll-ready time sheet PDF.
 *
 * Formatted like a payroll register a processor would accept: a letterhead,
 * an employer / pay-period metadata block, a bordered table per associate
 * (dates worked + daily duration) with a regular / overtime / total subtotal
 * and an earnings line (rate, gross, taxes, net), a grand-total band, a
 * sign-off line, and "Page X of Y" footers. Letter portrait, Helvetica.
 *
 * Gross is driven by each associate's compensation-record wage; net is the
 * full payroll-engine figure (W-4, pre-tax benefits, garnishments, YTD caps),
 * with Florida resolving to $0 state income tax.
 */

export interface PayrollSheetReportData {
  sheet: PayrollSheetPaid;
  clientName: string | null;
  rangeFrom: Date;
  rangeTo: Date; // end-exclusive
  generatedAt: Date;
  /** Entries still pending review in the window — totals are provisional. */
  pendingCount: number;
}

const MARGIN = 48;
const INK = '#111827';
const MUTED = '#6B7280';
const RULE = '#D1D5DB';
const BAND = '#1F2A37';
const ZEBRA = '#F4F6F8';
const SUBTOTAL_BG = '#EAEDF1';
const WARN = '#B5360F';

const ROW_H = 16;
const HEADER_ROW_H = 18;

function hrs(min: number): string {
  return minutesToHours(min);
}

function usd(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDay(ymd: string): { date: string; weekday: string } {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return {
    date: dt.toLocaleDateString('en-US', {
      month: '2-digit',
      day: '2-digit',
      year: 'numeric',
      timeZone: 'UTC',
    }),
    weekday: dt.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }),
  };
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

export async function renderPayrollSheetPdf(
  data: PayrollSheetReportData,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: MARGIN, bufferPages: true });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = MARGIN;
    const contentWidth = doc.page.width - MARGIN * 2;
    const right = left + contentWidth;
    const pageBottom = doc.page.height - MARGIN;

    // Column geometry for the per-associate detail table.
    const wDate = contentWidth * 0.34;
    const wDay = contentWidth * 0.33;
    const wHrs = contentWidth * 0.33;
    const xDate = left;
    const xDay = xDate + wDate;
    const xHrs = xDay + wDay;

    // ---- Letterhead ------------------------------------------------------
    const drawLetterhead = (): number => {
      doc
        .font('Helvetica-Bold')
        .fontSize(9)
        .fillColor(MUTED)
        .text('ALTO PEOPLE', left, MARGIN, { characterSpacing: 1.5 });
      doc
        .font('Helvetica-Bold')
        .fontSize(20)
        .fillColor(INK)
        .text('Payroll Time Sheet', left, MARGIN + 12);

      let y = MARGIN + 40;
      doc.moveTo(left, y).lineTo(right, y).lineWidth(1).strokeColor(BAND).stroke();
      y += 12;

      const colW = contentWidth / 2;
      const meta: Array<[string, string]> = [
        ['Employer', data.clientName ?? 'All clients'],
        ['Pay period', fmtRange(data.rangeFrom, data.rangeTo)],
        ['Status', 'Approved time only'],
        ['Generated', data.generatedAt.toLocaleString('en-US')],
      ];
      for (let i = 0; i < meta.length; i += 1) {
        const [label, value] = meta[i];
        const col = i % 2;
        const rowY = y + Math.floor(i / 2) * 16;
        const x = left + col * colW;
        doc
          .font('Helvetica')
          .fontSize(8)
          .fillColor(MUTED)
          .text(label.toUpperCase(), x, rowY, { characterSpacing: 0.5 });
        doc
          .font('Helvetica-Bold')
          .fontSize(9.5)
          .fillColor(INK)
          .text(value, x + 70, rowY - 1, { width: colW - 74, ellipsis: true });
      }
      y += Math.ceil(meta.length / 2) * 16 + 6;

      if (data.pendingCount > 0) {
        const bandH = 22;
        doc.save().fillColor('#FCEBE6').rect(left, y, contentWidth, bandH).fill().restore();
        doc
          .font('Helvetica-Bold')
          .fontSize(8.5)
          .fillColor(WARN)
          .text(
            `PROVISIONAL — ${data.pendingCount} entr${data.pendingCount === 1 ? 'y is' : 'ies are'} still pending review in this period. Hours, gross, and net are not final until the approval queue is cleared.`,
            left + 8,
            y + 5,
            { width: contentWidth - 16 },
          );
        y += bandH + 6;
      }
      doc.fillColor(INK);
      return y + 2;
    };

    const drawDetailHeader = (y: number, associate: string): number => {
      doc.save().fillColor(BAND).rect(left, y, contentWidth, HEADER_ROW_H).fill().restore();
      doc
        .font('Helvetica-Bold')
        .fontSize(10)
        .fillColor('#FFFFFF')
        .text(associate, left + 8, y + 4, { width: contentWidth - 16, ellipsis: true });
      y += HEADER_ROW_H;
      doc.save().fillColor('#FFFFFF').rect(left, y, contentWidth, ROW_H).fill().restore();
      doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED);
      doc.text('DATE', xDate + 6, y + 4);
      doc.text('DAY', xDay + 6, y + 4);
      doc.text('HOURS', xHrs, y + 4, { width: wHrs - 6, align: 'right' });
      doc.moveTo(left, y + ROW_H).lineTo(right, y + ROW_H).lineWidth(0.75).strokeColor(RULE).stroke();
      return y + ROW_H;
    };

    let y = drawLetterhead();

    if (data.sheet.associates.length === 0) {
      doc
        .font('Helvetica-Oblique')
        .fontSize(11)
        .fillColor(MUTED)
        .text('No approved time in this pay period.', left, y + 12);
      finishWithFooters(doc, left, right);
      doc.end();
      return;
    }

    const ensure = (needed: number) => {
      if (y + needed > pageBottom) {
        doc.addPage();
        y = MARGIN;
      }
    };

    // ---- Per-associate tables -------------------------------------------
    for (const assoc of data.sheet.associates) {
      if (y + HEADER_ROW_H + ROW_H * 2 > pageBottom) {
        doc.addPage();
        y = MARGIN;
      }
      y = drawDetailHeader(y, assoc.name);

      doc.font('Helvetica').fontSize(9).fillColor(INK);
      let zebra = false;
      for (const day of assoc.days) {
        if (y + ROW_H > pageBottom) {
          doc.addPage();
          y = MARGIN;
          y = drawDetailHeader(y, `${assoc.name} (continued)`);
          doc.font('Helvetica').fontSize(9).fillColor(INK);
          zebra = false;
        }
        if (zebra) {
          doc.save().fillColor(ZEBRA).rect(left, y, contentWidth, ROW_H).fill().restore();
        }
        zebra = !zebra;
        const { date, weekday } = fmtDay(day.date);
        doc.fillColor(INK).font('Helvetica').fontSize(9);
        doc.text(date, xDate + 6, y + 4, { width: wDate - 8 });
        doc.text(weekday, xDay + 6, y + 4, { width: wDay - 8 });
        doc.text(`${hrs(day.minutes)}`, xHrs, y + 4, { width: wHrs - 6, align: 'right' });
        y += ROW_H;
      }

      // Hours subtotal row.
      ensure(ROW_H + 2);
      doc.save().fillColor(SUBTOTAL_BG).rect(left, y, contentWidth, ROW_H + 2).fill().restore();
      doc.moveTo(left, y).lineTo(right, y).lineWidth(0.75).strokeColor(RULE).stroke();
      doc
        .font('Helvetica-Bold')
        .fontSize(9)
        .fillColor(INK)
        .text(
          `Regular ${hrs(assoc.regularMinutes)}    Overtime ${hrs(assoc.overtimeMinutes)}    Scheduled ${hrs(assoc.scheduledMinutes ?? 0)}`,
          xDate + 6,
          y + 5,
          { width: wDate + wDay - 8 },
        );
      doc.text(`Total ${hrs(assoc.totalMinutes)} h`, xHrs, y + 5, {
        width: wHrs - 6,
        align: 'right',
      });
      y += ROW_H + 2;

      // Earnings line(s).
      ensure(30);
      const pay = assoc.pay;
      if (pay.hasRate) {
        doc
          .font('Helvetica-Bold')
          .fontSize(9)
          .fillColor(INK)
          .text(
            `Pay rate ${usd(pay.hourlyRate)}/hr        Gross ${usd(pay.grossPay)}`,
            xDate + 6,
            y + 3,
            { width: contentWidth - 120 },
          );
        doc.text(`Net ${usd(pay.netPay)}`, xHrs, y + 3, { width: wHrs - 6, align: 'right' });
        y += 14;
        doc
          .font('Helvetica')
          .fontSize(7.5)
          .fillColor(MUTED)
          .text(
            `Taxes — Federal ${usd(pay.federalIncomeTax)} · Social Security ${usd(pay.socialSecurity)} · Medicare ${usd(pay.medicare)} · State ${usd(pay.stateIncomeTax)}`,
            xDate + 6,
            y + 1,
            { width: contentWidth - 12 },
          );
        y += 12;
      } else {
        doc
          .font('Helvetica-Oblique')
          .fontSize(8)
          .fillColor(MUTED)
          .text(
            'No hourly wage on file — gross / net not calculated.',
            xDate + 6,
            y + 3,
            { width: contentWidth - 12 },
          );
        y += 14;
      }
      y += 10; // gap before next associate
    }

    // ---- Grand totals ----------------------------------------------------
    const gtH = 22;
    ensure(gtH * 2 + 6);
    doc.save().fillColor(BAND).rect(left, y, contentWidth, gtH).fill().restore();
    doc
      .font('Helvetica-Bold')
      .fontSize(10)
      .fillColor('#FFFFFF')
      .text(
        `HOURS — Regular ${hrs(data.sheet.totalRegularMinutes)}    Overtime ${hrs(data.sheet.totalOvertimeMinutes)}    Scheduled ${hrs(data.sheet.totalScheduledMinutes ?? 0)}`,
        left + 8,
        y + 6,
        { width: contentWidth - 130 },
      );
    doc.text(`${hrs(data.sheet.totalMinutes)} h`, right - 130, y + 6, {
      width: 122,
      align: 'right',
    });
    y += gtH + 4;

    doc.save().fillColor(BAND).rect(left, y, contentWidth, gtH).fill().restore();
    doc
      .font('Helvetica-Bold')
      .fontSize(9.5)
      .fillColor('#FFFFFF')
      .text(
        `PAY — Gross ${usd(data.sheet.totalGross)} · Fed ${usd(data.sheet.totalFederalIncomeTax)} · SS ${usd(data.sheet.totalSocialSecurity)} · Medicare ${usd(data.sheet.totalMedicare)} · State ${usd(data.sheet.totalStateIncomeTax)}`,
        left + 8,
        y + 6,
        { width: contentWidth - 150 },
      );
    doc.text(`Net ${usd(data.sheet.totalNet)}`, right - 150, y + 6, {
      width: 142,
      align: 'right',
    });
    y += gtH + 16;

    // ---- Disclaimer + sign-off ------------------------------------------
    ensure(64);
    doc
      .font('Helvetica')
      .fontSize(7.5)
      .fillColor(MUTED)
      .text(
        'Net pay is estimated federal tax withholding for W-2 employees (using each employee’s W-4; defaults to Single if none on file) plus pre-tax benefits and garnishments. Florida has no state income tax. 1099 contractors show gross = net. Figures are an estimate for payroll preparation, not a pay statement.',
        left,
        y,
        { width: contentWidth },
      );
    y += 26;

    const sigW = (contentWidth - 40) / 2;
    const drawSig = (x: number, label: string) => {
      doc.moveTo(x, y + 16).lineTo(x + sigW, y + 16).lineWidth(0.75).strokeColor('#9CA3AF').stroke();
      doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(label, x, y + 20);
    };
    drawSig(left, 'Prepared by (name / signature / date)');
    drawSig(left + sigW + 40, 'Approved by (name / signature / date)');

    finishWithFooters(doc, left, right);
    doc.end();
  });
}

/** Stamp "Page X of Y" + a confidentiality line on every buffered page. */
function finishWithFooters(
  doc: PDFKit.PDFDocument,
  left: number,
  right: number,
): void {
  const range = doc.bufferedPageRange();
  const total = range.count;
  for (let i = 0; i < total; i += 1) {
    doc.switchToPage(range.start + i);
    const y = doc.page.height - MARGIN + 12;
    doc.moveTo(left, y - 4).lineTo(right, y - 4).lineWidth(0.5).strokeColor(RULE).stroke();
    doc
      .font('Helvetica')
      .fontSize(7.5)
      .fillColor(MUTED)
      .text(
        'Confidential · Overtime = hours over 40 per week (federal) · Generated by Alto People',
        left,
        y,
        { width: right - left - 90, lineBreak: false },
      );
    doc
      .font('Helvetica')
      .fontSize(7.5)
      .fillColor(MUTED)
      .text(`Page ${i + 1} of ${total}`, right - 90, y, {
        width: 90,
        align: 'right',
        lineBreak: false,
      });
  }
}
