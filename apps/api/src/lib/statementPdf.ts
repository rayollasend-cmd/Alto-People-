import PDFDocument from 'pdfkit';
import type { StatementSnapshot } from './clientStatement.js';

/**
 * Client statement PDF — the letterheaded artifact procurement files.
 * Layout is deliberately ledger-plain: header block, service levels,
 * billed line items, per-store subtotals, total. DRAFTs are watermarked
 * in the header; FINAL statements carry their sequential number.
 */
export async function renderStatementPdf(input: {
  snapshot: StatementSnapshot;
  number: number | null;
  status: string;
  finalizedAt: Date | null;
}): Promise<Buffer> {
  const { snapshot: s } = input;
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margin: 54,
      info: {
        Title: `Statement — ${s.clientName} — ${s.periodStart} to ${s.periodEnd}`,
        Author: 'Alto People',
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const money = (v: number) =>
      `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const width = right - left;

    // ---- Letterhead --------------------------------------------------------
    doc.font('Helvetica-Bold').fontSize(18).text('Alto People', left, undefined);
    doc
      .font('Helvetica')
      .fontSize(10)
      .fillColor('#555555')
      .text('Workforce Services Statement');
    doc.moveDown(0.8);
    doc.fillColor('#000000').font('Helvetica-Bold').fontSize(12).text(s.clientName);
    doc
      .font('Helvetica')
      .fontSize(10)
      .text(`Service period: ${s.periodStart} through ${s.periodEnd}`);
    doc.text(
      input.status === 'FINAL' && input.number !== null
        ? `Statement No. ${String(input.number).padStart(4, '0')}${
            input.finalizedAt
              ? ` · finalized ${input.finalizedAt.toISOString().slice(0, 10)}`
              : ''
          }`
        : 'DRAFT — figures may change until finalized',
    );
    doc
      .moveTo(left, doc.y + 8)
      .lineTo(right, doc.y + 8)
      .lineWidth(1)
      .strokeColor('#999999')
      .stroke();
    doc.moveDown(1.2);

    // ---- Service levels ----------------------------------------------------
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#000000').text('Service levels');
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(10);
    const sla = s.sla;
    const slaLines = [
      `Shifts published: ${sla.publishedShifts} · filled: ${sla.assignedShifts}` +
        (sla.fillRatePct !== null ? ` (${sla.fillRatePct}% fill rate)` : ''),
      sla.punctualPct !== null
        ? `On-time arrivals: ${sla.punctualPct}% of shift-linked punches`
        : 'On-time arrivals: no shift-linked punches in period',
      `No-shows flagged: ${sla.noShows}`,
    ];
    for (const line of slaLines) doc.text(line);
    if (sla.pendingEntries > 0) {
      doc
        .fillColor('#8a5a00')
        .text(
          `Note: ${sla.pendingEntries} time ${sla.pendingEntries === 1 ? 'entry' : 'entries'} in this period still await approval and are NOT billed here.`,
        )
        .fillColor('#000000');
    }
    doc.moveDown(1);

    // ---- Line items ---------------------------------------------------------
    doc.font('Helvetica-Bold').fontSize(11).text('Billed services');
    doc.moveDown(0.4);
    const cols = { label: left, hours: right - 200, rate: right - 130, amount: right - 65 };
    const rowY = () => doc.y;
    doc.fontSize(9).fillColor('#555555');
    doc.text('Service', cols.label, rowY(), { continued: false });
    doc.moveUp();
    doc.text('Hours', cols.hours, rowY(), { width: 60, align: 'right' });
    doc.moveUp();
    doc.text('Rate', cols.rate, rowY(), { width: 55, align: 'right' });
    doc.moveUp();
    doc.text('Amount', cols.amount, rowY(), { width: 65, align: 'right' });
    doc
      .moveTo(left, doc.y + 3)
      .lineTo(right, doc.y + 3)
      .lineWidth(0.5)
      .strokeColor('#bbbbbb')
      .stroke();
    doc.moveDown(0.5);
    doc.fillColor('#000000').font('Helvetica').fontSize(10);
    for (const line of s.lines) {
      const y = doc.y;
      doc.text(line.label, cols.label, y, { width: cols.hours - left - 10 });
      const rowH = doc.y - y;
      doc.text(line.hours.toFixed(2), cols.hours, y, { width: 60, align: 'right' });
      doc.text(money(line.rate), cols.rate, y, { width: 55, align: 'right' });
      doc.text(money(line.amount), cols.amount, y, { width: 65, align: 'right' });
      doc.y = y + Math.max(rowH, 14);
    }
    doc
      .moveTo(left, doc.y + 3)
      .lineTo(right, doc.y + 3)
      .lineWidth(0.5)
      .strokeColor('#bbbbbb')
      .stroke();
    doc.moveDown(0.5);
    doc.font('Helvetica-Bold');
    const ty = doc.y;
    doc.text(
      `Total — ${s.totals.hours.toFixed(2)} h (${s.totals.regularHours.toFixed(2)} regular, ${s.totals.otHours.toFixed(2)} overtime)`,
      cols.label,
      ty,
      { width: cols.amount - left - 10 },
    );
    doc.text(money(s.totals.amount), cols.amount, ty, { width: 65, align: 'right' });
    doc.moveDown(1.2);

    // ---- Store subtotals -----------------------------------------------------
    if (s.stores.length > 1) {
      doc.font('Helvetica-Bold').fontSize(11).text('By work site', left);
      doc.moveDown(0.4);
      doc.font('Helvetica').fontSize(10);
      for (const st of s.stores) {
        const y = doc.y;
        doc.text(st.locationName, cols.label, y, { width: cols.hours - left - 10 });
        doc.text(st.hours.toFixed(2), cols.hours, y, { width: 60, align: 'right' });
        doc.text(money(st.amount), cols.amount, y, { width: 65, align: 'right' });
        doc.y = y + 14;
      }
      doc.moveDown(1);
    }

    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor('#777777')
      .text(
        'Hours are approved time net of unpaid breaks. Overtime is the portion of an associate’s week beyond 40 hours across all assignments, billed at 1.5× per the SOW.',
        left,
        undefined,
        { width },
      );

    doc.end();
  });
}
