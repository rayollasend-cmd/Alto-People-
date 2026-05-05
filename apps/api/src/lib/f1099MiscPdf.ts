// Gap 11 — Phase 8: Form 1099-MISC plain-paper renderer.
//
// Mirrors f1099NecPdf's layout/conventions but lays out 1099-MISC's
// 14 numbered boxes + Box 7 checkbox + Boxes 15-17 state block.
//
//   Copy A — For Internal Revenue Service Center
//   Copy 1 — For State Tax Department
//   Copy B — For Recipient
//   Copy 2 — To be filed with recipient's state income tax return
//   Copy C — For Payer's records
//
// Box layout follows 2024 form:
//   1   Rents
//   2   Royalties
//   3   Other income
//   4   Federal income tax withheld
//   5   Fishing boat proceeds
//   6   Medical and health care payments
//   7   Direct sales of $5,000+ (checkbox)
//   8   Substitute payments in lieu of dividends or interest
//   9   Crop insurance proceeds
//   10  Gross proceeds paid to an attorney
//   11  Fish purchased for resale
//   12  Section 409A deferrals
//   13  Excess golden parachute payments
//   14  Nonqualified deferred compensation
//   15  State tax withheld
//   16  State / Payer's state no.
//   17  State income
//
// Substitute-form approval (Pub 1141) is a separate process; this is a
// starting point for finance to review.

import PDFDocument from 'pdfkit';
import { createHash } from 'node:crypto';
import type { Form1099MiscBoxes, Form1099MiscStateLine } from './f1099MiscAggregator.js';

export type F1099MiscCopyVariant = 'A' | '1' | 'B' | '2' | 'C';

const COPY_LABEL: Record<F1099MiscCopyVariant, string> = {
  A: 'Copy A—For Internal Revenue Service Center. Send this entire page with Form 1096 to the IRS; photocopies are not acceptable.',
  '1': 'Copy 1—For State Tax Department.',
  B: 'Copy B—For Recipient.',
  '2': "Copy 2—To be filed with recipient's state income tax return, when required.",
  C: "Copy C—For Payer's records.",
};

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
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 36 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    drawHeader(doc, data);
    drawIdBlock(doc, data);
    drawWageBoxes(doc, data.boxes);
    drawStateLines(doc, data.boxes.stateLines);
    drawFooter(doc, data);

    doc.end();
  });
}

