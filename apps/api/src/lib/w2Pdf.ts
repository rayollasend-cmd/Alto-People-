// Gap 1 â€” Form W-2 plain-paper renderer.
//
// One layout, five copy variants (A/B/C/D/2) â€” the only material
// difference between the recipient copies is the header label per IRS
// Pub 1141 Â§4.05. Copy A is the SSA submission copy; Copy B is the
// employee's federal-return attachment; Copy C is the employee's
// personal record; Copy 2 is the employee's state/local-return
// attachment; Copy D is the employer's record.
//
// Practical reality: most employers (this product included) submit
// Copy A *electronically* via EFW2 â€” paper Copy A on red drop-out
// ink with prior IRS approval is rare. We still render a Copy A
// variant so a finance reviewer can compare the form's shape, and so
// the 4-up multi-copy layout below has all the labels it needs.
//
// Output is intentionally austere; Rippling/Gusto's plain-paper W-2
// looks essentially identical. Substitute-form approval (Pub 1141) is
// a separate process â€” this renderer is a starting point that finance
// can review before we commit to either pursuing approval or shipping
// pre-printed forms.

import PDFDocument from 'pdfkit';
import { createHash } from 'node:crypto';
import type { W2Boxes, W2StateLine } from './w2Aggregator.js';

/**
 * Which copy of the W-2 to render. Header label and footer disclaimer
 * change per IRS Pub 1141; everything else is identical.
 */
export type W2CopyVariant = 'A' | 'B' | 'C' | 'D' | '2';

const COPY_LABEL: Record<W2CopyVariant, string> = {
  A: 'Copy Aâ€”For Social Security Administration. Send this entire page with Form W-3 to the SSA; photocopies are not acceptable.',
  B: "Copy Bâ€”To Be Filed With Employee's FEDERAL Tax Return.",
  C: "Copy Câ€”For EMPLOYEE'S RECORDS (See Notice to Employee on the back of Copy B.)",
  D: 'Copy Dâ€”For Employer.',
  '2': "Copy 2â€”To Be Filed With Employee's State, City, or Local Income Tax Return.",
};

export interface W2PdfData {
  taxYear: number;
  /**
   * Which copy to render. Defaults to Copy B (employee files with their
   * federal return) â€” the most-requested copy. The 4-up layout below
   * passes B/C/2/2 explicitly.
   */
  copyVariant?: W2CopyVariant;
  /** Employer block (Box b/c). */
  employer: {
    /** EIN formatted "XX-XXXXXXX" (Box b). */
    ein: string;
    /** Legal name on the IRS record (Box c, line 1). */
    name: string;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
  };
  /** Employee block (Box a/e/f). */
  employee: {
    /** Full SSN, formatted "XXX-XX-XXXX" (Box a). */
    ssn: string;
    firstName: string;
    lastName: string;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
  };
  /** Per-employee control number (Box d). */
  controlNumber: string;
  /** Box totals from w2Aggregator. */
  boxes: W2Boxes;
  /** Stamped on the bottom-right for audit; doesn't affect IRS validity. */
  meta: {
    formId: string;
    generatedAt: string;
  };
}

