// Gap 1 — Form W-2c (Corrected Wage and Tax Statement) renderer.
//
// Plain-paper layout in the same austere style as w2Pdf. The defining
// difference from a W-2 is that every dollar box is split into a
// "Previously reported" column and a "Correct information" column —
// the IRS and SSA reconcile against the previous values to identify
// what changed. We render those side by side per box so a recipient
// can verify the correction visually.
//
// Field positions follow the substitute-form rules from IRS Pub 1141
// to a best-effort match. Same disclaimer as w2Pdf: finance reviewer
// should compare against the SSA-approved fillable PDF before this is
// shipped to the IRS or to employees as their authoritative correction.

import PDFDocument from 'pdfkit';
import { createHash } from 'node:crypto';
import type { W2Boxes, W2StateLine } from './w2Aggregator.js';
import type { W2cAmounts } from './w2cAggregator.js';

export interface W2cPdfData {
  taxYear: number;
  /** Employer block (Box b/c). */
  employer: {
    ein: string;
    name: string;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
  };
  /** Employee block (Box a/i/h). */
  employee: {
    ssn: string;
    firstName: string;
    lastName: string;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
  };
  /** Per-employee control number, carried over from the original W-2. */
  controlNumber: string;
  /** Both old + new totals from w2cAggregator. */
  amounts: W2cAmounts;
  /** Free-text reason — appears on the form so the recipient knows why. */
  correctionReason: string | null;
  meta: {
    formId: string;
    /** ID of the original W-2 form being corrected (for audit). */
    originalFormId: string;
    generatedAt: string;
  };
}

export async function renderW2cPdf(data: W2cPdfData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 36 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    drawHeader(doc, data);
    drawIdBlock(doc, data);
    drawBoxesGrid(doc, data.amounts);
    drawStateLines(doc, data.amounts);
    drawCorrectionReason(doc, data.correctionReason);
    drawFooter(doc, data);

    doc.end();
  });
}

