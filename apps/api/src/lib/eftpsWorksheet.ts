import PDFDocument from 'pdfkit';

/**
 * EFTPS payment worksheet — one page carrying exactly the figures finance
 * keys into eftps.gov (or their bank's tax-payment screen) for a federal
 * deposit: EIN, form (941/940), tax period, settlement deadline, and the
 * sub-amount breakdown the IRS asks for on 941 deposits.
 */

export interface EftpsWorksheetData {
  ein: string;
  companyName: string;
  kind: 'FED_941' | 'FUTA';
  periodLabel: string;
  liabilityDate: string; // YYYY-MM-DD
  dueDate: string; // YYYY-MM-DD
  amount: number;
  breakdown: Record<string, unknown>;
  status: string;
  confirmationNumber: string | null;
}

const money = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export function renderEftpsWorksheetPdf(data: EftpsWorksheetData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 56 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.font('Helvetica-Bold').fontSize(16).text('Federal tax deposit worksheet');
    doc
      .font('Helvetica')
      .fontSize(10)
      .fillColor('#666666')
      .text('Key these figures into EFTPS (eftps.gov) or your bank\'s federal tax payment service.')
      .fillColor('#000000')
      .moveDown(1.5);

    const row = (label: string, value: string, bold = false) => {
      doc.font('Helvetica').fontSize(10).fillColor('#555555').text(label, { continued: false });
      doc
        .font(bold ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(bold ? 14 : 11)
        .fillColor('#000000')
        .text(value)
        .moveDown(0.7);
    };

    row('Employer (EIN)', `${data.companyName} — ${data.ein.slice(0, 2)}-${data.ein.slice(2)}`);
    row('Tax form', data.kind === 'FED_941' ? 'Form 941 — Employer\'s Quarterly Federal Tax Return' : 'Form 940 — FUTA');
    row('Liability period', `${data.periodLabel} (liability date ${data.liabilityDate})`);
    row('Settlement deadline', data.dueDate, true);
    row('Payment amount', money(data.amount), true);

    doc.moveDown(0.5);
    doc.font('Helvetica-Bold').fontSize(11).text('Breakdown');
    doc.moveDown(0.3);
    const labels: Record<string, string> = {
      fit: 'Federal income tax withheld',
      ssEmployee: 'Social Security — employee share',
      ssEmployer: 'Social Security — employer share',
      medEmployee: 'Medicare — employee share',
      medEmployer: 'Medicare — employer share',
      futa: 'FUTA (net 0.6%)',
    };
    doc.font('Helvetica').fontSize(10);
    for (const [key, label] of Object.entries(labels)) {
      const v = data.breakdown[key];
      if (typeof v !== 'number') continue;
      const y = doc.y;
      doc.text(label, 56, y);
      doc.text(money(v), 400, y, { width: 100, align: 'right' });
      doc.moveDown(0.35);
    }
    if (data.breakdown.nextDayRule === true) {
      doc
        .moveDown(0.5)
        .fillColor('#aa0000')
        .fontSize(10)
        .text('⚠ $100,000 next-day rule applies — this deposit is due the next business day after the payday.')
        .fillColor('#000000');
    }
    if (data.breakdown.belowDepositFloor === true) {
      doc
        .moveDown(0.5)
        .fillColor('#666666')
        .fontSize(9)
        .text('FUTA quarter liability is $500 or less — it may roll into the next quarter instead of depositing now (Form 940 instructions).')
        .fillColor('#000000');
    }

    doc.moveDown(1.5);
    doc
      .font('Helvetica')
      .fontSize(10)
      .text(
        data.status === 'PAID'
          ? `PAID — EFTPS acknowledgment: ${data.confirmationNumber ?? '—'}`
          : 'After paying, record the EFTPS acknowledgment number in Alto (Payroll → Tax deposits → Mark paid).',
      );

    doc.end();
  });
}