export function hashForm1099MiscPdf(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function drawHeader(doc: PDFKit.PDFDocument, data: Form1099MiscPdfData): void {
  const variant = data.copyVariant ?? 'B';
  doc
    .font('Helvetica-Bold')
    .fontSize(14)
    .text(`Form 1099-MISC  Miscellaneous Information  ${data.taxYear}`, 36, 36, {
      width: 540,
      align: 'left',
    });
  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor('#444')
    .text(COPY_LABEL[variant], 36, 54, { width: 540 });
  doc.fillColor('#000');
  doc
    .fontSize(7)
    .fillColor('#666')
    .text('Department of the Treasury — Internal Revenue Service', 36, 66, {
      width: 540,
    });
  doc.fillColor('#000');

  doc.rect(36, 84, 540, 660).strokeColor('#000').lineWidth(0.6).stroke();
}

function drawIdBlock(doc: PDFKit.PDFDocument, data: Form1099MiscPdfData): void {
  const payerLines = [
    data.payer.name,
    data.payer.addressLine1,
    data.payer.addressLine2,
    [data.payer.city, data.payer.state, data.payer.zip].filter(Boolean).join(', '),
    data.payer.phone ? `Phone: ${data.payer.phone}` : null,
  ]
    .filter((s) => s && s.length > 0)
    .join('\n');
  cell(
    doc,
    36,
    90,
    270,
    100,
    "PAYER'S name, street address, city, state, ZIP code, and telephone no.",
    payerLines,
  );
  cell(doc, 306, 90, 270, 32, "PAYER'S TIN", data.payer.ein);
  cell(doc, 306, 122, 270, 32, "RECIPIENT'S TIN", data.recipient.tin);
  cell(doc, 306, 154, 270, 36, 'Account number (see instructions)', data.accountNumber);

  cell(doc, 36, 190, 540, 28, "RECIPIENT'S name", data.recipient.name);
  cell(
    doc,
    36,
    218,
    540,
    44,
    'Street address (including apt. no.) / City, state, ZIP',
    [
      data.recipient.addressLine1,
      data.recipient.addressLine2,
      [data.recipient.city, data.recipient.state, data.recipient.zip]
        .filter(Boolean)
        .join(', '),
    ]
      .filter((s) => s && s.length > 0)
      .join('\n'),
  );
}

function drawWageBoxes(doc: PDFKit.PDFDocument, boxes: Form1099MiscBoxes): void {
  // Two-column grid, ~36 px row, fits all 14 boxes inside the 660 px
  // border area. Box 7 is a checkbox; the rest are dollar values.
  const top = 268;
  const rowH = 32;
  const left = 36;
  const mid = 306;
  const w = 270;

  // Row 1
  cell(doc, left, top + 0 * rowH, w, rowH, '1  Rents', usd(boxes.box1Rents));
  cell(doc, mid, top + 0 * rowH, w, rowH, '2  Royalties', usd(boxes.box2Royalties));
  // Row 2
  cell(doc, left, top + 1 * rowH, w, rowH, '3  Other income', usd(boxes.box3OtherIncome));
  cell(
    doc,
    mid,
    top + 1 * rowH,
    w,
    rowH,
    '4  Federal income tax withheld',
    usd(boxes.box4FitWithheld),
  );
  // Row 3
  cell(
    doc,
    left,
    top + 2 * rowH,
    w,
    rowH,
    '5  Fishing boat proceeds',
    usd(boxes.box5FishingBoatProceeds),
  );
  cell(
    doc,
    mid,
    top + 2 * rowH,
    w,
    rowH,
    '6  Medical and health care payments',
    usd(boxes.box6MedicalHealthcarePayments),
  );
  // Row 4
  cell(
    doc,
    left,
    top + 3 * rowH,
    w,
    rowH,
    '7  Payer made direct sales totaling $5,000+ (checkbox)',
    boxes.box7DirectSales ? '[ X ]' : '[   ]',
  );
  cell(
    doc,
    mid,
    top + 3 * rowH,
    w,
    rowH,
    '8  Substitute payments in lieu of dividends or interest',
    usd(boxes.box8SubstitutePayments),
  );
  // Row 5
  cell(
    doc,
    left,
    top + 4 * rowH,
    w,
    rowH,
    '9  Crop insurance proceeds',
    usd(boxes.box9CropInsuranceProceeds),
  );
  cell(
    doc,
    mid,
    top + 4 * rowH,
    w,
    rowH,
    '10  Gross proceeds paid to an attorney',
    usd(boxes.box10GrossProceedsAttorney),
  );
  // Row 6
  cell(
    doc,
    left,
    top + 5 * rowH,
    w,
    rowH,
    '11  Fish purchased for resale',
    usd(boxes.box11FishForResale),
  );
  cell(
    doc,
    mid,
    top + 5 * rowH,
    w,
    rowH,
    '12  Section 409A deferrals',
    usd(boxes.box12Section409ADeferrals),
  );
  // Row 7
  cell(
    doc,
    left,
    top + 6 * rowH,
    w,
    rowH,
    '13  Excess golden parachute payments',
    usd(boxes.box13ExcessGoldenParachute),
  );
  cell(
    doc,
    mid,
    top + 6 * rowH,
    w,
    rowH,
    '14  Nonqualified deferred compensation',
    usd(boxes.box14NonqualifiedDeferred),
  );
}

function drawStateLines(
  doc: PDFKit.PDFDocument,
  lines: Form1099MiscStateLine[],
): void {
  const top = 510;
  const rowH = 32;

  doc
    .font('Helvetica-Bold')
    .fontSize(7)
    .text('15  State tax withheld', 40, top - 12, { width: 130 })
    .text("16  State / Payer's state no.", 200, top - 12, { width: 160 })
    .text('17  State income', 380, top - 12, { width: 130 });
  doc.font('Helvetica');

  if (lines.length === 0) {
    cell(doc, 36, top, 540, rowH, '', '— No state withholding —');
    return;
  }

  let y = top;
  for (const line of lines.slice(0, 2)) {
    doc.rect(36, y, 540, rowH).strokeColor('#000').lineWidth(0.4).stroke();
    doc
      .font('Helvetica')
      .fontSize(11)
      .fillColor('#000')
      .text(usd(line.stateTaxWithheld), 44, y + 10, { width: 140 })
      .text(line.state, 200, y + 10, { width: 80 })
      .text(usd(line.stateIncome), 380, y + 10, { width: 130 });
    y += rowH;
  }
}

function drawFooter(doc: PDFKit.PDFDocument, data: Form1099MiscPdfData): void {
  const variant = data.copyVariant ?? 'B';
  doc
    .font('Helvetica')
    .fontSize(7)
    .fillColor('#666')
    .text(
      `Form 1099-MISC (${data.taxYear})  ·  Copy ${variant}  ·  ID ${data.meta.formId.slice(0, 8)}  ·  ` +
        `Generated by Alto People at ${data.meta.generatedAt}`,
      36,
      762,
      { width: 540, align: 'center' },
    );
  doc.fillColor('#000');
}

function cell(
  doc: PDFKit.PDFDocument,
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
  value: string,
): void {
  doc.rect(x, y, w, h).strokeColor('#000').lineWidth(0.4).stroke();
  if (label) {
    doc
      .font('Helvetica')
      .fontSize(6)
      .fillColor('#444')
      .text(label, x + 4, y + 3, { width: w - 8, lineBreak: false, ellipsis: true });
  }
  doc
    .font('Helvetica')
    .fontSize(11)
    .fillColor('#000')
    .text(value, x + 4, y + 13, { width: w - 8 });
}

function usd(n: number): string {
  if (n === 0) return '';
  return n.toFixed(2);
}
