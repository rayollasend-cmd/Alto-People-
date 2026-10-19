// Form 1099-NEC, Nonemployee Compensation, for the recipient (IRS Pub 1179
// substitute recipient statement). Copy B (the default) is the recipient's
// whole statement: a short cover, Copy B and Copy 2 in black ink, and the
// instructions for the recipient. Any other copy renders on its own.

import { createHash } from 'node:crypto';
import type { Form1099NecBoxes, Form1099StateLine } from './f1099NecAggregator.js';
import { F1099_COMMON_INSTRUCTIONS, render1099Statement } from './taxFormKit.js';

export type F1099CopyVariant = 'A' | '1' | 'B' | '2' | 'C';

export interface Form1099NecPdfData {
  taxYear: number;
  /**
   * Which copy to render. Defaults to Copy B (the recipient copy) — the
   * common case for contractor-facing download.
   */
  copyVariant?: F1099CopyVariant;
  /** Payer block (top-left). */
  payer: {
    /** EIN formatted "XX-XXXXXXX". */
    ein: string;
    name: string;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
    /** Optional callback phone — IRS allows but doesn't require. */
    phone?: string | null;
  };
  /** Recipient block (top-right + name/address rows). */
  recipient: {
    /**
     * Recipient TIN — SSN for individuals (XXX-XX-XXXX), EIN for
     * businesses (XX-XXXXXXX). Caller passes pre-formatted.
     */
    tin: string;
    /** Full legal name (individual) or business name. */
    name: string;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
  };
  /** Per-recipient account number — IRS field, can be blank. */
  accountNumber: string;
  /** Box totals from f1099NecAggregator. */
  boxes: Form1099NecBoxes;
  /** Stamped on the bottom-right for audit; doesn't affect IRS validity. */
  meta: {
    formId: string;
    generatedAt: string;
  };
}

export async function renderForm1099NecPdf(data: Form1099NecPdfData): Promise<Buffer> {
  const b = data.boxes;
  const golden = (b as unknown as { box3ExcessGoldenParachute?: number }).box3ExcessGoldenParachute ?? null;
  return render1099Statement({
    copy: data.copyVariant ?? 'B',
    meta: data.meta,
    spec: {
      formNumber: '1099-NEC',
      title: 'Nonemployee Compensation',
      omb: 'OMB No. 1545-0116',
      taxYear: data.taxYear,
      payer: data.payer,
      recipient: data.recipient,
      accountNumber: data.accountNumber,
      boxes: [
        { label: '1  Nonemployee compensation', value: b.box1NonemployeeCompensation },
        { label: '2  Payer made direct sales totaling $5,000 or more of consumer products to recipient for resale', value: !!b.box2DirectSales },
        { label: '3  Excess golden parachute payments', value: golden },
        { label: '4  Federal income tax withheld', value: b.box4FitWithheld },
      ],
      stateBoxes: { tax: '5  State tax withheld', id: "6  State/Payer's state no.", income: '7  State income' },
      stateRows: b.stateLines.map((l) => ({ tax: l.stateTaxWithheld, state: l.state, income: l.stateIncome })),
    },
    summary: [
      { label: 'Nonemployee pay (box 1)', amount: b.box1NonemployeeCompensation },
      { label: 'Federal tax withheld (box 4)', amount: b.box4FitWithheld },
      { label: 'State tax withheld (box 5)', amount: b.stateLines.reduce((s, l) => s + l.stateTaxWithheld, 0) },
    ],
    instructions: [
      ...F1099_COMMON_INSTRUCTIONS.slice(0, 2),
      { title: 'Box 1', body: 'Shows nonemployee compensation. If the amount in this box is self-employment (SE) income, report it on Schedule C or F (Form 1040) if a sole proprietor, or on Form 1065 and Schedule K-1 (Form 1065) if a partnership, and the recipient/partner completes Schedule SE (Form 1040). If you are not an employee of the payer and the amount is not SE income (for example, from a hobby or an activity not engaged in for profit), report it on the "Other income" line of Schedule 1 (Form 1040). If you believe you are an employee and cannot get the payer to correct this form, report the amount on the line for "Wages, salaries, tips, etc." of Form 1040, 1040-SR, or 1040-NR, and complete Form 8919 and attach it to your return.' },
      { title: 'Box 2', body: 'If checked, consumer products totaling $5,000 or more were sold to you for resale, on a buy-sell, a deposit-commission, or other basis. Generally, report any income from your sale of these products on Schedule C (Form 1040).' },
      { title: 'Box 3', body: 'Shows your total compensation of excess golden parachute payments subject to a 20% excise tax. See your tax return instructions for where to report.' },
      { title: 'Box 4', body: 'Shows backup withholding. A payer must backup withhold on certain payments if you did not give your TIN to the payer. See Form W-9 for information on backup withholding. Include this amount on your income tax return as tax withheld.' },
      { title: 'Boxes 5–7', body: 'State income tax withheld reporting boxes.' },
      ...F1099_COMMON_INSTRUCTIONS.slice(2),
    ],
  });
}

export function hashForm1099NecPdf(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

export type { Form1099NecBoxes, Form1099StateLine };
