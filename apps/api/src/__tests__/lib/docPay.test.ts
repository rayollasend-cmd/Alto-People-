import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { pdfText } from '../../../test/pdfText.js';
import { fmt } from '../../lib/docKit/index.js';
import { renderPaystubPdf, type PaystubData } from '../../lib/paystub.js';
import { renderW2Pdf, renderW2Pdf4Up, type W2PdfData } from '../../lib/w2Pdf.js';
import { renderW2cPdf } from '../../lib/w2cPdf.js';
import { renderForm1099NecPdf } from '../../lib/f1099NecPdf.js';
import { renderRemittanceAdvicePdf } from '../../lib/garnishmentRemittance.js';
import { renderTaxFormSummaryPdf } from '../../lib/taxFormSummaryPdf.js';

/**
 * The pay and tax documents on docKit: what each must say, for whom.
 * Text is read back out of the PDF through the embedded fonts' maps.
 */

/** Whitespace-insensitive "contains": wrapped lines drop the space at the break. */
const squash = (s: string) => s.replace(/\s+/g, '');
const has = (text: string, needle: string) => squash(text).includes(squash(needle));

const stub = (o: Partial<PaystubData> = {}): PaystubData => ({
  company: { name: 'Coastal Resort Holdings LLC', addressLine1: '100 Gulf Blvd', city: 'Panama City Beach', state: 'FL', zip: '32413', ein: '123456789', phone: null },
  associate: { firstName: 'Ana', lastName: 'López', email: null, addressLine1: '22 Palm Ct', city: 'Destin', state: 'FL', zip: '32541', employeeId: 'A1B2C3', ssnLast4: '6789' },
  period: { start: '2026-09-26', end: '2026-10-09', payDate: '2026-10-16' },
  earnings: [{ label: 'Regular', hours: 72, rate: 18.5, amount: 1332 }],
  gross: { current: 1332, ytd: 25000 },
  taxes: [{ label: 'Federal income tax', current: 121.4, ytd: 2301.2 }, { label: 'FL state income tax', current: 0, ytd: 0 }],
  taxesTotal: { current: 121.4, ytd: 2301.2 },
  preTaxDeductions: [{ label: 'Medical (Blue Shield PPO)', current: 52.5, ytd: 997.5 }, { label: 'Dental', current: 12, ytd: 228 }],
  postTaxDeductions: [{ label: 'Child support — Order 2026-DR-0412', current: 150, ytd: 2850 }],
  employerContributions: [{ label: '401(k) match', current: 50.3, ytd: 955.7 }],
  net: { current: 996.1, ytd: 18000 },
  employer: { fica: 82.58, medicare: 19.31, futa: 0, suta: 44.46 },
  payDistribution: { label: 'Direct deposit', detail: 'Checking ••••4821' },
  payMethod: 'DIRECT_DEPOSIT',
  meta: { runId: '7b904b7e-d105-4d0e', itemId: '00c9c41f-36f5-45b8', issuedAt: '2026-10-14T15:00:00Z' },
  hoursTotal: 72,
  ...o,
});

describe('money in the house style', () => {
  it('never prints a negative zero', () => {
    expect(fmt.money(-0.001)).toBe('$0.00');
    expect(fmt.money(0)).toBe('$0.00');
    expect(fmt.money(-12)).toBe('−$12.00');
    expect(fmt.money(12, { signed: true })).toBe('+$12.00');
  });
});

describe('the paystub', () => {
  it('itemizes every deduction, shows what the employer paid, how it was paid, and marks a deposit advice non-negotiable', async () => {
    const text = pdfText(await renderPaystubPdf(stub()));
    expect(has(text, 'Medical (Blue Shield PPO)')).toBe(true);
    expect(has(text, 'Dental')).toBe(true);
    expect(has(text, 'Child support — Order 2026-DR-0412')).toBe(true);
    expect(has(text, 'Your employer also paid')).toBe(true);
    expect(has(text, '401(k) match')).toBe(true);
    expect(has(text, 'Checking ••••4821')).toBe(true);
    expect(has(text, 'NON-NEGOTIABLE · THIS IS NOT A CHECK')).toBe(true);
    // State wage-statement items: employer legal name and address, inclusive dates, ID.
    expect(has(text, 'Sep 26, 2026 – Oct 9, 2026')).toBe(true);
    expect(has(text, 'Employee ID A1B2C3')).toBe(true);
    // A $0.00 tax line is $0.00, never a negative zero.
    expect(text).not.toMatch(/[-−]\$0\.00/);
  });

  it('a check-paid stub is not marked non-negotiable; a correction and a void say so', async () => {
    const check = pdfText(await renderPaystubPdf(stub({ payDistribution: { label: 'Paper check', detail: 'Check #1042' }, payMethod: 'CHECK' })));
    expect(has(check, 'Check #1042')).toBe(true);
    expect(has(check, 'NON-NEGOTIABLE')).toBe(false);
    const corrected = pdfText(await renderPaystubPdf(stub({ amendment: { reason: 'Missed 4 hours of overtime', sourceRunId: 'x' } })));
    expect(has(corrected, 'Corrected earnings statement')).toBe(true);
    expect(has(corrected, 'Missed 4 hours of overtime')).toBe(true);
    const voided = pdfText(await renderPaystubPdf(stub({ voided: { voidedAt: '2026-10-17T00:00:00Z', reason: 'Paid to the wrong account' } })));
    expect(has(voided, 'This paycheck was voided')).toBe(true);
    expect(has(voided, 'Paid to the wrong account')).toBe(true);
  });

  it('renders in Spanish when the person reads Spanish', async () => {
    const text = pdfText(await renderPaystubPdf(stub({ language: 'es' })));
    expect(has(text, 'Recibo de pago')).toBe(true);
    expect(has(text, 'PAGO NETO')).toBe(true);
    expect(has(text, 'Su empleador también pagó')).toBe(true);
    expect(has(text, 'NO NEGOCIABLE')).toBe(true);
  });
});

