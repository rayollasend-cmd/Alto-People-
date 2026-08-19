import PDFDocument from 'pdfkit';
import type { StatementSnapshot } from './clientStatement.js';

/**
 * Client statement PDF — the letterheaded artifact procurement files.
 * Ledger-plain layout: org letterhead + bill-to block, service levels,
 * billed line items, per-store subtotals, total, numbered footer on every
 * page. DRAFTs carry a visible watermark band; FINAL statements carry
 * their sequential number and who finalized them.
 */
export async function renderStatementPdf(input: {
  snapshot: StatementSnapshot;
  number: number | null;
  status: string;
  finalizedAt: Date | null;
  finalizedByEmail?: string | null;
  orgName?: string;
  billTo?: {
    legalName: string | null;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
  } | null;
}): Promise<Buffer> {
  const { snapshot: s } = input;
  const orgName = input.orgName ?? 'Alto People';
  const stmtLabel =
    input.status === 'FINAL' && input.number !== null
      ? `Statement No. ${String(input.number).padStart(4, '0')}`
      : 'DRAFT';
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margin: 54,
      bufferPages: true,
      info: {
        Title: `${stmtLabel} — ${s.clientName} — ${s.periodStart} to ${s.periodEnd}`,
        Author: orgName,
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
    doc.font('Helvetica-Bold').fontSize(20).fillColor('#0B1832').text(orgName, left, 54);
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor('#666666')
      .text('WORKFORCE SERVICES STATEMENT', { characterSpacing: 1.2 });
    // Statement number, top right.
    doc
      .font('Helvetica-Bold')
      .fontSize(12)
      .fillColor(input.status === 'FINAL' ? '#0B1832' : '#B45309')
      .text(stmtLabel, left, 58, { width, align: 'right' });
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor('#666666')
      .text(`Period ${s.periodStart} — ${s.periodEnd}`, left, 76, {
        width,
        align: 'right',
      });
    if (input.status === 'FINAL' && input.finalizedAt) {
      doc.text(
        `Finalized ${input.finalizedAt.toISOString().slice(0, 10)}${
          input.finalizedByEmail ? ` by ${input.finalizedByEmail}` : ''
        }`,
        left,
        doc.y,
        { width, align: 'right' },
      );
    }

    doc
      .moveTo(left, 108)
      .lineTo(right, 108)
      .lineWidth(1.5)
      .strokeColor('#0B1832')
      .stroke();

    // ---- Bill-to ------------------------------------------------------------
    doc.y = 122;
    doc.font('Helvetica').fontSize(8).fillColor('#888888').text('BILLED TO', left);
    doc
      .font('Helvetica-Bold')
      .fontSize(12)
      .fillColor('#000000')
      .text(input.billTo?.legalName || s.clientName);
    doc.font('Helvetica').fontSize(10).fillColor('#333333');
    const addr = input.billTo;
    if (addr?.addressLine1) doc.text(addr.addressLine1);
    if (addr?.addressLine2) doc.text(addr.addressLine2);
    const cityLine = [addr?.city, addr?.state, addr?.zip].filter(Boolean).join(', ');
    if (cityLine) doc.text(cityLine);

    // ---- Draft watermark band -----------------------------------------------
    if (input.status !== 'FINAL') {
      doc.moveDown(0.6);
      const bandY = doc.y;
      doc.rect(left, bandY, width, 20).fillColor('#FDF3E1').fill();
      doc
        .fillColor('#8a5a00')
        .font('Helvetica-Bold')
        .fontSize(9)
        .text(
          'DRAFT — figures recompute as approvals land and may change until finalized.',
          left + 8,
          bandY + 6,
        );
      doc.fillColor('#000000');
      doc.y = bandY + 28;
    } else {
      doc.moveDown(1);
    }

    // ---- Service levels ----------------------------------------------------
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#000000').text('Service levels', left);
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(10).fillColor('#333333');
    const sla = s.sla;
    doc.text(
      `Shifts published: ${sla.publishedShifts} · filled: ${sla.assignedShifts}` +
        (sla.fillRatePct !== null ? ` (${sla.fillRatePct}% fill rate)` : ''),
    );
    doc.text(
      sla.punctualPct !== null
        ? `On-time arrivals: ${sla.punctualPct}% of shift-linked punches`
        : 'On-time arrivals: no shift-linked punches in period',
    );
    doc.text(`No-shows flagged: ${sla.noShows}`);
    if (sla.pendingEntries > 0) {
      doc
        .fillColor('#8a5a00')
        .text(
          `Note: ${sla.pendingEntries} time ${sla.pendingEntries === 1 ? 'entry' : 'entries'} in this period still await approval and are NOT billed here.`,
        )
        .fillColor('#333333');
    }
    doc.moveDown(1);

    // ---- Line items ---------------------------------------------------------
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#000000').text('Billed services', left);
    doc.moveDown(0.4);
    const cols = { label: left, hours: right - 200, rate: right - 130, amount: right - 65 };
    const headerY = doc.y;
    doc.fontSize(8).fillColor('#888888').font('Helvetica-Bold');
    doc.text('SERVICE', cols.label, headerY);
    doc.text('HOURS', cols.hours, headerY, { width: 60, align: 'right' });
    doc.text('RATE', cols.rate, headerY, { width: 55, align: 'right' });
    doc.text('AMOUNT', cols.amount, headerY, { width: 65, align: 'right' });
    doc.y = headerY + 12;
    doc
      .moveTo(left, doc.y)
      .lineTo(right, doc.y)
      .lineWidth(0.5)
      .strokeColor('#bbbbbb')
      .stroke();
    doc.moveDown(0.4);
    doc.fillColor('#000000').font('Helvetica').fontSize(10);
    for (const line of s.lines) {
      const y = doc.y;
      doc.text(line.label, cols.label, y, { width: cols.hours - left - 10 });
      const rowH = doc.y - y;
      doc.text(line.hours.toFixed(2), cols.hours, y, { width: 60, align: 'right' });
      doc.text(money(line.rate), cols.rate, y, { width: 55, align: 'right' });
      doc.text(money(line.amount), cols.amount, y, { width: 65, align: 'right' });
      doc.y = y + Math.max(rowH, 15);
    }
    doc
      .moveTo(left, doc.y + 2)
      .lineTo(right, doc.y + 2)
      .lineWidth(1)
      .strokeColor('#0B1832')
      .stroke();
    doc.moveDown(0.5);
    doc.font('Helvetica-Bold').fontSize(11);
    const ty = doc.y;
    doc.text(
      `Total due — ${s.totals.hours.toFixed(2)} h (${s.totals.regularHours.toFixed(2)} regular, ${s.totals.otHours.toFixed(2)} overtime)`,
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
        doc.y = y + 15;
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

    // ---- Footer on every page ------------------------------------------------
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc
        .font('Helvetica')
        .fontSize(8)
        .fillColor('#999999')
        .text(
          `${orgName} · ${stmtLabel} · ${s.clientName} · page ${i - range.start + 1} of ${range.count}`,
          left,
          doc.page.height - 40,
          { width, align: 'center', lineBreak: false },
        );
    }

    doc.end();
  });
}
