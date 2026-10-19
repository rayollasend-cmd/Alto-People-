// Form W-2 for the employee, on plain paper (IRS Pub 1141 §2.3 substitute
// employee copies).
//
// The default download is the employee's whole statement:
//   1. a cover letter in the house style (a permissible enclosure — the
//      only page with brand colour) explaining each box with the person's
//      own numbers, and what to do with each copy;
//   2. Copy B and Copy C, then Copy 2 (two of them: state and local), each
//      a compliant black-ink copy, two to a page with a cut line between;
//      a copy that can't hold every box 12 code or state/local row
//      continues on another copy;
//   3. the Notice to Employee and box instructions, including the earned
//      income credit notice Pub 1141 §2.3 .20 requires.
// A single copy (A, C, D or 2) renders just that copy; the 4-up layout
// puts B, C, 2, 2 on one perforated-stock sheet in the vertical format.
//
// Copy A is filed with the SSA electronically (EFW2). Paper Copy A needs
// red drop-out ink and SSA approval, so the Copy A printout is labelled
// as a record, not a filing.

import { createHash } from 'node:crypto';
import type { W2Boxes, W2StateLine } from './w2Aggregator.js';
import { COLOR, SIZE, createDoc, fmt, type Kit } from './docKit/index.js';
import {
  BLACK,
  BOX12_MEANING,
  GREY,
  W2_BOX_INSTRUCTIONS,
  W2_NOTICE_TO_EMPLOYEE,
  drawW2Copy,
  drawW2CopyNarrow,
  w2NarrowHeight,
  stateLocalRows,
  w2CopyHeight,
  w2Parts,
  type W2CopyData,
} from './taxFormKit.js';

/**
 * Which copy of the W-2 to render. Copy B (the default) renders the
 * employee's full statement: cover, Copies B, C and 2, instructions.
 */
export type W2CopyVariant = 'A' | 'B' | 'C' | 'D' | '2';

export interface W2PdfData {
  taxYear: number;
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
    /** Full SSN, formatted "XXX-XX-XXXX" (Box a); employee copies show the last four. */
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
  meta: {
    formId: string;
    generatedAt: string;
  };
}