const w2: W2PdfData = {
  taxYear: 2026,
  employer: { ein: '12-3456789', name: 'Coastal Resort Holdings LLC', addressLine1: '100 Gulf Blvd', addressLine2: null, city: 'Panama City Beach', state: 'FL', zip: '32413' },
  employee: { ssn: '123-45-6789', firstName: 'Ana', lastName: 'López', addressLine1: '22 Palm Ct', addressLine2: null, city: 'Philadelphia', state: 'PA', zip: '19104' },
  controlNumber: 'A1B2C3D4',
  boxes: {
    box1Wages: 48210.55,
    box2FitWithheld: 4120.3,
    box3SsWages: 50110.55,
    box4SsTax: 3106.85,
    box5MedicareWages: 50110.55,
    box6MedicareTax: 726.6,
    box12: [{ code: 'D', amount: 1900 }, { code: 'DD', amount: 6840 }, { code: 'W', amount: 600 }, { code: 'AA', amount: 450 }, { code: 'TT', amount: 1066 }],
    box13RetirementPlan: true,
    box14Other: [{ label: 'Union dues', amount: 240 }],
    stateLines: [{ state: 'PA', stateWages: 50110.55, stateIncomeTax: 1538.39 }],
    localLines: [{ state: 'PA', locality: 'Philadelphia', code: 'PHL', kind: 'LOCAL', localWages: 50110.55, localIncomeTax: 1878.14 }],
    sourceItemCount: 26,
  },
  meta: { formId: 'f00c9c41-36f5', generatedAt: '2027-01-20T12:00:00Z' },
};

describe('Form W-2 for the employee', () => {
  it('carries the IRS legends and boxes, truncates the SSN, and lists every box 12 code (more than four allowed)', async () => {
    const text = pdfText(await renderW2Pdf(w2));
    expect(has(text, "Copy B, To Be Filed With Employee's FEDERAL Tax Return.")).toBe(true);
    expect(has(text, "Copy C, For EMPLOYEE'S RECORDS")).toBe(true);
    expect(has(text, "Copy 2, To Be Filed With Employee's State, City, or Local Income Tax Return.")).toBe(true);
    expect(has(text, 'This information is being furnished to the Internal Revenue Service.')).toBe(true);
    expect(has(text, 'Department of the Treasury—Internal Revenue Service')).toBe(true);
    expect(has(text, 'OMB No. 1545-0029')).toBe(true);
    expect(has(text, 'Wage and Tax Statement')).toBe(true);
    expect(has(text, 'XXX-XX-6789')).toBe(true);
    expect(text).not.toContain('123-45-6789');
    for (const code of ['D', 'DD', 'W', 'AA', 'TT']) expect(has(text, `${code}   `.trim())).toBe(true);
    expect(has(text, '1,066.00')).toBe(true);
    expect(has(text, 'Philadelphia')).toBe(true);
    // The notice the IRS requires, including the earned income credit.
    expect(has(text, 'Earned income credit (EIC)')).toBe(true);
    // The cover explains box 12 DD in plain English.
    expect(has(text, 'Cost of employer-sponsored health coverage (not taxable)')).toBe(true);
  });

  it('the same form renders to the same bytes, so its stored hash holds', async () => {
    const a = createHash('sha256').update(await renderW2Pdf(w2)).digest('hex');
    const b = createHash('sha256').update(await renderW2Pdf(w2)).digest('hex');
    expect(a).toBe(b);
  });

  it('prints a 4-up sheet of B, C, 2, 2 with the notice', async () => {
    const simple = { ...w2, boxes: { ...w2.boxes, box12: [{ code: 'D' as const, amount: 1900 }], box14Other: [], localLines: [] } };
    const text = pdfText(await renderW2Pdf4Up(simple));
    expect(has(text, "Copy B, To Be Filed With Employee's FEDERAL Tax Return.")).toBe(true);
    expect(has(text, "Copy C, For EMPLOYEE'S RECORDS")).toBe(true);
    expect(has(text, 'Notice to Employee')).toBe(true);
  });
});

