// Form W-2c (Corrected Wage and Tax Statement) for the employee.
//
// The employee's download is the whole correction:
//   1. a cover letter in the house style saying exactly what changed —
//      each corrected box with what was reported, what is correct, and the
//      difference — and why;
//   2. Copies B, C and 2 in black ink (IRS Pub 1141 / Pub 1223 substitute
//      rules): the identifying boxes, then every corrected box with its
//      "Previously reported" and "Correct information" amounts. As the
//      General Instructions for Forms W-2 and W-3 direct, only the boxes
//      being corrected are filled in; the rest stay blank;
//   3. a short notice on what to do with a corrected W-2.

import { createHash } from 'node:crypto';
import type { W2Boxes, W2StateLine } from './w2Aggregator.js';
import type { W2cAmounts } from './w2cAggregator.js';
import { COLOR, SIZE, createDoc, fmt, type Kit } from './docKit/index.js';
import { BLACK, BOX12_MEANING, GREY, IRS_FURNISHED_NOTE, TREASURY, boxAmount, formBox, truncatedSsn } from './taxFormKit.js';

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

export function hashW2cPdf(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

const W2C_LEGEND: Record<'B' | 'C' | '2', string> = {
  B: "Copy B—To Be Filed With Employee's FEDERAL Tax Return.",
  C: "Copy C—For EMPLOYEE'S RECORDS.",
  '2': "Copy 2—To Be Filed With Employee's State, City, or Local Income Tax Return.",
};
const W2C_OMB = 'OMB No. 1545-0029';

interface Change {
  box: string;
  label: string;
  before: number;
  after: number;
}

const same = (a: number | undefined, b: number | undefined) => Math.round((a ?? 0) * 100) === Math.round((b ?? 0) * 100);

/** Every box whose amount differs between what was reported and what is correct. */
export function w2cChanges(prev: W2Boxes, next: W2Boxes): Change[] {
  const out: Change[] = [];
  const pairs: Array<[string, string, keyof W2Boxes]> = [
    ['1', 'Wages, tips, other compensation', 'box1Wages'],
    ['2', 'Federal income tax withheld', 'box2FitWithheld'],
    ['3', 'Social security wages', 'box3SsWages'],
    ['4', 'Social security tax withheld', 'box4SsTax'],
    ['5', 'Medicare wages and tips', 'box5MedicareWages'],
    ['6', 'Medicare tax withheld', 'box6MedicareTax'],
    ['7', 'Social security tips', 'box7SsTips'],
    ['10', 'Dependent care benefits', 'box10DependentCare'],
  ];
  for (const [box, label, key] of pairs) {
    const a = (prev[key] as number | undefined) ?? 0;
    const b = (next[key] as number | undefined) ?? 0;
    if (!same(a, b)) out.push({ box, label, before: a, after: b });
  }
  const codes = new Set([...(prev.box12 ?? []), ...(next.box12 ?? [])].map((c) => c.code));
  for (const code of codes) {
    const a = (prev.box12 ?? []).find((c) => c.code === code)?.amount ?? 0;
    const b = (next.box12 ?? []).find((c) => c.code === code)?.amount ?? 0;
    if (!same(a, b)) out.push({ box: `12 ${code}`, label: BOX12_MEANING[code] ?? `Box 12 code ${code}`, before: a, after: b });
  }
  const others = new Set([...(prev.box14Other ?? []), ...(next.box14Other ?? [])].map((o) => o.label));
  for (const l of others) {
    const a = (prev.box14Other ?? []).find((o) => o.label === l)?.amount ?? 0;
    const b = (next.box14Other ?? []).find((o) => o.label === l)?.amount ?? 0;
    if (!same(a, b)) out.push({ box: '14a', label: l, before: a, after: b });
  }
  const states = new Set([...(prev.stateLines ?? []), ...(next.stateLines ?? [])].map((s) => s.state));
  for (const st of states) {
    const a = (prev.stateLines ?? []).find((s) => s.state === st);
    const b = (next.stateLines ?? []).find((s) => s.state === st);
    if (!same(a?.stateWages, b?.stateWages)) out.push({ box: `16 ${st}`, label: `${st} state wages`, before: a?.stateWages ?? 0, after: b?.stateWages ?? 0 });
    if (!same(a?.stateIncomeTax, b?.stateIncomeTax)) out.push({ box: `17 ${st}`, label: `${st} state income tax`, before: a?.stateIncomeTax ?? 0, after: b?.stateIncomeTax ?? 0 });
  }
  const locals = new Set([...(prev.localLines ?? []), ...(next.localLines ?? [])].map((l) => l.locality));
  for (const loc of locals) {
    const a = (prev.localLines ?? []).find((l) => l.locality === loc);
    const b = (next.localLines ?? []).find((l) => l.locality === loc);
    if (!same(a?.localWages, b?.localWages)) out.push({ box: '18', label: `${loc} local wages`, before: a?.localWages ?? 0, after: b?.localWages ?? 0 });
    if (!same(a?.localIncomeTax, b?.localIncomeTax)) out.push({ box: '19', label: `${loc} local income tax`, before: a?.localIncomeTax ?? 0, after: b?.localIncomeTax ?? 0 });
  }
  return out;
}

function cover(k: Kit, d: W2cPdfData, changes: Change[]): void {
  const er = d.employer;
  const name = `${d.employee.firstName} ${d.employee.lastName}`.trim();
  let y = k.masthead({
    title: `Corrected ${d.taxYear} Form W-2`,
    subtitle: 'Form W-2c · Corrected Wage and Tax Statement',
    brand: { name: er.name, lines: [[er.addressLine1, [[er.city, er.state].filter(Boolean).join(', '), er.zip].filter(Boolean).join(' ')].filter(Boolean).join(', '), `EIN ${fmt.ein(er.ein)}`].filter(Boolean) },
  });
  y += k.para(`${name}, ${er.name} corrected the Form W-2 it gave you for ${d.taxYear}. This Form W-2c replaces only the amounts listed below; everything else on your original W-2 stays as it was.`, k.L, y, k.width(), { size: SIZE.body, color: COLOR.ink2 }) + 12;
  if (d.correctionReason) y = k.callout({ tone: 'info', title: 'Why it changed', body: d.correctionReason }, y);
  y = k.section('What changed', y, `${changes.length} ${changes.length === 1 ? 'box' : 'boxes'}`);
  y = k.table({
    y,
    rows: changes,
    rowH: 16,
    empty: 'No amounts changed: this correction fixes your name, SSN or address.',
    columns: [
      { key: 'box', header: 'Box', width: 1.1, value: (c) => c.box, strong: true },
      { key: 'label', header: 'What it is', width: 4.4, value: (c) => c.label },
      { key: 'before', header: 'Was', width: 1.6, align: 'right', value: (c) => fmt.money(c.before) },
      { key: 'after', header: 'Correct', width: 1.6, align: 'right', value: (c) => fmt.money(c.after), strong: true },
      { key: 'diff', header: 'Change', width: 1.5, align: 'right', value: (c) => fmt.money(c.after - c.before, { signed: true }), color: (c) => (c.after - c.before < 0 ? COLOR.bad : COLOR.good) },
    ],
  });
  y = k.section('What to do', y);
  const steps = [
    'If you have not filed your return yet, use the correct amounts from this form together with your original W-2.',
    'If you already filed, you may need to file an amended return (Form 1040-X). Copy B is the one to include.',
    'Keep Copy C with your original W-2. File Copy 2 with any state, city or local return the correction affects.',
  ];
  for (const s of steps) {
    const h = k.para(s, k.L + 12, y, k.width() - 12, { size: SIZE.body, color: COLOR.ink2 });
    k.text('•', k.L, y, { size: SIZE.body, color: COLOR.brand });
    y += h + 5;
  }
}

function drawCopy(k: Kit, x: number, y: number, d: W2cPdfData, copy: 'B' | 'C' | '2', changes: Change[]): number {
  const W = 540;
  const half = W / 2;
  const er = d.employer;
  const ee = d.employee;
  let cy = y;
  formBox(k, x, cy, half, 54, "a  Employer's name, address, and ZIP code", [er.name, er.addressLine1, er.addressLine2, [[er.city, er.state].filter(Boolean).join(', '), er.zip].filter(Boolean).join(' ')].filter((s): s is string => !!s), { valueSize: 8.5 });
  formBox(k, x + half, cy, half / 2, 27, 'c  Tax year/Form corrected', `${d.taxYear} / W-2`);
  formBox(k, x + half * 1.5, cy, half / 2, 27, "d  Employee's correct SSN", truncatedSsn(ee.ssn));
  formBox(k, x + half, cy + 27, half, 27, 'b  Employer identification number (EIN)', fmt.ein(er.ein));
  cy += 54;
  formBox(k, x, cy, half, 26, "h  Employee's first name and initial      Last name", `${ee.firstName} ${ee.lastName}`.trim());
  formBox(k, x + half, cy, half, 26, "i  Employee's address and ZIP code", [[ee.addressLine1, ee.addressLine2].filter(Boolean).join(', '), [[ee.city, ee.state].filter(Boolean).join(', '), ee.zip].filter(Boolean).join(' ')].filter(Boolean).join(' · '), { valueSize: 8 });
  cy += 26;
  formBox(k, x, cy, half, 20, 'Control number (from the original W-2)', d.controlNumber, { valueSize: 8.5 });
  formBox(k, x + half, cy, half, 20, 'Note', 'Complete only the boxes being corrected', { valueSize: 7.5 });
  cy += 26;

  // Corrected boxes: previously reported | correct information, two per row.
  const head = (hx: number) => {
    k.text('Previously reported', hx + 4, cy, { size: 6.5, weight: 'semibold', color: BLACK, width: half / 2 - 8 });
    k.text('Correct information', hx + half / 2 + 4, cy, { size: 6.5, weight: 'semibold', color: BLACK, width: half / 2 - 8 });
  };
  head(x);
  head(x + half);
  cy += 10;
  const cells = changes.length ? changes : [];
  for (let i = 0; i < Math.max(2, cells.length); i += 2) {
    for (let j = 0; j < 2; j++) {
      const c = cells[i + j];
      const cx = x + j * half;
      formBox(k, cx, cy, half / 2, 24, c ? `${c.box}  ${c.label}` : '', c ? boxAmount(c.before) || '0.00' : '', { align: 'right', labelSize: 5.5 });
      formBox(k, cx + half / 2, cy, half / 2, 24, c ? `${c.box}  ${c.label}` : '', c ? boxAmount(c.after) || '0.00' : '', { align: 'right', labelSize: 5.5 });
    }
    cy += 24;
  }
  cy += 6;
  k.text('Form', x, cy + 4, { size: 7, color: BLACK });
  k.text('W-2c', x + 18, cy, { size: 15, weight: 'bold', color: BLACK });
  k.text('(Rev. 1-2026)', x + 64, cy + 5, { size: 6, color: GREY });
  k.text('Corrected Wage and Tax Statement', x + 110, cy + 3.5, { size: 9.5, weight: 'semibold', color: BLACK });
  k.text(TREASURY, x + W - 230, cy + 1, { size: 6.5, color: BLACK, width: 230, align: 'right' });
  k.text(W2C_OMB, x + W - 230, cy + 9.5, { size: 6, color: GREY, width: 230, align: 'right' });
  cy += 20;
  k.text(W2C_LEGEND[copy], x, cy, { size: 7, weight: 'semibold', color: BLACK, width: W });
  cy += 10;
  if (copy !== '2') cy += k.para(IRS_FURNISHED_NOTE, x, cy, W, { size: 6.5, color: BLACK });
  return cy - y + 2;
}

export async function renderW2cPdf(data: W2cPdfData): Promise<Buffer> {
  const changes = w2cChanges(data.amounts.previous, data.amounts.corrected);
  const { k } = createDoc({
    title: `Form W-2c ${data.taxYear} · ${data.employee.firstName} ${data.employee.lastName}`,
    author: data.employer.name,
    margin: 36,
    creationDate: new Date(data.meta.generatedAt),
  });
  cover(k, data, changes);
  k.doc.addPage();
  let y = 36;
  (['B', 'C', '2'] as const).forEach((copy, i) => {
    const estimate = 160 + Math.ceil(Math.max(2, changes.length) / 2) * 24 + 50;
    if (i > 0 && y + 18 + estimate > 792 - 52) {
      k.doc.addPage();
      y = 36;
    } else if (i > 0) {
      k.doc.save().lineWidth(0.5).dash(3, { space: 3 }).strokeColor(GREY).moveTo(36, y + 6).lineTo(576, y + 6).stroke().undash().restore();
      k.text('Cut along the dotted line', 36, y + 9, { size: 5.5, color: GREY });
      y += 18;
    }
    y += drawCopy(k, 36, y, data, copy, changes);
  });
  return k.finish({ reference: `Form W-2c ${data.taxYear} · ${data.meta.formId.slice(0, 8)} · corrects ${data.meta.originalFormId.slice(0, 8)}`, note: data.employer.name });
}

export type { W2Boxes, W2StateLine };