export async function renderW2Pdf(data: W2PdfData): Promise<Buffer> {
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

/**
 * 4-up multi-copy paper layout â€” packs Copy B (federal), Copy C
 * (employee record), and two Copy 2's (state/local) onto one Letter-
 * size sheet. This is the standard payroll-house format that's
 * pre-perforated by 1099/W-2 paper vendors so the employee can tear
 * off each copy.
 *
 * Page divides into four 4Ã—5.5" quadrants (top-left, top-right,
 * bottom-left, bottom-right) with a shared header strip across the
 * top and a thin tear/cut line down the middle and across the
 * horizontal seam. Each quadrant uses PDFKit's `save/translate/scale`
 * to reuse the single-copy layout at half scale â€” no duplicated
 * draw code.
 */
export async function renderW2Pdf4Up(data: W2PdfData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
    // Deterministic bytes: pdfkit stamps CreationDate=now by default, so
    // every re-render hashed differently and the pdfHash immutability
    // check warned on EVERY re-download — permanent log noise. Pin the
    // date to the form's own timestamp (meta.generatedAt = TaxForm
    // createdAt), making identical inputs produce identical bytes.
      size: 'LETTER',
      margin: 0,
      info: { CreationDate: new Date(data.meta.generatedAt) },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Letter @ 72dpi = 612 Ã— 792. Each quadrant is 306 Ã— 396.
    const W = 612;
    const H = 792;
    const halfW = W / 2;
    const halfH = H / 2;

    // Tear/cut guides â€” single-pixel hairlines at the seams.
    doc
      .strokeColor('#999')
      .lineWidth(0.3)
      .moveTo(halfW, 0).lineTo(halfW, H).stroke()
      .moveTo(0, halfH).lineTo(W, halfH).stroke();

    // The four quadrants â€” Copy B (federal) / C (employee record)
    // top, two Copy 2's (state) bottom. This matches every paper
    // vendor's preprinted W-2 stock I've checked.
    const quadrants: Array<{ x: number; y: number; copy: W2CopyVariant }> = [
      { x: 0,     y: 0,     copy: 'B' },
      { x: halfW, y: 0,     copy: 'C' },
      { x: 0,     y: halfH, copy: '2' },
      { x: halfW, y: halfH, copy: '2' },
    ];

    for (const q of quadrants) {
      doc.save();
      // The single-copy renderer assumes a full 612Ã—792 canvas; squeeze
      // it into the quadrant by translating to the quadrant's origin
      // and scaling by 0.5.
      doc.translate(q.x, q.y).scale(0.5);
      drawHeader(doc, { ...data, copyVariant: q.copy });
      drawIdBlock(doc, data);
      drawWageBoxes(doc, data.boxes);
      drawStateLines(doc, data.boxes.stateLines);
      drawFooter(doc, { ...data, copyVariant: q.copy });
      doc.restore();
    }

    doc.end();
  });
}