describe('Form W-2c', () => {
  it('lists exactly what changed, with the previous and correct amounts', async () => {
    const corrected = { ...w2.boxes, box1Wages: 49210.55, box12: [...(w2.boxes.box12 ?? []), { code: 'C' as const, amount: 120 }] };
    const text = pdfText(
      await renderW2cPdf({
        taxYear: 2026,
        employer: w2.employer,
        employee: w2.employee,
        controlNumber: 'A1B2C3D4',
        amounts: { previous: w2.boxes, corrected },
        correctionReason: 'A December bonus was left off.',
        meta: { formId: 'c0ffee12', originalFormId: 'f00c9c41', generatedAt: '2027-02-10T12:00:00Z' },
      }),
    );
    expect(has(text, 'Corrected Wage and Tax Statement')).toBe(true);
    expect(has(text, 'A December bonus was left off.')).toBe(true);
    expect(has(text, '48,210.55')).toBe(true);
    expect(has(text, '49,210.55')).toBe(true);
    expect(has(text, 'Taxable cost of group-term life insurance over $50,000')).toBe(true);
    expect(has(text, 'Previously reported')).toBe(true);
    expect(has(text, 'Correct information')).toBe(true);
  });
});

describe('Form 1099-NEC for the recipient', () => {
  it('carries the recipient legend and truncates the recipient TIN', async () => {
    const text = pdfText(
      await renderForm1099NecPdf({
        taxYear: 2026,
        payer: { ein: '123456789', name: 'Coastal Resort Holdings LLC', addressLine1: '100 Gulf Blvd', addressLine2: null, city: 'Panama City Beach', state: 'FL', zip: '32413' },
        recipient: { tin: '123-45-6789', name: 'Rosa Vega', addressLine1: '9 Ocean Ave', addressLine2: null, city: 'Destin', state: 'FL', zip: '32541' },
        accountNumber: 'C-0042',
        boxes: { box1NonemployeeCompensation: 18450, box2DirectSales: false, box4FitWithheld: 0, stateLines: [], sourceItemCount: 3 },
        meta: { formId: 'abcd1234', generatedAt: '2027-01-25T12:00:00Z' },
      }),
    );
    expect(has(text, 'Copy B—For Recipient.')).toBe(true);
    expect(has(text, 'This is important tax information and is being furnished to the IRS.')).toBe(true);
    expect(has(text, 'Nonemployee Compensation')).toBe(true);
    expect(has(text, 'XXX-XX-6789')).toBe(true);
    expect(text).not.toContain('123-45-6789');
    expect(has(text, '18,450.00')).toBe(true);
  });
});

describe('employer documents', () => {
  it('a remittance advice totals its orders and names each case', async () => {
    const text = pdfText(
      await renderRemittanceAdvicePdf({
        companyName: 'Coastal Resort Holdings LLC',
        ein: '123456789',
        payeeName: 'Florida State Disbursement Unit',
        payeeAddress: 'PO Box 8500',
        period: { start: '2026-09-26', end: '2026-10-09' },
        status: 'PENDING',
        reference: 'REM-1042',
        lines: [
          { employeeName: 'Ana López', caseNumber: 'CS777', kind: 'CHILD_SUPPORT', amount: 150 },
          { employeeName: 'Tomas Ortiz', caseNumber: 'CS778', kind: 'CHILD_SUPPORT', amount: 34.62 },
        ],
        generatedAt: '2026-10-16T12:00:00Z',
      }),
    );
    expect(has(text, 'CS777')).toBe(true);
    expect(has(text, 'Total remitted')).toBe(true);
    expect(has(text, '$184.62')).toBe(true);
  });

  it('a tax-form summary repairs em dashes lost upstream', async () => {
    const { pdf } = await renderTaxFormSummaryPdf({ title: 'Form 941 � Q4 2026', employer: { name: 'Coastal', ein: '123456789' }, status: 'DRAFT', generatedAt: '2027-01-20T12:00:00Z', lines: [{ label: 'Line 2 � Wages', value: '$1.00' }] });
    const text = pdfText(pdf);
    expect(has(text, 'Form 941 — Q4 2026')).toBe(true);
    expect(text).not.toContain('�');
  });
});
