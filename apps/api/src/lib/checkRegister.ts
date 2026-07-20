import PDFDocument from 'pdfkit';

/**
 * Check-register PDF for a payroll run — the sheet the office prints and
 * writes physical checks from (or hands to the bank's check-printing
 * service). One line per PayCheck: number, date, payee, memo, amount, with
 * a run total and signature line. VOIDED checks render struck-through so
 * the register stays a complete audit trail of every number ever issued.
 */

export interface CheckRegisterRow {
  checkNumber: number;
  issuedAt: string; // ISO date
  payeeName: string;
  memo: string | null;
  amount: number;
  voided: boolean;
}

export interface CheckRegisterData {
  company: { name: string };
  run: { id: string; periodStart: string; periodEnd: string };
  rows: CheckRegisterRow[];
  generatedAt: string;
}

const money = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export function renderCheckRegisterPdf(data: CheckRegisterData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 48 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.font('Helvetica-Bold').fontSize(16).text(data.company.name);
    doc
      .font('Helvetica')
      .fontSize(11)
      .text(`Payroll check register — pay period ${data.run.periodStart} to ${data.run.periodEnd}`)
      .fontSize(8)
      .fillColor('#666666')
      .text(`Run ${data.run.id} · generated ${data.generatedAt}`)
      .fillColor('#000000')
      .moveDown(1);

    const cols = { num: 48, date: 110, payee: 180, memo: 340, amount: 500 };
    const rowH = 18;
    const header = () => {
      doc.font('Helvetica-Bold').fontSize(9);
      doc.text('Check #', cols.num, doc.y, { continued: false });
      const y = doc.y - 11;
      doc.text('Date', cols.date, y);
      doc.text('Payee', cols.payee, y);
      doc.text('Memo', cols.memo, y);
      doc.text('Amount', cols.amount, y, { width: 64, align: 'right' });
      doc
        .moveTo(48, doc.y + 2)
        .lineTo(564, doc.y + 2)
        .strokeColor('#999999')
        .stroke()
        .strokeColor('#000000');
      doc.moveDown(0.4);
    };
    header();

    doc.font('Helvetica').fontSize(9);
    let total = 0;
    for (const row of data.rows) {
      if (doc.y > 700) {
        doc.addPage();
        header();
        doc.font('Helvetica').fontSize(9);
      }
      const y = doc.y;
      if (row.voided) doc.fillColor('#999999');
      doc.text(String(row.checkNumber), cols.num, y);
      doc.text(row.issuedAt.slice(0, 10), cols.date, y);
      doc.text(row.payeeName.slice(0, 28), cols.payee, y, { width: 150 });
      doc.text((row.voided ? 'VOID — ' : '') + (row.memo ?? '').slice(0, 30), cols.memo, y, { width: 150 });
      doc.text(row.voided ? '—' : money(row.amount), cols.amount, y, { width: 64, align: 'right' });
      if (row.voided) {
        doc
          .moveTo(cols.num, y + 5)
          .lineTo(564, y + 5)
          .strokeColor('#bbbbbb')
          .stroke()
          .strokeColor('#000000');
      } else {
        total += row.amount;
      }
      doc.fillColor('#000000');
      doc.y = y + rowH;
    }

    doc.moveDown(0.5);
    doc
      .moveTo(340, doc.y)
      .lineTo(564, doc.y)
      .strokeColor('#000000')
      .stroke();
    doc.moveDown(0.3);
    const yTot = doc.y;
    doc.font('Helvetica-Bold').fontSize(10);
    doc.text(`${data.rows.filter((r) => !r.voided).length} checks`, cols.payee, yTot);
    doc.text('Total', cols.memo, yTot);
    doc.text(money(total), cols.amount, yTot, { width: 64, align: 'right' });

    doc.moveDown(3);
    doc.font('Helvetica').fontSize(9).text('Authorized signature: ____________________________     Date: ______________', 48);

    doc.end();
  });
}