export function hashW2Pdf(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

// ---- Layout helpers ------------------------------------------------------

function drawHeader(doc: PDFKit.PDFDocument, data: W2PdfData): void {
  const variant = data.copyVariant ?? 'B';
  // Title strip
  doc
    .font('Helvetica-Bold')
    .fontSize(14)
    .text(`Form W-2  Wage and Tax Statement  ${data.taxYear}`, 36, 36, {
      width: 540,
      align: 'left',
    });
  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor('#444')
    .text(COPY_LABEL[variant], 36, 54, { width: 540 });
  doc.fillColor('#000');
  // Department footer line at top â€” IRS substitute forms typically carry
  // this so a recipient can verify the form's source.
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

function drawIdBlock(doc: PDFKit.PDFDocument, data: W2PdfData): void {
  // Top three boxes: a (SSN), b (EIN), c (Employer)
  // Layout splits the top 110px vertically into:
  //   row 1 (90-130): a (left half) | b (right half)
  //   row 2 (130-190): c (full width)
  cell(doc, 36, 90, 270, 40, 'a  Employee\'s social security number', data.employee.ssn);
  cell(doc, 306, 90, 270, 40, 'b  Employer identification number (EIN)', data.employer.ein);

  cell(
    doc,
    36,
    130,
    540,
    60,
    'c  Employer\'s name, address, and ZIP code',
    [
      data.employer.name,
      data.employer.addressLine1,
      data.employer.addressLine2,
      [data.employer.city, data.employer.state, data.employer.zip]
        .filter(Boolean)
        .join(', '),
    ]
      .filter((s) => s && s.length > 0)
      .join('\n'),
  );

  // d Control number â€” single full-width row
  cell(doc, 36, 190, 540, 28, 'd  Control number', data.controlNumber);

  // e Employee name + f Address â€” stacked rows
  cell(
    doc,
    36,
    218,
    540,
    32,
    'e  Employee\'s first name and initial    Last name',
    `${data.employee.firstName} ${data.employee.lastName}`,
  );
  cell(
    doc,
    36,
    250,
    540,
    44,
    'f  Employee\'s address and ZIP code',
    [
      data.employee.addressLine1,
      data.employee.addressLine2,
      [data.employee.city, data.employee.state, data.employee.zip]
        .filter(Boolean)
        .join(', '),
    ]
      .filter((s) => s && s.length > 0)
      .join('\n'),
  );
}

function drawWageBoxes(doc: PDFKit.PDFDocument, boxes: W2Boxes): void {
  // Six boxes (1-6) in two columns of three rows. Right column carries
  // the matching tax-withheld figure. Standard IRS Form W-2 layout.
  const top = 300;
  const rowH = 32;
  const left = 36;
  const mid = 306;
  const w = 270;

  cell(doc, left, top + 0 * rowH, w, rowH, '1  Wages, tips, other compensation', usd(boxes.box1Wages));
  cell(doc, mid,  top + 0 * rowH, w, rowH, '2  Federal income tax withheld',     usd(boxes.box2FitWithheld));
  cell(doc, left, top + 1 * rowH, w, rowH, '3  Social security wages',           usd(boxes.box3SsWages));
  cell(doc, mid,  top + 1 * rowH, w, rowH, '4  Social security tax withheld',    usd(boxes.box4SsTax));
  cell(doc, left, top + 2 * rowH, w, rowH, '5  Medicare wages and tips',         usd(boxes.box5MedicareWages));
  cell(doc, mid,  top + 2 * rowH, w, rowH, '6  Medicare tax withheld',           usd(boxes.box6MedicareTax));

  // Box 7 (SS tips), 8 (allocated tips), 9 (verification code), 10
  // (dependent care), 11 (nonqualified plans), 12a-d (codes), 13
  // (checkboxes), 14 (other) â€” these are all out of scope for Phase 1-3.
  // Render empty placeholders so a finance reviewer can see the form's
  // shape and we don't surprise them when the additional boxes land.
  const skipTop = top + 3 * rowH + 8;
  cell(doc, left, skipTop, w, rowH, '7  Social security tips', '');
  cell(doc, mid,  skipTop, w, rowH, '8  Allocated tips', '');
  cell(doc, left, skipTop + rowH, w, rowH, '10  Dependent care benefits', '');
  cell(doc, mid,  skipTop + rowH, w, rowH, '11  Nonqualified plans', '');
  cell(doc, left, skipTop + 2 * rowH, w, rowH, '12a  See instructions for box 12', '');
  cell(doc, mid,  skipTop + 2 * rowH, w, rowH, '14  Other', '');
}

function drawStateLines(doc: PDFKit.PDFDocument, lines: W2StateLine[]): void {
  // Box 15-17 â€” one row per state. Single-state is the common case;
  // multi-state employees get one row each (up to 2 fit cleanly here).
  const top = 510;
  const rowH = 28;

  // Header strip
  doc
    .font('Helvetica-Bold')
    .fontSize(7)
    .text('15  State', 40, top - 12, { width: 60 })
    .text('Employer\'s state ID', 96, top - 12, { width: 100 })
    .text('16  State wages, tips, etc.', 230, top - 12, { width: 130 })
    .text('17  State income tax', 380, top - 12, { width: 130 });
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
      .text(line.state, 44, y + 8, { width: 50 })
      .text('â€”', 100, y + 8, { width: 100 })
      .text(usd(line.stateWages), 230, y + 8, { width: 130 })
      .text(usd(line.stateIncomeTax), 380, y + 8, { width: 130 });
    y += rowH;
  }
}

function drawFooter(doc: PDFKit.PDFDocument, data: W2PdfData): void {
  const variant = data.copyVariant ?? 'B';
  doc
    .font('Helvetica')
    .fontSize(7)
    .fillColor('#666')
    .text(
      `Form W-2 (${data.taxYear})  Â·  Copy ${variant}  Â·  ID ${data.meta.formId.slice(0, 8)}  Â·  ` +
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
  // No leading $; W-2 boxes are unitless and the IRS form text already
  // says wages/tax so the dollar sign would be redundant.
  return n.toFixed(2);
}