export function hashW2cPdf(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

// ---- Layout helpers ------------------------------------------------------

function drawHeader(doc: PDFKit.PDFDocument, data: W2cPdfData): void {
  doc
    .font('Helvetica-Bold')
    .fontSize(14)
    .text(
      `Form W-2c  Corrected Wage and Tax Statement  ${data.taxYear}`,
      36,
      36,
      { width: 540, align: 'left' },
    );
  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor('#444')
    .text(
      `Copy B—To Be Filed With Employee's FEDERAL Tax Return.`,
      36,
      54,
      { width: 540 },
    );
  doc.fillColor('#000');
  doc
    .fontSize(7)
    .fillColor('#666')
    .text('Department of the Treasury — Internal Revenue Service', 36, 66, {
      width: 540,
    });
  doc.fillColor('#000');

  // Border
  doc.rect(36, 84, 540, 600).strokeColor('#000').lineWidth(0.6).stroke();
}

function drawIdBlock(doc: PDFKit.PDFDocument, data: W2cPdfData): void {
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

  cell(doc, 36, 190, 540, 28, 'd  Employer\'s correction number', data.meta.formId.slice(0, 8).toUpperCase());

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

  // Original W-2 control number (Box d on the W-2c — different from Box d
  // on the W-2). Helps the IRS reconcile to the prior submission.
  cell(
    doc,
    36,
    294,
    540,
    22,
    'g  Original W-2 control number',
    data.controlNumber,
  );
}

function drawBoxesGrid(doc: PDFKit.PDFDocument, amounts: W2cAmounts): void {
  // The defining W-2c layout: each numbered box has two columns.
  //   Previously reported (left)  |  Correct information (right)
  // We render each box pair on one row, with the box label spanning
  // the full width and the two values stacked beneath. Six rows for
  // boxes 1-6.
  const top = 326;
  const rowH = 38;
  const labelH = 10;

  const left = 36;
  const colW = 270;
  const mid = left + colW;
  const valW = colW; // each value cell is half the row width? actually full per-half

  const rows: { num: number; label: string; prev: number; curr: number }[] = [
    { num: 1, label: 'Wages, tips, other compensation', prev: amounts.previous.box1Wages, curr: amounts.corrected.box1Wages },
    { num: 2, label: 'Federal income tax withheld', prev: amounts.previous.box2FitWithheld, curr: amounts.corrected.box2FitWithheld },
    { num: 3, label: 'Social security wages', prev: amounts.previous.box3SsWages, curr: amounts.corrected.box3SsWages },
    { num: 4, label: 'Social security tax withheld', prev: amounts.previous.box4SsTax, curr: amounts.corrected.box4SsTax },
    { num: 5, label: 'Medicare wages and tips', prev: amounts.previous.box5MedicareWages, curr: amounts.corrected.box5MedicareWages },
    { num: 6, label: 'Medicare tax withheld', prev: amounts.previous.box6MedicareTax, curr: amounts.corrected.box6MedicareTax },
  ];

  // Two-column-header strip
  doc
    .font('Helvetica-Bold')
    .fontSize(7)
    .fillColor('#000')
    .text('Previously reported', left + 4, top - labelH - 2, { width: colW - 8 })
    .text('Correct information', mid + 4, top - labelH - 2, { width: colW - 8 });

  let y = top;
  for (const r of rows) {
    // Box label row (full width, very small)
    doc
      .font('Helvetica-Bold')
      .fontSize(8)
      .fillColor('#000')
      .text(`${r.num}  ${r.label}`, left, y, { width: 540 });
    // Value cells
    valueCell(doc, left, y + 12, colW, rowH - 14, usd(r.prev), changeMark(r.prev, r.curr));
    valueCell(doc, mid, y + 12, valW, rowH - 14, usd(r.curr), changeMark(r.prev, r.curr));
    y += rowH;
  }
}

function drawStateLines(doc: PDFKit.PDFDocument, amounts: W2cAmounts): void {
  const top = 580;
  // Single-row aggregate: shows the union of states across previous +
  // corrected, with the prev/curr wages and prev/curr tax stacked. For
  // multi-state cases the row is small; stick with one row for the
  // common single-state case and let multi-state spill to follow-up.
  const states = new Set<string>();
  for (const s of amounts.previous.stateLines) states.add(s.state);
  for (const s of amounts.corrected.stateLines) states.add(s.state);

  doc
    .font('Helvetica-Bold')
    .fontSize(7)
    .fillColor('#000')
    .text('15-17  State wages / tax (previous → corrected)', 36, top - 12, {
      width: 540,
    });

  if (states.size === 0) {
    cell(doc, 36, top, 540, 26, '', '— No state withholding —');
    return;
  }

  let y = top;
  const rowH = 26;
  for (const state of [...states].sort()) {
    const prev = amounts.previous.stateLines.find((s) => s.state === state);
    const curr = amounts.corrected.stateLines.find((s) => s.state === state);
    const prevWages = prev?.stateWages ?? 0;
    const currWages = curr?.stateWages ?? 0;
    const prevTax = prev?.stateIncomeTax ?? 0;
    const currTax = curr?.stateIncomeTax ?? 0;
    doc.rect(36, y, 540, rowH).strokeColor('#000').lineWidth(0.4).stroke();
    doc
      .font('Helvetica')
      .fontSize(10)
      .fillColor('#000')
      .text(state, 44, y + 8, { width: 30 })
      .text(
        `wages ${usd(prevWages)} → ${usd(currWages)}    tax ${usd(prevTax)} → ${usd(currTax)}`,
        80,
        y + 8,
        { width: 460 },
      );
    y += rowH;
    if (y > 660) break; // don't push past the form border
  }
}

function drawCorrectionReason(doc: PDFKit.PDFDocument, reason: string | null): void {
  if (!reason) return;
  doc.save();
  doc
    .roundedRect(36, 668, 540, 18, 2)
    .fillColor('#fff7e6')
    .fill();
  doc
    .fillColor('#a05a00')
    .font('Helvetica-Bold')
    .fontSize(8)
    .text('REASON FOR CORRECTION', 42, 672);
  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor('#5a3a00')
    .text(reason, 170, 672, {
      width: 400,
      lineBreak: false,
      ellipsis: true,
    });
  doc.restore();
}

function drawFooter(doc: PDFKit.PDFDocument, data: W2cPdfData): void {
  doc
    .font('Helvetica')
    .fontSize(7)
    .fillColor('#666')
    .text(
      `Form W-2c (${data.taxYear})  ·  ID ${data.meta.formId.slice(0, 8)}  ·  ` +
        `Amends ${data.meta.originalFormId.slice(0, 8)}  ·  ` +
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

function valueCell(
  doc: PDFKit.PDFDocument,
  x: number,
  y: number,
  w: number,
  h: number,
  value: string,
  changed: boolean,
): void {
  doc
    .rect(x, y, w, h)
    .strokeColor(changed ? '#a05a00' : '#000')
    .lineWidth(changed ? 0.8 : 0.4)
    .stroke();
  doc
    .font('Helvetica')
    .fontSize(11)
    .fillColor(changed ? '#a05a00' : '#000')
    .text(value || '—', x + 4, y + 4, { width: w - 8 });
  doc.fillColor('#000');
}

/** Returns true when the two figures differ enough to highlight (cents). */
function changeMark(prev: number, curr: number): boolean {
  return Math.round(prev * 100) !== Math.round(curr * 100);
}

function usd(n: number): string {
  if (n === 0) return '';
  return n.toFixed(2);
}

// Re-exports so route code only imports from one module.
export type { W2Boxes, W2StateLine };