export function hashW2Pdf(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

function copyData(d: W2PdfData): W2CopyData {
  return { taxYear: d.taxYear, employer: d.employer, employee: d.employee, controlNumber: d.controlNumber, boxes: d.boxes };
}

const MARGIN = 36;

/** Copies of one kind, two to a page with a cut line between. Returns nothing; pages are added as needed. */
function drawCopies(k: Kit, d: W2PdfData, copies: W2CopyVariant[], firstPage: boolean): void {
  const cd = copyData(d);
  let y = MARGIN;
  let onPage = 0;
  let pageStarted = !firstPage;
  const startPage = () => {
    if (pageStarted) k.doc.addPage();
    pageStarted = true;
    y = MARGIN;
    onPage = 0;
  };
  startPage();
  for (const copy of copies) {
    for (const part of w2Parts(d.boxes, copy)) {
      const h = w2CopyHeight(d.boxes, part, copy);
      if (onPage > 0 && y + 18 + h > 792 - 52) startPage();
      if (onPage > 0) {
        // Cut line between copies (Pub 1141 §2.3 .05: each copy easily separated).
        k.doc.save().lineWidth(0.5).dash(3, { space: 3 }).strokeColor(GREY).moveTo(MARGIN, y + 6).lineTo(612 - MARGIN, y + 6).stroke().undash().restore();
        k.text('Cut along the dotted line', MARGIN, y + 9, { size: 5.5, color: GREY });
        y += 18;
      }
      y += drawW2Copy(k, MARGIN, y, cd, copy, part);
      onPage += 1;
    }
  }
}

function coverPage(k: Kit, d: W2PdfData): void {
  const b = d.boxes;
  const er = d.employer;
  const name = `${d.employee.firstName} ${d.employee.lastName}`.trim();
  let y = k.masthead({
    title: `Your ${d.taxYear} Form W-2`,
    subtitle: 'Wage and Tax Statement',
    brand: { name: er.name, lines: [[er.addressLine1, [[er.city, er.state].filter(Boolean).join(', '), er.zip].filter(Boolean).join(' ')].filter(Boolean).join(', '), `EIN ${fmt.ein(er.ein)}`].filter(Boolean) },
  });
  const intro = `${name}, this is your Form W-2 for ${d.taxYear}: what ${er.name} paid you and the taxes withheld from that pay. You'll need it to file your tax return. The official copies follow this page; the boxes are explained below with your numbers.`;
  y += k.para(intro, k.L, y, k.width(), { size: SIZE.body, color: COLOR.ink2 }) + 12;

  const stateTax = (b.stateLines ?? []).reduce((s, l) => s + l.stateIncomeTax, 0) + (b.localLines ?? []).reduce((s, l) => s + l.localIncomeTax, 0);
  y = k.figures(
    [
      { label: 'Wages (box 1)', value: fmt.money(b.box1Wages) },
      { label: 'Federal tax (box 2)', value: fmt.money(b.box2FitWithheld) },
      { label: 'SS + Medicare tax', value: fmt.money(b.box4SsTax + b.box6MedicareTax), hint: 'Boxes 4 and 6' },
      { label: 'State and local tax', value: fmt.money(stateTax), hint: 'Boxes 17 and 19' },
    ],
    y,
  );

  y = k.section('What each box means', y, 'Your amounts');
  type R = { box: string; what: string; amount: string };
  const rows: R[] = [
    { box: '1', what: 'Wages, tips and other pay subject to federal income tax', amount: fmt.money(b.box1Wages) },
    { box: '2', what: 'Federal income tax withheld from your pay', amount: fmt.money(b.box2FitWithheld) },
    { box: '3', what: 'Wages subject to Social Security tax (up to the yearly limit)', amount: fmt.money(b.box3SsWages) },
    { box: '4', what: 'Social Security tax withheld', amount: fmt.money(b.box4SsTax) },
    { box: '5', what: 'Wages subject to Medicare tax (no limit)', amount: fmt.money(b.box5MedicareWages) },
    { box: '6', what: 'Medicare tax withheld', amount: fmt.money(b.box6MedicareTax) },
  ];
  if (b.box7SsTips) rows.push({ box: '7', what: 'Tips you reported, subject to Social Security tax', amount: fmt.money(b.box7SsTips) });
  if (b.box10DependentCare) rows.push({ box: '10', what: 'Dependent care benefits', amount: fmt.money(b.box10DependentCare) });
  for (const c of b.box12 ?? []) rows.push({ box: `12 · ${c.code}`, what: BOX12_MEANING[c.code] ?? 'See the box 12 instructions', amount: fmt.money(c.amount) });
  if (b.box13RetirementPlan) rows.push({ box: '13', what: 'You took part in a workplace retirement plan this year', amount: 'Checked' });
  if (b.box13ThirdPartySickPay) rows.push({ box: '13', what: 'Sick pay from an insurer is included', amount: 'Checked' });
  for (const o of b.box14Other ?? []) rows.push({ box: '14a', what: o.label, amount: fmt.money(o.amount) });
  for (const r of stateLocalRows(b)) {
    if (r.stateWages || r.stateTax) rows.push({ box: `16–17 · ${r.state}`, what: `${r.state} wages and state income tax withheld`, amount: `${fmt.money(r.stateWages)} · ${fmt.money(r.stateTax)}` });
    if (r.locality) rows.push({ box: '18–20', what: `${r.locality} wages and local tax withheld`, amount: `${fmt.money(r.localWages)} · ${fmt.money(r.localTax)}` });
  }
  y = k.table({
    y,
    rows,
    rowH: 14.5,
    columns: [
      { key: 'box', header: 'Box', width: 1.3, value: (r) => r.box, strong: true },
      { key: 'what', header: 'What it is', width: 6.2, value: (r) => r.what },
      { key: 'amount', header: 'Your amount', width: 2.5, align: 'right', value: (r) => r.amount },
    ],
  });

  y = k.section('What to do with each copy', y);
  const copies: Array<[string, string]> = [
    ['Copy B', 'File with your federal tax return (attach it if you file on paper).'],
    ['Copy C', 'Keep for your records — at least four years.'],
    ['Copy 2', 'File with your state, city or local tax return if you have to file one. Two are included.'],
  ];
  for (const [c, t] of copies) {
    k.text(c, k.L, y, { size: SIZE.body, weight: 'semibold', width: 70 });
    k.text(t, k.L + 70, y, { size: SIZE.body, color: COLOR.ink2, width: k.width() - 70 });
    y += 15;
  }
  y += 8;
  // Corrections are also covered on the notice page; the note here only when it fits.
  if (y + 64 > k.bottom()) return;
  k.callout(
    {
      tone: 'info',
      title: 'Something looks wrong?',
      body: `If your name, Social Security number or any amount is wrong, contact ${er.name} payroll. They will issue a Form W-2c and correct the record with the Social Security Administration. For your protection the copies show only the last four digits of your SSN; your full number was reported to the IRS and SSA.`,
    },
    y,
  );
}

function instructionsPage(k: Kit, d: W2PdfData): void {
  k.doc.addPage();
  let y = k.top;
  k.text(`Notice to Employee · Form W-2 (${d.taxYear})`, k.L, y, { size: SIZE.heading, family: 'display', weight: 'semibold', color: BLACK });
  y += 26;
  const colW = (k.width() - 18) / 2;
  let col = 0;
  let cy = y;
  const block = (title: string, body: string) => {
    const h = k.para(body, 0, 0, colW, { size: 7.5 }, false) + 14;
    if (cy + h > k.bottom()) {
      if (col === 0) {
        col = 1;
        cy = y;
      } else {
        k.doc.addPage();
        col = 0;
        cy = k.top;
        y = k.top;
      }
    }
    const x = k.L + col * (colW + 18);
    k.text(title, x, cy, { size: 8, weight: 'semibold', color: BLACK, width: colW });
    cy += 11;
    cy += k.para(body, x, cy, colW, { size: 7.5, color: BLACK }) + 6;
  };
  for (const n of W2_NOTICE_TO_EMPLOYEE) block(n.title, n.body);
  block('Instructions for Employee', 'See also the Notice to Employee. Box explanations follow.');
  for (const i of W2_BOX_INSTRUCTIONS) block(i.box, i.body);
  const codes = [...new Set((d.boxes.box12 ?? []).map((c) => c.code))];
  if (codes.length) block('Box 12 codes on your form', codes.map((c) => `${c} — ${BOX12_MEANING[c] ?? 'see the General Instructions for Forms W-2 and W-3'}.`).join(' '));
}

export async function renderW2Pdf(data: W2PdfData): Promise<Buffer> {
  const copy = data.copyVariant ?? 'B';
  const { k } = createDoc({
    title: `Form W-2 ${data.taxYear} · ${data.employee.firstName} ${data.employee.lastName}`,
    author: data.employer.name,
    margin: MARGIN,
    creationDate: new Date(data.meta.generatedAt),
  });
  if (copy === 'B') {
    coverPage(k, data);
    drawCopies(k, data, ['B', 'C'], false);
    drawCopies(k, data, ['2', '2'], false);
    instructionsPage(k, data);
  } else {
    drawCopies(k, data, [copy], true);
    if (copy === 'C' || copy === '2') instructionsPage(k, data);
  }
  return k.finish({ reference: `Form W-2 ${data.taxYear} · ${data.meta.formId.slice(0, 8)}`, note: data.employer.name });
}

/**
 * 4-up sheet: B, C, 2, 2 in the vertical format, one per 4.25" × 5.5"
 * quadrant, for perforated W-2 stock; the notice follows. A W-2 with too
 * much to fit a quadrant prints the full-size copies instead.
 */
export async function renderW2Pdf4Up(data: W2PdfData): Promise<Buffer> {
  const cd = copyData(data);
  const qW = 306;
  const qH = 396;
  const pad = 10;
  const fits = Math.max(w2NarrowHeight(data.boxes, 'B'), w2NarrowHeight(data.boxes, '2')) <= qH - pad * 2;
  const { k } = createDoc({ title: `Form W-2 ${data.taxYear} (4-up)`, author: data.employer.name, margin: MARGIN, creationDate: new Date(data.meta.generatedAt) });
  if (!fits) {
    drawCopies(k, data, ['B', 'C', '2', '2'], true);
  } else {
    // The quadrants run edge to edge: drop the margins while drawing so the
    // PDF library never treats a low line as a page overflow.
    const saved = { ...k.doc.page.margins };
    k.doc.page.margins = { top: 0, bottom: 0, left: 0, right: 0 };
    k.doc.save().lineWidth(0.3).dash(2, { space: 2 }).strokeColor(GREY).moveTo(qW, 0).lineTo(qW, 792).stroke().moveTo(0, qH).lineTo(612, qH).stroke().undash().restore();
    const quads: Array<{ x: number; y: number; copy: W2CopyVariant }> = [
      { x: 0, y: 0, copy: 'B' },
      { x: qW, y: 0, copy: 'C' },
      { x: 0, y: qH, copy: '2' },
      { x: qW, y: qH, copy: '2' },
    ];
    for (const q of quads) drawW2CopyNarrow(k, q.x, q.y + pad, qW, qH - pad * 2, cd, q.copy);
    k.doc.page.margins = saved;
  }
  instructionsPage(k, data);
  return k.finish({ reference: `Form W-2 ${data.taxYear} · ${data.meta.formId.slice(0, 8)}`, note: data.employer.name, skipPages: fits ? [0] : [] });
}

export type { W2Boxes, W2StateLine };
