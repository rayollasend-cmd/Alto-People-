// Garnishment notice / acknowledgment letter PDF.
//
// Produces a plain-paper PDF that operators can mail to the garnishing
// authority (court, child-support agency, IRS) confirming the order has
// been received and is being honored. Distinct from the IRS-furnished
// notice itself — this is the *response* the employer is required to
// send acknowledging compliance.
//
// Layout is intentionally form-shaped (header → addressee block →
// recipient block → garnishment summary → withheld-to-date table →
// signature block) so finance can review before mailing.

import PDFDocument from 'pdfkit';
import type {
  Garnishment,
  GarnishmentDeduction,
  GarnishmentKind,
  Associate,
} from '@prisma/client';

const KIND_LABEL: Record<GarnishmentKind, string> = {
  CHILD_SUPPORT: 'Income Withholding for Support (Child Support)',
  TAX_LEVY: 'IRS Notice of Levy on Wages',
  STUDENT_LOAN: 'Administrative Wage Garnishment (Student Loan)',
  BANKRUPTCY: 'Bankruptcy Trustee Order',
  CREDITOR: 'Creditor Garnishment',
  OTHER: 'Garnishment Order',
};

export interface GarnishmentLetterData {
  garnishment: Garnishment;
  associate: Pick<Associate, 'firstName' | 'lastName' | 'email'>;
  deductions: GarnishmentDeduction[];
  /** Employer block — pulled from system settings or org branding. */
  employer: {
    name: string;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
    phone: string | null;
    ein: string | null;
  };
}

const fmt = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const fmtDate = (d: Date) => d.toISOString().slice(0, 10);

export async function renderGarnishmentLetterPdf(
  data: GarnishmentLetterData,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 54 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const { garnishment: g, associate, deductions, employer } = data;

    doc.font('Helvetica-Bold').fontSize(14).text(KIND_LABEL[g.kind]);
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor('#444')
      .text(`Employer acknowledgment letter · generated ${fmtDate(new Date())}`)
      .moveDown(0.5);
    doc.fillColor('#000');

    doc.fontSize(10);
    doc.text(employer.name);
    if (employer.addressLine1) doc.text(employer.addressLine1);
    if (employer.addressLine2) doc.text(employer.addressLine2);
    if (employer.city || employer.state || employer.zip) {
      doc.text([employer.city, employer.state, employer.zip].filter(Boolean).join(', '));
    }
    if (employer.phone) doc.text(`Phone: ${employer.phone}`);
    if (employer.ein) doc.text(`EIN: ${employer.ein}`);
    doc.moveDown();

    doc.font('Helvetica-Bold').text('To:');
    doc.font('Helvetica');
    doc.text(g.remitTo ?? g.agencyName ?? '— Issuing authority —');
    if (g.remitAddress) {
      g.remitAddress.split('\n').forEach((line) => doc.text(line));
    }
    doc.moveDown();

    doc.font('Helvetica-Bold').text('Re:');
    doc.font('Helvetica');
    doc.text(`Employee: ${associate.firstName} ${associate.lastName}`);
    if (g.caseNumber) doc.text(`Case number: ${g.caseNumber}`);
    doc.text(`Order received: ${fmtDate(g.startDate)}`);
    if (g.endDate) doc.text(`Order ends: ${fmtDate(g.endDate)}`);
    doc.moveDown();

    doc
      .text(
        `This letter confirms that we received the above order and have begun ` +
          `withholding from the named employee's wages in accordance with applicable ` +
          `federal and state law. Withholding will continue until the cap is reached, ` +
          `the order terminates, or we receive written notice from your office.`,
        { align: 'justify' },
      )
      .moveDown();

    doc.font('Helvetica-Bold').text('Withholding terms');
    doc.font('Helvetica');
    if (g.amountPerRun) {
      doc.text(`Amount per pay period: ${fmt(Number(g.amountPerRun))}`);
    }
    if (g.percentOfDisp) {
      doc.text(`Percentage of disposable earnings: ${(Number(g.percentOfDisp) * 100).toFixed(2)}%`);
    }
    if (g.totalCap) {
      doc.text(`Total cap: ${fmt(Number(g.totalCap))}`);
    }
    doc.text(`Withheld to date: ${fmt(Number(g.amountWithheld))}`);
    doc.text(`Status: ${g.status}`);
    doc.moveDown();

    if (deductions.length > 0) {
      doc.font('Helvetica-Bold').text('Deduction history');
      doc.font('Helvetica').fontSize(9);
      const rowH = 14;
      const colDate = 60;
      const colRun = 200;
      const colAmt = 480;
      const startY = doc.y;
      doc.text('Deducted on', colDate, startY);
      doc.text('Payroll run', colRun, startY);
      doc.text('Amount', colAmt, startY, { align: 'right' });
      doc.moveTo(54, startY + rowH - 2).lineTo(560, startY + rowH - 2).stroke();
      let y = startY + rowH;
      for (const d of deductions.slice(0, 30)) {
        doc.text(d.deductedOn.toISOString().slice(0, 10), colDate, y);
        doc.text(d.payrollRunId ? d.payrollRunId.slice(0, 8) : 'Manual', colRun, y);
        doc.text(fmt(Number(d.amount)), colAmt, y, { align: 'right' });
        y += rowH;
      }
      if (deductions.length > 30) {
        doc.text(`(+${deductions.length - 30} earlier deductions not shown)`, colDate, y);
        y += rowH;
      }
      doc.moveDown(2);
      doc.fontSize(10);
      doc.x = 54;
    }

    doc.moveDown(2);
    doc.font('Helvetica-Bold').text('Authorized signature');
    doc.font('Helvetica');
    doc.moveDown();
    doc.text('________________________________________      Date: ___________');
    doc.moveDown(0.5);
    doc.text('Print name and title');

    doc.end();
  });
}
