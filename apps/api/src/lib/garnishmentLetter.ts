// Garnishment notice / acknowledgment letter PDF.
//
// Produces a plain-paper PDF that operators can mail to the garnishing
// authority (court, child-support agency, IRS) confirming the order has
// been received and is being honored. Distinct from the IRS-furnished
// notice itself — this is the *response* the employer is required to
// send acknowledging compliance.
//
// A business letter on the employer's letterhead: the addressee, the
// "Re:" block that lets the agency match it to its case, the
// acknowledgment, the withholding terms, every deduction so far, and a
// signature block — reviewed by finance before it goes in the mail.

import { COLOR, SIZE, createDoc, fmt } from './docKit/index.js';
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

export async function renderGarnishmentLetterPdf(data: GarnishmentLetterData): Promise<Buffer> {
  const { garnishment: g, associate, deductions, employer } = data;
  const name = `${associate.firstName} ${associate.lastName}`;
  const { k } = createDoc({ title: `${KIND_LABEL[g.kind]} · ${name}`, author: employer.name });
  const loc = [[employer.city, employer.state].filter(Boolean).join(', '), employer.zip].filter(Boolean).join(' ');
  let y = k.letterhead({
    brand: { name: employer.name, lines: [[employer.addressLine1, employer.addressLine2].filter(Boolean).join(', '), loc, [employer.phone ? `Tel ${employer.phone}` : null, employer.ein ? `EIN ${fmt.ein(employer.ein)}` : null].filter(Boolean).join('  ·  ')].filter((l) => !!l) as string[] },
    date: fmt.date(new Date()),
    reference: g.caseNumber ? `Case ${g.caseNumber}` : undefined,
  });

  // Addressee.
  const to = [g.remitTo ?? g.agencyName ?? 'Issuing authority', ...(g.remitAddress ? g.remitAddress.split('\n') : [])];
  for (const l of to) {
    k.text(l, k.L, y, { size: SIZE.body, width: k.width() * 0.6 });
    y += 13;
  }
  y += 14;

  // Re: block — what the agency matches the letter to.
  k.text('Re:', k.L, y, { size: SIZE.body, weight: 'semibold' });
  const re = [KIND_LABEL[g.kind], `Employee: ${name}`, g.caseNumber ? `Case number: ${g.caseNumber}` : null, `Order received: ${fmt.date(g.startDate)}`, g.endDate ? `Order ends: ${fmt.date(g.endDate)}` : null].filter((l): l is string => !!l);
  for (const l of re) {
    k.text(l, k.L + 30, y, { size: SIZE.body, weight: l === re[0] ? 'semibold' : 'regular', width: k.width() - 30 });
    y += 13;
  }
  y += 12;

  const body = [
    'To whom it may concern:',
    `This letter confirms that ${employer.name} received the order referenced above and has begun withholding from the named employee's wages in accordance with applicable federal and state law. Withholding will continue until the amount ordered is reached, the order ends, or we receive written notice from your office.`,
  ];
  for (const p2 of body) y += k.para(p2, k.L, y, k.width(), { size: SIZE.body, color: COLOR.ink }) + 10;

  y = k.section('Withholding terms', y);
  const terms = [
    ...(g.amountPerRun ? [{ label: 'Amount per pay period', value: fmt.money(Number(g.amountPerRun)) }] : []),
    ...(g.percentOfDisp ? [{ label: 'Share of disposable earnings', value: fmt.percent(Number(g.percentOfDisp), 2) }] : []),
    ...(g.totalCap ? [{ label: 'Total ordered', value: fmt.money(Number(g.totalCap)) }] : []),
    { label: 'Withheld to date', value: fmt.money(Number(g.amountWithheld)), strong: true },
    { label: 'Status', value: g.status.charAt(0) + g.status.slice(1).toLowerCase() },
  ];
  y = k.facts(terms, y, { cols: 3 });

  if (deductions.length) {
    y = k.section('Deductions so far', y, `${deductions.length} ${deductions.length === 1 ? 'deduction' : 'deductions'}`);
    y = k.table({
      y,
      rows: deductions,
      columns: [
        { key: 'on', header: 'Deducted on', width: 3, value: (d) => fmt.date(d.deductedOn) },
        { key: 'run', header: 'Payroll run', width: 4, value: (d) => (d.payrollRunId ? d.payrollRunId.slice(0, 8).toUpperCase() : 'Manual') },
        { key: 'amt', header: 'Amount', width: 3, align: 'right', value: (d) => fmt.money(Number(d.amount)) },
      ],
      totals: { on: 'Total', amt: fmt.money(deductions.reduce((s, d) => s + Number(d.amount), 0)) },
    });
  }

  y = k.ensure(y + 10, 90);
  y += k.para('Please contact our payroll office with any questions about this order.', k.L, y, k.width(), { size: SIZE.body }) + 8;
  k.text('Sincerely,', k.L, y, { size: SIZE.body });
  y += 46;
  k.signatureLine(k.L, y, 230, 'Authorized signature');
  k.signatureLine(k.L + 260, y, 140, 'Date');
  y += 34;
  k.signatureLine(k.L, y, 230, 'Printed name and title');
  return k.finish({ reference: g.caseNumber ? `Case ${g.caseNumber}` : 'Garnishment acknowledgment', note: employer.name });
}
