// Gap 11 â€” Form 1099-NEC plain-paper renderer.
//
// One layout, four copy variants per IRS Pub 1141 Â§4.05:
//
//   Copy A â€” For Internal Revenue Service Center (red drop-out ink in
//            production; we render plain-paper for AccuWage / IRS FIRE
//            review and let e-file via Pub 1220 carry the actual filing)
//   Copy 1 â€” For State Tax Department
//   Copy B â€” For Recipient (the contractor's copy)
//   Copy 2 â€” To be filed with recipient's state income tax return
//   Copy C â€” For Payer's records
//
// Box layout follows the official 2024 form:
//   Box 1  Nonemployee compensation
//   Box 2  Payer made direct sales totaling $5,000+ (checkbox)
//   Box 3  (reserved â€” blank)
//   Box 4  Federal income tax withheld (backup withholding)
//   Box 5  State tax withheld
//   Box 6  State / Payer's state no.
//   Box 7  State income
//
// Same austere plain-paper aesthetic as w2Pdf â€” cell()/usd() helpers
// are local copies so 1099-NEC and W-2 renderers can evolve
// independently. Substitute-form approval (Pub 1141) is a separate
// process; this is a starting point for finance to review.

import PDFDocument from 'pdfkit';
import { createHash } from 'node:crypto';
import type { Form1099NecBoxes, Form1099StateLine } from './f1099NecAggregator.js';

export type F1099CopyVariant = 'A' | '1' | 'B' | '2' | 'C';

const COPY_LABEL: Record<F1099CopyVariant, string> = {
  A: 'Copy Aâ€”For Internal Revenue Service Center. Send this entire page with Form 1096 to the IRS; photocopies are not acceptable.',
  '1': 'Copy 1â€”For State Tax Department.',
  B: 'Copy Bâ€”For Recipient.',
  '2': "Copy 2â€”To be filed with recipient's state income tax return, when required.",
  C: "Copy Câ€”For Payer's records.",
};

export interface Form1099NecPdfData {
  taxYear: number;
  /**
   * Which copy to render. Defaults to Copy B (the recipient copy) â€” the
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
    /** Optional callback phone â€” IRS allows but doesn't require. */
    phone?: string | null;
  };
  /** Recipient block (top-right + name/address rows). */
  recipient: {
    /**
     * Recipient TIN â€” SSN for individuals (XXX-XX-XXXX), EIN for
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
  /** Per-recipient account number â€” IRS field, can be blank. */
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
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
    // Deterministic bytes: pdfkit stamps CreationDate=now by default, so
    // every re-render hashed differently and the pdfHash immutability
    // check warned on EVERY re-download — permanent log noise. Pin the
    // date to the form's own timestamp (meta.generatedAt = TaxForm
    // createdAt), making identical inputs produce identical bytes.
      size: 'LETTER',
      margin: 36,
      info: { CreationDate: new Date(data.meta.generatedAt) },
    });
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

export function hashForm1099NecPdf(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

// ---- Layout helpers ------------------------------------------------------

function drawHeader(doc: PDFKit.PDFDocument, data: Form1099NecPdfData): void {
  const variant = data.copyVariant ?? 'B';
  doc
    .font('Helvetica-Bold')
    .fontSize(14)
    .text(`Form 1099-NEC  Nonemployee Compensation  ${data.taxYear}`, 36, 36, {
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
    .text('Department of the Treasury â€” Internal Revenue Service', 36, 66, {
      width: 540,
    });
  doc.fillColor('#000');

  // Border around the whole form
  doc.rect(36, 84, 540, 600).strokeColor('#000').lineWidth(0.6).stroke();
}

function drawIdBlock(doc: PDFKit.PDFDocument, data: Form1099NecPdfData): void {
  // Header tile â€” payer (left, taller) | TIN row (right) | recipient block.
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
  // Right column: TIN pair, then recipient TIN, then account number.
  cell(doc, 306, 90, 270, 32, "PAYER'S TIN", data.payer.ein);
  cell(doc, 306, 122, 270, 32, "RECIPIENT'S TIN", data.recipient.tin);
  cell(doc, 306, 154, 270, 36, 'Account number (see instructions)', data.accountNumber);

  // Recipient name + address rows below.
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

function drawWageBoxes(doc: PDFKit.PDFDocument, boxes: Form1099NecBoxes): void {
  // Box 1 (Nonemployee compensation) is the main money field; Box 2 is a
  // checkbox; Box 3 is reserved/blank; Box 4 is backup withholding.
  // Layout: two-row block under the recipient address.
  const top = 280;
  const rowH = 40;
  const left = 36;
  const mid = 306;
  const w = 270;

  cell(
    doc,
    left,
    top,
    w,
    rowH,
    '1  Nonemployee compensation',
    usd(boxes.box1NonemployeeCompensation),
  );
  // Box 2 is a checkbox â€” render literal "[ X ]" or "[   ]" inside.
  cell(
    doc,
    mid,
    top,
    w,
    rowH,
    "2  Payer made direct sales totaling $5,000 or more of consumer products to recipient for resale",
    boxes.box2DirectSales ? '[ X ]' : '[   ]',
  );
  cell(doc, left, top + rowH, w, rowH, '3  (reserved)', '');
  cell(
    doc,
    mid,
    top + rowH,
    w,
    rowH,
    '4  Federal income tax withheld',
    usd(boxes.box4FitWithheld),
  );
}

function drawStateLines(doc: PDFKit.PDFDocument, lines: Form1099StateLine[]): void {
  // Boxes 5/6/7 â€” one row per state (up to 2 fit cleanly on the form).
  const top = 410;
  const rowH = 32;

  doc
    .font('Helvetica-Bold')
    .fontSize(7)
    .text('5  State tax withheld', 40, top - 12, { width: 130 })
    .text("6  State / Payer's state no.", 200, top - 12, { width: 160 })
    .text('7  State income', 380, top - 12, { width: 130 });
  doc.font('Helvetica');

  if (lines.length === 0) {
    cell(doc, 36, top, 540, rowH, '', 'â€” No state withholding â€”');
    return;
  }

  let y = top;
  for (const line of lines.slice(0, 2)) {
    doc
      .rect(36, y, 540, rowH)
      .strokeColor('#000')
      .lineWidth(0.4)
      .stroke();
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

function drawFooter(doc: PDFKit.PDFDocument, data: Form1099NecPdfData): void {
  const variant = data.copyVariant ?? 'B';
  doc
    .font('Helvetica')
    .fontSize(7)
    .fillColor('#666')
    .text(
      `Form 1099-NEC (${data.taxYear})  Â·  Copy ${variant}  Â·  ID ${data.meta.formId.slice(0, 8)}  Â·  ` +
        `Generated by Alto People at ${data.meta.generatedAt}`,
      36,
      702,
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
