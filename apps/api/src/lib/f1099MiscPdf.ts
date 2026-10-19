// Form 1099-MISC, Miscellaneous Information, for the recipient (IRS Pub 1179
// substitute recipient statement). Copy B (the default) is the recipient's
// whole statement: a short cover, Copy B and Copy 2 in black ink, and the
// instructions for the recipient. Any other copy renders on its own.

import { createHash } from 'node:crypto';
import type { Form1099MiscBoxes, Form1099MiscStateLine } from './f1099MiscAggregator.js';
import { F1099_COMMON_INSTRUCTIONS, render1099Statement } from './taxFormKit.js';

export type F1099MiscCopyVariant = 'A' | '1' | 'B' | '2' | 'C';

export interface Form1099MiscPdfData {
  taxYear: number;
  copyVariant?: F1099MiscCopyVariant;
  payer: {
    ein: string;
    name: string;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
    phone?: string | null;
  };
  recipient: {
    tin: string;
    name: string;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
  };
  accountNumber: string;
  boxes: Form1099MiscBoxes;
  meta: {
    formId: string;
    generatedAt: string;
  };
}

export async function renderForm1099MiscPdf(data: Form1099MiscPdfData): Promise<Buffer> {
  const b = data.boxes;
  return render1099Statement({
    copy: data.copyVariant ?? 'B',
    meta: data.meta,
    spec: {
      formNumber: '1099-MISC',
      title: 'Miscellaneous Information',
      omb: 'OMB No. 1545-0115',
      taxYear: data.taxYear,
      payer: data.payer,
      recipient: data.recipient,
      accountNumber: data.accountNumber,
      boxes: [
        { label: '1  Rents', value: b.box1Rents },
        { label: '2  Royalties', value: b.box2Royalties },
        { label: '3  Other income', value: b.box3OtherIncome },
        { label: '4  Federal income tax withheld', value: b.box4FitWithheld },
        { label: '5  Fishing boat proceeds', value: b.box5FishingBoatProceeds },
        { label: '6  Medical and health care payments', value: b.box6MedicalHealthcarePayments },
        { label: '7  Payer made direct sales totaling $5,000 or more of consumer products to recipient for resale', value: !!b.box7DirectSales },
        { label: '8  Substitute payments in lieu of dividends or interest', value: b.box8SubstitutePayments },
        { label: '9  Crop insurance proceeds', value: b.box9CropInsuranceProceeds },
        { label: '10  Gross proceeds paid to an attorney', value: b.box10GrossProceedsAttorney },
        { label: '11  Fish purchased for resale', value: b.box11FishForResale },
        { label: '12  Section 409A deferrals', value: b.box12Section409ADeferrals },
        { label: '13  Excess golden parachute payments', value: b.box13ExcessGoldenParachute },
        { label: '14  Nonqualified deferred compensation', value: b.box14NonqualifiedDeferred },
      ],
      stateBoxes: { tax: '15  State tax withheld', id: "16  State/Payer's state no.", income: '17  State income' },
      stateRows: b.stateLines.map((l: Form1099MiscStateLine) => ({ tax: l.stateTaxWithheld, state: l.state, income: l.stateIncome })),
    },
    summary: [
      { label: 'Rents (box 1)', amount: b.box1Rents },
      { label: 'Other income (box 3)', amount: b.box3OtherIncome },
      { label: 'Federal tax withheld (box 4)', amount: b.box4FitWithheld },
    ],
    instructions: [
      ...F1099_COMMON_INSTRUCTIONS.slice(0, 2),
      { title: 'Box 1', body: 'Report rents from real estate on Schedule E (Form 1040). However, report rents on Schedule C (Form 1040) if you provided significant services to the tenant, sold real estate as a business, or rented personal property as a business.' },
      { title: 'Box 2', body: 'Report royalties from oil, gas, or mineral properties; copyrights; and patents on Schedule E (Form 1040). However, report payments for a working interest as explained in the Schedule E (Form 1040) instructions.' },
      { title: 'Box 3', body: 'Generally, report this amount on the "Other income" line of Schedule 1 (Form 1040) and identify the payment. The amount shown may be payments received as the beneficiary of a deceased employee, prizes, awards, taxable damages, Indian gaming profits, or other taxable income.' },
      { title: 'Box 4', body: 'Shows backup withholding or withholding on Indian gaming profits. Generally, a payer must backup withhold if you did not furnish your TIN. See Form W-9 and Pub. 505 for more information. Report this amount on your income tax return as tax withheld.' },
      { title: 'Boxes 5–14', body: 'See the Instructions for Recipient of Form 1099-MISC at www.irs.gov/Form1099MISC for each box that shows an amount on your form.' },
      { title: 'Boxes 15–17', body: 'Show state income tax withheld, the payer\'s state number, and the income subject to that state.' },
      ...F1099_COMMON_INSTRUCTIONS.slice(2),
    ],
  });
}

export function hashForm1099MiscPdf(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}
