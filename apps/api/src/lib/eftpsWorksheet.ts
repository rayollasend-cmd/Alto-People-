import { createDoc, fmt } from './docKit/index.js';

/**
 * EFTPS payment worksheet — one page carrying exactly the figures finance
 * keys into eftps.gov (or their bank's tax-payment screen) for a federal
 * deposit: EIN, form (941/940), tax period, settlement deadline, and the
 * sub-amount breakdown the IRS asks for on 941 deposits. Laid out in the
 * order the EFTPS screens ask for them, the deadline and amount first.
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

const BREAKDOWN: Record<string, string> = {
  fit: 'Federal income tax withheld',
  ssEmployee: 'Social Security — employee share',
  ssEmployer: 'Social Security — employer share',
  medEmployee: 'Medicare — employee share',
  medEmployer: 'Medicare — employer share',
  futa: 'FUTA (net 0.6%)',
};

export async function renderEftpsWorksheetPdf(data: EftpsWorksheetData): Promise<Buffer> {
  const paid = data.status === 'PAID';
  const form = data.kind === 'FED_941' ? "Form 941 — Employer's Quarterly Federal Tax Return" : 'Form 940 — Federal Unemployment (FUTA) Tax';
  const { k } = createDoc({ title: `Federal tax deposit · ${data.periodLabel}`, author: data.companyName });
  let y = k.masthead({
    title: 'Federal tax deposit',
    subtitle: 'EFTPS payment worksheet',
    brand: { name: data.companyName, lines: [`EIN ${fmt.ein(data.ein)}`] },
  });
  if (paid) y = k.callout({ tone: 'good', title: 'Paid', body: `EFTPS acknowledgment number ${data.confirmationNumber ?? '—'}.` }, y);
  y = k.figures(
    [
      { label: 'Settle by', value: fmt.date(data.dueDate), tone: paid ? undefined : 'warn' },
      { label: 'Amount to pay', value: fmt.money(data.amount), emphasis: true },
    ],
    y,
  );
  y = k.section('Enter in EFTPS', y, 'In the order the screens ask');
  y = k.facts(
    [
      { label: 'Employer identification number', value: fmt.ein(data.ein), strong: true },
      { label: 'Tax form', value: form },
      { label: 'Tax period', value: data.periodLabel },
      { label: 'Liability date', value: fmt.date(data.liabilityDate) },
    ],
    y,
  );
  const rows = Object.entries(BREAKDOWN)
    .filter(([key]) => typeof data.breakdown[key] === 'number')
    .map(([key, label]) => ({ label, amount: data.breakdown[key] as number }));
  if (rows.length) {
    y = k.section('Breakdown', y);
    y = k.table({
      y,
      rows,
      columns: [
        { key: 'label', header: 'Amount type', width: 7, value: (r) => r.label },
        { key: 'amount', header: 'Amount', width: 3, align: 'right', value: (r) => fmt.money(r.amount) },
      ],
      totals: { label: 'Total deposit', amount: fmt.money(data.amount) },
    });
  }
  if (data.breakdown.nextDayRule === true) {
    y = k.callout({ tone: 'bad', title: '$100,000 next-day rule applies', body: 'This deposit is due the next business day after the payday, not on the normal schedule.' }, y);
  }
  if (data.breakdown.belowDepositFloor === true) {
    y = k.callout({ tone: 'neutral', body: 'FUTA liability for the quarter is $500 or less: it may roll into the next quarter instead of being deposited now (Form 940 instructions).' }, y);
  }
  if (!paid) k.callout({ tone: 'info', title: 'After you pay', body: 'Record the EFTPS acknowledgment number in Alto: Payroll → Payroll taxes → Deposits → Mark paid.' }, y);
  return k.finish({ reference: `EFTPS worksheet · ${data.periodLabel}` });
}
